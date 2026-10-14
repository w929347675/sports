import { test, expect } from '@playwright/test';

const profile = {
  id: 1,
  goal: 'maintain',
  height_cm: 175,
  age: 30,
  sex: 'unspecified',
  training_experience: 'intermediate',
  equipment: 'home gym',
  training_days_per_week: 4,
  session_duration_minutes: 60,
  diet_preferences: 'balanced',
  allergies: 'none',
  health_restrictions: 'none',
};

const report = {
  summary: 'The period was consistent overall.',
  trend: { observations: ['Weight was stable.'] },
  trainingPlan: Array.from({ length: 7 }, (_, index) => ({ day: index + 1, focus: `Day ${index + 1}`, exercises: ['Squat'] })),
  dietAdvice: ['Keep protein consistent.'],
  recovery: ['Sleep at least eight hours.'],
  followUps: ['Review progress in seven days.'],
  safety: { level: 'high', banner: 'Stop affected activities and seek professional evaluation.' },
  uncertainties: ['Some food amounts are estimates.'],
};

test.describe('recommendation mock flow', () => {
  test('keeps generation manual, sends no API key, and renders the saved report', async ({ page }) => {
    let jobRequests = 0;
    let jobBody: Record<string, unknown> | undefined;
    const recommendation = {
      id: 1,
      range_start: '2026-09-18',
      range_end: '2026-10-01',
      model_name: 'mock-model',
      generated_at: '2026-10-01T10:00:00Z',
      input_summary_json: JSON.stringify({ recordCount: 1, imageCount: 0 }),
      report_markdown: '# Summary',
      structured_report_json: JSON.stringify(report),
      status: 'completed',
      inputSummary: { recordCount: 1, imageCount: 0 },
      report,
    };
    const job = {
      job_id: 'mock-job-1', profile_id: 1, status: 'queued', phase_percent: 5, received_chars: 0,
      started_at: null, updated_at: '2026-10-01T10:00:00Z', completed_at: null,
      error_code: null, error_message: null, error_phase: null, request_id: 'req-mock-job', recommendation_id: null,
    };
    const completedJob = { ...job, status: 'completed', phase_percent: 100, completed_at: '2026-10-01T10:01:00Z', recommendation_id: 1 };

    await page.route('**/api/profile', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: profile }) });
    });
    await page.route('**/api/current-profile', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { profile: { ...profile, name: 'Mock profile', status: 'active' } } }) });
    });
    await page.route('**/api/profiles?**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: [{ ...profile, name: 'Mock profile', status: 'active' }] }) });
    });
    await page.route('**/api/profiles/1', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { ...profile, name: 'Mock profile', status: 'active' } }) });
    });
    await page.route('**/api/profiles/1/recommendations**', async (route) => {
      const isDetail = /\/\d+$/.test(route.request().url().split('?')[0]);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: isDetail ? { ...recommendation, profile_id: 1 } : { items: [], page: 1, pageSize: 25, total: 0 } }) });
    });
    await page.route('**/api/profiles/1/recommendation-jobs**', async (route) => {
      if (route.request().method() === 'POST') {
        jobRequests += 1;
        jobBody = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
        await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ ok: true, data: job }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: completedJob }) });
    });

    await page.goto('/recommendations');
    await expect(page.getByRole('heading', { name: '阶段建议' })).toBeVisible();
    expect(jobRequests).toBe(0);

    const start = await page.getByLabel('开始日期').inputValue();
    const end = await page.getByLabel('结束日期').inputValue();
    await page.getByRole('button', { name: '生成建议' }).click();
    await page.getByRole('checkbox', { name: '确认将所选日期范围的数据传输给模型' }).check();
    await page.getByRole('button', { name: '确认并生成' }).click();

    expect(jobRequests).toBe(1);
    expect(jobBody).toEqual({ start, end, explicitReview: false });
    expect(JSON.stringify(jobBody)).not.toMatch(/api[_-]?key/i);
    await expect(page.getByRole('heading', { name: '未来 7 天训练计划' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '高风险安全提示' })).toBeVisible();
  });
});
