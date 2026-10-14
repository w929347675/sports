import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';

const importMkdirGate = vi.hoisted(() => ({
  blockNext: false,
  failNextInstallRename: false,
  onFailInstallRename: undefined as (() => void) | undefined,
  entered: undefined as (() => void) | undefined,
  release: undefined as (() => void) | undefined,
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    mkdir: vi.fn(async (path: Parameters<typeof actual.mkdir>[0], options?: Parameters<typeof actual.mkdir>[1]) => {
      if (importMkdirGate.blockNext && String(path).includes('.profile-import-')) {
        importMkdirGate.blockNext = false;
        await new Promise<void>((resolve) => {
          importMkdirGate.release = resolve;
          importMkdirGate.entered?.();
        });
      }
      return actual.mkdir(path, options as never);
    }),
    rename: vi.fn(async (oldPath: Parameters<typeof actual.rename>[0], newPath: Parameters<typeof actual.rename>[1]) => {
      if (importMkdirGate.failNextInstallRename && String(oldPath).includes('profile-source-') && String(newPath).includes('images/profile-')) {
        importMkdirGate.failNextInstallRename = false;
        importMkdirGate.onFailInstallRename?.();
        throw new Error('simulated image install failure');
      }
      return actual.rename(oldPath, newPath);
    }),
  };
});

const jsonFiles = [
  'manifest.json',
  'schema-version.json',
  'profiles.json',
  'daily-entries.json',
  'weights.json',
  'meals.json',
  'meal-images.json',
  'food-items.json',
  'workouts.json',
  'exercises.json',
  'body-feedback.json',
  'recommendations.json',
] as const;

type Archive = Map<string, Buffer>;
type JsonFile = Exclude<(typeof jsonFiles)[number], 'schema-version.json'>;
const databaseTables = [
  'schema_migrations',
  'profiles',
  'daily_entries',
  'weight_measurements',
  'meals',
  'meal_images',
  'food_items',
  'workouts',
  'exercises',
  'body_feedback',
  'recommendations',
  'app_settings',
] as const;

function parseOctal(bytes: Buffer) {
  const value = bytes.toString('ascii').replace(/\0.*$/, '').trim();
  return value === '' ? 0 : Number.parseInt(value, 8);
}

