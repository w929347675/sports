import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { getConfig, JSON_BODY_LIMIT, MULTIPART_BODY_LIMIT } from './config.js';

describe('server config', () => {
  it('uses a local data directory and never exposes API key configuration', () => {
    const config = getConfig({ DATA_DIR: 'data/custom', PORT: '3010' });

    expect(config).toEqual({
      dataDir: resolve('data/custom'),
      port: 3010,
      host: '127.0.0.1',
    });
    expect('apiKey' in config).toBe(false);
  });

  it('defines explicit body limits without loosening the existing payload limits', () => {
    expect(JSON_BODY_LIMIT).toBe(11 * 1024 * 1024);
    expect(MULTIPART_BODY_LIMIT).toBe(11 * 1024 * 1024);
  });
});
