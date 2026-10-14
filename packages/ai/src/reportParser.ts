import { z } from 'zod';
import { AiClientError } from './parse.js';

export const recommendationReportSchema = z.object({
  summary: z.string().trim().min(1),
  trend: z.object({ observations: z.array(z.string()) }).passthrough(),
  trainingPlan: z.array(z.object({
    day: z.number().int().min(1).max(7),
    focus: z.string().trim().min(1),
    exercises: z.array(z.string()),
  }).passthrough()).length(7).refine(
    (plan) => new Set(plan.map(({ day }) => day)).size === 7,
    { message: 'trainingPlan must contain one entry for each day from 1 to 7' },
  ),
  dietAdvice: z.array(z.string()),
  recovery: z.array(z.string()),
  followUps: z.array(z.string()),
  safety: z.object({
    level: z.string().trim().min(1),
    banner: z.string().trim().min(1),
  }).passthrough(),
  uncertainties: z.array(z.string()),
}).passthrough();

export type RecommendationReport = z.infer<typeof recommendationReportSchema>;

export function parseRecommendationReport(content: string): RecommendationReport {
  let json: unknown;
  try {
    json = JSON.parse(content) as unknown;
  } catch {
    throw new AiClientError('AI_INVALID_JSON', 'AI response content is not valid JSON');
  }

  const parsed = recommendationReportSchema.safeParse(json);
  if (!parsed.success) {
    const paths = parsed.error.issues
      .slice(0, 3)
      .map((issue) => issue.path.join('.') || 'root')
      .join(', ');
    throw new AiClientError('AI_INVALID_RESPONSE', `AI response does not match the recommendation report schema (${paths})`);
  }
  return parsed.data;
}
