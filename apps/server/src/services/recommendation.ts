import { Buffer } from 'node:buffer';
import { AiClientError, createRecommendationModel, type AiRequestOptions, type RecommendationModel, type RecommendationResult } from '@fitness-coach/ai';
import { buildRecommendationContext, selectRecommendationImages } from '@fitness-coach/ai';
import {
  dateOnlySchema,
  idParamsSchema,
  recommendationSchema,
  recommendationMetadataSchema,
  type ProfileRecord,
  type RecommendationJob,
  reportBulkDeleteSchema,
  reportExportQuerySchema,
  reportListQuerySchema,
} from '@fitness-coach/shared';
import { z } from 'zod';
import { ApiError, notFound } from '../errors.js';
import type { ServiceContext } from './context.js';
import { createFilesService } from './files.js';
import { createAnalyticsService } from './analytics.js';
import { resolveDateRange } from './dateRange.js';

const requestSchema = z.object({
  start: dateOnlySchema.optional(),
  end: dateOnlySchema.optional(),
  explicitReview: z.boolean().optional().default(false),
  specifiedMealIds: z.array(z.number().int().positive()).optional().default([]),
}).strict();

const maxRecommendationImageBytes = 20 * 1024 * 1024;
const maxStructuredDays = 100;

function isStructuredReport(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  const trend = report.trend;
  const safety = report.safety;
  return typeof report.summary === 'string'
    && Boolean(trend && typeof trend === 'object' && !Array.isArray(trend)
      && Array.isArray((trend as Record<string, unknown>).observations))
    && Array.isArray(report.trainingPlan)
    && Array.isArray(report.dietAdvice)
    && Array.isArray(report.recovery)
    && Array.isArray(report.followUps)
    && Boolean(safety && typeof safety === 'object' && !Array.isArray(safety)
      && typeof (safety as Record<string, unknown>).level === 'string'
      && typeof (safety as Record<string, unknown>).banner === 'string')
    && Array.isArray(report.uncertainties);
}

type RecommendationDependencies = {
  getModelCredentials: () => Promise<{ baseUrl: string; modelName: string; apiKey: string }>;
  modelFactory?: typeof createRecommendationModel;
};

export type RecommendationGenerationPhase = 'sending' | 'waiting_model' | 'receiving' | 'parsing' | 'saving';

export type RecommendationGenerationOptions = {
  profile?: ProfileRecord;
  range?: { start: string; end: string };
  jobId?: string;
  signal?: AbortSignal;
  onPhase?: (phase: RecommendationGenerationPhase) => void;
  onProgress?: (progress: { chunk: string; receivedChars: number }) => void;
  maxImageBytes?: number;
  saveRecommendation?: (input: z.input<typeof recommendationSchema>) => (z.infer<typeof recommendationSchema> & { id: number }) | undefined;
};

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Recommendation generation was cancelled', 'AbortError');
}

