import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiClientError, type AiConfig, type AiRequestOptions, type RecommendationResult } from '@fitness-coach/ai';
import { migrate, createRepositories } from '@fitness-coach/db';
import { buildApp } from './app.js';
import { createProfileScope } from './services/profileScope.js';
import type { ServiceContext } from './services/context.js';
import { createRecommendationJobService } from './services/recommendationJobs.js';
import { createProfileService } from './services/profile.js';

const generateRecommendation = vi.hoisted(() => vi.fn());
const createRecommendationModel = vi.hoisted(() => vi.fn((_config: AiConfig, options?: AiRequestOptions) => {
  options?.onProgress?.({ chunk: '{', receivedChars: 1 });
  return generateRecommendation;
}));

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

function setup() {
  const database = new Database(':memory:');
  migrate(database);
  const baseRepositories = createRepositories(database);
  const profile = baseRepositories.profiles.create({
    name: 'Runner profile', status: 'active', goal: 'maintain', goal_description: 'steady progress',
    height_cm: 175, age: 30, sex: 'unspecified', training_experience: 'beginner', equipment: 'home',
    training_days_per_week: 3, session_duration_minutes: 45, diet_preferences: 'balanced', allergies: 'none',
    health_restrictions: 'none',
  });
  baseRepositories.profiles.setCurrentId(profile.id);
  baseRepositories.forProfile(profile.id).dailyEntry.save({ entry_date: '2026-10-01', status: 'training' });
  const profileScope = createProfileScope(baseRepositories);
  const context: ServiceContext = {
    repositories: profileScope.repositories,
    baseRepositories,
    profileScope,
    dataDir: '/tmp/unused',
    database,
  } as ServiceContext & { baseRepositories: typeof baseRepositories };
  return { database, baseRepositories, profile, context };
}

function mockResult(): RecommendationResult {
  return {
    modelName: 'mock-model',
    report,
    markdown: '# Summary',
    inputSummary: {},
  };
}

