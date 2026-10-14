import { randomUUID } from 'node:crypto';
import {
  AiClientError,
  createRecommendationModel,
  type AiConfig,
  type AiRequestOptions,
  type RecommendationModel,
} from '@fitness-coach/ai';
import {
  recommendationJobRequestSchema,
  type RecommendationJob,
  type RecommendationJobStatus,
} from '@fitness-coach/shared';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import type { Repositories, ServiceContext } from './context.js';
import { createRecommendationService } from './recommendation.js';
import { resolveDateRange } from './dateRange.js';

type ModelFactory = (config: AiConfig, options?: AiRequestOptions) => RecommendationModel;

type RecommendationJobDependencies = {
  getModelCredentials: () => Promise<AiConfig>;
  modelFactory?: ModelFactory;
  onPhase?: (jobId: string, phase: RecommendationJobStatus) => void;
};

type JobRepository = ReturnType<Repositories['forProfile']>['recommendationJob'];

export type RecommendationJobService = ReturnType<typeof createRecommendationJobService>;

const activeStatuses = new Set<RecommendationJobStatus>([
  'queued', 'preparing', 'sending', 'waiting_model', 'receiving', 'parsing', 'saving',
]);
const cancellableStatuses = new Set<RecommendationJobStatus>([
  'queued', 'preparing', 'sending', 'waiting_model', 'receiving',
]);
const safeErrorCodes = new Set<string>([
  'VALIDATION_ERROR', 'NOT_FOUND', 'CONFLICT', 'FORBIDDEN', 'PROFILE_ARCHIVED', 'CONFIGURATION_ERROR',
  'INTERNAL_ERROR', 'AI_TIMEOUT', 'AI_AUTHENTICATION_FAILED', 'AI_NETWORK_ERROR', 'AI_INVALID_JSON',
  'AI_INVALID_RESPONSE', 'AI_INVALID_INPUT', 'AI_HTTP_ERROR',
]);

