import { constants, closeSync, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { openDatabase } from './client.js';

function tableExists(db: Database.Database, table: string) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function tableColumn(db: Database.Database, table: string, column: string) {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>).find(({ name }) => name === column);
}

function currentProfileId(db: Database.Database) {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'current_profile_id'").get() as { value?: string } | undefined;
  const id = Number(row?.value);
  if (Number.isInteger(id) && id > 0 && db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(id)) return id;
  const active = db.prepare("SELECT id FROM profiles WHERE status = 'active' ORDER BY id").all() as Array<{ id: number }>;
  if (active.length === 1) return active[0].id;
  throw new Error('Phase 2 migration cannot determine a unique profile owner');
}

function hasUnownedRows(db: Database.Database) {
  const daily = tableColumn(db, 'daily_entries', 'profile_id');
  const recommendations = tableColumn(db, 'recommendations', 'profile_id');
  return !daily || daily.notnull === 0 || !recommendations || recommendations.notnull === 0
    || Boolean(db.prepare('SELECT 1 FROM daily_entries WHERE profile_id IS NULL LIMIT 1').get())
    || Boolean(db.prepare('SELECT 1 FROM recommendations WHERE profile_id IS NULL LIMIT 1').get());
}

function hasScopedRows(db: Database.Database) {
  return Boolean(db.prepare('SELECT 1 FROM daily_entries LIMIT 1').get())
    || Boolean(db.prepare('SELECT 1 FROM recommendations LIMIT 1').get());
}

function createProfiles(db: Database.Database) {
  db.exec(`
    CREATE TABLE profiles (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
      goal TEXT NOT NULL CHECK (goal IN ('fat_loss', 'muscle_gain', 'maintain', 'custom')),
      goal_description TEXT NOT NULL DEFAULT '', height_cm REAL NOT NULL CHECK (height_cm > 0),
      age INTEGER NOT NULL CHECK (age BETWEEN 1 AND 150), sex TEXT NOT NULL,
      training_experience TEXT NOT NULL, equipment TEXT NOT NULL,
      training_days_per_week INTEGER NOT NULL CHECK (training_days_per_week BETWEEN 0 AND 7),
      session_duration_minutes INTEGER NOT NULL CHECK (session_duration_minutes > 0),
      diet_preferences TEXT NOT NULL, allergies TEXT NOT NULL, health_restrictions TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), archived_at TEXT
    );
  `);
}

type MigratedImage = { imageId: number; profileId: number; source: string; target: string; dev: number; ino: number; size: number; sha256: string; directory: string; directoryCreated: boolean };
type LegacyImageJournal = { version: 1; moves: Array<Pick<MigratedImage, 'imageId' | 'profileId' | 'source' | 'target' | 'size' | 'sha256'>> };
const legacyImageJournalFilename = '.legacy-image-migration.json';
export type MigrationFileHooks = {
  afterLockAcquired?: () => void;
  beforeTargetCreate?: () => void;
  asyncUnsafeBeforeTargetCreate?: () => void;
  afterTargetCreate?: () => void;
  beforeSourceUnlink?: () => void;
};
type FileIdentity = { dev: number; ino: number; size: number; sha256: string };
type MigrationLock = { path: string; dev: number; ino: number };
type MigrationLockOwner = { pid: number; token: string; createdAt: string };

function pathIsInside(root: string, candidate: string) {
  const child = relative(root, candidate);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function fileIdentity(path: string): FileIdentity {
  const handle = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(handle);
    if (!stat.isFile()) throw new Error('Unsafe legacy image source');
    return { dev: stat.dev, ino: stat.ino, size: stat.size, sha256: createHash('sha256').update(readFileSync(handle)).digest('hex') };
  } finally {
    closeSync(handle);
  }
}