describe('recommendation job service', () => {
  const databases: Database.Database[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const database of databases.splice(0)) database.close();
  });

  it('returns a queued job immediately and starts the mocked runner asynchronously', async () => {
    const { database, context } = setup();
    databases.push(database);
    const model = vi.fn().mockImplementation(async () => mockResult());
    const modelFactory = vi.fn((_config: AiConfig, options?: AiRequestOptions) => {
      options?.onProgress?.({ chunk: '{', receivedChars: 1 });
      return model;
    });
    const service = createRecommendationJobService(context, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'not-used' }),
      modelFactory,
    });

    const job = service.create({ start: '2026-10-01', end: '2026-10-01' });

    expect(job.status).toBe('queued');
    expect(job.job_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(context.profileScope?.baseRepositories.forProfile(job.profile_id).recommendationJob.get(job.job_id)?.status).toBe('queued');
    expect(service.get(job.job_id)?.status).toBe('queued');
    expect(model).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(1));
    expect(service.get(job.job_id)?.status).toBe('completed');
  });

  it('keeps the saved profile and data scope when the current profile changes while running', async () => {
    const { database, context, baseRepositories, profile } = setup();
    databases.push(database);
    const second = baseRepositories.profiles.create({
      name: 'Second profile', status: 'active', goal: 'fat_loss', goal_description: 'second', height_cm: 180, age: 31,
      sex: 'unspecified', training_experience: 'advanced', equipment: 'gym', training_days_per_week: 5,
      session_duration_minutes: 60, diet_preferences: 'high protein', allergies: 'none', health_restrictions: 'none',
    });
    baseRepositories.forProfile(second.id).dailyEntry.save({ entry_date: '2026-10-01', status: 'rest' });
    let release!: (result: RecommendationResult) => void;
    let modelInput: Record<string, unknown> | undefined;
    const service = createRecommendationJobService(context, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'not-used' }),
      modelFactory: (_config, options) => {
        options?.onProgress?.({ chunk: '{', receivedChars: 1 });
        return vi.fn(async (input) => {
          modelInput = input as Record<string, unknown>;
          return new Promise<RecommendationResult>((resolve) => { release = resolve; });
        });
      },
    });

    const job = service.create({ start: '2026-10-01', end: '2026-10-01' });
    await vi.waitFor(() => expect(service.get(job.job_id)?.status).toBe('receiving'));
    baseRepositories.profiles.setCurrentId(second.id);
    expect(service.get(job.job_id)).toBeUndefined();
    release(mockResult());
    await vi.waitFor(() => expect(service.getForProfile(profile.id, job.job_id)?.status).toBe('completed'));
    const sections = modelInput?.sections as { profile?: { id?: number }; structuredData?: { days?: Array<{ status?: string }> } };
    expect(sections.profile?.id).toBe(profile.id);
    expect(sections.structuredData?.days).toEqual([expect.objectContaining({ status: 'training' })]);
  });

  it('runs every model phase in order and passes the required abort/progress options', async () => {
    const { database, context } = setup();
    databases.push(database);
    let modelOptions: AiRequestOptions | undefined;
    let releaseModel!: (result: RecommendationResult) => void;
    const phases: string[] = [];
    const model = vi.fn(async () => new Promise<RecommendationResult>((resolve) => {
      releaseModel = resolve;
      modelOptions?.onProgress?.({ chunk: '{', receivedChars: 1 });
    }));
    const modelFactory = vi.fn((_config: AiConfig, options?: AiRequestOptions) => {
      modelOptions = options;
      return model;
    });
    const service = createRecommendationJobService(context, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'not-used' }),
      modelFactory,
      onPhase: (_jobId, phase) => phases.push(phase),
    });

    const job = service.create({ start: '2026-10-01', end: '2026-10-01' });
    await vi.waitFor(() => expect(service.get(job.job_id)?.status).toBe('receiving'));
    expect(modelOptions).toEqual(expect.objectContaining({ timeoutMs: 600_000, maxRetries: 0, stream: true }));
    expect(modelOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(modelOptions?.onProgress).toEqual(expect.any(Function));

    releaseModel(mockResult());
    await vi.waitFor(() => expect(service.get(job.job_id)?.status).toBe('completed'));
    expect(phases).toEqual(['preparing', 'sending', 'waiting_model', 'receiving', 'parsing', 'saving']);
  });

  it('saves exactly one completed recommendation linked to the job', async () => {
    const { database, context, baseRepositories, profile } = setup();
    databases.push(database);
    const model = vi.fn().mockResolvedValue(mockResult());
    const service = createRecommendationJobService(context, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'not-used' }),
      modelFactory: (_config, options) => {
        options?.onProgress?.({ chunk: '{', receivedChars: 1 });
        return model;
      },
    });

    const job = service.create({ start: '2026-10-01', end: '2026-10-01' });
    await vi.waitFor(() => expect(service.get(job.job_id)).toMatchObject({ status: 'completed', error_code: null }), { timeout: 1000 });
    const recommendations = baseRepositories.forProfile(profile.id).recommendation.list();
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]).toMatchObject({ job_id: job.job_id, profile_id: profile.id, status: 'completed' });
    expect(service.get(job.job_id)?.recommendation_id).toBe(recommendations[0]?.id);
  });

  it('enters the receiving phase before parsing when the model returns a non-SSE response', async () => {
    const { database, context, baseRepositories, profile } = setup();
    databases.push(database);
    const phases: string[] = [];
    const service = createRecommendationJobService(context, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'not-used' }),
      modelFactory: () => vi.fn().mockResolvedValue(mockResult()),
      onPhase: (_jobId, phase) => phases.push(phase),
    });

    const job = service.create({ start: '2026-10-01', end: '2026-10-01' });
    await vi.waitFor(() => expect(service.get(job.job_id)?.status).toBe('completed'));

    expect(phases).toEqual(['preparing', 'sending', 'waiting_model', 'receiving', 'parsing', 'saving']);
    expect(baseRepositories.forProfile(profile.id).recommendation.list()).toHaveLength(1);
  });

  it('marks model failures failed without saving a completed recommendation', async () => {
    const { database, context, baseRepositories, profile } = setup();
    databases.push(database);
    const service = createRecommendationJobService(context, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'secret-key' }),
      modelFactory: () => vi.fn().mockRejectedValue(new Error('secret response and base64 payload')),
    });

    const job = service.create({ start: '2026-10-01', end: '2026-10-01' });
    await vi.waitFor(() => expect(service.get(job.job_id)?.status).toBe('failed'));
    expect(service.get(job.job_id)).toMatchObject({ error_code: 'INTERNAL_ERROR', error_message: 'Recommendation generation failed' });
    expect(JSON.stringify(service.get(job.job_id))).not.toMatch(/secret|base64|response/);
    expect(baseRepositories.forProfile(profile.id).recommendation.list()).toHaveLength(0);
  });

  it('maps AI client failures to a safe code, phase, and request ID', async () => {
    const { database, context } = setup();
    databases.push(database);
    const service = createRecommendationJobService(context, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'secret-key' }),
      modelFactory: () => vi.fn().mockRejectedValue(new AiClientError('AI_TIMEOUT', 'upstream secret response')),
    });

    const job = service.create({ start: '2026-10-01', end: '2026-10-01' });
    await vi.waitFor(() => expect(service.get(job.job_id)?.status).toBe('failed'));
    expect(service.get(job.job_id)).toMatchObject({
      error_code: 'AI_TIMEOUT',
      error_message: 'Recommendation generation failed',
      error_phase: 'waiting_model',
      request_id: expect.stringMatching(/^req-[A-Za-z0-9]+$/),
    });
    expect(JSON.stringify(service.get(job.job_id))).not.toContain('upstream secret response');
  });

  it('reports streamed response parsing failures in the parsing phase', async () => {
    const { database, context } = setup();
    databases.push(database);
    const service = createRecommendationJobService(context, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'not-used' }),
      modelFactory: () => vi.fn().mockRejectedValue(new AiClientError('AI_INVALID_JSON', 'raw model response')),
    });

    const job = service.create({ start: '2026-10-01', end: '2026-10-01' });
    await vi.waitFor(() => expect(service.get(job.job_id)?.status).toBe('failed'));
    expect(service.get(job.job_id)).toMatchObject({ error_code: 'AI_INVALID_JSON', error_phase: 'parsing' });
  });

  it.each(['waiting_model', 'receiving'] as const)('cancels during %s with abort and no recommendation', async (cancelPhase) => {
    const { database, context, baseRepositories, profile } = setup();
    databases.push(database);
    let modelOptions: AiRequestOptions | undefined;
    let rejectModel!: (error: unknown) => void;
    const model = vi.fn(() => new Promise<RecommendationResult>((_resolve, reject) => {
      rejectModel = reject;
    }));
    const service = createRecommendationJobService(context, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'not-used' }),
      modelFactory: (_config, options) => {
        modelOptions = options;
        if (cancelPhase === 'receiving') queueMicrotask(() => options?.onProgress?.({ chunk: '{', receivedChars: 1 }));
        return model;
      },
    });

    const job = service.create({ start: '2026-10-01', end: '2026-10-01' });
    await vi.waitFor(() => expect(service.get(job.job_id)?.status).toBe(cancelPhase));
    expect(service.cancel(job.job_id).status).toBe('cancelled');
    expect(modelOptions?.signal?.aborted).toBe(true);
    rejectModel(new DOMException('cancelled', 'AbortError'));
    await vi.waitFor(() => expect(service.get(job.job_id)?.status).toBe('cancelled'));
    expect(baseRepositories.forProfile(profile.id).recommendation.list()).toHaveLength(0);
    expect(service.cancel(job.job_id).status).toBe('cancelled');
  });

  it.each(['queued', 'waiting_model', 'receiving'] as const)('cancels and fully joins a profile runner in %s before deletion can continue', async (phase) => {
    const { database, context, baseRepositories, profile } = setup();
    databases.push(database);
    let runnerExited = false;
    const modelFactory = vi.fn((_config: AiConfig, options?: AiRequestOptions) => {
      if (phase === 'receiving') options?.onProgress?.({ chunk: '{', receivedChars: 1 });
      return vi.fn(() => new Promise<RecommendationResult>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          queueMicrotask(() => {
            runnerExited = true;
            reject(new DOMException('cancelled', 'AbortError'));
          });
        }, { once: true });
      }));
    });
    const service = createRecommendationJobService(context, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'not-used' }),
      modelFactory,
    });

    const job = service.create({ start: '2026-10-01', end: '2026-10-01' });
    if (phase !== 'queued') await vi.waitFor(() => expect(service.get(job.job_id)?.status).toBe(phase));
    await service.cancelAndWaitForProfile(profile.id);

    if (phase === 'queued') {
      expect(modelFactory).not.toHaveBeenCalled();
    } else {
      expect(runnerExited).toBe(true);
    }
    expect(service.getForProfile(profile.id, job.job_id)?.status).toBe('cancelled');
    expect(baseRepositories.forProfile(profile.id).recommendation.list()).toEqual([]);
    service.finishProfileDeletion(profile.id);
  });

  it('does not finish profile deletion until an already-cancelled runner actually exits', async () => {
    const { database, context, baseRepositories } = setup();
    databases.push(database);
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-cancelled-runner-delete-'));
    await mkdir(join(dataDir, 'images'));
    const target = baseRepositories.profiles.create({
      name: 'Delayed cancelled runner', status: 'active', goal: 'maintain', goal_description: 'delete', height_cm: 180, age: 31,
      sex: 'unspecified', training_experience: 'beginner', equipment: 'home', training_days_per_week: 3,
      session_duration_minutes: 45, diet_preferences: 'balanced', allergies: 'none', health_restrictions: 'none',
    });
    let rejectRunner!: (error: unknown) => void;
    let modelSignal: AbortSignal | undefined;
    const service = createRecommendationJobService({ ...context, dataDir }, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'not-used' }),
      modelFactory: (_config, options) => {
        modelSignal = options?.signal;
        return vi.fn(() => new Promise<RecommendationResult>((_resolve, reject) => {
          rejectRunner = reject;
        }));
      },
    });
    const profiles = createProfileService({ ...context, dataDir, recommendationJobs: service });

    try {
      const job = service.createForProfile(target.id, { start: '2026-10-01', end: '2026-10-01' });
      await vi.waitFor(() => expect(service.getForProfile(target.id, job.job_id)?.status).toBe('waiting_model'));
      expect(service.cancelForProfile(target.id, job.job_id).status).toBe('cancelled');
      expect(modelSignal?.aborted).toBe(true);

      let deletionFinished = false;
      let cancellationStarted!: () => void;
      const cancellationReached = new Promise<void>((resolve) => { cancellationStarted = resolve; });
      const targetJobs = baseRepositories.forProfile(target.id).recommendationJob;
      const cancelActive = targetJobs.cancelActive.bind(targetJobs);
      vi.spyOn(targetJobs, 'cancelActive').mockImplementation(() => {
        const count = cancelActive();
        cancellationStarted();
        return count;
      });
      const originalForProfile = baseRepositories.forProfile.bind(baseRepositories);
      vi.spyOn(baseRepositories, 'forProfile').mockImplementation((profileId) => profileId === target.id
        ? { ...originalForProfile(profileId), recommendationJob: targetJobs }
        : originalForProfile(profileId));
      const deleteProfiles = vi.spyOn(baseRepositories.profiles, 'delete');
      const deleting = profiles.remove(target.id).then((result) => {
        deletionFinished = true;
        return result;
      });
      await cancellationReached;

      expect(deletionFinished).toBe(false);
      expect(deleteProfiles).not.toHaveBeenCalled();
      expect(baseRepositories.profiles.get(target.id)).toBeDefined();

      rejectRunner(new DOMException('upstream finally stopped', 'AbortError'));
      await expect(deleting).resolves.toMatchObject({ deleted: [target.id] });
      expect(baseRepositories.profiles.get(target.id)).toBeUndefined();
      expect(baseRepositories.forProfile(target.id).recommendation.list()).toEqual([]);

      await service.shutdown();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('validates every profile in a batch before cancelling any active runner', async () => {
    const { database, context, baseRepositories } = setup();
    databases.push(database);
    const target = baseRepositories.profiles.create({
      name: 'Valid batch target', status: 'active', goal: 'maintain', goal_description: 'keep running', height_cm: 180, age: 31,
      sex: 'unspecified', training_experience: 'beginner', equipment: 'home', training_days_per_week: 3,
      session_duration_minutes: 45, diet_preferences: 'balanced', allergies: 'none', health_restrictions: 'none',
    });
    let signal: AbortSignal | undefined;
    const service = createRecommendationJobService(context, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'not-used' }),
      modelFactory: (_config, options) => {
        signal = options?.signal;
        return vi.fn(() => new Promise<RecommendationResult>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
        }));
      },
    });
    const profiles = createProfileService({ ...context, recommendationJobs: service });
    const job = service.createForProfile(target.id, { start: '2026-10-01', end: '2026-10-01' });
    await vi.waitFor(() => expect(service.getForProfile(target.id, job.job_id)?.status).toBe('waiting_model'));

    await expect(profiles.remove([target.id, 999_999])).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(signal?.aborted).toBe(false);
    expect(service.getForProfile(target.id, job.job_id)?.status).toBe('waiting_model');
    expect(baseRepositories.profiles.get(target.id)).toBeDefined();
    await service.shutdown();
  });

  it('keeps a completed job stable when cancelled and creates a new ID on retry', async () => {
    const { database, context } = setup();
    databases.push(database);
    const service = createRecommendationJobService(context, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'not-used' }),
      modelFactory: (_config, options) => {
        options?.onProgress?.({ chunk: '{', receivedChars: 1 });
        return vi.fn().mockResolvedValue(mockResult());
      },
    });

    const first = service.create({ start: '2026-10-01', end: '2026-10-01' });
    await vi.waitFor(() => expect(service.get(first.job_id)?.status).toBe('completed'));
    expect(service.cancel(first.job_id).status).toBe('completed');
    const retried = service.retry(first.job_id);
    expect(retried.job_id).not.toBe(first.job_id);
    await vi.waitFor(() => expect(service.get(retried.job_id)?.status).toBe('completed'));
  });

  it('deduplicates an active range and rejects an archived current profile', async () => {
    const { database, context, baseRepositories, profile } = setup();
    databases.push(database);
    let release!: (result: RecommendationResult) => void;
    const modelFactory = vi.fn((_config: AiConfig, options?: AiRequestOptions) => {
      options?.onProgress?.({ chunk: '{', receivedChars: 1 });
      return vi.fn(() => new Promise<RecommendationResult>((resolve) => { release = resolve; }));
    });
    const service = createRecommendationJobService(context, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'not-used' }),
      modelFactory,
    });

    const first = service.create({ start: '2026-10-01', end: '2026-10-01' });
    const duplicate = service.create({ start: '2026-10-01', end: '2026-10-01' });
    expect(duplicate.job_id).toBe(first.job_id);
    baseRepositories.profiles.archive(profile.id);
    expect(() => service.create({ start: '2026-10-02', end: '2026-10-02' })).toThrowError(/archived/i);
    await vi.waitFor(() => expect(modelFactory).toHaveBeenCalledTimes(1));
    release(mockResult());
    await vi.waitFor(() => expect(service.get(first.job_id)).toMatchObject({ status: 'failed', error_code: 'PROFILE_ARCHIVED' }));
  });

  it('creates distinct active jobs when image policy or specified meals differ', async () => {
    const { database, context } = setup();
    databases.push(database);
    const service = createRecommendationJobService(context, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'not-used' }),
      modelFactory: () => vi.fn(() => new Promise<RecommendationResult>(() => undefined)),
    });

    const first = service.create({ start: '2026-10-01', end: '2026-10-01', explicitReview: false });
    const explicit = service.create({ start: '2026-10-01', end: '2026-10-01', explicitReview: true });

    expect(explicit.job_id).not.toBe(first.job_id);
    const currentProfileId = context.profileScope!.baseRepositories.profiles.currentId()!;
    const meal = context.profileScope!.baseRepositories.forProfile(currentProfileId).meal.save(
      context.profileScope!.baseRepositories.forProfile(currentProfileId).dailyEntry.getByDate('2026-10-01')!.id,
      { eaten_at: '2026-10-01T12:00:00Z', meal_type: 'lunch', recognition_status: 'unrecognized' },
    )!;
    const specified = service.create({ start: '2026-10-01', end: '2026-10-01', specifiedMealIds: [meal.id] });
    expect(specified.job_id).not.toBe(first.job_id);
  });

  it('reuses the same active job when specified meal IDs are submitted in a different order', async () => {
    const { database, context, baseRepositories, profile } = setup();
    databases.push(database);
    const scoped = baseRepositories.forProfile(profile.id);
    const entry = scoped.dailyEntry.getByDate('2026-10-01')!;
    const firstMeal = scoped.meal.save(entry.id, { eaten_at: '2026-10-01T12:00:00Z', meal_type: 'lunch', recognition_status: 'unrecognized' })!;
    const secondMeal = scoped.meal.save(entry.id, { eaten_at: '2026-10-01T18:00:00Z', meal_type: 'dinner', recognition_status: 'unrecognized' })!;
    const service = createRecommendationJobService(context, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'not-used' }),
      modelFactory: () => vi.fn(() => new Promise<RecommendationResult>(() => undefined)),
    });

    const first = service.create({ start: '2026-10-01', end: '2026-10-01', specifiedMealIds: [secondMeal.id, firstMeal.id] });
    const duplicate = service.create({ start: '2026-10-01', end: '2026-10-01', specifiedMealIds: [firstMeal.id, secondMeal.id] });

    expect(duplicate.job_id).toBe(first.job_id);
    expect(first.specified_meal_ids).toEqual([firstMeal.id, secondMeal.id]);
  });

  it('does not start a second runner when a concurrent create wins the active-range race', async () => {
    const { database, context, baseRepositories, profile } = setup();
    databases.push(database);
    const repository = baseRepositories.forProfile(profile.id).recommendationJob;
    const winner = repository.create({
      range_start: '2026-10-02', range_end: '2026-10-02', image_policy: { explicitReview: false },
      specified_meal_ids: [], specified_meal_payload: null,
    });
    const originalForProfile = baseRepositories.forProfile;
    vi.spyOn(baseRepositories, 'forProfile').mockImplementation((profileId) => {
      const scoped = originalForProfile(profileId);
      if (profileId !== profile.id) return scoped;
      return {
        ...scoped,
        recommendationJob: {
          ...repository,
          listActive: vi.fn().mockReturnValueOnce([]),
          createOrGet: vi.fn(() => ({ job: winner, created: false })),
        },
      };
    });
    const modelFactory = vi.fn(() => vi.fn(() => new Promise<RecommendationResult>(() => undefined)));
    const service = createRecommendationJobService(context, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'not-used' }),
      modelFactory,
    });

    const job = service.create({ start: '2026-10-02', end: '2026-10-02' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(job.job_id).toBe(winner.job_id);
    expect(modelFactory).not.toHaveBeenCalled();
  });

  it('fails an in-flight non-current profile job without saving after that profile is archived', async () => {
    const { database, context, baseRepositories } = setup();
    databases.push(database);
    const second = baseRepositories.profiles.create({
      name: 'Archived while running', status: 'active', goal: 'maintain', goal_description: 'second', height_cm: 180, age: 31,
      sex: 'unspecified', training_experience: 'beginner', equipment: 'home', training_days_per_week: 3,
      session_duration_minutes: 45, diet_preferences: 'balanced', allergies: 'none', health_restrictions: 'none',
    });
    let release!: (result: RecommendationResult) => void;
    const service = createRecommendationJobService(context, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'not-used' }),
      modelFactory: (_config, options) => {
        options?.onProgress?.({ chunk: '{', receivedChars: 1 });
        return vi.fn(() => new Promise<RecommendationResult>((resolve) => { release = resolve; }));
      },
    });

    const job = service.createForProfile(second.id, { start: '2026-10-01', end: '2026-10-01' });
    await vi.waitFor(() => expect(service.getForProfile(second.id, job.job_id)?.status).toBe('receiving'));
    expect(baseRepositories.profiles.archive(second.id)).toBeTruthy();
    release(mockResult());

    await vi.waitFor(() => expect(service.getForProfile(second.id, job.job_id)).toMatchObject({
      status: 'failed', error_code: 'PROFILE_ARCHIVED',
    }));
    expect(baseRepositories.forProfile(second.id).recommendation.list()).toHaveLength(0);
  });

  it('recovers unfinished jobs and exposes safe request IDs for failures', async () => {
    const { database, context, baseRepositories, profile } = setup();
    databases.push(database);
    const repository = baseRepositories.forProfile(profile.id).recommendationJob;
    const unfinished = repository.create({
      range_start: '2026-10-01', range_end: '2026-10-01', image_policy: { explicitReview: false },
      specified_meal_ids: [], specified_meal_payload: null, request_id: 'unsafe secret',
    });
    repository.updateStatus(unfinished.job_id, 'preparing');
    const service = createRecommendationJobService(context, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'secret-key' }),
      modelFactory: () => vi.fn().mockRejectedValue(new Error('api_key=secret-key full response')),
    });

    expect(service.recoverOnStartup()).toBe(1);
    expect(service.get(unfinished.job_id)).toMatchObject({ status: 'failed', error_code: 'SERVER_RESTARTED' });
    const job = service.create({ start: '2026-10-02', end: '2026-10-02' });
    await vi.waitFor(() => expect(service.get(job.job_id)?.status).toBe('failed'));
    expect(service.get(job.job_id)?.request_id).toMatch(/^req-[A-Za-z0-9]+$/);
    expect(JSON.stringify(service.get(job.job_id))).not.toMatch(/secret|api[_-]?key|base64|full response/i);
  });

  it('restricts profile-scoped job access to the requested profile', async () => {
    const { database, context, baseRepositories, profile } = setup();
    databases.push(database);
    const second = baseRepositories.profiles.create({
      name: 'Second profile', status: 'active', goal: 'maintain', goal_description: 'second', height_cm: 180, age: 31,
      sex: 'unspecified', training_experience: 'beginner', equipment: 'home', training_days_per_week: 3,
      session_duration_minutes: 45, diet_preferences: 'balanced', allergies: 'none', health_restrictions: 'none',
    });
    const service = createRecommendationJobService(context, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'not-used' }),
      modelFactory: (_config, options) => {
        options?.onProgress?.({ chunk: '{', receivedChars: 1 });
        return vi.fn().mockResolvedValue(mockResult());
      },
    });
    const job = service.create({ start: '2026-10-01', end: '2026-10-01' });
    await vi.waitFor(() => expect(service.get(job.job_id)?.status).toBe('completed'));

    expect(service.getForProfile(profile.id, job.job_id)?.job_id).toBe(job.job_id);
    expect(service.getForProfile(second.id, job.job_id)).toBeUndefined();
    expect(() => service.cancelForProfile(second.id, job.job_id)).toThrowError(/not found/i);
  });

  it('supports creating and retrying through an explicit profile scope', async () => {
    const { database, context, baseRepositories } = setup();
    databases.push(database);
    const second = baseRepositories.profiles.create({
      name: 'Second profile', status: 'active', goal: 'maintain', goal_description: 'second', height_cm: 180, age: 31,
      sex: 'unspecified', training_experience: 'beginner', equipment: 'home', training_days_per_week: 3,
      session_duration_minutes: 45, diet_preferences: 'balanced', allergies: 'none', health_restrictions: 'none',
    });
    const service = createRecommendationJobService(context, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'not-used' }),
      modelFactory: (_config, options) => {
        options?.onProgress?.({ chunk: '{', receivedChars: 1 });
        return vi.fn().mockRejectedValue(new Error('temporary failure'));
      },
    });

    const job = service.createForProfile(second.id, { start: '2026-10-01', end: '2026-10-01' });
    await vi.waitFor(() => expect(service.getForProfile(second.id, job.job_id)?.status).toBe('failed'));
    const retried = service.retryForProfile(second.id, job.job_id);
    expect(retried.job_id).not.toBe(job.job_id);
    await vi.waitFor(() => expect(service.getForProfile(second.id, retried.job_id)?.status).toBe('failed'));
  });

  it('returns a safe conflict when retrying after a specified meal was deleted', async () => {
    const { database, context, baseRepositories, profile } = setup();
    databases.push(database);
    const service = createRecommendationJobService(context, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'not-used' }),
      modelFactory: () => vi.fn().mockRejectedValue(new Error('temporary failure')),
    });
    const entry = baseRepositories.forProfile(profile.id).dailyEntry.getByDate('2026-10-01')!;
    const meal = baseRepositories.forProfile(profile.id).meal.save(entry.id, {
      eaten_at: '2026-10-01T12:00:00Z', meal_type: 'lunch', recognition_status: 'unrecognized',
    })!;
    const job = service.create({ start: '2026-10-01', end: '2026-10-01', specifiedMealIds: [meal.id] });
    await vi.waitFor(() => expect(service.get(job.job_id)?.status).toBe('failed'));
    baseRepositories.forProfile(profile.id).meal.delete(meal.id);

    try {
      service.retry(job.job_id);
      throw new Error('Expected retry to fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'CONFLICT', statusCode: 409 });
    }
  });

  it('does not save an incomplete model report', async () => {
    const { database, context, baseRepositories, profile } = setup();
    databases.push(database);
    const incomplete = { ...mockResult(), report: { summary: 'missing required sections' } } as RecommendationResult;
    const service = createRecommendationJobService(context, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'not-used' }),
      modelFactory: (_config, options) => {
        options?.onProgress?.({ chunk: '{', receivedChars: 1 });
        return vi.fn().mockResolvedValue(incomplete);
      },
    });

    const job = service.create({ start: '2026-10-01', end: '2026-10-01' });
    await vi.waitFor(() => expect(service.get(job.job_id)?.status).toBe('failed'));
    expect(service.get(job.job_id)).toMatchObject({ error_code: 'AI_INVALID_RESPONSE', error_phase: 'parsing' });
    expect(baseRepositories.forProfile(profile.id).recommendation.list()).toHaveLength(0);
  });

  it('can cancel immediately after enqueue before the runner begins', async () => {
    const { database, context, baseRepositories, profile } = setup();
    databases.push(database);
    let modelCalled = false;
    const service = createRecommendationJobService(context, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'not-used' }),
      modelFactory: () => {
        modelCalled = true;
        return vi.fn().mockResolvedValue(mockResult());
      },
    });
    const job = service.create({ start: '2026-10-01', end: '2026-10-01' });
    expect(service.cancel(job.job_id).status).toBe('cancelled');
    await service.shutdown();
    expect(modelCalled).toBe(false);
    expect(baseRepositories.forProfile(profile.id).recommendation.list()).toHaveLength(0);
  });

  it.each(['queued', 'waiting_model', 'receiving'] as const)('cancels and waits for all %s jobs before profile deletion', async (phase) => {
    const { database, context, baseRepositories } = setup();
    databases.push(database);
    const profile = baseRepositories.profiles.create({
      name: `Delete ${phase}`, status: 'active', goal: 'maintain', goal_description: 'delete', height_cm: 180, age: 31,
      sex: 'unspecified', training_experience: 'beginner', equipment: 'home', training_days_per_week: 3,
      session_duration_minutes: 45, diet_preferences: 'balanced', allergies: 'none', health_restrictions: 'none',
    });
    let rejectModel!: (error: unknown) => void;
    const service = createRecommendationJobService(context, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'not-used' }),
      modelFactory: (_config, options) => {
        if (phase === 'receiving') queueMicrotask(() => options?.onProgress?.({ chunk: '{', receivedChars: 1 }));
        return vi.fn(() => new Promise<RecommendationResult>((_resolve, reject) => {
          rejectModel = reject;
          options?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
        }));
      },
    });

    const job = service.createForProfile(profile.id, { start: `2026-10-${String(10 + ['queued', 'waiting_model', 'receiving'].indexOf(phase)).padStart(2, '0')}`, end: `2026-10-${String(10 + ['queued', 'waiting_model', 'receiving'].indexOf(phase)).padStart(2, '0')}` });
    if (phase !== 'queued') await vi.waitFor(() => expect(service.getForProfile(profile.id, job.job_id)?.status).toBe(phase));

    await service.cancelAndWaitForProfile(profile.id);

    expect(service.getForProfile(profile.id, job.job_id)?.status).toBe('cancelled');
    expect(baseRepositories.forProfile(profile.id).recommendation.list()).toHaveLength(0);
    if (phase === 'queued') expect(rejectModel).toBeUndefined();
  });

  it('aborts a queued runner when shutdown starts before its microtask', async () => {
    const { database, context } = setup();
    databases.push(database);
    let modelCalled = false;
    const service = createRecommendationJobService(context, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'not-used' }),
      modelFactory: () => {
        modelCalled = true;
        return vi.fn().mockResolvedValue(mockResult());
      },
    });
    const job = service.create({ start: '2026-10-01', end: '2026-10-01' });
    await service.shutdown();
    expect(modelCalled).toBe(false);
    expect(service.get(job.job_id)).toMatchObject({ status: 'failed', error_code: 'SERVER_RESTARTED' });
  });

  it('marks an active runner as server-restarted instead of cancelled during shutdown', async () => {
    const { database, context } = setup();
    databases.push(database);
    let rejectModel!: (error: unknown) => void;
    const service = createRecommendationJobService(context, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'not-used' }),
      modelFactory: (_config, options) => {
        options?.onProgress?.({ chunk: '{', receivedChars: 1 });
        return vi.fn(() => new Promise<RecommendationResult>((_resolve, reject) => { rejectModel = reject; }));
      },
    });
    const job = service.create({ start: '2026-10-01', end: '2026-10-01' });
    await vi.waitFor(() => expect(service.get(job.job_id)?.status).toBe('receiving'));

    const shutdown = service.shutdown();
    rejectModel(new DOMException('server stopping', 'AbortError'));
    await shutdown;

    expect(service.get(job.job_id)).toMatchObject({ status: 'failed', error_code: 'SERVER_RESTARTED', error_phase: 'server_restart' });
  });

  it('rejects retry while another active job already owns the same range', async () => {
    const { database, context } = setup();
    databases.push(database);
    const service = createRecommendationJobService(context, {
      getModelCredentials: async () => ({ baseUrl: 'https://model.example/v1', modelName: 'mock-model', apiKey: 'not-used' }),
      modelFactory: () => vi.fn(() => new Promise<RecommendationResult>(() => undefined)),
    });
    const first = service.create({ start: '2026-10-01', end: '2026-10-01' });
    expect(() => service.retry(first.job_id)).toThrowError(/active|conflict/i);
  });
});