export function createRecommendationService(
  context: ServiceContext,
  dependencies: RecommendationDependencies,
) {
  const { repositories } = context;
  const files = createFilesService(context);
  const analytics = createAnalyticsService(context);

  function requestDetails(input: unknown) {
    const request = requestSchema.parse(input ?? {});
    let range: ReturnType<typeof resolveDateRange>;
    try {
      range = resolveDateRange({ start: request.start, end: request.end });
    } catch (error) {
      throw new ApiError('VALIDATION_ERROR', (error as Error).message);
    }
    const profile = repositories.profile.get();
    if (!profile) throw new ApiError('CONFLICT', 'A profile is required before generating recommendations');
    const entries = repositories.dailyEntry.listRange(range.start, range.end);
    const feedback = entries.flatMap((entry) => repositories.feedback.listForEntry(entry.id));
    const symptomCounts = new Map<string, number>();
    for (const item of feedback.filter(({ category }) => category === 'pain' || category === 'discomfort')) {
      symptomCounts.set(item.category, (symptomCounts.get(item.category) ?? 0) + 1);
    }
    const highRisk = feedback.some((item) => item.severity >= 7)
      || [...symptomCounts.values()].some((count) => count > 1);
    const summary = analytics.summarize(range);
    const candidates = entries.flatMap((entry) => repositories.meal.listForEntry(entry.id).flatMap((meal) =>
      repositories.image.listForEntry(meal.id).map((image) => ({
        id: image.id,
        mealId: meal.id,
        createdAt: image.created_at ?? meal.eaten_at,
        fileSize: image.file_size,
        base64: '',
        isConfirmed: meal.recognition_status === 'confirmed',
        riskRelated: feedback.some((item) => item.category === 'pain' || item.severity >= 7),
        mimeType: image.mime_type,
      })),
    ));
    let imageCount = 0;
    try {
      imageCount = selectRecommendationImages({
        images: candidates,
        explicitReview: request.explicitReview,
        specifiedMealIds: request.specifiedMealIds,
        maxBytes: maxRecommendationImageBytes,
      }).length;
    } catch (error) {
      throw new ApiError('VALIDATION_ERROR', (error as Error).message);
    }
    return {
      request,
      range,
      summary,
      inputSummary: {
        recordCount: summary.recordCount,
        entryCount: summary.entryCount,
        workoutCount: summary.workoutCount,
        feedbackCount: summary.feedbackCount,
        mealCount: summary.meals.count,
        imageCount,
        highRisk,
      },
      highRisk,
    };
  }

  async function generate(input: unknown, options: RecommendationGenerationOptions = {}) {
    const request = requestSchema.parse(input ?? {});
    let range: ReturnType<typeof resolveDateRange>;
    try {
      range = options.range ?? resolveDateRange({ start: request.start, end: request.end });
    } catch (error) {
      throw new ApiError('VALIDATION_ERROR', (error as Error).message);
    }

    const profile = options.profile ?? repositories.profile.get();
    if (!profile) throw new ApiError('CONFLICT', 'A profile is required before generating recommendations');
    throwIfAborted(options.signal);

    const entries = repositories.dailyEntry.listRange(range.start, range.end);
    const dayData = entries.map((entry) => {
      const meals = repositories.meal.listForEntry(entry.id).map((meal) => ({
        ...meal,
        foodItems: repositories.foodItem.listForEntry(meal.id),
      }));
      return {
        ...entry,
        weights: repositories.weight.listForEntry(entry.id),
        workouts: repositories.workout.listForEntry(entry.id).map((workout) => ({
          ...workout,
          exercises: repositories.exercise.listForEntry(workout.id),
        })),
        meals,
        feedback: repositories.feedback.listForEntry(entry.id),
      };
    });
    const summary = analytics.summarize(range);
    const feedback = dayData.flatMap(({ feedback: items }) => items);
    const symptomCounts = new Map<string, number>();
    for (const item of feedback.filter(({ category }) => category === 'pain' || category === 'discomfort')) {
      symptomCounts.set(item.category, (symptomCounts.get(item.category) ?? 0) + 1);
    }
    const highRisk = feedback.some((item) => item.severity >= 7)
      || [...symptomCounts.values()].some((count) => count > 1);
    const feedbackByEntry = new Map(dayData.map((entry) => [entry.id, entry.feedback]));
    const candidates = dayData.flatMap((entry) => entry.meals.flatMap((meal) =>
      repositories.image.listForEntry(meal.id).map((image) => ({
        id: image.id,
        mealId: meal.id,
        createdAt: image.created_at ?? meal.eaten_at,
        fileSize: image.file_size,
        base64: '',
        isConfirmed: meal.recognition_status === 'confirmed',
        riskRelated: (feedbackByEntry.get(entry.id) ?? []).some((item) => item.category === 'pain' || item.severity >= 7),
        mimeType: image.mime_type,
      })),
    ));

    let selectedImages;
    try {
      selectedImages = selectRecommendationImages({
        images: candidates,
        explicitReview: request.explicitReview,
        specifiedMealIds: request.specifiedMealIds,
        maxBytes: options.maxImageBytes ?? maxRecommendationImageBytes,
      });
    } catch (error) {
      throw new ApiError('VALIDATION_ERROR', (error as Error).message);
    }

    let actualBytes = 0;
    const imageInputs = [];
    for (const image of selectedImages) {
      const local = await files.read(image.id);
      actualBytes += local.bytes.length;
      if (actualBytes > (options.maxImageBytes ?? maxRecommendationImageBytes)) {
        throw new ApiError('VALIDATION_ERROR', 'Selected recommendation images exceed the byte limit');
      }
      imageInputs.push({ ...image, base64: Buffer.from(local.bytes).toString('base64') });
    }

    const confirmedFood = dayData.flatMap(({ meals }) => meals.flatMap(({ foodItems }) =>
      foodItems.filter((item) => item.is_user_confirmed).map(({ name, amount, unit, cooking_method, notes }) => ({
        name, amount, unit, cookingMethod: cooking_method, notes,
      })),
    ));
    const estimatedFood = dayData.flatMap(({ meals }) => meals.flatMap(({ foodItems }) =>
      foodItems.filter((item) => !item.is_user_confirmed).map(({ name, amount, unit, confidence, notes }) => ({
        name, amount, unit, confidence, notes, estimated: true,
      })),
    ));
    const structuredData = {
      range,
      days: dayData.slice(0, maxStructuredDays),
      truncated: dayData.length > maxStructuredDays,
    };
    const context = buildRecommendationContext({
      profile,
      trends: { range: summary.weights, longTerm: analytics.longTermWeights() },
      structuredData,
      training: { count: summary.training.count, frequencyPerWeek: summary.training.frequencyPerWeek },
      feedback: { items: feedback, highRisk },
      status: summary.statusDistribution,
      confirmedFood,
      estimatedFood,
      images: imageInputs,
      explicitReview: request.explicitReview,
      specifiedMealIds: request.specifiedMealIds,
      maxBytes: options.maxImageBytes ?? maxRecommendationImageBytes,
    });
    const imageCount = context.images.length;
    const inputSummary = {
      recordCount: summary.recordCount,
      entryCount: summary.entryCount,
      workoutCount: summary.workoutCount,
      feedbackCount: summary.feedbackCount,
      mealCount: summary.meals.count,
      imageCount,
      highRisk,
    };
    const modelInput = {
      range,
      priority: context.priority,
      sections: {
        ...context.sections,
        safety: highRisk
          ? { level: 'high', banner: 'Serious or repeated symptoms were recorded. Stop affected activities and seek professional evaluation.' }
          : { level: 'low', banner: 'No high-risk symptoms were identified in the recorded feedback.' },
      },
      images: context.images,
      inputSummary,
    };

    let result: RecommendationResult;
    try {
      options.onPhase?.('sending');
      const credentials = await dependencies.getModelCredentials();
      const factory = dependencies.modelFactory ?? createRecommendationModel;
      const modelOptions: AiRequestOptions = { timeoutMs: 600_000, maxRetries: 0, stream: true };
      let receivedFirstChunk = false;
      if (options.signal) {
        modelOptions.signal = options.signal;
        modelOptions.onProgress = (progress) => {
          if (!receivedFirstChunk) {
            receivedFirstChunk = true;
            options.onPhase?.('receiving');
          }
          options.onProgress?.(progress);
        };
      }
      throwIfAborted(options.signal);
      options.onPhase?.('waiting_model');
      const model: RecommendationModel = factory(credentials, modelOptions);
      result = await model(modelInput);
      throwIfAborted(options.signal);
      if (options.signal && !receivedFirstChunk) options.onPhase?.('receiving');
      options.onPhase?.('parsing');
      if (!isStructuredReport(result.report)) {
        throw new ApiError('AI_INVALID_RESPONSE', 'Recommendation report was invalid');
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      if (error instanceof AiClientError) {
        if (error.code === 'AI_INVALID_JSON' || error.code === 'AI_INVALID_RESPONSE') {
          options.onPhase?.('receiving');
          options.onPhase?.('parsing');
        }
        throw new ApiError(error.code, 'Recommendation generation failed', error.code === 'AI_AUTHENTICATION_FAILED' ? 502 : 503);
      }
      throw new ApiError(options.jobId ? 'INTERNAL_ERROR' : 'AI_HTTP_ERROR', 'Recommendation generation failed', options.jobId ? 500 : 422);
    }

    const safety = highRisk
      ? { level: 'high', banner: 'Serious or repeated symptoms were recorded. Stop affected activities and seek professional evaluation.' }
      : result.report.safety;
    const report = { ...result.report, safety };
    const markdown = highRisk
      ? `> **Safety: High risk.** ${safety.banner}\n\n${result.markdown}`
      : result.markdown;
    const reportJson = JSON.stringify(report);
    throwIfAborted(options.signal);
    options.onPhase?.('saving');
    throwIfAborted(options.signal);
    const recommendationInput = recommendationSchema.parse({
      profile_id: profile.id,
      job_id: options.jobId ?? null,
      range_start: range.start,
      range_end: range.end,
       model_name: result.modelName,
       input_record_count: inputSummary.recordCount,
       image_review_count: inputSummary.imageCount,
       input_summary_json: JSON.stringify(inputSummary),
      report_markdown: markdown,
      structured_report_json: reportJson,
      status: 'completed',
    });
    const saved = options.saveRecommendation
      ? options.saveRecommendation(recommendationInput)
      : repositories.recommendation.save(recommendationInput);
    if (!saved) throw new ApiError('INTERNAL_ERROR', 'Unable to save recommendation');
    return {
      ...saved,
       inputSummary,
      report,
    };
  }

  function present(record: ReturnType<typeof repositories.recommendation.get>) {
    if (!record) return null;
    let report: unknown = null;
    try {
      const parsed = JSON.parse(record.structured_report_json) as unknown;
      report = isStructuredReport(parsed) ? parsed : null;
    } catch {
      report = null;
    }
    let inputSummary: unknown = null;
    try {
      inputSummary = JSON.parse(record.input_summary_json) as unknown;
    } catch {
      inputSummary = null;
    }
    const metadata = recommendationMetadataSchema.parse({
      job_id: record.job_id,
      input_record_count: record.input_record_count,
      image_review_count: record.image_review_count,
      error_code: record.error_code,
      error_message: record.error_message,
    });
    return { ...record, ...metadata, report, inputSummary };
  }

  function parseStored(record: ReturnType<typeof repositories.recommendation.get>) {
    const value = present(record);
    if (!value) return undefined;
    return value;
  }

  function hasHighRisk(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(hasHighRisk);
    for (const [key, nested] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase();
      if (['highrisk', 'high_risk', 'is_high_risk', 'risk'].includes(normalizedKey) && nested === true) return true;
      if (['level', 'risk', 'risklevel', 'risk_level'].includes(normalizedKey) && typeof nested === 'string' && ['high', 'critical'].includes(nested.toLowerCase())) return true;
      if (hasHighRisk(nested)) return true;
    }
    return false;
  }

  function reportRisk(record: ReturnType<typeof repositories.recommendation.get>) {
    const value = parseStored(record);
    return value ? hasHighRisk(value.inputSummary) || hasHighRisk(value.report) : false;
  }

  function imageReviewCount(record: ReturnType<typeof repositories.recommendation.get>) {
    if (!record) return 0;
    const stored = Number(record.image_review_count ?? 0);
    if (stored > 0) return stored;
    const value = parseStored(record);
    const legacy = value?.inputSummary;
    const legacyImageCount = legacy && typeof legacy === 'object' && !Array.isArray(legacy)
      ? (legacy as { imageCount?: unknown }).imageCount
      : undefined;
    return typeof legacyImageCount === 'number'
      ? legacyImageCount
      : 0;
  }

  function profileRepositories(profileIdInput: unknown, writable = false) {
    const profileId = idParamsSchema.parse({ id: profileIdInput }).id;
    const baseRepositories = context.profileScope?.baseRepositories ?? repositories;
    const profile = baseRepositories.profiles.get(profileId);
    if (!profile) notFound('Profile not found');
    if (writable && profile.status === 'archived') throw new ApiError('PROFILE_ARCHIVED', 'Archived profiles are read-only');
    return { profile, repositories: baseRepositories.forProfile(profileId) };
  }

  function listForProfile(profileIdInput: unknown, input: unknown) {
    const { profile, repositories: scoped } = profileRepositories(profileIdInput);
    const query = reportListQuerySchema.parse(input ?? {});
    const records = scoped.recommendation.list(query);
    const filtered = records.filter((record) => {
      if (query.risk !== undefined && reportRisk(record) !== query.risk) return false;
      if (query.hasImages !== undefined && (imageReviewCount(record) > 0) !== query.hasImages) return false;
      return true;
    });
    const start = (query.page - 1) * query.pageSize;
    return {
      items: filtered.slice(start, start + query.pageSize).map((record) => ({
        ...parseStored(record),
        profile: { id: profile.id, name: profile.name },
        image_review_count: imageReviewCount(record),
      })),
      page: query.page,
      pageSize: query.pageSize,
      total: filtered.length,
    };
  }

  function getForProfile(profileIdInput: unknown, idInput: unknown) {
    const { profile, repositories: scoped } = profileRepositories(profileIdInput);
    const { id } = idParamsSchema.parse({ id: idInput });
    const record = scoped.recommendation.get(id);
    if (!record) notFound('Recommendation not found');
    return {
      ...parseStored(record),
      profile: { id: profile.id, name: profile.name },
      image_review_count: imageReviewCount(record),
    };
  }

  function deleteForProfile(profileIdInput: unknown, idInput: unknown) {
    const { profile, repositories: scoped } = profileRepositories(profileIdInput, true);
    const { id } = idParamsSchema.parse({ id: idInput });
    const deleted = scoped.recommendation.delete(id);
    if (!deleted) notFound('Recommendation not found');
    return { id: deleted.id, profile: { id: profile.id, name: profile.name } };
  }

  function bulkDeleteForProfile(profileIdInput: unknown, input: unknown) {
    const { repositories: scoped } = profileRepositories(profileIdInput, true);
    const { ids } = reportBulkDeleteSchema.parse(input);
    const deleted = scoped.recommendation.deleteMany(ids);
    if (!deleted) notFound('Recommendation not found');
    return { deleted };
  }

  function exportForProfile(profileIdInput: unknown, idInput: unknown, input: unknown) {
    const value = getForProfile(profileIdInput, idInput);
    const { format } = reportExportQuerySchema.parse(input ?? {});
    if (format === 'markdown') {
      return {
        contentType: 'text/markdown; charset=utf-8',
        filename: `recommendation-${value.id}.md`,
        body: value.report_markdown,
      };
    }
    return {
      contentType: 'application/json; charset=utf-8',
      filename: `recommendation-${value.id}.json`,
      body: JSON.stringify(value),
    };
  }

  return {
    generate,
    preview(input: unknown) {
      const { range, inputSummary, highRisk, request } = requestDetails(input);
      return {
        range,
        inputSummary,
        imageCount: inputSummary.imageCount,
        highRisk,
        explicitReview: request.explicitReview,
        safety: highRisk
          ? { level: 'high', banner: '记录中存在高风险或反复不适，请在生成前确认是否停止相关动作并寻求专业评估。' }
          : { level: 'low', banner: '当前范围未发现高风险不适。' },
      };
    },
    list() {
      return repositories.recommendation.list().map((record) => present(record)!);
    },
    get(idInput: unknown) {
      const { id } = idParamsSchema.parse({ id: idInput });
      const record = present(repositories.recommendation.get(id));
      if (!record) notFound('Recommendation not found');
      return record;
    },
    listForProfile,
    getForProfile,
    deleteForProfile,
    bulkDeleteForProfile,
    exportForProfile,
    generateForJob(job: RecommendationJob, options: Pick<RecommendationGenerationOptions, 'signal' | 'onPhase' | 'onProgress'> = {}) {
      const jobRepositories = context.profileScope?.baseRepositories.forProfile(job.profile_id);
      if (!jobRepositories) throw new ApiError('INTERNAL_ERROR', 'Recommendation job scope is unavailable');
      return generate({
        start: job.range_start,
        end: job.range_end,
        explicitReview: job.image_policy.explicitReview,
        specifiedMealIds: job.specified_meal_ids,
      }, {
        ...options,
        profile: job.profile_snapshot,
        range: { start: job.range_start, end: job.range_end },
        jobId: job.job_id,
        maxImageBytes: job.image_policy.maxBytes,
        saveRecommendation(input) {
          let completed: ReturnType<typeof jobRepositories.recommendationJob.completeWithRecommendation>;
          try {
            completed = jobRepositories.recommendationJob.completeWithRecommendation(job.job_id, input);
          } catch (error) {
            const code = error instanceof Error && 'code' in error ? (error as Error & { code?: string }).code : undefined;
            if (code === 'PROFILE_ARCHIVED') throw new ApiError('PROFILE_ARCHIVED', 'Archived profiles are read-only');
            if (code === 'CONFLICT') throw new ApiError('CONFLICT', 'Recommendation does not belong to the job');
            throw error;
          }
          if (!completed?.recommendation_id) throw new ApiError('CONFLICT', 'Unable to complete recommendation job');
          const saved = jobRepositories.recommendation.get(completed.recommendation_id);
          if (!saved) throw new ApiError('INTERNAL_ERROR', 'Unable to read completed recommendation');
          return saved;
        },
      });
    },
  };
}
