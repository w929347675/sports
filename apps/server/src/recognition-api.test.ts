import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '@fitness-coach/db';
import { buildApp } from './app.js';

const date = '2026-09-28';
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex');

function multipart(bytes: Buffer, filename = 'meal.png') {
  const boundary = 'recognition-api-test-boundary';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

function aiResponse(itemName = 'Rice') {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      items: [{ name: itemName, amount: 180, unit: 'g', confidence: 0.8, needsConfirmation: true, notes: '' }],
      cookingMethod: 'steamed',
      uncertainties: [],
    }) } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('meal recognition API', () => {
  let app: FastifyInstance;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-recognition-api-'));
    app = await buildApp({ dataDir });
    await app.inject({ method: 'PUT', url: '/api/profile', payload: {
      goal: 'maintain', height_cm: 175, age: 30, sex: 'unspecified', training_experience: 'beginner',
      equipment: 'home', training_days_per_week: 3, session_duration_minutes: 45,
      diet_preferences: '', allergies: '', health_restrictions: '',
    } });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function request(method: 'GET' | 'PUT' | 'POST', url: string, payload?: object, headers?: Record<string, string>) {
    return app.inject({ method, url, ...(payload === undefined ? {} : { payload }), ...(headers === undefined ? {} : { headers }) });
  }

  async function createMeal(notes = 'one bowl') {
    await request('PUT', `/api/daily-entries/${date}`, { status: 'training' });
    const response = await request('POST', `/api/daily-entries/${date}/meals`, {
      eaten_at: `${date}T12:00:00Z`, meal_type: 'lunch', notes, recognition_status: 'unrecognized',
    });
    return response.json().data as { id: number };
  }

  async function upload(mealId: number, bytes = png) {
    return app.inject({ method: 'POST', url: `/api/meals/${mealId}/images`, ...multipart(bytes) });
  }

  async function configure(key = 'sk-never-return-this') {
    return request('PUT', '/api/settings/model', {
      base_url: 'https://example.test/v1', model_name: 'vision-model', api_key: key,
    });
  }

  it('calls AI exactly once only after manual recognize and returns a reusable meal detail shape', async () => {
    const key = 'sk-secret-recognition-key';
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(aiResponse());
    expect((await configure(key)).statusCode).toBe(200);
    const meal = await createMeal();
    const image = await upload(meal.id);
    expect(image.statusCode).toBe(201);
    expect(fetch).toHaveBeenCalledTimes(0);

    const response = await request('POST', `/api/meals/${meal.id}/recognize`);

    expect(response.statusCode).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(response.json()).toMatchObject({
      ok: true,
      data: {
        meal: { id: meal.id, recognition_status: 'needs_review' },
        food_items: [{ name: 'Rice', cooking_method: 'steamed', source: 'model', is_user_confirmed: false }],
      },
    });
    expect(response.body).not.toContain(key);
    expect(JSON.stringify(response.headers)).not.toContain(key);
    const entry = await request('GET', `/api/daily-entries/${date}`);
    expect(entry.json().data.meals[0]).toMatchObject({
      id: meal.id,
      recognition_status: 'needs_review',
      images: [{ id: image.json().data.id }],
      food_items: [{ name: 'Rice' }],
    });
  });

  it('rejects recognition from an external origin before reading images or calling AI', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(aiResponse());
    await configure();
    const meal = await createMeal();
    await upload(meal.id);

    const response = await request('POST', `/api/meals/${meal.id}/recognize`, undefined, { origin: 'https://evil.example' });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Meal recognition requests must come from a local origin', requestId: expect.any(String) },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'http://localhost:5173',
    'http://127.0.0.1:4173',
    'http://[::1]:3000',
  ])('allows recognition from loopback browser origin %s', async (origin) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(aiResponse());
    await configure();
    const meal = await createMeal();
    await upload(meal.id);

    const response = await request('POST', `/api/meals/${meal.id}/recognize`, undefined, { origin });

    expect(response.statusCode).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('protects batch recognition from an external origin', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(aiResponse());
    await configure();
    const first = await createMeal('first');
    await upload(first.id);

    const response = await request('POST', '/api/meals/recognize-batch', { mealIds: [first.id] }, { origin: 'https://evil.example' });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Meal recognition requests must come from a local origin', requestId: expect.any(String) },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not send 30 historical images during saves or when recognizing another meal', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(aiResponse('Selected meal'));
    await configure();
    const selected = await createMeal('selected');
    await upload(selected.id, Buffer.from('selected-image'));
    const historical = await createMeal('historical');
    for (let index = 0; index < 30; index += 1) await upload(historical.id, Buffer.from(`history-${index}`));
    expect(fetch).toHaveBeenCalledTimes(0);

    const response = await request('POST', `/api/meals/${selected.id}/recognize`);

    expect(response.statusCode).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetch.mock.calls[0][1]?.body as string) as {
      messages: Array<{ content: unknown }>;
    };
    const content = body.messages[1].content as Array<{ type: string; image_url?: { url: string } }>;
    expect(content.filter(({ type }) => type === 'image_url')).toHaveLength(1);
    expect(JSON.stringify(body)).toContain(Buffer.from('selected-image').toString('base64'));
    expect(JSON.stringify(body)).not.toContain(Buffer.from('history-0').toString('base64'));
  });

  it('confirms edited items without a model call and rejects invalid amounts', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(aiResponse());
    await configure();
    const meal = await createMeal();
    await upload(meal.id);
    const recognized = await request('POST', `/api/meals/${meal.id}/recognize`);
    const item = recognized.json().data.food_items[0] as { id: number };
    expect(fetch).toHaveBeenCalledTimes(1);

    const invalid = await request('POST', `/api/meals/${meal.id}/confirm-food-items`, {
      items: [{ id: item.id, name: 'Rice', amount: 0, unit: 'g', cooking_method: 'steamed', confidence: 1, needs_confirmation: false, notes: '' }],
    });
    expect(invalid.statusCode).toBe(400);

    const confirmed = await request('POST', `/api/meals/${meal.id}/confirm-food-items`, {
      items: [{ id: item.id, name: 'Brown rice', amount: 200, unit: 'g', cooking_method: 'steamed', confidence: 1, needs_confirmation: true, notes: 'weighed' }],
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({
      ok: true,
      data: {
        meal: { recognition_status: 'confirmed' },
        food_items: [{ name: 'Brown rice', amount: 200, source: 'user', is_user_confirmed: true, needs_confirmation: false }],
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns per-meal batch outcomes and keeps original files and old items on a failed meal', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(aiResponse('First meal'))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));
    await configure();
    const first = await createMeal('first');
    const second = await createMeal('second');
    const firstImage = await upload(first.id, Buffer.from('first-file'));
    const secondImage = await upload(second.id, Buffer.from('second-file'));
    const secondImagePath = resolve(dataDir, secondImage.json().data.relative_path);
    const db = openDatabase(join(dataDir, 'fitness-coach.sqlite'));
    try {
      db.prepare(`INSERT INTO food_items
        (meal_id, name, amount, unit, cooking_method, confidence, needs_confirmation, is_user_confirmed, source, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(second.id, 'Existing confirmed', 1, 'bowl', '', 1, 0, 1, 'user', '');
    } finally {
      db.close();
    }

    const response = await request('POST', '/api/meals/recognize-batch', { mealIds: [first.id, second.id] });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, data: [
      { mealId: first.id, status: 'success', data: { meal: { recognition_status: 'needs_review' } } },
      { mealId: second.id, status: 'failed', error: { code: 'AI_AUTHENTICATION_FAILED', message: 'AI service authentication failed' } },
    ] });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await readFile(secondImagePath)).toEqual(Buffer.from('second-file'));
    const entry = await request('GET', `/api/daily-entries/${date}`);
    const failed = entry.json().data.meals.find(({ id }: { id: number }) => id === second.id);
    expect(failed).toMatchObject({
      recognition_status: 'failed',
      images: [{ id: secondImage.json().data.id }],
      food_items: [{ name: 'Existing confirmed', is_user_confirmed: true }],
    });
    expect(firstImage.statusCode).toBe(201);
  });

  it('returns readable non-secret errors for missing configuration and unknown meals', async () => {
    const meal = await createMeal();
    await upload(meal.id);
    const missing = await request('POST', `/api/meals/${meal.id}/recognize`);
    expect(missing.statusCode).toBe(503);
    expect(missing.json()).toEqual({
      ok: false,
      error: { code: 'CONFIGURATION_ERROR', message: 'Model configuration is incomplete', requestId: expect.any(String) },
    });
    const unknown = await request('POST', '/api/meals/999999/recognize');
    expect(unknown.statusCode).toBe(404);
  });

  it('maps AI failures to stable readable responses without leaking the API key', async () => {
    const key = 'sk-error-must-stay-private';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('denied', { status: 401 }));
    await configure(key);
    const meal = await createMeal();
    await upload(meal.id);

    const response = await request('POST', `/api/meals/${meal.id}/recognize`);

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      ok: false,
      error: { code: 'AI_AUTHENTICATION_FAILED', message: 'AI service authentication failed', requestId: expect.any(String) },
    });
    expect(response.body).not.toContain(key);
  });

  it('persists parser uncertainty reasons in food item notes and returns them from the daily entry', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        items: [{ name: '米饭', amount: 180, unit: 'g', confidence: 0.9, needsConfirmation: false, notes: '' }],
        cookingMethod: null,
        uncertainties: ['重量无法确定'],
      }) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await configure();
    const meal = await createMeal();
    await upload(meal.id);

    const recognized = await request('POST', `/api/meals/${meal.id}/recognize`);
    const item = recognized.json().data.food_items[0];
    expect(item).toMatchObject({ needs_confirmation: true });
    expect(item.notes).toContain('重量无法确定');

    const entry = await request('GET', `/api/daily-entries/${date}`);
    expect(entry.json().data.meals[0].food_items[0]).toMatchObject({
      needs_confirmation: true,
      notes: expect.stringContaining('重量无法确定'),
    });
  });

  it('rejects a duplicate recognize request while the first request is processing', async () => {
    let finishRequest: (response: Response) => void = () => undefined;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => {
      finishRequest = resolve;
    }));
    await configure();
    const meal = await createMeal();
    await upload(meal.id);

    const first = request('POST', `/api/meals/${meal.id}/recognize`);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const duplicate = await request('POST', `/api/meals/${meal.id}/recognize`);

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({
      ok: false,
      error: { code: 'CONFLICT', message: 'Meal recognition is already processing', requestId: expect.any(String) },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    finishRequest(aiResponse());
    expect((await first).statusCode).toBe(200);
  });

  it('recovers an interrupted processing meal on app restart and allows recognition to retry', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(aiResponse('Recovered meal'));
    await configure();
    const meal = await createMeal();
    await upload(meal.id);
    const db = openDatabase(join(dataDir, 'fitness-coach.sqlite'));
    try {
      db.prepare("UPDATE meals SET recognition_status = 'processing' WHERE id = ?").run(meal.id);
    } finally {
      db.close();
    }
    await app.close();

    app = await buildApp({ dataDir });
    const recovered = await request('GET', `/api/daily-entries/${date}`);
    expect(recovered.json().data.meals[0].recognition_status).toBe('failed');

    const retried = await request('POST', `/api/meals/${meal.id}/recognize`);
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({
      ok: true,
      data: { meal: { recognition_status: 'needs_review' }, food_items: [{ name: 'Recovered meal' }] },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects confirmation while processing without changing the meal or calling AI', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(aiResponse());
    const meal = await createMeal();
    await upload(meal.id);
    const db = openDatabase(join(dataDir, 'fitness-coach.sqlite'));
    try {
      db.prepare("UPDATE meals SET recognition_status = 'processing' WHERE id = ?").run(meal.id);
    } finally {
      db.close();
    }
    const before = await request('GET', `/api/daily-entries/${date}`);

    const response = await request('POST', `/api/meals/${meal.id}/confirm-food-items`, { items: [] });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      ok: false,
      error: { code: 'CONFLICT', message: 'Meal recognition is still processing', requestId: expect.any(String) },
    });
    expect(fetch).not.toHaveBeenCalled();
    const after = await request('GET', `/api/daily-entries/${date}`);
    expect(after.json().data.meals[0]).toMatchObject({
      recognition_status: 'processing',
      food_items: before.json().data.meals[0].food_items,
    });
  });

  it('allows confirming an empty item set from needs_review to delete model drafts', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(aiResponse());
    await configure();
    const meal = await createMeal();
    await upload(meal.id);
    const recognized = await request('POST', `/api/meals/${meal.id}/recognize`);
    expect(recognized.statusCode).toBe(200);

    const response = await request('POST', `/api/meals/${meal.id}/confirm-food-items`, { items: [] });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, data: { meal: { recognition_status: 'confirmed' }, food_items: [] } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects an over-limit selected meal without sending or deleting its images', async () => {
    const key = 'sk-limit-error-private';
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(aiResponse());
    await configure(key);
    const meal = await createMeal();
    const images = [];
    for (let index = 0; index < 13; index += 1) images.push(await upload(meal.id, Buffer.from(`selected-${index}`)));
    const firstPath = resolve(dataDir, images[0].json().data.relative_path);

    const response = await request('POST', `/api/meals/${meal.id}/recognize`);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'Meal recognition supports at most 12 images', requestId: expect.any(String) },
    });
    expect(response.body).not.toContain(key);
    expect(fetch).not.toHaveBeenCalled();
    expect(await readFile(firstPath)).toEqual(Buffer.from('selected-0'));
    const entry = await request('GET', `/api/daily-entries/${date}`);
    expect(entry.json().data.meals[0]).toMatchObject({ recognition_status: 'failed' });
    expect(entry.json().data.meals[0].images).toHaveLength(13);
  });

  it('does not send an image if its ID is reassigned to another meal before recognition reads it', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(aiResponse());
    await configure();
    const selected = await createMeal('selected');
    const other = await createMeal('other');
    const image = await upload(selected.id, Buffer.from('must-not-send'));
    const db = openDatabase(join(dataDir, 'fitness-coach.sqlite'));
    try {
      db.prepare('UPDATE meal_images SET meal_id = ? WHERE id = ?').run(other.id, image.json().data.id);
    } finally {
      db.close();
    }

    const response = await request('POST', `/api/meals/${selected.id}/recognize`);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'Meal recognition requires at least one image', requestId: expect.any(String) },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
