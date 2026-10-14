import { test, expect } from '@playwright/test';

test.describe('local record loop', () => {
  test('profile and daily records stay local and survive a refresh', async ({ page }) => {
    const apiRequests: Array<{ url: string; body: string | null }> = [];
    const apiResponses: Array<{ method: string; url: string; status: number }> = [];
    const failedRequests: Array<{ method: string; url: string; failure: string | null }> = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/')) apiRequests.push({ url: request.url(), body: request.postData() });
    });
    page.on('response', (response) => {
      if (response.url().includes('/api/')) apiResponses.push({ method: response.request().method(), url: response.url(), status: response.status() });
    });
    page.on('requestfailed', (request) => {
      if (request.url().includes('/api/')) failedRequests.push({ method: request.method(), url: request.url(), failure: request.failure()?.errorText ?? null });
    });

    await page.goto('/');
    await page.getByRole('link', { name: '档案' }).click();
    await page.getByLabel('目标').selectOption('maintain');
    await page.getByLabel('训练经验').fill('初学');
    await page.getByLabel('器械与场地').fill('家中');
    await page.getByRole('button', { name: '保存档案' }).click();
    await expect(page.getByRole('heading', { name: '今日工作台' })).toBeVisible();

    await page.getByRole('link', { name: '设置' }).click();
    await page.getByLabel('Base URL').fill('https://example.test/v1');
    await page.getByLabel('模型名').fill('test-only-model');
    await page.getByLabel('API Key').fill('not-a-real-api-key');
    expect(await page.locator('form').evaluate((form) => (form as HTMLFormElement).checkValidity())).toBe(true);
    const settingsResponse = page.waitForResponse((response) => response.url().endsWith('/api/settings/model') && response.request().method() === 'PUT');
    await page.getByRole('button', { name: '保存设置' }).click();
    const response = await settingsResponse.catch((error) => {
      throw new Error(`${error.message}\nAPI responses: ${JSON.stringify(apiResponses)}\nFailed requests: ${JSON.stringify(failedRequests)}`);
    });
    expect(response.status()).toBe(200);
    const payload = await response.json() as { ok?: boolean; data?: { configured?: boolean } };
    expect(payload).toMatchObject({ ok: true, data: { configured: true } });
    await expect(page.getByText('API Key 已配置，前端不会读取或显示它。')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('not-a-real-api-key');

    await page.getByRole('link', { name: '今日记录' }).click();
    await page.getByRole('button', { name: '打开日记录' }).click();
    const date = new URL(page.url()).pathname.slice('/entry/'.length);
    const dailyStatusResponse = page.waitForResponse((response) => response.url().endsWith(`/api/daily-entries/${date}`) && response.request().method() === 'PUT');
    await page.getByRole('button', { name: '保存当天状态' }).click();
    const statusResponse = await dailyStatusResponse.catch((error) => {
      throw new Error(`${error.message}\nAPI responses: ${JSON.stringify(apiResponses)}\nFailed requests: ${JSON.stringify(failedRequests)}`);
    });
    expect(statusResponse.status()).toBe(200);
    await page.getByLabel('体重（kg）').fill('72.5');
    await expect(page.getByRole('button', { name: '保存体重' })).toBeEnabled();
    await page.getByRole('button', { name: '保存体重' }).click();
    await expect(page.getByText('72.5 kg')).toBeVisible();
    await page.getByLabel('餐次类型').selectOption('lunch');
    await page.getByLabel('餐次备注').fill('午餐');
    await page.getByRole('button', { name: '保存餐次' }).click();
    await expect(page.getByRole('button', { name: '午餐', exact: true })).toBeVisible();
    await page.getByLabel('训练类型').fill('力量');
    await page.getByRole('button', { name: '保存训练' }).click();
    await expect(page.getByText('力量')).toBeVisible();
    await page.reload();

    await expect(page.getByText('72.5 kg')).toBeVisible();
    await expect(page.getByRole('button', { name: '午餐', exact: true })).toBeVisible();
    await expect(page.getByText('力量')).toBeVisible();
    expect(apiRequests.filter(({ url }) => /recognition|recommendation|\/ai(?:\/|$)|\/chat(?:\/|$)|\/responses(?:\/|$)/.test(url))).toEqual([]);
    expect(apiRequests.filter(({ url, body }) => !url.endsWith('/api/settings/model') && body?.includes('not-a-real-api-key'))).toEqual([]);
  });
});
