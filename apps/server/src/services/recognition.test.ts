import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiClientError, type AiConfig, type AiRequestOptions, type MealRecognizer } from '@fitness-coach/ai';
import { createRepositories, migrate } from '@fitness-coach/db';
import { createRecognitionService } from './recognition.js';

const recognizedMeal = {
  items: [{
    name: 'Chicken breast', amount: 150, unit: 'g', confidence: 0.8,
    needsConfirmation: false, notes: 'Estimated from image',
  }],
  cookingMethod: 'grilled',
  uncertainties: [],
};

describe('recognition service', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  async function setup() {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-recognition-'));
    await mkdir(join(dataDir, 'images'));
    const db = new Database(':memory:');
    migrate(db);
    const repositories = createRepositories(db);
    const profile = repositories.profiles.create({
      name: 'Default', goal: 'maintain', goal_description: '', height_cm: 175, age: 30, sex: 'unspecified',
      training_experience: 'beginner', equipment: 'home', training_days_per_week: 3,
      session_duration_minutes: 45, diet_preferences: '', allergies: '', health_restrictions: '',
    });
    repositories.profiles.setCurrentId(profile.id);
    const entry = repositories.dailyEntry.save({ entry_date: '2026-09-28', status: 'training' });
    cleanups.push(async () => {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    return { dataDir, repositories, entry };
  }

  function saveMeal(repositories: Awaited<ReturnType<typeof setup>>['repositories'], entryId: number, notes = 'large portion') {
    return repositories.meal.save(entryId, {
      eaten_at: '2026-09-28T12:00:00Z',
      meal_type: 'lunch',
      notes,
      recognition_status: 'unrecognized',
    });
  }

  async function addImage(
    dataDir: string,
    repositories: Awaited<ReturnType<typeof setup>>['repositories'],
    mealId: number,
    filename: string,
    bytes: Buffer,
    mimeType = 'image/png',
  ) {
    await writeFile(join(dataDir, 'images', filename), bytes);
    return repositories.image.register(mealId, {
      relative_path: `images/${filename}`,
      mime_type: mimeType,
      file_size: bytes.length,
    });
  }

  it('sends only the selected meal images in database order and stores model drafts', async () => {
    const { dataDir, repositories, entry } = await setup();
    const meal = saveMeal(repositories, entry.id);
    const otherMeal = saveMeal(repositories, entry.id, 'historical meal');
    await addImage(dataDir, repositories, meal.id, 'first.png', Buffer.from('first'));
    await addImage(dataDir, repositories, meal.id, 'second.webp', Buffer.from('second'), 'image/webp');
    for (let index = 0; index < 30; index += 1) {
      await addImage(dataDir, repositories, otherMeal.id, `history-${index}.png`, Buffer.from(`history-${index}`));
    }
    const oldDraft = repositories.foodItem.save(meal.id, {
      name: 'Old draft', amount: 1, unit: 'portion', cooking_method: '', confidence: 0.4,
      needs_confirmation: true, is_user_confirmed: false, source: 'model', notes: '',
    });
    const confirmed = repositories.foodItem.save(meal.id, {
      name: 'User-confirmed item', amount: 2, unit: 'pieces', cooking_method: 'boiled', confidence: 1,
      needs_confirmation: false, is_user_confirmed: true, source: 'user', notes: '',
    });
    const recognizer = vi.fn<MealRecognizer>().mockResolvedValue(recognizedMeal);
    const service = createRecognitionService({ repositories, dataDir }, { recognizer });

    const result = await service.recognize(meal.id);

    expect(recognizer).toHaveBeenCalledTimes(1);
    expect(recognizer).toHaveBeenCalledWith({
      mealText: 'large portion',
      userPortion: 'large portion',
      images: [
        { base64: Buffer.from('first').toString('base64'), mimeType: 'image/png' },
        { base64: Buffer.from('second').toString('base64'), mimeType: 'image/webp' },
      ],
    });
    expect(result.meal.recognition_status).toBe('needs_review');
    expect(result.food_items).toEqual([
      expect.objectContaining({ id: confirmed.id, name: 'User-confirmed item' }),
      expect.objectContaining({
        name: 'Chicken breast', amount: 150, cooking_method: 'grilled', source: 'model',
        is_user_confirmed: false, needs_confirmation: false,
      }),
    ]);
    expect(result.food_items.map(({ id }) => id)).not.toContain(oldDraft.id);
    expect(repositories.image.listForEntry(meal.id)).toHaveLength(2);
    expect(repositories.image.listForEntry(otherMeal.id)).toHaveLength(30);
  });

  it('passes a two-minute timeout to the production meal recognizer', async () => {
    const { dataDir, repositories, entry } = await setup();
    const meal = saveMeal(repositories, entry.id);
    await addImage(dataDir, repositories, meal.id, 'meal.png', Buffer.from('meal'));
    const recognizer = vi.fn<MealRecognizer>().mockResolvedValue(recognizedMeal);
    const recognizerFactory = vi.fn((_config: AiConfig, _options?: AiRequestOptions) => recognizer);
    const service = createRecognitionService({ repositories, dataDir }, {
      recognizerFactory,
      getModelCredentials: vi.fn().mockResolvedValue({ baseUrl: 'http://model.test/v1', modelName: 'vision', apiKey: 'secret' }),
    });

    await service.recognize(meal.id);

    expect(recognizerFactory).toHaveBeenCalledWith(
      { baseUrl: 'http://model.test/v1', modelName: 'vision', apiKey: 'secret' },
      { timeoutMs: 120_000 },
    );
  });

  it('sets processing before awaiting the model and rejects a duplicate call without invoking it twice', async () => {
    const { dataDir, repositories, entry } = await setup();
    const meal = saveMeal(repositories, entry.id);
    await addImage(dataDir, repositories, meal.id, 'meal.png', Buffer.from('meal'));
    let resolveRecognition: (value: typeof recognizedMeal) => void = () => undefined;
    const recognizer = vi.fn<MealRecognizer>().mockImplementation(() => new Promise((resolve) => {
      resolveRecognition = resolve;
    }));
    const service = createRecognitionService({ repositories, dataDir }, { recognizer });

    const first = service.recognize(meal.id);
    expect(repositories.meal.get(meal.id)?.recognition_status).toBe('processing');
    await vi.waitFor(() => expect(recognizer).toHaveBeenCalledTimes(1));
    await expect(service.recognize(meal.id)).rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
    expect(recognizer).toHaveBeenCalledTimes(1);
    resolveRecognition(recognizedMeal);
    await expect(first).resolves.toMatchObject({ meal: { recognition_status: 'needs_review' } });
  });

  it.each([
    ['AI_TIMEOUT', 'timed out'],
    ['AI_AUTHENTICATION_FAILED', 'authentication failed'],
    ['AI_INVALID_JSON', 'invalid JSON'],
  ] as const)('maps %s to a readable error without exposing secrets and preserves local data', async (code, expectedMessage) => {
    const { dataDir, repositories, entry } = await setup();
    const meal = saveMeal(repositories, entry.id);
    const image = await addImage(dataDir, repositories, meal.id, 'meal.png', Buffer.from('original-image'));
    const existing = repositories.foodItem.save(meal.id, {
      name: 'Existing item', amount: 1, unit: 'bowl', cooking_method: '', confidence: 1,
      needs_confirmation: false, is_user_confirmed: true, source: 'user', notes: '',
    });
    const recognizer = vi.fn<MealRecognizer>().mockRejectedValue(new AiClientError(code, 'secret sk-do-not-leak'));
    const service = createRecognitionService({ repositories, dataDir }, { recognizer });

    await expect(service.recognize(meal.id)).rejects.toMatchObject({ code, message: expect.stringContaining(expectedMessage) });
    expect(repositories.meal.get(meal.id)?.recognition_status).toBe('failed');
    expect(repositories.foodItem.listForEntry(meal.id)).toEqual([expect.objectContaining({ id: existing.id })]);
    expect(repositories.image.get(image.id!)).toMatchObject({ id: image.id });
  });

  it('marks missing configuration or image failures as failed without calling the recognizer', async () => {
    const { dataDir, repositories, entry } = await setup();
    const missingConfigurationMeal = saveMeal(repositories, entry.id);
    const credentialsError = Object.assign(new Error('Model configuration is incomplete'), {
      code: 'CONFIGURATION_ERROR', statusCode: 503,
    });
    const getModelCredentials = vi.fn().mockRejectedValue(credentialsError);
    const service = createRecognitionService({ repositories, dataDir }, { getModelCredentials });

    await expect(service.recognize(missingConfigurationMeal.id)).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    expect(repositories.meal.get(missingConfigurationMeal.id)?.recognition_status).toBe('failed');
    expect(getModelCredentials).toHaveBeenCalledTimes(1);

    const missingImageMeal = saveMeal(repositories, entry.id);
    repositories.image.register(missingImageMeal.id, {
      relative_path: 'images/missing.png', mime_type: 'image/png', file_size: 10,
    });
    const recognizer = vi.fn<MealRecognizer>();
    const imageService = createRecognitionService({ repositories, dataDir }, { recognizer });
    await expect(imageService.recognize(missingImageMeal.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(repositories.meal.get(missingImageMeal.id)?.recognition_status).toBe('failed');
    expect(recognizer).not.toHaveBeenCalled();
  });

  it('marks an image-less recognition as failed without invoking the model', async () => {
    const { dataDir, repositories, entry } = await setup();
    const meal = saveMeal(repositories, entry.id);
    const recognizer = vi.fn<MealRecognizer>();
    const service = createRecognitionService({ repositories, dataDir }, { recognizer });

    await expect(service.recognize(meal.id)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Meal recognition requires at least one image',
    });
    expect(repositories.meal.get(meal.id)?.recognition_status).toBe('failed');
    expect(recognizer).not.toHaveBeenCalled();
  });

  it('rejects more than 12 selected images before reading files or invoking the model', async () => {
    const { dataDir, repositories, entry } = await setup();
    const meal = saveMeal(repositories, entry.id);
    const images = [];
    for (let index = 0; index < 13; index += 1) {
      images.push(await addImage(dataDir, repositories, meal.id, `selected-${index}.png`, Buffer.from(`selected-${index}`)));
    }
    const recognizer = vi.fn<MealRecognizer>();
    const service = createRecognitionService({ repositories, dataDir }, { recognizer });

    await expect(service.recognize(meal.id)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Meal recognition supports at most 12 images',
    });
    expect(recognizer).not.toHaveBeenCalled();
    expect(repositories.meal.get(meal.id)?.recognition_status).toBe('failed');
    expect(repositories.image.listForEntry(meal.id)).toEqual(images);
    await expect(Promise.all(images.map((image) => import('node:fs/promises').then(({ readFile }) => readFile(join(dataDir, image.relative_path)))))).resolves.toHaveLength(13);
  });

  it('rejects selected image metadata over 20 MiB before reading files or invoking the model', async () => {
    const { dataDir, repositories, entry } = await setup();
    const meal = saveMeal(repositories, entry.id);
    const first = await addImage(dataDir, repositories, meal.id, 'first.png', Buffer.from('first'));
    const second = await addImage(dataDir, repositories, meal.id, 'second.png', Buffer.from('second'));
    repositories.image.update(first.id, { file_size: 10 * 1024 * 1024 });
    repositories.image.update(second.id, { file_size: 10 * 1024 * 1024 + 1 });
    const recognizer = vi.fn<MealRecognizer>();
    const service = createRecognitionService({ repositories, dataDir }, { recognizer });

    await expect(service.recognize(meal.id)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Meal recognition images exceed the 20 MiB total limit',
    });
    expect(recognizer).not.toHaveBeenCalled();
    expect(repositories.meal.get(meal.id)?.recognition_status).toBe('failed');
    expect(repositories.image.listForEntry(meal.id)).toHaveLength(2);
  });

  it('rejects selected image files over 20 MiB even when database metadata is within the limit', async () => {
    const { dataDir, repositories, entry } = await setup();
    const meal = saveMeal(repositories, entry.id);
    const first = await addImage(dataDir, repositories, meal.id, 'first.png', Buffer.alloc(10 * 1024 * 1024 + 1));
    const second = await addImage(dataDir, repositories, meal.id, 'second.png', Buffer.alloc(10 * 1024 * 1024 + 1));
    repositories.image.update(first.id, { file_size: 10 * 1024 * 1024 });
    repositories.image.update(second.id, { file_size: 10 * 1024 * 1024 });
    const existing = repositories.foodItem.save(meal.id, {
      name: 'Existing item', amount: 1, unit: 'bowl', cooking_method: '', confidence: 1,
      needs_confirmation: false, is_user_confirmed: true, source: 'user', notes: '',
    });
    const recognizer = vi.fn<MealRecognizer>().mockResolvedValue(recognizedMeal);
    const service = createRecognitionService({ repositories, dataDir }, { recognizer });

    await expect(service.recognize(meal.id)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Meal recognition images exceed the 20 MiB total limit',
    });
    expect(recognizer).not.toHaveBeenCalled();
    expect(repositories.meal.get(meal.id)?.recognition_status).toBe('failed');
    expect(repositories.image.listForEntry(meal.id)).toEqual([
      expect.objectContaining({ id: first.id }),
      expect.objectContaining({ id: second.id }),
    ]);
    expect(repositories.foodItem.listForEntry(meal.id)).toEqual([expect.objectContaining({ id: existing.id })]);
  });

  it('rejects a read image that no longer belongs to the selected meal without invoking the model', async () => {
    const { dataDir, repositories, entry } = await setup();
    const meal = saveMeal(repositories, entry.id);
    const otherMeal = saveMeal(repositories, entry.id, 'other');
    const image = await addImage(dataDir, repositories, meal.id, 'selected.png', Buffer.from('selected'));
    const originalGet = repositories.image.get;
    let reads = 0;
    repositories.image.get = vi.fn((id: number) => {
      const found = originalGet.call(repositories.image, id);
      reads += 1;
      return found && reads === 1 ? { ...found, meal_id: otherMeal.id } : found;
    });
    const recognizer = vi.fn<MealRecognizer>();
    const service = createRecognitionService({ repositories, dataDir }, { recognizer });

    await expect(service.recognize(meal.id)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Image does not belong to meal',
    });
    expect(recognizer).not.toHaveBeenCalled();
    expect(repositories.image.listForEntry(meal.id)).toEqual([expect.objectContaining({ id: image.id })]);
  });

  it('does not delete old drafts when persisting a successful model result fails', async () => {
    const { dataDir, repositories, entry } = await setup();
    const meal = saveMeal(repositories, entry.id);
    await addImage(dataDir, repositories, meal.id, 'meal.png', Buffer.from('meal'));
    const oldDraft = repositories.foodItem.save(meal.id, {
      name: 'Old draft', amount: 1, unit: 'piece', cooking_method: '', confidence: 0.4,
      needs_confirmation: true, is_user_confirmed: false, source: 'model', notes: '',
    });
    const originalReplace = repositories.foodItem.replaceModelDrafts;
    repositories.foodItem.replaceModelDrafts = vi.fn(() => {
      throw new Error('database unavailable');
    }) as typeof originalReplace;
    const service = createRecognitionService({ repositories, dataDir }, {
      recognizer: vi.fn<MealRecognizer>().mockResolvedValue(recognizedMeal),
    });

    await expect(service.recognize(meal.id)).rejects.toThrow('database unavailable');
    expect(repositories.meal.get(meal.id)?.recognition_status).toBe('failed');
    expect(repositories.foodItem.get(oldDraft.id)).toMatchObject({ name: 'Old draft', source: 'model' });
  });

  it('confirms an edited item set as user data without invoking the model', async () => {
    const { dataDir, repositories, entry } = await setup();
    const meal = saveMeal(repositories, entry.id);
    repositories.meal.update(meal.id, { recognition_status: 'needs_review' });
    const draft = repositories.foodItem.save(meal.id, {
      name: 'Rice estimate', amount: 100, unit: 'g', cooking_method: 'steamed', confidence: 0.6,
      needs_confirmation: true, is_user_confirmed: false, source: 'model', notes: '',
    });
    repositories.foodItem.save(meal.id, {
      name: 'Discarded draft', amount: 1, unit: 'serving', cooking_method: '', confidence: 0.3,
      needs_confirmation: true, is_user_confirmed: false, source: 'model', notes: '',
    });
    const recognizer = vi.fn<MealRecognizer>();
    const service = createRecognitionService({ repositories, dataDir }, { recognizer });

    const result = service.confirm(meal.id, { items: [{
      id: draft.id, name: 'Rice', amount: 180, unit: 'g', cooking_method: 'steamed', confidence: 0.9,
      needs_confirmation: true, notes: 'weighed',
    }] });

    expect(result.meal.recognition_status).toBe('confirmed');
    expect(result.food_items).toEqual([expect.objectContaining({
      id: draft.id, name: 'Rice', amount: 180, source: 'user', is_user_confirmed: true, needs_confirmation: false,
    })]);
    expect(recognizer).not.toHaveBeenCalled();
  });

  it('rejects a confirmation item from another meal without changing records', async () => {
    const { dataDir, repositories, entry } = await setup();
    const meal = saveMeal(repositories, entry.id);
    const otherMeal = saveMeal(repositories, entry.id, 'other');
    repositories.meal.update(meal.id, { recognition_status: 'needs_review' });
    const otherItem = repositories.foodItem.save(otherMeal.id, {
      name: 'Other item', amount: 1, unit: 'piece', cooking_method: '', confidence: 0.5,
      needs_confirmation: true, is_user_confirmed: false, source: 'model', notes: '',
    });
    const service = createRecognitionService({ repositories, dataDir }, { recognizer: vi.fn<MealRecognizer>() });

    expect(() => service.confirm(meal.id, { items: [{
      id: otherItem.id, name: 'Changed', amount: 1, unit: 'piece', cooking_method: '', confidence: 1,
      needs_confirmation: false, notes: '',
    }] })).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(repositories.meal.get(meal.id)?.recognition_status).toBe('needs_review');
    expect(repositories.foodItem.get(otherItem.id)).toMatchObject({ name: 'Other item', source: 'model' });
  });

  it('rejects duplicate confirmation item IDs without changing records', async () => {
    const { dataDir, repositories, entry } = await setup();
    const meal = saveMeal(repositories, entry.id);
    repositories.meal.update(meal.id, { recognition_status: 'needs_review' });
    const draft = repositories.foodItem.save(meal.id, {
      name: 'Draft', amount: 1, unit: 'piece', cooking_method: '', confidence: 0.5,
      needs_confirmation: true, is_user_confirmed: false, source: 'model', notes: '',
    });
    const service = createRecognitionService({ repositories, dataDir }, { recognizer: vi.fn<MealRecognizer>() });

    expect(() => service.confirm(meal.id, { items: [{
      id: draft.id, name: 'First edit', amount: 1, unit: 'piece', cooking_method: '', confidence: 1,
      needs_confirmation: false, notes: '',
    }, {
      id: draft.id, name: 'Second edit', amount: 2, unit: 'pieces', cooking_method: '', confidence: 1,
      needs_confirmation: false, notes: '',
    }] })).toThrow();
    expect(repositories.meal.get(meal.id)?.recognition_status).toBe('needs_review');
    expect(repositories.foodItem.get(draft.id)).toMatchObject({ name: 'Draft', source: 'model' });
  });

  it.each(['unrecognized', 'confirmed'] as const)('rejects confirmation from %s without changing records', async (status) => {
    const { dataDir, repositories, entry } = await setup();
    const meal = saveMeal(repositories, entry.id);
    repositories.meal.update(meal.id, { recognition_status: status });
    const item = repositories.foodItem.save(meal.id, {
      name: 'Existing', amount: 1, unit: 'piece', cooking_method: '', confidence: 1,
      needs_confirmation: false, is_user_confirmed: true, source: 'user', notes: '',
    });
    const recognizer = vi.fn<MealRecognizer>();
    const service = createRecognitionService({ repositories, dataDir }, { recognizer });

    expect(() => service.confirm(meal.id, { items: [] })).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    expect(repositories.meal.get(meal.id)?.recognition_status).toBe(status);
    expect(repositories.foodItem.get(item.id)).toMatchObject({ name: 'Existing' });
    expect(recognizer).not.toHaveBeenCalled();
  });

  it('allows a failed meal with a model draft to be confirmed without invoking the model', async () => {
    const { dataDir, repositories, entry } = await setup();
    const meal = saveMeal(repositories, entry.id);
    repositories.meal.update(meal.id, { recognition_status: 'failed' });
    const draft = repositories.foodItem.save(meal.id, {
      name: 'Draft', amount: 1, unit: 'piece', cooking_method: '', confidence: 0.5,
      needs_confirmation: true, is_user_confirmed: false, source: 'model', notes: '',
    });
    const recognizer = vi.fn<MealRecognizer>();
    const service = createRecognitionService({ repositories, dataDir }, { recognizer });

    const result = service.confirm(meal.id, { items: [{
      id: draft.id, name: 'Confirmed draft', amount: 1, unit: 'piece', cooking_method: '', confidence: 1,
      needs_confirmation: false, notes: '',
    }] });

    expect(result).toMatchObject({ meal: { recognition_status: 'confirmed' }, food_items: [{ source: 'user' }] });
    expect(recognizer).not.toHaveBeenCalled();
  });

  it('rejects a failed meal without a model draft', async () => {
    const { dataDir, repositories, entry } = await setup();
    const meal = saveMeal(repositories, entry.id);
    repositories.meal.update(meal.id, { recognition_status: 'failed' });
    const service = createRecognitionService({ repositories, dataDir }, { recognizer: vi.fn<MealRecognizer>() });

    expect(() => service.confirm(meal.id, { items: [] })).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    expect(repositories.meal.get(meal.id)?.recognition_status).toBe('failed');
  });

  it('recognizes a batch in request order and isolates failures per meal', async () => {
    const { dataDir, repositories, entry } = await setup();
    const firstMeal = saveMeal(repositories, entry.id, 'first');
    const secondMeal = saveMeal(repositories, entry.id, 'second');
    const thirdMeal = saveMeal(repositories, entry.id, 'third');
    await addImage(dataDir, repositories, firstMeal.id, 'first.png', Buffer.from('first'));
    await addImage(dataDir, repositories, secondMeal.id, 'second.png', Buffer.from('second'));
    await addImage(dataDir, repositories, thirdMeal.id, 'third.png', Buffer.from('third'));
    const recognizer = vi.fn<MealRecognizer>()
      .mockResolvedValueOnce(recognizedMeal)
      .mockRejectedValueOnce(new AiClientError('AI_NETWORK_ERROR', 'network unavailable'))
      .mockResolvedValueOnce({ ...recognizedMeal, items: [{ ...recognizedMeal.items[0], name: 'Egg' }] });
    const service = createRecognitionService({ repositories, dataDir }, { recognizer });

    const result = await service.recognizeBatch({ mealIds: [firstMeal.id, secondMeal.id, thirdMeal.id] });

    expect(result.map(({ mealId }) => mealId)).toEqual([firstMeal.id, secondMeal.id, thirdMeal.id]);
    expect(result).toMatchObject([
      { mealId: firstMeal.id, status: 'success', data: { meal: { recognition_status: 'needs_review' } } },
      { mealId: secondMeal.id, status: 'failed', error: { code: 'AI_NETWORK_ERROR' } },
      { mealId: thirdMeal.id, status: 'success', data: { meal: { recognition_status: 'needs_review' } } },
    ]);
    expect(repositories.meal.get(secondMeal.id)?.recognition_status).toBe('failed');
    expect(repositories.foodItem.listForEntry(firstMeal.id)).toHaveLength(1);
    expect(repositories.foodItem.listForEntry(thirdMeal.id)).toHaveLength(1);
    expect(recognizer).toHaveBeenCalledTimes(3);
  });
});
