// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getProfile: vi.fn().mockResolvedValue(null),
    getCurrentProfile: vi.fn().mockResolvedValue({ profile: null }),
    listProfiles: vi.fn().mockResolvedValue([]),
    switchCurrentProfile: vi.fn(),
    getModelSettings: vi.fn().mockResolvedValue({ configured: false }),
    getDailyEntry: vi.fn().mockResolvedValue(null),
    listDailyEntries: vi.fn().mockResolvedValue([]),
    saveProfile: vi.fn().mockResolvedValue({ id: 1 }),
    saveModelSettings: vi.fn().mockResolvedValue({ configured: true, modelName: 'local' }),
    saveDailyEntry: vi.fn().mockResolvedValue({ id: 1, entry_date: '2026-09-28', status: 'training' }),
    createWeight: vi.fn().mockResolvedValue({ id: 1 }),
    createMeal: vi.fn().mockResolvedValue({ id: 1 }),
    createWorkout: vi.fn().mockResolvedValue({ id: 1 }),
    createFeedback: vi.fn().mockResolvedValue({ id: 1 }),
    recognizeMeal: vi.fn(),
    recognizeMealsBatch: vi.fn(),
    confirmFoodItems: vi.fn(),
  },
}));

vi.mock('./api/client.js', () => ({
  api: apiMock,
}));

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
  vi.clearAllMocks();
  apiMock.getProfile.mockResolvedValue(null);
  apiMock.getDailyEntry.mockResolvedValue(null);
});

describe('App', () => {
  it('routes a first-time user to the profile page before the workbench', async () => {
    apiMock.saveProfile.mockResolvedValueOnce({
      id: 1, name: '默认档案', status: 'active', goal: 'maintain', goal_description: '', height_cm: 175, age: 30,
      sex: 'unspecified', training_experience: '初学', equipment: '无', training_days_per_week: 3,
      session_duration_minutes: 45, diet_preferences: '', allergies: '', health_restrictions: '',
      created_at: '2026-10-10T00:00:00Z', updated_at: '2026-10-10T00:00:00Z', archived_at: null,
    });
    render(<App />);

    expect(await screen.findByRole('heading', { name: '建立你的健身档案' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '今日工作台' })).toBeNull();

    fireEvent.change(screen.getByLabelText('目标'), { target: { value: 'maintain' } });
    fireEvent.change(screen.getByLabelText('训练经验'), { target: { value: '初学' } });
    fireEvent.change(screen.getByLabelText('器械与场地'), { target: { value: '无' } });
    fireEvent.click(screen.getByRole('button', { name: '保存档案' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: '今日工作台' })).toBeTruthy());
    expect(screen.getByLabelText('当前档案').textContent).toContain('默认档案');
  });

  it('opens a meal detail page on direct access with the meal query', async () => {
    window.history.replaceState({}, '', '/entry/2026-09-28?meal=7');
    apiMock.getProfile.mockResolvedValue({ id: 1 });
    apiMock.getDailyEntry.mockResolvedValue({
      id: 1,
      entry_date: '2026-09-28',
      status: 'training',
      status_note: '',
      weights: [],
      meals: [{ id: 7, daily_entry_id: 1, eaten_at: '2026-09-28T12:00:00Z', meal_type: 'lunch', notes: '午餐', recognition_status: 'unrecognized', images: [], food_items: [] }],
      workouts: [],
      feedback: [],
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '午餐' })).toBeTruthy();
    expect(apiMock.recognizeMeal).not.toHaveBeenCalled();
  });

  it('shows the current profile context and available active profiles', async () => {
    apiMock.getProfile.mockResolvedValue({ id: 1, goal: 'maintain' });
    apiMock.getCurrentProfile.mockResolvedValue({ profile: {
      id: 1, name: '默认档案', status: 'active', goal: 'maintain', goal_description: '',
      height_cm: 175, age: 30, sex: 'unspecified', training_experience: 'beginner', equipment: 'home',
      training_days_per_week: 3, session_duration_minutes: 45, diet_preferences: '', allergies: '', health_restrictions: '',
      created_at: '2026-10-10T00:00:00Z', updated_at: '2026-10-10T00:00:00Z', archived_at: null,
    }});
    apiMock.listProfiles.mockResolvedValue([{ id: 1, name: '默认档案', status: 'active' }]);

    render(<App />);

    expect((await screen.findByLabelText('当前档案')).textContent).toContain('默认档案');
    expect(screen.getByLabelText('切换档案')).toBeTruthy();
  });

  it('finds the meal query regardless of query order and extra parameters', async () => {
    window.history.replaceState({}, '', '/entry/2026-09-28?source=history&meal=7&view=full');
    apiMock.getProfile.mockResolvedValue({ id: 1 });
    apiMock.getDailyEntry.mockResolvedValue({
      id: 1,
      entry_date: '2026-09-28',
      status: 'training',
      status_note: '',
      weights: [],
      meals: [{ id: 7, daily_entry_id: 1, eaten_at: '2026-09-28T12:00:00Z', meal_type: 'lunch', notes: '历史午餐', recognition_status: 'unrecognized', images: [], food_items: [] }],
      workouts: [],
      feedback: [],
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '历史午餐' })).toBeTruthy();
  });
});
