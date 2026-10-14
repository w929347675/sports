import { describe, expect, it } from 'vitest';
import { summarizeEntries } from './trends.js';

describe('trend summaries', () => {
  it('counts records while keeping missing dates distinct from rest days', () => {
    const summary = summarizeEntries([
      { entry_date: '2026-09-27', status: 'rest', weights: [{ measured_at: '2026-09-27T07:00:00Z', weight_kg: 72 }], meals: [{ recognition_status: 'unrecognized' }], workouts: [], feedback: [] },
      { entry_date: '2026-09-28', status: 'training', weights: [{ measured_at: '2026-09-28T07:00:00Z', weight_kg: 71.5 }], meals: [{ recognition_status: 'confirmed' }, { recognition_status: 'unrecognized' }], workouts: [{ exercises: [{ weight: 40, sets: 3, repetitions: 8 }] }], feedback: [{ severity: 3 }] },
    ]);

    expect(summary).toEqual({
      daysRecorded: 2,
      trainingDays: 1,
      restDays: 1,
      weightLatestKg: 71.5,
      weightChangeKg: -0.5,
      workoutCount: 1,
      trainingVolumeKg: 960,
      feedbackCount: 1,
      mealCoveragePercent: 100,
      pendingMealCount: 2,
      statusDistribution: { training: 1, rest: 1, paused_sick: 0, travel: 0, custom: 0 },
    });
  });

  it('orders measurements by measurement time when calculating the weight trend', () => {
    const summary = summarizeEntries([
      { entry_date: '2026-09-28', status: 'training', weights: [{ measured_at: '2026-09-28T20:00:00Z', weight_kg: 71 }, { measured_at: '2026-09-28T07:00:00Z', weight_kg: 72 }], meals: [], workouts: [], feedback: [] },
    ]);

    expect(summary.weightLatestKg).toBe(71);
    expect(summary.weightChangeKg).toBe(-1);
  });
});
