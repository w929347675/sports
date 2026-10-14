import { expect, type APIRequestContext } from '@playwright/test';

type RecommendationJob = {
  job_id: string;
  status: string;
  recommendation_id: number | null;
};

export async function generateRecommendation(
  request: APIRequestContext,
  profileId: number,
  input: { start: string; end: string; explicitReview?: boolean; specifiedMealIds?: number[] },
) {
  const created = await request.post(`/api/profiles/${profileId}/recommendation-jobs`, { data: input });
  expect(created.status()).toBe(202);
  const initial = (await created.json()).data as RecommendationJob;
  expect(initial.job_id).toEqual(expect.any(String));

  let job = initial;
  for (let attempt = 0; attempt < 100 && job.status !== 'completed'; attempt += 1) {
    if (job.status === 'failed' || job.status === 'cancelled') throw new Error(`Recommendation job ended as ${job.status}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const status = await request.get(`/api/profiles/${profileId}/recommendation-jobs/${encodeURIComponent(job.job_id)}`);
    expect(status.ok()).toBeTruthy();
    job = (await status.json()).data as RecommendationJob;
  }
  expect(job.status).toBe('completed');
  expect(job.recommendation_id).toEqual(expect.any(Number));
  const report = await request.get(`/api/profiles/${profileId}/recommendations/${job.recommendation_id}`);
  expect(report.ok()).toBeTruthy();
  return { job, report: (await report.json()).data as { id: number } };
}
