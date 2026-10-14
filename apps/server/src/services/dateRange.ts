import { dateOnlySchema } from '@fitness-coach/shared';

export type DateRange = { start: string; end: string };

export function resolveDateRange(input?: Partial<DateRange>): DateRange {
  if (input?.start === undefined && input?.end === undefined) {
    const today = new Date();
    const end = localDate(today);
    const startDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 13);
    return { start: localDate(startDate), end };
  }
  if (input.start === undefined || input.end === undefined) {
    throw new Error('Both start and end dates are required for a custom range');
  }

  const start = dateOnlySchema.parse(input.start);
  const end = dateOnlySchema.parse(input.end);
  const startTime = Date.parse(`${start}T00:00:00Z`);
  const endTime = Date.parse(`${end}T00:00:00Z`);
  const days = (endTime - startTime) / 86_400_000 + 1;
  if (days < 1) throw new Error('Date range start must not be after end');
  if (days > 366) throw new Error('Date range must not exceed 366 days');
  return { start, end };
}

function localDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