function lockOwner(path: string): { owner: MigrationLockOwner; dev: number; ino: number } {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('Legacy image migration lock is unsafe');
  let owner: MigrationLockOwner;
  try {
    owner = JSON.parse(readFileSync(path, 'utf8')) as MigrationLockOwner;
  } catch {
    throw new Error('Legacy image migration lock is malformed');
  }
  if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !/^[a-f0-9-]{32,64}$/i.test(owner.token) || !Number.isFinite(Date.parse(owner.createdAt))) {
    throw new Error('Legacy image migration lock is malformed');
  }
  return { owner, dev: metadata.dev, ino: metadata.ino };
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    if (code === 'ESRCH') return false;
    throw error;
  }
}

function acquireMigrationLock(dataDir: string): MigrationLock {
  const path = join(realpathSync(resolve(dataDir)), '.legacy-image-migration.lock');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle: number;
    try {
      handle = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = lockOwner(path);
      if (processIsAlive(existing.owner.pid)) throw new Error('Legacy image migration lock is already held');
      const current = lstatSync(path);
      if (current.isSymbolicLink() || !current.isFile() || current.dev !== existing.dev || current.ino !== existing.ino) throw new Error('Legacy image migration lock changed while taking over');
      unlinkSync(path);
      continue;
    }
    try {
      const owner: MigrationLockOwner = { pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() };
      writeFileSync(handle, JSON.stringify(owner));
      fsyncSync(handle);
      const stat = fstatSync(handle);
      return { path, dev: stat.dev, ino: stat.ino };
    } finally {
      closeSync(handle);
    }
  }
  throw new Error('Legacy image migration lock could not be acquired');
}

