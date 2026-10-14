import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createRepositories, migrate } from '@fitness-coach/db';
import { buildApp } from './app.js';

const profileInput = (name: string) => ({
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
});

async function withApp(test: (app: Awaited<ReturnType<typeof buildApp>>, dataDir: string) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-profile-management-'));
  const app = await buildApp({ dataDir });
  try {
    await test(app, dataDir);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

describe('profile management API', () => {
  it('creates profiles with required body data, rejects empty profiles, and enforces unique names', async () => {
    await withApp(async (app) => {
      const created = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Runner') });
      expect(created.statusCode).toBe(201);
      expect(created.json().data).toMatchObject({ name: 'Runner', status: 'active' });

      const duplicate = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('  runner ') });
      expect(duplicate.statusCode).toBe(409);

      const empty = await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Incomplete' } });
      expect(empty.statusCode).toBe(400);
      const blankName = await app.inject({ method: 'POST', url: '/api/profiles', payload: { ...profileInput('   '), name: '   ' } });
      expect(blankName.statusCode).toBe(400);
    });
  });

  it('returns profile details and summary fields, and only active profiles can be edited', async () => {
    await withApp(async (app) => {
      const created = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Runner') });
      const id = created.json().data.id as number;
      const entry = await app.inject({ method: 'PUT', url: '/api/daily-entries/2026-10-10', payload: { status: 'training' } });
      expect(entry.statusCode).toBe(200);

      const detail = await app.inject({ method: 'GET', url: `/api/profiles/${id}` });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().data).toMatchObject({ id, name: 'Runner', summary: expect.objectContaining({ record_days: 1 }) });
      expect(detail.json().data.daily_entries).toEqual([expect.objectContaining({ entry_date: '2026-10-10', status: 'training' })]);

      const archived = await app.inject({ method: 'POST', url: `/api/profiles/${id}/archive` });
      expect(archived.statusCode).toBe(409);

      const other = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Other') });
      const otherId = other.json().data.id as number;
      await app.inject({ method: 'PUT', url: '/api/current-profile', payload: { profileId: otherId } });
      expect((await app.inject({ method: 'POST', url: `/api/profiles/${id}/archive` })).statusCode).toBe(200);
      const edit = await app.inject({ method: 'PATCH', url: `/api/profiles/${id}`, payload: { ...profileInput('Changed'), name: 'Changed' } });
      expect(edit.statusCode).toBe(409);
      expect(edit.json()).toMatchObject({ ok: false, error: { code: 'PROFILE_ARCHIVED' } });
    });
  });

  it('filters and sorts profiles on the server by status and each supported time field', async () => {
    await withApp(async (app, dataDir) => {
      const first = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('First') });
      const second = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Second') });
      const firstId = first.json().data.id as number;
      const secondId = second.json().data.id as number;
      const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
      db.prepare("UPDATE profiles SET created_at = ?, updated_at = ? WHERE id = ?").run('2026-10-01T00:00:00.000Z', '2026-10-03T00:00:00.000Z', firstId);
      db.prepare("UPDATE profiles SET created_at = ?, updated_at = ? WHERE id = ?").run('2026-10-02T00:00:00.000Z', '2026-10-04T00:00:00.000Z', secondId);
      db.close();

      const byCreated = await app.inject({ method: 'GET', url: '/api/profiles?status=active&timeField=created_at&from=2026-10-01&to=2026-10-02&sort=created_at&order=asc' });
      expect(byCreated.json().data.map((profile: { id: number }) => profile.id)).toEqual([firstId, secondId]);
      const byUpdated = await app.inject({ method: 'GET', url: '/api/profiles?timeField=updated_at&sort=updated_at&order=desc' });
      expect(byUpdated.json().data.map((profile: { id: number }) => profile.id).slice(0, 2)).toEqual([secondId, firstId]);
      const invalidSort = await app.inject({ method: 'GET', url: '/api/profiles?timeField=created_at&sort=updated_at' });
      expect(invalidSort.statusCode).toBe(400);
    });
  });

  it('sorts stably by ID and supports recent entry and recommendation date filters', async () => {
    await withApp(async (app, dataDir) => {
      const first = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('First') });
      const second = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Second') });
      const firstId = first.json().data.id as number;
      const secondId = second.json().data.id as number;
      const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
      db.prepare('INSERT INTO daily_entries (profile_id, entry_date, status) VALUES (?, ?, ?)').run(firstId, '2026-10-01', 'training');
      db.prepare('INSERT INTO daily_entries (profile_id, entry_date, status) VALUES (?, ?, ?)').run(secondId, '2026-10-01', 'rest');
      const recommendation = "INSERT INTO recommendations (profile_id, range_start, range_end, model_name, generated_at, input_summary_json, report_markdown, structured_report_json, status) VALUES (?, '2026-09-01', '2026-09-30', 'mock', ?, '{}', '', '{}', 'completed')";
      db.prepare(recommendation).run(firstId, '2026-10-02T12:00:00.000Z');
      db.prepare(recommendation).run(secondId, '2026-10-03T12:00:00.000Z');
      db.close();

      const byEntry = await app.inject({ method: 'GET', url: '/api/profiles?timeField=last_entry_at&from=2026-10-01&to=2026-10-01&sort=last_entry_at&order=asc' });
      expect(byEntry.json().data.map((profile: { id: number }) => profile.id)).toEqual([firstId, secondId]);
      const byRecommendation = await app.inject({ method: 'GET', url: '/api/profiles?timeField=last_recommendation_at&from=2026-10-03&to=2026-10-03&sort=last_recommendation_at&order=desc' });
      expect(byRecommendation.json().data.map((profile: { id: number }) => profile.id)).toEqual([secondId]);
    });
  });

  it('sorts archived profiles by archive time by default', async () => {
    await withApp(async (app, dataDir) => {
      const first = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('First') });
      const second = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Second') });
      const current = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Current') });
      const firstId = first.json().data.id as number;
      const secondId = second.json().data.id as number;
      await app.inject({ method: 'PUT', url: '/api/current-profile', payload: { profileId: current.json().data.id } });
      await app.inject({ method: 'POST', url: `/api/profiles/${firstId}/archive` });
      await app.inject({ method: 'POST', url: `/api/profiles/${secondId}/archive` });
      const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
      db.prepare('UPDATE profiles SET archived_at = ? WHERE id = ?').run('2026-10-04T00:00:00.000Z', firstId);
      db.prepare('UPDATE profiles SET archived_at = ? WHERE id = ?').run('2026-10-03T00:00:00.000Z', secondId);
      db.close();
      const result = await app.inject({ method: 'GET', url: '/api/profiles?status=archived' });
      expect(result.json().data.map((profile: { id: number }) => profile.id)).toEqual([firstId, secondId]);
    });
  });

  it('archives and restores profiles transactionally, while preserving their records', async () => {
    await withApp(async (app) => {
      const first = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('First') });
      const id = first.json().data.id as number;
      const second = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Second') });
      await app.inject({ method: 'PUT', url: '/api/current-profile', payload: { profileId: second.json().data.id } });
      expect((await app.inject({ method: 'POST', url: `/api/profiles/${id}/archive` })).json().data.status).toBe('archived');
      expect((await app.inject({ method: 'POST', url: `/api/profiles/${id}/restore` })).json().data.status).toBe('active');
    });
  });

  it('rejects deleting the current profile and batch deletion containing it, then clears current after the last active profile is deleted', async () => {
    await withApp(async (app, dataDir) => {
      const first = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('First') });
      const second = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Second') });
      const firstId = first.json().data.id as number;
      const secondId = second.json().data.id as number;
      expect((await app.inject({ method: 'DELETE', url: `/api/profiles/${secondId}` })).statusCode).toBe(409);
      expect((await app.inject({ method: 'DELETE', url: '/api/profiles', payload: { ids: [firstId, secondId] } })).statusCode).toBe(409);

      await app.inject({ method: 'PUT', url: '/api/current-profile', payload: { profileId: secondId } });
      const deleted = await app.inject({ method: 'DELETE', url: `/api/profiles/${firstId}` });
      expect(deleted.statusCode).toBe(200);
      expect((await app.inject({ method: 'DELETE', url: `/api/profiles/${secondId}` })).statusCode).toBe(409);
      const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
      db.prepare("DELETE FROM app_settings WHERE key = 'current_profile_id'").run();
      db.close();
      expect((await app.inject({ method: 'DELETE', url: `/api/profiles/${secondId}` })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/current-profile' })).json().data.profile).toBeNull();
    });
  });

  it('does not delete a profile that becomes current while deletion is in progress', async () => {
    await withApp(async (app) => {
      const target = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Target') });
      const targetId = target.json().data.id as number;
      const current = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Current') });
      const currentId = current.json().data.id as number;
      await app.inject({ method: 'PUT', url: '/api/current-profile', payload: { profileId: currentId } });

      const deleting = app.inject({ method: 'DELETE', url: `/api/profiles/${targetId}` });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const switching = await app.inject({ method: 'PUT', url: '/api/current-profile', payload: { profileId: targetId } });
      const deleted = await deleting;

      expect(deleted.statusCode).toBe(200);
      expect(switching.statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `/api/profiles/${targetId}` })).statusCode).toBe(404);
    });
  });

  it('cancels every active recommendation phase and waits for the runner before deleting its profile', async () => {
    await withApp(async (app, dataDir) => {
      const target = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Job target') });
      const targetId = target.json().data.id as number;
      const current = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Job current') });
      const currentId = current.json().data.id as number;
      await app.inject({ method: 'PUT', url: '/api/current-profile', payload: { profileId: currentId } });

      const database = new Database(join(dataDir, 'fitness-coach.sqlite'));
      const jobs = [
        ['queued', 5, '2026-10-01'], ['waiting_model', 60, '2026-10-02'], ['receiving', 80, '2026-10-03'],
      ] as const;
      const snapshot = database.prepare('SELECT * FROM profiles WHERE id = ?').get(targetId);
      for (const [status, phasePercent, date] of jobs) {
        database.prepare(`INSERT INTO recommendation_jobs (
          job_id, profile_id, profile_snapshot_json, range_start, range_end, image_policy_json,
          specified_meal_ids_json, specified_meal_payload_json, status, phase_percent, received_chars
        ) VALUES (?, ?, ?, ?, ?, '{}', '[]', NULL, ?, ?, 0)`).run(
          `job-${status}`, targetId, JSON.stringify(snapshot), date, date,
          status, phasePercent,
        );
      }
      database.close();

      const deleted = await app.inject({ method: 'DELETE', url: `/api/profiles/${targetId}` });

      expect(deleted.statusCode).toBe(200);
      const after = new Database(join(dataDir, 'fitness-coach.sqlite'));
      expect(after.prepare('SELECT COUNT(*) AS count FROM recommendation_jobs WHERE profile_id = ?').get(targetId)).toEqual({ count: 0 });
      expect(after.prepare('SELECT COUNT(*) AS count FROM recommendations WHERE profile_id = ?').get(targetId)).toEqual({ count: 0 });
      expect(after.prepare('SELECT COUNT(*) AS count FROM profiles WHERE id = ?').get(targetId)).toEqual({ count: 0 });
      after.close();
    });
  });

  it('deletes multiple non-current profiles atomically', async () => {
    await withApp(async (app) => {
      const first = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('First') });
      const second = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Second') });
      const current = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Current') });
      const ids = [first.json().data.id, second.json().data.id] as number[];
      await app.inject({ method: 'PUT', url: '/api/current-profile', payload: { profileId: current.json().data.id } });
      const deleted = await app.inject({ method: 'DELETE', url: '/api/profiles', payload: { ids } });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json().data.deleted).toEqual(ids);
      const remaining = (await app.inject({ method: 'GET', url: '/api/profiles?status=all' })).json().data as Array<{ id: number }>;
      expect(remaining.map(({ id }) => id)).toEqual([current.json().data.id]);
    });
  });

  it('cleans profile image files after deleting profile data and reports cleanup failures', async () => {
    await withApp(async (app, dataDir) => {
      const created = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Runner') });
      const id = created.json().data.id as number;
      const other = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Other') });
      await app.inject({ method: 'PUT', url: '/api/current-profile', payload: { profileId: other.json().data.id } });
      const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
      db.prepare('INSERT INTO daily_entries (profile_id, entry_date, status) VALUES (?, ?, ?)').run(id, '2026-10-10', 'training');
      const entryId = (db.prepare('SELECT id FROM daily_entries WHERE profile_id = ?').get(id) as { id: number }).id;
      db.prepare("INSERT INTO meals (daily_entry_id, eaten_at, meal_type, recognition_status) VALUES (?, ?, ?, 'unrecognized')").run(entryId, '2026-10-10T12:00:00Z', 'lunch');
      const mealId = (db.prepare('SELECT id FROM meals WHERE daily_entry_id = ?').get(entryId) as { id: number }).id;
      await mkdir(join(dataDir, 'images', `profile-${id}`), { recursive: true });
      await writeFile(join(dataDir, 'images', `profile-${id}`, 'saved.png'), 'x');
      await writeFile(join(dataDir, 'images', `profile-${id}`, 'orphan.png'), 'orphan');
      db.prepare("INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size) VALUES (?, ?, 'image/png', 1)").run(mealId, `images/profile-${id}/saved.png`);
      db.prepare("INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size) VALUES (?, ?, 'image/png', 1)").run(mealId, `images/profile-${id}/missing.png`);
      db.close();
      const result = await app.inject({ method: 'DELETE', url: `/api/profiles/${id}` });
      expect(result.statusCode).toBe(200);
      expect(result.json().data).toMatchObject({ cleanup_failures: [`images/profile-${id}/missing.png`] });
      await expect(stat(join(dataDir, 'images', `profile-${id}`, 'saved.png'))).rejects.toThrow();
      await expect(stat(join(dataDir, 'images', `profile-${id}`, 'orphan.png'))).rejects.toThrow();
    });
  });

  it('does not delete an image path outside the deleted profile directory', async () => {
    await withApp(async (app, dataDir) => {
      const target = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Target') });
      const targetId = target.json().data.id as number;
      const other = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Other') });
      const otherId = other.json().data.id as number;
      await mkdir(join(dataDir, 'images', `profile-${otherId}`), { recursive: true });
      const foreignPath = `images/profile-${otherId}/keep.png`;
      await writeFile(join(dataDir, foreignPath), 'x');
      const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
      db.prepare('INSERT INTO daily_entries (profile_id, entry_date, status) VALUES (?, ?, ?)').run(targetId, '2026-10-10', 'training');
      const entryId = (db.prepare('SELECT id FROM daily_entries WHERE profile_id = ?').get(targetId) as { id: number }).id;
      db.prepare("INSERT INTO meals (daily_entry_id, eaten_at, meal_type, recognition_status) VALUES (?, ?, ?, 'unrecognized')").run(entryId, '2026-10-10T12:00:00Z', 'lunch');
      const mealId = (db.prepare('SELECT id FROM meals WHERE daily_entry_id = ?').get(entryId) as { id: number }).id;
      db.prepare("INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size) VALUES (?, ?, 'image/png', 1)").run(mealId, foreignPath);
      db.close();

      const deleted = await app.inject({ method: 'DELETE', url: `/api/profiles/${targetId}` });
      expect(deleted.json().data.cleanup_failures).toEqual([foreignPath]);
      await expect(stat(join(dataDir, foreignPath))).resolves.toBeDefined();
    });
  });

  it('refuses profile deletion before database removal when its image directory is a symlink', async () => {
    await withApp(async (app, dataDir) => {
      const created = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Linked') });
      const id = created.json().data.id as number;
      const other = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Other') });
      await app.inject({ method: 'PUT', url: '/api/current-profile', payload: { profileId: other.json().data.id } });
      const outside = await mkdtemp(join(tmpdir(), 'fitness-coach-profile-outside-'));
      await rm(join(dataDir, 'images', `profile-${id}`), { recursive: true, force: true });
      await symlink(outside, join(dataDir, 'images', `profile-${id}`));
      try {
        const deleted = await app.inject({ method: 'DELETE', url: `/api/profiles/${id}` });
        expect(deleted.statusCode).toBe(400);
        expect((await app.inject({ method: 'GET', url: `/api/profiles/${id}` })).statusCode).toBe(200);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('rejects cross-profile meal and image ID access', async () => {
    await withApp(async (app, dataDir) => {
      const first = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('First') });
      const firstId = first.json().data.id as number;
      const second = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Second') });
      const secondId = second.json().data.id as number;
      const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
      db.prepare('INSERT INTO daily_entries (profile_id, entry_date, status) VALUES (?, ?, ?)').run(firstId, '2026-10-10', 'training');
      const entryId = (db.prepare('SELECT id FROM daily_entries WHERE profile_id = ?').get(firstId) as { id: number }).id;
      db.prepare("INSERT INTO meals (daily_entry_id, eaten_at, meal_type, recognition_status) VALUES (?, ?, ?, 'unrecognized')").run(entryId, '2026-10-10T12:00:00Z', 'lunch');
      const mealId = (db.prepare('SELECT id FROM meals WHERE daily_entry_id = ?').get(entryId) as { id: number }).id;
      db.prepare("INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size) VALUES (?, 'images/profile-1/x.png', 'image/png', 1)").run(mealId);
      const imageId = (db.prepare('SELECT id FROM meal_images WHERE meal_id = ?').get(mealId) as { id: number }).id;
      db.close();
      await app.inject({ method: 'PUT', url: '/api/current-profile', payload: { profileId: secondId } });
      expect((await app.inject({ method: 'DELETE', url: `/api/meals/${mealId}` })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `/api/images/${imageId}` })).statusCode).toBe(404);
      expect((await app.inject({ method: 'DELETE', url: `/api/images/${imageId}` })).statusCode).toBe(404);
    });
  });
});
