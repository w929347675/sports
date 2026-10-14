import Database from 'better-sqlite3';
import { existsSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrate } from './migrate.js';
import { createRepositories } from './repositories.js';

describe('database migrations', () => {
  it('is idempotent and preserves existing data', () => {
    const db = new Database(':memory:');
    migrate(db);
    const profileId = Number(db.prepare(`INSERT INTO profiles (name, status, goal, goal_description, height_cm, age, sex,
      training_experience, equipment, training_days_per_week, session_duration_minutes, diet_preferences, allergies, health_restrictions)
      VALUES ('Default', 'active', 'maintain', '', 175, 30, 'unspecified', 'beginner', 'home', 3, 45, '', '', '')`).run().lastInsertRowid);
    db.prepare("INSERT INTO daily_entries (profile_id, entry_date, status) VALUES (?, '2026-09-28', 'rest')").run(profileId);

    expect(() => migrate(db)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM daily_entries').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 1 });
  });

  it('enforces one daily entry per local date and rolls back failed transactions', () => {
    const db = new Database(':memory:');
    migrate(db);
    const profileId = Number(db.prepare(`INSERT INTO profiles (name, status, goal, goal_description, height_cm, age, sex,
      training_experience, equipment, training_days_per_week, session_duration_minutes, diet_preferences, allergies, health_restrictions)
      VALUES ('Default', 'active', 'maintain', '', 175, 30, 'unspecified', 'beginner', 'home', 3, 45, '', '', '')`).run().lastInsertRowid);
    const addEntries = db.transaction(() => {
      db.prepare("INSERT INTO daily_entries (profile_id, entry_date, status) VALUES (?, '2026-09-28', 'training')").run(profileId);
      db.prepare("INSERT INTO daily_entries (profile_id, entry_date, status) VALUES (?, '2026-09-28', 'rest')").run(profileId);
    });

    expect(() => addEntries()).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM daily_entries').get()).toEqual({ count: 0 });
  });

  it('moves legacy image files into the default profile directory and updates their database paths', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-legacy-image-migration-'));
    const db = new Database(':memory:');
    try {
      await mkdir(join(dataDir, 'images'), { recursive: true });
      await writeFile(join(dataDir, 'images', 'lunch.png'), 'legacy image');
      migrate(db);
      const profileId = Number(db.prepare(`INSERT INTO profiles (name, status, goal, goal_description, height_cm, age, sex,
        training_experience, equipment, training_days_per_week, session_duration_minutes, diet_preferences, allergies, health_restrictions)
        VALUES ('Default', 'active', 'maintain', '', 175, 30, 'unspecified', 'beginner', 'home', 3, 45, '', '', '')`).run().lastInsertRowid);
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('current_profile_id', ?)").run(String(profileId));
      const entryId = Number(db.prepare("INSERT INTO daily_entries (profile_id, entry_date, status) VALUES (?, '2026-10-01', 'rest')").run(profileId).lastInsertRowid);
      const mealId = Number(db.prepare("INSERT INTO meals (daily_entry_id, eaten_at, meal_type) VALUES (?, '2026-10-01T12:00:00Z', 'lunch')").run(entryId).lastInsertRowid);
      db.prepare("INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size) VALUES (?, 'images/lunch.png', 'image/png', 12)").run(mealId);

      migrate(db, dataDir);

      expect(db.prepare('SELECT relative_path FROM meal_images').get()).toEqual({ relative_path: `images/profile-${profileId}/lunch.png` });
      await expect(readFile(join(dataDir, 'images', `profile-${profileId}`, 'lunch.png'), 'utf8')).resolves.toBe('legacy image');
    } finally {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects unsafe legacy image paths and symlink sources without changing database rows', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-legacy-image-safety-'));
    const db = new Database(':memory:');
    try {
      await mkdir(join(dataDir, 'images'), { recursive: true });
      await writeFile(join(dataDir, 'outside.png'), 'outside');
      await symlink(join(dataDir, 'outside.png'), join(dataDir, 'images', 'linked.png'));
      migrate(db);
      const profileId = Number(db.prepare(`INSERT INTO profiles (name, status, goal, goal_description, height_cm, age, sex,
        training_experience, equipment, training_days_per_week, session_duration_minutes, diet_preferences, allergies, health_restrictions)
        VALUES ('Default', 'active', 'maintain', '', 175, 30, 'unspecified', 'beginner', 'home', 3, 45, '', '', '')`).run().lastInsertRowid);
      const entryId = Number(db.prepare("INSERT INTO daily_entries (profile_id, entry_date, status) VALUES (?, '2026-10-01', 'rest')").run(profileId).lastInsertRowid);
      const mealId = Number(db.prepare("INSERT INTO meals (daily_entry_id, eaten_at, meal_type) VALUES (?, '2026-10-01T12:00:00Z', 'lunch')").run(entryId).lastInsertRowid);
      db.prepare("INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size) VALUES (?, 'images/linked.png', 'image/png', 7)").run(mealId);

      expect(() => migrate(db, dataDir)).toThrow();
      expect(db.prepare('SELECT relative_path FROM meal_images').get()).toEqual({ relative_path: 'images/linked.png' });
      await expect(readFile(join(dataDir, 'outside.png'), 'utf8')).resolves.toBe('outside');
    } finally {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it.each([
    '/outside.png',
    'images/../outside.png',
  ])('rejects unsafe legacy database path %s without changing the row', async (relativePath) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-legacy-image-path-'));
    const db = new Database(':memory:');
    try {
      await mkdir(join(dataDir, 'images'), { recursive: true });
      await writeFile(join(dataDir, 'outside.png'), 'outside');
      migrate(db);
      const profileId = Number(db.prepare(`INSERT INTO profiles (name, status, goal, goal_description, height_cm, age, sex,
        training_experience, equipment, training_days_per_week, session_duration_minutes, diet_preferences, allergies, health_restrictions)
        VALUES ('Default', 'active', 'maintain', '', 175, 30, 'unspecified', 'beginner', 'home', 3, 45, '', '', '')`).run().lastInsertRowid);
      const entryId = Number(db.prepare("INSERT INTO daily_entries (profile_id, entry_date, status) VALUES (?, '2026-10-01', 'rest')").run(profileId).lastInsertRowid);
      const mealId = Number(db.prepare("INSERT INTO meals (daily_entry_id, eaten_at, meal_type) VALUES (?, '2026-10-01T12:00:00Z', 'lunch')").run(entryId).lastInsertRowid);
      db.prepare("INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size) VALUES (?, ?, 'image/png', 7)").run(mealId, relativePath);

      expect(() => migrate(db, dataDir)).toThrow(/unsafe legacy image path/i);
      expect(db.prepare('SELECT relative_path FROM meal_images').get()).toEqual({ relative_path: relativePath });
      await expect(readFile(join(dataDir, 'outside.png'), 'utf8')).resolves.toBe('outside');
    } finally {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('is idempotent and compensates already moved legacy files when a later legacy source fails', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-legacy-image-compensation-'));
    const db = new Database(':memory:');
    try {
      await mkdir(join(dataDir, 'images'), { recursive: true });
      await writeFile(join(dataDir, 'images', 'a-good.png'), 'good');
      await writeFile(join(dataDir, 'outside.png'), 'outside');
      await symlink(join(dataDir, 'outside.png'), join(dataDir, 'images', 'z-linked.png'));
      migrate(db);
      const profileId = Number(db.prepare(`INSERT INTO profiles (name, status, goal, goal_description, height_cm, age, sex,
        training_experience, equipment, training_days_per_week, session_duration_minutes, diet_preferences, allergies, health_restrictions)
        VALUES ('Default', 'active', 'maintain', '', 175, 30, 'unspecified', 'beginner', 'home', 3, 45, '', '', '')`).run().lastInsertRowid);
      const entry = Number(db.prepare("INSERT INTO daily_entries (profile_id, entry_date, status) VALUES (?, '2026-10-01', 'rest')").run(profileId).lastInsertRowid);
      const firstMeal = Number(db.prepare("INSERT INTO meals (daily_entry_id, eaten_at, meal_type) VALUES (?, '2026-10-01T12:00:00Z', 'lunch')").run(entry).lastInsertRowid);
      const secondMeal = Number(db.prepare("INSERT INTO meals (daily_entry_id, eaten_at, meal_type) VALUES (?, '2026-10-01T18:00:00Z', 'dinner')").run(entry).lastInsertRowid);
      db.prepare("INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size) VALUES (?, 'images/a-good.png', 'image/png', 4)").run(firstMeal);
      db.prepare("INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size) VALUES (?, 'images/z-linked.png', 'image/png', 7)").run(secondMeal);

      expect(() => migrate(db, dataDir)).toThrow();

      expect(db.prepare('SELECT relative_path FROM meal_images ORDER BY id').all()).toEqual([
        { relative_path: 'images/a-good.png' }, { relative_path: 'images/z-linked.png' },
      ]);
      await expect(readFile(join(dataDir, 'images', 'a-good.png'), 'utf8')).resolves.toBe('good');
      await expect(readdir(join(dataDir, 'images', `profile-${profileId}`))).rejects.toThrow();
      await rm(join(dataDir, 'images', 'z-linked.png'));
      db.prepare('DELETE FROM meal_images WHERE meal_id = ?').run(secondMeal);

      expect(() => migrate(db, dataDir)).not.toThrow();
      expect(() => migrate(db, dataDir)).not.toThrow();
      expect(db.prepare('SELECT relative_path FROM meal_images ORDER BY id').all()).toEqual([
        { relative_path: `images/profile-${profileId}/a-good.png` },
      ]);
    } finally {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('resumes a journaled file move after a crash before the database path update', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-legacy-image-crash-file-first-'));
    const db = new Database(':memory:');
    try {
      await mkdir(join(dataDir, 'images', 'profile-1'), { recursive: true });
      await writeFile(join(dataDir, 'images', 'profile-1', 'lunch.png'), 'journaled image');
      migrate(db);
      const profileId = Number(db.prepare(`INSERT INTO profiles (id, name, status, goal, goal_description, height_cm, age, sex,
        training_experience, equipment, training_days_per_week, session_duration_minutes, diet_preferences, allergies, health_restrictions)
        VALUES (1, 'Default', 'active', 'maintain', '', 175, 30, 'unspecified', 'beginner', 'home', 3, 45, '', '', '')`).run().lastInsertRowid || 1);
      const entry = Number(db.prepare("INSERT INTO daily_entries (profile_id, entry_date, status) VALUES (?, '2026-10-01', 'rest')").run(profileId).lastInsertRowid);
      const meal = Number(db.prepare("INSERT INTO meals (daily_entry_id, eaten_at, meal_type) VALUES (?, '2026-10-01T12:00:00Z', 'lunch')").run(entry).lastInsertRowid);
      db.prepare("INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size) VALUES (?, 'images/lunch.png', 'image/png', 15)").run(meal);
      await writeFile(join(dataDir, '.legacy-image-migration.json'), JSON.stringify({ version: 1, moves: [{ imageId: 1, profileId, source: 'images/lunch.png', target: 'images/profile-1/lunch.png', size: 15, sha256: createHash('sha256').update('journaled image').digest('hex') }] }));

      migrate(db, dataDir);

      expect(db.prepare('SELECT relative_path FROM meal_images WHERE id = 1').get()).toEqual({ relative_path: 'images/profile-1/lunch.png' });
      await expect(readFile(join(dataDir, 'images', 'profile-1', 'lunch.png'), 'utf8')).resolves.toBe('journaled image');
      await expect(stat(join(dataDir, '.legacy-image-migration.json'))).rejects.toThrow();
    } finally {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('finishes cleanup when the database path committed before a simulated crash', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-legacy-image-crash-db-first-'));
    const db = new Database(':memory:');
    try {
      await mkdir(join(dataDir, 'images', 'profile-1'), { recursive: true });
      await writeFile(join(dataDir, 'images', 'profile-1', 'lunch.png'), 'committed image');
      migrate(db);
      db.prepare(`INSERT INTO profiles (id, name, status, goal, goal_description, height_cm, age, sex,
        training_experience, equipment, training_days_per_week, session_duration_minutes, diet_preferences, allergies, health_restrictions)
        VALUES (1, 'Default', 'active', 'maintain', '', 175, 30, 'unspecified', 'beginner', 'home', 3, 45, '', '', '')`).run();
      const entry = Number(db.prepare("INSERT INTO daily_entries (profile_id, entry_date, status) VALUES (1, '2026-10-01', 'rest')").run().lastInsertRowid);
      const meal = Number(db.prepare("INSERT INTO meals (daily_entry_id, eaten_at, meal_type) VALUES (?, '2026-10-01T12:00:00Z', 'lunch')").run(entry).lastInsertRowid);
      db.prepare("INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size) VALUES (?, 'images/profile-1/lunch.png', 'image/png', 15)").run(meal);
      await writeFile(join(dataDir, '.legacy-image-migration.json'), JSON.stringify({ version: 1, moves: [{ imageId: 1, profileId: 1, source: 'images/lunch.png', target: 'images/profile-1/lunch.png', size: 15, sha256: createHash('sha256').update('committed image').digest('hex') }] }));

      migrate(db, dataDir);

      expect(db.prepare('SELECT relative_path FROM meal_images WHERE id = 1').get()).toEqual({ relative_path: 'images/profile-1/lunch.png' });
      await expect(readFile(join(dataDir, 'images', 'profile-1', 'lunch.png'), 'utf8')).resolves.toBe('committed image');
      await expect(stat(join(dataDir, '.legacy-image-migration.json'))).rejects.toThrow();
    } finally {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('does not overwrite an unknown target created immediately before exclusive target creation', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-legacy-target-race-'));
    const db = new Database(':memory:');
    try {
      await mkdir(join(dataDir, 'images'), { recursive: true });
      await writeFile(join(dataDir, 'images', 'lunch.png'), 'legacy source');
      migrate(db);
      const profileId = Number(db.prepare(`INSERT INTO profiles (name, status, goal, goal_description, height_cm, age, sex,
        training_experience, equipment, training_days_per_week, session_duration_minutes, diet_preferences, allergies, health_restrictions)
        VALUES ('Default', 'active', 'maintain', '', 175, 30, 'unspecified', 'beginner', 'home', 3, 45, '', '', '')`).run().lastInsertRowid);
      const entry = Number(db.prepare("INSERT INTO daily_entries (profile_id, entry_date, status) VALUES (?, '2026-10-01', 'rest')").run(profileId).lastInsertRowid);
      const meal = Number(db.prepare("INSERT INTO meals (daily_entry_id, eaten_at, meal_type) VALUES (?, '2026-10-01T12:00:00Z', 'lunch')").run(entry).lastInsertRowid);
      db.prepare("INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size) VALUES (?, 'images/lunch.png', 'image/png', 13)").run(meal);
      const target = join(dataDir, 'images', `profile-${profileId}`, 'lunch.png');

      expect(() => migrate(db, dataDir, {
        beforeTargetCreate() { writeFileSync(target, 'unknown target'); },
      })).toThrow();

      await expect(readFile(target, 'utf8')).resolves.toBe('unknown target');
      await expect(readFile(join(dataDir, 'images', 'lunch.png'), 'utf8')).resolves.toBe('legacy source');
      expect(db.prepare('SELECT relative_path FROM meal_images').get()).toEqual({ relative_path: 'images/lunch.png' });
    } finally {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects a target directory replaced by a symlink after its initial check without touching outside files', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-legacy-target-dir-race-'));
    const outside = await mkdtemp(join(tmpdir(), 'fitness-coach-legacy-target-outside-'));
    const db = new Database(':memory:');
    try {
      await mkdir(join(dataDir, 'images'), { recursive: true });
      await writeFile(join(dataDir, 'images', 'lunch.png'), 'legacy source');
      await writeFile(join(outside, 'lunch.png'), 'outside existing');
      migrate(db);
      const profileId = Number(db.prepare(`INSERT INTO profiles (name, status, goal, goal_description, height_cm, age, sex,
        training_experience, equipment, training_days_per_week, session_duration_minutes, diet_preferences, allergies, health_restrictions)
        VALUES ('Default', 'active', 'maintain', '', 175, 30, 'unspecified', 'beginner', 'home', 3, 45, '', '', '')`).run().lastInsertRowid);
      const entry = Number(db.prepare("INSERT INTO daily_entries (profile_id, entry_date, status) VALUES (?, '2026-10-01', 'rest')").run(profileId).lastInsertRowid);
      const meal = Number(db.prepare("INSERT INTO meals (daily_entry_id, eaten_at, meal_type) VALUES (?, '2026-10-01T12:00:00Z', 'lunch')").run(entry).lastInsertRowid);
      db.prepare("INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size) VALUES (?, 'images/lunch.png', 'image/png', 13)").run(meal);
      const targetDirectory = join(dataDir, 'images', `profile-${profileId}`);

      expect(() => migrate(db, dataDir, {
        asyncUnsafeBeforeTargetCreate() {
          rmSync(targetDirectory, { recursive: true, force: true });
          symlinkSync(outside, targetDirectory, 'dir');
        },
      })).toThrow();

      await expect(readFile(join(outside, 'lunch.png'), 'utf8')).resolves.toBe('outside existing');
      await expect(readFile(join(dataDir, 'images', 'lunch.png'), 'utf8')).resolves.toBe('legacy source');
      expect(db.prepare('SELECT relative_path FROM meal_images').get()).toEqual({ relative_path: 'images/lunch.png' });
    } finally {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects a source replaced by a symlink before unlink and leaves the outside file untouched', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-legacy-source-race-'));
    const db = new Database(':memory:');
    try {
      await mkdir(join(dataDir, 'images'), { recursive: true });
      await writeFile(join(dataDir, 'images', 'lunch.png'), 'legacy source');
      await writeFile(join(dataDir, 'outside.png'), 'outside existing');
      migrate(db);
      const profileId = Number(db.prepare(`INSERT INTO profiles (name, status, goal, goal_description, height_cm, age, sex,
        training_experience, equipment, training_days_per_week, session_duration_minutes, diet_preferences, allergies, health_restrictions)
        VALUES ('Default', 'active', 'maintain', '', 175, 30, 'unspecified', 'beginner', 'home', 3, 45, '', '', '')`).run().lastInsertRowid);
      const entry = Number(db.prepare("INSERT INTO daily_entries (profile_id, entry_date, status) VALUES (?, '2026-10-01', 'rest')").run(profileId).lastInsertRowid);
      const meal = Number(db.prepare("INSERT INTO meals (daily_entry_id, eaten_at, meal_type) VALUES (?, '2026-10-01T12:00:00Z', 'lunch')").run(entry).lastInsertRowid);
      db.prepare("INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size) VALUES (?, 'images/lunch.png', 'image/png', 13)").run(meal);
      const source = join(dataDir, 'images', 'lunch.png');

      expect(() => migrate(db, dataDir, {
        beforeSourceUnlink() {
          rmSync(source, { force: true });
          symlinkSync(join(dataDir, 'outside.png'), source);
        },
      })).toThrow();

      await expect(readFile(join(dataDir, 'outside.png'), 'utf8')).resolves.toBe('outside existing');
      await expect(stat(join(dataDir, 'images', `profile-${profileId}`, 'lunch.png'))).rejects.toThrow();
      expect(db.prepare('SELECT relative_path FROM meal_images').get()).toEqual({ relative_path: 'images/lunch.png' });
    } finally {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects a journal without a valid sha256 and preserves it for diagnosis', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-invalid-legacy-journal-'));
    const db = new Database(':memory:');
    try {
      await mkdir(join(dataDir, 'images'), { recursive: true });
      migrate(db);
      const journal = JSON.stringify({ version: 1, moves: [{ imageId: 1, profileId: 1, source: 'images/lunch.png', target: 'images/profile-1/lunch.png', size: 1, sha256: 'bad' }] });
      await writeFile(join(dataDir, '.legacy-image-migration.json'), journal);

      expect(() => migrate(db, dataDir)).toThrow(/journal/i);
      await expect(readFile(join(dataDir, '.legacy-image-migration.json'), 'utf8')).resolves.toBe(journal);
    } finally {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('does not delete an unknown file that replaces the exclusively created target during cleanup', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-target-cleanup-race-'));
    const db = new Database(':memory:');
    try {
      await mkdir(join(dataDir, 'images'), { recursive: true });
      await writeFile(join(dataDir, 'images', 'lunch.png'), 'legacy source');
      migrate(db);
      const profileId = Number(db.prepare(`INSERT INTO profiles (name, status, goal, goal_description, height_cm, age, sex,
        training_experience, equipment, training_days_per_week, session_duration_minutes, diet_preferences, allergies, health_restrictions)
        VALUES ('Default', 'active', 'maintain', '', 175, 30, 'unspecified', 'beginner', 'home', 3, 45, '', '', '')`).run().lastInsertRowid);
      const entry = Number(db.prepare("INSERT INTO daily_entries (profile_id, entry_date, status) VALUES (?, '2026-10-01', 'rest')").run(profileId).lastInsertRowid);
      const meal = Number(db.prepare("INSERT INTO meals (daily_entry_id, eaten_at, meal_type) VALUES (?, '2026-10-01T12:00:00Z', 'lunch')").run(entry).lastInsertRowid);
      db.prepare("INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size) VALUES (?, 'images/lunch.png', 'image/png', 13)").run(meal);
      const target = join(dataDir, 'images', `profile-${profileId}`, 'lunch.png');

      expect(() => migrate(db, dataDir, {
        afterTargetCreate() {
          rmSync(target, { force: true });
          writeFileSync(target, 'unknown replacement');
          throw new Error('force cleanup');
        },
      })).toThrow(/cleanup|compensation|unknown|identity/i);

      await expect(readFile(target, 'utf8')).resolves.toBe('unknown replacement');
      expect(db.prepare('SELECT relative_path FROM meal_images').get()).toEqual({ relative_path: 'images/lunch.png' });
      await expect(stat(join(dataDir, '.legacy-image-migration.json'))).resolves.toBeDefined();
    } finally {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('does not overwrite a source created before compensation restore and retains its journal', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-compensation-source-race-'));
    const db = new Database(':memory:');
    try {
      await mkdir(join(dataDir, 'images'), { recursive: true });
      await writeFile(join(dataDir, 'images', 'a.png'), 'first source');
      await writeFile(join(dataDir, 'images', 'b.png'), 'second source');
      migrate(db);
      const profileId = Number(db.prepare(`INSERT INTO profiles (name, status, goal, goal_description, height_cm, age, sex,
        training_experience, equipment, training_days_per_week, session_duration_minutes, diet_preferences, allergies, health_restrictions)
        VALUES ('Default', 'active', 'maintain', '', 175, 30, 'unspecified', 'beginner', 'home', 3, 45, '', '', '')`).run().lastInsertRowid);
      const entry = Number(db.prepare("INSERT INTO daily_entries (profile_id, entry_date, status) VALUES (?, '2026-10-01', 'rest')").run(profileId).lastInsertRowid);
      for (const [name, time] of [['a.png', '12:00'], ['b.png', '18:00']] as const) {
        const meal = Number(db.prepare("INSERT INTO meals (daily_entry_id, eaten_at, meal_type) VALUES (?, ?, 'lunch')").run(entry, `2026-10-01T${time}:00Z`).lastInsertRowid);
        db.prepare('INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size) VALUES (?, ?, \'image/png\', ?)').run(meal, `images/${name}`, name === 'a.png' ? 12 : 13);
      }
      const sourceA = join(dataDir, 'images', 'a.png');

      expect(() => migrate(db, dataDir, {
        beforeTargetCreate() {
          if (!existsSync(sourceA)) {
            writeFileSync(sourceA, 'unknown source replacement');
            throw new Error('force compensation');
          }
        },
      })).toThrow();

      await expect(readFile(sourceA, 'utf8')).resolves.toBe('unknown source replacement');
      await expect(stat(join(dataDir, '.legacy-image-migration.json'))).resolves.toBeDefined();
    } finally {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('uses an exclusive migration lock and removes only its own lock on release', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-migration-lock-'));
    const first = new Database(':memory:');
    const second = new Database(':memory:');
    try {
      await mkdir(join(dataDir, 'images'), { recursive: true });
      migrate(first);
      migrate(second);
      expect(() => migrate(first, dataDir, {
        afterLockAcquired() {
          expect(() => migrate(second, dataDir)).toThrow(/migration.*lock/i);
        },
      })).not.toThrow();
      expect(() => migrate(second, dataDir)).not.toThrow();
      await expect(stat(join(dataDir, '.legacy-image-migration.lock'))).rejects.toThrow();
    } finally {
      first.close();
      second.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('takes over a stale dead-pid lock and recovers the existing crash journal', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-stale-migration-lock-'));
    const db = new Database(':memory:');
    try {
      await mkdir(join(dataDir, 'images', 'profile-1'), { recursive: true });
      await writeFile(join(dataDir, 'images', 'profile-1', 'lunch.png'), 'stale recovery');
      migrate(db);
      db.prepare(`INSERT INTO profiles (id, name, status, goal, goal_description, height_cm, age, sex, training_experience, equipment,
        training_days_per_week, session_duration_minutes, diet_preferences, allergies, health_restrictions)
        VALUES (1, 'Default', 'active', 'maintain', '', 175, 30, 'unspecified', 'beginner', 'home', 3, 45, '', '', '')`).run();
      const entry = Number(db.prepare("INSERT INTO daily_entries (profile_id, entry_date, status) VALUES (1, '2026-10-01', 'rest')").run().lastInsertRowid);
      const meal = Number(db.prepare("INSERT INTO meals (daily_entry_id, eaten_at, meal_type) VALUES (?, '2026-10-01T12:00:00Z', 'lunch')").run(entry).lastInsertRowid);
      db.prepare("INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size) VALUES (?, 'images/lunch.png', 'image/png', 14)").run(meal);
      const sha256 = createHash('sha256').update('stale recovery').digest('hex');
      await writeFile(join(dataDir, '.legacy-image-migration.json'), JSON.stringify({ version: 1, moves: [{ imageId: 1, profileId: 1, source: 'images/lunch.png', target: 'images/profile-1/lunch.png', size: 14, sha256 }] }));
      await writeFile(join(dataDir, '.legacy-image-migration.lock'), JSON.stringify({ pid: 2_147_483_647, token: 'a'.repeat(32), createdAt: '2026-10-01T00:00:00.000Z' }));

      migrate(db, dataDir);

      expect(db.prepare('SELECT relative_path FROM meal_images').get()).toEqual({ relative_path: 'images/profile-1/lunch.png' });
      await expect(stat(join(dataDir, '.legacy-image-migration.json'))).rejects.toThrow();
      await expect(stat(join(dataDir, '.legacy-image-migration.lock'))).rejects.toThrow();
    } finally {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects a live-pid lock without modifying the crash journal', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-live-migration-lock-'));
    const db = new Database(':memory:');
    try {
      await mkdir(join(dataDir, 'images'), { recursive: true });
      migrate(db);
      const journal = JSON.stringify({ version: 1, moves: [] });
      await writeFile(join(dataDir, '.legacy-image-migration.json'), journal);
      const lock = JSON.stringify({ pid: process.pid, token: 'b'.repeat(32), createdAt: new Date().toISOString() });
      await writeFile(join(dataDir, '.legacy-image-migration.lock'), lock);

      expect(() => migrate(db, dataDir)).toThrow(/lock/i);

      await expect(readFile(join(dataDir, '.legacy-image-migration.json'), 'utf8')).resolves.toBe(journal);
      await expect(readFile(join(dataDir, '.legacy-image-migration.lock'), 'utf8')).resolves.toBe(lock);
    } finally {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it.each(['malformed', 'symlink'] as const)('rejects a %s migration lock without deleting it', async (kind) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-invalid-migration-lock-'));
    const db = new Database(':memory:');
    try {
      await mkdir(join(dataDir, 'images'), { recursive: true });
      migrate(db);
      const lockPath = join(dataDir, '.legacy-image-migration.lock');
      if (kind === 'malformed') await writeFile(lockPath, '{bad json');
      else {
        await writeFile(join(dataDir, 'outside-lock'), 'outside');
        await symlink(join(dataDir, 'outside-lock'), lockPath);
      }

      expect(() => migrate(db, dataDir)).toThrow(/lock/i);

      expect((await stat(lockPath)).isFile()).toBe(true);
    } finally {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('preserves recommendation extension fields while rebuilding an intermediate scoped table', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      db.exec('DROP TABLE recommendations');
      db.exec(`CREATE TABLE recommendations (
        id INTEGER PRIMARY KEY, profile_id INTEGER, job_id TEXT, range_start TEXT NOT NULL, range_end TEXT NOT NULL,
        model_name TEXT NOT NULL, generated_at TEXT NOT NULL, input_record_count INTEGER NOT NULL DEFAULT 0,
        image_review_count INTEGER NOT NULL DEFAULT 0, input_summary_json TEXT NOT NULL, report_markdown TEXT NOT NULL,
        structured_report_json TEXT NOT NULL, error_code TEXT, error_message TEXT, status TEXT NOT NULL
      )`);
      db.prepare(`INSERT INTO profiles (name, status, goal, goal_description, height_cm, age, sex, training_experience, equipment,
        training_days_per_week, session_duration_minutes, diet_preferences, allergies, health_restrictions)
        VALUES ('Default', 'active', 'maintain', '', 175, 30, 'unspecified', 'beginner', 'home', 3, 45, '', '', '')`).run();
      db.prepare(`INSERT INTO recommendations (profile_id, job_id, range_start, range_end, model_name, generated_at,
        input_record_count, image_review_count, input_summary_json, report_markdown, structured_report_json, error_code, error_message, status)
        VALUES (NULL, 'job-1', '2026-10-01', '2026-10-07', 'model', '2026-10-08T00:00:00.000Z', 9, 2, '{}', 'failed report', '{}', 'MODEL_TIMEOUT', 'timeout', 'failed')`).run();
      db.prepare('DELETE FROM schema_migrations').run();
      db.prepare('INSERT INTO schema_migrations (version) VALUES (1)').run();

      migrate(db);

      expect(db.prepare('SELECT * FROM recommendations').get()).toMatchObject({
        profile_id: 1, job_id: 'job-1', input_record_count: 9, image_review_count: 2,
        error_code: 'MODEL_TIMEOUT', error_message: 'timeout', report_markdown: 'failed report', status: 'failed',
      });
    } finally {
      db.close();
    }
  });

  it('recovers processing meals only for active profiles', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      const createProfile = (name: string, status: string) => Number(db.prepare(`INSERT INTO profiles (name, status, goal, goal_description, height_cm, age, sex,
        training_experience, equipment, training_days_per_week, session_duration_minutes, diet_preferences, allergies, health_restrictions)
        VALUES (?, ?, 'maintain', '', 175, 30, 'unspecified', 'beginner', 'home', 3, 45, '', '', '')`).run(name, status).lastInsertRowid);
      const active = createProfile('Active', 'active');
      const archived = createProfile('Archived', 'archived');
      for (const [profileId, date] of [[active, '2026-10-01'], [archived, '2026-10-02']] as const) {
        const entry = Number(db.prepare('INSERT INTO daily_entries (profile_id, entry_date, status) VALUES (?, ?, \'rest\')').run(profileId, date).lastInsertRowid);
        db.prepare("INSERT INTO meals (daily_entry_id, eaten_at, meal_type, recognition_status) VALUES (?, ?, 'lunch', 'processing')").run(entry, `${date}T12:00:00Z`);
      }
      const repositories = createRepositories(db);

      expect(repositories.meal.recoverProcessing()).toBe(1);
      expect(db.prepare('SELECT recognition_status FROM meals WHERE daily_entry_id = (SELECT id FROM daily_entries WHERE profile_id = ?)').get(active)).toEqual({ recognition_status: 'failed' });
      expect(db.prepare('SELECT recognition_status FROM meals WHERE daily_entry_id = (SELECT id FROM daily_entries WHERE profile_id = ?)').get(archived)).toEqual({ recognition_status: 'processing' });
    } finally {
      db.close();
    }
  });
});
