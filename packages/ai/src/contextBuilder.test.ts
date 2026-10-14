import { describe, expect, it } from 'vitest';
import { buildRecommendationContext, selectRecommendationImages } from './contextBuilder.js';

const images = [
  { id: 10, mealId: 900, createdAt: '2026-09-18T08:00:00Z', fileSize: 4, base64: 'specified-old', isConfirmed: true, riskRelated: false },
  { id: 11, mealId: 901, createdAt: '2026-09-30T08:00:00Z', fileSize: 4, base64: 'specified-new', isConfirmed: true, riskRelated: false },
  { id: 20, mealId: 902, createdAt: '2026-09-29T08:00:00Z', fileSize: 4, base64: 'unconfirmed', isConfirmed: false, riskRelated: false },
  { id: 30, mealId: 903, createdAt: '2026-09-28T08:00:00Z', fileSize: 4, base64: 'risk', isConfirmed: true, riskRelated: true },
  { id: 40, mealId: 904, createdAt: '2026-09-27T08:00:00Z', fileSize: 4, base64: 'newest', isConfirmed: true, riskRelated: false },
  { id: 50, mealId: 905, createdAt: '2026-09-26T08:00:00Z', fileSize: 4, base64: 'older', isConfirmed: true, riskRelated: false },
];

describe('recommendation context builder', () => {
  it('sends zero images unless image review is explicitly requested', () => {
    const context = buildRecommendationContext({
      profile: { goal: 'maintain' },
      trends: { weight: 'stable' },
      structuredData: { meals: 3 },
      training: { count: 2 },
      feedback: { fatigue: 1 },
      status: { training: 2 },
      confirmedFood: [{ name: 'Chicken', amount: 150, unit: 'g' }],
      estimatedFood: [{ name: 'Rice', amount: 180, unit: 'g' }],
      images,
    });

    expect(context.images).toEqual([]);
  });

  it('selects at most five images with specified meals first, then unconfirmed, risk-related, and newest', () => {
    const selected = selectRecommendationImages({
      images,
      explicitReview: true,
      specifiedMealIds: [900, 901],
    });

    expect(selected).toHaveLength(5);
    expect(selected.map((image: (typeof images)[number]) => image.id)).toEqual([11, 10, 20, 30, 40]);
  });

  it('rejects an explicitly selected image set over the byte limit', () => {
    expect(() => selectRecommendationImages({
      images,
      explicitReview: true,
      specifiedMealIds: [900, 901],
      maxBytes: 7,
    })).toThrow(/image.*(size|byte|limit)/i);
  });

  it('prefers the newest images within the same priority group', () => {
    const samePriority = [
      { id: 60, mealId: 906, createdAt: '2026-09-20T08:00:00Z', fileSize: 4, base64: 'old', isConfirmed: false, riskRelated: false },
      { id: 61, mealId: 907, createdAt: '2026-09-30T08:00:00Z', fileSize: 4, base64: 'new', isConfirmed: false, riskRelated: false },
    ];

    expect(selectRecommendationImages({ images: samePriority, explicitReview: true }).map((image) => image.id)).toEqual([61, 60]);
  });

  it('preserves context priority and distinguishes confirmed food from estimates', () => {
    const context = buildRecommendationContext({
      profile: { goal: 'maintain' },
      trends: { weight: 'stable' },
      structuredData: { meals: 3 },
      training: { count: 2 },
      feedback: { fatigue: 1 },
      status: { training: 2 },
      confirmedFood: [{ name: 'Chicken', amount: 150, unit: 'g' }],
      estimatedFood: [{ name: 'Rice', amount: 180, unit: 'g' }],
      images: [],
    });

    expect(context.priority).toEqual([
      'profile',
      'trends',
      'structuredData',
      'training',
      'feedback',
      'status',
      'confirmedFood',
      'estimatedFood',
    ]);
    expect(context.sections.confirmedFood).toEqual([{ name: 'Chicken', amount: 150, unit: 'g' }]);
    expect(context.sections.estimatedFood).toEqual([{ name: 'Rice', amount: 180, unit: 'g' }]);
  });
});
