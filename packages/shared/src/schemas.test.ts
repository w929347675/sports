import { describe, expect, it } from 'vitest';
import {
  confirmFoodItemsInputSchema,
  dailyEntrySchema,
  feedbackSchema,
  mealSchema,
  mealCreateInputSchema,
  mealUserPatchSchema,
  recognizeMealsBatchInputSchema,
  profileSchema,
  settingsSchema,
  weightMeasurementSchema,
} from './schemas.js';

describe('shared schemas', () => {
  it('accepts a valid profile and daily entry', async () => {
    const profile = profileSchema.parse({
      goal: 'maintain',
      height_cm: 175,
      age: 30,
      sex: 'unspecified',
      training_experience: 'intermediate',
      equipment: 'home gym',
      training_days_per_week: 4,
      session_duration_minutes: 60,
      diet_preferences: 'balanced',
      allergies: 'none',
      health_restrictions: 'none',
    });
    const entry = dailyEntrySchema.parse({
      entry_date: '2026-09-28',
      status: 'training',
      status_note: 'Upper body session',
    });

    expect(profile.goal).toBe('maintain');
    expect(entry.status).toBe('training');
  });

  it('rejects impossible dates and non-positive measurements', () => {
    expect(() => dailyEntrySchema.parse({
      entry_date: '2026-02-30',
      status: 'rest',
    })).toThrow();
    expect(() => weightMeasurementSchema.parse({
      measured_at: '2026-09-28T08:00:00Z',
      weight_kg: 0,
    })).toThrow();
  });

  it('rejects feedback severity outside the 0-10 range', () => {
    expect(() => feedbackSchema.parse({
      recorded_at: '2026-09-28T08:00:00Z',
      category: 'pain',
      body_part: 'knee',
      severity: 11,
      impact: 'running',
      description: 'Pain after the last set',
    })).toThrow();
  });

  it('uses fixed status enums for records', () => {
    expect(() => dailyEntrySchema.parse({
      entry_date: '2026-09-28',
      status: 'workout',
    })).toThrow();
    expect(() => mealSchema.parse({
      eaten_at: '2026-09-28T12:00:00Z',
      meal_type: 'lunch',
      recognition_status: 'done',
    })).toThrow();
  });

  it('does not expose an API key through the shared settings contract', () => {
    expect('api_key' in settingsSchema.shape).toBe(false);
  });

  it('validates edited food items for confirmation', () => {
    expect(confirmFoodItemsInputSchema.parse({
      items: [{
        id: 3,
        name: 'Chicken breast',
        amount: 150,
        unit: 'g',
        cooking_method: 'grilled',
        confidence: 0.8,
        needs_confirmation: true,
        notes: 'Edited by the user',
      }],
    })).toEqual({
      items: [{
        id: 3,
        name: 'Chicken breast',
        amount: 150,
        unit: 'g',
        cooking_method: 'grilled',
        confidence: 0.8,
        needs_confirmation: true,
        notes: 'Edited by the user',
      }],
    });
    expect(() => confirmFoodItemsInputSchema.parse({
      items: [{
        name: 'Unknown portion',
        amount: 0,
        unit: 'g',
        cooking_method: '',
        confidence: 0.5,
        needs_confirmation: true,
      }],
    })).toThrow();
  });

  it('accepts an ordered unique batch of meal IDs and rejects duplicates', () => {
    expect(recognizeMealsBatchInputSchema.parse({ mealIds: [7, 2, 9] })).toEqual({ mealIds: [7, 2, 9] });
    expect(() => recognizeMealsBatchInputSchema.parse({ mealIds: [7, 7] })).toThrow();
  });

  it('fixes new meals to unrecognized and rejects recognition status in user patches', () => {
    expect(mealCreateInputSchema.parse({
      eaten_at: '2026-09-28T12:00:00Z', meal_type: 'lunch', notes: 'rice', recognition_status: 'unrecognized',
    })).toMatchObject({ recognition_status: 'unrecognized' });
    expect(() => mealCreateInputSchema.parse({
      eaten_at: '2026-09-28T12:00:00Z', meal_type: 'lunch', recognition_status: 'processing',
    })).toThrow();
    expect(() => mealUserPatchSchema.parse({ recognition_status: 'confirmed' })).toThrow();
    expect(mealUserPatchSchema.parse({ notes: 'edited' })).toEqual({ notes: 'edited' });
    expect(mealCreateInputSchema.parse({
      eaten_at: '2026-09-28T12:00:00Z', meal_type: 'lunch', notes: 'no client status',
    })).toMatchObject({ recognition_status: 'unrecognized' });
  });
});
