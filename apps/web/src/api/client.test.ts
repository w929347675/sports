import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './client.js';

describe('web API client', () => {
  afterEach(() => vi.restoreAllMocks());

  it('unwraps successful API responses without exposing credentials', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { configured: true, modelName: 'local-model' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(api.getModelSettings()).resolves.toEqual({ configured: true, modelName: 'local-model' });
    expect(fetchMock).toHaveBeenCalledWith('/api/settings/model', expect.objectContaining({ method: 'GET' }));
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('body');
  });

  it('maps API failures to a user-readable error without logging request bodies', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid request' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(api.saveProfile({
      goal: 'maintain', height_cm: 175, age: 30, sex: 'unspecified', training_experience: 'beginner',
      equipment: 'none', training_days_per_week: 2, session_duration_minutes: 30,
      diet_preferences: '', allergies: '', health_restrictions: '',
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: 'Invalid request' });
  });

  it('preserves the request id when a downloadable export fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: '导出失败' } }), {
        status: 500,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req-export-1' },
      }),
    );

    await expect(api.downloadJsonExport(false)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      requestId: 'req-export-1',
    });
  });

  it('saves a daily entry through the local API only', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { id: 1, entry_date: '2026-09-28', status: 'training' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await api.saveDailyEntry('2026-09-28', { status: 'training', status_note: 'planned' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/daily-entries/2026-09-28');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'PUT' });
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).not.toContain('api_key');
  });

  it('does not retry mutating requests after a server error', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'failed' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { id: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    await expect(api.saveDailyEntry('2026-09-28', { status: 'training', status_note: '' })).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses date-scoped patch and delete routes for editing saved records', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ ok: true, data: { id: 7 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await api.patchWeight('2026-09-28', { id: 7, weight_kg: 71.8 });
    await api.deleteWeight('2026-09-28', 7);
    await api.patchMeal('2026-09-28', { id: 8, notes: 'edited' });
    await api.deleteMeal('2026-09-28', 8);

    expect(fetchMock.mock.calls.map(([path, init]) => [path, init?.method])).toEqual([
      ['/api/daily-entries/2026-09-28/weights', 'PATCH'],
      ['/api/daily-entries/2026-09-28/weights', 'DELETE'],
      ['/api/daily-entries/2026-09-28/meals', 'PATCH'],
      ['/api/daily-entries/2026-09-28/meals', 'DELETE'],
    ]);
  });

  it('recognizes one meal, recognizes a batch, and confirms food items through the matching routes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ ok: true, data: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await api.recognizeMeal(7);
    await api.recognizeMealsBatch([7, 9]);
    await api.confirmFoodItems(7, {
      items: [{ id: 12, name: '米饭', amount: 180, unit: 'g', cooking_method: '蒸', confidence: 0.8, needs_confirmation: true, notes: '估计' }],
    });

    expect(fetchMock.mock.calls.map(([path, init]) => [path, init?.method, init?.body])).toEqual([
      ['/api/meals/7/recognize', 'POST', undefined],
      ['/api/meals/recognize-batch', 'POST', JSON.stringify({ mealIds: [7, 9] })],
      ['/api/meals/7/confirm-food-items', 'POST', JSON.stringify({
        items: [{ id: 12, name: '米饭', amount: 180, unit: 'g', cooking_method: '蒸', confidence: 0.8, needs_confirmation: true, notes: '估计' }],
      })],
    ]);
  });

  it('lists, retrieves, and creates recommendation jobs through the correct routes without sending an API key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      ok: true,
      data: { id: 41, status: 'completed' },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await api.listRecommendations();
    await api.getRecommendation(41);
    await api.createRecommendationJob(7, {
      start: '2026-09-10',
      end: '2026-09-16',
      explicitReview: false,
    });

    expect(fetchMock.mock.calls.map(([path, init]) => [path, init?.method, init?.body])).toEqual([
      ['/api/recommendations', 'GET', undefined],
      ['/api/recommendations/41', 'GET', undefined],
      ['/api/profiles/7/recommendation-jobs', 'POST', JSON.stringify({
        start: '2026-09-10',
        end: '2026-09-16',
        explicitReview: false,
      })],
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(String(init?.body ?? '')).not.toMatch(/api[_-]?key/i);
    }
  });

  it('passes AbortSignal to job status fetches and does not retry permanent errors', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      ok: false, error: { code: 'PROFILE_ARCHIVED', message: 'Archived profiles are read-only' },
    }), { status: 409, headers: { 'content-type': 'application/json' } }));
    const controller = new AbortController();

    await expect(api.getRecommendationJob(7, 'job-1', controller.signal)).rejects.toMatchObject({ code: 'PROFILE_ARCHIVED', status: 409 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/profiles/7/recommendation-jobs/job-1', expect.objectContaining({ signal: controller.signal }));
  });

});
