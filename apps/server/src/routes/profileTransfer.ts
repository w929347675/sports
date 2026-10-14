import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { profileExportInputSchema, profileTransferImportExecuteInputSchema } from '@fitness-coach/shared';
import { ApiError } from '../errors.js';
import { createProfileTransferService, MAX_IMPORT_BYTES } from '../services/profileTransfer.js';
import type { ServiceContext } from '../services/context.js';

type ProfileTransferService = ReturnType<typeof createProfileTransferService>;

export async function registerProfileTransferRoutes(app: FastifyInstance, context: ServiceContext, transfer?: ProfileTransferService) {
  const service = transfer ?? createProfileTransferService({ dataDir: context.dataDir, database: context.database });
  app.post('/api/profiles/export', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = profileExportInputSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', 'Profile IDs must be a non-empty array of positive integers');
    const result = await service.exportProfiles(parsed.data.profileIds);
    return reply
      .type('application/gzip')
      .header('content-disposition', `attachment; filename="${result.filename}"`)
      .send(result.archive);
  });
  app.post('/api/profile-transfers/import/preview', { bodyLimit: MAX_IMPORT_BYTES + 1024 * 1024 }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { filename?: unknown; mime_type?: unknown; bytes?: unknown } | null;
    if (
      !body
      || typeof body.filename !== 'string'
      || typeof body.mime_type !== 'string'
      || !(body.bytes instanceof Uint8Array)
      || body.bytes.length === 0
      || body.bytes.length > MAX_IMPORT_BYTES
    ) throw new ApiError('VALIDATION_ERROR', body?.bytes && (body.bytes as Uint8Array).length > MAX_IMPORT_BYTES ? 'Profile transfer package is too large' : 'Import file is missing');
    const data = await service.previewImport({ filename: body.filename, mime_type: body.mime_type, bytes: body.bytes });
    return reply.code(200).send({ ok: true, data });
  });
  app.post('/api/profile-transfers/import/execute', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = profileTransferImportExecuteInputSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', 'Invalid profile import request');
    const data = await service.executeImport(parsed.data);
    return reply.code(200).send({ ok: true, data });
  });
}
