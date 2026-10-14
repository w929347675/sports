import { describe, expect, it } from 'vitest';
import { createRequestLogEntry } from './log-entry.js';

describe('request log entries', () => {
  it('keeps only safe request outcome fields and strips query strings', () => {
    const entry = createRequestLogEntry({
      method: 'POST',
      path: '/api/settings/model?api_key=secret',
      status: 400,
      durationMs: 3.6,
      requestId: 'req-abc123',
      errorCode: 'VALIDATION_ERROR',
    });

    expect(entry).toEqual({
      method: 'POST',
      path: '/api/settings/model',
      status: 400,
      durationMs: 4,
      requestId: 'req-abc123',
      errorCode: 'VALIDATION_ERROR',
    });
    expect(Object.keys(entry)).not.toContain('body');
    expect(JSON.stringify(entry)).not.toContain('secret');
  });
});
