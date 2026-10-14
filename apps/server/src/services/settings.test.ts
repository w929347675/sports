import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories, migrate } from '@fitness-coach/db';
import { ApiError } from '../errors.js';
import { createSettingsService } from './settings.js';

describe('settings service model credentials', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function setup() {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-settings-'));
    directories.push(dataDir);
    await mkdir(join(dataDir, 'images'));
    const db = new Database(':memory:');
    migrate(db);
    const settings = createSettingsService({ repositories: createRepositories(db), dataDir });
    return { db, settings };
  }

  it('returns complete model credentials only through the server service', async () => {
    const { db, settings } = await setup();
    await settings.saveModel({
      base_url: 'https://example.test/v1',
      model_name: 'vision-model',
      api_key: 'sk-server-only',
    });

    await expect(settings.getModelCredentials()).resolves.toEqual({
      baseUrl: 'https://example.test/v1',
      modelName: 'vision-model',
      apiKey: 'sk-server-only',
    });
    expect(await settings.getModel()).not.toHaveProperty('apiKey');
    db.close();
  });

  it('reports incomplete model credentials without exposing a stored key', async () => {
    const { db, settings } = await setup();

    await expect(settings.getModelCredentials()).rejects.toMatchObject({
      code: 'CONFIGURATION_ERROR',
      statusCode: 503,
    } satisfies Partial<ApiError>);
    await expect(settings.getModelCredentials()).rejects.not.toThrow(/api.?key/i);
    db.close();
  });

  it('tests the stored connection server-side without returning the API key', async () => {
    const { db, settings: baseSettings } = await setup();
    await baseSettings.saveModel({ base_url: 'http://127.0.0.1:4321/v1', model_name: 'test-model', api_key: 'test-secret' });
    const tester = vi.fn().mockResolvedValue(undefined);
    const settings = createSettingsService({ repositories: createRepositories(db), dataDir: directories.at(-1)! }, { tester });

    await expect(settings.testConnection()).resolves.toEqual({ connected: true, modelName: 'test-model' });
    expect(tester).toHaveBeenCalledWith(
      { baseUrl: 'http://127.0.0.1:4321/v1', modelName: 'test-model', apiKey: 'test-secret' },
      { timeoutMs: 60_000 },
    );
    expect(JSON.stringify(await settings.testConnection())).not.toContain('test-secret');
    db.close();
  });
});