describe('recommendation job API', () => {
  const directories: string[] = [];
  const apps: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    generateRecommendation.mockReset();
    createRecommendationModel.mockClear();
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function setup() {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-recommendation-jobs-'));
    const app = await buildApp({ dataDir });
    directories.push(dataDir);
    apps.push(app);
    const profileResponse = await app.inject({
      method: 'POST',
      url: '/api/profiles',
      payload: {
        name: 'Primary profile',
        ...profileInput,
      },
    });
    const profile = profileResponse.json().data as { id: number };
    await app.inject({
      method: 'PUT',
      url: '/api/settings/model',
      payload: { base_url: 'https://model.example/v1', model_name: 'mock-model', api_key: 'sk-secret' },
    });
    return { app, dataDir, profileId: profile.id };
  }

  it('creates an asynchronous job with a safe detail response and exposes progress through GET', async () => {
    generateRecommendation.mockResolvedValue(mockResult());
    const { app, profileId } = await setup();

    const created = await app.inject({
      method: 'POST',
      url: `/api/profiles/${profileId}/recommendation-jobs`,
      headers: { 'x-request-id': 'req-http-create' },
      payload: { start: '2026-10-01', end: '2026-10-01' },
    });

    expect(created.statusCode).toBe(202);
    expect(created.headers['x-request-id']).toBe('req-http-create');
    expect(created.json()).toMatchObject({ ok: true, data: {
      job_id: expect.any(String),
      profile_id: profileId,
      status: 'queued',
      phase_percent: expect.any(Number),
      received_chars: expect.any(Number),
      started_at: null,
      completed_at: null,
      error_code: null,
      error_message: null,
      recommendation_id: null,
    } });
    expect(created.body).not.toContain('sk-secret');
    expect(created.body).not.toMatch(/api[_-]?key|base64/i);

    const jobId = created.json().data.job_id as string;
    await vi.waitFor(async () => {
      const current = await app.inject({ method: 'GET', url: `/api/profiles/${profileId}/recommendation-jobs/${jobId}` });
      expect(current.statusCode).toBe(200);
      expect(current.json()).toMatchObject({ ok: true, data: {
        job_id: jobId,
        status: 'completed',
        recommendation_id: expect.any(Number),
        updated_at: expect.any(String),
        completed_at: expect.any(String),
      } });
    });
  });

  it('does not disclose a job through another profile scope for GET, cancel, or retry', async () => {
    generateRecommendation.mockResolvedValue(mockResult());
    const { app, profileId } = await setup();
    const secondProfile = await app.inject({
      method: 'POST',
      url: '/api/profiles',
      payload: { name: 'Second profile', ...profileInput },
    });
    const secondProfileId = secondProfile.json().data.id as number;
    const created = await app.inject({
      method: 'POST',
      url: `/api/profiles/${profileId}/recommendation-jobs`,
      payload: { start: '2026-10-01', end: '2026-10-01' },
    });
    const jobId = created.json().data.job_id as string;

    for (const method of ['GET', 'POST'] as const) {
      for (const action of ['', '/cancel', '/retry']) {
        if (method === 'GET' && action !== '') continue;
        const response = await app.inject({
          method,
          url: `/api/profiles/${secondProfileId}/recommendation-jobs/${jobId}${action}`,
        });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
        expect(response.body).not.toContain(jobId);
      }
    }

    const secondJobResponse = await app.inject({
      method: 'POST',
      url: `/api/profiles/${secondProfileId}/recommendation-jobs`,
      payload: { start: '2026-10-02', end: '2026-10-02' },
    });
    const secondJobId = secondJobResponse.json().data.job_id as string;
    await app.inject({ method: 'POST', url: `/api/profiles/${profileId}/archive` });
    const archivedCrossProfileCancel = await app.inject({
      method: 'POST',
      url: `/api/profiles/${profileId}/recommendation-jobs/${secondJobId}/cancel`,
    });
    expect(archivedCrossProfileCancel.statusCode).toBe(404);
    expect(archivedCrossProfileCancel.json()).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(archivedCrossProfileCancel.body).not.toContain(secondJobId);
  });

  it('returns NOT_FOUND when creating a job for an unknown profile', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/api/profiles/999/recommendation-jobs',
      payload: { start: '2026-10-01', end: '2026-10-01' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('rejects create and retry for archived profiles while allowing GET of an existing job', async () => {
    generateRecommendation.mockResolvedValue(mockResult());
    const { app, profileId } = await setup();
    const secondProfile = await app.inject({
      method: 'POST',
      url: '/api/profiles',
      payload: { name: 'Second profile', ...profileInput },
    });
    const secondProfileId = secondProfile.json().data.id as number;
    const created = await app.inject({
      method: 'POST',
      url: `/api/profiles/${profileId}/recommendation-jobs`,
      payload: { start: '2026-10-01', end: '2026-10-01' },
    });
    const jobId = created.json().data.job_id as string;
    await vi.waitFor(async () => {
      const current = await app.inject({ method: 'GET', url: `/api/profiles/${profileId}/recommendation-jobs/${jobId}` });
      expect(current.json().data.status).toBe('completed');
    });

    expect((await app.inject({ method: 'POST', url: `/api/profiles/${profileId}/archive` })).statusCode).toBe(200);

    const createArchived = await app.inject({
      method: 'POST',
      url: `/api/profiles/${profileId}/recommendation-jobs`,
      payload: { start: '2026-10-02', end: '2026-10-02' },
    });
    expect(createArchived.statusCode).toBe(409);
    expect(createArchived.json()).toMatchObject({ ok: false, error: { code: 'PROFILE_ARCHIVED' } });

    const getArchived = await app.inject({ method: 'GET', url: `/api/profiles/${profileId}/recommendation-jobs/${jobId}` });
    expect(getArchived.statusCode).toBe(200);
    expect(getArchived.json().data.job_id).toBe(jobId);

    const cancelArchived = await app.inject({ method: 'POST', url: `/api/profiles/${profileId}/recommendation-jobs/${jobId}/cancel` });
    expect(cancelArchived.statusCode).toBe(409);
    expect(cancelArchived.json()).toMatchObject({ ok: false, error: { code: 'PROFILE_ARCHIVED' } });

    const retryArchived = await app.inject({ method: 'POST', url: `/api/profiles/${profileId}/recommendation-jobs/${jobId}/retry` });
    expect(retryArchived.statusCode).toBe(409);
    expect(retryArchived.json()).toMatchObject({ ok: false, error: { code: 'PROFILE_ARCHIVED' } });
    expect(secondProfileId).not.toBe(profileId);
  });

  it('stores the request ID on a failed job without exposing model credentials or response data', async () => {
    generateRecommendation.mockRejectedValue(new Error('api_key=sk-secret full response base64 payload'));
    const { app, profileId } = await setup();
    const created = await app.inject({
      method: 'POST',
      url: `/api/profiles/${profileId}/recommendation-jobs`,
      headers: { 'x-request-id': 'req-http-failure' },
      payload: { start: '2026-10-04', end: '2026-10-04' },
    });
    const jobId = created.json().data.job_id as string;

    await vi.waitFor(async () => {
      const current = await app.inject({ method: 'GET', url: `/api/profiles/${profileId}/recommendation-jobs/${jobId}` });
      expect(current.json().data).toMatchObject({
        status: 'failed',
        request_id: 'req-http-failure',
        error_code: 'INTERNAL_ERROR',
        error_message: 'Recommendation generation failed',
      });
      expect(current.body).not.toMatch(/sk-secret|base64|full response|api[_-]?key/i);
    });
  });

  it('aborts an active runner before closing the database', async () => {
    let signal!: AbortSignal;
    let rejectModel!: (error: unknown) => void;
    createRecommendationModel.mockImplementationOnce((_config: AiConfig, options?: AiRequestOptions) => {
      signal = options?.signal as AbortSignal;
      options?.onProgress?.({ chunk: '{', receivedChars: 1 });
      return vi.fn(() => new Promise<RecommendationResult>((_resolve, reject) => {
        rejectModel = reject;
        signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
      }));
    });
    const { app, profileId } = await setup();
    const created = await app.inject({
      method: 'POST',
      url: `/api/profiles/${profileId}/recommendation-jobs`,
      payload: { start: '2026-10-05', end: '2026-10-05' },
    });
    const jobId = created.json().data.job_id as string;
    await vi.waitFor(async () => {
      const current = await app.inject({ method: 'GET', url: `/api/profiles/${profileId}/recommendation-jobs/${jobId}` });
      expect(current.json().data.status).toBe('receiving');
    });

    await app.close();
    rejectModel(new DOMException('cancelled', 'AbortError'));
    expect(signal.aborted).toBe(true);
  });

  it('coalesces repeated shutdown calls into one app close', async () => {
    vi.doMock('./app.js', () => ({
      buildApp: vi.fn().mockResolvedValue({ listen: vi.fn(), close: vi.fn(), log: { error: vi.fn() } }),
      getConfig: vi.fn(() => ({})),
    }));
    const module = await import('./index.js');
    const close = vi.fn().mockResolvedValue(undefined);
    const shutdown = module.createShutdownHandler({ close });

    await Promise.all([shutdown(), shutdown()]);

    expect(close).toHaveBeenCalledTimes(1);
    vi.doUnmock('./app.js');
  });

  it('keeps cancellation stable and retries with a new job ID while preserving the old record', async () => {
    generateRecommendation.mockResolvedValue(mockResult());
    const { app, profileId } = await setup();
    const created = await app.inject({
      method: 'POST',
      url: `/api/profiles/${profileId}/recommendation-jobs`,
      payload: { start: '2026-10-01', end: '2026-10-01' },
    });
    const jobId = created.json().data.job_id as string;
    await vi.waitFor(async () => {
      const current = await app.inject({ method: 'GET', url: `/api/profiles/${profileId}/recommendation-jobs/${jobId}` });
      expect(current.json().data.status).toBe('completed');
    });

    const firstCancel = await app.inject({ method: 'POST', url: `/api/profiles/${profileId}/recommendation-jobs/${jobId}/cancel` });
    const secondCancel = await app.inject({ method: 'POST', url: `/api/profiles/${profileId}/recommendation-jobs/${jobId}/cancel` });
    expect(firstCancel.statusCode).toBe(200);
    expect(secondCancel.statusCode).toBe(200);
    expect(firstCancel.json().data).toMatchObject({ job_id: jobId, status: 'completed' });
    expect(secondCancel.json().data).toMatchObject({ job_id: jobId, status: 'completed' });

    const retried = await app.inject({ method: 'POST', url: `/api/profiles/${profileId}/recommendation-jobs/${jobId}/retry` });
    expect(retried.statusCode).toBe(202);
    expect(retried.json().data.job_id).not.toBe(jobId);
    const old = await app.inject({ method: 'GET', url: `/api/profiles/${profileId}/recommendation-jobs/${jobId}` });
    expect(old.json().data.job_id).toBe(jobId);
  });

  it('marks unfinished jobs as server-restarted during app startup', async () => {
    const { app, dataDir, profileId } = await setup();
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    const database = new Database(join(dataDir, 'fitness-coach.sqlite'));
    migrate(database);
    const repositories = createRepositories(database);
    const repository = repositories.forProfile(profileId).recommendationJob;
    const unfinished = repository.create({
      range_start: '2026-10-03', range_end: '2026-10-03', image_policy: { explicitReview: false },
      specified_meal_ids: [], specified_meal_payload: null, request_id: 'req-before-restart',
    });
    repository.updateStatus(unfinished.job_id, 'receiving');
    database.close();

    const restarted = await buildApp({ dataDir });
    apps.push(restarted);
    const response = await restarted.inject({
      method: 'GET',
      url: `/api/profiles/${profileId}/recommendation-jobs/${unfinished.job_id}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ status: 'failed', error_code: 'SERVER_RESTARTED' });
  });
});

const profileInput = {
  goal: 'maintain', height_cm: 175, age: 30, sex: 'unspecified',
  goal_description: 'steady progress', training_experience: 'intermediate', equipment: 'home gym',
  training_days_per_week: 4, session_duration_minutes: 60, diet_preferences: 'balanced',
  allergies: 'none', health_restrictions: 'none',
};
