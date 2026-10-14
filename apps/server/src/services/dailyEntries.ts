import { dailyEntryInputSchema, dailyEntrySchema, dateOnlySchema, dateRangeQuerySchema } from '@fitness-coach/shared';
import type { ServiceContext } from './context.js';
import { createFilesService } from './files.js';

export function createDailyEntriesService({ repositories, dataDir }: ServiceContext) {
  const files = createFilesService({ repositories, dataDir });

  async function aggregate(entry: ReturnType<typeof repositories.dailyEntry.getByDate>) {
    if (!entry) return null;
    const weights = repositories.weight.listForEntry(entry.id);
    const meals = await Promise.all(repositories.meal.listForEntry(entry.id).map(async (meal) => ({
      ...meal,
       images: await Promise.all(repositories.image.listForEntry(meal.id).map((image) => files.imageStatus(image))),
      food_items: repositories.foodItem.listForEntry(meal.id),
    })));
    const workouts = repositories.workout.listForEntry(entry.id).map((workout) => ({
      ...workout,
      exercises: repositories.exercise.listForEntry(workout.id),
    }));
    const feedback = repositories.feedback.listForEntry(entry.id);
    return { ...entry, entry, weights, meals, workouts, feedback };
  }

  return {
    getByDate(input: unknown) {
      const date = dateOnlySchema.parse(input);
      return aggregate(repositories.dailyEntry.getByDate(date));
    },
    list(input: unknown) {
      const { from, to } = dateRangeQuerySchema.parse(input);
      return repositories.dailyEntry.listRange(from, to);
    },
    save(dateInput: unknown, body: unknown) {
      const entry_date = dateOnlySchema.parse(dateInput);
      const fields = dailyEntryInputSchema.parse(body);
      return repositories.dailyEntry.save({ entry_date, ...fields });
    },
  };
}
