import { dateOnlySchema, feedbackInputSchema, feedbackPatchSchema, recordIdBodySchema } from '@fitness-coach/shared';
import { notFound } from '../errors.js';
import type { ServiceContext } from './context.js';

export function createFeedbackService({ repositories }: ServiceContext) {
  function entryId(date: string) {
    const entry = repositories.dailyEntry.getByDate(dateOnlySchema.parse(date));
    if (!entry) notFound('Daily entry not found');
    return entry.id;
  }

  return {
    create(date: string, input: unknown) {
      return repositories.feedback.save(entryId(date), feedbackInputSchema.parse(input));
    },
    patch(date: string, input: unknown) {
      const patch = feedbackPatchSchema.parse(input) as { id: number } & Record<string, unknown>;
      const saved = repositories.feedback.updateForParent(entryId(date), patch.id, patch);
      if (!saved) notFound('Feedback not found for this date');
      return saved;
    },
    delete(date: string, input: unknown) {
      const { id } = recordIdBodySchema.parse(input);
      const deleted = repositories.feedback.deleteForParent(entryId(date), id);
      if (!deleted) notFound('Feedback not found for this date');
      return deleted;
    },
  };
}