function requestId(value: string | null | undefined) {
  return value && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
    ? value
    : `req-${randomUUID().replaceAll('-', '')}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
    || error instanceof Error && error.name === 'AbortError';
}

function errorCode(error: unknown): string {
  if (error instanceof ApiError) return error.code;
  if (error instanceof AiClientError) return error.code;
  return 'INTERNAL_ERROR';
}

function safeErrorMessage(error: unknown) {
  if (error instanceof ApiError && error.code === 'VALIDATION_ERROR') return error.message;
  if (error instanceof ApiError && error.code === 'PROFILE_ARCHIVED') return 'Archived profiles are read-only';
  if (error instanceof AiClientError) return 'Recommendation generation failed';
  if (isAbortError(error)) return 'Recommendation generation was cancelled';
  return 'Recommendation generation failed';
}

function activeJobMatches(job: RecommendationJob, input: {
  range: { start: string; end: string };
  imagePolicy: RecommendationJob['image_policy'];
  specifiedMealIds: number[];
}) {
  return activeStatuses.has(job.status)
    && job.range_start === input.range.start
    && job.range_end === input.range.end
    && JSON.stringify(job.image_policy) === JSON.stringify(input.imagePolicy)
    && JSON.stringify([...job.specified_meal_ids].sort((left, right) => left - right)) === JSON.stringify(input.specifiedMealIds);
}

export function createRecommendationJobService(context: ServiceContext, dependencies: RecommendationJobDependencies) {
  const baseRepositories = context.profileScope?.baseRepositories ?? context.repositories;
  const controllers = new Map<string, AbortController>();
  const runners = new Map<string, Promise<void>>();
  const runnerProfiles = new Map<string, number>();
  const stoppingProfiles = new Set<number>();
  let stopping = false;

  function currentProfile() {
    const profileId = context.profileScope?.currentProfileId?.() ?? baseRepositories.profiles.currentId();
    if (profileId === undefined) throw new ApiError('CONFLICT', 'A current profile is required before generating recommendations');
    const profile = baseRepositories.profiles.get(profileId);
    if (!profile) throw new ApiError('CONFLICT', 'A current profile is required before generating recommendations');
    if (profile.status === 'archived') throw new ApiError('PROFILE_ARCHIVED', 'Archived profiles are read-only');
    return profile;
  }

  function repositoryFor(job: RecommendationJob): JobRepository {
    return baseRepositories.forProfile(job.profile_id).recommendationJob;
  }

  function repositoriesForProfile(profileId: number): Repositories {
    const scoped = baseRepositories.forProfile(profileId);
    const scopedNames = new Set([
      'profile', 'dailyEntry', 'weight', 'meal', 'image', 'foodItem', 'workout', 'exercise', 'feedback',
      'recommendation', 'recommendationJob',
    ]);
    return new Proxy(baseRepositories, {
      get(target, property, receiver) {
        if (typeof property === 'string' && scopedNames.has(property)) {
          return scoped[property as keyof typeof scoped];
        }
        return Reflect.get(target, property, receiver);
      },
    });
  }

  function findJob(jobId: string) {
    for (const profile of baseRepositories.profiles.list()) {
      const job = baseRepositories.forProfile(profile.id).recommendationJob.get(jobId);
      if (job) return { job, repository: baseRepositories.forProfile(profile.id).recommendationJob };
    }
    return undefined;
  }

  function setPhase(repository: JobRepository, jobId: string, phase: RecommendationJobStatus) {
    const updated = repository.updateStatus(jobId, phase);
    if (!updated && repository.get(jobId)?.status !== phase) throw new Error(`Unable to enter recommendation phase ${phase}`);
    dependencies.onPhase?.(jobId, phase);
  }

  function failForServerRestart(repository: JobRepository, jobId: string) {
    repository.fail(jobId, {
      error_code: 'SERVER_RESTARTED',
      error_message: 'The server restarted before the recommendation job finished',
      error_phase: 'server_restart',
    });
  }

  async function run(job: RecommendationJob, repository: JobRepository) {
    const controller = new AbortController();
    controllers.set(job.job_id, controller);
    let phase: RecommendationJobStatus = 'queued';
    const requestIdValue = requestId(job.request_id);
    try {
      if (repository.get(job.job_id)?.status === 'cancelled') {
        repository.cancel(job.job_id);
        return;
      }
      if (stopping) {
        failForServerRestart(repository, job.job_id);
        return;
      }
      setPhase(repository, job.job_id, 'preparing');
      phase = 'preparing';
      const fixedContext: ServiceContext = {
        ...context,
        repositories: repositoriesForProfile(job.profile_id),
      };
      const recommendations = createRecommendationService(fixedContext, {
        getModelCredentials: dependencies.getModelCredentials,
        modelFactory: dependencies.modelFactory ?? createRecommendationModel,
      });
      const result = await recommendations.generateForJob(job, {
        signal: controller.signal,
        onPhase(nextPhase) {
          phase = nextPhase;
          setPhase(repository, job.job_id, nextPhase);
        },
        onProgress(progress) {
          if (repository.get(job.job_id)?.status !== 'receiving') {
            setPhase(repository, job.job_id, 'receiving');
            phase = 'receiving';
          }
          repository.updateProgress(job.job_id, { received_chars: progress.receivedChars, phase_percent: 80 });
        },
      });
      if (repository.get(job.job_id)?.status !== 'completed') {
        if (repository.get(job.job_id)?.status === 'cancelled') return;
        throw new Error('Unable to complete recommendation job');
      }
    } catch (error) {
      const current = repository.get(job.job_id);
      if (current?.status === 'cancelled') {
        repository.cancel(job.job_id);
        return;
      }
      if (stopping) {
        if (current && activeStatuses.has(current.status)) failForServerRestart(repository, job.job_id);
        return;
      }
      if (isAbortError(error)) {
        repository.cancel(job.job_id);
        return;
      }
      if (current && activeStatuses.has(current.status)) {
        const code = errorCode(error);
        repository.fail(job.job_id, {
          error_code: safeErrorCodes.has(code) ? code : 'INTERNAL_ERROR',
          error_message: safeErrorMessage(error),
          error_phase: phase,
          request_id: requestIdValue,
        });
      }
    } finally {
      controllers.delete(job.job_id);
      runners.delete(job.job_id);
      runnerProfiles.delete(job.job_id);
    }
  }

  function start(job: RecommendationJob, repository: JobRepository) {
    const runner = new Promise<void>((resolve) => {
      queueMicrotask(() => {
        void run(job, repository).then(resolve, resolve);
      });
    });
    runners.set(job.job_id, runner);
    runnerProfiles.set(job.job_id, job.profile_id);
  }

  function create(input: unknown) {
    const profile = currentProfile();
    return createForProfile(profile.id, input);
  }

  function createForProfile(profileIdInput: unknown, input: unknown, requestIdInput?: string | null) {
    const profileId = z.coerce.number().int().positive().parse(profileIdInput);
    if (stoppingProfiles.has(profileId)) throw new ApiError('CONFLICT', 'Profile is being deleted');
    const profile = baseRepositories.profiles.get(profileId);
    if (!profile) throw new ApiError('NOT_FOUND', 'Profile not found');
    if (profile.status === 'archived') throw new ApiError('PROFILE_ARCHIVED', 'Archived profiles are read-only');
    const request = recommendationJobRequestSchema.parse(input ?? {});
    let range: { start: string; end: string };
    try {
      range = resolveDateRange({ start: request.start, end: request.end });
    } catch (error) {
      throw new ApiError('VALIDATION_ERROR', (error as Error).message);
    }
    const repository = baseRepositories.forProfile(profile.id).recommendationJob;
    const imagePolicy = { explicitReview: request.explicitReview, maxBytes: 20 * 1024 * 1024 };
    const specifiedMealIds = [...request.specifiedMealIds].sort((left, right) => left - right);
    const existing = repository.listActive().find((job) => activeJobMatches(job, { range, imagePolicy, specifiedMealIds }));
    if (existing) return existing;
    const { job, created } = repository.createOrGet({
      range_start: range.start,
      range_end: range.end,
      image_policy: imagePolicy,
      specified_meal_ids: specifiedMealIds,
      specified_meal_payload: null,
      request_id: requestId(requestIdInput),
    });
    if (created) start(job, repository);
    return job;
  }

  function get(jobIdInput: unknown) {
    const jobId = z.string().min(1).parse(jobIdInput);
    const found = findJob(jobId);
    const currentProfileId = context.profileScope?.currentProfileId?.() ?? baseRepositories.profiles.currentId();
    if (!found || found.job.profile_id !== currentProfileId) return undefined;
    return found.job;
  }

  function getForProfile(profileIdInput: unknown, jobIdInput: unknown) {
    const profileId = z.coerce.number().int().positive().parse(profileIdInput);
    const jobId = z.string().min(1).parse(jobIdInput);
    return baseRepositories.forProfile(profileId).recommendationJob.get(jobId);
  }

  function cancel(jobIdInput: unknown) {
    const job = get(jobIdInput);
    if (!job) throw new ApiError('NOT_FOUND', 'Recommendation job not found');
    const repository = repositoryFor(job);
    if (cancellableStatuses.has(job.status)) controllers.get(job.job_id)?.abort();
    return repository.cancel(job.job_id)!;
  }

  function cancelForProfile(profileIdInput: unknown, jobIdInput: unknown) {
    const profileId = z.coerce.number().int().positive().parse(profileIdInput);
    const jobId = z.string().min(1).parse(jobIdInput);
    const repository = baseRepositories.forProfile(profileId).recommendationJob;
    const job = repository.get(jobId);
    if (!job) throw new ApiError('NOT_FOUND', 'Recommendation job not found');
    const profile = baseRepositories.profiles.get(profileId);
    if (profile?.status === 'archived') throw new ApiError('PROFILE_ARCHIVED', 'Archived profiles are read-only');
    if (cancellableStatuses.has(job.status)) controllers.get(job.job_id)?.abort();
    return repository.cancel(job.job_id)!;
  }

  function retry(jobIdInput: unknown) {
    const job = get(jobIdInput);
    if (!job) throw new ApiError('NOT_FOUND', 'Recommendation job not found');
    const profile = baseRepositories.profiles.get(job.profile_id);
    if (!profile || profile.status === 'archived') throw new ApiError('PROFILE_ARCHIVED', 'Archived profiles are read-only');
    const repository = repositoryFor(job);
    return retryJob(job, repository);
  }

  function retryJob(job: RecommendationJob, repository: JobRepository, requestIdInput?: string | null) {
    if (stoppingProfiles.has(job.profile_id)) throw new ApiError('CONFLICT', 'Profile is being deleted');
    const profile = baseRepositories.profiles.get(job.profile_id);
    if (!profile || profile.status === 'archived') throw new ApiError('PROFILE_ARCHIVED', 'Archived profiles are read-only');
    const snapshot = repository.retrySourceSnapshot(job.job_id);
    if (!snapshot) throw new ApiError('NOT_FOUND', 'Recommendation job not found');
    const existing = repository.listActive().find((active) => active.range_start === snapshot.range_start && active.range_end === snapshot.range_end);
    if (existing) throw new ApiError('CONFLICT', 'An active recommendation job already exists for this range');
    let next: RecommendationJob;
    let created = false;
    try {
      const result = repository.createOrGet({
        range_start: snapshot.range_start,
        range_end: snapshot.range_end,
        image_policy: snapshot.image_policy,
        specified_meal_ids: snapshot.specified_meal_ids,
        specified_meal_payload: snapshot.specified_meal_payload,
        request_id: requestId(requestIdInput),
      });
      next = result.job;
      created = result.created;
    } catch (error) {
      if (error instanceof Error && /specified meals must belong to the profile/i.test(error.message)) {
        throw new ApiError('CONFLICT', 'A specified meal is no longer available for this profile');
      }
      throw error;
    }
    if (created) start(next, repository);
    return next;
  }

  function retryForProfile(profileIdInput: unknown, jobIdInput: unknown, requestIdInput?: string | null) {
    const profileId = z.coerce.number().int().positive().parse(profileIdInput);
    const jobId = z.string().min(1).parse(jobIdInput);
    const repository = baseRepositories.forProfile(profileId).recommendationJob;
    const job = repository.get(jobId);
    if (!job) throw new ApiError('NOT_FOUND', 'Recommendation job not found');
    return retryJob(job, repository, requestIdInput);
  }

  function recoverOnStartup() {
    let count = 0;
    for (const profile of baseRepositories.profiles.list()) {
      count += baseRepositories.forProfile(profile.id).recommendationJob.markUnfinishedFailed();
    }
    return count;
  }

  async function shutdown() {
    stopping = true;
    for (const controller of controllers.values()) controller.abort();
    await Promise.allSettled(runners.values());
  }

  async function cancelAndWaitForProfile(profileIdInput: unknown) {
    const profileId = z.coerce.number().int().positive().parse(profileIdInput);
    stoppingProfiles.add(profileId);
    const repository = baseRepositories.forProfile(profileId).recommendationJob;
    try {
      const jobs = repository.listActive();
      repository.cancelActive();
      const profileRunners = [...runnerProfiles.entries()]
        .filter(([, runnerProfileId]) => runnerProfileId === profileId)
        .map(([jobId]) => ({ jobId, runner: runners.get(jobId) }))
        .filter((entry): entry is { jobId: string; runner: Promise<void> } => entry.runner !== undefined);
      for (const { jobId } of profileRunners) {
        controllers.get(jobId)?.abort();
      }
      await Promise.allSettled(profileRunners.map(({ runner }) => runner));
      return jobs;
    } catch (error) {
      stoppingProfiles.delete(profileId);
      throw error;
    }
  }

  function finishProfileDeletion(profileIdInput: unknown) {
    const profileId = z.coerce.number().int().positive().parse(profileIdInput);
    stoppingProfiles.delete(profileId);
  }

  return { create, createForProfile, get, getForProfile, cancel, cancelForProfile, cancelAndWaitForProfile, finishProfileDeletion, retry, retryForProfile, recoverOnStartup, markUnfinishedFailed: recoverOnStartup, shutdown, abortAll: shutdown };
}
