import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';
import type { RecommendationJobService } from '../services/recommendationJobs.js';

function params(request: FastifyRequest) {
  return request.params as { profileId: string; jobId: string };
}

function success(reply: FastifyReply, data: unknown, statusCode = 200) {
  return reply.code(statusCode).send({ ok: true, data });
}

function requireJob(job: ReturnType<RecommendationJobService['getForProfile']>) {
  if (!job) throw new ApiError('NOT_FOUND', 'Recommendation job not found');
  return job;
}

export async function registerRecommendationJobRoutes(app: FastifyInstance, service: RecommendationJobService) {
  app.post('/api/profiles/:profileId/recommendation-jobs', async (request, reply) => {
    const { profileId } = params(request);
    return success(reply, service.createForProfile(profileId, request.body, request.id), 202);
  });

  app.get('/api/profiles/:profileId/recommendation-jobs/:jobId', async (request, reply) => {
    const { profileId, jobId } = params(request);
    return success(reply, requireJob(service.getForProfile(profileId, jobId)));
  });

  app.post('/api/profiles/:profileId/recommendation-jobs/:jobId/cancel', async (request, reply) => {
    const { profileId, jobId } = params(request);
    return success(reply, service.cancelForProfile(profileId, jobId), 200);
  });

  app.post('/api/profiles/:profileId/recommendation-jobs/:jobId/retry', async (request, reply) => {
    const { profileId, jobId } = params(request);
    return success(reply, service.retryForProfile(profileId, jobId, request.id), 202);
  });
}