function releaseMigrationLock(lock: MigrationLock) {
  try {
    const stat = lstatSync(lock.path);
    if (!stat.isSymbolicLink() && stat.isFile() && stat.dev === lock.dev && stat.ino === lock.ino) unlinkSync(lock.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function unlinkIfIdentity(path: string, expected: FileIdentity) {
  const actual = fileIdentity(path);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== expected.size || actual.sha256 !== expected.sha256) return false;
  const pathStat = lstatSync(path);
  if (pathStat.isSymbolicLink() || pathStat.dev !== expected.dev || pathStat.ino !== expected.ino) return false;
  unlinkSync(path);
  return true;
}

function copyExclusive(source: string, target: string, expected: FileIdentity) {
  const sourceHandle = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let targetHandle: number | undefined;
  try {
    const sourceStat = fstatSync(sourceHandle);
    if (sourceStat.dev !== expected.dev || sourceStat.ino !== expected.ino) throw new Error('Migration compensation target identity changed');
    const bytes = readFileSync(sourceHandle);
    targetHandle = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(targetHandle, bytes, offset, bytes.length - offset, offset);
    fsyncSync(targetHandle);
    const created = fstatSync(targetHandle);
    closeSync(targetHandle);
    targetHandle = undefined;
    const identity = fileIdentity(target);
    if (identity.dev !== created.dev || identity.ino !== created.ino || identity.size !== expected.size || identity.sha256 !== expected.sha256) throw new Error('Migration compensation copy failed verification');
    return identity;
  } catch (error) {
    if (targetHandle !== undefined) closeSync(targetHandle);
    throw error;
  } finally {
    closeSync(sourceHandle);
  }
}

function journalPath(dataDir: string) {
  return join(realpathSync(resolve(dataDir)), legacyImageJournalFilename);
}

function readLegacyImageJournal(dataDir: string): LegacyImageJournal | undefined {
  const path = journalPath(dataDir);
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as LegacyImageJournal;
  if (parsed.version !== 1 || !Array.isArray(parsed.moves)) throw new Error('Legacy image migration journal is invalid');
  for (const move of parsed.moves) {
    const sourceParts = move.source?.split('/');
    const targetParts = move.target?.split('/');
    if (!Number.isInteger(move.imageId) || move.imageId <= 0 || !Number.isInteger(move.profileId) || move.profileId <= 0
      || !Number.isInteger(move.size) || move.size < 0 || !/^[a-f0-9]{64}$/.test(move.sha256)
      || sourceParts?.length !== 2 || sourceParts[0] !== 'images' || !sourceParts[1] || basename(sourceParts[1]) !== sourceParts[1]
      || targetParts?.length !== 3 || targetParts[0] !== 'images' || targetParts[1] !== `profile-${move.profileId}` || targetParts[2] !== sourceParts[1]
      || [move.source, move.target].some((path) => isAbsolute(path) || path.includes('\\') || path.includes('\0') || path.split('/').some((part) => part === '..' || part === '.'))) {
      throw new Error('Legacy image migration journal is invalid');
    }
  }
  return parsed;
}

function writeLegacyImageJournal(dataDir: string, moves: LegacyImageJournal['moves']) {
  const path = journalPath(dataDir);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, moves }), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function recoverLegacyImageJournal(db: Database.Database, dataDir: string) {
  const journal = readLegacyImageJournal(dataDir);
  if (!journal) return false;
  const root = realpathSync(resolve(dataDir));
  for (const move of journal.moves) {
    const source = resolve(root, move.source);
    const target = resolve(root, move.target);
    if (!pathIsInside(root, source) || !pathIsInside(root, target)) throw new Error('Legacy image migration journal is unsafe');
    const row = db.prepare('SELECT relative_path FROM meal_images WHERE id = ?').get(move.imageId) as { relative_path?: string } | undefined;
    if (!row) throw new Error('Legacy image migration journal record is missing');
    if (existsSync(target)) {
      const identity = fileIdentity(target);
      if (identity.size !== move.size || (move.sha256 && identity.sha256 !== move.sha256)) throw new Error('Legacy image migration target does not match journal');
      if (row.relative_path === move.source) db.prepare('UPDATE meal_images SET relative_path = ? WHERE id = ?').run(move.target, move.imageId);
      else if (row.relative_path !== move.target) throw new Error('Legacy image migration journal path does not match database');
    } else if (existsSync(source) && row.relative_path === move.source) {
      // The crash happened before the file move; the normal migration will resume it.
    } else {
      throw new Error('Legacy image migration journal files are unavailable');
    }
  }
  return true;
}

function migrateLegacyImages(db: Database.Database, dataDir: string, profileId: number, moved: MigratedImage[], hooks: MigrationFileHooks) {
  const rows = db.prepare(`SELECT i.id, i.relative_path
    FROM meal_images i JOIN meals m ON m.id = i.meal_id JOIN daily_entries d ON d.id = m.daily_entry_id
    WHERE d.profile_id = ? AND i.relative_path NOT LIKE 'images/profile-%/%'`).all(profileId) as Array<{ id: number; relative_path: string }>;
  const dataRoot = realpathSync(resolve(dataDir));
  const imagesRoot = realpathSync(join(dataRoot, 'images'));
  if (!pathIsInside(dataRoot, imagesRoot) || lstatSync(imagesRoot).isSymbolicLink()) throw new Error('Unsafe images directory');
  for (const row of rows) {
    const parts = row.relative_path.split('/');
    const filename = parts[1];
    if (parts.length !== 2 || parts[0] !== 'images' || !filename || filename === '.' || filename === '..' || basename(filename) !== filename || filename.includes('\\') || filename.includes('\0')) throw new Error('Unsafe legacy image path');
    const source = join(imagesRoot, filename);
    if (!pathIsInside(imagesRoot, source)) throw new Error('Unsafe legacy image path');
    const sourceMeta = lstatSync(source);
    if (!sourceMeta.isFile() || sourceMeta.isSymbolicLink()) throw new Error('Unsafe legacy image source');
    const identity = fileIdentity(source);
    const targetDir = join(imagesRoot, `profile-${profileId}`);
    let directoryCreated = false;
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { mode: 0o700 });
      directoryCreated = true;
    } else {
      const targetDirectoryMeta = lstatSync(targetDir);
      if (!targetDirectoryMeta.isDirectory() || targetDirectoryMeta.isSymbolicLink() || !pathIsInside(imagesRoot, realpathSync(targetDir))) throw new Error('Unsafe profile image directory');
    }
    const target = join(targetDir, filename);
    if (existsSync(target)) throw new Error('Legacy image target already exists');
    const sourceRelative = `images/${filename}`;
    const targetRelative = `images/profile-${profileId}/${filename}`;
    writeLegacyImageJournal(dataDir, [
      ...moved.map((move) => ({ imageId: move.imageId, profileId: move.profileId, source: relative(dataRoot, move.source), target: relative(dataRoot, move.target), size: move.size, sha256: move.sha256 })),
      { imageId: row.id, profileId, source: sourceRelative, target: targetRelative, ...identity },
    ]);
    hooks.beforeTargetCreate?.();
    hooks.asyncUnsafeBeforeTargetCreate?.();
    const currentTargetDirectory = lstatSync(targetDir);
    if (currentTargetDirectory.isSymbolicLink() || !currentTargetDirectory.isDirectory() || realpathSync(targetDir) !== targetDir) throw new Error('Unsafe profile image directory');
    const sourceHandle = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let targetHandle: number | undefined;
    let targetCreated = false;
    let targetOpened: FileIdentity | undefined;
    try {
      const sourceOpened = fstatSync(sourceHandle);
      if (!sourceOpened.isFile() || sourceOpened.dev !== sourceMeta.dev || sourceOpened.ino !== sourceMeta.ino) throw new Error('Legacy image source changed');
      const bytes = readFileSync(sourceHandle);
      targetHandle = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      targetCreated = true;
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(targetHandle, bytes, offset, bytes.length - offset, offset);
      fsyncSync(targetHandle);
      const targetStat = fstatSync(targetHandle);
      targetOpened = { dev: targetStat.dev, ino: targetStat.ino, size: targetStat.size, sha256: identity.sha256 };
      closeSync(targetHandle);
      targetHandle = undefined;
      hooks.afterTargetCreate?.();
    } catch (error) {
      if (targetHandle !== undefined) closeSync(targetHandle);
      if (targetCreated && targetOpened && existsSync(target) && !unlinkIfIdentity(target, targetOpened)) throw new Error('Migration cleanup refused to delete an unknown target', { cause: error });
      closeSync(sourceHandle);
      throw error;
    }
    const targetMeta = lstatSync(target);
    const targetIdentity = fileIdentity(target);
    const targetDirectoryMeta = lstatSync(targetDir);
    if (targetMeta.isSymbolicLink() || !targetMeta.isFile() || targetDirectoryMeta.isSymbolicLink() || !targetDirectoryMeta.isDirectory()
      || targetIdentity.size !== identity.size || targetIdentity.sha256 !== identity.sha256) {
      if (targetCreated && targetOpened && existsSync(target) && !unlinkIfIdentity(target, targetOpened)) throw new Error('Migration cleanup refused to delete an unknown target');
      closeSync(sourceHandle);
      rmSync(journalPath(dataDir), { force: true });
      throw new Error('Legacy image changed during migration');
    }
    hooks.beforeSourceUnlink?.();
    const sourcePathMeta = lstatSync(source);
    if (sourcePathMeta.isSymbolicLink() || !sourcePathMeta.isFile() || sourcePathMeta.dev !== sourceMeta.dev || sourcePathMeta.ino !== sourceMeta.ino) {
      if (targetCreated && targetOpened && existsSync(target) && !unlinkIfIdentity(target, targetOpened)) throw new Error('Migration cleanup refused to delete an unknown target');
      closeSync(sourceHandle);
      throw new Error('Legacy image source changed before unlink');
    }
    unlinkSync(source);
    closeSync(sourceHandle);
    moved.push({ imageId: row.id, profileId, source, target, ...targetOpened!, directory: targetDir, directoryCreated });
    db.prepare('UPDATE meal_images SET relative_path = ? WHERE id = ?').run(targetRelative, row.id);
  }
}

