import { dateOnlySchema, recordIdBodySchema, weightInputSchema, weightPatchSchema } from '@fitness-coach/shared';
import { notFound } from '../errors.js';
import type { ServiceContext } from './context.js';

export function createWeightsService({ repositories }: ServiceContext) {
  function entryId(date: string) {
    const entry = repositories.dailyEntry.getByDate(dateOnlySchema.parse(date));
    if (!entry) notFound('Daily entry not found');
    return entry.id;
  }

  return {
    create(date: string, input: unknown) {
      return repositories.weight.save(entryId(date), weightInputSchema.parse(input));
    },
    patch(date: string, input: unknown) {
      const patch = weightPatchSchema.parse(input) as { id: number } & Record<string, unknown>;
      const saved = repositories.weight.updateForParent(entryId(date), patch.id, patch);
      if (!saved) notFound('Weight measurement not found for this date');
      return saved;
    },
    delete(date: string, input: unknown) {
      const { id } = recordIdBodySchema.parse(input);
      const deleted = repositories.weight.deleteForParent(entryId(date), id);
      if (!deleted) notFound('Weight measurement not found for this date');
      return deleted;
    },
  };
}
