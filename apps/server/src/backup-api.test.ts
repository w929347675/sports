import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';

describe('backup and JSON export API', () => {
  let app: FastifyInstance;
  let dataDir: string;

  afterEach(async () => {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function setup() {
    dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-backup-api-'));
    app = await buildApp({ dataDir });
    await app.inject({ method: 'PUT', url: '/api/profile', payload: {
      goal: 'maintain', height_cm: 175, age: 30, sex: 'unspecified', training_experience: 'beginner',
      equipment: 'home', training_days_per_week: 3, session_duration_minutes: 45,
      diet_preferences: '', allergies: '', health_restrictions: '',
    } });
  }

  it('exports sanitized JSON without the API key by default and includes image bytes on request', async () => {
    await setup();
    const key = 'sk-json-export-secret';
    await app.inject({
      method: 'PUT',
      url: '/api/settings/model',
      payload: { base_url: 'https://example.test/v1', model_name: 'export-model', api_key: key },
    });
    await app.inject({ method: 'PUT', url: '/api/daily-entries/2026-09-28', payload: { status: 'training' } });
    const meal = await app.inject({
      method: 'POST',
      url: '/api/daily-entries/2026-09-28/meals',
      payload: { eaten_at: '2026-09-28T12:00:00Z', meal_type: 'lunch', notes: 'export' },
    });
    const boundary = 'export-test-boundary';
    await app.inject({
      method: 'POST',
      url: `/api/meals/${meal.json().data.id}/images`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="meal.png"\r\nContent-Type: image/png\r\n\r\n`),
        Buffer.from('image bytes'),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });

    const defaultExport = await app.inject({ method: 'GET', url: '/api/export/json' });
    expect(defaultExport.statusCode).toBe(200);
    expect(defaultExport.headers['content-disposition']).toContain('attachment');
    expect(defaultExport.body).not.toContain(key);
    expect(defaultExport.body).not.toContain('base64');
    expect(defaultExport.json()).toMatchObject({
      manifest: { schema_version: 2, includes_images: false },
      data: { app_settings: expect.arrayContaining([
        { key: 'model_base_url', value: 'https://example.test/v1' },
        { key: 'model_name', value: 'export-model' },
      ]) },
    });

    const withImages = await app.inject({ method: 'GET', url: '/api/export/json?include-images=true' });
    expect(withImages.statusCode).toBe(200);
    expect(withImages.body).not.toContain(key);
    expect(withImages.json()).toMatchObject({
      manifest: { schema_version: 2, includes_images: true },
      images: [expect.objectContaining({ path: expect.stringMatching(/^images\//), base64: expect.any(String) })],
    });
  });

  it('creates a backup and exposes recent backup metadata without filesystem paths', async () => {
    await setup();
    const created = await app.inject({ method: 'POST', url: '/api/backups' });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ ok: true, data: { filename: expect.stringMatching(/^backup-.*\.tar\.gz$/), size: expect.any(Number) } });
    expect(created.body).not.toContain(dataDir);

    const listed = await app.inject({ method: 'GET', url: '/api/backups' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ ok: true, data: [expect.objectContaining({ filename: created.json().data.filename })] });
    expect(listed.body).not.toContain(dataDir);
  });

  it('does not include secret or backup files in exported metadata', async () => {
    await setup();
    await writeFile(join(dataDir, 'model-api-key.secret'), 'sk-file-only');
    await writeFile(join(dataDir, 'runtime-config.json'), 'runtime');
    await mkdir(join(dataDir, 'backups', 'nested'), { recursive: true });
    await writeFile(join(dataDir, 'backups', 'nested', 'old.tar.gz'), 'old');

    const response = await app.inject({ method: 'GET', url: '/api/export/json' });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('model-api-key.secret');
    expect(response.body).not.toContain('runtime-config.json');
    expect(response.body).not.toContain('sk-file-only');
  });

  it('drops forbidden settings rows instead of retaining their secret values', async () => {
    await setup();
    const { openDatabase } = await import('@fitness-coach/db');
    const db = openDatabase(join(dataDir, 'fitness-coach.sqlite'));
    try {
      db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('api-key-backup', 'sk-row-secret');
    } finally {
      db.close();
    }

    const response = await app.inject({ method: 'GET', url: '/api/export/json' });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('api-key-backup');
    expect(response.body).not.toContain('sk-row-secret');
  });
});
