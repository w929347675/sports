import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '@fitness-coach/db';
import { createRepositories } from '@fitness-coach/db';

function legacyDatabase() {
  const db = new Database(':memory:');
  db.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT 'now');
    CREATE TABLE profile (
      id INTEGER PRIMARY KEY CHECK (id = 1), goal TEXT NOT NULL, height_cm REAL NOT NULL,
      age INTEGER NOT NULL, sex TEXT NOT NULL, training_experience TEXT NOT NULL,
      equipment TEXT NOT NULL, training_days_per_week INTEGER NOT NULL,
      session_duration_minutes INTEGER NOT NULL, diet_preferences TEXT NOT NULL,
      allergies TEXT NOT NULL, health_restrictions TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE daily_entries (
      id INTEGER PRIMARY KEY, entry_date TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
      status_note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE recommendations (
      id INTEGER PRIMARY KEY, range_start TEXT NOT NULL, range_end TEXT NOT NULL,
      model_name TEXT NOT NULL, generated_at TEXT NOT NULL, input_summary_json TEXT NOT NULL,
      report_markdown TEXT NOT NULL, structured_report_json TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE app_settings (key TEXT PRIMARY KEY CHECK (key <> 'api_key'), value TEXT NOT NULL);
    INSERT INTO schema_migrations (version) VALUES (1);
    INSERT INTO profile VALUES (1, 'maintain', 175, 30, 'unspecified', 'beginner', 'home', 3, 45, 'none', 'none', 'none', '2026-10-10T00:00:00.000Z');
    INSERT INTO daily_entries VALUES (7, '2026-10-10', 'training', 'legacy', '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z');
    INSERT INTO recommendations VALUES (9, '2026-10-01', '2026-10-10', 'mock', '2026-10-10T00:00:00.000Z', '{}', 'report', '{}', 'completed');
  `);
  return db;
}

describe('phase 2A migration', () => {
  it('creates a version 2 schema with mandatory profile ownership', () => {
    const db = new Database(':memory:');

    migrate(db);

    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 2 }]);
    expect(db.prepare('PRAGMA table_info(daily_entries)').all()).toContainEqual(expect.objectContaining({
      name: 'profile_id',
      notnull: 1,
    }));
    expect(db.prepare('PRAGMA table_info(recommendations)').all()).toContainEqual(expect.objectContaining({
      name: 'profile_id',
      notnull: 1,
    }));
  });

  it('moves legacy records to one default profile and is idempotent', () => {
    const db = legacyDatabase();

    migrate(db);
    migrate(db);

    expect(db.prepare('SELECT name, status, goal FROM profiles').all()).toEqual([
      { name: '默认档案', status: 'active', goal: 'maintain' },
    ]);
    expect(db.prepare('SELECT profile_id FROM daily_entries WHERE id = 7').get()).toEqual({ profile_id: 1 });
    expect(db.prepare('SELECT profile_id FROM recommendations WHERE id = 9').get()).toEqual({ profile_id: 1 });
    expect(db.prepare("SELECT value FROM app_settings WHERE key = 'current_profile_id'").get()).toEqual({ value: '1' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM profiles').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM daily_entries').get()).toEqual({ count: 1 });
  });

  it('keeps legacy child records attached to the migrated daily entry', () => {
    const db = legacyDatabase();
    db.exec(`
      CREATE TABLE weight_measurements (id INTEGER PRIMARY KEY, daily_entry_id INTEGER NOT NULL REFERENCES daily_entries(id) ON DELETE CASCADE, measured_at TEXT NOT NULL, weight_kg REAL NOT NULL, note TEXT NOT NULL DEFAULT '');
      CREATE TABLE meals (id INTEGER PRIMARY KEY, daily_entry_id INTEGER NOT NULL REFERENCES daily_entries(id) ON DELETE CASCADE, eaten_at TEXT NOT NULL, meal_type TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', recognition_status TEXT NOT NULL);
      CREATE TABLE meal_images (id INTEGER PRIMARY KEY, meal_id INTEGER NOT NULL REFERENCES meals(id) ON DELETE CASCADE, relative_path TEXT NOT NULL, mime_type TEXT NOT NULL, file_size INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE food_items (id INTEGER PRIMARY KEY, meal_id INTEGER NOT NULL REFERENCES meals(id) ON DELETE CASCADE, name TEXT NOT NULL, amount REAL NOT NULL, unit TEXT NOT NULL, cooking_method TEXT NOT NULL, confidence REAL NOT NULL, needs_confirmation INTEGER NOT NULL, is_user_confirmed INTEGER NOT NULL, source TEXT NOT NULL, notes TEXT NOT NULL);
      CREATE TABLE workouts (id INTEGER PRIMARY KEY, daily_entry_id INTEGER NOT NULL REFERENCES daily_entries(id) ON DELETE CASCADE, started_at TEXT NOT NULL, workout_type TEXT NOT NULL, duration_minutes INTEGER, perceived_difficulty REAL, notes TEXT NOT NULL);
      CREATE TABLE exercises (id INTEGER PRIMARY KEY, workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE, name TEXT NOT NULL, weight REAL, weight_unit TEXT NOT NULL, sets INTEGER NOT NULL, repetitions INTEGER NOT NULL, completed INTEGER NOT NULL, notes TEXT NOT NULL);
      CREATE TABLE body_feedback (id INTEGER PRIMARY KEY, daily_entry_id INTEGER NOT NULL REFERENCES daily_entries(id) ON DELETE CASCADE, recorded_at TEXT NOT NULL, category TEXT NOT NULL, body_part TEXT NOT NULL, severity REAL NOT NULL, impact TEXT NOT NULL, description TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO weight_measurements VALUES (1, 7, '2026-10-10T08:00:00Z', 70, '');
      INSERT INTO meals VALUES (2, 7, '2026-10-10T12:00:00Z', 'lunch', '', 'unrecognized');
      INSERT INTO meal_images VALUES (3, 2, 'images/lunch.png', 'image/png', 1, '2026-10-10T12:00:00Z');
      INSERT INTO food_items VALUES (4, 2, 'Rice', 1, 'bowl', '', 1, 0, 1, 'user', '');
      INSERT INTO workouts VALUES (5, 7, '2026-10-10T18:00:00Z', 'strength', 45, 5, '');
      INSERT INTO exercises VALUES (6, 5, 'Squat', 50, 'kg', 3, 8, 1, '');
      INSERT INTO body_feedback VALUES (7, 7, '2026-10-10T19:00:00Z', 'fatigue', 'legs', 2, '', 'tired', '2026-10-10T19:00:00Z');
    `);

    migrate(db);

    expect(db.prepare('SELECT daily_entry_id FROM weight_measurements WHERE id = 1').get()).toEqual({ daily_entry_id: 7 });
    expect(db.prepare('SELECT daily_entry_id FROM meals WHERE id = 2').get()).toEqual({ daily_entry_id: 7 });
    expect(db.prepare('SELECT meal_id FROM meal_images WHERE id = 3').get()).toEqual({ meal_id: 2 });
    expect(db.prepare('SELECT meal_id FROM food_items WHERE id = 4').get()).toEqual({ meal_id: 2 });
    expect(db.prepare('SELECT daily_entry_id FROM workouts WHERE id = 5').get()).toEqual({ daily_entry_id: 7 });
    expect(db.prepare('SELECT workout_id FROM exercises WHERE id = 6').get()).toEqual({ workout_id: 5 });
    expect(db.prepare('SELECT daily_entry_id FROM body_feedback WHERE id = 7').get()).toEqual({ daily_entry_id: 7 });
  });

  it('uses the migrated profiles table rather than the legacy singleton for reads', () => {
    const db = legacyDatabase();
    migrate(db);
    db.prepare("UPDATE profile SET goal = 'fat_loss' WHERE id = 1").run();

    expect(createRepositories(db).profile.get()).toMatchObject({ goal: 'maintain' });
  });

  it('repairs an early phase 2A database without leaving null ownership', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT 'now');
      CREATE TABLE profiles (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, status TEXT NOT NULL, goal TEXT NOT NULL,
        goal_description TEXT NOT NULL, height_cm REAL NOT NULL, age INTEGER NOT NULL, sex TEXT NOT NULL,
        training_experience TEXT NOT NULL, equipment TEXT NOT NULL, training_days_per_week INTEGER NOT NULL,
        session_duration_minutes INTEGER NOT NULL, diet_preferences TEXT NOT NULL, allergies TEXT NOT NULL,
        health_restrictions TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
      );
      CREATE TABLE daily_entries (
        id INTEGER PRIMARY KEY, profile_id INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
        entry_date TEXT NOT NULL, status TEXT NOT NULL, status_note TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE recommendations (
        id INTEGER PRIMARY KEY, profile_id INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
        range_start TEXT NOT NULL, range_end TEXT NOT NULL, model_name TEXT NOT NULL, generated_at TEXT NOT NULL,
        input_summary_json TEXT NOT NULL, report_markdown TEXT NOT NULL, structured_report_json TEXT NOT NULL, status TEXT NOT NULL
      );
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_migrations (version) VALUES (1);
      INSERT INTO profiles VALUES (4, 'Default', 'active', 'maintain', '', 175, 30, 'unspecified', 'beginner', 'home', 3, 45, '', '', '', '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z', NULL);
      INSERT INTO app_settings VALUES ('current_profile_id', '4');
      INSERT INTO daily_entries VALUES (7, NULL, '2026-10-10', 'training', '', '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z');
      INSERT INTO recommendations VALUES (9, NULL, '2026-10-01', '2026-10-10', 'mock', '2026-10-10T00:00:00.000Z', '{}', 'report', '{}', 'completed');
    `);

    migrate(db);

    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }]);
    expect(db.prepare('SELECT profile_id FROM daily_entries WHERE id = 7').get()).toEqual({ profile_id: 4 });
    expect(db.prepare('SELECT profile_id FROM recommendations WHERE id = 9').get()).toEqual({ profile_id: 4 });
    expect(db.prepare('PRAGMA table_info(daily_entries)').all()).toContainEqual(expect.objectContaining({ name: 'profile_id', notnull: 1 }));
    expect(db.prepare('PRAGMA table_info(recommendations)').all()).toContainEqual(expect.objectContaining({ name: 'profile_id', notnull: 1 }));
  });

  it('rolls back every migration change when legacy data cannot be copied', () => {
    const db = legacyDatabase();
    db.prepare('UPDATE profile SET training_days_per_week = 99 WHERE id = 1').run();

    expect(() => migrate(db)).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'profiles'").get()).toBeUndefined();
    expect(db.prepare('SELECT * FROM daily_entries WHERE id = 7').get()).toEqual(expect.objectContaining({ entry_date: '2026-10-10' }));
    expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 1 }]);
    expect(db.prepare('SELECT id, training_days_per_week FROM profile').get()).toEqual({ id: 1, training_days_per_week: 99 });
  });
});
