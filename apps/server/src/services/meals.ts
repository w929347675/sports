import { dateOnlySchema, idParamsSchema, mealCreateInputSchema, mealPatchSchema, mealUserPatchSchema, recordIdBodySchema } from '@fitness-coach/shared';
import { notFound } from '../errors.js';
import type { ServiceContext } from './context.js';

export function createMealsService({ repositories }: ServiceContext) {
  function entryId(date: string) {
    const entry = repositories.dailyEntry.getByDate(dateOnlySchema.parse(date));
    if (!entry) notFound('Daily entry not found');
    return entry.id;
  }

  return {
    create(date: string, input: unknown) {
      const id = entryId(date);
      return repositories.meal.save(id, mealCreateInputSchema.parse(input));
    },
    patchForDate(date: string, input: unknown) {
      const parentId = entryId(date);
      const patch = mealPatchSchema.parse(input) as { id: number } & Record<string, unknown>;
      const saved = repositories.meal.updateForParent(parentId, patch.id, patch);
      if (!saved) notFound('Meal not found for this date');
      return saved;
    },
    deleteForDate(date: string, input: unknown) {
      const parentId = entryId(date);
      const { id } = recordIdBodySchema.parse(input);
      const deleted = repositories.meal.deleteForParent(parentId, id);
      if (!deleted) notFound('Meal not found for this date');
      return deleted;
    },
    patch(idInput: unknown, input: unknown) {
      const { id } = idParamsSchema.parse({ id: idInput });
      const saved = repositories.meal.update(id, mealUserPatchSchema.parse(input));
      if (!saved) notFound('Meal not found');
      return saved;
    },
    delete(idInput: unknown) {
      const { id } = idParamsSchema.parse({ id: idInput });
      const deleted = repositories.meal.delete(id);
      if (!deleted) notFound('Meal not found');
      return deleted;
    },
  };
}
