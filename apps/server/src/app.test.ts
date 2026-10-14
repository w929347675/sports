import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { JSON_BODY_LIMIT, MULTIPART_BODY_LIMIT } from './config.js';

describe('health API', () => {
  it('returns a healthy local server response', async () => {
    const app = await buildApp({ dataDir: '/tmp/fitness-coach-health-test' });
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      service: 'fitness-coach-server',
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('serves the built web app and falls back to index for client routes', async () => {
    const originalCwd = process.cwd();
    process.chdir('/tmp');
    try {
      const app = await buildApp({ dataDir: '/tmp/fitness-coach-static-test' });
      const root = await app.inject({ method: 'GET', url: '/' });
      const clientRoute = await app.inject({ method: 'GET', url: '/history' });

      expect(root.statusCode).toBe(200);
      expect(root.headers['content-type']).toContain('text/html');
      expect(root.body).toContain('Fitness Coach');
      expect(clientRoute.statusCode).toBe(200);
      expect(clientRoute.headers['content-type']).toContain('text/html');
      await app.close();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('correlates requests and logs only safe structured fields', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const app = await buildApp({ dataDir: '/tmp/fitness-coach-request-id-test' }, { log: (entry) => logs.push(entry) });

    const response = await app.inject({
      method: 'GET',
      url: '/api/meals/999999?api_key=do-not-log',
      headers: { 'x-request-id': 'client-request-123' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['x-request-id']).toBe('client-request-123');
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND', requestId: 'client-request-123' },
    });
    expect(logs).toContainEqual(expect.objectContaining({
      method: 'GET',
      path: '/api/meals/999999',
      status: 404,
      requestId: 'client-request-123',
      errorCode: 'NOT_FOUND',
    }));
    expect(JSON.stringify(logs)).not.toContain('api_key');
    expect(JSON.stringify(logs)).not.toContain('do-not-log');
    expect(logs.every((entry) => Object.keys(entry).every((key) => [
      'method', 'path', 'status', 'durationMs', 'requestId', 'errorCode',
    ].includes(key)))).toBe(true);
    await app.close();
  });

  it('generates a safe request id when the incoming id is unsuitable', async () => {
    const app = await buildApp({ dataDir: '/tmp/fitness-coach-generated-request-id-test' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-request-id': 'not suitable: this id is intentionally longer than the accepted request id limit '.repeat(3) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toMatch(/^req-[a-z0-9]+$/);
    await app.close();
  });

  it('rejects oversized JSON and multipart bodies without logging their contents', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const app = await buildApp({ dataDir: '/tmp/fitness-coach-body-limit-test' }, { log: (entry) => logs.push(entry) });
    const jsonSecret = 'json-secret-must-not-be-logged';
    const jsonResponse = await app.inject({
      method: 'POST',
      url: '/api/recommendations',
      headers: { 'content-type': 'application/json', authorization: 'Bearer authorization-secret' },
      payload: JSON.stringify({ api_key: jsonSecret, padding: 'x'.repeat(JSON_BODY_LIMIT) }),
    });
    const boundary = 'oversized-body-test-boundary';
    const multipartSecret = 'multipart-secret-must-not-be-logged';
    const multipartResponse = await app.inject({
      method: 'POST',
      url: '/api/meals/1/images',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="secret.png"\r\nContent-Type: image/png\r\n\r\n${multipartSecret}`),
        Buffer.alloc(MULTIPART_BODY_LIMIT + 1, 1),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });

    expect(jsonResponse.statusCode).toBe(413);
    expect(multipartResponse.statusCode).toBe(413);
    expect(jsonResponse.json()).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Payload is too large' } });
    expect(multipartResponse.json()).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Payload is too large' } });
    expect(JSON.stringify(logs)).not.toContain(jsonSecret);
    expect(JSON.stringify(logs)).not.toContain(multipartSecret);
    expect(JSON.stringify(logs)).not.toContain('authorization-secret');
    await app.close();
  });

  it('rejects a symlinked data directory and unsafe storage children at startup', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'fitness-coach-path-test-'));
    const realDataDir = join(parent, 'real-data');
    const linkedDataDir = join(parent, 'linked-data');
    const outside = join(parent, 'outside');
    await mkdir(realDataDir);
    await mkdir(outside);
    await symlink(realDataDir, linkedDataDir);
    await expect(buildApp({ dataDir: linkedDataDir })).rejects.toThrow(/symlink|unsafe/i);

    await symlink(outside, join(realDataDir, 'images'));
    await expect(buildApp({ dataDir: realDataDir })).rejects.toThrow(/symlink|unsafe/i);
    await rm(parent, { recursive: true, force: true });
  });

  it('rejects symlinked database and secret paths at startup', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'fitness-coach-file-path-test-'));
    const dataDir = join(parent, 'data');
    const outsideFile = join(parent, 'outside.secret');
    await mkdir(dataDir);
    await writeFile(outsideFile, 'private');
    await symlink(outsideFile, join(dataDir, 'fitness-coach.sqlite'));
    await expect(buildApp({ dataDir })).rejects.toThrow(/symlink|unsafe/i);
    await rm(dataDir, { recursive: true, force: true });
    await mkdir(dataDir);
    await symlink(outsideFile, join(dataDir, 'model-api-key.secret'));
    await expect(buildApp({ dataDir })).rejects.toThrow(/symlink|unsafe/i);
    await rm(parent, { recursive: true, force: true });
  });

  it('does not create an unsafe child symlink target while validating startup paths', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'fitness-coach-child-link-test-'));
    const dataDir = join(parent, 'data');
    const outside = join(parent, 'outside-not-created');
    await mkdir(dataDir);
    await symlink(outside, join(dataDir, 'images'));

    await expect(buildApp({ dataDir })).rejects.toThrow(/symlink|unsafe/i);
    await expect(stat(outside)).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(parent, { recursive: true, force: true });
  });
});
