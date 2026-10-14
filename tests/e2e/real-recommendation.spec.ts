import { test, expect } from '@playwright/test';

function localDate(offsetDays = 0) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

test('generates a real local recommendation only after transfer confirmation', async ({ page, request }) => {
  const today = localDate();
  await request.post('http://127.0.0.1:4321/test/reset');
  await request.put('/api/settings/model', { data: {
    base_url: 'http://127.0.0.1:4321/v1', model_name: 'test-only-model', api_key: 'test-only-key',
  } });
  await request.put('/api/profile', { data: {
    goal: 'maintain', height_cm: 175, age: 30, sex: 'unspecified', training_experience: 'beginner',
    equipment: 'home', training_days_per_week: 3, session_duration_minutes: 45,
    diet_preferences: 'balanced', allergies: 'none', health_restrictions: 'none',
  } });
  await request.put(`/api/daily-entries/${today}`, { data: { status: 'training', status_note: '' } });
  await request.post(`/api/daily-entries/${today}/feedback`, { data: {
    recorded_at: `${today}T18:00:00Z`, category: 'pain', body_part: 'knee', severity: 8,
    impact: 'walking', description: 'Pain after training',
  } });

  await page.goto('/recommendations');
  await expect(page.getByRole('heading', { name: '阶段建议' })).toBeVisible();
  const start = await page.getByLabel('开始日期').inputValue();
  const end = await page.getByLabel('结束日期').inputValue();
  expect(start).toBe(localDate(-13));
  expect(end).toBe(today);

  const beforeConfirm = await request.get('http://127.0.0.1:4321/test/state');
  expect((await beforeConfirm.json()).requests).toEqual([]);
  await page.getByRole('button', { name: '生成建议' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText(/默认不会发送原图/)).toBeVisible();
  const stillBeforeConfirm = await request.get('http://127.0.0.1:4321/test/state');
  expect((await stillBeforeConfirm.json()).requests).toEqual([]);

  await page.getByRole('checkbox', { name: /确认将所选日期范围的数据传输给模型/ }).check();
  const currentProfile = await request.get('/api/current-profile');
  const profileId = ((await currentProfile.json()).data as { profile: { id: number } }).profile.id;
  const generation = page.waitForResponse((response) => response.url() === `http://127.0.0.1:3001/api/profiles/${profileId}/recommendation-jobs` && response.request().method() === 'POST');
  await page.getByRole('button', { name: '确认并生成' }).click();
  await expect((await generation).status()).toBe(202);
  await expect(page.getByRole('heading', { name: '未来 7 天训练计划' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '高风险安全提示' })).toBeVisible();

  const state = await request.get('http://127.0.0.1:4321/test/state');
  expect((await state.json()).requests).toEqual([expect.objectContaining({
    kind: 'recommendation', imageCount: 0, hasAuthorization: true, structuredData: true, highRisk: true,
  })]);
  await page.reload();
  await expect(page.getByRole('heading', { name: '未来 7 天训练计划' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '高风险安全提示' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('test-only-key');
});
