import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories, migrate } from '@fitness-coach/db';
import { createAnalyticsService } from './analytics.js';

const range = { start: '2026-09-18', end: '2026-10-01' };

describe('analytics service', () => {
  let db: Database.Database;

  afterEach(() => {
    db?.close();
  });

  function setup() {
    db = new Database(':memory:');
    migrate(db);
    const repositories = createRepositories(db);
    const profile = repositories.profiles.create({
      name: 'Default', goal: 'maintain', goal_description: '', height_cm: 175, age: 30, sex: 'unspecified',
      training_experience: 'beginner', equipment: 'home', training_days_per_week: 3,
      session_duration_minutes: 45, diet_preferences: '', allergies: '', health_restrictions: '',
    });
    repositories.profiles.setCurrentId(profile.id);
    const analytics = createAnalyticsService({ repositories, dataDir: '/tmp/fitness-coach-analytics-test' });
    return { repositories, analytics };
  }

  it('summarizes weight extrema, valid count, training frequency, feedback, meals, and food confirmation coverage', () => {
    const { repositories, analytics } = setup();
    const trainingDay = repositories.dailyEntry.save({ entry_date: '2026-09-18', status: 'training' });
    const secondTrainingDay = repositories.dailyEntry.save({ entry_date: '2026-09-20', status: 'training' });
    const restDay = repositories.dailyEntry.save({ entry_date: '2026-09-22', status: 'rest' });
    const travelDay = repositories.dailyEntry.save({ entry_date: '2026-09-23', status: 'travel' });
    repositories.workout.save(trainingDay.id, {
      started_at: '2026-09-18T17:00:00Z', workout_type: 'strength', duration_minutes: 45,
      perceived_difficulty: 6, notes: '',
    });
    repositories.workout.save(trainingDay.id, {
      started_at: '2026-09-18T18:00:00Z', workout_type: 'cardio', duration_minutes: 20,
      perceived_difficulty: 4, notes: '',
    });
    repositories.workout.save(secondTrainingDay.id, {
      started_at: '2026-09-20T17:00:00Z', workout_type: 'strength', duration_minutes: 50,
      perceived_difficulty: 7, notes: '',
    });

    repositories.weight.save(trainingDay.id, {
      measured_at: '2026-09-18T07:00:00Z', weight_kg: 72, note: '',
    });
    repositories.weight.save(secondTrainingDay.id, {
      measured_at: '2026-09-20T07:00:00Z', weight_kg: 71.5, note: '',
    });
    repositories.weight.save(travelDay.id, {
      measured_at: '2026-09-23T07:00:00Z', weight_kg: 72.2, note: '',
    });

    const confirmedMeal = repositories.meal.save(trainingDay.id, {
      eaten_at: '2026-09-18T12:00:00Z', meal_type: 'lunch', notes: '', recognition_status: 'confirmed',
    });
    const estimatedMeal = repositories.meal.save(secondTrainingDay.id, {
      eaten_at: '2026-09-20T12:00:00Z', meal_type: 'lunch', notes: '', recognition_status: 'needs_review',
    });
    repositories.meal.save(restDay.id, {
      eaten_at: '2026-09-22T12:00:00Z', meal_type: 'dinner', notes: '', recognition_status: 'unrecognized',
    });
    repositories.foodItem.save(confirmedMeal.id, {
      name: 'Chicken', amount: 150, unit: 'g', cooking_method: 'grilled', confidence: 1,
      needs_confirmation: false, is_user_confirmed: true, source: 'user', notes: '',
    });
    repositories.foodItem.save(estimatedMeal.id, {
      name: 'Rice', amount: 180, unit: 'g', cooking_method: 'steamed', confidence: 0.5,
      needs_confirmation: true, is_user_confirmed: false, source: 'model', notes: '',
    });

    repositories.feedback.save(trainingDay.id, {
      recorded_at: '2026-09-18T19:00:00Z', category: 'fatigue', body_part: 'legs', severity: 3,
      impact: 'walking', description: 'Tired',
    });
    repositories.feedback.save(secondTrainingDay.id, {
      recorded_at: '2026-09-20T19:00:00Z', category: 'pain', body_part: 'knee', severity: 4,
      impact: 'squatting', description: 'Pain',
    });

    const summary = analytics.summarize(range);

    expect(summary.weights).toEqual({
      start: 72,
      end: 72.2,
      min: 71.5,
      max: 72.2,
      validCount: 3,
    });
    expect(summary.training).toEqual({ count: 3, frequencyPerWeek: 1.5 });
    expect(summary.feedbackDistribution).toMatchObject({ fatigue: 1, pain: 1 });
    expect(summary.meals).toMatchObject({
      count: 3,
      confirmedFoodCoverage: { confirmedMeals: 1, totalMeals: 3, ratio: 1 / 3 },
    });
  });

  it('counts only persisted statuses, so missing days are not inferred as rest', () => {
    const { repositories, analytics } = setup();
    repositories.dailyEntry.save({ entry_date: '2026-09-18', status: 'training' });
    repositories.dailyEntry.save({ entry_date: '2026-09-20', status: 'rest' });

    const summary = analytics.summarize(range);

    expect(summary.statusDistribution).toEqual({
      training: 1,
      rest: 1,
      paused_sick: 0,
      travel: 0,
      custom: 0,
    });
    expect(Object.values(summary.statusDistribution as Record<string, number>).reduce((total, count) => total + count, 0)).toBe(2);
  });

  it('summarizes long-term weight history separately from the selected range', () => {
    const { repositories, analytics } = setup();
    const older = repositories.dailyEntry.save({ entry_date: '2026-01-01', status: 'training' });
    const current = repositories.dailyEntry.save({ entry_date: '2026-09-20', status: 'training' });
    repositories.weight.save(older.id, { measured_at: '2026-01-01T07:00:00Z', weight_kg: 80, note: '' });
    repositories.weight.save(current.id, { measured_at: '2026-09-20T07:00:00Z', weight_kg: 72, note: '' });

    expect(analytics.longTermWeights()).toEqual({
      start: 80,
      end: 72,
      min: 72,
      max: 80,
      validCount: 2,
    });
  });
});
