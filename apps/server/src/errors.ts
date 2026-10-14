import type { AiErrorCode } from '@fitness-coach/ai';

export type ErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'PROFILE_ARCHIVED' | 'CONFIGURATION_ERROR' | 'INTERNAL_ERROR' | AiErrorCode;

export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly statusCode = code === 'VALIDATION_ERROR' ? 400 : code === 'NOT_FOUND' ? 404 : code === 'CONFLICT' ? 409 : code === 'FORBIDDEN' ? 403 : code === 'PROFILE_ARCHIVED' ? 409 : code === 'CONFIGURATION_ERROR' ? 503 : 500,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function payloadTooLarge(message = 'Payload is too large'): never {
  throw new ApiError('VALIDATION_ERROR', message, 413);
}

export function notFound(message = 'Resource not found'): never {
  throw new ApiError('NOT_FOUND', message);
}

export function configurationError(message: string): never {
  throw new ApiError('CONFIGURATION_ERROR', message);
}

export function internalError(message: string): never {
  throw new ApiError('INTERNAL_ERROR', message);
}
