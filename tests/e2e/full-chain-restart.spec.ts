import { test, expect, request as playwrightRequest } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

const port = 3002;
const serverUrl = `http://127.0.0.1:${port}`;

function localDate(offsetDays = 0) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(`${serverUrl}/api/health`)).ok) return;
    } catch {
      // The child process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Dedicated E2E server did not become healthy');
}

function startServer(dataDir: string): ChildProcess {
  const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx');
  return spawn(process.execPath, [tsx, 'apps/server/src/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) },
    stdio: 'ignore',
  });
}

async function stopServer(server: ChildProcess) {
  if (server.exitCode !== null) return;
  server.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    server.once('exit', () => resolve());
    setTimeout(resolve, 3_000);
  });
}

async function createMealImage(request: APIRequestContext, mealId: number) {
  const boundary = '----fitness-coach-full-chain-boundary';
  const multipart = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="meal.png"\r\nContent-Type: image/png\r\n\r\n`),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await request.post(`/api/meals/${mealId}/images`, {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    data: multipart,
  });
  expect(response.ok()).toBe(true);
}

async function configureAndSeed(request: APIRequestContext) {
  const today = localDate();
  await request.put('/api/profile', { data: {
    goal: 'maintain', height_cm: 175, age: 30, sex: 'unspecified', training_experience: 'beginner',
    equipment: 'home', training_days_per_week: 3, session_duration_minutes: 45,
    diet_preferences: 'balanced', allergies: 'none', health_restrictions: 'none',
  } });
  await request.put('/api/settings/model', { data: {
    base_url: 'http://127.0.0.1:4321/v1', model_name: 'test-only-model', api_key: 'test-only-key',
  } });

  for (const [offset, status] of [[-2, 'training'], [-1, 'rest'], [0, 'training']] as const) {
    const date = localDate(offset);
    await request.put(`/api/daily-entries/${date}`, { data: { status, status_note: '' } });
    await request.post(`/api/daily-entries/${date}/weights`, { data: { measured_at: `${date}T08:00:00Z`, weight_kg: 72 + offset * 0.1, note: '' } });
    await request.post(`/api/daily-entries/${date}/workouts`, { data: { started_at: `${date}T18:00:00Z`, workout_type: '力量', duration_minutes: 40, perceived_effort: 6, notes: '' } });
    await request.post(`/api/daily-entries/${date}/feedback`, { data: {
      recorded_at: `${date}T20:00:00Z`, category: offset === 0 ? 'pain' : 'normal', body_part: offset === 0 ? 'knee' : '', severity: offset === 0 ? 8 : 0,
      impact: offset === 0 ? 'walking' : '', description: offset === 0 ? 'Pain after training' : '正常',
    } });
  }

  const mealResponse = await request.post(`/api/daily-entries/${today}/meals`, { data: {
    eaten_at: `${today}T12:00:00Z`, meal_type: 'lunch', notes: '三日流程午餐', recognition_status: 'unrecognized',
  } });
  const meal = (await mealResponse.json()).data as { id: number };
  await createMealImage(request, meal.id);
  return { today, mealId: meal.id };
}

test('completes the local chain and recovers the same data directory after restart', async ({ browser }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-full-chain-'));
  let server = startServer(dataDir);
  const aiRequest = await playwrightRequest.newContext({ baseURL: 'http://127.0.0.1:4321' });
  try {
    await waitForHealth();
    await aiRequest.post('/test/reset');
    const api = await playwrightRequest.newContext({ baseURL: serverUrl });
    const { today, mealId } = await configureAndSeed(api);
    const page = await (await browser.newContext({ baseURL: serverUrl })).newPage();

    await page.goto(`/entry/${today}?meal=${mealId}`);
    await expect(page.getByRole('heading', { name: '三日流程午餐' })).toBeVisible();
    await page.getByRole('button', { name: '识别这餐' }).click();
    await expect(page.getByLabel('食物名称 1')).toHaveValue('鸡胸肉');
    await page.getByLabel('食物名称 1').fill('确认鸡胸肉');
    await page.getByRole('button', { name: '确认食物项目' }).click();
    await expect(page.locator('.status-pill').getByText('已确认')).toBeVisible();

    await page.goto('/recommendations');
    await expect(page.getByLabel('开始日期')).toHaveValue(localDate(-13));
    await expect(page.getByLabel('结束日期')).toHaveValue(today);
    await page.getByRole('button', { name: '生成建议' }).click();
    await page.getByRole('checkbox', { name: /确认将所选日期范围的数据传输给模型/ }).check();
    await page.getByRole('button', { name: '确认并生成' }).click();
    await expect(page.getByRole('heading', { name: '未来 7 天训练计划' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '高风险安全提示' })).toBeVisible();

    await page.goto('/settings');
    await page.getByRole('button', { name: '创建本地备份' }).click();
    await expect(page.getByText('备份已保存到本机')).toBeVisible();
    await page.getByRole('button', { name: '导出 JSON' }).click();
    await expect(page.getByText('导出已下载到本机')).toBeVisible();

    const aiState = await aiRequest.get('/test/state');
    expect((await aiState.json()).requests).toEqual([
      expect.objectContaining({ kind: 'recognition', imageCount: 1 }),
      expect.objectContaining({ kind: 'recommendation', imageCount: 0, structuredData: true, highRisk: true }),
    ]);
    expect(await (await api.get(`/api/daily-entries/${today}`)).json()).toMatchObject({
      data: { meals: [expect.objectContaining({ food_items: [expect.objectContaining({ name: '确认鸡胸肉' })] })] },
    });

    await page.context().close();
    await api.dispose();
    await aiRequest.dispose();
    await stopServer(server);
    server = startServer(dataDir);
    await waitForHealth();

    const recoveredApi = await playwrightRequest.newContext({ baseURL: serverUrl });
    expect(await (await recoveredApi.get('/api/profile')).json()).toMatchObject({ data: { goal: 'maintain' } });
    const recoveredEntry = await (await recoveredApi.get(`/api/daily-entries/${today}`)).json() as {
      data: { meals: Array<{ images: Array<{ id: number }> }> };
    };
    const recoveredImageId = recoveredEntry.data.meals[0]?.images[0]?.id;
    expect(recoveredImageId).toBeDefined();
    const recoveredImage = await recoveredApi.get(`/api/images/${recoveredImageId}`);
    expect(recoveredImage.ok()).toBe(true);
    expect((await recoveredImage.body()).byteLength).toBeGreaterThan(0);

    const recoveredContext = await browser.newContext({ baseURL: serverUrl });
    const recovered = await recoveredContext.newPage();
    await recovered.goto(`/entry/${today}?meal=${mealId}`);
    await expect(recovered.locator('.status-pill').getByText('已确认')).toBeVisible();
    await expect(recovered.getByText('确认鸡胸肉')).toBeVisible();
    await recovered.goto('/recommendations');
    await expect(recovered.getByRole('heading', { name: '未来 7 天训练计划' })).toBeVisible();
    await recoveredContext.close();
    await recoveredApi.dispose();
  } finally {
    await stopServer(server);
    await aiRequest.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});
