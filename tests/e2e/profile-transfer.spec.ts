import { expect, request as playwrightRequest, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRecommendation } from './recommendation-job-helper.js';

const targetPort = 3003;
const targetUrl = `http://127.0.0.1:${targetPort}`;

async function waitForHealth() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(`${targetUrl}/api/health`)).ok) return; } catch { /* The process may still be starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Profile import E2E server did not become healthy');
}

function startServer(dataDir: string): ChildProcess {
  const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx');
  return spawn(process.execPath, [tsx, 'apps/server/src/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(targetPort) },
    stdio: 'ignore',
  });
}

async function stopServer(server: ChildProcess) {
  if (server.exitCode !== null) return;
  server.kill('SIGTERM');
  await new Promise<void>((resolve) => { server.once('exit', () => resolve()); setTimeout(resolve, 3_000); });
}

test('exports then imports records, an image and a report into another empty data directory', async ({ page, request }) => {
  const name = `Transfer ${Date.now()}`;
  const date = '2026-10-10';
  const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const profile = {
    name, goal: 'maintain', goal_description: 'e2e transfer', height_cm: 175, age: 30,
    sex: 'unspecified', training_experience: 'beginner', equipment: 'home', training_days_per_week: 3,
    session_duration_minutes: 45, diet_preferences: 'none', allergies: 'none', health_restrictions: 'none',
  };
  const created = await request.post('/api/profiles', { data: profile });
  expect(created.ok()).toBeTruthy();
  const profileId = ((await created.json()).data as { id: number }).id;
  await request.put(`/api/daily-entries/${date}`, { data: { status: 'training', status_note: 'transfer day' } });
  const mealResponse = await request.post(`/api/daily-entries/${date}/meals`, { data: {
    eaten_at: `${date}T12:00:00Z`, meal_type: 'lunch', notes: 'transfer meal', recognition_status: 'unrecognized',
  } });
  const mealId = (await mealResponse.json()).data.id as number;
  const boundary = '----fitness-coach-profile-transfer-e2e';
  const imageUpload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="meal.png"\r\nContent-Type: image/png\r\n\r\n`),
    imageBytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  expect((await request.post(`/api/meals/${mealId}/images`, { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, data: imageUpload })).ok()).toBeTruthy();
  await request.put('/api/settings/model', { data: { base_url: 'http://127.0.0.1:4321/v1', model_name: 'transfer-model', api_key: 'test-only-transfer-key' } });
  await request.post('http://127.0.0.1:4321/test/reset');
  const generated = await generateRecommendation(request, profileId, { start: date, end: date });
  expect(generated.job.recommendation_id).toBe(generated.report.id);

  await page.goto('/profile-transfer');
  await page.getByLabel(`选择 ${name}`).check();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出所选档案' }).click();
  const download = await downloadPromise;
  const archiveDir = await mkdtemp(join(tmpdir(), 'fitness-coach-transfer-archive-'));
  const archivePath = join(archiveDir, download.suggestedFilename());
  await download.saveAs(archivePath);

  const targetDataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-transfer-target-'));
  const targetServer = startServer(targetDataDir);
  try {
    await waitForHealth();
    const targetRequest = await playwrightRequest.newContext({ baseURL: targetUrl });
    try {
      expect((await (await targetRequest.get('/api/current-profile')).json()).data.profile).toBeNull();
      await page.goto(`${targetUrl}/profile-transfer`);
      await page.getByLabel('选择档案包').setInputFiles(archivePath);
      await expect(page.getByRole('heading', { name: '导入预览' })).toBeVisible();
      await page.getByRole('button', { name: '执行导入' }).click();
      await page.getByRole('button', { name: '确认导入' }).click();
      await expect(page.getByText('导入完成')).toBeVisible();
      expect((await (await targetRequest.get('/api/current-profile')).json()).data.profile).toBeNull();

      const profiles = (await (await targetRequest.get('/api/profiles?status=all')).json()).data as Array<{ id: number; name: string; status: string }>;
      const imported = profiles.find((item) => item.name === name);
      expect(imported).toMatchObject({ status: 'active' });
      if (!imported) throw new Error('Imported profile is missing');
      expect((await targetRequest.put('/api/current-profile', { data: { profileId: imported.id } })).ok()).toBeTruthy();
      const day = (await (await targetRequest.get(`/api/daily-entries/${date}`)).json()).data;
      expect(day.entry.status_note).toBe('transfer day');
      expect(day.meals[0].notes).toBe('transfer meal');
      const image = await targetRequest.get(`/api/images/${day.meals[0].images[0].id}`);
      expect(Buffer.from(await image.body())).toEqual(imageBytes);
      const reports = (await (await targetRequest.get('/api/recommendations')).json()).data;
      expect(reports).toHaveLength(1);
      expect(reports[0].model_name).toBe('transfer-model');
    } finally {
      await targetRequest.dispose();
    }
  } finally {
    await stopServer(targetServer);
    await rm(targetDataDir, { recursive: true, force: true });
    await rm(archiveDir, { recursive: true, force: true });
  }
});
