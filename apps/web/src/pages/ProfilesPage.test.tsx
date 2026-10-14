// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProfilesPage } from './ProfilesPage.js';

const profile = {
  id: 1, name: 'Runner', status: 'active' as const, goal: 'maintain' as const, goal_description: '',
  height_cm: 175, age: 30, sex: 'unspecified' as const, training_experience: 'beginner', equipment: 'home',
  training_days_per_week: 3, session_duration_minutes: 45, diet_preferences: '', allergies: '', health_restrictions: '',
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z', archived_at: null,
  last_entry_at: '2026-10-02', last_recommendation_at: null, record_days: 2, report_count: 0,
  has_unconfirmed_diet: false, has_high_risk_feedback: false,
};

const { apiMock } = vi.hoisted(() => ({ apiMock: {
  listProfiles: vi.fn(),
  createProfile: vi.fn(),
  archiveProfile: vi.fn(),
  restoreProfile: vi.fn(),
  deleteProfiles: vi.fn(),
} }));

vi.mock('../api/client.js', () => ({ api: apiMock }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('ProfilesPage', () => {
  it('loads server filters, shows summaries and current profile, and supports select all', async () => {
    apiMock.listProfiles.mockResolvedValue([profile]);
    render(<ProfilesPage currentProfile={profile} onProfilesChanged={vi.fn()} navigate={vi.fn()} />);

    expect(await screen.findByText('Runner')).toBeTruthy();
    expect(screen.getByText('当前档案')).toBeTruthy();
    expect(screen.getByText('记录 2 天')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('状态筛选'), { target: { value: 'all' } });
    await waitFor(() => expect(apiMock.listProfiles).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'all' })));
    fireEvent.click(screen.getByLabelText('全选档案'));
    expect((screen.getByLabelText('选择 Runner') as HTMLInputElement).checked).toBe(true);
  });

  it('creates a complete profile and switches to it through the page callback', async () => {
    apiMock.listProfiles.mockResolvedValue([]);
    apiMock.createProfile.mockResolvedValue(profile);
    const onProfilesChanged = vi.fn();
    render(<ProfilesPage currentProfile={null} onProfilesChanged={onProfilesChanged} navigate={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: '新增档案' }));
    fireEvent.change(screen.getByLabelText('档案名称'), { target: { value: 'Runner' } });
    fireEvent.change(screen.getByLabelText('训练经验'), { target: { value: 'beginner' } });
    fireEvent.change(screen.getByLabelText('器械与场地'), { target: { value: 'home' } });
    fireEvent.click(screen.getByRole('button', { name: '创建并切换' }));

    await waitFor(() => expect(apiMock.createProfile).toHaveBeenCalledWith(expect.objectContaining({ name: 'Runner' })));
    expect(onProfilesChanged).toHaveBeenCalledWith(profile);
  });

  it('requires confirmation before archive and restore operations', async () => {
    const archived = { ...profile, id: 2, name: 'Archive', status: 'archived' as const, archived_at: '2026-10-03T00:00:00Z' };
    apiMock.listProfiles.mockResolvedValue([archived]);
    apiMock.restoreProfile.mockResolvedValue({ ...archived, status: 'active' });
    render(<ProfilesPage currentProfile={profile} onProfilesChanged={vi.fn()} navigate={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('状态筛选'), { target: { value: 'all' } });
    await waitFor(() => expect(screen.getByText('Archive')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '恢复 Archive' }));
    expect(apiMock.restoreProfile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认恢复' }));
    await waitFor(() => expect(apiMock.restoreProfile).toHaveBeenCalledWith(2));
  });
});
