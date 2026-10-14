import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  recommendationJobCreateInputSchema,
  recommendationJobSchema,
  recommendationJobStatusSchema,
  type RecommendationJobDetailResponse,
} from '@fitness-coach/shared';
import { migrate } from './migrate.js';
import { createRepositories } from './repositories.js';

describe('recommendation job repository', () => {
  function createProfile(repositories: ReturnType<typeof createRepositories>, name: string, status: 'active' | 'archived' = 'active') {
    return repositories.profiles.create({
      name, status, goal: 'maintain', goal_description: 'steady progress', height_cm: 175, age: 30, sex: 'unspecified',
      training_experience: 'beginner', equipment: 'home', training_days_per_week: 3,
      session_duration_minutes: 45, diet_preferences: 'balanced', allergies: 'none', health_restrictions: 'none',
    });
  }

  function setup() {
    const db = new Database(':memory:');
    migrate(db);
    const repositories = createRepositories(db);
    const first = createProfile(repositories, 'First');
    const second = createProfile(repositories, 'Second');
    const firstEntry = repositories.forProfile(first.id).dailyEntry.save({ entry_date: '2026-10-01', status: 'training' });
    const firstMeal = repositories.forProfile(first.id).meal.save(firstEntry!.id, {
      eaten_at: '2026-10-01T12:00:00Z', meal_type: 'lunch', recognition_status: 'unrecognized',
    });
    return { db, repositories, first, second, firstMeal: firstMeal! };
  }

  it('creates a queued job with an immutable safe profile and request snapshot', () => {
    const { db, repositories, first, firstMeal } = setup();
    try {
      const job = repositories.forProfile(first.id).recommendationJob.create({
        range_start: '2026-10-01',
        range_end: '2026-10-07',
        image_policy: { explicitReview: true, maxBytes: 20_000_000 },
        specified_meal_ids: [firstMeal.id],
        specified_meal_payload: { meals: [{ id: firstMeal.id, note: 'locked input' }] },
      });

      expect(job).toMatchObject({
        profile_id: first.id,
        range_start: '2026-10-01',
        range_end: '2026-10-07',
        status: 'queued',
        phase_percent: 5,
        received_chars: 0,
        started_at: null,
        completed_at: null,
        error_code: null,
        recommendation_id: null,
        image_policy: { explicitReview: true, maxBytes: 20_000_000 },
        specified_meal_ids: [firstMeal.id],
        specified_meal_payload: { meals: [{ id: firstMeal.id, note: 'locked input' }] },
        profile_snapshot: expect.objectContaining({ id: first.id, name: 'First', goal: 'maintain' }),
      });
      expect(job).not.toHaveProperty('api_key');
      expect(job).not.toHaveProperty('base_url');
      expect(job).not.toHaveProperty('model_name');
      expect(JSON.stringify(job)).not.toMatch(/api[_-]?key|base[_-]?url|model[_-]?name/i);

      repositories.profiles.update(first.id, { name: 'Changed after enqueue', goal: 'fat_loss' });
      expect(repositories.forProfile(first.id).recommendationJob.get(job.job_id)).toMatchObject({
        profile_snapshot: expect.objectContaining({ name: 'First', goal: 'maintain' }),
      });
      expect(db.prepare('SELECT profile_snapshot_json FROM recommendation_jobs WHERE job_id = ?').get(job.job_id)).toEqual({
        profile_snapshot_json: expect.any(String),
      });
    } finally {
      db.close();
    }
  });

  it('exposes reusable job shared types without model credentials', () => {
    const { db, repositories, first } = setup();
    try {
      const input = recommendationJobCreateInputSchema.parse({
        range_start: '2026-10-01', range_end: '2026-10-07', image_policy: { explicitReview: false },
        specified_meal_ids: [], specified_meal_payload: [{ note: 'safe payload' }],
      });
      const job = repositories.forProfile(first.id).recommendationJob.create(input);
      const response: RecommendationJobDetailResponse = { ok: true, data: job };
      expect(Object.values(recommendationJobStatusSchema.enum)).toEqual([
        'queued', 'preparing', 'sending', 'waiting_model', 'receiving', 'parsing', 'saving', 'completed', 'failed', 'cancelled',
      ]);
      expect('api_key' in recommendationJobSchema.shape).toBe(false);
      expect('base_url' in recommendationJobSchema.shape).toBe(false);
      expect('model_name' in recommendationJobSchema.shape).toBe(false);
      expect(JSON.stringify(response)).not.toMatch(/api[_-]?key|base[_-]?url|model[_-]?name/i);
      expect(() => recommendationJobCreateInputSchema.parse({ ...input, api_key: 'secret' })).toThrow();
      expect(() => recommendationJobCreateInputSchema.parse({ ...input, specified_meal_payload: { api_key: 'secret' } })).toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects job creation for archived profiles and isolates every job operation by profile', () => {
    const { db, repositories, first, second } = setup();
    try {
      const archived = createProfile(repositories, 'Archived', 'archived');
      expect(() => repositories.forProfile(archived.id).recommendationJob.create({
        range_start: '2026-10-01',
        range_end: '2026-10-07',
        image_policy: { explicitReview: false },
        specified_meal_ids: [],
        specified_meal_payload: null,
      })).toThrow(/active/i);

      const job = repositories.forProfile(first.id).recommendationJob.create({
        range_start: '2026-10-01', range_end: '2026-10-07',
        image_policy: { explicitReview: false }, specified_meal_ids: [], specified_meal_payload: null,
      });
      const otherJobs = repositories.forProfile(second.id).recommendationJob;
      expect(otherJobs.get(job.job_id)).toBeUndefined();
      expect(otherJobs.updateStatus(job.job_id, 'preparing')).toBeUndefined();
      expect(otherJobs.updateProgress(job.job_id, { phase_percent: 50, received_chars: 10 })).toBeUndefined();
      expect(otherJobs.complete(job.job_id, 99)).toBeUndefined();
      expect(otherJobs.fail(job.job_id, { error_code: 'NO_ACCESS', error_message: 'not yours', error_phase: 'preparing' })).toBeUndefined();
      expect(otherJobs.cancel(job.job_id)).toBeUndefined();
      expect(otherJobs.listActive()).toEqual([]);
      expect(repositories.forProfile(first.id).recommendationJob.get(job.job_id)).toMatchObject({ status: 'queued' });
    } finally {
      db.close();
    }
  });

  it('rejects specified meal IDs owned by another profile', () => {
    const { db, repositories, first, second } = setup();
    try {
      const otherEntry = repositories.forProfile(second.id).dailyEntry.save({ entry_date: '2026-10-01', status: 'training' });
      const otherMeal = repositories.forProfile(second.id).meal.save(otherEntry!.id, {
        eaten_at: '2026-10-01T12:00:00Z', meal_type: 'lunch', recognition_status: 'unrecognized',
      });
      expect(() => repositories.forProfile(first.id).recommendationJob.create({
        range_start: '2026-10-01', range_end: '2026-10-07', image_policy: { explicitReview: false },
        specified_meal_ids: [otherMeal!.id], specified_meal_payload: [{ id: otherMeal!.id }],
      })).toThrow(/profile/i);
      expect(db.prepare('SELECT COUNT(*) AS count FROM recommendation_jobs').get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('tracks progress and terminal completion, failure, and cancellation without cross-terminal mutation', () => {
    const { db, repositories, first } = setup();
    try {
      const jobs = repositories.forProfile(first.id).recommendationJob;
      const completed = jobs.create({ range_start: '2026-10-01', range_end: '2026-10-07', image_policy: { explicitReview: false }, specified_meal_ids: [], specified_meal_payload: null });
      const earlyRecommendation = repositories.forProfile(first.id).recommendation.save({
        range_start: '2026-10-01', range_end: '2026-10-07', model_name: 'mock', input_summary_json: '{}',
        report_markdown: '# Report', structured_report_json: '{}', status: 'completed',
      });
      expect(jobs.complete(completed.job_id, earlyRecommendation!.id)).toBeUndefined();
      expect(jobs.get(completed.job_id)).toMatchObject({ status: 'queued' });
      expect(jobs.updateStatus(completed.job_id, 'receiving')).toBeUndefined();
      expect(jobs.get(completed.job_id)).toMatchObject({ status: 'queued' });
      expect(jobs.updateStatus(completed.job_id, 'preparing')).toMatchObject({ status: 'preparing', started_at: expect.any(String), phase_percent: 15 });
      expect(jobs.updateProgress(completed.job_id, { phase_percent: 43, received_chars: 128 })).toMatchObject({ phase_percent: 43, received_chars: 128 });
      expect(jobs.updateProgress(completed.job_id, { phase_percent: 20, received_chars: 64 })).toBeUndefined();
      expect(jobs.get(completed.job_id)).toMatchObject({ phase_percent: 43, received_chars: 128 });
      expect(jobs.updateStatus(completed.job_id, 'sending')).toMatchObject({ status: 'sending', phase_percent: 43 });
      for (const status of ['waiting_model', 'receiving', 'parsing', 'saving'] as const) expect(jobs.updateStatus(completed.job_id, status)).toMatchObject({ status });
      expect(jobs.get(completed.job_id)).toMatchObject({ phase_percent: 98 });
      const recommendation = repositories.forProfile(first.id).recommendation.save({
        range_start: '2026-10-01', range_end: '2026-10-07', model_name: 'mock', input_summary_json: '{}',
        report_markdown: '# Report', structured_report_json: '{}', status: 'completed',
      });
      expect(jobs.complete(completed.job_id, recommendation!.id)).toMatchObject({ status: 'completed', phase_percent: 100, recommendation_id: recommendation!.id, completed_at: expect.any(String) });
      expect(jobs.cancel(completed.job_id)).toMatchObject({ status: 'completed', recommendation_id: recommendation!.id });

      const failed = jobs.create({ range_start: '2026-10-08', range_end: '2026-10-14', image_policy: { explicitReview: false }, specified_meal_ids: [], specified_meal_payload: null });
      expect(jobs.fail(failed.job_id, { error_code: 'MODEL_TIMEOUT', error_message: 'Model did not respond', error_phase: 'waiting_model', request_id: 'req-1' })).toMatchObject({
        status: 'failed', phase_percent: 5, error_code: 'MODEL_TIMEOUT', error_message: 'Model did not respond', error_phase: 'waiting_model', request_id: 'req-1', completed_at: expect.any(String),
      });

      const cancelled = jobs.create({ range_start: '2026-10-15', range_end: '2026-10-21', image_policy: { explicitReview: false }, specified_meal_ids: [], specified_meal_payload: null });
      expect(jobs.cancel(cancelled.job_id)).toMatchObject({ status: 'cancelled', completed_at: expect.any(String) });
      expect(jobs.cancel(cancelled.job_id)).toMatchObject({ status: 'cancelled' });
    } finally {
      db.close();
    }
  });

  it('does not complete a job with a recommendation owned by another profile', () => {
    const { db, repositories, first, second } = setup();
    try {
      const job = repositories.forProfile(first.id).recommendationJob.create({
        range_start: '2026-10-01', range_end: '2026-10-07', image_policy: { explicitReview: false }, specified_meal_ids: [], specified_meal_payload: null,
      });
      const recommendation = repositories.forProfile(second.id).recommendation.save({
        range_start: '2026-10-01', range_end: '2026-10-07', model_name: 'mock', input_summary_json: '{}',
        report_markdown: '# Report', structured_report_json: '{}', status: 'completed',
      });

      expect(repositories.forProfile(first.id).recommendationJob.complete(job.job_id, recommendation!.id)).toBeUndefined();
      expect(repositories.forProfile(first.id).recommendationJob.get(job.job_id)).toMatchObject({ status: 'queued', recommendation_id: null });
    } finally {
      db.close();
    }
  });

  it('uses a partial unique input index and rereads the existing exact active job after a constraint', () => {
    const { db, repositories, first } = setup();
    try {
      const jobs = repositories.forProfile(first.id).recommendationJob;
      const firstJob = jobs.create({
        range_start: '2026-12-01', range_end: '2026-12-07', image_policy: { explicitReview: false },
        specified_meal_ids: [], specified_meal_payload: null,
      });
       expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_recommendation_jobs_active_input'").get()).toEqual({ 1: 1 });
      expect(jobs.create({
        range_start: firstJob.range_start, range_end: firstJob.range_end, image_policy: { explicitReview: false },
        specified_meal_ids: [], specified_meal_payload: null,
      }).job_id).toBe(firstJob.job_id);
    } finally {
      db.close();
    }
  });

  it('replaces the legacy range-only active index during migration', () => {
    const { db, repositories, first } = setup();
    try {
      db.exec('DROP INDEX idx_recommendation_jobs_active_input');
      db.exec(`CREATE UNIQUE INDEX idx_recommendation_jobs_active_range
        ON recommendation_jobs(profile_id, range_start, range_end)
        WHERE status IN ('queued', 'preparing', 'sending', 'waiting_model', 'receiving', 'parsing', 'saving')`);

      migrate(db);

      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_recommendation_jobs_active_range'").get()).toBeUndefined();
      const jobs = repositories.forProfile(first.id).recommendationJob;
      const firstJob = jobs.create({ range_start: '2026-12-01', range_end: '2026-12-07', image_policy: { explicitReview: false }, specified_meal_ids: [], specified_meal_payload: null });
      const secondJob = jobs.create({ range_start: '2026-12-01', range_end: '2026-12-07', image_policy: { explicitReview: true }, specified_meal_ids: [], specified_meal_payload: null });
      expect(secondJob.job_id).not.toBe(firstJob.job_id);
    } finally {
      db.close();
    }
  });

  it('rolls back the recommendation when atomic job completion cannot update the job', () => {
    const { db, repositories, first } = setup();
    try {
      const jobs = repositories.forProfile(first.id).recommendationJob;
      const job = jobs.create({
        range_start: '2026-10-01', range_end: '2026-10-07', image_policy: { explicitReview: false },
        specified_meal_ids: [], specified_meal_payload: null,
      });
      for (const status of ['preparing', 'sending', 'waiting_model', 'receiving', 'parsing', 'saving'] as const) {
        expect(jobs.updateStatus(job.job_id, status)).toMatchObject({ status });
      }
      db.exec("CREATE TRIGGER reject_job_completion BEFORE UPDATE OF status ON recommendation_jobs WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'job completion rejected'); END");

      expect(() => jobs.completeWithRecommendation(job.job_id, {
        profile_id: first.id,
        job_id: job.job_id,
        range_start: job.range_start,
        range_end: job.range_end,
        model_name: 'mock',
        input_summary_json: '{}',
        report_markdown: '# Report',
        structured_report_json: '{}',
        status: 'completed',
      })).toThrow('job completion rejected');

      expect(jobs.get(job.job_id)).toMatchObject({ status: 'saving', recommendation_id: null });
      expect(repositories.forProfile(first.id).recommendation.list()).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('marks all unfinished phases as SERVER_RESTARTED and exposes a retry source snapshot', () => {
    const { db, repositories, first, firstMeal } = setup();
    try {
      const jobs = repositories.forProfile(first.id).recommendationJob;
      const queued = jobs.create({ range_start: '2026-10-01', range_end: '2026-10-07', image_policy: { explicitReview: true }, specified_meal_ids: [firstMeal.id], specified_meal_payload: { id: firstMeal.id }, request_id: 'req-queued' });
      const preparing = jobs.create({ range_start: '2026-10-08', range_end: '2026-10-14', image_policy: { explicitReview: false }, specified_meal_ids: [], specified_meal_payload: null });
      jobs.updateStatus(preparing.job_id, 'preparing');
      const sending = jobs.create({ range_start: '2026-10-15', range_end: '2026-10-21', image_policy: { explicitReview: false }, specified_meal_ids: [], specified_meal_payload: null });
      jobs.updateStatus(sending.job_id, 'preparing');
      jobs.updateStatus(sending.job_id, 'sending');
      const waiting = jobs.create({ range_start: '2026-10-22', range_end: '2026-10-28', image_policy: { explicitReview: false }, specified_meal_ids: [], specified_meal_payload: null });
      jobs.updateStatus(waiting.job_id, 'preparing');
      jobs.updateStatus(waiting.job_id, 'sending');
      jobs.updateStatus(waiting.job_id, 'waiting_model');
      const receiving = jobs.create({ range_start: '2026-10-29', range_end: '2026-11-04', image_policy: { explicitReview: false }, specified_meal_ids: [], specified_meal_payload: null });
      jobs.updateStatus(receiving.job_id, 'preparing');
      jobs.updateStatus(receiving.job_id, 'sending');
      jobs.updateStatus(receiving.job_id, 'waiting_model');
      jobs.updateStatus(receiving.job_id, 'receiving');
      const completed = jobs.create({ range_start: '2026-11-05', range_end: '2026-11-11', image_policy: { explicitReview: false }, specified_meal_ids: [], specified_meal_payload: null });
      jobs.updateStatus(completed.job_id, 'preparing');
      jobs.updateStatus(completed.job_id, 'sending');
      jobs.updateStatus(completed.job_id, 'waiting_model');
      jobs.updateStatus(completed.job_id, 'receiving');
      jobs.updateStatus(completed.job_id, 'parsing');
      jobs.updateStatus(completed.job_id, 'saving');
      const completedRecommendation = repositories.forProfile(first.id).recommendation.save({
        range_start: '2026-11-05', range_end: '2026-11-11', model_name: 'mock', input_summary_json: '{}',
        report_markdown: '# Report', structured_report_json: '{}', status: 'completed',
      });
      jobs.complete(completed.job_id, completedRecommendation!.id);

      expect(jobs.listActive().map(({ job_id }) => job_id)).toEqual(expect.arrayContaining([queued.job_id, preparing.job_id, sending.job_id, waiting.job_id, receiving.job_id]));
      expect(jobs.markUnfinishedFailed()).toBe(5);
      expect(jobs.listActive()).toEqual([]);
      for (const jobId of [queued.job_id, preparing.job_id, sending.job_id, waiting.job_id, receiving.job_id]) {
        expect(jobs.get(jobId)).toMatchObject({ status: 'failed', error_code: 'SERVER_RESTARTED', error_phase: 'server_restart' });
      }
      expect(jobs.get(completed.job_id)).toMatchObject({ status: 'completed', recommendation_id: completedRecommendation!.id });
      expect(jobs.retrySourceSnapshot(queued.job_id)).toEqual(expect.objectContaining({
        profile_snapshot: expect.objectContaining({ id: first.id }),
        range_start: '2026-10-01', range_end: '2026-10-07',
        image_policy: { explicitReview: true }, specified_meal_ids: [firstMeal.id], specified_meal_payload: { id: firstMeal.id },
      }));
    } finally {
      db.close();
    }
  });

  it('keeps the job table and existing records across repeated migration', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      const repositories = createRepositories(db);
      const profile = createProfile(repositories, 'Migrated');
      repositories.forProfile(profile.id).dailyEntry.save({ entry_date: '2026-10-01', status: 'rest' });
      migrate(db);
      expect(db.prepare('SELECT COUNT(*) AS count FROM daily_entries').get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recommendation_jobs'").get()).toEqual({ name: 'recommendation_jobs' });
      db.exec('DROP TABLE recommendation_jobs');
      migrate(db);
      expect(db.prepare('SELECT COUNT(*) AS count FROM daily_entries').get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recommendation_jobs'").get()).toEqual({ name: 'recommendation_jobs' });
    } finally {
      db.close();
    }
  });
});
