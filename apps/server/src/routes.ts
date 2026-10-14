import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { dateOnlySchema, imageUploadSchema, recordIdBodySchema, reportBulkDeleteSchema, reportExportQuerySchema } from '@fitness-coach/shared';
import { z } from 'zod';
import { ApiError, payloadTooLarge } from './errors.js';
import { createDailyEntriesService } from './services/dailyEntries.js';
import { createFeedbackService } from './services/feedback.js';
import { createFilesService } from './services/files.js';
import { createMealsService } from './services/meals.js';
import { createProfileService } from './services/profile.js';
import { createRecognitionService } from './services/recognition.js';
import { createRecommendationService } from './services/recommendation.js';
import { createSettingsService } from './services/settings.js';
import { createWeightsService } from './services/weights.js';
import { createWorkoutsService } from './services/workouts.js';
import { createBackupService } from './services/backup.js';
import { createProfileTransferService } from './services/profileTransfer.js';
import type { ServiceContext } from './services/context.js';
import { registerProfileTransferRoutes } from './routes/profileTransfer.js';
import { registerRecommendationJobRoutes } from './routes/recommendationJobs.js';

function success(reply: FastifyReply, data: unknown, statusCode = 200) {
  return reply.code(statusCode).send({ ok: true, data });
}

function body(request: FastifyRequest) {
  return request.body;
}

function params(request: FastifyRequest) {
  return request.params as Record<string, string>;
}

function query(request: FastifyRequest) {
  return request.query as Record<string, string | undefined>;
}

const localRecognitionSourceError = 'Meal recognition requests must come from a local origin';

const profileTimeFields = ['created_at', 'updated_at', 'last_entry_at', 'last_recommendation_at'] as const;
const profileQuerySchema = z.object({
  status: z.enum(['active', 'archived', 'all']).default('active'),
  timeField: z.enum(profileTimeFields).optional(),
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
  sort: z.enum(profileTimeFields).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
}).refine(({ from, to }) => from === undefined || to === undefined || from <= to, {
  message: 'from must not be after to',
});

function normalizedProfileQuery(input: Record<string, string | undefined>) {
  const values = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== ''));
  const parsed = profileQuerySchema.parse(values);
  if (parsed.sort !== undefined && parsed.sort !== parsed.timeField) {
    throw new ApiError('VALIDATION_ERROR', 'sort must match timeField');
  }
  if ((parsed.from !== undefined || parsed.to !== undefined) && parsed.timeField === undefined) {
    throw new ApiError('VALIDATION_ERROR', 'timeField is required for date filters');
  }
  return parsed;
}

function assertLocalRecognitionSource(request: FastifyRequest) {
  const source = request.headers.origin ?? request.headers.referer;
  if (!source) return;

  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new ApiError('FORBIDDEN', localRecognitionSourceError);
  }

  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) {
    throw new ApiError('FORBIDDEN', localRecognitionSourceError);
  }
}

