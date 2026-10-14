import { test, expect } from '@playwright/test';

const date = '2026-10-02';
const profile = {
  goal: 'maintain', height_cm: 175, age: 30, sex: 'unspecified', training_experience: 'beginner',
  equipment: 'home', training_days_per_week: 3, session_duration_minutes: 45,
  diet_preferences: 'balanced', allergies: 'none', health_restrictions: 'none',
};

test.describe('real local meal recognition flow', () => {
  test('recognizes, edits, confirms, and persists a meal through the local server', async ({ page, request }) => {
    await request.post('http://127.0.0.1:4321/test/reset');
    await request.put('/api/settings/model', { data: {
      base_url: 'http://127.0.0.1:4321/v1', model_name: 'test-only-model', api_key: 'test-only-key',
    } });
    await request.put('/api/profile', { data: profile });
    await request.put(`/api/daily-entries/${date}`, { data: { status: 'training', status_note: '' } });
    const mealResponse = await request.post(`/api/daily-entries/${date}/meals`, { data: {
      eaten_at: `${date}T12:00:00Z`, meal_type: 'lunch', notes: '测试午餐', recognition_status: 'unrecognized',
    } });
    const meal = (await mealResponse.json()).data as { id: number };
    const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const boundary = '----fitness-coach-test-boundary';
    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="meal.png"\r\nContent-Type: image/png\r\n\r\n`),
      imageBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const uploadResponse = await request.post(`/api/meals/${meal.id}/images`, {
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      data: multipart,
    });
    expect(uploadResponse.ok()).toBe(true);

    await page.goto(`/entry/${date}?meal=${meal.id}`);
    await expect(page.getByRole('heading', { name: '测试午餐' })).toBeVisible();
    await expect(page.locator('.status-pill').getByText('尚未识别')).toBeVisible();
    const recognition = page.waitForResponse((response) => response.url().endsWith(`/api/meals/${meal.id}/recognize`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: '识别这餐' }).click();
    await expect((await recognition).status()).toBe(200);
    await expect(page.getByLabel('食物名称 1')).toHaveValue('鸡胸肉');
    await page.getByLabel('食物名称 1').fill('确认鸡胸肉');
    await page.getByRole('button', { name: '确认食物项目' }).click();
    await expect(page.locator('.status-pill').getByText('已确认')).toBeVisible();

    const state = await request.get('http://127.0.0.1:4321/test/state');
    expect((await state.json()).requests).toEqual([expect.objectContaining({ kind: 'recognition', imageCount: 1, hasAuthorization: true })]);
    const persisted = await request.get(`/api/daily-entries/${date}`);
    expect((await persisted.json()).data.meals[0]).toMatchObject({ recognition_status: 'confirmed' });
    expect((await persisted.json()).data.meals[0].food_items[0]).toMatchObject({ name: '确认鸡胸肉', is_user_confirmed: true, source: 'user' });
  });
});
