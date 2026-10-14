import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDateRange } from './dateRange.js';

describe('resolveDateRange', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults to the local date and the 13 preceding calendar days', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 1, 12, 0, 0));

    expect(resolveDateRange()).toEqual({
      start: '2026-09-18',
      end: '2026-10-01',
    });
  });

  it('accepts an inclusive custom range when start is before or equal to end', () => {
    expect(resolveDateRange({ start: '2026-02-28', end: '2026-03-01' })).toEqual({
      start: '2026-02-28',
      end: '2026-03-01',
    });
    expect(resolveDateRange({ start: '2026-03-01', end: '2026-03-01' })).toEqual({
      start: '2026-03-01',
      end: '2026-03-01',
    });
  });

  it('allows at most 366 calendar days including both endpoints', () => {
    expect(resolveDateRange({ start: '2025-01-01', end: '2026-01-01' })).toEqual({
      start: '2025-01-01',
      end: '2026-01-01',
    });
  });

  it.each([
    { start: '2026-03-02', end: '2026-03-01' },
    { start: '2025-01-01', end: '2026-01-02' },
  ])('rejects an invalid or overlong range: %j', (range) => {
    expect(() => resolveDateRange(range)).toThrow();
  });
});