function parseExportPackage(bytes: Buffer): Archive {
  const tar = gunzipSync(bytes);
  const files = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const path = prefix ? `${prefix}/${name}` : name;
    const size = parseOctal(header.subarray(124, 136));
    const start = offset + 512;
    files.set(path, Buffer.from(tar.subarray(start, start + size)));
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

function json<T = unknown>(archive: Archive, path: JsonFile): T {
  const file = archive.get(path);
  if (!file) throw new Error(`Missing ${path}`);
  return JSON.parse(file.toString('utf8')) as T;
}

function replaceJson(archive: Archive, path: JsonFile | 'schema-version.json', mutate: (value: any) => void) {
  const copy = new Map(archive);
  const file = copy.get(path);
  if (!file) throw new Error(`Missing ${path}`);
  const value = JSON.parse(file.toString('utf8'));
  mutate(value);
  copy.set(path, Buffer.from(JSON.stringify(value)));
  return copy;
}

function renameEntry(archive: Archive, from: string, to: string) {
  const copy = new Map(archive);
  const bytes = copy.get(from);
  if (!bytes) throw new Error(`Missing ${from}`);
  copy.delete(from);
  copy.set(to, bytes);
  return copy;
}

function multipart(bytes: Buffer, filename = 'profiles.tar.gz') {
  const boundary = 'fitness-coach-profile-transfer-test-boundary';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/gzip\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

function profileInput(name: string) {
  return {
    name,
    goal: 'maintain',
    goal_description: `${name} goal`,
    height_cm: 175,
    age: 30,
    sex: 'unspecified',
    training_experience: 'beginner',
    equipment: 'home',
    training_days_per_week: 3,
    session_duration_minutes: 45,
    diet_preferences: 'none',
    allergies: 'none',
    health_restrictions: 'none',
  };
}

describe('profile transfer API', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let selectedId: number;
  let archivedId: number;
  let excludedId: number;
  let selectedImage: Buffer;
  const additionalApps: FastifyInstance[] = [];
  const additionalDataDirs: string[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-profile-transfer-'));
    app = await buildApp({ dataDir });

    selectedId = (await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Selected') })).json().data.id;
    archivedId = (await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Archived') })).json().data.id;
    excludedId = (await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Excluded') })).json().data.id;

    await app.inject({ method: 'PUT', url: '/api/current-profile', payload: { profileId: selectedId } });
    await app.inject({
      method: 'PUT',
      url: '/api/settings/model',
      payload: { base_url: 'https://private.example/v1', model_name: 'private-model', api_key: 'sk-profile-export-secret' },
    });
    await app.inject({ method: 'PUT', url: '/api/daily-entries/2026-10-10', payload: { status: 'training', status_note: 'selected day' } });
    await app.inject({ method: 'POST', url: '/api/daily-entries/2026-10-10/weights', payload: { measured_at: '2026-10-10T07:00:00Z', weight_kg: 71.5, note: 'selected weight' } });
    const meal = await app.inject({
      method: 'POST',
      url: '/api/daily-entries/2026-10-10/meals',
      payload: { eaten_at: '2026-10-10T12:00:00Z', meal_type: 'lunch', notes: 'selected meal' },
    });
    const workout = await app.inject({
      method: 'POST',
      url: '/api/daily-entries/2026-10-10/workouts',
      payload: { started_at: '2026-10-10T18:00:00Z', workout_type: 'strength', duration_minutes: 45, perceived_difficulty: 6, notes: 'selected workout' },
    });
    const workoutId = workout.json().data.id as number;
    await app.inject({
      method: 'POST',
      url: `/api/workouts/${workoutId}/exercises`,
      payload: { name: 'Squat', weight: 50, weight_unit: 'kg', sets: 3, repetitions: 8, completed: true, notes: 'selected exercise' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/daily-entries/2026-10-10/feedback',
      payload: { recorded_at: '2026-10-10T20:00:00Z', category: 'fatigue', body_part: 'legs', severity: 2, impact: '', description: 'selected feedback' },
    });

    selectedImage = Buffer.from('selected image bytes');
    const selectedImagePath = `images/profile-${selectedId}/selected.png`;
    await mkdir(join(dataDir, 'images', `profile-${selectedId}`), { recursive: true });
    await writeFile(join(dataDir, selectedImagePath), selectedImage);

    const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
    try {
      const mealId = meal.json().data.id as number;
      db.prepare(`INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size)
        VALUES (?, ?, 'image/png', ?)`).run(mealId, selectedImagePath, selectedImage.length);
      db.prepare(`INSERT INTO food_items (meal_id, name, amount, unit, cooking_method, confidence, needs_confirmation, is_user_confirmed, source, notes)
        VALUES (?, 'Rice', 1, 'bowl', 'steamed', 0.9, 0, 1, 'user', 'selected food')`).run(mealId);
      db.prepare(`INSERT INTO recommendations (profile_id, range_start, range_end, model_name, input_summary_json, report_markdown, structured_report_json, status)
        VALUES (?, '2026-10-01', '2026-10-10', 'selected-model', '{}', 'selected report', '{}', 'completed')`).run(selectedId);

      db.prepare("UPDATE profiles SET status = 'archived', archived_at = '2026-10-11T00:00:00.000Z' WHERE id = ?").run(archivedId);
      db.prepare("INSERT INTO daily_entries (profile_id, entry_date, status, status_note) VALUES (?, '2026-10-09', 'rest', 'archived day')").run(archivedId);

      db.prepare("INSERT INTO daily_entries (profile_id, entry_date, status, status_note) VALUES (?, '2026-10-08', 'rest', 'excluded day')").run(excludedId);
      db.prepare(`INSERT INTO recommendations (profile_id, range_start, range_end, model_name, input_summary_json, report_markdown, structured_report_json, status)
        VALUES (?, '2026-10-01', '2026-10-08', 'excluded-model', '{}', 'excluded report', '{}', 'completed')`).run(excludedId);
    } finally {
      db.close();
    }
  });

  afterEach(async () => {
    importMkdirGate.blockNext = false;
    importMkdirGate.failNextInstallRename = false;
    importMkdirGate.onFailInstallRename = undefined;
    importMkdirGate.release?.();
    importMkdirGate.entered = undefined;
    importMkdirGate.release = undefined;
    for (const additionalApp of additionalApps.splice(0)) await additionalApp.close();
    await app.close();
    for (const additionalDataDir of additionalDataDirs.splice(0)) {
      await rm(additionalDataDir, { recursive: true, force: true });
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  async function createEmptyApp() {
    const targetDataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-profile-import-'));
    additionalDataDirs.push(targetDataDir);
    const targetApp = await buildApp({ dataDir: targetDataDir });
    additionalApps.push(targetApp);
    return { app: targetApp, dataDir: targetDataDir };
  }

  async function exportProfiles(profileIds: number[]) {
    const response = await app.inject({ method: 'POST', url: '/api/profiles/export', payload: { profileIds } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/gzip');
    expect(response.headers['content-disposition']).toMatch(/attachment;.*\.tar\.gz/);
    return parseExportPackage(response.rawPayload);
  }

  async function persistentState(targetDataDir = dataDir) {
    const db = new Database(join(targetDataDir, 'fitness-coach.sqlite'));
    const tables: Record<string, unknown> = {};
    try {
      for (const table of databaseTables) tables[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    } finally {
      db.close();
    }

    const images: Array<[string, string]> = [];
    async function visit(directory: string, relativeDirectory: string) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        const relativePath = `${relativeDirectory}/${entry.name}`;
        if (entry.isDirectory()) await visit(path, relativePath);
        else if (entry.isFile()) images.push([relativePath, (await readFile(path)).toString('base64')]);
      }
    }
    await visit(join(targetDataDir, 'images'), 'images');
    images.sort(([left], [right]) => left.localeCompare(right));
    return { tables, images };
  }

  function archiveBytes(archive: Archive) {
    return gzipSync(createTar([...archive].map(([path, bytes]) => ({ path, bytes }))));
  }

  async function preview(archive: Archive, targetApp = app) {
    const response = await targetApp.inject({
      method: 'POST',
      url: '/api/profile-transfers/import/preview',
      ...multipart(archiveBytes(archive)),
    });
    return response;
  }

  async function executeImport(
    targetApp: FastifyInstance,
    importId: string,
    resolutions?: Array<{ profileId: number; strategy: 'new' | 'skip' | 'overwrite' | 'cancel'; newName?: string }>,
  ) {
    return targetApp.inject({
      method: 'POST',
      url: '/api/profile-transfers/import/execute',
      payload: { importId, ...(resolutions === undefined ? {} : { resolutions }) },
    });
  }

  function withProfileName(archive: Archive, name: string) {
    return replaceJson(
      replaceJson(archive, 'manifest.json', (manifest) => { manifest.profiles[0].name = name; }),
      'profiles.json',
      (profiles) => { profiles[0].name = name; },
    );
  }

  function remapSingleProfile(archive: Archive, profileId: number, name: string) {
    const [sourceProfile] = json<Array<{ id: number }>>(archive, 'profiles.json');
    if (!sourceProfile) throw new Error('Missing source profile');
    const sourceImagePath = selectedImagePath(sourceProfile.id);
    const targetImagePath = selectedImagePath(profileId);
    let remapped = replaceJson(archive, 'manifest.json', (manifest) => {
      manifest.profiles[0].id = profileId;
      manifest.profiles[0].name = name;
      for (const image of manifest.images) {
        image.profile_id = profileId;
        if (image.path === sourceImagePath) image.path = targetImagePath;
      }
    });
    remapped = replaceJson(remapped, 'profiles.json', (profiles) => {
      profiles[0].id = profileId;
      profiles[0].name = name;
    });
    remapped = replaceJson(remapped, 'daily-entries.json', (entries) => {
      for (const entry of entries) entry.profile_id = profileId;
    });
    remapped = replaceJson(remapped, 'recommendations.json', (recommendations) => {
      for (const recommendation of recommendations) recommendation.profile_id = profileId;
    });
    remapped = replaceJson(remapped, 'meal-images.json', (images) => {
      for (const image of images) if (image.relative_path === sourceImagePath) image.relative_path = targetImagePath;
    });
    return remapped.has(sourceImagePath) ? renameEntry(remapped, sourceImagePath, targetImagePath) : remapped;
  }

  it('exports only one selected profile with all related records, image bytes, counts, and hashes', async () => {
    const archive = await exportProfiles([selectedId]);
    expect([...archive.keys()].sort()).toEqual([
      ...jsonFiles,
      `${selectedImagePath(selectedId)}`,
    ].sort());

    expect(json<Array<{ id: number; name: string; status: string }>>(archive, 'profiles.json')).toEqual([
      expect.objectContaining({ id: selectedId, name: 'Selected', status: 'active' }),
    ]);
    expect(json<Array<{ profile_id: number; status_note: string }>>(archive, 'daily-entries.json')).toEqual([
      expect.objectContaining({ profile_id: selectedId, status_note: 'selected day' }),
    ]);
    expect(json<Array<{ weight_kg: number }>>(archive, 'weights.json')).toEqual([expect.objectContaining({ weight_kg: 71.5 })]);
    expect(json<Array<{ notes: string }>>(archive, 'meals.json')).toEqual([expect.objectContaining({ notes: 'selected meal' })]);
    expect(json<Array<{ relative_path: string }>>(archive, 'meal-images.json')).toEqual([
      expect.objectContaining({ relative_path: selectedImagePath(selectedId) }),
    ]);
    expect(json<Array<{ notes: string }>>(archive, 'food-items.json')).toEqual([expect.objectContaining({ notes: 'selected food' })]);
    expect(json<Array<{ notes: string }>>(archive, 'workouts.json')).toEqual([expect.objectContaining({ notes: 'selected workout' })]);
    expect(json<Array<{ notes: string }>>(archive, 'exercises.json')).toEqual([expect.objectContaining({ notes: 'selected exercise' })]);
    expect(json<Array<{ description: string }>>(archive, 'body-feedback.json')).toEqual([expect.objectContaining({ description: 'selected feedback' })]);
    expect(json<Array<{ report_markdown: string }>>(archive, 'recommendations.json')).toEqual([expect.objectContaining({ report_markdown: 'selected report' })]);

    const image = archive.get(selectedImagePath(selectedId));
    expect(image).toEqual(selectedImage);
    expect(json(archive, 'manifest.json')).toMatchObject({
      profiles: [expect.objectContaining({ id: selectedId, status: 'active' })],
      counts: {
        profiles: 1,
        daily_entries: 1,
        weight_measurements: 1,
        meals: 1,
        meal_images: 1,
        food_items: 1,
        workouts: 1,
        exercises: 1,
        body_feedback: 1,
        recommendations: 1,
      },
      images: [{
        profile_id: selectedId,
        path: selectedImagePath(selectedId),
        size: selectedImage.length,
        sha256: createHash('sha256').update(selectedImage).digest('hex'),
      }],
    });
  });

  it('exports multiple selected profiles while preserving archived state and excluding settings, secrets, and unselected profiles', async () => {
    const archive = await exportProfiles([selectedId, archivedId]);
    expect(json<Array<{ id: number; status: string }>>(archive, 'profiles.json')).toEqual([
      expect.objectContaining({ id: selectedId, status: 'active' }),
      expect.objectContaining({ id: archivedId, status: 'archived' }),
    ]);
    expect(json<Array<{ profile_id: number; status_note: string }>>(archive, 'daily-entries.json')).toEqual(expect.arrayContaining([
      expect.objectContaining({ profile_id: selectedId, status_note: 'selected day' }),
      expect.objectContaining({ profile_id: archivedId, status_note: 'archived day' }),
    ]));

    expect(archive.has('app-settings.json')).toBe(false);
    expect(archive.has('model-api-key.secret')).toBe(false);
    const text = Buffer.concat([...archive.values()]).toString('utf8');
    expect(text).not.toContain('sk-profile-export-secret');
    expect(text).not.toContain('https://private.example/v1');
    expect(text).not.toContain('private-model');
    expect(text).not.toContain('Excluded');
    expect(text).not.toContain('excluded day');
    expect(text).not.toContain('excluded report');
  });

  it('previews a valid exported package without changing profiles, daily entries, or images', async () => {
    const archive = await exportProfiles([selectedId]);
    const before = await persistentState();

    const response = await preview(archive);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      data: {
        importId: expect.any(String),
        manifest: expect.objectContaining({
          format: 'fitness-coach-profile-transfer',
          version: 1,
          schema_version: expect.any(Number),
          profiles: [expect.objectContaining({ id: selectedId, name: 'Selected', status: 'active' })],
          counts: expect.objectContaining({ profiles: 1, daily_entries: 1, meal_images: 1 }),
          images: [expect.objectContaining({ path: selectedImagePath(selectedId), sha256: expect.any(String) })],
        }),
        profileStats: [expect.objectContaining({ id: selectedId, name: 'Selected', status: 'active' })],
        conflicts: [expect.objectContaining({ type: 'profile_id', profileId: selectedId, existingProfileId: selectedId })],
      },
    });
    expect(await persistentState()).toEqual(before);
  });

  it('executes a valid import in another empty app with statuses, records, images, and recommendations intact without selecting a profile', async () => {
    const archive = await exportProfiles([selectedId, archivedId]);
    const target = await createEmptyApp();
    const previewResponse = await preview(archive, target.app);
    expect(previewResponse.statusCode).toBe(200);

    const executeResponse = await executeImport(target.app, previewResponse.json().data.importId, []);

    expect(executeResponse.statusCode).toBe(200);
    expect(executeResponse.json()).toMatchObject({
      ok: true,
      data: {
        results: expect.arrayContaining([
          expect.objectContaining({ sourceProfileId: selectedId, targetProfileId: expect.any(Number), status: 'imported' }),
          expect.objectContaining({ sourceProfileId: archivedId, targetProfileId: expect.any(Number), status: 'imported' }),
        ]),
      },
    });
    expect((await target.app.inject({ method: 'GET', url: '/api/current-profile' })).json().data.profile).toBeNull();

    const profiles = (await target.app.inject({ method: 'GET', url: '/api/profiles?status=all' })).json().data as Array<{
      id: number;
      name: string;
      status: string;
    }>;
    const importedSelected = profiles.find(({ name }) => name === 'Selected');
    const importedArchived = profiles.find(({ name }) => name === 'Archived');
    expect(importedSelected).toMatchObject({ status: 'active' });
    expect(importedArchived).toMatchObject({ status: 'archived' });
    if (!importedSelected || !importedArchived) throw new Error('Missing imported profiles');

    const archivedDetail = await target.app.inject({ method: 'GET', url: `/api/profiles/${importedArchived.id}` });
    expect(archivedDetail.statusCode).toBe(200);
    expect(archivedDetail.json().data.daily_entries).toEqual([
      expect.objectContaining({ entry_date: '2026-10-09', status_note: 'archived day' }),
    ]);

    await target.app.inject({ method: 'PUT', url: '/api/current-profile', payload: { profileId: importedSelected.id } });
    const selectedDay = await target.app.inject({ method: 'GET', url: '/api/daily-entries/2026-10-10' });
    expect(selectedDay.statusCode).toBe(200);
    expect(selectedDay.json().data).toMatchObject({
      entry: { status_note: 'selected day' },
      weights: [expect.objectContaining({ weight_kg: 71.5 })],
      meals: [expect.objectContaining({
        notes: 'selected meal',
        food_items: [expect.objectContaining({ name: 'Rice' })],
        images: [expect.objectContaining({ id: expect.any(Number) })],
      })],
      workouts: [expect.objectContaining({ exercises: [expect.objectContaining({ name: 'Squat' })] })],
      feedback: [expect.objectContaining({ description: 'selected feedback' })],
    });
    const imageId = selectedDay.json().data.meals[0].images[0].id as number;
    const imageResponse = await target.app.inject({ method: 'GET', url: `/api/images/${imageId}` });
    expect(imageResponse.statusCode).toBe(200);
    expect(imageResponse.rawPayload).toEqual(selectedImage);
    expect(createHash('sha256').update(imageResponse.rawPayload).digest('hex')).toBe(
      createHash('sha256').update(selectedImage).digest('hex'),
    );
    expect((await target.app.inject({ method: 'GET', url: '/api/recommendations' })).json().data).toEqual([
      expect.objectContaining({ report_markdown: 'selected report', model_name: 'selected-model' }),
    ]);
  });

  it('round-trips every recommendation field for completed, failed, and processing reports', async () => {
    const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
    try {
      db.prepare('DELETE FROM recommendations WHERE profile_id = ?').run(selectedId);
      const insert = db.prepare(`INSERT INTO recommendations (
        profile_id, job_id, range_start, range_end, model_name, generated_at,
        input_record_count, image_review_count, input_summary_json, report_markdown,
        structured_report_json, error_code, error_message, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      insert.run(selectedId, 'job-completed', '2026-09-01', '2026-09-07', 'model-completed', '2026-09-08T01:02:03.000Z', 11, 3, '{"completed":true}', 'completed markdown', '{"kind":"completed"}', null, null, 'completed');
      insert.run(selectedId, 'job-failed', '2026-09-08', '2026-09-14', 'model-failed', '2026-09-15T01:02:03.000Z', 7, 2, '{"failed":true}', 'failed markdown', '{"kind":"failed"}', 'MODEL_TIMEOUT', 'safe failure', 'failed');
      insert.run(selectedId, null, '2026-09-15', '2026-09-21', 'model-processing', '2026-09-22T01:02:03.000Z', 5, 1, '{"processing":true}', 'processing markdown', '{"kind":"processing"}', null, null, 'processing');
    } finally {
      db.close();
    }
    const archive = await exportProfiles([selectedId]);
    const exported = json<Array<Record<string, unknown>>>(archive, 'recommendations.json');
    const recommendationColumns = [
      'id', 'profile_id', 'job_id', 'range_start', 'range_end', 'model_name', 'generated_at',
      'input_record_count', 'image_review_count', 'input_summary_json', 'report_markdown',
      'structured_report_json', 'error_code', 'error_message', 'status',
    ];
    expect(Object.keys(exported[0]!).sort()).toEqual([...recommendationColumns].sort());

    const target = await createEmptyApp();
    const previewResponse = await preview(archive, target.app);
    const executeResponse = await executeImport(target.app, previewResponse.json().data.importId, []);
    expect(executeResponse.statusCode).toBe(200);
    const targetDb = new Database(join(target.dataDir, 'fitness-coach.sqlite'));
    try {
      const imported = targetDb.prepare(`SELECT ${recommendationColumns.filter((field) => !['id', 'profile_id'].includes(field)).join(', ')} FROM recommendations ORDER BY generated_at`).all();
      const expected = exported.map(({ id: _id, profile_id: _profileId, ...record }) => record);
      expect(imported).toEqual(expected);
    } finally {
      targetDb.close();
    }
  });

  it('serializes execute calls across service instances while preview remains available', async () => {
    const firstArchive = withProfileName(await exportProfiles([selectedId]), 'Concurrent First');
    const secondArchive = withProfileName(await exportProfiles([selectedId]), 'Concurrent Second');
    const firstTarget = await createEmptyApp();
    const secondTarget = await createEmptyApp();
    const firstPreview = await preview(firstArchive, firstTarget.app);
    const secondPreview = await preview(secondArchive, secondTarget.app);
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    importMkdirGate.blockNext = true;
    importMkdirGate.entered = entered;

    const firstExecute = executeImport(firstTarget.app, firstPreview.json().data.importId, []);
    await firstEntered;
    const secondExecute = await executeImport(secondTarget.app, secondPreview.json().data.importId, []);
    expect(secondExecute.statusCode).toBe(409);
    expect(secondExecute.json()).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });

    const parallelPreview = await preview(secondArchive, secondTarget.app);
    expect(parallelPreview.statusCode).toBe(200);
    expect(parallelPreview.json().data.importId).toEqual(expect.any(String));

    importMkdirGate.release?.();
    expect((await firstExecute).statusCode).toBe(200);
    const targetDb = new Database(join(firstTarget.dataDir, 'fitness-coach.sqlite'));
    try {
      expect(targetDb.prepare("SELECT value FROM app_settings WHERE key = 'profile_import_journal'").get()).toBeUndefined();
    } finally {
      targetDb.close();
    }
  });

  it('does not overwrite a retained recovery journal and startup recovery can use the original journal', async () => {
    const originalDb = new Database(join(dataDir, 'fitness-coach.sqlite'));
    let originalRecommendation: Record<string, unknown>;
    try {
      originalDb.prepare(`INSERT INTO recommendations (
        profile_id, job_id, range_start, range_end, model_name, generated_at,
        input_record_count, image_review_count, input_summary_json, report_markdown,
        structured_report_json, error_code, error_message, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        archivedId, 'job-recovery-original', '2026-07-01', '2026-07-07', 'recovery-model', '2026-07-08T01:02:03.000Z',
        13, 2, '{"recovery":true}', 'recovery original markdown', '{"kind":"recovery"}', 'MODEL_TIMEOUT', 'recovery error', 'failed',
      );
      originalRecommendation = originalDb.prepare('SELECT * FROM recommendations WHERE profile_id = ?').get(archivedId) as Record<string, unknown>;
    } finally {
      originalDb.close();
    }
    const overwriteArchive = remapSingleProfile(await exportProfiles([selectedId]), archivedId, 'Archived');
    const laterArchive = remapSingleProfile(await exportProfiles([selectedId]), 999_999, 'Later Import');
    const overwritePreview = await preview(overwriteArchive);
    const laterPreview = await preview(laterArchive);
    importMkdirGate.failNextInstallRename = true;
    importMkdirGate.onFailInstallRename = () => {
      const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
      try {
        db.exec(`CREATE TRIGGER fail_profile_snapshot_restore
          BEFORE INSERT ON profiles WHEN NEW.id = ${archivedId}
          BEGIN SELECT RAISE(ABORT, 'simulated snapshot restore failure'); END`);
      } finally {
        db.close();
      }
    };

    const failed = await executeImport(app, overwritePreview.json().data.importId, [
      { profileId: archivedId, strategy: 'overwrite' },
    ]);
    expect(failed.statusCode).toBe(500);
    const failedDb = new Database(join(dataDir, 'fitness-coach.sqlite'));
    let retainedJournal: string;
    try {
      retainedJournal = (failedDb.prepare("SELECT value FROM app_settings WHERE key = 'profile_import_journal'").get() as { value: string }).value;
    } finally {
      failedDb.close();
    }

    const blocked = await executeImport(app, laterPreview.json().data.importId, []);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: expect.stringMatching(/recover/i) } });
    const blockedDb = new Database(join(dataDir, 'fitness-coach.sqlite'));
    try {
      expect((blockedDb.prepare("SELECT value FROM app_settings WHERE key = 'profile_import_journal'").get() as { value: string }).value).toBe(retainedJournal);
      blockedDb.exec('DROP TRIGGER fail_profile_snapshot_restore');
    } finally {
      blockedDb.close();
    }

    await app.close();
    app = await buildApp({ dataDir });
    const recoveredDb = new Database(join(dataDir, 'fitness-coach.sqlite'));
    try {
      expect(recoveredDb.prepare("SELECT value FROM app_settings WHERE key = 'profile_import_journal'").get()).toBeUndefined();
      expect(recoveredDb.prepare('SELECT name, status FROM profiles WHERE id = ?').get(archivedId)).toEqual({ name: 'Archived', status: 'archived' });
      expect(recoveredDb.prepare('SELECT * FROM recommendations WHERE profile_id = ?').get(archivedId)).toEqual(originalRecommendation);
    } finally {
      recoveredDb.close();
    }
  });

  it('restores every original recommendation field when overwrite fails after the database commit', async () => {
    const oldImagePath = `images/profile-${archivedId}/rollback-old.png`;
    await mkdir(join(dataDir, 'images', `profile-${archivedId}`), { recursive: true });
    await writeFile(join(dataDir, oldImagePath), 'rollback old image');
    const recommendationFields = [
      'id', 'profile_id', 'job_id', 'range_start', 'range_end', 'model_name', 'generated_at',
      'input_record_count', 'image_review_count', 'input_summary_json', 'report_markdown',
      'structured_report_json', 'error_code', 'error_message', 'status',
    ];
    const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
    let originalRecommendation: Record<string, unknown>;
    try {
      db.prepare('DELETE FROM recommendations WHERE profile_id = ?').run(archivedId);
      db.prepare(`INSERT INTO recommendations (
        profile_id, job_id, range_start, range_end, model_name, generated_at,
        input_record_count, image_review_count, input_summary_json, report_markdown,
        structured_report_json, error_code, error_message, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        archivedId, 'job-original-failed', '2026-08-01', '2026-08-07', 'original-model', '2026-08-08T01:02:03.000Z',
        19, 4, '{"original":true}', 'original markdown', '{"kind":"original"}', 'MODEL_TIMEOUT', 'original safe error', 'failed',
      );
      originalRecommendation = db.prepare(`SELECT ${recommendationFields.join(', ')} FROM recommendations WHERE profile_id = ?`).get(archivedId) as Record<string, unknown>;
    } finally {
      db.close();
    }

    const archive = remapSingleProfile(await exportProfiles([selectedId]), archivedId, 'Archived');
    const previewResponse = await preview(archive);
    importMkdirGate.failNextInstallRename = true;
    const executeResponse = await executeImport(app, previewResponse.json().data.importId, [
      { profileId: archivedId, strategy: 'overwrite' },
    ]);

    expect(executeResponse.statusCode).toBe(500);
    const restoredDb = new Database(join(dataDir, 'fitness-coach.sqlite'));
    try {
      expect(restoredDb.prepare(`SELECT ${recommendationFields.join(', ')} FROM recommendations WHERE profile_id = ?`).get(archivedId)).toEqual(originalRecommendation);
      expect(restoredDb.prepare("SELECT value FROM app_settings WHERE key = 'profile_import_journal'").get()).toBeUndefined();
    } finally {
      restoredDb.close();
    }
    expect(await readFile(join(dataDir, oldImagePath))).toEqual(Buffer.from('rollback old image'));
  });

  it('imports an ID and name conflict as a renamed new profile with every relationship and image path remapped', async () => {
    const archive = remapSingleProfile(await exportProfiles([selectedId]), archivedId, 'Excluded');
    const previewResponse = await preview(archive);
    expect(previewResponse.statusCode).toBe(200);
    expect(previewResponse.json().data.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'profile_id', profileId: archivedId, existingProfileId: archivedId }),
      expect.objectContaining({ type: 'profile_name', profileId: archivedId, existingProfileId: excludedId }),
    ]));

    const executeResponse = await executeImport(app, previewResponse.json().data.importId, [
      { profileId: archivedId, strategy: 'new', newName: 'Imported Copy' },
    ]);

    expect(executeResponse.statusCode).toBe(200);
    expect(executeResponse.json()).toMatchObject({
      ok: true,
      data: {
        results: [expect.objectContaining({
          sourceProfileId: archivedId,
          targetProfileId: expect.any(Number),
          status: 'imported',
        })],
      },
    });
    const profiles = (await app.inject({ method: 'GET', url: '/api/profiles?status=all' })).json().data as Array<{
      id: number;
      name: string;
      status: string;
    }>;
    expect(profiles.map(({ name }) => name)).toEqual(expect.arrayContaining(['Selected', 'Archived', 'Excluded', 'Imported Copy']));
    const imported = profiles.find(({ name }) => name === 'Imported Copy');
    if (!imported) throw new Error('Missing imported profile');
    expect(imported.id).not.toBe(archivedId);
    expect(imported.status).toBe('active');

    const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
    let importedRows: Record<string, unknown>;
    let importedRecommendation: { id: number; profile_id: number; report_markdown: string };
    try {
      importedRows = db.prepare(`
        SELECT d.id AS daily_entry_id, d.profile_id, w.id AS weight_id,
          m.id AS meal_id, i.id AS image_id, i.meal_id AS image_meal_id, i.relative_path,
          f.id AS food_id, f.meal_id AS food_meal_id,
          wo.id AS workout_id, e.id AS exercise_id, e.workout_id AS exercise_workout_id,
          b.id AS feedback_id, b.daily_entry_id AS feedback_entry_id
        FROM daily_entries d
        JOIN weight_measurements w ON w.daily_entry_id = d.id
        JOIN meals m ON m.daily_entry_id = d.id
        JOIN meal_images i ON i.meal_id = m.id
        JOIN food_items f ON f.meal_id = m.id
        JOIN workouts wo ON wo.daily_entry_id = d.id
        JOIN exercises e ON e.workout_id = wo.id
        JOIN body_feedback b ON b.daily_entry_id = d.id
        WHERE d.profile_id = ?
      `).get(imported.id) as Record<string, unknown>;
      importedRecommendation = db.prepare('SELECT id, profile_id, report_markdown FROM recommendations WHERE profile_id = ?').get(imported.id) as {
        id: number;
        profile_id: number;
        report_markdown: string;
      };
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
    expect(importedRows).toMatchObject({
      profile_id: imported.id,
      image_meal_id: importedRows.meal_id,
      food_meal_id: importedRows.meal_id,
      exercise_workout_id: importedRows.workout_id,
      feedback_entry_id: importedRows.daily_entry_id,
      relative_path: `images/profile-${imported.id}/selected.png`,
    });
    expect(importedRecommendation).toMatchObject({ profile_id: imported.id, report_markdown: 'selected report' });
    expect(importedRows.daily_entry_id).not.toBe(json<Array<{ id: number }>>(archive, 'daily-entries.json')[0]?.id);
    expect(importedRows.weight_id).not.toBe(json<Array<{ id: number }>>(archive, 'weights.json')[0]?.id);
    expect(importedRows.meal_id).not.toBe(json<Array<{ id: number }>>(archive, 'meals.json')[0]?.id);
    expect(importedRows.image_id).not.toBe(json<Array<{ id: number }>>(archive, 'meal-images.json')[0]?.id);
    expect(importedRows.food_id).not.toBe(json<Array<{ id: number }>>(archive, 'food-items.json')[0]?.id);
    expect(importedRows.workout_id).not.toBe(json<Array<{ id: number }>>(archive, 'workouts.json')[0]?.id);
    expect(importedRows.exercise_id).not.toBe(json<Array<{ id: number }>>(archive, 'exercises.json')[0]?.id);
    expect(importedRows.feedback_id).not.toBe(json<Array<{ id: number }>>(archive, 'body-feedback.json')[0]?.id);
    expect(importedRecommendation.id).not.toBe(json<Array<{ id: number }>>(archive, 'recommendations.json')[0]?.id);

    const importedImage = await readFile(join(dataDir, String(importedRows.relative_path)));
    expect(importedImage).toEqual(selectedImage);
    expect(createHash('sha256').update(importedImage).digest('hex')).toBe(createHash('sha256').update(selectedImage).digest('hex'));
    expect(await readFile(join(dataDir, `images/profile-${selectedId}/selected.png`))).toEqual(selectedImage);
    await app.inject({ method: 'PUT', url: '/api/current-profile', payload: { profileId: imported.id } });
    const imageResponse = await app.inject({ method: 'GET', url: `/api/images/${String(importedRows.image_id)}` });
    expect(imageResponse.statusCode).toBe(200);
    expect(imageResponse.rawPayload).toEqual(selectedImage);
  });

  it('skips a conflicting profile without adding or replacing data and reports it as skipped', async () => {
    const archive = remapSingleProfile(await exportProfiles([selectedId]), archivedId, 'Excluded');
    const previewResponse = await preview(archive);
    expect(previewResponse.statusCode).toBe(200);
    const before = await persistentState();

    const executeResponse = await executeImport(app, previewResponse.json().data.importId, [
      { profileId: archivedId, strategy: 'skip' },
    ]);

    expect(executeResponse.statusCode).toBe(200);
    expect(executeResponse.json()).toMatchObject({
      ok: true,
      data: {
        results: [expect.objectContaining({
          sourceProfileId: archivedId,
          targetProfileId: archivedId,
          status: 'skipped',
        })],
      },
    });
    expect(await persistentState()).toEqual(before);
  });

  it('reports an ID conflict even when the imported profile has identical fields', async () => {
    const archive = await exportProfiles([selectedId]);
    const previewResponse = await preview(archive);

    expect(previewResponse.statusCode).toBe(200);
    expect(previewResponse.json().data.conflicts).toEqual([
      expect.objectContaining({
        type: 'profile_id',
        profileId: selectedId,
        existingProfileId: selectedId,
      }),
    ]);
  });

  it('rejects overwriting the current profile before the import transaction', async () => {
    const archive = await exportProfiles([selectedId]);
    const previewResponse = await preview(archive);
    expect(previewResponse.statusCode).toBe(200);
    const before = await persistentState();

    const executeResponse = await executeImport(app, previewResponse.json().data.importId, [
      { profileId: selectedId, strategy: 'overwrite' },
    ]);

    expect(executeResponse.statusCode).toBe(409);
    expect(await persistentState()).toEqual(before);
  });

  it('rechecks the current profile inside the import transaction before committing an overwrite', async () => {
    const archive = remapSingleProfile(await exportProfiles([selectedId]), archivedId, 'Archived');
    const previewResponse = await preview(archive);
    expect(previewResponse.statusCode).toBe(200);
    const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
    try {
      db.exec(`CREATE TRIGGER make_overwrite_target_current
        BEFORE DELETE ON profiles
        WHEN OLD.id = ${archivedId}
        BEGIN
          INSERT INTO app_settings (key, value) VALUES ('current_profile_id', '${archivedId}')
          ON CONFLICT(key) DO UPDATE SET value = excluded.value;
        END`);
    } finally {
      db.close();
    }
    const before = await persistentState();

    const executeResponse = await executeImport(app, previewResponse.json().data.importId, [
      { profileId: archivedId, strategy: 'overwrite' },
    ]);

    expect(executeResponse.statusCode).toBe(409);
    expect(await persistentState()).toEqual(before);
    expect((await app.inject({ method: 'GET', url: '/api/current-profile' })).json().data.profile.id).toBe(selectedId);
  });

  it('overwrites a multi-profile ID/name swap while keeping final names unique', async () => {
    const archive = await exportProfiles([selectedId, archivedId]);
    const swapped = replaceJson(
      replaceJson(archive, 'manifest.json', (manifest) => {
        const first = manifest.profiles.find((profile: { id: number }) => profile.id === selectedId);
        const second = manifest.profiles.find((profile: { id: number }) => profile.id === archivedId);
        if (!first || !second) throw new Error('Missing profiles in manifest');
        first.id = archivedId;
        first.name = 'Excluded';
        second.id = excludedId;
        second.name = 'Archived';
        for (const image of manifest.images) {
          if (image.profile_id === selectedId) {
            image.profile_id = archivedId;
            image.path = image.path.replace(`images/${selectedId}/`, `images/${archivedId}/`);
          }
        }
      }),
      'profiles.json',
      (profiles) => {
        const first = profiles.find((profile: { id: number }) => profile.id === selectedId);
        const second = profiles.find((profile: { id: number }) => profile.id === archivedId);
        if (!first || !second) throw new Error('Missing profiles in data');
        first.id = archivedId;
        first.name = 'Excluded';
        second.id = excludedId;
        second.name = 'Archived';
      },
    );
    const withRelationships = replaceJson(
      replaceJson(swapped, 'daily-entries.json', (entries) => {
        for (const entry of entries) if (entry.profile_id === selectedId) entry.profile_id = archivedId;
      }),
      'recommendations.json',
      (recommendations) => {
        for (const recommendation of recommendations) if (recommendation.profile_id === selectedId) recommendation.profile_id = archivedId;
      },
    );
    const finalArchive = replaceJson(withRelationships, 'meal-images.json', (images) => {
      for (const image of images) if (image.relative_path.includes(`images/${selectedId}/`)) {
        image.relative_path = image.relative_path.replace(`images/${selectedId}/`, `images/${archivedId}/`);
      }
    });
    const renamedImage = renameEntry(finalArchive, selectedImagePath(selectedId), selectedImagePath(archivedId));
    const previewResponse = await preview(renamedImage);
    expect(previewResponse.statusCode).toBe(200);

    const executeResponse = await executeImport(app, previewResponse.json().data.importId, [
      { profileId: archivedId, strategy: 'overwrite' },
      { profileId: excludedId, strategy: 'overwrite' },
    ]);

    expect(executeResponse.statusCode).toBe(200);
    const profiles = (await app.inject({ method: 'GET', url: '/api/profiles?status=all' })).json().data as Array<{ id: number; name: string }>;
    expect(profiles.filter(({ id }) => id === archivedId || id === excludedId).map(({ id, name }) => ({ id, name }))).toEqual([
      { id: archivedId, name: 'Excluded' },
      { id: excludedId, name: 'Archived' },
    ]);
    expect(new Set(profiles.map(({ name }) => name)).size).toBe(profiles.length);
  });

  it('rejects import when the images root is a symlink without changing the database', async () => {
    const archive = await exportProfiles([selectedId]);
    const target = await createEmptyApp();
    const externalImages = await mkdtemp(join(tmpdir(), 'fitness-coach-external-images-'));
    additionalDataDirs.push(externalImages);
    await rm(join(target.dataDir, 'images'), { recursive: true, force: true });
    await symlink(externalImages, join(target.dataDir, 'images'), 'dir');
    const before = await persistentState(target.dataDir);
    const previewResponse = await preview(archive, target.app);
    expect(previewResponse.statusCode).toBe(200);

    const executeResponse = await executeImport(target.app, previewResponse.json().data.importId, []);

    expect(executeResponse.statusCode).toBe(400);
    expect(await persistentState(target.dataDir)).toEqual(before);
    expect((await target.app.inject({ method: 'GET', url: '/api/profiles?status=all' })).json().data).toEqual([]);
  });

  it('recovers a database-committed import journal on startup without leaving half-imported rows', async () => {
    const target = await createEmptyApp();
    const imported = (await target.app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Half imported') })).json().data as { id: number };
    const temporaryRoot = join(target.dataDir, '.profile-import-crashed');
    await mkdir(temporaryRoot, { recursive: true });
    await writeFile(join(temporaryRoot, 'staged-image'), 'staged');
    const db = new Database(join(target.dataDir, 'fitness-coach.sqlite'));
    try {
      db.prepare(`INSERT INTO app_settings (key, value) VALUES ('profile_import_journal', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify({
        version: 1,
        phase: 'database_committed',
        temporaryRoot,
        insertedProfileIds: [imported.id],
        snapshots: [],
        moves: [],
      }));
    } finally {
      db.close();
    }
    await target.app.close();
    additionalApps.splice(additionalApps.indexOf(target.app), 1);

    const restarted = await buildApp({ dataDir: target.dataDir });
    additionalApps.push(restarted);

    expect((await restarted.inject({ method: 'GET', url: '/api/profiles?status=all' })).json().data).toEqual([]);
    await expect(readdir(temporaryRoot)).rejects.toThrow();
    const recoveredDb = new Database(join(target.dataDir, 'fitness-coach.sqlite'));
    try {
      expect(recoveredDb.prepare("SELECT value FROM app_settings WHERE key = 'profile_import_journal'").get()).toBeUndefined();
    } finally {
      recoveredDb.close();
    }
  });

  it('overwrites a conflicting non-current profile, replacing related data and images without changing the current profile', async () => {
    const oldImage = Buffer.from('old archived image');
    const oldImagePath = `images/profile-${archivedId}/old.png`;
    await mkdir(join(dataDir, 'images', `profile-${archivedId}`), { recursive: true });
    await writeFile(join(dataDir, oldImagePath), oldImage);
    const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
    try {
      const oldEntry = db.prepare("INSERT INTO daily_entries (profile_id, entry_date, status, status_note) VALUES (?, '2026-10-07', 'rest', 'replace me')").run(archivedId);
      const oldMeal = db.prepare("INSERT INTO meals (daily_entry_id, eaten_at, meal_type, notes) VALUES (?, '2026-10-07T12:00:00Z', 'lunch', 'old meal')").run(Number(oldEntry.lastInsertRowid));
      db.prepare("INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size) VALUES (?, ?, 'image/png', ?)")
        .run(Number(oldMeal.lastInsertRowid), oldImagePath, oldImage.length);
      db.prepare(`INSERT INTO recommendations (profile_id, range_start, range_end, model_name, input_summary_json, report_markdown, structured_report_json, status)
        VALUES (?, '2026-10-01', '2026-10-07', 'old-model', '{}', 'old report', '{}', 'completed')`).run(archivedId);
    } finally {
      db.close();
    }
    const archive = remapSingleProfile(await exportProfiles([selectedId]), archivedId, 'Archived');
    const previewResponse = await preview(archive);
    expect(previewResponse.statusCode).toBe(200);
    expect(previewResponse.json().data.conflicts).toEqual([
      expect.objectContaining({ type: 'profile_id', profileId: archivedId, existingProfileId: archivedId }),
    ]);

    const executeResponse = await executeImport(app, previewResponse.json().data.importId, [
      { profileId: archivedId, strategy: 'overwrite' },
    ]);

    expect(executeResponse.statusCode).toBe(200);
    expect(executeResponse.json()).toMatchObject({
      ok: true,
      data: {
        results: [expect.objectContaining({ sourceProfileId: archivedId, targetProfileId: archivedId, status: 'imported' })],
      },
    });
    expect((await app.inject({ method: 'GET', url: '/api/current-profile' })).json().data.profile.id).toBe(selectedId);
    const overwritten = (await app.inject({ method: 'GET', url: `/api/profiles/${archivedId}` })).json().data;
    expect(overwritten).toMatchObject({ name: 'Archived', status: 'active' });
    expect(overwritten.daily_entries).toHaveLength(1);
    expect(overwritten.daily_entries[0]).toMatchObject({ entry_date: '2026-10-10', status_note: 'selected day' });
    expect(overwritten.daily_entries[0].meals[0]).toMatchObject({
      notes: 'selected meal',
      images: [expect.objectContaining({ relative_path: `images/profile-${archivedId}/selected.png` })],
    });
    expect(overwritten.recommendations).toEqual([expect.objectContaining({ report_markdown: 'selected report' })]);
    expect(JSON.stringify(overwritten)).not.toContain('replace me');
    expect(JSON.stringify(overwritten)).not.toContain('old meal');
    expect(JSON.stringify(overwritten)).not.toContain('old report');
    await expect(readFile(join(dataDir, oldImagePath))).rejects.toThrow();
    expect(await readFile(join(dataDir, `images/profile-${archivedId}/selected.png`))).toEqual(selectedImage);
    const original = (await app.inject({ method: 'GET', url: `/api/profiles/${selectedId}` })).json().data;
    expect(original.daily_entries).toEqual([expect.objectContaining({ status_note: 'selected day' })]);
    expect(original.recommendations).toEqual([expect.objectContaining({ report_markdown: 'selected report' })]);
  });

  it.each([
    {
      name: 'the conflict strategy is missing',
      expectedStatus: 400,
      resolutions: undefined,
    },
    {
      name: 'the conflict strategy is cancel',
      expectedStatus: 409,
      resolutions: [{ profileId: 0, strategy: 'cancel' as const }],
    },
    {
      name: 'the renamed profile name is blank',
      expectedStatus: 400,
      resolutions: [{ profileId: 0, strategy: 'new' as const, newName: '   ' }],
    },
  ])('rejects execution when $name without changing the database or images', async ({ expectedStatus, resolutions }) => {
    const archive = remapSingleProfile(await exportProfiles([selectedId]), archivedId, 'Excluded');
    const previewResponse = await preview(archive);
    expect(previewResponse.statusCode).toBe(200);
    const before = await persistentState();
    const actualResolutions = resolutions?.map((resolution) => ({ ...resolution, profileId: archivedId }));

    const executeResponse = await executeImport(app, previewResponse.json().data.importId, actualResolutions);

    expect(executeResponse.statusCode).toBe(expectedStatus);
    expect(await persistentState()).toEqual(before);
  });

  it('rolls back all database rows and image files when execution fails after related rows have started importing', async () => {
    const archive = await exportProfiles([selectedId]);
    const target = await createEmptyApp();
    const previewResponse = await preview(archive, target.app);
    expect(previewResponse.statusCode).toBe(200);
    const db = new Database(join(target.dataDir, 'fitness-coach.sqlite'));
    try {
      db.exec(`CREATE TRIGGER fail_profile_import_recommendation
        BEFORE INSERT ON recommendations
        WHEN NEW.report_markdown = 'selected report'
        BEGIN
          SELECT RAISE(ABORT, 'forced recommendation import failure');
        END`);
    } finally {
      db.close();
    }
    const before = await persistentState(target.dataDir);

    const executeResponse = await executeImport(target.app, previewResponse.json().data.importId, []);

    expect(executeResponse.statusCode).toBe(500);
    expect(await persistentState(target.dataDir)).toEqual(before);
    expect((await target.app.inject({ method: 'GET', url: '/api/profiles?status=all' })).json().data).toEqual([]);
    expect((await target.app.inject({ method: 'GET', url: '/api/current-profile' })).json().data.profile).toBeNull();
  });

  it.each([
    {
      name: 'a format version mismatch',
      mutate: (archive: Archive) => replaceJson(archive, 'manifest.json', (manifest) => { manifest.version = 999; }),
    },
    {
      name: 'a schema version mismatch between manifest and schema-version JSON',
      mutate: (archive: Archive) => replaceJson(archive, 'schema-version.json', (schema) => { schema.schema_version += 1; }),
    },
  ])('rejects $name without writing the database or images', async ({ mutate }) => {
    const archive = mutate(await exportProfiles([selectedId]));
    const before = await persistentState();

    const response = await preview(archive);

    expect(response.statusCode).toBe(400);
    expect(await persistentState()).toEqual(before);
  });

  it.each(['../outside.png', '/outside.png'])('rejects an image tar entry at %s without writing the database or images', async (unsafePath) => {
    const archive = renameEntry(await exportProfiles([selectedId]), selectedImagePath(selectedId), unsafePath);
    const before = await persistentState();

    const response = await preview(archive);

    expect(response.statusCode).toBe(400);
    expect(await persistentState()).toEqual(before);
  });

  it('rejects changed image bytes when the manifest retains the old hash', async () => {
    const archive = await exportProfiles([selectedId]);
    const tampered = new Map(archive);
    const imagePath = selectedImagePath(selectedId);
    const image = tampered.get(imagePath);
    if (!image) throw new Error('Missing exported image');
    tampered.set(imagePath, Buffer.from(image).fill(image[0] === 0 ? 1 : 0));
    const before = await persistentState();

    const response = await preview(tampered);

    expect(response.statusCode).toBe(400);
    expect(await persistentState()).toEqual(before);
  });

  it.each([
    {
      name: 'a daily entry profile_id pointing to another profile',
      mutate: (archive: Archive) => replaceJson(archive, 'daily-entries.json', (entries) => { entries[0].profile_id = archivedId; }),
    },
    {
      name: 'a child parent ID pointing outside the package',
      mutate: (archive: Archive) => replaceJson(archive, 'weights.json', (weights) => { weights[0].daily_entry_id = 999999; }),
    },
  ])('rejects $name without writing the database or images', async ({ mutate }) => {
    const archive = mutate(await exportProfiles([selectedId]));
    const before = await persistentState();

    const response = await preview(archive);

    expect(response.statusCode).toBe(400);
    expect(await persistentState()).toEqual(before);
  });
});

function selectedImagePath(profileId: number) {
  return `images/${profileId}/selected.png`;
}

function octal(value: number, size: number) {
  return Buffer.from(`${value.toString(8).padStart(size - 1, '0')}\0`);
}

function tarHeader(path: string, size: number) {
  const header = Buffer.alloc(512, 0);
  const absolute = path.startsWith('/');
  const pathWithoutRoot = absolute ? path.slice(1) : path;
  const slash = pathWithoutRoot.lastIndexOf('/');
  const name = Buffer.from(slash < 0 ? pathWithoutRoot : pathWithoutRoot.slice(slash + 1));
  const prefix = Buffer.from(slash < 0 ? '' : pathWithoutRoot.slice(0, slash));
  if (name.length > 100 || prefix.length > 155) throw new Error('Test tar path is too long');
  if (absolute) Buffer.from('/').copy(header, 0);
  name.copy(header, absolute ? 1 : 0);
  prefix.copy(header, 345);
  octal(0o600, 8).copy(header, 100);
  octal(size, 12).copy(header, 124);
  octal(Math.floor(Date.now() / 1000), 12).copy(header, 136);
  Buffer.alloc(8, 0x20).copy(header, 148);
  header[156] = 0x30;
  Buffer.from('ustar\0').copy(header, 257);
  Buffer.from('00').copy(header, 263);
  octal(header.reduce((sum, byte) => sum + byte, 0), 8).copy(header, 148);
  return header;
}

function createTar(entries: Array<{ path: string; bytes: Buffer }>) {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(tarHeader(entry.path, entry.bytes.length), entry.bytes);
    const padding = (512 - (entry.bytes.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}
