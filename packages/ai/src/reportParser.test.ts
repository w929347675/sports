import { describe, expect, it } from 'vitest';
import { parseRecommendationReport } from './reportParser.js';

const completeReport = {
  summary: 'The period was consistent overall.',
  trend: { observations: ['Weight was stable.'] },
  trainingPlan: Array.from({ length: 7 }, (_, index) => ({ day: index + 1, focus: 'Strength', exercises: ['Squat'] })),
  dietAdvice: ['Keep protein consistent.'],
  recovery: ['Sleep at least eight hours.'],
  followUps: ['Review progress in seven days.'],
  safety: { level: 'low', banner: 'No immediate safety concerns.' },
  uncertainties: ['Some food amounts are estimates.'],
};

describe('recommendation report parser', () => {
  it('exposes safe schema paths when a report shape is invalid', () => {
    expect(() => parseRecommendationReport(JSON.stringify({
      summary: 'Summary',
      trend: { observations: [] },
      trainingPlan: [],
      dietAdvice: [],
      recovery: [],
      followUps: [],
      safety: { level: 'low', banner: 'Safe' },
      uncertainties: [],
    }))).toThrow(/trainingPlan/);
  });
  it('accepts a report containing every required top-level section', () => {
    expect(parseRecommendationReport(JSON.stringify(completeReport))).toEqual(completeReport);
  });

  it.each([
    'summary',
    'trend',
    'trainingPlan',
    'dietAdvice',
    'recovery',
    'followUps',
    'safety',
    'uncertainties',
  ] as const)('rejects a report missing %s', (missingField) => {
    const incomplete: Record<string, unknown> = { ...completeReport };
    delete incomplete[missingField];

    expect(() => parseRecommendationReport(JSON.stringify(incomplete))).toThrow();
  });

  it('rejects a training plan that does not cover all seven days', () => {
    const incomplete = { ...completeReport, trainingPlan: completeReport.trainingPlan.slice(0, 6) };

    expect(() => parseRecommendationReport(JSON.stringify(incomplete))).toThrow();
  });

  it('rejects a seven-item training plan with duplicate day numbers', () => {
    const duplicateDays = completeReport.trainingPlan.map((day, index) => index === 6 ? { ...day, day: 1 } : day);

    expect(() => parseRecommendationReport(JSON.stringify({ ...completeReport, trainingPlan: duplicateDays }))).toThrow();
  });
});
