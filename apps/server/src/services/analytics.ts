import type { ServiceContext } from './context.js';
import type { DateRange } from './dateRange.js';

const statusNames = ['training', 'rest', 'paused_sick', 'travel', 'custom'] as const;

export function createAnalyticsService({ repositories }: ServiceContext) {
  function summarizeWeights(weights: Array<{ measured_at: string; weight_kg: number }>) {
    const ordered = [...weights].sort((left, right) => left.measured_at.localeCompare(right.measured_at));
    const values = ordered.map(({ weight_kg }) => weight_kg);
    return {
      start: values[0] ?? null,
      end: values.at(-1) ?? null,
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      validCount: values.length,
    };
  }

  return {
    longTermWeights() {
      const entries = repositories.dailyEntry.listRange('0000-01-01', '9999-12-31');
      return summarizeWeights(entries.flatMap((entry) => repositories.weight.listForEntry(entry.id)));
    },
    summarize(range: DateRange) {
      const entries = repositories.dailyEntry.listRange(range.start, range.end);
      const weights = entries.flatMap((entry) => repositories.weight.listForEntry(entry.id));
      const workouts = entries.flatMap((entry) => repositories.workout.listForEntry(entry.id));
      const meals = entries.flatMap((entry) => repositories.meal.listForEntry(entry.id));
      const feedback = entries.flatMap((entry) => repositories.feedback.listForEntry(entry.id));
      const statusDistribution = Object.fromEntries(statusNames.map((status) => [status, 0])) as Record<typeof statusNames[number], number>;
      for (const entry of entries) statusDistribution[entry.status] += 1;

      const confirmedMeals = meals.filter(({ recognition_status }) => recognition_status === 'confirmed').length;
      const rangeDays = (Date.parse(`${range.end}T00:00:00Z`) - Date.parse(`${range.start}T00:00:00Z`)) / 86_400_000 + 1;
      const feedbackDistribution = Object.fromEntries(
        ['normal', 'discomfort', 'pain', 'fatigue', 'other'].map((category) => [
          category,
          feedback.filter((item) => item.category === category).length,
        ]),
      );

      return {
        weights: {
          ...summarizeWeights(weights),
        },
        training: {
          count: workouts.length,
          frequencyPerWeek: workouts.length / (rangeDays / 7),
        },
        feedbackDistribution,
        meals: {
          count: meals.length,
          confirmedFoodCoverage: {
            confirmedMeals,
            totalMeals: meals.length,
            ratio: meals.length === 0 ? 0 : confirmedMeals / meals.length,
          },
        },
        statusDistribution,
        recordCount: entries.length + weights.length + workouts.length + meals.length + feedback.length,
        entryCount: entries.length,
        workoutCount: workouts.length,
        feedbackCount: feedback.length,
      };
    },
  };
}
