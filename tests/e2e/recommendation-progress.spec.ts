import { expect, test } from '@playwright/test';

const profile = {
  id: 7,
  name: '进度档案',
  status: 'active',
  goal: 'maintain',
  height_cm: 175,
  age: 30,
  sex: 'unspecified',
  training_experience: 'beginner',
  equipment: 'home',
  training_days_per_week: 3,
  session_duration_minutes: 45,
  diet_preferences: 'balanced',
  allergies: 'none',
  health_restrictions: 'none',
};

const job = (status: string, overrides: Record<string, unknown> = {}) => ({
  job_id: 'progress-job-1', profile_id: 7, status, phase_percent: status === 'receiving' ? 80 : 5,
  received_chars: status === 'receiving' ? 1280 : 0, started_at: '2026-10-13T10:00:00Z',
  updated_at: '2026-10-13T10:00:30Z', completed_at: null, error_code: null, error_message: null,
  error_phase: null, request_id: 'req-progress-1', recommendation_id: null, ...overrides,
});

async function openPage(page: import('@playwright/test').Page) {
  await page.route('**/api/profile', async (route) => route.fulfill({ json: { ok: true, data: profile } }));
  await page.route('**/api/current-profile', async (route) => route.fulfill({ json: { ok: true, data: { profile } } }));
  await page.route('**/api/profiles?**', async (route) => route.fulfill({ json: { ok: true, data: [profile] } }));
  await page.route('**/api/profiles/7', async (route) => route.fulfill({ json: { ok: true, data: profile } }));
  await page.route('**/api/profiles/7/recommendations**', async (route) => route.fulfill({ json: { ok: true, data: { items: [], page: 1, pageSize: 25, total: 0 } } }));
  await page.route('**/api/recommendations/preview', async (route) => route.fulfill({ json: {
    ok: true,
    data: {
      range: { start: '2026-10-01', end: '2026-10-13' },
      inputSummary: { recordCount: 1, imageCount: 0 }, imageCount: 0, highRisk: false,
      explicitReview: false, safety: { level: 'low', banner: '当前范围未发现高风险不适。' },
    },
  } }));
  await page.goto('/recommendations');
  await expect(page.getByRole('heading', { name: '阶段建议' })).toBeVisible();
  await page.getByRole('button', { name: '生成建议' }).click();
  await page.getByRole('checkbox', { name: '确认将所选日期范围的数据传输给模型' }).check();
}

test.describe('recommendation progress', () => {
  test('shows slow model progress and cancels without opening a report', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-10-13T10:00:30Z') });
    let current = job('waiting_model');
    await page.route('**/api/profiles/7/recommendation-jobs', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({ status: 202, json: { ok: true, data: current } });
        return;
      }
      await route.fulfill({ json: { ok: true, data: current } });
    });
    await page.route('**/api/profiles/7/recommendation-jobs/progress-job-1', async (route) => {
      await route.fulfill({ json: { ok: true, data: current } });
    });
    await page.route('**/api/profiles/7/recommendation-jobs/progress-job-1/cancel', async (route) => {
      current = job('cancelled', { completed_at: '2026-10-13T10:01:00Z' });
      await route.fulfill({ json: { ok: true, data: current } });
    });

    await openPage(page);
    await page.getByRole('button', { name: '确认并生成' }).click();
    await expect(page.getByRole('heading', { name: '等待模型分析' })).toBeVisible();
    await expect(page.getByText(/已接收字符：/)).toBeVisible();
    await expect(page.getByText(/阶段估计，不是模型真实进度/)).toBeVisible();
    await page.clock.fastForward('01:01');
    await expect(page.getByText(/等待时长：1 分/)).toBeVisible();
    await expect(page.getByRole('button', { name: '取消生成' })).toBeEnabled();
    await page.getByRole('button', { name: '取消生成' }).click();
    await expect(page.getByText('已取消生成')).toBeVisible();
    await expect(page).not.toHaveURL(/\/reports\/7\//);
  });

  test('shows safe failure details and creates a new job on retry', async ({ page }) => {
    let current = job('failed', { error_code: 'AI_TIMEOUT', error_phase: 'waiting_model', request_id: 'req-failed-1' });
    await page.route('**/api/profiles/7/recommendation-jobs', async (route) => route.fulfill({ status: 202, json: { ok: true, data: current } }));
    await page.route('**/api/profiles/7/recommendation-jobs/progress-job-1', async (route) => route.fulfill({ json: { ok: true, data: current } }));
    await page.route('**/api/profiles/7/recommendation-jobs/progress-job-1/retry', async (route) => {
      current = job('queued', { job_id: 'progress-job-2', request_id: 'req-retry-1' });
      await route.fulfill({ status: 202, json: { ok: true, data: current } });
    });

    await page.addInitScript(() => window.localStorage.setItem('recommendation-job-7', 'progress-job-1'));
    await openPage(page);
    await expect(page.getByRole('alert')).toContainText('AI_TIMEOUT');
    await expect(page.getByRole('alert')).toContainText('waiting_model');
    await expect(page.getByRole('alert')).toContainText('req-failed-1');
    await page.getByRole('button', { name: '重试生成' }).click();
    await expect(page.getByText('progress-job-2')).toBeVisible();
    await expect(page.getByRole('alert')).not.toContainText('api_key');
  });
});
