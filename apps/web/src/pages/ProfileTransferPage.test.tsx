// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProfileTransferPage } from './ProfileTransferPage.js';

const activeProfile = {
  id: 1, name: 'Runner', status: 'active' as const, goal: 'maintain' as const, goal_description: '',
  height_cm: 175, age: 30, sex: 'unspecified' as const, training_experience: 'beginner', equipment: 'home',
  training_days_per_week: 3, session_duration_minutes: 45, diet_preferences: '', allergies: '', health_restrictions: '',
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z', archived_at: null,
  last_entry_at: '2026-10-02', last_recommendation_at: null, record_days: 2, report_count: 0,
  has_unconfirmed_diet: false, has_high_risk_feedback: false,
};

const archivedProfile = {
  ...activeProfile,
  id: 2,
  name: 'Archived Lifter',
  status: 'archived' as const,
  archived_at: '2026-10-03T00:00:00Z',
};

const preview = {
  importId: 'import-42',
  manifest: {
    format: 'fitness-coach-profile-transfer',
    version: 1,
    created_at: '2026-10-10T00:00:00Z',
    schema_version: 2,
    profiles: [
      { id: 9, name: 'Imported Runner', status: 'active' },
      { id: 10, name: 'Imported Archive', status: 'archived' },
      { id: 11, name: 'Imported Walker', status: 'active' },
    ],
    counts: {
      profiles: 3, daily_entries: 7, weight_measurements: 4, meals: 5, meal_images: 3,
      food_items: 8, workouts: 2, exercises: 6, body_feedback: 1, recommendations: 3,
    },
    images: [],
  },
  profileStats: [
    {
      id: 9, name: 'Imported Runner', status: 'active', images: 2, reports: 1,
      records: {
        daily_entries: 3, weight_measurements: 2, meals: 2, meal_images: 2, food_items: 4,
        workouts: 1, exercises: 3, body_feedback: 1, recommendations: 1,
      },
    },
    {
      id: 10, name: 'Imported Archive', status: 'archived', images: 1, reports: 2,
      records: {
        daily_entries: 4, weight_measurements: 2, meals: 3, meal_images: 1, food_items: 4,
        workouts: 1, exercises: 3, body_feedback: 0, recommendations: 2,
      },
    },
    {
      id: 11, name: 'Imported Walker', status: 'active', images: 0, reports: 0,
      records: {
        daily_entries: 0, weight_measurements: 0, meals: 0, meal_images: 0, food_items: 0,
        workouts: 0, exercises: 0, body_feedback: 0, recommendations: 0,
      },
    },
  ],
  conflicts: [
    { type: 'profile_id', profileId: 9, existingProfileId: 1, incomingName: 'Imported Runner', existingName: 'Runner' },
    { type: 'profile_name', profileId: 10, existingProfileId: 2, incomingName: 'Imported Archive', existingName: 'Archived Lifter' },
    { type: 'profile_id', profileId: 11, existingProfileId: 3, incomingName: 'Imported Walker', existingName: 'Local Walker' },
  ],
};

const importResult = {
  results: [
    { sourceProfileId: 9, targetProfileId: 101, status: 'imported' as const },
    { sourceProfileId: 10, targetProfileId: 2, status: 'imported' as const },
    { sourceProfileId: 11, targetProfileId: 11, status: 'skipped' as const },
  ],
};

const { apiMock } = vi.hoisted(() => ({ apiMock: {
  listProfiles: vi.fn(),
  exportProfiles: vi.fn(),
  previewProfileImport: vi.fn(),
  executeProfileImport: vi.fn(),
  switchCurrentProfile: vi.fn(),
} }));

vi.mock('../api/client.js', () => ({ api: apiMock }));

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.listProfiles.mockResolvedValue([activeProfile, archivedProfile]);
  apiMock.exportProfiles.mockResolvedValue(undefined);
  apiMock.previewProfileImport.mockResolvedValue(preview);
  apiMock.executeProfileImport.mockResolvedValue(importResult);
});

afterEach(cleanup);

function renderPage(onProfilesChanged = vi.fn()) {
  render(<ProfileTransferPage currentProfile={activeProfile} onProfilesChanged={onProfilesChanged} />);
  return { onProfilesChanged };
}

async function uploadPackage(name = 'profiles.tar.gz') {
  const file = new File(['profile archive'], name, { type: 'application/gzip' });
  fireEvent.change(await screen.findByLabelText('选择档案包'), { target: { files: [file] } });
  await waitFor(() => expect(apiMock.previewProfileImport).toHaveBeenCalledWith(file));
  return file;
}

function chooseResolution(profileName: string, strategy: 'new' | 'overwrite' | 'skip' | 'cancel') {
  fireEvent.change(screen.getByLabelText(`${profileName} 的冲突处理`), { target: { value: strategy } });
}