function restoreMigratedImages(moved: MigratedImage[]) {
  const failures: string[] = [];
  for (const move of [...moved].reverse()) {
    try {
      if (!existsSync(move.target)) throw new Error('Migration target is missing');
      const targetIdentity = fileIdentity(move.target);
      if (targetIdentity.dev !== move.dev || targetIdentity.ino !== move.ino || targetIdentity.size !== move.size || targetIdentity.sha256 !== move.sha256) throw new Error('Migration target identity changed');
      if (existsSync(move.source)) throw new Error('Migration source path is occupied');
      const restored = copyExclusive(move.target, move.source, targetIdentity);
      if (!unlinkIfIdentity(move.target, targetIdentity)) {
        unlinkIfIdentity(move.source, restored);
        throw new Error('Migration target changed before compensation unlink');
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : 'Migration compensation failed');
    }
    if (move.directoryCreated) {
      try { rmdirSync(move.directory); } catch { /* A concurrent file makes retaining the directory safer. */ }
    }
  }
  return failures;
}

function rebuildScopedTables(db: Database.Database, profileId: number) {
  const dailyProfile = tableColumn(db, 'daily_entries', 'profile_id');
  if (!dailyProfile || dailyProfile.notnull === 0) {
    const hasProfileId = Boolean(dailyProfile);
    db.exec(`
      CREATE TABLE daily_entries_new (
        id INTEGER PRIMARY KEY,
        profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        entry_date TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('training', 'rest', 'paused_sick', 'travel', 'custom')),
        status_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE(profile_id, entry_date)
      );
      INSERT INTO daily_entries_new (id, profile_id, entry_date, status, status_note, created_at, updated_at)
      SELECT id, ${hasProfileId ? 'COALESCE(profile_id, @profile_id)' : '@profile_id'}, entry_date, status, status_note, created_at, updated_at FROM daily_entries;
      DROP TABLE daily_entries;
      ALTER TABLE daily_entries_new RENAME TO daily_entries;
    `.replaceAll('@profile_id', String(profileId)));
  }

  const recommendationProfile = tableColumn(db, 'recommendations', 'profile_id');
  if (!recommendationProfile || recommendationProfile.notnull === 0) {
    const hasProfileId = Boolean(recommendationProfile);
    const columns = new Set((db.prepare('PRAGMA table_info(recommendations)').all() as Array<{ name: string }>).map(({ name }) => name));
    const source = (name: string, fallback: string) => columns.has(name) ? name : fallback;
    db.exec(`
      CREATE TABLE recommendations_new (
        id INTEGER PRIMARY KEY,
        profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        job_id TEXT, range_start TEXT NOT NULL, range_end TEXT NOT NULL, model_name TEXT NOT NULL,
        generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        input_record_count INTEGER NOT NULL DEFAULT 0, image_review_count INTEGER NOT NULL DEFAULT 0,
        input_summary_json TEXT NOT NULL, report_markdown TEXT NOT NULL, structured_report_json TEXT NOT NULL,
        error_code TEXT, error_message TEXT,
        status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed'))
      );
      INSERT INTO recommendations_new (id, profile_id, job_id, range_start, range_end, model_name, generated_at, input_record_count, image_review_count, input_summary_json, report_markdown, structured_report_json, error_code, error_message, status)
      SELECT id, ${hasProfileId ? 'COALESCE(profile_id, @profile_id)' : '@profile_id'}, ${source('job_id', 'NULL')}, range_start, range_end, model_name, generated_at, ${source('input_record_count', '0')}, ${source('image_review_count', '0')}, input_summary_json, report_markdown, structured_report_json, ${source('error_code', 'NULL')}, ${source('error_message', 'NULL')}, status FROM recommendations;
      DROP TABLE recommendations;
      ALTER TABLE recommendations_new RENAME TO recommendations;
    `.replaceAll('@profile_id', String(profileId)));
  }
}

