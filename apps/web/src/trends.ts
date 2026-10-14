import type { DailyEntryView } from './api/client.js';

export type TrendEntry = {
  entry_date: string;
  status: DailyEntryView['status'];
  weights: Array<{ measured_at: string; weight_kg: number }>;
  meals: Array<{ recognition_status: DailyEntryView['meals'][number]['recognition_status'] }>;
  workouts: Array<{ exercises: Array<{ weight?: number; sets: number; repetitions: number }> }>;
  feedback: Array<unknown>;
};

export type EntrySummary = {
  daysRecorded: number;
  trainingDays: number;
  restDays: number;
  weightLatestKg: number | null;
  weightChangeKg: number | null;
  workoutCount: number;
  trainingVolumeKg: number;
  feedbackCount: number;
  mealCoveragePercent: number;
  pendingMealCount: number;
  statusDistribution: Record<DailyEntryView['status'], number>;
};

export function summarizeEntries(entries: TrendEntry[]): EntrySummary {
  const ordered = [...entries].sort((a, b) => a.entry_date.localeCompare(b.entry_date));
  const measurements = ordered
    .flatMap((entry) => entry.weights.map((weight) => ({ measured_at: weight.measured_at, weight_kg: weight.weight_kg })))
    .sort((a, b) => a.measured_at.localeCompare(b.measured_at));
  const meals = ordered.flatMap((entry) => entry.meals);
  const volume = ordered.flatMap((entry) => entry.workouts).flatMap((workout) => workout.exercises).reduce((total, exercise) => {
    return total + (exercise.weight ?? 0) * exercise.sets * exercise.repetitions;
  }, 0);
  const coveredDays = ordered.filter((entry) => entry.meals.length > 0).length;

  return {
    daysRecorded: entries.length,
    trainingDays: entries.filter((entry) => entry.status === 'training').length,
    restDays: entries.filter((entry) => entry.status === 'rest').length,
    weightLatestKg: measurements.at(-1)?.weight_kg ?? null,
    weightChangeKg: measurements.length > 1 ? (measurements.at(-1)?.weight_kg ?? 0) - (measurements.at(0)?.weight_kg ?? 0) : null,
    workoutCount: ordered.flatMap((entry) => entry.workouts).length,
    trainingVolumeKg: volume,
    feedbackCount: ordered.flatMap((entry) => entry.feedback).length,
    mealCoveragePercent: entries.length === 0 ? 0 : Math.round((coveredDays / entries.length) * 100),
    pendingMealCount: meals.filter((meal) => meal.recognition_status === 'unrecognized' || meal.recognition_status === 'needs_review').length,
    statusDistribution: ordered.reduce<Record<DailyEntryView['status'], number>>((counts, entry) => {
      counts[entry.status] += 1;
      return counts;
    }, { training: 0, rest: 0, paused_sick: 0, travel: 0, custom: 0 }),
  };
}
