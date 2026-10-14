import { describe, expect, it, vi } from 'vitest';
import { createRecommendationModel } from './recommendation.js';
import type { FetchLike } from './types.js';

describe('recommendation model prompt', () => {
  it('states data uncertainty and the complete safety boundary', async () => {
    let requestBody: { messages: Array<{ role: string; content: string }>; stream?: boolean } | undefined;
    const report = {
      summary: 'Summary', trend: { observations: [] },
      trainingPlan: Array.from({ length: 7 }, (_, index) => ({ day: index + 1, focus: 'Recovery', exercises: [] })),
      dietAdvice: [], recovery: [], followUps: [], safety: { level: 'low', banner: 'Monitor symptoms.' }, uncertainties: [],
    };
    const fetcher: FetchLike = vi.fn(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(report) } }] }), { status: 200 });
    });

    await createRecommendationModel({ baseUrl: 'http://localhost/v1', modelName: 'test', apiKey: 'secret' }, { fetch: fetcher })({});

    const prompt = requestBody?.messages[0]?.content ?? '';
    expect(prompt).toMatch(/weight.*food portions.*visual recognition.*inaccurate/i);
    expect(prompt).toMatch(/persistent.*worsening.*daily activities/i);
    expect(prompt).toMatch(/not a medical diagnostic tool/i);
    expect(requestBody?.stream).toBe(true);
    expect(prompt).toMatch(/trainingPlan.*7.*day.*focus.*exercises/is);
    expect(prompt).toMatch(/safety.*level.*banner/is);
  });
});
