import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

const structuredReport = (summary: string, level: 'high' | 'low', banner: string) => ({
  summary,
  trend: { observations: ['Recorded trend'] },
  trainingPlan: [{ day: 1, focus: 'Recovery', exercises: ['Stretching'] }],
  dietAdvice: ['Keep meals consistent.'],
  recovery: ['Prioritize sleep.'],
  followUps: ['Review the next period.'],
  safety: { level, banner },
  uncertainties: [],
});

describe('report management API', () => {
  const apps: Array<{ close: () => Promise<void> }> = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function setup() {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-report-management-'));
    const app = await buildApp({ dataDir });
    apps.push(app);
    directories.push(dataDir);

    const first = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('First') });
    const second = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Second') });
    const firstId = first.json().data.id as number;
    const secondId = second.json().data.id as number;

    const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
    const insert = db.prepare(`INSERT INTO recommendations
      (profile_id, range_start, range_end, model_name, generated_at, input_summary_json, report_markdown, structured_report_json, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const firstHighRisk = Number(insert.run(
      firstId, '2026-10-01', '2026-10-07', 'model-a', '2026-10-08T12:00:00.000Z',
      JSON.stringify({ recordCount: 8, imageCount: 2, highRisk: true }), '# First high risk',
      JSON.stringify(structuredReport('First report', 'high', 'Caution')), 'completed',
    ).lastInsertRowid);
    const firstLowRisk = Number(insert.run(
      firstId, '2026-09-01', '2026-09-07', 'model-a', '2026-10-09T12:00:00.000Z',
      JSON.stringify({ recordCount: 4, imageCount: 0, highRisk: false }), '# First low risk',
      JSON.stringify(structuredReport('Second report', 'low', 'Clear')), 'completed',
    ).lastInsertRowid);
    const secondReport = Number(insert.run(
      secondId, '2026-10-01', '2026-10-07', 'model-b', '2026-10-10T12:00:00.000Z',
      JSON.stringify({ recordCount: 3, imageCount: 1, highRisk: false }), '# Second profile',
      JSON.stringify(structuredReport('Foreign report', 'low', 'Clear')), 'completed',
    ).lastInsertRowid);
    db.prepare('INSERT INTO daily_entries (profile_id, entry_date, status) VALUES (?, ?, ?)').run(firstId, '2026-10-10', 'training');
    const entry = db.prepare('SELECT id FROM daily_entries WHERE profile_id = ?').get(firstId) as { id: number };
    const meal = db.prepare(`INSERT INTO meals (daily_entry_id, eaten_at, meal_type, recognition_status)
      VALUES (?, ?, ?, ?)`).run(entry.id, '2026-10-10T12:00:00Z', 'lunch', 'confirmed');
    db.prepare(`INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size)
      VALUES (?, ?, ?, ?)`).run(Number(meal.lastInsertRowid), 'images/profile-1/report.jpg', 'image/jpeg', 10);
    db.prepare(`INSERT INTO food_items
      (meal_id, name, amount, unit, cooking_method, confidence, needs_confirmation, is_user_confirmed, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(Number(meal.lastInsertRowid), 'Food', 1, 'serving', '', 1, 0, 1, 'user');
    db.close();

    return { app, dataDir, firstId, secondId, firstHighRisk, firstLowRisk, secondReport };
  }

  it('adds report job, count, and error metadata to the schema', async () => {
    const { app, dataDir } = await setup();
    const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
    const columns = (db.prepare('PRAGMA table_info(recommendations)').all() as Array<{ name: string }>).map(({ name }) => name);
    db.close();

    expect(columns).toEqual(expect.arrayContaining([
      'profile_id', 'job_id', 'input_record_count', 'image_review_count', 'error_code', 'error_message',
    ]));
    expect((await app.inject({ method: 'GET', url: '/api/profiles/1/recommendations' })).statusCode).not.toBe(404);
  });

  it('initializes missing Phase 2D recommendation columns for version 2 databases', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-legacy-reports-'));
    directories.push(dataDir);
    const initialApp = await buildApp({ dataDir });
    const profile = await initialApp.inject({ method: 'POST', url: '/api/profiles', payload: profileInput('Legacy') });
    const profileId = profile.json().data.id as number;
    await initialApp.close();

    const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
    db.exec(`
      DROP INDEX IF EXISTS idx_recommendations_range;
      DROP INDEX IF EXISTS idx_recommendations_profile_generated;
      ALTER TABLE recommendations RENAME TO recommendations_legacy;
      CREATE TABLE recommendations (
        id INTEGER PRIMARY KEY,
        profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        range_start TEXT NOT NULL,
        range_end TEXT NOT NULL,
        model_name TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        input_summary_json TEXT NOT NULL,
        report_markdown TEXT NOT NULL,
        structured_report_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed'))
      );
      DROP TABLE recommendations_legacy;
    `);
    db.prepare(`INSERT INTO recommendations (
      profile_id, range_start, range_end, model_name, generated_at,
      input_summary_json, report_markdown, structured_report_json, status
    ) VALUES (?, '2026-10-01', '2026-10-07', 'legacy-model', '2026-10-08T12:00:00.000Z', ?, '# Legacy report', ?, 'completed')`)
      .run(profileId, '{}', JSON.stringify({ summary: 'Legacy report' }));
    db.close();

    const app = await buildApp({ dataDir });
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: `/api/profiles/${profileId}/recommendations` });
    const initializedDb = new Database(join(dataDir, 'fitness-coach.sqlite'));
    const columns = (initializedDb.prepare('PRAGMA table_info(recommendations)').all() as Array<{ name: string }>).map(({ name }) => name);
    initializedDb.close();

    expect(response.statusCode).toBe(200);
    expect(columns).toEqual(expect.arrayContaining([
      'job_id', 'input_record_count', 'image_review_count', 'error_code', 'error_message',
    ]));
    expect(response.json()).toMatchObject({
      ok: true,
      data: {
        total: 1,
        items: [{ id: 1, report_markdown: '# Legacy report', image_review_count: 0 }],
      },
    });
  });

  it('uses default pagination for blank page and pageSize query values', async () => {
    const { app, firstId } = await setup();

    const response = await app.inject({ method: 'GET', url: `/api/profiles/${firstId}/recommendations?page=&pageSize=` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, data: { page: 1, pageSize: 25, total: 2 } });
  });

  it('lists profile-scoped reports with filters, stable sorting, pagination, parsed data, and profile name', async () => {
    const { app, firstId, firstHighRisk } = await setup();

    const response = await app.inject({
      method: 'GET',
      url: `/api/profiles/${firstId}/recommendations?status=completed&from=2026-10-01&to=2026-10-31&risk=true&hasImages=true&sort=generated_at&order=asc&page=1&pageSize=1`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      data: {
        items: [{
          id: firstHighRisk,
          profile: { id: firstId, name: 'First' },
          inputSummary: { highRisk: true, imageCount: 2 },
          report: { summary: 'First report' },
        }],
        page: 1,
        pageSize: 1,
        total: 1,
      },
    });
  });

  it('keeps failed reports readable when stored JSON is invalid or structurally incomplete', async () => {
    const { app, dataDir, firstId, firstHighRisk } = await setup();
    const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
    const result = db.prepare(`INSERT INTO recommendations (
      profile_id, range_start, range_end, model_name, generated_at,
      input_record_count, image_review_count, input_summary_json, report_markdown,
      structured_report_json, status, error_code, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(firstId, '2026-10-11', '2026-10-17', 'model-failed', '2026-10-18T12:00:00.000Z',
        0, 0, '', 'Generation failed safely', 'not-json', 'failed', 'AI_HTTP_ERROR', 'Recommendation generation failed');
    const incompleteResult = db.prepare(`INSERT INTO recommendations (
      profile_id, range_start, range_end, model_name, generated_at,
      input_record_count, image_review_count, input_summary_json, report_markdown,
      structured_report_json, status, error_code, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(firstId, '2026-10-18', '2026-10-24', 'model-incomplete', '2026-10-25T12:00:00.000Z',
        0, 0, JSON.stringify({ recordCount: 0, imageCount: 0, highRisk: false }),
        'Generation failed with an incomplete payload', '{}', 'failed', 'AI_INVALID_RESPONSE', 'Recommendation response was incomplete');
    db.close();
    const reportId = Number(result.lastInsertRowid);
    const incompleteReportId = Number(incompleteResult.lastInsertRowid);

    const list = await app.inject({ method: 'GET', url: `/api/profiles/${firstId}/recommendations?status=failed` });
    const detail = await app.inject({ method: 'GET', url: `/api/profiles/${firstId}/recommendations/${reportId}` });
    const incompleteDetail = await app.inject({ method: 'GET', url: `/api/profiles/${firstId}/recommendations/${incompleteReportId}` });
    const completedDetail = await app.inject({ method: 'GET', url: `/api/profiles/${firstId}/recommendations/${firstHighRisk}` });

    expect(list.statusCode).toBe(200);
    expect(detail.statusCode).toBe(200);
    expect(incompleteDetail.statusCode).toBe(200);
    expect(completedDetail.statusCode).toBe(200);

    const failedItems = list.json().data.items as Array<{ id: number; report: unknown }>;
    expect(failedItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: reportId,
        status: 'failed',
        report: null,
        inputSummary: null,
        error_code: 'AI_HTTP_ERROR',
        error_message: 'Recommendation generation failed',
      }),
      expect.objectContaining({
        id: incompleteReportId,
        status: 'failed',
        report: null,
        inputSummary: { recordCount: 0, imageCount: 0, highRisk: false },
        error_code: 'AI_INVALID_RESPONSE',
        error_message: 'Recommendation response was incomplete',
      }),
    ]));
    expect(detail.json()).toMatchObject({
      ok: true,
      data: { id: reportId, status: 'failed', report: null, inputSummary: null },
    });
    expect(incompleteDetail.json()).toMatchObject({
      ok: true,
      data: {
        id: incompleteReportId,
        status: 'failed',
        inputSummary: { recordCount: 0, imageCount: 0, highRisk: false },
      },
    });
    expect(completedDetail.json()).toMatchObject({
      ok: true,
      data: { id: firstHighRisk, status: 'completed', report: { summary: 'First report' } },
    });
    expect.soft(incompleteDetail.json().data.report).toBeNull();

    const markdown = await app.inject({ method: 'GET', url: `/api/profiles/${firstId}/recommendations/${reportId}/export?format=markdown` });
    expect(markdown.statusCode).toBe(200);
    expect(markdown.body).toBe('Generation failed safely');

    const json = await app.inject({ method: 'GET', url: `/api/profiles/${firstId}/recommendations/${reportId}/export?format=json` });
    expect(json.statusCode).toBe(200);
    expect(JSON.parse(json.body)).toMatchObject({
      status: 'failed',
      report: null,
      inputSummary: null,
      error_code: 'AI_HTTP_ERROR',
      error_message: 'Recommendation generation failed',
    });
    expect(json.body).not.toContain('api_key');
  });

  it('rejects invalid date and boolean query values', async () => {
    const { app, firstId } = await setup();
    expect((await app.inject({ method: 'GET', url: `/api/profiles/${firstId}/recommendations?from=2026-10-02&to=2026-10-01` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/profiles/${firstId}/recommendations?hasImages=maybe` })).statusCode).toBe(400);
  });

  it('does not leak foreign or unknown reports through detail, delete, or export', async () => {
    const { app, firstId, secondId, secondReport } = await setup();

    for (const request of [
      { method: 'GET' as const, url: `/api/profiles/${firstId}/recommendations/${secondReport}` },
      { method: 'DELETE' as const, url: `/api/profiles/${firstId}/recommendations/${secondReport}` },
      { method: 'GET' as const, url: `/api/profiles/${firstId}/recommendations/${secondReport}/export?format=json` },
      { method: 'GET' as const, url: `/api/profiles/999999/recommendations` },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      expect(response.body).not.toContain('Foreign report');
      expect(response.body).not.toContain('Second');
    }
  });

  it('deletes only reports, supports atomic deduplicated bulk deletion, and preserves records', async () => {
    const { app, dataDir, firstId, secondReport, firstHighRisk, firstLowRisk } = await setup();

    const foreignBatch = await app.inject({
      method: 'POST',
      url: `/api/profiles/${firstId}/recommendations/bulk-delete`,
      payload: { ids: [firstHighRisk, secondReport] },
    });
    expect(foreignBatch.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/profiles/${firstId}/recommendations/${firstHighRisk}` })).statusCode).toBe(200);

    expect((await app.inject({
      method: 'POST',
      url: `/api/profiles/${firstId}/recommendations/bulk-delete`,
      payload: { ids: [] },
    })).statusCode).toBe(400);

    const deleted = await app.inject({
      method: 'POST',
      url: `/api/profiles/${firstId}/recommendations/bulk-delete`,
      payload: { ids: [firstHighRisk, firstHighRisk] },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().data.deleted).toEqual([firstHighRisk]);

    const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
    expect((db.prepare('SELECT COUNT(*) AS count FROM recommendations WHERE id = ?').get(firstHighRisk) as { count: number }).count).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM recommendations WHERE id = ?').get(firstLowRisk) as { count: number }).count).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS count FROM daily_entries').get() as { count: number }).count).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS count FROM meal_images').get() as { count: number }).count).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS count FROM food_items').get() as { count: number }).count).toBe(1);
    db.close();
  });

  it('allows archived profile reads and exports but blocks report deletion', async () => {
    const { app, firstId, secondId, firstLowRisk } = await setup();
    expect((await app.inject({ method: 'PUT', url: '/api/current-profile', payload: { profileId: secondId } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/profiles/${firstId}/archive` })).statusCode).toBe(200);

    expect((await app.inject({ method: 'GET', url: `/api/profiles/${firstId}/recommendations/${firstLowRisk}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/profiles/${firstId}/recommendations/${firstLowRisk}/export?format=markdown` })).statusCode).toBe(200);

    const singleDelete = await app.inject({ method: 'DELETE', url: `/api/profiles/${firstId}/recommendations/${firstLowRisk}` });
    expect(singleDelete.statusCode).toBe(409);
    expect(singleDelete.json()).toMatchObject({ ok: false, error: { code: 'PROFILE_ARCHIVED' } });
    const bulkDelete = await app.inject({ method: 'POST', url: `/api/profiles/${firstId}/recommendations/bulk-delete`, payload: { ids: [firstLowRisk] } });
    expect(bulkDelete.statusCode).toBe(409);
    expect(bulkDelete.json()).toMatchObject({ ok: false, error: { code: 'PROFILE_ARCHIVED' } });
  });

  it('returns raw markdown and JSON attachment payloads without an API envelope', async () => {
    const { app, firstId, firstLowRisk } = await setup();
    const markdown = await app.inject({ method: 'GET', url: `/api/profiles/${firstId}/recommendations/${firstLowRisk}/export?format=markdown` });
    expect(markdown.statusCode).toBe(200);
    expect(markdown.headers['content-type']).toContain('text/markdown');
    expect(markdown.headers['content-disposition']).toContain('attachment');
    expect(markdown.body).toBe('# First low risk');
    expect(markdown.body).not.toContain('"ok"');

    const json = await app.inject({ method: 'GET', url: `/api/profiles/${firstId}/recommendations/${firstLowRisk}/export?format=json` });
    expect(json.statusCode).toBe(200);
    expect(json.headers['content-type']).toContain('application/json');
    expect(json.headers['content-disposition']).toContain('attachment');
    expect(JSON.parse(json.body)).toMatchObject({ report: { summary: 'Second report' }, inputSummary: { highRisk: false } });
    expect(json.body).not.toContain('"ok"');
    expect((await app.inject({ method: 'GET', url: `/api/profiles/${firstId}/recommendations/${firstLowRisk}/export?format=xml` })).statusCode).toBe(400);
  });
});
