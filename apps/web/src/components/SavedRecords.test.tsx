// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DailyEntryView } from '../api/client.js';
import { SavedRecords } from './SavedRecords.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    patchWeight: vi.fn().mockResolvedValue({ id: 1, measured_at: '2026-09-28T12:00:00', weight_kg: 71.8, note: '' }),
    deleteWeight: vi.fn().mockResolvedValue({ id: 1 }),
    patchMeal: vi.fn().mockResolvedValue({ id: 2 }),
    deleteMeal: vi.fn().mockResolvedValue({ id: 2 }),
    uploadMealImage: vi.fn().mockResolvedValue({ id: 3 }),
    recognizeMealsBatch: vi.fn(),
    patchWorkout: vi.fn().mockResolvedValue({ id: 4 }),
    deleteWorkout: vi.fn().mockResolvedValue({ id: 4 }),
    patchFeedback: vi.fn().mockResolvedValue({ id: 5 }),
    deleteFeedback: vi.fn().mockResolvedValue({ id: 5 }),
  },
}));

vi.mock('../api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../api/client.js')>('../api/client.js');
  return { ...actual, api: apiMock };
});

const entry = {
  id: 1,
  entry_date: '2026-09-28',
  status: 'training' as const,
  status_note: '',
  weights: [{ id: 1, daily_entry_id: 1, measured_at: '2026-09-28T12:00:00', weight_kg: 72, note: '' }],
  meals: [{ id: 2, daily_entry_id: 1, eaten_at: '2026-09-28T12:00:00', meal_type: 'lunch', notes: '午餐', recognition_status: 'unrecognized' as const, images: [], food_items: [] }],
  workouts: [],
  feedback: [],
} satisfies DailyEntryView;

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('SavedRecords', () => {
  it('edits a saved weight and exposes existing meal image upload', async () => {
    render(<SavedRecords date="2026-09-28" entry={entry} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '编辑体重' }));
    fireEvent.change(screen.getByLabelText('编辑体重'), { target: { value: '71.8' } });
    fireEvent.click(screen.getByRole('button', { name: '保存体重修改' }));
    await waitFor(() => expect(apiMock.patchWeight).toHaveBeenCalledWith('2026-09-28', { id: 1, weight_kg: 71.8 }));
    expect(screen.getByLabelText('为午餐添加本地图片')).toBeTruthy();
  });

  it('shows an error and releases the edit state when a saved record update fails', async () => {
    apiMock.patchWeight.mockRejectedValueOnce(new Error('本地服务暂时不可用'));
    render(<SavedRecords date="2026-09-28" entry={entry} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '编辑体重' }));
    fireEvent.click(screen.getByRole('button', { name: '保存体重修改' }));

    expect((await screen.findByRole('alert')).textContent).toContain('本地服务暂时不可用');
    expect((screen.getByRole('button', { name: '保存体重修改' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('recognizes selected meals in one batch request and reports an individual failure', async () => {
    const twoMealEntry = {
      ...entry,
      meals: [
        entry.meals[0],
        { ...entry.meals[0], id: 3, meal_type: 'dinner', notes: '晚餐' },
      ],
    } satisfies DailyEntryView;
    apiMock.recognizeMealsBatch.mockResolvedValue([
      { mealId: 2, status: 'success', data: { meal: { id: 2, recognition_status: 'needs_review' }, food_items: [] } },
      { mealId: 3, status: 'failed', error: { code: 'AI_TIMEOUT', message: '识别超时' } },
    ]);

    render(<SavedRecords date="2026-09-28" entry={twoMealEntry} onChanged={vi.fn()} />);
    fireEvent.click(screen.getAllByLabelText('选择午餐进行识别')[0]);
    fireEvent.click(screen.getByLabelText('选择晚餐进行识别'));
    fireEvent.click(screen.getByRole('button', { name: '识别选中餐次' }));

    await waitFor(() => expect(apiMock.recognizeMealsBatch).toHaveBeenCalledTimes(1));
    expect(apiMock.recognizeMealsBatch).toHaveBeenCalledWith([2, 3]);
    expect(await screen.findByText('晚餐：识别失败：识别超时')).toBeTruthy();
    expect(screen.getByText('午餐：识别成功')).toBeTruthy();
  });

  it('does not render batch selection for processing or confirmed meals', () => {
    const statusEntry = {
      ...entry,
      meals: [
        { ...entry.meals[0], recognition_status: 'processing' as const, meal_type: 'lunch', notes: '处理中' },
        { ...entry.meals[0], id: 3, recognition_status: 'confirmed' as const, meal_type: 'dinner', notes: '已确认餐' },
      ],
    } satisfies DailyEntryView;

    render(<SavedRecords date="2026-09-28" entry={statusEntry} onChanged={vi.fn()} />);

    expect(screen.queryByLabelText('选择午餐进行识别')).toBeNull();
    expect(screen.queryByLabelText('选择晚餐进行识别')).toBeNull();
  });
});