export async function registerRoutes(app: FastifyInstance, context: ServiceContext) {
  const dailyEntries = createDailyEntriesService(context);
  const feedback = createFeedbackService(context);
  const files = createFilesService(context);
  const meals = createMealsService(context);
  const profile = createProfileService(context);
  const settings = createSettingsService(context);
  const recognition = createRecognitionService(context, { getModelCredentials: settings.getModelCredentials });
  const recommendations = createRecommendationService(context, { getModelCredentials: settings.getModelCredentials });
  const recommendationJobs = context.recommendationJobs;
  if (!recommendationJobs) throw new Error('Recommendation job service is not configured');
  const weights = createWeightsService(context);
  const workouts = createWorkoutsService(context);
  const backups = createBackupService(context);
  const profileTransfers = context.profileTransfers ?? createProfileTransferService(context);
  const profileScope = context.profileScope;
  await registerProfileTransferRoutes(app, {
    ...context,
    repositories: profileScope?.baseRepositories ?? context.repositories,
  }, profileTransfers);
  await registerRecommendationJobRoutes(app, recommendationJobs);

  app.get('/api/profile', async (_request, reply) => success(reply, profile.get()));
  app.put('/api/profile', async (request, reply) => success(reply, profile.upsert(body(request))));
  app.get('/api/profiles', async (request, reply) => success(reply, profile.list(normalizedProfileQuery(query(request)))));
  app.post('/api/profiles', async (request, reply) => success(reply, profile.create(body(request)), 201));
  app.get('/api/profiles/:id', async (request, reply) => success(reply, profile.getById(params(request).id)));
  app.patch('/api/profiles/:id', async (request, reply) => success(reply, profile.patch(params(request).id, body(request))));
  app.post('/api/profiles/:id/archive', async (request, reply) => success(reply, profile.archive(params(request).id)));
  app.post('/api/profiles/:id/restore', async (request, reply) => success(reply, profile.restore(params(request).id)));
  app.delete('/api/profiles/:id', async (request, reply) => success(reply, await profile.remove(params(request).id)));
  app.delete('/api/profiles', async (request, reply) => {
    const payload = body(request) as { ids?: unknown } | null;
    if (!payload || !Array.isArray(payload.ids)) throw new ApiError('VALIDATION_ERROR', 'Profile IDs are required');
    return success(reply, await profile.remove(payload.ids));
  });
  app.get('/api/current-profile', async (_request, reply) => success(reply, { profile: profileScope?.currentProfile() ?? null }));
  app.put('/api/current-profile', async (request, reply) => success(reply, {
    profile: profileScope
      ? await profileScope.runProfileMutation(async () => profileScope.setCurrentProfile((body(request) as { profileId?: unknown })?.profileId))
      : null,
  }));

  app.get('/api/settings/model', async (_request, reply) => success(reply, await settings.getModel()));
  app.put('/api/settings/model', async (request, reply) => success(reply, await settings.saveModel(body(request))));
  app.post('/api/settings/model/test', async (_request, reply) => success(reply, await settings.testConnection()));
  app.delete('/api/settings/model', async (_request, reply) => success(reply, await settings.clearModelKey()));

  app.post('/api/recommendations', async () => {
    throw new ApiError('CONFLICT', 'Synchronous recommendation generation is no longer supported; create a recommendation job instead');
  });
  app.post('/api/recommendations/preview', async (request, reply) => success(reply, recommendations.preview(body(request))));
  app.get('/api/recommendations', async (_request, reply) => success(reply, recommendations.list()));
  app.get('/api/recommendations/:id', async (request, reply) => success(reply, recommendations.get(params(request).id)));

  app.get('/api/profiles/:profileId/recommendations', async (request, reply) => {
    return success(reply, recommendations.listForProfile(params(request).profileId, query(request)));
  });
  app.get('/api/profiles/:profileId/recommendations/:id', async (request, reply) => success(reply, recommendations.getForProfile(params(request).profileId, params(request).id)));
  app.delete('/api/profiles/:profileId/recommendations/:id', async (request, reply) => success(reply, recommendations.deleteForProfile(params(request).profileId, params(request).id)));
  app.post('/api/profiles/:profileId/recommendations/bulk-delete', async (request, reply) => {
    const parsed = reportBulkDeleteSchema.parse(body(request));
    return success(reply, recommendations.bulkDeleteForProfile(params(request).profileId, parsed));
  });
  app.get('/api/profiles/:profileId/recommendations/:id/export', async (request, reply) => {
    const exported = recommendations.exportForProfile(params(request).profileId, params(request).id, reportExportQuerySchema.parse(query(request)));
    return reply.type(exported.contentType).header('content-disposition', `attachment; filename="${exported.filename}"`).send(exported.body);
  });


  app.get('/api/daily-entries', async (request, reply) => success(reply, dailyEntries.list(query(request))));
  app.get('/api/daily-entries/:date', async (request, reply) => success(reply, await dailyEntries.getByDate(params(request).date)));
  app.put('/api/daily-entries/:date', async (request, reply) => success(reply, dailyEntries.save(params(request).date, body(request))));

  app.post('/api/daily-entries/:date/weights', async (request, reply) => success(reply, weights.create(params(request).date, body(request)), 201));
  app.patch('/api/daily-entries/:date/weights', async (request, reply) => success(reply, weights.patch(params(request).date, body(request))));
  app.delete('/api/daily-entries/:date/weights', async (request, reply) => success(reply, weights.delete(params(request).date, body(request))));

  app.post('/api/daily-entries/:date/meals', async (request, reply) => success(reply, meals.create(params(request).date, body(request)), 201));
  app.patch('/api/daily-entries/:date/meals', async (request, reply) => success(reply, meals.patchForDate(params(request).date, body(request))));
  app.delete('/api/daily-entries/:date/meals', async (request, reply) => {
    const date = dateOnlySchema.parse(params(request).date);
    const { id } = recordIdBodySchema.parse(body(request));
    const entry = context.repositories.dailyEntry.getByDate(date);
    if (!entry) throw new ApiError('NOT_FOUND', 'Daily entry not found');
    return success(reply, await files.deleteMeal(id, entry.id));
  });
  app.patch('/api/meals/:id', async (request, reply) => success(reply, meals.patch(params(request).id, body(request))));
  app.delete('/api/meals/:id', async (request, reply) => success(reply, await files.deleteMeal(params(request).id)));
  app.post('/api/meals/recognize-batch', async (request, reply) => {
    assertLocalRecognitionSource(request);
    return success(reply, await recognition.recognizeBatch(body(request)));
  });
  app.post('/api/meals/:id/recognize', async (request, reply) => {
    assertLocalRecognitionSource(request);
    return success(reply, await recognition.recognize(params(request).id));
  });
  app.post('/api/meals/:id/confirm-food-items', async (request, reply) => success(reply, recognition.confirm(params(request).id, body(request))));

  app.post('/api/daily-entries/:date/workouts', async (request, reply) => success(reply, workouts.create(params(request).date, body(request)), 201));
  app.patch('/api/daily-entries/:date/workouts', async (request, reply) => success(reply, workouts.patchForDate(params(request).date, body(request))));
  app.delete('/api/daily-entries/:date/workouts', async (request, reply) => success(reply, workouts.deleteForDate(params(request).date, body(request))));
  app.post('/api/workouts/:id/exercises', async (request, reply) => success(reply, workouts.createExercise(params(request).id, body(request)), 201));
  app.patch('/api/workouts/:id/exercises', async (request, reply) => success(reply, workouts.patchExercise(params(request).id, body(request))));
  app.delete('/api/workouts/:id/exercises', async (request, reply) => success(reply, workouts.deleteExercise(params(request).id, body(request))));

  app.post('/api/daily-entries/:date/feedback', async (request, reply) => success(reply, feedback.create(params(request).date, body(request)), 201));
  app.patch('/api/daily-entries/:date/feedback', async (request, reply) => success(reply, feedback.patch(params(request).date, body(request))));
  app.delete('/api/daily-entries/:date/feedback', async (request, reply) => success(reply, feedback.delete(params(request).date, body(request))));

  app.post('/api/meals/:id/images', async (request, reply) => {
    const value = request.body as { bytes?: Uint8Array } | null;
    if ((value?.bytes?.length ?? 0) > 10 * 1024 * 1024) payloadTooLarge('Image is too large');
    const multipart = imageUploadSchema.parse({ ...value, file_size: value?.bytes?.length });
    const profileId = profileScope?.currentProfileId?.();
    if (profileId === undefined) throw new ApiError('CONFLICT', 'A current profile is required');
    return success(reply, await files.upload(params(request).id, multipart, profileId), 201);
  });
  app.get('/api/images/:id', async (request, reply) => {
    const { image, bytes } = await files.read(params(request).id);
    return reply.type(image.mime_type).send(bytes);
  });
  app.delete('/api/images/:id', async (request, reply) => success(reply, await files.delete(params(request).id)));
  app.post('/api/backups', async (_request, reply) => {
    const result = await backups.create();
    return success(reply, { filename: result.filename, size: result.size, manifest: result.manifest }, 201);
  });
  app.get('/api/backups', async (_request, reply) => success(reply, await backups.list()));
  app.get('/api/export/json', async (request, reply) => {
    const values = query(request);
    const includeImages = values.include_images === 'true' || values['include-images'] === 'true';
    const exported = await backups.exportJson(includeImages);
    return reply
      .type('application/json')
      .header('content-disposition', 'attachment; filename="fitness-coach-export.json"')
      .send(JSON.stringify(exported));
  });
}
