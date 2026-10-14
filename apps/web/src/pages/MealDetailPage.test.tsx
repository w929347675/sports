// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MealDetailPage } from './MealDetailPage.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getDailyEntry: vi.fn(),
    recognizeMeal: vi.fn(),
    confirmFoodItems: vi.fn(),
  },
}));

vi.mock('../api/client.js', () => ({ api: apiMock }));

function meal(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    daily_entry_id: 1,
    eaten_at: '2026-09-28T12:00:00Z',
    meal_type: 'lunch',
    notes: '午餐',
    recognition_status: 'needs_review' as const,
    images: [{ id: 30, relative_path: 'meals/7/a.png', mime_type: 'image/png', file_size: 10 }],
    food_items: [{
      id: 12,
      meal_id: 7,
      name: '米饭',
      amount: 180,
      unit: 'g',
      cooking_method: '蒸',
      confidence: 0.8,
      needs_confirmation: true,
      is_user_confirmed: false,
      source: 'model' as const,
      notes: '估计',
    }],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MealDetailPage', () => {
  it('loads a meal without recognizing it, then recognizes once after an explicit click', async () => {
    const initialMeal = meal({ recognition_status: 'unrecognized', food_items: [] });
    const recognizedMeal = meal({ recognition_status: 'needs_review' });
    apiMock.getDailyEntry.mockResolvedValue({ id: 1, entry_date: '2026-09-28', status: 'training', status_note: '', weights: [], meals: [initialMeal], workouts: [], feedback: [] });
    apiMock.recognizeMeal.mockResolvedValue({ meal: recognizedMeal, food_items: recognizedMeal.food_items });

    render(<MealDetailPage date="2026-09-28" mealId={7} />);

    expect(await screen.findByRole('button', { name: '识别这餐' })).toBeTruthy();
    expect(screen.getAllByText('尚未识别').length).toBeGreaterThan(0);
    expect(apiMock.recognizeMeal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '识别这餐' }));

    await waitFor(() => expect(apiMock.recognizeMeal).toHaveBeenCalledTimes(1));
    expect(screen.getByDisplayValue('米饭')).toBeTruthy();
    expect(screen.getAllByText('待确认').length).toBeGreaterThan(0);
  });

  it('submits edited items and displays the confirmed state', async () => {
    const currentMeal = meal();
    apiMock.getDailyEntry.mockResolvedValue({ id: 1, entry_date: '2026-09-28', status: 'training', status_note: '', weights: [], meals: [currentMeal], workouts: [], feedback: [] });
    apiMock.confirmFoodItems.mockResolvedValue({
      meal: { ...currentMeal, recognition_status: 'confirmed' },
      food_items: [{ ...currentMeal.food_items[0], name: '糙米', is_user_confirmed: true, needs_confirmation: false, source: 'user' }],
    });

    render(<MealDetailPage date="2026-09-28" mealId={7} />);
    await screen.findByDisplayValue('米饭');
    fireEvent.change(screen.getByLabelText('食物名称 1'), { target: { value: '糙米' } });
    fireEvent.change(screen.getByLabelText('份量 1'), { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: '确认食物项目' }));

    await waitFor(() => expect(apiMock.confirmFoodItems).toHaveBeenCalledWith(7, {
      items: [{ id: 12, name: '糙米', amount: 200, unit: 'g', cooking_method: '蒸', confidence: 0.8, needs_confirmation: true, notes: '估计' }],
    }));
    expect((await screen.findAllByText('已确认')).length).toBeGreaterThan(0);
  });

  it('omits a deleted item from the confirmation body', async () => {
    const currentMeal = meal({ food_items: [
      ...meal().food_items,
      { id: 13, meal_id: 7, name: '鸡蛋', amount: 1, unit: '个', cooking_method: '煮', confidence: 0.7, needs_confirmation: true, is_user_confirmed: false, source: 'model' as const, notes: '' },
    ] });
    apiMock.getDailyEntry.mockResolvedValue({ id: 1, entry_date: '2026-09-28', status: 'training', status_note: '', weights: [], meals: [currentMeal], workouts: [], feedback: [] });
    apiMock.confirmFoodItems.mockResolvedValue({ meal: { ...currentMeal, recognition_status: 'confirmed' }, food_items: [currentMeal.food_items[0]] });

    render(<MealDetailPage date="2026-09-28" mealId={7} />);
    await screen.findByDisplayValue('鸡蛋');
    fireEvent.click(screen.getByRole('button', { name: '删除食物项目 2' }));
    fireEvent.click(screen.getByRole('button', { name: '确认食物项目' }));

    await waitFor(() => expect(apiMock.confirmFoodItems).toHaveBeenCalledWith(7, {
      items: [{ id: 12, name: '米饭', amount: 180, unit: 'g', cooking_method: '蒸', confidence: 0.8, needs_confirmation: true, notes: '估计' }],
    }));
  });

  it('marks a meal failed after recognition errors while preserving its draft', async () => {
    const currentMeal = meal();
    apiMock.getDailyEntry.mockResolvedValue({ id: 1, entry_date: '2026-09-28', status: 'training', status_note: '', weights: [], meals: [currentMeal], workouts: [], feedback: [] });
    apiMock.recognizeMeal.mockRejectedValue(new Error('识别服务暂时不可用'));

    render(<MealDetailPage date="2026-09-28" mealId={7} />);
    await screen.findByDisplayValue('米饭');
    fireEvent.click(screen.getByRole('button', { name: '识别这餐' }));

    expect(await screen.findByText('识别服务暂时不可用')).toBeTruthy();
    expect(screen.getAllByText('识别失败').length).toBeGreaterThan(0);
    expect(screen.getByDisplayValue('米饭')).toBeTruthy();
  });

  it('distinguishes model estimates from human-confirmed food items', async () => {
    const currentMeal = meal({ food_items: [
      { ...meal().food_items[0], needs_confirmation: false, is_user_confirmed: false, source: 'model' as const },
      { ...meal().food_items[0], id: 13, name: '鸡蛋', needs_confirmation: false, is_user_confirmed: true, source: 'user' as const },
    ] });
    apiMock.getDailyEntry.mockResolvedValue({ id: 1, entry_date: '2026-09-28', status: 'training', status_note: '', weights: [], meals: [currentMeal], workouts: [], feedback: [] });

    render(<MealDetailPage date="2026-09-28" mealId={7} />);

    expect(await screen.findByText('模型估计 / 待确认')).toBeTruthy();
    expect(screen.getByText('人工确认')).toBeTruthy();
  });

  it('keeps confirmed items in the confirmation body while allowing model drafts to be deleted', async () => {
    const currentMeal = meal({ food_items: [
      { ...meal().food_items[0], needs_confirmation: false, is_user_confirmed: true, source: 'user' as const },
      { ...meal().food_items[0], id: 13, name: '鸡蛋', needs_confirmation: true, is_user_confirmed: false, source: 'model' as const },
    ] });
    apiMock.getDailyEntry.mockResolvedValue({ id: 1, entry_date: '2026-09-28', status: 'training', status_note: '', weights: [], meals: [currentMeal], workouts: [], feedback: [] });
    apiMock.confirmFoodItems.mockResolvedValue({ meal: { ...currentMeal, recognition_status: 'confirmed' }, food_items: currentMeal.food_items });

    render(<MealDetailPage date="2026-09-28" mealId={7} />);
    await screen.findByDisplayValue('鸡蛋');
    expect(screen.queryByRole('button', { name: '删除食物项目 1' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '删除食物项目 2' }));
    fireEvent.click(screen.getByRole('button', { name: '确认食物项目' }));

    await waitFor(() => expect(apiMock.confirmFoodItems).toHaveBeenCalledWith(7, {
      items: [{ id: 12, name: '米饭', amount: 180, unit: 'g', cooking_method: '蒸', confidence: 0.8, needs_confirmation: false, notes: '估计' }],
    }));
  });

  it('does not show a confirmation editor for a failed meal with no model draft', async () => {
    const currentMeal = meal({ recognition_status: 'failed', food_items: [{ ...meal().food_items[0], needs_confirmation: false, is_user_confirmed: true, source: 'user' as const }] });
    apiMock.getDailyEntry.mockResolvedValue({ id: 1, entry_date: '2026-09-28', status: 'training', status_note: '', weights: [], meals: [currentMeal], workouts: [], feedback: [] });

    render(<MealDetailPage date="2026-09-28" mealId={7} />);

    expect((await screen.findAllByText('识别失败')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: '确认食物项目' })).toBeNull();
    expect(screen.getByText('识别失败后没有可确认的识别草稿，请重试识别。')).toBeTruthy();
    expect(screen.getByText('米饭')).toBeTruthy();
  });

  it('disables confirmation while a recognition request is processing', async () => {
    const currentMeal = meal();
    let resolveRecognition: (value: { meal: typeof currentMeal; food_items: typeof currentMeal.food_items }) => void = () => undefined;
    apiMock.getDailyEntry.mockResolvedValue({ id: 1, entry_date: '2026-09-28', status: 'training', status_note: '', weights: [], meals: [currentMeal], workouts: [], feedback: [] });
    apiMock.recognizeMeal.mockReturnValue(new Promise((resolve) => { resolveRecognition = resolve; }));

    render(<MealDetailPage date="2026-09-28" mealId={7} />);
    await screen.findByDisplayValue('米饭');
    fireEvent.click(screen.getByRole('button', { name: '识别这餐' }));

    expect((await screen.findAllByText('识别中')).length).toBeGreaterThan(0);
    expect((screen.getByRole('button', { name: '确认食物项目' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('食物名称 1') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '确认食物项目' }));
    expect(apiMock.confirmFoodItems).not.toHaveBeenCalled();
    resolveRecognition({ meal: { ...currentMeal, recognition_status: 'needs_review' }, food_items: currentMeal.food_items });
    await waitFor(() => expect(screen.getByRole('button', { name: '确认食物项目' })).toBeTruthy());
  });

  it('disables recognition and editing while a confirmation request is saving', async () => {
    const currentMeal = meal();
    type ConfirmationResult = { meal: Omit<typeof currentMeal, 'recognition_status'> & { recognition_status: 'needs_review' | 'confirmed' }; food_items: typeof currentMeal.food_items };
    let resolveConfirmation: (value: ConfirmationResult) => void = () => undefined;
    apiMock.getDailyEntry.mockResolvedValue({ id: 1, entry_date: '2026-09-28', status: 'training', status_note: '', weights: [], meals: [currentMeal], workouts: [], feedback: [] });
    apiMock.confirmFoodItems.mockReturnValue(new Promise((resolve) => { resolveConfirmation = resolve; }));

    render(<MealDetailPage date="2026-09-28" mealId={7} />);
    await screen.findByDisplayValue('米饭');
    fireEvent.click(screen.getByRole('button', { name: '确认食物项目' }));

    expect((screen.getByRole('button', { name: '识别这餐' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('食物名称 1') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '识别这餐' }));
    expect(apiMock.recognizeMeal).not.toHaveBeenCalled();

    resolveConfirmation({ meal: { ...currentMeal, recognition_status: 'confirmed' }, food_items: currentMeal.food_items });
    await waitFor(() => expect(screen.getAllByText('已确认').length).toBeGreaterThan(0));
  });
});
