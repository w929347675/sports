// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DailyEntryPage, localDate } from './DailyEntryPage.js';

const { apiMock } = vi.hoisted(() => ({ apiMock: {
  getDailyEntry: vi.fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValue({ id: 1, entry_date: '2026-09-28', status: 'training', status_note: '', weights: [], meals: [], workouts: [], feedback: [] }),
  saveDailyEntry: vi.fn().mockResolvedValue({ id: 1, entry_date: '2026-09-28', status: 'training', status_note: '' }),
  createWeight: vi.fn().mockResolvedValue({ id: 1 }),
  createMeal: vi.fn().mockResolvedValue({ id: 1 }),
  createWorkout: vi.fn().mockResolvedValue({ id: 1 }),
  createExercise: vi.fn().mockResolvedValue({ id: 1 }),
  createFeedback: vi.fn().mockResolvedValue({ id: 1 }),
  uploadMealImage: vi.fn().mockResolvedValue({ id: 1 }),
} }));

vi.mock('../api/client.js', () => ({ api: apiMock, entryTimestamp: (date: string) => `${date}T12:00:00Z` }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  apiMock.getDailyEntry
    .mockResolvedValueOnce(null)
    .mockResolvedValue({ id: 1, entry_date: '2026-09-28', status: 'training', status_note: '', weights: [], meals: [], workouts: [], feedback: [] });
});

describe('DailyEntryPage', () => {
  it('requires an explicitly saved daily status before saving child records', async () => {
    render(<DailyEntryPage date="2026-09-28" />);
    await screen.findByRole('heading', { name: '记录今天的状态' });

    const saveWeight = screen.getByRole('button', { name: '保存体重' });
    expect((saveWeight as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('请先保存当天状态，再添加体重、餐次、训练或反馈。')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '保存当天状态' }));
    fireEvent.change(screen.getByLabelText('体重（kg）'), { target: { value: '72.5' } });
    await waitFor(() => expect((saveWeight as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText('请先保存当天状态，再添加体重、餐次、训练或反馈。')).toBeNull();
  });

  it('formats a selected date using the local calendar date', () => {
    const selected = new Date(2026, 8, 28, 23, 30, 0);
    expect(localDate(selected)).toBe('2026-09-28');
  });

  it('saves child records with a timezone-qualified timestamp', async () => {
    apiMock.getDailyEntry.mockReset();
    apiMock.getDailyEntry.mockResolvedValue({ id: 1, entry_date: '2026-09-28', status: 'training', status_note: '', weights: [], meals: [], workouts: [], feedback: [] });
    render(<DailyEntryPage date="2026-09-28" />);
    await screen.findByRole('heading', { name: '记录今天的状态' });
    fireEvent.change(screen.getByLabelText('体重（kg）'), { target: { value: '72.5' } });
    fireEvent.click(screen.getByRole('button', { name: '保存体重' }));

    await waitFor(() => expect(apiMock.createWeight).toHaveBeenCalledWith('2026-09-28', expect.objectContaining({ measured_at: expect.stringMatching(/(?:Z|[+-]\d\d:\d\d)$/) })));
  });
});
