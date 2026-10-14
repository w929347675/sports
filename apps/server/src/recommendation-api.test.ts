import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import type { AiConfig, AiRequestOptions } from '@fitness-coach/ai';

const generateRecommendation = vi.hoisted(() => vi.fn());
const createRecommendationModel = vi.hoisted(() => vi.fn((_config: AiConfig, _options?: AiRequestOptions) => generateRecommendation));

vi.mock('@fitness-coach/ai', async () => ({
  ...(await vi.importActual('@fitness-coach/ai')),
  createRecommendationModel,
}));

const report = {
  summary: 'The period was consistent overall.',
  trend: { observations: ['Weight was stable.'] },
  trainingPlan: Array.from({ length: 7 }, (_, index) => ({ day: index + 1, focus: 'Strength', exercises: ['Squat'] })),
  dietAdvice: ['Keep protein consistent.'],
  recovery: ['Sleep at least eight hours.'],
  followUps: ['Review progress in seven days.'],
  safety: { level: 'low', banner: 'No immediate safety concerns.' },
  uncertainties: [],
};

const profile = {
  goal: 'maintain', height_cm: 175, age: 30, sex: 'unspecified',
  training_experience: 'intermediate', equipment: 'home gym', training_days_per_week: 4,
  session_duration_minutes: 60, diet_preferences: 'balanced', allergies: 'none', health_restrictions: 'none',
};

