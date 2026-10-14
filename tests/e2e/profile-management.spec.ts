import { test, expect } from '@playwright/test';

async function createProfile(page: import('@playwright/test').Page, name: string) {
  await page.getByRole('button', { name: '新增档案' }).click();
  await page.getByLabel('档案名称').fill(name);
  await page.getByLabel('训练经验').fill('初学');
  await page.getByLabel('器械与场地').fill('家中');
  await page.getByRole('button', { name: '创建并切换' }).click();
  await expect(page.getByRole('button', { name: new RegExp(`${name}.*(?:启用|已归档)`) })).toBeVisible();
}

test('creates, switches, isolates, archives, restores, deletes and filters profiles', async ({ page }) => {
  await page.goto('/profiles');
  await createProfile(page, '档案 A');
  await createProfile(page, '档案 B');

  await page.getByLabel('切换档案').selectOption({ label: '档案 A' });
  await page.getByRole('link', { name: '今日记录' }).click();
  await page.getByRole('button', { name: '打开日记录' }).click();
  const date = new URL(page.url()).pathname.slice('/entry/'.length);
  await page.getByRole('button', { name: '保存当天状态' }).click();
  await page.getByLabel('体重（kg）').fill('70.2');
  await page.getByRole('button', { name: '保存体重' }).click();
  await expect(page.getByText('70.2 kg')).toBeVisible();

  await page.getByLabel('切换档案').selectOption({ label: '档案 B' });
  await expect(page.getByText('70.2 kg')).not.toBeVisible();
  await page.getByRole('link', { name: '管理' }).click();
  await page.getByLabel('状态筛选').selectOption('all');
  await page.getByRole('button', { name: '归档 档案 A' }).click();
  await page.getByRole('button', { name: '确认归档' }).click();
  await expect(page.getByText('已归档')).toBeVisible();

  await page.getByRole('button', { name: /档案 A.*已归档/ }).click();
  await expect(page.getByRole('status')).toContainText('只读归档');
  await expect(page.getByRole('button', { name: '编辑资料' })).not.toBeVisible();
  await page.getByRole('button', { name: '← 返回档案列表' }).click();
  await page.getByLabel('状态筛选').selectOption('archived');
  await page.getByRole('button', { name: '恢复 档案 A' }).click();
  await page.getByRole('button', { name: '确认恢复' }).click();
  await expect(page.getByRole('button', { name: /档案 A.*已归档/ })).not.toBeVisible();

  await page.getByLabel('状态筛选').selectOption('active');
  await page.getByLabel('选择 档案 A').check();
  await page.getByRole('button', { name: '永久删除所选' }).click();
  await page.getByLabel('我理解这些档案及其记录、图片和报告将被永久删除').check();
  await page.getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(page.getByRole('button', { name: /档案 A.*启用/ })).not.toBeVisible();
  await page.goto(`/entry/${date}`);
  await expect(page.getByText('70.2 kg')).not.toBeVisible();
});