describe('ProfileTransferPage', () => {
  it('loads active and archived profiles, disables an empty export, and exports one selected profile', async () => {
    renderPage();

    expect(await screen.findByText('Runner')).toBeTruthy();
    expect(screen.getByText('Archived Lifter')).toBeTruthy();
    expect(screen.getByText('启用')).toBeTruthy();
    expect(screen.getByText('已归档')).toBeTruthy();
    expect(apiMock.listProfiles).toHaveBeenCalledWith(expect.objectContaining({ status: 'all' }));

    const exportButton = screen.getByRole('button', { name: '导出所选档案' }) as HTMLButtonElement;
    expect(exportButton.disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('选择 Runner'));
    expect(exportButton.disabled).toBe(false);
    fireEvent.click(exportButton);

    await waitFor(() => expect(apiMock.exportProfiles).toHaveBeenCalledWith([1]));
  });

  it('exports every selected profile together', async () => {
    renderPage();

    fireEvent.click(await screen.findByLabelText('选择 Runner'));
    fireEvent.click(screen.getByLabelText('选择 Archived Lifter'));
    fireEvent.click(screen.getByRole('button', { name: '导出所选档案' }));

    await waitFor(() => expect(apiMock.exportProfiles).toHaveBeenCalledWith([1, 2]));
  });

  it('previews the selected package with profile status, statistics, and conflicts', async () => {
    renderPage();
    const file = await uploadPackage();

    expect(apiMock.previewProfileImport).toHaveBeenCalledWith(file);
    expect(await screen.findByRole('heading', { name: '导入预览' })).toBeTruthy();
    expect(screen.getAllByText('Imported Runner').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Imported Archive').length).toBeGreaterThan(0);
    expect(screen.getByText('状态：启用')).toBeTruthy();
    expect(screen.getByText('状态：已归档')).toBeTruthy();
    expect(screen.getByText('每日记录：3')).toBeTruthy();
    expect(screen.getByText('图片：2')).toBeTruthy();
    expect(screen.getByText('报告：1')).toBeTruthy();
    expect(screen.getByText('ID 冲突：Runner')).toBeTruthy();
    expect(screen.getByText('名称冲突：Archived Lifter')).toBeTruthy();
  });

  it('collects per-conflict resolutions, confirms execution, refreshes profiles, and keeps the current profile', async () => {
    const { onProfilesChanged } = renderPage();
    await uploadPackage();

    for (const profileName of ['Imported Runner', 'Imported Archive', 'Imported Walker']) {
      const select = screen.getByLabelText(`${profileName} 的冲突处理`) as HTMLSelectElement;
      expect(new Set(Array.from(select.options, (option) => option.value))).toEqual(new Set(['new', 'overwrite', 'skip', 'cancel']));
    }

    chooseResolution('Imported Runner', 'new');
    chooseResolution('Imported Archive', 'overwrite');
    chooseResolution('Imported Walker', 'skip');

    const executeButton = screen.getByRole('button', { name: '执行导入' }) as HTMLButtonElement;
    const newNameInput = screen.getByLabelText('Imported Runner 的新档案名称');
    fireEvent.change(newNameInput, { target: { value: '' } });
    expect(executeButton.disabled).toBe(true);
    fireEvent.change(newNameInput, { target: { value: 'Runner From Import' } });
    expect(executeButton.disabled).toBe(false);

    fireEvent.click(executeButton);
    expect(screen.getByRole('dialog', { name: '确认执行档案导入' })).toBeTruthy();
    expect(apiMock.executeProfileImport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));

    await waitFor(() => expect(apiMock.executeProfileImport).toHaveBeenCalledWith('import-42', [
      { profileId: 9, strategy: 'new', newName: 'Runner From Import' },
      { profileId: 10, strategy: 'overwrite' },
      { profileId: 11, strategy: 'skip' },
    ]));
    expect(await screen.findByText('导入完成')).toBeTruthy();
    expect(screen.getByText('已导入 2 个档案')).toBeTruthy();
    expect(screen.getByText('已跳过 1 个档案')).toBeTruthy();
    await waitFor(() => expect(apiMock.listProfiles).toHaveBeenCalledTimes(2));
    expect(onProfilesChanged).toHaveBeenCalledWith(activeProfile);
    expect(apiMock.switchCurrentProfile).not.toHaveBeenCalled();
    expect(screen.getByText('当前档案：Runner')).toBeTruthy();
  });

  it('does not execute when the confirmation is canceled', async () => {
    renderPage();
    await uploadPackage();
    chooseResolution('Imported Runner', 'overwrite');
    chooseResolution('Imported Archive', 'skip');
    chooseResolution('Imported Walker', 'overwrite');

    fireEvent.click(screen.getByRole('button', { name: '执行导入' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(apiMock.executeProfileImport).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: '确认执行档案导入' })).toBeNull();
  });

  it('shows API errors and does not report or refresh a failed import', async () => {
    apiMock.executeProfileImport.mockRejectedValue(new Error('档案导入失败，请重试'));
    const { onProfilesChanged } = renderPage();
    await uploadPackage();
    chooseResolution('Imported Runner', 'overwrite');
    chooseResolution('Imported Archive', 'skip');
    chooseResolution('Imported Walker', 'overwrite');

    fireEvent.click(screen.getByRole('button', { name: '执行导入' }));
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));

    expect((await screen.findByRole('alert')).textContent).toContain('档案导入失败，请重试');
    expect(onProfilesChanged).not.toHaveBeenCalled();
    expect(apiMock.listProfiles).toHaveBeenCalledTimes(1);
    expect(apiMock.switchCurrentProfile).not.toHaveBeenCalled();
  });
});
