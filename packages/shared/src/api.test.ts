import { describe, expect, it } from 'vitest';
import type { ApiFailure, ApiResult, ApiSuccess } from './api.js';

describe('shared API contract', () => {
  it('represents success and failure without sensitive configuration fields', () => {
    const success: ApiSuccess<{ saved: boolean }> = {
      ok: true,
      data: { saved: true },
    };
    const failure: ApiFailure = {
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid input' },
    };
    const result: ApiResult<{ saved: boolean }> = success;

    expect(result.ok).toBe(true);
    expect(failure.error.code).toBe('VALIDATION_ERROR');
    expect('api_key' in success).toBe(false);
  });
});