describe('recommendation API', () => {
  const directories: string[] = [];
  const apps: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    generateRecommendation.mockReset();
    createRecommendationModel.mockClear();
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function setup() {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-recommendation-'));
    const app = await buildApp({ dataDir });
    directories.push(dataDir);
    apps.push(app);
    await app.inject({ method: 'PUT', url: '/api/settings/model', payload: {
      base_url: 'https://model.example/v1', model_name: 'recommendation-model', api_key: 'sk-do-not-return',
    } });
    await app.inject({ method: 'PUT', url: '/api/profile', payload: profile });
    await app.inject({ method: 'PUT', url: '/api/daily-entries/2026-09-28', payload: { status: 'training' } });
    return { app, dataDir };
  }

  function savedRecommendations(dataDir: string) {
    const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
    try {
      return db.prepare(`SELECT status, range_start, range_end, model_name, input_summary_json,
        report_markdown, structured_report_json FROM recommendations ORDER BY id`).all() as Array<{
          status: string;
          range_start: string;
          range_end: string;
          model_name: string;
          input_summary_json: string;
          report_markdown: string;
          structured_report_json: string;
        }>;
    } finally {
      db.close();
    }
  }

  function dbCount(dataDir: string, table: 'recommendation_jobs' | 'recommendations') {
    const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
    try {
      return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    } finally {
      db.close();
    }
  }

  it('generates and saves a completed report without returning the model API key', async () => {
    generateRecommendation.mockResolvedValue({
      modelName: 'recommendation-model',
      report,
      markdown: '# Summary',
      inputSummary: { recordCount: 1, imageCount: 0 },
    });
    const { app, dataDir } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: '/api/profiles/1/recommendation-jobs',
      payload: { start: '2026-09-18', end: '2026-10-01' },
    });

    expect(response.statusCode).toBe(202);
    await vi.waitFor(() => expect(generateRecommendation).toHaveBeenCalledTimes(1));
    expect(generateRecommendation).toHaveBeenCalledTimes(1);
    expect(createRecommendationModel).toHaveBeenCalledWith(
      { baseUrl: 'https://model.example/v1', modelName: 'recommendation-model', apiKey: 'sk-do-not-return' },
      expect.objectContaining({ timeoutMs: 600_000, maxRetries: 0, stream: true, signal: expect.any(AbortSignal) }),
    );
    expect(response.json()).toMatchObject({ ok: true, data: { status: 'queued' } });
    expect(response.body).not.toContain('sk-do-not-return');
    expect(response.body).not.toMatch(/api[_-]?key/i);
    const modelInput = generateRecommendation.mock.calls[0]?.[0] as { sections: { trends: { range: unknown; longTerm: unknown } } };
    expect(modelInput.sections.trends).toEqual(expect.objectContaining({ range: expect.anything(), longTerm: expect.anything() }));
    expect(dbCount(dataDir, 'recommendation_jobs')).toBe(1);
  });

  it('rejects the legacy synchronous generation route without creating a job or calling the model', async () => {
    const { app, dataDir } = await setup();

    const response = await app.inject({ method: 'POST', url: '/api/recommendations', payload: { start: '2026-09-18', end: '2026-10-01' } });

    expect(response.statusCode).toBe(409);
    expect(generateRecommendation).not.toHaveBeenCalled();
    const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
    expect(db.prepare('SELECT COUNT(*) AS count FROM recommendation_jobs').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM recommendations').get()).toEqual({ count: 0 });
    db.close();
  });

  it('returns a local preflight summary without calling the recommendation model', async () => {
    const { app } = await setup();
    await app.inject({ method: 'POST', url: '/api/daily-entries/2026-09-28/feedback', payload: {
      recorded_at: '2026-09-28T12:00:00Z', category: 'pain', body_part: 'knee', severity: 8,
      impact: 'walking', description: 'Pain after training',
    } });

    const response = await app.inject({
      method: 'POST',
      url: '/api/recommendations/preview',
      payload: { start: '2026-09-18', end: '2026-10-01' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, data: {
      range: { start: '2026-09-18', end: '2026-10-01' },
      inputSummary: { entryCount: 1, feedbackCount: 1, imageCount: 0, highRisk: true },
      imageCount: 0,
      highRisk: true,
    } });
    expect(createRecommendationModel).not.toHaveBeenCalled();
    expect(response.body).not.toMatch(/api[_-]?key|sk-do-not-return/i);
  });

  it('does not save a completed report when the recommendation model fails', async () => {
    generateRecommendation.mockRejectedValue(new Error('model unavailable'));
    const { app, dataDir } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: '/api/profiles/1/recommendation-jobs',
      payload: { start: '2026-09-18', end: '2026-10-01' },
    });

    expect(response.statusCode).toBe(202);
    const jobId = response.json().data.job_id as string;
    await vi.waitFor(async () => {
      const job = await app.inject({ method: 'GET', url: `/api/profiles/1/recommendation-jobs/${jobId}` });
      expect(job.json().data.status).toBe('failed');
    });
    expect(generateRecommendation).toHaveBeenCalledTimes(1);
    expect(response.body).not.toContain('sk-do-not-return');
    expect(savedRecommendations(dataDir).map(({ status }) => status)).not.toContain('completed');
  });

  it('uses the default date range when generation has no request body', async () => {
    generateRecommendation.mockResolvedValue({
      modelName: 'recommendation-model',
      report,
      markdown: '# Summary',
      inputSummary: { recordCount: 999, imageCount: 999 },
    });
    const { app, dataDir } = await setup();

    const response = await app.inject({ method: 'POST', url: '/api/profiles/1/recommendation-jobs' });

    expect(response.statusCode).toBe(202);
    await vi.waitFor(() => expect(savedRecommendations(dataDir)).toHaveLength(1));
    expect(savedRecommendations(dataDir)[0]?.input_summary_json).not.toContain('999');
  });

  it('bounds the local structured summary before sending a long date range to the model', async () => {
    generateRecommendation.mockResolvedValue({
      modelName: 'recommendation-model',
      report,
      markdown: '# Summary',
      inputSummary: { recordCount: 999, imageCount: 999 },
    });
    const { app, dataDir } = await setup();
    const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
    try {
      const profileId = Number((db.prepare("SELECT value FROM app_settings WHERE key = 'current_profile_id'").get() as { value: string }).value);
      const insert = db.prepare('INSERT INTO daily_entries (profile_id, entry_date, status, status_note) VALUES (?, ?, ?, ?)');
      for (let index = 0; index < 120; index += 1) {
        const date = new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10);
        insert.run(profileId, date, 'training', '');
      }
    } finally {
      db.close();
    }

    const response = await app.inject({
      method: 'POST',
      url: '/api/profiles/1/recommendation-jobs',
      payload: { start: '2026-01-01', end: '2026-04-30' },
    });

    expect(response.statusCode).toBe(202);
    await vi.waitFor(() => expect(generateRecommendation).toHaveBeenCalledTimes(1));
    const modelInput = generateRecommendation.mock.calls[0]?.[0] as {
      sections: { structuredData: { days: unknown[]; truncated: boolean } };
    };
    expect(modelInput.sections.structuredData.days.length).toBeLessThanOrEqual(100);
    expect(modelInput.sections.structuredData.truncated).toBe(true);
  });

  it('sends structured records and a high-risk marker while excluding all 30 historical images by default', async () => {
    generateRecommendation.mockResolvedValue({
      modelName: 'recommendation-model',
      report,
      markdown: '# Summary',
      inputSummary: { recordCount: 3, imageCount: 0, highRisk: true },
    });
    const { app, dataDir } = await setup();
    await app.inject({ method: 'POST', url: '/api/daily-entries/2026-09-28/feedback', payload: {
      recorded_at: '2026-09-28T12:00:00Z', category: 'pain', body_part: 'knee', severity: 8,
      impact: 'walking', description: 'Pain after training',
    } });
    const db = new Database(join(dataDir, 'fitness-coach.sqlite'));
    try {
      const entry = db.prepare('SELECT id FROM daily_entries WHERE entry_date = ?').get('2026-09-28') as { id: number };
      const meal = db.prepare(`INSERT INTO meals (daily_entry_id, eaten_at, meal_type, notes, recognition_status)
        VALUES (?, ?, ?, ?, ?)`).run(entry.id, '2026-09-28T13:00:00Z', 'lunch', '', 'confirmed');
      db.prepare(`INSERT INTO food_items
        (meal_id, name, amount, unit, cooking_method, confidence, needs_confirmation, is_user_confirmed, source, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(Number(meal.lastInsertRowid), 'Chicken', 150, 'g', 'grilled', 1, 0, 1, 'user', '');
      const addImage = db.prepare('INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size) VALUES (?, ?, ?, ?)');
      for (let index = 0; index < 30; index += 1) {
        addImage.run(Number(meal.lastInsertRowid), `images/history-${index}.jpg`, 'image/jpeg', 128);
      }
    } finally {
      db.close();
    }

    const response = await app.inject({
      method: 'POST',
      url: '/api/profiles/1/recommendation-jobs',
      payload: { start: '2026-09-18', end: '2026-10-01' },
    });

    expect(response.statusCode).toBe(202);
    await vi.waitFor(() => expect(generateRecommendation).toHaveBeenCalledTimes(1));
    const modelInput = generateRecommendation.mock.calls[0]?.[0] as {
      sections: { structuredData: { days: unknown[] }; confirmedFood: unknown[]; safety: { level: string; banner: string } };
      images: unknown[];
    };
    expect(modelInput.images).toEqual([]);
    expect(modelInput.sections.structuredData.days).toHaveLength(1);
    expect(modelInput.sections.confirmedFood).toEqual([expect.objectContaining({ name: 'Chicken' })]);
    expect(modelInput.sections.safety.level).toBe('high');
    await vi.waitFor(() => expect(savedRecommendations(dataDir)).toHaveLength(1));
    expect(JSON.parse(savedRecommendations(dataDir)[0]!.structured_report_json).safety).toMatchObject({ level: 'high', banner: expect.stringContaining('Stop affected activities') });
    expect(JSON.parse(savedRecommendations(dataDir)[0]!.input_summary_json).imageCount).toBe(0);
  });
});