export function migrate(db: Database.Database, dataDir?: string, hooks: MigrationFileHooks = {}): void {
  db.pragma('foreign_keys = OFF');
  const compiledSchemaUrl = new URL('./schema.sql', import.meta.url);
  const sourceSchemaUrl = new URL('../src/schema.sql', import.meta.url);
  const schemaUrl = existsSync(fileURLToPath(sourceSchemaUrl)) ? sourceSchemaUrl : compiledSchemaUrl;
  const schema = readFileSync(fileURLToPath(schemaUrl), 'utf8');

  const movedImages: MigratedImage[] = [];
  let migrationLock: MigrationLock | undefined;
  try {
    if (dataDir) {
      try {
        migrationLock = acquireMigrationLock(dataDir);
      } catch (error) {
        if (error instanceof Error && /migration lock/i.test(error.message)) throw error;
        throw new Error('Legacy image migration lock could not be acquired', { cause: error });
      }
      hooks.afterLockAcquired?.();
    }
    if (dataDir && db.transaction(() => recoverLegacyImageJournal(db, dataDir))()) {
      rmSync(journalPath(dataDir), { force: true });
    }
    db.transaction(() => {
      if (!tableExists(db, 'schema_migrations')) {
        db.exec(schema);
        db.prepare('INSERT INTO schema_migrations (version) VALUES (2)').run();
        return;
      }

      const version = (db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version?: number }).version ?? 0;
      if (version >= 2) {
        db.exec('DROP INDEX IF EXISTS idx_recommendation_jobs_active_range');
        db.exec(schema);
        const defaultProfile = db.prepare("SELECT id FROM profiles WHERE status = 'active' ORDER BY id LIMIT 1").get() as { id?: number } | undefined;
        if (defaultProfile?.id && dataDir) migrateLegacyImages(db, dataDir, defaultProfile.id, movedImages, hooks);
        return;
      }

      if (!tableExists(db, 'profiles')) {
        createProfiles(db);
        const legacy = tableExists(db, 'profile') ? db.prepare('SELECT * FROM profile WHERE id = 1').get() as Record<string, unknown> | undefined : undefined;
        if (!legacy) throw new Error('Phase 1 profile is required for migration');
        db.prepare(`INSERT INTO profiles (id, name, status, goal, height_cm, age, sex, training_experience, equipment,
          training_days_per_week, session_duration_minutes, diet_preferences, allergies, health_restrictions, updated_at)
          VALUES (1, '默认档案', 'active', @goal, @height_cm, @age, @sex, @training_experience, @equipment,
          @training_days_per_week, @session_duration_minutes, @diet_preferences, @allergies, @health_restrictions, @updated_at)`).run(legacy);
        db.prepare("INSERT INTO app_settings (key, value) VALUES ('current_profile_id', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
      }

      if (hasUnownedRows(db)) rebuildScopedTables(db, hasScopedRows(db) ? currentProfileId(db) : 1);
      db.exec('DROP INDEX IF EXISTS idx_recommendation_jobs_active_range');
      db.exec(schema);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (2)').run();
      const defaultProfile = db.prepare("SELECT id FROM profiles WHERE status = 'active' ORDER BY id LIMIT 1").get() as { id?: number } | undefined;
      if (defaultProfile?.id && dataDir) migrateLegacyImages(db, dataDir, defaultProfile.id, movedImages, hooks);
    })();
    if (dataDir && movedImages.length > 0) rmSync(journalPath(dataDir), { force: true });
  } catch (error) {
    const failures = restoreMigratedImages(movedImages);
    if (dataDir && movedImages.length > 0 && failures.length === 0) rmSync(journalPath(dataDir), { force: true });
    if (failures.length > 0) throw new Error(`Legacy image migration compensation failed: ${failures.join('; ')}`, { cause: error });
    throw error;
  } finally {
    db.pragma('foreign_keys = ON');
    if (migrationLock) releaseMigrationLock(migrationLock);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  const dataDir = resolve(process.env.DATA_DIR ?? 'data');
  const db = openDatabase(join(dataDir, 'fitness-coach.sqlite'));
  try {
    migrate(db, dataDir);
  } finally {
    db.close();
  }
}
