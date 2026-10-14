import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDatabase } from '@fitness-coach/db';
import { buildApp } from './app.js';

const date = '2026-09-28';
const nextDate = '2026-09-29';
const profile = {
  goal: 'maintain', height_cm: 175, age: 30, sex: 'unspecified',
  training_experience: 'intermediate', equipment: 'home gym',
  training_days_per_week: 4, session_duration_minutes: 60,
  diet_preferences: 'balanced', allergies: 'none', health_restrictions: 'none',
};
const weight = { measured_at: `${date}T07:00:00Z`, weight_kg: 72.5, note: 'morning' };
const meal = { eaten_at: `${date}T12:00:00Z`, meal_type: 'lunch', notes: 'rice', recognition_status: 'unrecognized' };
const workout = { started_at: `${date}T17:00:00Z`, workout_type: 'strength', duration_minutes: 45, perceived_difficulty: 6, notes: 'upper body' };
const exercise = { name: 'squat', weight: 50, weight_unit: 'kg', sets: 3, repetitions: 8, completed: true, notes: '' };
const feedback = { recorded_at: `${date}T19:00:00Z`, category: 'fatigue', body_part: 'legs', severity: 3, impact: 'walking', description: 'tired' };
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex');

function multipart(bytes: Buffer, mimeType = 'image/png', filename = 'lunch.png') {
  const boundary = 'fitness-coach-test-boundary';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

describe('local records API', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let outsidePath: string | undefined;
  let outsideDir: string | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-records-'));
    app = await buildApp({ dataDir });
    await app.inject({ method: 'PUT', url: '/api/profile', payload: profile });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    if (outsidePath) await rm(outsidePath, { force: true });
    if (outsideDir) await rm(outsideDir, { recursive: true, force: true });
    outsidePath = undefined;
    outsideDir = undefined;
  });

  async function request(method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
    return app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  }

  async function createEntry(entryDate = date) {
    const response = await request('PUT', `/api/daily-entries/${entryDate}`, { status: 'training', status_note: 'planned' });
    expect(response.statusCode).toBe(200);
    return response.json().data as { id: number; entry_date: string };
  }

  async function createMeal() {
    await createEntry();
    const response = await request('POST', `/api/daily-entries/${date}/meals`, meal);
    expect(response.statusCode).toBe(201);
    return response.json().data as { id: number };
  }

  async function createWorkout() {
    await createEntry();
    const response = await request('POST', `/api/daily-entries/${date}/workouts`, workout);
    expect(response.statusCode).toBe(201);
    return response.json().data as { id: number };
  }

  async function upload(mealId: number, bytes = png, mimeType = 'image/png') {
    return app.inject({ method: 'POST', url: `/api/meals/${mealId}/images`, ...multipart(bytes, mimeType) });
  }

  function count(table: string) {
    const db = openDatabase(join(dataDir, 'fitness-coach.sqlite'));
    try {
      return (db.prepare(`SELECT count(*) AS total FROM ${table}`).get() as { total: number }).total;
    } finally {
      db.close();
    }
  }

  it('reads and updates the current migrated profile', async () => {
    const empty = await request('GET', '/api/profile');
    expect(empty.statusCode).toBe(200);
    expect(empty.json().data).toMatchObject({ id: 1, name: '默认档案', status: 'active', ...profile });

    const saved = await request('PUT', '/api/profile', profile);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ ok: true, data: { id: 1, ...profile } });
    const updated = await request('PUT', '/api/profile', { ...profile, goal: 'muscle_gain' });
    expect(updated.statusCode).toBe(200);
    expect((await request('GET', '/api/profile')).json().data).toMatchObject({ id: 1, goal: 'muscle_gain' });
    expect(count('profiles')).toBe(1);
  });

  it.each([
    { age: 0 }, { height_cm: -1 }, { training_days_per_week: 8 },
    { goal: 'invalid' }, { session_duration_minutes: 0 },
  ])('rejects an invalid profile: %j', async (change) => {
    const response = await request('PUT', '/api/profile', { ...profile, ...change });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(count('profiles')).toBe(1);
  });

  it('stores model settings without ever returning the key, then clears the key', async () => {
    const key = 'sk-never-expose-this-value';
    const initial = await request('GET', '/api/settings/model');
    expect(initial.statusCode).toBe(200);
    expect(initial.json().data).toMatchObject({ configured: false });
    const settings = { base_url: 'https://example.test/v1', model_name: 'test-model', api_key: key };
    const saved = await request('PUT', '/api/settings/model', settings);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ ok: true, data: { baseUrl: settings.base_url, modelName: settings.model_name, configured: true } });
    expect(saved.body).not.toContain(key);

    const read = await request('GET', '/api/settings/model');
    expect(read.statusCode).toBe(200);
    expect(read.json().data).toEqual({ baseUrl: settings.base_url, modelName: settings.model_name, configured: true });
    expect(read.body).not.toContain(key);
    expect(read.body).not.toMatch(/api_key/i);

    const cleared = await request('DELETE', '/api/settings/model');
    expect(cleared.statusCode).toBe(200);
    expect(cleared.body).not.toContain(key);
    const after = await request('GET', '/api/settings/model');
    expect(after.json().data).toMatchObject({ configured: false });
    expect(after.body).not.toContain(key);
    expect(after.body).not.toMatch(/api_key/i);
    await app.close();
    app = await buildApp({ dataDir });
    expect((await request('GET', '/api/settings/model')).json().data).toMatchObject({ configured: false });
  });

  it('does not leave a new secret when model metadata cannot be committed', async () => {
    const key = 'sk-atomicity-check';
    const db = openDatabase(join(dataDir, 'fitness-coach.sqlite'));
    try {
      db.exec("CREATE TRIGGER reject_model_settings BEFORE INSERT ON app_settings BEGIN SELECT RAISE(ABORT, 'settings rejected'); END");
    } finally {
      db.close();
    }

    const response = await request('PUT', '/api/settings/model', {
      base_url: 'https://example.test/v1', model_name: 'atomicity-check', api_key: key,
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    await expect(readFile(join(dataDir, 'model-api-key.secret'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(response.body).not.toContain(key);
  });

  it('keeps the model key in a mode-0600 secret file instead of SQLite', async () => {
    const key = 'sk-file-only-secret';
    const saved = await request('PUT', '/api/settings/model', {
      base_url: 'https://example.test/v1', model_name: 'file-model', api_key: key,
    });
    expect(saved.statusCode).toBe(200);
    const secretPath = join(dataDir, 'model-api-key.secret');
    expect(await readFile(secretPath, 'utf8')).toBe(key);
    expect((await stat(secretPath)).mode & 0o777).toBe(0o600);

    const db = openDatabase(join(dataDir, 'fitness-coach.sqlite'));
    try {
      const rows = db.prepare('SELECT key, value FROM app_settings ORDER BY key').all() as Array<{ key: string; value: string }>;
      expect(rows).toEqual(expect.arrayContaining([
        { key: 'model_base_url', value: 'https://example.test/v1' },
        { key: 'model_name', value: 'file-model' },
      ]));
      expect(JSON.stringify(rows)).not.toContain(key);
    } finally {
      db.close();
    }

    await app.close();
    app = await buildApp({ dataDir });
    expect((await request('GET', '/api/settings/model')).json()).toEqual({
      ok: true,
      data: { baseUrl: 'https://example.test/v1', modelName: 'file-model', configured: true },
    });
    const cleared = await request('DELETE', '/api/settings/model');
    expect(cleared.json()).toEqual({
      ok: true,
      data: { baseUrl: 'https://example.test/v1', modelName: 'file-model', configured: false },
    });
    await expect(readFile(secretPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    { base_url: 'not a URL', model_name: 'model', api_key: 'secret' },
    { base_url: 'https://example.test/v1', model_name: ' ', api_key: 'secret' },
  ])('rejects invalid model configuration: %j', async (settings) => {
    const response = await request('PUT', '/api/settings/model', settings);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(response.body).not.toContain(settings.api_key);
  });

  it('reads missing dates without creating an entry or treating them as rest days', async () => {
    const missing = await request('GET', `/api/daily-entries/${date}`);
    expect(missing.statusCode).toBe(200);
    expect(missing.json().ok).toBe(true);
    const emptyEntry = missing.json().data;
    if (emptyEntry !== null) {
      expect(emptyEntry).toMatchObject({ entry_date: date });
      expect(emptyEntry.status).not.toBe('rest');
    }
    expect(count('daily_entries')).toBe(0);
    const range = await request('GET', `/api/daily-entries?from=${date}&to=${nextDate}`);
    expect(range.statusCode).toBe(200);
    expect(range.json()).toEqual({ ok: true, data: [] });
    expect(count('daily_entries')).toBe(0);
  });

  it('upserts statuses and lists only dates in the inclusive requested range', async () => {
    await createEntry('2026-09-27');
    const first = await createEntry();
    const update = await request('PUT', `/api/daily-entries/${date}`, { status: 'rest', status_note: 'recovery' });
    expect(update.statusCode).toBe(200);
    expect(update.json().data).toMatchObject({ id: first.id, entry_date: date, status: 'rest' });
    await createEntry(nextDate);
    const range = await request('GET', `/api/daily-entries?from=${date}&to=${nextDate}`);
    expect(range.statusCode).toBe(200);
    expect(range.json().data.map((entry: { entry_date: string }) => entry.entry_date)).toEqual([date, nextDate]);
    expect(count('daily_entries')).toBe(3);
  });

  it.each([
    ['/api/daily-entries/2026-02-30', { status: 'training' }],
    [`/api/daily-entries/${date}`, { status: 'unknown' }],
  ])('rejects invalid date or status on PUT %s', async (url, payload) => {
    const response = await request('PUT', url, payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(count('daily_entries')).toBe(0);
  });

  it.each(['?from=2026-02-30&to=2026-09-28', '?from=2026-09-29&to=2026-09-28', '?from=2026-09-28', '?from=bad&to=bad'])('rejects invalid date ranges %s', async (query) => {
    const response = await request('GET', `/api/daily-entries${query}`);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });

  it('creates, patches and deletes one of several weights on the same day', async () => {
    await createEntry();
    const first = await request('POST', `/api/daily-entries/${date}/weights`, weight);
    const second = await request('POST', `/api/daily-entries/${date}/weights`, { ...weight, measured_at: `${date}T20:00:00Z`, weight_kg: 73 });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const firstId = first.json().data.id;
    expect(second.json().data.id).not.toBe(firstId);
    const patched = await request('PATCH', `/api/daily-entries/${date}/weights`, { id: firstId, weight_kg: 72 });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().data).toMatchObject({ id: firstId, weight_kg: 72 });
    expect((await request('GET', `/api/daily-entries/${date}`)).json().data.weights).toHaveLength(2);
    expect((await request('DELETE', `/api/daily-entries/${date}/weights`, { id: firstId })).statusCode).toBe(200);
    expect((await request('GET', `/api/daily-entries/${date}`)).json().data.weights).toMatchObject([{ weight_kg: 73 }]);
  });

  it('creates several meals and patches a meal through both advertised routes', async () => {
    await createEntry();
    const first = await request('POST', `/api/daily-entries/${date}/meals`, meal);
    const second = await request('POST', `/api/daily-entries/${date}/meals`, { ...meal, eaten_at: `${date}T19:00:00Z`, meal_type: 'dinner' });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().data.id).not.toBe(second.json().data.id);
    const id = first.json().data.id;
    expect((await request('PATCH', `/api/daily-entries/${date}/meals`, { id, notes: 'edited' })).json().data).toMatchObject({ notes: 'edited' });
    const updated = await request('PATCH', `/api/meals/${id}`, { meal_type: 'brunch' });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data).toMatchObject({ id, meal_type: 'brunch', notes: 'edited' });
    const invalid = await request('PATCH', `/api/meals/${id}`, { recognition_status: 'done' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect((await request('GET', `/api/daily-entries/${date}`)).json().data.meals).toHaveLength(2);
    expect((await request('GET', `/api/daily-entries/${date}`)).json().data.meals[0]).toMatchObject({ recognition_status: 'unrecognized' });
  });

  it.each(['processing', 'needs_review', 'confirmed', 'failed'])('does not allow meal creation with recognition status %s', async (recognition_status) => {
    await createEntry();

    const response = await request('POST', `/api/daily-entries/${date}/meals`, { ...meal, recognition_status });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(count('meals')).toBe(0);
  });

  it.each(['processing', 'needs_review', 'confirmed', 'failed'])('does not allow meal patching to recognition status %s', async (recognition_status) => {
    const saved = await createMeal();

    const direct = await request('PATCH', `/api/meals/${saved.id}`, { recognition_status });
    const scoped = await request('PATCH', `/api/daily-entries/${date}/meals`, { id: saved.id, recognition_status });

    expect(direct.statusCode).toBe(400);
    expect(scoped.statusCode).toBe(400);
    expect((await request('GET', `/api/daily-entries/${date}`)).json().data.meals[0].recognition_status).toBe('unrecognized');
  });

  it('does not allow a user meal patch to combine editable fields with a recognition status', async () => {
    const saved = await createMeal();

    const direct = await request('PATCH', `/api/meals/${saved.id}`, { notes: 'edited', recognition_status: 'confirmed' });
    const scoped = await request('PATCH', `/api/daily-entries/${date}/meals`, { id: saved.id, notes: 'edited', recognition_status: 'confirmed' });

    expect(direct.statusCode).toBe(400);
    expect(scoped.statusCode).toBe(400);
    expect((await request('GET', `/api/daily-entries/${date}`)).json().data.meals[0]).toMatchObject({
      notes: 'rice', recognition_status: 'unrecognized',
    });
  });

  it('creates several workouts and several exercises, patches and deletes only the selected records', async () => {
    await createEntry();
    const first = await request('POST', `/api/daily-entries/${date}/workouts`, workout);
    const second = await request('POST', `/api/daily-entries/${date}/workouts`, { ...workout, started_at: `${date}T20:00:00Z`, workout_type: 'cardio' });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const workoutId = first.json().data.id;
    const a = await request('POST', `/api/workouts/${workoutId}/exercises`, exercise);
    const b = await request('POST', `/api/workouts/${workoutId}/exercises`, { ...exercise, name: 'press' });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().data.id).not.toBe(b.json().data.id);
    const exerciseId = a.json().data.id;
    expect((await request('PATCH', `/api/workouts/${workoutId}/exercises`, { id: exerciseId, completed: false })).json().data).toMatchObject({ completed: false });
    expect((await request('PATCH', `/api/daily-entries/${date}/workouts`, { id: workoutId, notes: 'revised' })).json().data).toMatchObject({ notes: 'revised' });
    expect((await request('DELETE', `/api/workouts/${workoutId}/exercises`, { id: exerciseId })).statusCode).toBe(200);
    expect(count('exercises')).toBe(1);
    expect((await request('DELETE', `/api/daily-entries/${date}/workouts`, { id: workoutId })).statusCode).toBe(200);
    expect(count('exercises')).toBe(0);
    expect((await request('GET', `/api/daily-entries/${date}`)).json().data.workouts).toMatchObject([{ id: second.json().data.id }]);
  });

  it('creates multiple feedback entries and updates or removes just one', async () => {
    await createEntry();
    const first = await request('POST', `/api/daily-entries/${date}/feedback`, feedback);
    const second = await request('POST', `/api/daily-entries/${date}/feedback`, { ...feedback, category: 'pain', severity: 5 });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const id = first.json().data.id;
    expect(second.json().data.id).not.toBe(id);
    expect((await request('PATCH', `/api/daily-entries/${date}/feedback`, { id, severity: 1 })).json().data).toMatchObject({ severity: 1 });
    const invalid = await request('PATCH', `/api/daily-entries/${date}/feedback`, { id, severity: 11 });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect((await request('GET', `/api/daily-entries/${date}`)).json().data.feedback).toHaveLength(2);
    expect((await request('DELETE', `/api/daily-entries/${date}/feedback`, { id })).statusCode).toBe(200);
    expect((await request('GET', `/api/daily-entries/${date}`)).json().data.feedback).toMatchObject([{ category: 'pain' }]);
  });

  it.each([
    [`/api/daily-entries/${date}/weights`, { ...weight, weight_kg: 0 }],
    [`/api/daily-entries/${date}/meals`, { ...meal, recognition_status: 'done' }],
    [`/api/daily-entries/${date}/workouts`, { ...workout, duration_minutes: -1 }],
    [`/api/daily-entries/${date}/feedback`, { ...feedback, severity: 11 }],
  ])('rejects invalid child payloads at %s without inserting them', async (url, payload) => {
    await createEntry();
    const response = await request('POST', url, payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(count({ weights: 'weight_measurements', meals: 'meals', workouts: 'workouts', feedback: 'body_feedback' }[url.split('/').at(-1)!] ?? 'daily_entries')).toBe(0);
  });

  it('rejects invalid exercise fields without inserting anything', async () => {
    const parent = await createWorkout();
    for (const invalid of [{ sets: 0 }, { repetitions: -1 }, { completed: 'yes' }, { weight: -1 }]) {
      const response = await request('POST', `/api/workouts/${parent.id}/exercises`, { ...exercise, ...invalid });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    }
    expect(count('exercises')).toBe(0);
  });

  it('validates malformed date, ID and partial updates without changing stored records', async () => {
    const invalidDate = await request('GET', '/api/daily-entries/2026-02-30');
    expect(invalidDate.statusCode).toBe(400);
    expect(invalidDate.json()).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    await createEntry();
    const saved = await request('POST', `/api/daily-entries/${date}/weights`, weight);
    expect(saved.statusCode).toBe(201);
    const invalidId = await request('PATCH', `/api/daily-entries/${date}/weights`, { id: 'not-an-id', weight_kg: 72 });
    expect(invalidId.statusCode).toBe(400);
    const invalidValue = await request('PATCH', `/api/daily-entries/${date}/weights`, { id: saved.json().data.id, weight_kg: -1 });
    expect(invalidValue.statusCode).toBe(400);
    expect(count('weight_measurements')).toBe(1);
    expect((await request('GET', `/api/daily-entries/${date}`)).json().data.weights).toMatchObject([{ weight_kg: 72.5 }]);
  });

  it.each([
    ['POST', `/api/daily-entries/${date}/weights`, weight],
    ['POST', `/api/daily-entries/${date}/meals`, meal],
    ['POST', `/api/daily-entries/${date}/workouts`, workout],
    ['POST', `/api/daily-entries/${date}/feedback`, feedback],
    ['POST', '/api/workouts/999999/exercises', exercise],
    ['PATCH', '/api/meals/999999', { notes: 'no parent' }],
  ] as const)('returns NOT_FOUND for unknown parent: %s %s', async (method, url, payload) => {
    const response = await request(method, url, payload);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('does not allow a child ID to be patched or deleted through a different day or workout', async () => {
    await createEntry();
    await createEntry(nextDate);
    const savedWeight = await request('POST', `/api/daily-entries/${date}/weights`, weight);
    const savedWorkout = await request('POST', `/api/daily-entries/${date}/workouts`, workout);
    const otherWorkout = await request('POST', `/api/daily-entries/${nextDate}/workouts`, { ...workout, started_at: `${nextDate}T17:00:00Z` });
    const savedExercise = await request('POST', `/api/workouts/${savedWorkout.json().data.id}/exercises`, exercise);
    expect((await request('PATCH', `/api/daily-entries/${nextDate}/weights`, { id: savedWeight.json().data.id, weight_kg: 1 })).statusCode).toBe(404);
    expect((await request('DELETE', `/api/workouts/${otherWorkout.json().data.id}/exercises`, { id: savedExercise.json().data.id })).statusCode).toBe(404);
    expect(count('weight_measurements')).toBe(1);
    expect(count('exercises')).toBe(1);
  });

  it('uploads multiple local images, serves exact bytes and removes file and row on delete', async () => {
    const parent = await createMeal();
    const first = await upload(parent.id);
    const second = await upload(parent.id);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const image = first.json().data as { id: number; relative_path: string; mime_type: string; file_size: number };
    expect(image).toMatchObject({ mime_type: 'image/png', file_size: png.length });
    expect(image.id).not.toBe(second.json().data.id);
    expect(image.relative_path.startsWith('/')).toBe(false);
    expect(image.relative_path.split(/[\\/]/)).not.toContain('..');
    const localPath = resolve(dataDir, image.relative_path);
    expect(localPath.startsWith(`${resolve(dataDir)}${sep}`)).toBe(true);
    expect(await readFile(localPath)).toEqual(png);
    const served = await request('GET', `/api/images/${image.id}`);
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toContain('image/png');
    expect(served.rawPayload).toEqual(png);
    expect((await request('GET', `/api/daily-entries/${date}`)).json().data.meals[0].images).toHaveLength(2);
    expect((await request('DELETE', `/api/images/${image.id}`)).statusCode).toBe(200);
    await expect(stat(localPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(count('meal_images')).toBe(1);
    expect((await request('GET', `/api/images/${image.id}`)).statusCode).toBe(404);
  });

  it('rejects unsupported image MIME and oversized uploads without files or references', async () => {
    const parent = await createMeal();
    const unsupported = await upload(parent.id, Buffer.from('not an image'), 'text/plain');
    expect(unsupported.statusCode).toBe(400);
    const justOverLimit = await upload(parent.id, Buffer.alloc(10 * 1024 * 1024 + 1));
    expect(justOverLimit.statusCode).toBe(413);
    const oversized = await upload(parent.id, Buffer.alloc(20 * 1024 * 1024, 1));
    expect(oversized.statusCode).toBe(413);
    expect(count('meal_images')).toBe(0);
    expect(await readdir(join(dataDir, 'images'))).toEqual([]);
  });

  it('returns 404 when uploading to an unknown meal without leaving a file', async () => {
    const response = await upload(999999);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(count('meal_images')).toBe(0);
    expect(await readdir(join(dataDir, 'images'))).toEqual([]);
  });

  it('never serves or deletes a stored image path that escapes the data directory', async () => {
    const parent = await createMeal();
    outsidePath = join(tmpdir(), `${basename(dataDir)}-outside.png`);
    await writeFile(outsidePath, Buffer.from('private data'));
    const db = openDatabase(join(dataDir, 'fitness-coach.sqlite'));
    let imageId: number;
    try {
      imageId = Number(db.prepare('INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size) VALUES (?, ?, ?, ?)').run(parent.id, `../${basename(outsidePath)}`, 'image/png', 12).lastInsertRowid);
    } finally {
      db.close();
    }
    const served = await request('GET', `/api/images/${imageId}`);
    expect(served.statusCode).toBeGreaterThanOrEqual(400);
    expect(served.body).not.toContain('private data');
    const deleted = await request('DELETE', `/api/images/${imageId}`);
    expect(deleted.statusCode).toBeGreaterThanOrEqual(400);
    expect(await readFile(outsidePath, 'utf8')).toBe('private data');
  });

  it('marks malicious aggregate image paths as unavailable without probing outside dataDir', async () => {
    const parent = await createMeal();
    outsidePath = join(tmpdir(), `${basename(dataDir)}-aggregate-outside.png`);
    await writeFile(outsidePath, Buffer.from('private aggregate data'));
    const db = openDatabase(join(dataDir, 'fitness-coach.sqlite'));
    try {
      db.prepare('INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size) VALUES (?, ?, ?, ?)')
        .run(parent.id, `../${basename(outsidePath)}`, 'image/png', 21);
    } finally {
      db.close();
    }

    const entry = await request('GET', `/api/daily-entries/${date}`);
    expect(entry.statusCode).toBe(200);
    expect(entry.json().data.meals[0].images[0]).toMatchObject({ warning: 'FILE_MISSING' });
    expect(entry.body).not.toContain('private aggregate data');
  });

  it('marks nested symlink aggregate image paths as unavailable', async () => {
    const parent = await createMeal();
    outsideDir = await mkdtemp(join(tmpdir(), 'fitness-coach-aggregate-nested-'));
    outsidePath = join(outsideDir, 'private.png');
    await writeFile(outsidePath, 'private nested aggregate data');
    await symlink(outsideDir, join(dataDir, 'images', 'aggregate-nested'));
    const db = openDatabase(join(dataDir, 'fitness-coach.sqlite'));
    try {
      db.prepare('INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size) VALUES (?, ?, ?, ?)')
        .run(parent.id, 'images/aggregate-nested/private.png', 'image/png', 28);
    } finally {
      db.close();
    }

    const entry = await request('GET', `/api/daily-entries/${date}`);
    expect(entry.statusCode).toBe(200);
    expect(entry.json().data.meals[0].images[0]).toMatchObject({ warning: 'FILE_MISSING' });
    expect(entry.body).not.toContain('private nested aggregate data');
  });

  it('does not register an image when writing its file fails', async () => {
    const parent = await createMeal();
    await rm(join(dataDir, 'images'), { recursive: true });
    await writeFile(join(dataDir, 'images'), 'not a directory');
    const response = await upload(parent.id);
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(count('meal_images')).toBe(0);
    expect(count('meals')).toBe(1);
  });

  it('removes a written image if registration in SQLite fails', async () => {
    const parent = await createMeal();
    const db = openDatabase(join(dataDir, 'fitness-coach.sqlite'));
    try {
      db.exec("CREATE TRIGGER reject_image BEFORE INSERT ON meal_images BEGIN SELECT RAISE(ABORT, 'registration rejected'); END");
    } finally {
      db.close();
    }
    const response = await upload(parent.id);
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(count('meal_images')).toBe(0);
    expect(await readdir(join(dataDir, 'images'))).toEqual([]);
  });

  it('does not discard the meal if a previously registered image file goes missing', async () => {
    const parent = await createMeal();
    const uploaded = await upload(parent.id);
    expect(uploaded.statusCode).toBe(201);
    await rm(resolve(dataDir, uploaded.json().data.relative_path));
    expect((await request('GET', `/api/images/${uploaded.json().data.id}`)).statusCode).toBe(404);
    expect((await request('GET', `/api/daily-entries/${date}`)).json().data.meals).toHaveLength(1);
    expect(count('meal_images')).toBe(1);
  });

  it('deletes a missing image reference and returns a readable warning', async () => {
    const parent = await createMeal();
    const uploaded = await upload(parent.id);
    const image = uploaded.json().data;
    await rm(resolve(dataDir, image.relative_path));
    const deleted = await request('DELETE', `/api/images/${image.id}`);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ ok: true, data: { id: image.id, warning: 'FILE_MISSING' } });
    expect(count('meal_images')).toBe(0);
  });

  it('restores an image when database deletion fails', async () => {
    const parent = await createMeal();
    const uploaded = await upload(parent.id);
    const image = uploaded.json().data;
    const localPath = resolve(dataDir, image.relative_path);
    const db = openDatabase(join(dataDir, 'fitness-coach.sqlite'));
    try {
      db.exec("CREATE TRIGGER reject_image_delete BEFORE DELETE ON meal_images BEGIN SELECT RAISE(ABORT, 'delete rejected'); END");
    } finally {
      db.close();
    }
    const deleted = await request('DELETE', `/api/images/${image.id}`);
    expect(deleted.statusCode).toBeGreaterThanOrEqual(400);
    expect(count('meal_images')).toBe(1);
    expect(await readFile(localPath)).toEqual(png);
  });

  it('keeps a tombstone warning when single-image cleanup fails after database deletion', async () => {
    const parent = await createMeal();
    const cleanupPath = join(dataDir, 'images', 'cleanup-directory');
    await mkdir(cleanupPath);
    const db = openDatabase(join(dataDir, 'fitness-coach.sqlite'));
    let imageId: number;
    try {
      imageId = Number(db.prepare('INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size) VALUES (?, ?, ?, ?)')
        .run(parent.id, 'images/cleanup-directory', 'image/png', 12).lastInsertRowid);
    } finally {
      db.close();
    }

    const deleted = await request('DELETE', `/api/images/${imageId}`);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ ok: true, data: { id: imageId, warning: 'CLEANUP_PENDING' } });
    expect(count('meal_images')).toBe(0);
    expect(await readdir(join(dataDir, 'images'))).toEqual([expect.stringMatching(/^\.deleted-/)]);
    await expect(stat(cleanupPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('deletes a meal through its date scope and cleans up image files and references', async () => {
    const parent = await createMeal();
    const uploaded = await upload(parent.id);
    const localPath = resolve(dataDir, uploaded.json().data.relative_path);
    const deleted = await request('DELETE', `/api/daily-entries/${date}/meals`, { id: parent.id });
    expect(deleted.statusCode).toBe(200);
    await expect(stat(localPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(count('meals')).toBe(0);
    expect(count('meal_images')).toBe(0);
  });

  it('keeps a tombstone warning when meal cleanup fails after database deletion', async () => {
    const parent = await createMeal();
    const cleanupPath = join(dataDir, 'images', 'meal-cleanup-directory');
    await mkdir(cleanupPath);
    const db = openDatabase(join(dataDir, 'fitness-coach.sqlite'));
    try {
      db.prepare('INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size) VALUES (?, ?, ?, ?)')
        .run(parent.id, 'images/meal-cleanup-directory', 'image/png', 12);
    } finally {
      db.close();
    }

    const deleted = await request('DELETE', `/api/daily-entries/${date}/meals`, { id: parent.id });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ ok: true, data: { id: parent.id, warning: 'CLEANUP_PENDING' } });
    expect(count('meals')).toBe(0);
    expect(count('meal_images')).toBe(0);
    expect(await readdir(join(dataDir, 'images'))).toEqual([expect.stringMatching(/^\.deleted-/)]);
    await expect(stat(cleanupPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('validates date-scoped meal deletion params and body IDs', async () => {
    const parent = await createMeal();
    const invalidDate = await request('DELETE', '/api/daily-entries/2026-02-30/meals', { id: parent.id });
    expect(invalidDate.statusCode).toBe(400);
    expect(invalidDate.json()).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    const invalidId = await request('DELETE', `/api/daily-entries/${date}/meals`, { id: String(parent.id) });
    expect(invalidId.statusCode).toBe(400);
    expect(count('meals')).toBe(1);
  });

  it('rejects an images directory symlink without writing outside dataDir', async () => {
    const parent = await createMeal();
    outsideDir = await mkdtemp(join(tmpdir(), 'fitness-coach-images-outside-'));
    await rm(join(dataDir, 'images'), { recursive: true });
    await symlink(outsideDir, join(dataDir, 'images'));
    const uploaded = await upload(parent.id);
    expect(uploaded.statusCode).toBeGreaterThanOrEqual(400);
    expect(await readdir(outsideDir)).toEqual([]);
    expect(count('meal_images')).toBe(0);
  });

  it('fails closed when images is replaced before upload begins', async () => {
    const parent = await createMeal();
    outsideDir = await mkdtemp(join(tmpdir(), 'fitness-coach-upload-replaced-'));
    await rm(join(dataDir, 'images'), { recursive: true });
    await symlink(outsideDir, join(dataDir, 'images'));

    const response = await upload(parent.id);
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(count('meal_images')).toBe(0);
    expect(await readdir(outsideDir)).toEqual([]);
  });

  it('fails closed when images is replaced before deletion begins', async () => {
    const parent = await createMeal();
    const uploaded = await upload(parent.id);
    const image = uploaded.json().data as { id: number };
    outsideDir = await mkdtemp(join(tmpdir(), 'fitness-coach-delete-replaced-'));
    const outsideImage = join(outsideDir, 'private.png');
    await writeFile(outsideImage, 'must remain untouched');
    await rm(join(dataDir, 'images'), { recursive: true });
    await symlink(outsideDir, join(dataDir, 'images'));

    const response = await request('DELETE', `/api/images/${image.id}`);
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(count('meal_images')).toBe(1);
    expect(await readFile(outsideImage, 'utf8')).toBe('must remain untouched');
  });

  it('rejects upload when images is already replaced by a symlink', async () => {
    const parent = await createMeal();
    outsideDir = await mkdtemp(join(tmpdir(), 'fitness-coach-upload-symlink-'));
    await rm(join(dataDir, 'images'), { recursive: true });
    await symlink(outsideDir, join(dataDir, 'images'));

    const response = await upload(parent.id);
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(await readdir(outsideDir)).toEqual([]);
    expect(count('meal_images')).toBe(0);
  });

  it('rejects deletion when images is replaced by a symlink before staging', async () => {
    const parent = await createMeal();
    const uploaded = await upload(parent.id);
    const image = uploaded.json().data as { id: number };
    outsideDir = await mkdtemp(join(tmpdir(), 'fitness-coach-delete-symlink-'));
    await writeFile(join(outsideDir, 'private.png'), 'must remain untouched');
    await rm(join(dataDir, 'images'), { recursive: true });
    await symlink(outsideDir, join(dataDir, 'images'));

    const response = await request('DELETE', `/api/images/${image.id}`);
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(await readFile(join(outsideDir, 'private.png'), 'utf8')).toBe('must remain untouched');
    expect(count('meal_images')).toBe(1);
  });

  it('fails closed when the configured data directory is replaced by an external symlink before upload', async () => {
    const parent = await createMeal();
    outsideDir = await mkdtemp(join(tmpdir(), 'fitness-coach-data-dir-upload-'));
    await mkdir(join(outsideDir, 'images'));
    const displacedPath = join(tmpdir(), `${basename(dataDir)}-before-upload-data-dir-replacement`);
    await rename(dataDir, displacedPath);
    await symlink(outsideDir, dataDir);

    const response = await upload(parent.id);
    await rm(dataDir, { force: true });
    await rename(displacedPath, dataDir);

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(await readdir(join(outsideDir, 'images'))).toEqual([]);
    expect(count('meal_images')).toBe(0);
  });

  it('fails closed when the configured data directory is replaced by an external symlink before deletion', async () => {
    const parent = await createMeal();
    const uploaded = await upload(parent.id);
    const image = uploaded.json().data as { id: number };
    outsideDir = await mkdtemp(join(tmpdir(), 'fitness-coach-data-dir-delete-'));
    await mkdir(join(outsideDir, 'images'));
    await writeFile(join(outsideDir, 'images', 'private.png'), 'must remain untouched');
    const displacedPath = join(tmpdir(), `${basename(dataDir)}-before-delete-data-dir-replacement`);
    await rename(dataDir, displacedPath);
    await symlink(outsideDir, dataDir);

    const response = await request('DELETE', `/api/images/${image.id}`);
    await rm(dataDir, { force: true });
    await rename(displacedPath, dataDir);

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(count('meal_images')).toBe(1);
    expect(await readFile(join(outsideDir, 'images', 'private.png'), 'utf8')).toBe('must remain untouched');
  });

  it('rejects a symlinked configured data directory before writing an image', async () => {
    await app.close();
    const realDataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-symlinked-data-'));
    const symlinkedDataDir = join(tmpdir(), `${basename(realDataDir)}-link`);
    await symlink(realDataDir, symlinkedDataDir);
    outsideDir = realDataDir;
    dataDir = symlinkedDataDir;
    await expect(buildApp({ dataDir })).rejects.toThrow(/symlink|unsafe/i);
    expect(await readdir(realDataDir)).toEqual([]);
  });

  it('rejects a nested symlink in a stored image path', async () => {
    const parent = await createMeal();
    outsideDir = await mkdtemp(join(tmpdir(), 'fitness-coach-nested-outside-'));
    outsidePath = join(outsideDir, 'private.png');
    await writeFile(outsidePath, 'private data');
    await symlink(outsideDir, join(dataDir, 'images', 'nested'));
    const db = openDatabase(join(dataDir, 'fitness-coach.sqlite'));
    let imageId: number;
    try {
      imageId = Number(db.prepare('INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size) VALUES (?, ?, ?, ?)').run(parent.id, 'images/nested/private.png', 'image/png', 12).lastInsertRowid);
    } finally {
      db.close();
    }
    expect((await request('GET', `/api/images/${imageId}`)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await request('DELETE', `/api/images/${imageId}`)).statusCode).toBeGreaterThanOrEqual(400);
    expect(await readFile(outsidePath, 'utf8')).toBe('private data');
  });

  it('rejects an image path whose final component is a symlink', async () => {
    const parent = await createMeal();
    outsidePath = join(tmpdir(), `${basename(dataDir)}-final-outside.png`);
    await writeFile(outsidePath, 'private data');
    const relativePath = 'images/final-link.png';
    await symlink(outsidePath, resolve(dataDir, relativePath));
    const db = openDatabase(join(dataDir, 'fitness-coach.sqlite'));
    let imageId: number;
    try {
      imageId = Number(db.prepare('INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size) VALUES (?, ?, ?, ?)').run(parent.id, relativePath, 'image/png', 12).lastInsertRowid);
    } finally {
      db.close();
    }
    expect((await request('GET', `/api/images/${imageId}`)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await request('DELETE', `/api/images/${imageId}`)).statusCode).toBeGreaterThanOrEqual(400);
    expect(await readFile(outsidePath, 'utf8')).toBe('private data');
  });

  it('does not create a secret file in a non-writable data directory', async () => {
    await chmod(dataDir, 0o500);
    try {
      const response = await request('PUT', '/api/settings/model', {
        base_url: 'https://example.test/v1', model_name: 'unwritable', api_key: 'sk-no-file',
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.body).not.toContain('sk-no-file');
    } finally {
      await chmod(dataDir, 0o700);
    }
  });

  it('maps malformed JSON bodies to VALIDATION_ERROR', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/profile',
      headers: { 'content-type': 'application/json' },
      payload: '{"goal":',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });

  it('rejects empty multipart files through the shared upload schema', async () => {
    const parent = await createMeal();
    const response = await upload(parent.id, Buffer.alloc(0));
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(count('meal_images')).toBe(0);
  });


  it('persists profile, settings, children and image bytes across an app restart', async () => {
    await request('PUT', '/api/profile', profile);
    await request('PUT', '/api/settings/model', { base_url: 'https://example.test/v1', model_name: 'local-test', api_key: 'sk-restart-secret' });
    const parent = await createMeal();
    const image = await upload(parent.id);
    expect(image.statusCode).toBe(201);
    await request('POST', `/api/daily-entries/${date}/weights`, weight);
    await request('POST', `/api/daily-entries/${date}/workouts`, workout);
    await request('POST', `/api/daily-entries/${date}/feedback`, feedback);
    await app.close();
    app = await buildApp({ dataDir });
    expect((await request('GET', '/api/profile')).json().data).toMatchObject(profile);
    const settings = await request('GET', '/api/settings/model');
    expect(settings.json().data).toMatchObject({ modelName: 'local-test', configured: true });
    expect(settings.body).not.toContain('sk-restart-secret');
    expect((await request('GET', `/api/daily-entries/${date}`)).json().data).toMatchObject({
      entry_date: date, weights: [weight], meals: [meal], workouts: [workout], feedback: [feedback],
    });
    expect((await request('GET', `/api/images/${image.json().data.id}`)).rawPayload).toEqual(png);
  });

  it('stores newly uploaded images under the current profile directory', async () => {
    const savedProfile = await request('PUT', '/api/profile', profile);
    expect(savedProfile.statusCode).toBe(200);
    const meal = await createMeal();

    const uploaded = await upload(meal.id);

    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json().data.relative_path).toMatch(/^images\/profile-1\//);
  });

  it('keeps an upload bound to the request profile when current profile changes', async () => {
    const second = await request('POST', '/api/profiles', { name: 'Second profile', goal_description: '', ...profile });
    const secondId = second.json().data.id as number;
    await request('PUT', '/api/current-profile', { profileId: 1 });
    const parent = await createMeal();

    const uploading = upload(parent.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await request('PUT', '/api/current-profile', { profileId: secondId });
    const uploaded = await uploading;

    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json().data.relative_path).toMatch(/^images\/profile-1\//);
  });

  it('keeps record saves and uploads local even when model settings are configured', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('model must not be called'));
    expect((await request('PUT', '/api/settings/model', { base_url: 'https://example.test/v1', model_name: 'test', api_key: 'sk-local-only' })).statusCode).toBe(200);
    expect((await request('PUT', '/api/profile', profile)).statusCode).toBe(200);
    await createEntry();
    expect((await request('POST', `/api/daily-entries/${date}/weights`, weight)).statusCode).toBe(201);
    const parent = await request('POST', `/api/daily-entries/${date}/meals`, meal);
    expect(parent.statusCode).toBe(201);
    expect((await upload(parent.json().data.id)).statusCode).toBe(201);
    expect((await request('POST', `/api/daily-entries/${date}/workouts`, workout)).statusCode).toBe(201);
    expect((await request('POST', `/api/daily-entries/${date}/feedback`, feedback)).statusCode).toBe(201);
    expect(fetch).toHaveBeenCalledTimes(0);
  });
});
