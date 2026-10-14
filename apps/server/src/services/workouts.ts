import { dateOnlySchema, exerciseInputSchema, exercisePatchSchema, idParamsSchema, recordIdBodySchema, workoutInputSchema, workoutPatchSchema } from '@fitness-coach/shared';
import { notFound } from '../errors.js';
import type { ServiceContext } from './context.js';

export function createWorkoutsService({ repositories }: ServiceContext) {
  function entryId(date: string) {
    const entry = repositories.dailyEntry.getByDate(dateOnlySchema.parse(date));
    if (!entry) notFound('Daily entry not found');
    return entry.id;
  }

  function workoutId(input: unknown) {
    const { id } = idParamsSchema.parse({ id: input });
    if (!repositories.workout.get(id)) notFound('Workout not found');
    return id;
  }

  return {
    create(date: string, input: unknown) {
      return repositories.workout.save(entryId(date), workoutInputSchema.parse(input));
    },
    patchForDate(date: string, input: unknown) {
      const parentId = entryId(date);
      const patch = workoutPatchSchema.parse(input) as { id: number } & Record<string, unknown>;
      const saved = repositories.workout.updateForParent(parentId, patch.id, patch);
      if (!saved) notFound('Workout not found for this date');
      return saved;
    },
    deleteForDate(date: string, input: unknown) {
      const parentId = entryId(date);
      const { id } = recordIdBodySchema.parse(input);
      const deleted = repositories.workout.deleteForParent(parentId, id);
      if (!deleted) notFound('Workout not found for this date');
      return deleted;
    },
    createExercise(input: unknown, body: unknown) {
      return repositories.exercise.save(workoutId(input), exerciseInputSchema.parse(body));
    },
    patchExercise(input: unknown, body: unknown) {
      const parentId = workoutId(input);
      const patch = exercisePatchSchema.parse(body) as { id: number } & Record<string, unknown>;
      const saved = repositories.exercise.updateForParent(parentId, patch.id, patch);
      if (!saved) notFound('Exercise not found for this workout');
      return saved;
    },
    deleteExercise(input: unknown, body: unknown) {
      const parentId = workoutId(input);
      const { id } = recordIdBodySchema.parse(body);
      const deleted = repositories.exercise.deleteForParent(parentId, id);
      if (!deleted) notFound('Exercise not found for this workout');
      return deleted;
    },
  };
}
