import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from './migrate.js';
import { createRepositories } from './repositories.js';

describe('repositories', () => {
  function selectDefaultProfile(repositories: ReturnType<typeof createRepositories>) {
    const profile = repositories.profiles.create({
      name: 'Default', goal: 'maintain', goal_description: '', height_cm: 175, age: 30, sex: 'unspecified',
      training_experience: 'beginner', equipment: 'home', training_days_per_week: 3,
      session_duration_minutes: 45, diet_preferences: '', allergies: '', health_restrictions: '',
    });
    repositories.profiles.setCurrentId(profile.id);
  }

  it('refuses business writes when no current profile exists', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repositories = createRepositories(db);

    expect(() => repositories.dailyEntry.save({ entry_date: '2026-10-10', status: 'training' })).toThrow(/current profile/i);
    expect(() => repositories.recommendation.save({
      profile_id: 1,
      range_start: '2026-10-01', range_end: '2026-10-10', model_name: 'mock', input_summary_json: '{}',
      report_markdown: 'report', structured_report_json: '{}', status: 'completed',
    })).toThrow(/current profile/i);
    expect(db.prepare('SELECT COUNT(*) AS count FROM daily_entries').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM recommendations').get()).toEqual({ count: 0 });
  });

  it('updates the selected current profile instead of profile 1', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repositories = createRepositories(db);
    const first = repositories.profiles.create({
      name: 'First', goal: 'maintain', goal_description: '', height_cm: 175, age: 30, sex: 'unspecified',
      training_experience: 'beginner', equipment: 'home', training_days_per_week: 3,
      session_duration_minutes: 45, diet_preferences: '', allergies: '', health_restrictions: '',
    });
    const second = repositories.profiles.create({
      name: 'Second', goal: 'maintain', goal_description: '', height_cm: 180, age: 31, sex: 'unspecified',
      training_experience: 'beginner', equipment: 'gym', training_days_per_week: 4,
      session_duration_minutes: 60, diet_preferences: '', allergies: '', health_restrictions: '',
    });
    repositories.profiles.setCurrentId(second.id);

    repositories.profile.save({
      goal: 'muscle_gain', height_cm: 181, age: 31, sex: 'unspecified', training_experience: 'intermediate',
      equipment: 'gym', training_days_per_week: 4, session_duration_minutes: 60,
      diet_preferences: '', allergies: '', health_restrictions: '',
    });

    expect(repositories.profiles.get(first.id)).toMatchObject({ goal: 'maintain', height_cm: 175 });
    expect(repositories.profiles.get(second.id)).toMatchObject({ goal: 'muscle_gain', height_cm: 181 });
  });

  it('creates and reads the profile and daily entry with child records', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repositories = createRepositories(db);
    const profile = repositories.profile.save({
      goal: 'fat_loss',
      height_cm: 175,
      age: 30,
      sex: 'unspecified',
      training_experience: 'beginner',
      equipment: 'bodyweight',
      training_days_per_week: 3,
      session_duration_minutes: 45,
      diet_preferences: 'none',
      allergies: 'none',
      health_restrictions: 'none',
    });
    const entry = repositories.dailyEntry.save({
      entry_date: '2026-09-28',
      status: 'training',
      status_note: 'Morning session',
    });
    const weight = repositories.weight.save(entry.id, {
      measured_at: '2026-09-28T07:00:00Z',
      weight_kg: 72.5,
      note: 'Before breakfast',
    });
    const meal = repositories.meal.save(entry.id, {
      eaten_at: '2026-09-28T12:00:00Z',
      meal_type: 'lunch',
      notes: 'Home cooked',
      recognition_status: 'unrecognized',
    });
    const feedback = repositories.feedback.save(entry.id, {
      recorded_at: '2026-09-28T18:00:00Z',
      category: 'fatigue',
      body_part: 'general',
      severity: 3,
      impact: 'low',
      description: 'Slightly tired',
    });

    expect(profile.id).toBe(1);
    expect(repositories.profile.get()).toMatchObject({ goal: 'fat_loss' });
    expect(repositories.dailyEntry.getByDate('2026-09-28')).toMatchObject({
      entry_date: '2026-09-28',
      status: 'training',
    });
    expect(repositories.weight.listForEntry(entry.id)).toHaveLength(1);
    expect(repositories.meal.listForEntry(entry.id)[0]).toMatchObject({ id: meal.id });
    expect(repositories.feedback.listForEntry(entry.id)[0]).toMatchObject({ id: feedback.id });
    expect(weight.weight_kg).toBe(72.5);
  });

  it('atomically replaces only unconfirmed model food items and updates recognition status', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repositories = createRepositories(db);
    selectDefaultProfile(repositories);
    const entry = repositories.dailyEntry.save({ entry_date: '2026-09-28', status: 'training' });
    const meal = repositories.meal.save(entry.id, {
      eaten_at: '2026-09-28T12:00:00Z',
      meal_type: 'lunch',
      notes: 'meal notes',
      recognition_status: 'processing',
    });
    const oldDraft = repositories.foodItem.save(meal.id, {
      name: 'Old model draft', amount: 1, unit: 'serving', cooking_method: '', confidence: 0.4,
      needs_confirmation: true, is_user_confirmed: false, source: 'model', notes: '',
    });
    const confirmedModelItem = repositories.foodItem.save(meal.id, {
      name: 'Confirmed model item', amount: 2, unit: 'pieces', cooking_method: 'baked', confidence: 0.8,
      needs_confirmation: false, is_user_confirmed: true, source: 'model', notes: '',
    });
    const userItem = repositories.foodItem.save(meal.id, {
      name: 'User item', amount: 100, unit: 'g', cooking_method: 'raw', confidence: 1,
      needs_confirmation: false, is_user_confirmed: true, source: 'user', notes: '',
    });

    const saved = repositories.foodItem.replaceModelDrafts(meal.id, [{
      name: 'New draft', amount: 150, unit: 'g', cooking_method: 'grilled', confidence: 0.75,
      needs_confirmation: true, is_user_confirmed: false, source: 'model', notes: 'estimate',
    }]);

    expect(saved.meal.recognition_status).toBe('needs_review');
    expect(saved.food_items).toEqual([
      expect.objectContaining({ id: confirmedModelItem.id, name: 'Confirmed model item' }),
      expect.objectContaining({ id: userItem.id, name: 'User item' }),
      expect.objectContaining({ name: 'New draft', cooking_method: 'grilled', source: 'model', is_user_confirmed: false }),
    ]);
    expect(saved.food_items.map(({ id }) => id)).not.toContain(oldDraft.id);
  });

  it('rolls back draft deletion when replacement cannot be inserted', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repositories = createRepositories(db);
    selectDefaultProfile(repositories);
    const entry = repositories.dailyEntry.save({ entry_date: '2026-09-28', status: 'training' });
    const meal = repositories.meal.save(entry.id, {
      eaten_at: '2026-09-28T12:00:00Z', meal_type: 'lunch', recognition_status: 'processing',
    });
    const oldDraft = repositories.foodItem.save(meal.id, {
      name: 'Old model draft', amount: 1, unit: 'serving', cooking_method: '', confidence: 0.4,
      needs_confirmation: true, is_user_confirmed: false, source: 'model', notes: '',
    });
    db.exec("CREATE TRIGGER reject_new_model_item BEFORE INSERT ON food_items BEGIN SELECT RAISE(ABORT, 'rejected'); END");

    expect(() => repositories.foodItem.replaceModelDrafts(meal.id, [{
      name: 'New draft', amount: 1, unit: 'serving', cooking_method: '', confidence: 0.5,
      needs_confirmation: true, is_user_confirmed: false, source: 'model', notes: '',
    }])).toThrow();

    expect(repositories.foodItem.listForEntry(meal.id)).toEqual([expect.objectContaining({ id: oldDraft.id })]);
    expect(repositories.meal.get(meal.id)?.recognition_status).toBe('processing');
  });

  it('atomically confirms the submitted set and removes obsolete model drafts', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repositories = createRepositories(db);
    selectDefaultProfile(repositories);
    const entry = repositories.dailyEntry.save({ entry_date: '2026-09-28', status: 'training' });
    const meal = repositories.meal.save(entry.id, {
      eaten_at: '2026-09-28T12:00:00Z', meal_type: 'lunch', recognition_status: 'needs_review',
    });
    const kept = repositories.foodItem.save(meal.id, {
      name: 'Rice estimate', amount: 150, unit: 'g', cooking_method: 'steamed', confidence: 0.7,
      needs_confirmation: true, is_user_confirmed: false, source: 'model', notes: '',
    });
    repositories.foodItem.save(meal.id, {
      name: 'Delete me', amount: 1, unit: 'serving', cooking_method: '', confidence: 0.4,
      needs_confirmation: true, is_user_confirmed: false, source: 'model', notes: '',
    });
    const priorConfirmed = repositories.foodItem.save(meal.id, {
      name: 'Keep prior user item', amount: 1, unit: 'piece', cooking_method: '', confidence: 1,
      needs_confirmation: false, is_user_confirmed: true, source: 'user', notes: '',
    });

    const confirmed = repositories.foodItem.confirmForMeal(meal.id, [{
      id: kept.id, name: 'Rice', amount: 180, unit: 'g', cooking_method: 'steamed', confidence: 0.7,
      needs_confirmation: true, notes: 'weighed',
    }, {
      name: 'Egg', amount: 2, unit: 'pieces', cooking_method: 'boiled', confidence: 1,
      needs_confirmation: false, notes: '',
    }]);

    expect(confirmed.meal.recognition_status).toBe('confirmed');
    expect(confirmed.food_items).toEqual([
      expect.objectContaining({ id: kept.id, name: 'Rice', amount: 180, source: 'user', is_user_confirmed: true, needs_confirmation: false }),
      expect.objectContaining({ id: priorConfirmed.id, name: 'Keep prior user item' }),
      expect.objectContaining({ name: 'Egg', source: 'user', is_user_confirmed: true, needs_confirmation: false }),
    ]);
  });

  it('rejects confirmation IDs that belong to another meal without changing either meal', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repositories = createRepositories(db);
    selectDefaultProfile(repositories);
    const entry = repositories.dailyEntry.save({ entry_date: '2026-09-28', status: 'training' });
    const firstMeal = repositories.meal.save(entry.id, {
      eaten_at: '2026-09-28T12:00:00Z', meal_type: 'lunch', recognition_status: 'needs_review',
    });
    const secondMeal = repositories.meal.save(entry.id, {
      eaten_at: '2026-09-28T18:00:00Z', meal_type: 'dinner', recognition_status: 'needs_review',
    });
    const otherItem = repositories.foodItem.save(secondMeal.id, {
      name: 'Other meal item', amount: 1, unit: 'piece', cooking_method: '', confidence: 0.5,
      needs_confirmation: true, is_user_confirmed: false, source: 'model', notes: '',
    });

    expect(() => repositories.foodItem.confirmForMeal(firstMeal.id, [{
      id: otherItem.id, name: 'Hijacked', amount: 1, unit: 'piece', cooking_method: '', confidence: 1,
      needs_confirmation: false, notes: '',
    }])).toThrow('Food item does not belong to meal');

    expect(repositories.foodItem.get(otherItem.id)).toMatchObject({ name: 'Other meal item', source: 'model' });
    expect(repositories.meal.get(firstMeal.id)?.recognition_status).toBe('needs_review');
  });

  it('rolls back confirmation changes when an item update fails', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repositories = createRepositories(db);
    selectDefaultProfile(repositories);
    const entry = repositories.dailyEntry.save({ entry_date: '2026-09-28', status: 'training' });
    const meal = repositories.meal.save(entry.id, {
      eaten_at: '2026-09-28T12:00:00Z', meal_type: 'lunch', recognition_status: 'needs_review',
    });
    const kept = repositories.foodItem.save(meal.id, {
      name: 'Keep', amount: 1, unit: 'piece', cooking_method: '', confidence: 0.5,
      needs_confirmation: true, is_user_confirmed: false, source: 'model', notes: '',
    });
    const omitted = repositories.foodItem.save(meal.id, {
      name: 'Omitted', amount: 1, unit: 'piece', cooking_method: '', confidence: 0.5,
      needs_confirmation: true, is_user_confirmed: false, source: 'model', notes: '',
    });
    db.exec("CREATE TRIGGER reject_food_item_update BEFORE UPDATE ON food_items BEGIN SELECT RAISE(ABORT, 'rejected'); END");

    expect(() => repositories.foodItem.confirmForMeal(meal.id, [{
      id: kept.id, name: 'Edited', amount: 2, unit: 'pieces', cooking_method: '', confidence: 1,
      needs_confirmation: false, notes: '',
    }])).toThrow();

    expect(repositories.foodItem.listForEntry(meal.id)).toEqual([
      expect.objectContaining({ id: kept.id, name: 'Keep', source: 'model' }),
      expect.objectContaining({ id: omitted.id, name: 'Omitted', source: 'model' }),
    ]);
    expect(repositories.meal.get(meal.id)?.recognition_status).toBe('needs_review');
  });

  it('recovers only processing meals as failed and refreshes their updated timestamp', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repositories = createRepositories(db);
    selectDefaultProfile(repositories);
    const entry = repositories.dailyEntry.save({ entry_date: '2026-09-28', status: 'training' });
    const processing = repositories.meal.save(entry.id, {
      eaten_at: '2026-09-28T12:00:00Z', meal_type: 'lunch', recognition_status: 'processing',
    });
    const review = repositories.meal.save(entry.id, {
      eaten_at: '2026-09-28T18:00:00Z', meal_type: 'dinner', recognition_status: 'needs_review',
    });
    const oldTimestamp = '2020-01-01T00:00:00.000Z';
    db.prepare('UPDATE meals SET updated_at = ? WHERE id IN (?, ?)').run(oldTimestamp, processing.id, review.id);

    expect(repositories.meal.recoverProcessing()).toBe(1);

    expect(repositories.meal.get(processing.id)).toMatchObject({
      recognition_status: 'failed',
      updated_at: expect.not.stringMatching(/^2020-/),
    });
    expect(repositories.meal.get(review.id)).toMatchObject({
      recognition_status: 'needs_review',
      updated_at: oldTimestamp,
    });
  });

  it('refreshes updated_at when a meal is updated', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repositories = createRepositories(db);
    selectDefaultProfile(repositories);
    const entry = repositories.dailyEntry.save({ entry_date: '2026-09-28', status: 'training' });
    const meal = repositories.meal.save(entry.id, {
      eaten_at: '2026-09-28T12:00:00Z', meal_type: 'lunch', notes: 'before', recognition_status: 'unrecognized',
    });
    const oldTimestamp = '2020-01-01T00:00:00.000Z';
    db.prepare('UPDATE meals SET updated_at = ? WHERE id = ?').run(oldTimestamp, meal.id);

    const updated = repositories.meal.update(meal.id, { notes: 'after' });

    expect(updated).toMatchObject({ notes: 'after', updated_at: expect.not.stringMatching(/^2020-/) });
  });

  it('refreshes updated_at when a meal is updated through its daily entry', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repositories = createRepositories(db);
    selectDefaultProfile(repositories);
    const entry = repositories.dailyEntry.save({ entry_date: '2026-09-28', status: 'training' });
    const meal = repositories.meal.save(entry.id, {
      eaten_at: '2026-09-28T12:00:00Z', meal_type: 'lunch', notes: 'before', recognition_status: 'unrecognized',
    });
    const oldTimestamp = '2020-01-01T00:00:00.000Z';
    db.prepare('UPDATE meals SET updated_at = ? WHERE id = ?').run(oldTimestamp, meal.id);

    const updated = repositories.meal.updateForParent(entry.id, meal.id, { notes: 'after' });

    expect(updated).toMatchObject({ notes: 'after', updated_at: expect.not.stringMatching(/^2020-/) });
  });

  it('refuses profile deletion when the current profile changed after the caller checked it', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repositories = createRepositories(db);
    const first = repositories.profiles.create({ name: 'First', goal: 'maintain', goal_description: '', height_cm: 175, age: 30, sex: 'unspecified', training_experience: 'beginner', equipment: 'home', training_days_per_week: 3, session_duration_minutes: 45, diet_preferences: '', allergies: '', health_restrictions: '' });
    const second = repositories.profiles.create({ name: 'Second', goal: 'maintain', goal_description: '', height_cm: 175, age: 30, sex: 'unspecified', training_experience: 'beginner', equipment: 'home', training_days_per_week: 3, session_duration_minutes: 45, diet_preferences: '', allergies: '', health_restrictions: '' });
    repositories.profiles.setCurrentId(second.id);
    const checkedCurrentId = repositories.profiles.currentId()!;
    repositories.profiles.setCurrentId(first.id);

    expect(repositories.profiles.delete([first.id], checkedCurrentId)).toBe(0);
    expect(repositories.profiles.get(first.id)).toBeDefined();
  });
});
