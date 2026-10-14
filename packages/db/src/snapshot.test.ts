import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { exportDatabase, getSchemaVersion, snapshotDatabase } from './snapshot.js';
import { migrate } from './migrate.js';

describe('database snapshots', () => {
  it('exports the schema version and data without leaking SQL into the server boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fitness-coach-db-snapshot-'));
    const db = new Database(':memory:');
    try {
      migrate(db);
      const profileId = Number(db.prepare(`INSERT INTO profiles (name, status, goal, goal_description, height_cm, age, sex,
        training_experience, equipment, training_days_per_week, session_duration_minutes, diet_preferences, allergies, health_restrictions)
        VALUES ('Default', 'active', 'maintain', '', 175, 30, 'unspecified', 'beginner', 'home', 3, 45, '', '', '')`).run().lastInsertRowid);
      db.prepare("INSERT INTO daily_entries (profile_id, entry_date, status) VALUES (?, '2026-09-28', 'rest')").run(profileId);

      expect(getSchemaVersion(db)).toBe(2);
      expect(exportDatabase(db)).toEqual(expect.objectContaining({
        schemaVersion: 2,
        tables: expect.objectContaining({
          daily_entries: [expect.objectContaining({ entry_date: '2026-09-28', status: 'rest' })],
        }),
      }));

      const snapshotPath = join(directory, 'fitness-coach.sqlite');
      await snapshotDatabase(db, snapshotPath);
      const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
      try {
        expect(snapshot.prepare('SELECT entry_date, status FROM daily_entries').all()).toEqual([
          { entry_date: '2026-09-28', status: 'rest' },
        ]);
      } finally {
        snapshot.close();
      }
    } finally {
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
