import { gunzipSync } from 'node:zlib';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createRepositories, migrate } from '@fitness-coach/db';
import { createBackupService } from './backup.js';

describe('backup service', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  async function setup() {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-backup-'));
    const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
    migrate(db);
    await mkdir(join(dataDir, 'images'));
    await mkdir(join(dataDir, 'backups'));
    const repositories = createRepositories(db);
    const profile = repositories.profiles.create({
      name: 'Default', goal: 'maintain', goal_description: '', height_cm: 175, age: 30, sex: 'unspecified',
      training_experience: 'beginner', equipment: 'home', training_days_per_week: 3,
      session_duration_minutes: 45, diet_preferences: '', allergies: '', health_restrictions: '',
    });
    repositories.profiles.setCurrentId(profile.id);
    cleanups.push(async () => {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    return { dataDir, db, repositories };
  }

  it('creates an atomic archive with a consistent database, schema manifest, and images', async () => {
    const { dataDir, db, repositories } = await setup();
    repositories.dailyEntry.save({ entry_date: '2026-09-28', status: 'training' });
    await writeFile(join(dataDir, 'images', 'meal.png'), 'image bytes');
    await writeFile(join(dataDir, 'model-api-key.secret'), 'sk-never-backup-this');
    await writeFile(join(dataDir, '.env'), 'SECRET=runtime');
    await writeFile(join(dataDir, 'runtime-config.json'), '{}');
    await writeFile(join(dataDir, 'backups', 'old.tar.gz'), 'old backup');

    const service = createBackupService({ database: db, repositories, dataDir });
    const result = await service.create();

    expect(result.filename).toMatch(/^backup-.*\.tar\.gz$/);
    expect(await readdir(join(dataDir, 'backups'))).toEqual(['old.tar.gz', result.filename].sort());
    expect(result.manifest).toMatchObject({
      schema_version: 2,
      includes_images: true,
      files: expect.arrayContaining([
        expect.objectContaining({ path: 'database/fitness-coach.sqlite' }),
        expect.objectContaining({ path: 'schema-version.json' }),
        expect.objectContaining({ path: 'images/meal.png' }),
      ]),
    });
    expect(result.manifest.files.map((file) => file.path)).not.toContain('model-api-key.secret');
    expect(result.manifest.files.map((file) => file.path)).not.toContain('backups/old.tar.gz');
    expect(gunzipSync(await readFile(result.path)).toString()).not.toContain('sk-never-backup-this');
    expect(await service.verify(result.path)).toMatchObject({
      valid: true,
      schemaVersion: 2,
      includesImages: true,
      files: expect.arrayContaining(['images/meal.png', 'database/fitness-coach.sqlite']),
    });
    await expect(lstat(join(dataDir, 'backups', `.${result.filename}.tmp`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed on symlinked image content without publishing a partial archive', async () => {
    const { dataDir, db, repositories } = await setup();
    const outside = await mkdtemp(join(tmpdir(), 'fitness-coach-backup-outside-'));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, 'private.png'), 'private');
    await symlink(outside, join(dataDir, 'images', 'linked'));

    const service = createBackupService({ database: db, repositories, dataDir });
    await expect(service.create()).rejects.toThrow(/unsafe|symlink/i);
    expect(await readdir(join(dataDir, 'backups'))).toEqual([]);
    expect(await readFile(join(outside, 'private.png'), 'utf8')).toBe('private');
  });

  it('rejects optional-image export through a symlinked configured data directory', async () => {
    const { dataDir, db, repositories } = await setup();
    const links = await mkdtemp(join(tmpdir(), 'fitness-coach-backup-links-'));
    cleanups.push(() => rm(links, { recursive: true, force: true }));
    const linkedDataDir = join(links, 'data');
    await symlink(dataDir, linkedDataDir);
    const service = createBackupService({ database: db, repositories, dataDir: linkedDataDir });

    await expect(service.exportJson(true)).rejects.toThrow(/unsafe|symlink/i);
  });

  it('verifies a backup when the image directory is empty', async () => {
    const { dataDir, db, repositories } = await setup();
    const service = createBackupService({ database: db, repositories, dataDir });

    const result = await service.create();

    await expect(service.verify(result.path)).resolves.toMatchObject({
      valid: true,
      includesImages: true,
      files: expect.not.arrayContaining([expect.stringMatching(/^images\//)]),
    });
  });

  it('does not publish a backup when the database references a missing image', async () => {
    const { dataDir, db, repositories } = await setup();
    const entry = repositories.dailyEntry.save({ entry_date: '2026-09-28', status: 'training' });
    const meal = repositories.meal.save(entry.id, {
      eaten_at: '2026-09-28T12:00:00Z',
      meal_type: 'lunch',
      notes: '',
      recognition_status: 'unrecognized',
    });
    repositories.image.register(meal.id, {
      relative_path: 'images/missing.png',
      mime_type: 'image/png',
      file_size: 12,
    });
    const service = createBackupService({ database: db, repositories, dataDir });

    await expect(service.create()).rejects.toThrow(/image/i);
    expect(await readdir(join(dataDir, 'backups'))).toEqual([]);
  });

  it('rejects an archive with an unsafe path during recovery verification', async () => {
    const { dataDir, db, repositories } = await setup();
    const service = createBackupService({ database: db, repositories, dataDir });
    const invalidArchive = join(dataDir, 'invalid.tar.gz');
    await writeFile(invalidArchive, Buffer.from('not a valid archive'));

    await expect(service.verify(invalidArchive)).rejects.toThrow(/archive|invalid|manifest/i);
  });
});
