import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createRepositories, migrate } from '@fitness-coach/db';
import { buildApp } from './app.js';
import { createProfileScope } from './services/profileScope.js';

const profileInput = (name: string) => ({
  name,
  goal: 'maintain' as const,
  goal_description: '',
  height_cm: 175,
  age: 30,
  sex: 'unspecified' as const,
  training_experience: 'beginner',
  equipment: 'home',
  training_days_per_week: 3,
  session_duration_minutes: 45,
  diet_preferences: 'none',
  allergies: 'none',
  health_restrictions: 'none',
});

describe('profile-scoped repositories', () => {
  it('locks one profile scope for the duration of a request', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repositories = createRepositories(db);
    const profileA = repositories.profiles.create(profileInput('A'));
    const profileB = repositories.profiles.create(profileInput('B'));
    repositories.profiles.setCurrentId(profileA.id);
    const scope = createProfileScope(repositories) as ReturnType<typeof createProfileScope> & {
      runWithCurrentProfile<T>(callback: () => Promise<T>): Promise<T>;
    };

    await scope.runWithCurrentProfile(async () => {
      expect(scope.repositories.profile.get()).toMatchObject({ id: profileA.id });
      repositories.profiles.setCurrentId(profileB.id);
      await Promise.resolve();
      expect(scope.repositories.profile.get()).toMatchObject({ id: profileA.id });
      expect(scope.repositories.dailyEntry.save({ entry_date: '2026-10-10', status: 'training' })).toMatchObject({ profile_id: profileA.id });
    });

    expect(repositories.forProfile(profileA.id).dailyEntry.getByDate('2026-10-10')).toBeDefined();
    expect(repositories.forProfile(profileB.id).dailyEntry.getByDate('2026-10-10')).toBeUndefined();
  });

  it('does not expose any A records through profile B scope or foreign child IDs', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repositories = createRepositories(db);
    const profileA = repositories.profiles.create(profileInput('A'));
    const profileB = repositories.profiles.create(profileInput('B'));
    const a = repositories.forProfile(profileA.id);
    const b = repositories.forProfile(profileB.id);

    const entry = a.dailyEntry.save({ entry_date: '2026-10-10', status: 'training' })!;
    const weight = a.weight.save(entry.id, { measured_at: '2026-10-10T08:00:00Z', weight_kg: 70, note: '' })!;
    const meal = a.meal.save(entry.id, { eaten_at: '2026-10-10T12:00:00Z', meal_type: 'lunch', notes: '', recognition_status: 'unrecognized' })!;
    const image = a.image.save(meal.id, { relative_path: 'images/a.png', mime_type: 'image/png', file_size: 1 })!;
    const food = a.foodItem.save(meal.id, {
      name: 'Rice', amount: 1, unit: 'bowl', cooking_method: '', confidence: 1,
      needs_confirmation: false, is_user_confirmed: true, source: 'user', notes: '',
    })!;
    const workout = a.workout.save(entry.id, { started_at: '2026-10-10T18:00:00Z', workout_type: 'strength', notes: '' })!;
    const exercise = a.exercise.save(workout.id, { name: 'Squat', weight: 50, weight_unit: 'kg', sets: 3, repetitions: 8, completed: true, notes: '' })!;
    const feedback = a.feedback.save(entry.id, {
      recorded_at: '2026-10-10T19:00:00Z', category: 'fatigue', body_part: 'legs', severity: 2, impact: '', description: 'tired',
    })!;
    const recommendation = a.recommendation.save({
      profile_id: profileA.id,
      range_start: '2026-10-10', range_end: '2026-10-10', model_name: 'mock',
      input_summary_json: '{}', report_markdown: 'report', structured_report_json: '{}', status: 'completed',
    })!;

    expect(b.dailyEntry.getByDate('2026-10-10')).toBeUndefined();
    expect(b.dailyEntry.listRange('2026-10-01', '2026-10-31')).toEqual([]);
    expect(b.weight.get(weight.id)).toBeUndefined();
    expect(b.meal.get(meal.id)).toBeUndefined();
    expect(b.image.get(image.id)).toBeUndefined();
    expect(b.foodItem.get(food.id)).toBeUndefined();
    expect(b.workout.get(workout.id)).toBeUndefined();
    expect(b.exercise.get(exercise.id)).toBeUndefined();
    expect(b.feedback.get(feedback.id)).toBeUndefined();
    expect(b.recommendation.get(recommendation.id)).toBeUndefined();
    expect(b.recommendation.list()).toEqual([]);
    expect(b.meal.update(meal.id, { notes: 'hijack' })).toBeUndefined();
    expect(b.meal.delete(meal.id)).toBeUndefined();
    expect(a.meal.get(meal.id)).toMatchObject({ notes: '' });
  });

  it('reads and switches the current profile, and rejects writes for archived profiles', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-profile-scope-'));
    const app = await buildApp({ dataDir });
    try {
      const saved = await app.inject({
        method: 'PUT',
        url: '/api/profile',
        payload: profileInput('Default'),
      });
      expect(saved.statusCode).toBe(200);

      const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
      const repositories = createRepositories(db);
      const second = repositories.profiles.create(profileInput('Second'));
      db.prepare('UPDATE profiles SET status = \'archived\', archived_at = \'2026-10-10T00:00:00.000Z\' WHERE id = ?').run(second.id);
      db.close();

      expect((await app.inject({ method: 'GET', url: '/api/current-profile' })).json().data.profile.name).toBe('默认档案');
      expect((await app.inject({ method: 'GET', url: '/api/profiles?status=all' })).json().data).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: '默认档案', status: 'active' }),
        expect.objectContaining({ name: 'Second', status: 'archived' }),
      ]));
      const switched = await app.inject({ method: 'PUT', url: '/api/current-profile', payload: { profileId: second.id } });
      expect(switched.statusCode).toBe(400);
      expect(switched.json()).toMatchObject({ ok: false, error: { code: 'PROFILE_ARCHIVED' } });

      const db2 = new Database(join(dataDir, 'fitness-coach.sqlite'));
      db2.prepare("UPDATE app_settings SET value = ? WHERE key = 'current_profile_id'").run(String(second.id));
      db2.close();
      const write = await app.inject({ method: 'PUT', url: '/api/daily-entries/2026-10-10', payload: { status: 'training' } });
      expect(write.statusCode).toBe(409);
      expect(write.json()).toMatchObject({ ok: false, error: { code: 'PROFILE_ARCHIVED' } });
    } finally {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('fails closed for scoped reads and writes when no current profile exists', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-profile-required-'));
    const app = await buildApp({ dataDir });
    try {
      const reads = [
        { method: 'GET' as const, url: '/api/daily-entries?from=2026-10-01&to=2026-10-10' },
        { method: 'GET' as const, url: '/api/recommendations' },
      ];
      for (const request of reads) {
        const response = await app.inject(request);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true, data: [] });
      }
      const writes = [
        { method: 'PUT' as const, url: '/api/daily-entries/2026-10-10', payload: { status: 'training' } },
        { method: 'POST' as const, url: '/api/recommendations', payload: {} },
      ];
      for (const request of writes) {
        const response = await app.inject(request);
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      }
    } finally {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects every existing business write API for an archived profile', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-archived-writes-'));
    const app = await buildApp({ dataDir });
    try {
      await app.inject({ method: 'PUT', url: '/api/profile', payload: profileInput('Default') });
      const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
      db.prepare("UPDATE profiles SET status = 'archived', archived_at = '2026-10-10T00:00:00.000Z'").run();
      db.close();

      const writes = [
        { method: 'PUT' as const, url: '/api/profile', payload: profileInput('Edited') },
        { method: 'PUT' as const, url: '/api/daily-entries/2026-10-10', payload: { status: 'training' } },
        { method: 'POST' as const, url: '/api/daily-entries/2026-10-10/weights', payload: {} },
        { method: 'POST' as const, url: '/api/daily-entries/2026-10-10/meals', payload: {} },
        { method: 'PATCH' as const, url: '/api/meals/1', payload: { notes: 'blocked' } },
        { method: 'DELETE' as const, url: '/api/meals/1' },
        { method: 'POST' as const, url: '/api/meals/1/recognize' },
        { method: 'POST' as const, url: '/api/meals/1/confirm-food-items', payload: { items: [] } },
        { method: 'POST' as const, url: '/api/daily-entries/2026-10-10/workouts', payload: {} },
        { method: 'POST' as const, url: '/api/workouts/1/exercises', payload: {} },
        { method: 'POST' as const, url: '/api/daily-entries/2026-10-10/feedback', payload: {} },
        { method: 'POST' as const, url: '/api/meals/1/images', payload: {} },
        { method: 'DELETE' as const, url: '/api/images/1' },
        { method: 'POST' as const, url: '/api/recommendations/preview', payload: {} },
        { method: 'POST' as const, url: '/api/recommendations', payload: {} },
      ];
      for (const request of writes) {
        const response = await app.inject(request);
        expect(response.statusCode, `${request.method} ${request.url}`).toBe(409);
        expect(response.json(), `${request.method} ${request.url}`).toMatchObject({
          ok: false,
          error: { code: 'PROFILE_ARCHIVED' },
        });
      }
    } finally {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('recovers processing meals for active profiles on restart without mutating archived profiles', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-processing-recovery-scope-'));
    let app = await buildApp({ dataDir });
    try {
      const activeResponse = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Active recovery') });
      const activeId = activeResponse.json().data.id as number;
      const archivedResponse = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Archived recovery') });
      const archivedId = archivedResponse.json().data.id as number;
      const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
      try {
        const addMeal = (profileId: number, date: string) => {
          const entryId = Number(db.prepare('INSERT INTO daily_entries (profile_id, entry_date, status) VALUES (?, ?, \'rest\')').run(profileId, date).lastInsertRowid);
          db.prepare("INSERT INTO meals (daily_entry_id, eaten_at, meal_type, recognition_status) VALUES (?, ?, 'lunch', 'processing')").run(entryId, `${date}T12:00:00Z`);
        };
        addMeal(activeId, '2026-10-11');
        addMeal(archivedId, '2026-10-12');
        db.prepare("UPDATE profiles SET status = 'archived', archived_at = '2026-10-13T00:00:00.000Z' WHERE id = ?").run(archivedId);
      } finally {
        db.close();
      }

      await app.close();
      app = await buildApp({ dataDir });

      const recovered = new Database(join(dataDir, 'fitness-coach.sqlite'));
      try {
        expect(recovered.prepare(`SELECT m.recognition_status FROM meals m JOIN daily_entries d ON d.id = m.daily_entry_id WHERE d.profile_id = ?`).get(activeId)).toEqual({ recognition_status: 'failed' });
        expect(recovered.prepare(`SELECT m.recognition_status FROM meals m JOIN daily_entries d ON d.id = m.daily_entry_id WHERE d.profile_id = ?`).get(archivedId)).toEqual({ recognition_status: 'processing' });
      } finally {
        recovered.close();
      }
    } finally {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
