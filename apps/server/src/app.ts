import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { migrate } from '@fitness-coach/db';
import { openDatabase } from '@fitness-coach/db';
import type { HealthResponse } from '@fitness-coach/shared';
import { getConfig, JSON_BODY_LIMIT, MULTIPART_BODY_LIMIT, type ServerConfig } from './config.js';
import { ApiError } from './errors.js';
import { registerRoutes } from './routes.js';
import { createRepositories } from '@fitness-coach/db';
import { prepareDataPaths } from './data-paths.js';
import { createRequestLogEntry, type RequestLogEntry } from './log-entry.js';
import { createProfileScope } from './services/profileScope.js';
import { createProfileTransferService } from './services/profileTransfer.js';
import { createSettingsService } from './services/settings.js';
import { createRecommendationJobService } from './services/recommendationJobs.js';

type BuildAppOptions = {
  log?: (entry: RequestLogEntry) => void;
};

const requestStart = new WeakMap<FastifyRequest, number>();
const requestErrorCodes = new WeakMap<FastifyRequest, string>();

function suitableRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function requestId(request: { headers: Record<string, string | string[] | undefined> }) {
  const value = request.headers['x-request-id'];
  return suitableRequestId(value) ? value : `req-${randomUUID().replaceAll('-', '')}`;
}

function parseMultipart(contentType: string, payload: Buffer | string) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!boundaryMatch) throw new ApiError('VALIDATION_ERROR', 'Multipart boundary is missing');
  const boundary = Buffer.from(`--${boundaryMatch[1] ?? boundaryMatch[2]}`);
  const headerEnd = Buffer.from('\r\n\r\n');
  const start = bytes.indexOf(headerEnd);
  if (start < 0) throw new ApiError('VALIDATION_ERROR', 'Multipart file is missing');
  const headers = bytes.subarray(0, start).toString('utf8');
  const disposition = /name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(headers);
  const mimeType = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim();
  if (!disposition?.[2] || !mimeType) throw new ApiError('VALIDATION_ERROR', 'Multipart file is missing');
  const fileStart = start + headerEnd.length;
  const endBoundary = bytes.indexOf(boundary, fileStart);
  const end = endBoundary >= 2 ? endBoundary - 2 : -1;
  if (end < fileStart) throw new ApiError('VALIDATION_ERROR', 'Multipart file is invalid');
  return { filename: disposition[2], mime_type: mimeType, bytes: bytes.subarray(fileStart, end) };
}

export async function buildApp(overrides: Partial<ServerConfig> = {}, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = { ...getConfig(), ...overrides };
  const paths = await prepareDataPaths(config.dataDir);
  const db = openDatabase(paths.database);
  migrate(db, paths.root);
  const profileTransfers = createProfileTransferService({ dataDir: paths.root, database: db });
  const recovery = await profileTransfers.recoverImport();
  if (recovery.cleanup_failures.length > 0) {
    db.close();
    throw new Error(`Profile import recovery cleanup failed: ${recovery.cleanup_failures.join('; ')}`);
  }
  const repositories = createRepositories(db);
  const profileScope = createProfileScope(repositories);
  const serviceContext = { repositories: profileScope.repositories, profileScope, dataDir: paths.root, database: db, profileTransfers };
  const settings = createSettingsService(serviceContext);
  const recommendationJobs = createRecommendationJobService(serviceContext, {
    getModelCredentials: settings.getModelCredentials,
  });
  recommendationJobs.recoverOnStartup();
  repositories.meal.recoverProcessing();
  const app = Fastify({
    logger: true,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: JSON_BODY_LIMIT,
    requestIdHeader: false,
    genReqId: requestId,
  });
  const log = options.log ?? ((entry: RequestLogEntry) => app.log.info(entry));
  app.addHook('onRequest', async (request, reply) => {
    requestStart.set(request, performance.now());
    reply.header('x-request-id', request.id);
  });
  app.addHook('onResponse', async (request, reply) => {
    log(createRequestLogEntry({
      method: request.method,
      path: request.raw.url ?? request.url,
      status: reply.statusCode,
      durationMs: performance.now() - (requestStart.get(request) ?? performance.now()),
      requestId: request.id,
      errorCode: requestErrorCodes.get(request),
    }));
  });
  app.addHook('preHandler', async (request) => {
    const path = request.raw.url?.split('?')[0] ?? request.url;
    const scoped = path.startsWith('/api/daily-entries')
      || path.startsWith('/api/meals')
      || path.startsWith('/api/workouts')
      || path.startsWith('/api/images')
      || path.startsWith('/api/recommendations');
    if (!scoped) return;
    if (profileScope.currentProfileId() !== undefined) {
      profileScope.lockCurrentProfile();
      if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') profileScope.assertWritable();
    }
  });
  await app.register(cors, { origin: false });
  const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const webRoot = join(projectRoot, 'apps', 'web', 'dist');
  const hasWebRoot = existsSync(webRoot);
  if (hasWebRoot) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
  }
  app.setNotFoundHandler((request, reply) => {
    if (request.raw.url?.startsWith('/api/')) {
      requestErrorCodes.set(request, 'NOT_FOUND');
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'Route not found', requestId: request.id } });
    }
    if (hasWebRoot) {
      return reply.sendFile('index.html');
    }
    requestErrorCodes.set(request, 'NOT_FOUND');
    return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'Route not found', requestId: request.id } });
  });
  app.addContentTypeParser(/^multipart\/form-data(?:;.*)?$/i, { parseAs: 'buffer', bodyLimit: MULTIPART_BODY_LIMIT }, (_request, payload, done) => {
    try {
      done(null, parseMultipart(String(_request.headers['content-type'] ?? ''), payload));
    } catch (error) {
      done(error as Error);
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const code = error instanceof ApiError
      ? error.code
      : error instanceof ZodError || (typeof error === 'object' && error !== null && 'issues' in error)
        ? 'VALIDATION_ERROR'
        : (error as { code?: string }).code === 'FST_ERR_CTP_INVALID_JSON_BODY'
          ? 'VALIDATION_ERROR'
          : (error as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE' || (error as { statusCode?: number }).statusCode === 413
            ? 'VALIDATION_ERROR'
            : 'INTERNAL_ERROR';
    requestErrorCodes.set(request, code);
    const errorResponse = (statusCode: number, message: string) => reply.code(statusCode).send({ ok: false, error: { code, message, requestId: request.id } });
    if (error instanceof ApiError) {
      return errorResponse(error.statusCode, error.message);
    }
    if (error instanceof ZodError || (typeof error === 'object' && error !== null && 'issues' in error)) {
      return errorResponse(400, 'Invalid request');
    }
    if ((error as { code?: string }).code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
      return errorResponse(400, 'Invalid JSON body');
    }
    if ((error as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return errorResponse(413, 'Payload is too large');
    }
    if ((error as { statusCode?: number }).statusCode === 413) {
      return errorResponse(413, 'Payload is too large');
    }
    return errorResponse(500, 'Internal server error');
  });
  app.get<{ Reply: HealthResponse }>('/api/health', async () => ({
    ok: true,
    service: 'fitness-coach-server',
  }));
  await registerRoutes(app, { ...serviceContext, recommendationJobs });
  app.addHook('onClose', async () => {
    await recommendationJobs.shutdown();
    db.close();
  });
  return app;
}

export { getConfig };
