import { expect, test } from '@playwright/test';
import { generateRecommendation } from './recommendation-job-helper.js';

const profileInput = (name: string) => ({
  name,
  goal: 'maintain',
  goal_description: `${name} goal`,
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
});

test('isolates reports by profile and keeps archived reports read-only', async ({ page, request }) => {
  const suffix = Date.now();
  await request.put('/api/settings/model', { data: {
    base_url: 'http://127.0.0.1:4321/v1', model_name: 'report-management-model', api_key: 'test-only-key',
  } });

  const firstProfile = await request.post('/api/profiles', { data: profileInput(`报告 A ${suffix}`) });
  const firstProfileData = (await firstProfile.json()).data as { id: number };
  const firstGenerated = await generateRecommendation(request, firstProfileData.id, {
    start: '2026-09-01', end: '2026-09-07', explicitReview: false,
  });
  const firstReport = firstGenerated.report;

  const secondProfile = await request.post('/api/profiles', { data: profileInput(`报告 B ${suffix}`) });
  const secondProfileData = (await secondProfile.json()).data as { id: number };
  await request.put('/api/current-profile', { data: { profileId: secondProfileData.id } });
  const secondGenerated = await generateRecommendation(request, secondProfileData.id, {
    start: '2026-10-01', end: '2026-10-07', explicitReview: false,
  });
  const secondReport = secondGenerated.report;
  const thirdGenerated = await generateRecommendation(request, secondProfileData.id, {
    start: '2026-10-08', end: '2026-10-14', explicitReview: false,
  });
  const thirdReport = thirdGenerated.report;
  const remainingGenerated = await generateRecommendation(request, secondProfileData.id, {
    start: '2026-10-15', end: '2026-10-21', explicitReview: false,
  });
  const remainingReport = remainingGenerated.report;

  expect(firstProfileData.id).not.toBe(secondProfileData.id);
  expect(firstReport.id).not.toBe(secondReport.id);
  expect(secondReport.id).not.toBe(thirdReport.id);
  expect(thirdReport.id).not.toBe(remainingReport.id);

  await page.goto('/reports');
  await expect(page.getByRole('heading', { name: '阶段报告' })).toBeVisible();
  await expect(page.getByRole('button', { name: /2026-10-01 至 2026-10-07/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /2026-10-08 至 2026-10-14/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /2026-10-15 至 2026-10-21/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /2026-09-01 至 2026-09-07/ })).not.toBeVisible();

  await page.getByRole('button', { name: /2026-10-01 至 2026-10-07/ }).click();
  await expect(page).toHaveURL(new RegExp(`/reports/${secondProfileData.id}/${secondReport.id}$`));
  await expect(page.getByRole('heading', { name: '未来 7 天训练计划' })).toBeVisible();

  await page.getByRole('button', { name: '重新生成' }).click();
  await expect(page).toHaveURL(/\/recommendations$/);
  await expect(page.getByRole('heading', { name: '阶段建议' })).toBeVisible();
  await page.getByRole('button', { name: '生成建议' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('checkbox', { name: '确认将所选日期范围的数据传输给模型' }).check();
  await expect(page.getByRole('button', { name: '确认并生成' })).toBeEnabled();
  const generation = page.waitForResponse((response) => response.url() === `http://127.0.0.1:3001/api/profiles/${secondProfileData.id}/recommendation-jobs` && response.request().method() === 'POST');
  await page.getByRole('button', { name: '确认并生成' }).click();
  const generationResponse = await generation;
  expect(generationResponse.status()).toBe(202);
  await expect(page.getByRole('heading', { name: '未来 7 天训练计划' })).toBeVisible();
  const newReportPath = new URL(page.url()).pathname;
  const newReportId = Number(newReportPath.split('/').pop());
  expect(newReportId).not.toBe(secondReport.id);

  await page.getByRole('button', { name: '返回报告列表' }).click();
  await expect(page.getByRole('button', { name: /2026-10-01 至 2026-10-07/ })).toBeVisible();
  await page.getByRole('button', { name: /2026-10-01 至 2026-10-07/ }).click();
  await expect(page).toHaveURL(new RegExp(`/reports/${secondProfileData.id}/${secondReport.id}$`));
  await expect(page.getByRole('heading', { name: '未来 7 天训练计划' })).toBeVisible();
  await page.getByRole('button', { name: '返回报告列表' }).click();

  await page.getByLabel('选择报告 ' + secondReport.id).check();
  await page.getByLabel('选择报告 ' + thirdReport.id).check();
  await page.getByRole('button', { name: '删除所选报告' }).click();
  await expect(page.getByRole('heading', { name: '删除 2 份报告' })).toBeVisible();
  await page.getByLabel('我理解删除报告不可恢复').check();
  const bulkDelete = page.waitForResponse((response) => response.url() === `http://127.0.0.1:3001/api/profiles/${secondProfileData.id}/recommendations/bulk-delete` && response.request().method() === 'POST');
  await page.getByRole('button', { name: '确认删除' }).click();
  const bulkDeleteResponse = await bulkDelete;
  expect(bulkDeleteResponse.status()).toBe(200);
  expect(bulkDeleteResponse.request().postDataJSON()).toEqual({ ids: expect.arrayContaining([secondReport.id, thirdReport.id]) });
  await expect(page.getByLabel('选择报告 ' + secondReport.id)).not.toBeVisible();
  await expect(page.getByLabel('选择报告 ' + thirdReport.id)).not.toBeVisible();
  await expect(page.getByRole('button', { name: /2026-10-01 至 2026-10-07/ })).not.toBeVisible();
  await expect(page.getByRole('button', { name: /2026-10-08 至 2026-10-14/ })).not.toBeVisible();
  await expect(page.getByRole('button', { name: /2026-10-15 至 2026-10-21/ })).toBeVisible();

  const profileSwitch = page.waitForResponse((response) => response.url() === 'http://127.0.0.1:3001/api/current-profile' && response.request().method() === 'PUT');
  await page.getByLabel('切换档案').selectOption({ label: `报告 A ${suffix}` });
  await profileSwitch;
  await page.goto('/reports');
  await expect(page.getByRole('button', { name: /2026-09-01 至 2026-09-07/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /2026-10-01 至 2026-10-07/ })).not.toBeVisible();
  await page.getByRole('button', { name: /2026-09-01 至 2026-09-07/ }).click();
  await expect(page).toHaveURL(new RegExp(`/reports/${firstProfileData.id}/${firstReport.id}$`));

  await request.put('/api/current-profile', { data: { profileId: secondProfileData.id } });
  await request.post(`/api/profiles/${firstProfileData.id}/archive`);
  await page.goto(`/reports/${firstProfileData.id}`);
  await expect(page.getByRole('status')).toContainText('只读归档');
  await expect(page.getByRole('button', { name: /2026-09-01 至 2026-09-07/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '删除所选报告' })).not.toBeVisible();
  await expect(page.getByRole('checkbox', { name: /^选择报告/ })).not.toBeVisible();

  const archivedReportResponse = await request.post(`/api/profiles/${firstProfileData.id}/recommendations/bulk-delete`, { data: { ids: [firstReport.id] } });
  expect(archivedReportResponse.status()).toBe(409);

  await page.getByRole('button', { name: /2026-09-01 至 2026-09-07/ }).click();
  await expect(page.getByRole('button', { name: /导出 Markdown/ })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /导出 Markdown/ }).click();
  expect((await download).suggestedFilename()).toBe(`recommendation-${firstReport.id}.md`);
  await expect(page.getByRole('button', { name: '重新生成' })).not.toBeVisible();
  await expect(page.locator('body')).not.toContainText('test-only-key');
});
