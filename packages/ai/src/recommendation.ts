import { requestChatCompletion } from './client.js';
import { parseRecommendationReport, type RecommendationReport } from './reportParser.js';
import type { AiConfig, AiRequestOptions, ChatMessage } from './types.js';

export type RecommendationModelInput = {
  priority?: string[];
  sections?: Record<string, unknown>;
  images?: Array<{
    id: number;
    mealId: number;
    createdAt: string;
    fileSize: number;
    base64: string;
    mimeType?: string;
    isConfirmed: boolean;
    riskRelated: boolean;
  }>;
  inputSummary?: Record<string, unknown>;
  [key: string]: unknown;
};

export type RecommendationResult = {
  modelName: string;
  report: RecommendationReport;
  markdown: string;
  inputSummary: Record<string, unknown>;
};

export type RecommendationModel = (input: RecommendationModelInput) => Promise<RecommendationResult>;

const recommendationSystemPrompt = `You are a fitness planning assistant, not a medical diagnostic tool. Analyze only the supplied profile and records. Weight, food portions, and visual recognition values may be inaccurate. Distinguish confirmed data, model estimates, and inferences. Do not invent missing data. If discomfort is severe, persistent, worsening, repeatedly recorded, or affects daily activities, put a clear safety banner at the top of the report, recommend stopping the relevant activity, and suggest professional evaluation. Return only one valid JSON object, with no markdown fences, using exactly these fields: summary (string), trend (object with observations string array), trainingPlan (array of exactly 7 objects, each with day 1 through 7, focus string, and exercises string array), dietAdvice (string array), recovery (string array), followUps (string array), safety (object with level string and banner string), uncertainties (string array).`;

export function createRecommendationModel(config: AiConfig, options: AiRequestOptions = {}): RecommendationModel {
  return async (input) => {
    const messages: ChatMessage[] = [
      { role: 'system', content: recommendationSystemPrompt },
      {
        role: 'user',
        content: input.images?.length
          ? [
              { type: 'text', text: JSON.stringify({ ...input, images: input.images.map(({ base64: _base64, ...image }) => image) }) },
              ...input.images.map((image) => ({
                type: 'image_url' as const,
                image_url: { url: `data:${image.mimeType ?? 'image/jpeg'};base64,${image.base64}` },
              })),
            ]
          : JSON.stringify(input),
      },
    ];
    const content = await requestChatCompletion(config, messages, { ...options, stream: true });
    const report = parseRecommendationReport(content);
    const inputSummary = input.inputSummary ?? summarizeInput(input);
    return {
      modelName: config.modelName,
      report,
      markdown: recommendationMarkdown(report),
      inputSummary,
    };
  };
}

function summarizeInput(input: RecommendationModelInput): Record<string, unknown> {
  const sections = input.sections ?? {};
  const structuredData = sections.structuredData;
  const recordCount = Array.isArray(structuredData)
    ? structuredData.length
    : typeof structuredData === 'object' && structuredData !== null && 'recordCount' in structuredData
      ? structuredData.recordCount
      : undefined;
  return {
    ...(recordCount === undefined ? {} : { recordCount }),
    imageCount: input.images?.length ?? 0,
  };
}

function recommendationMarkdown(report: RecommendationReport) {
  const lines = [
    '# Summary',
    report.summary,
    '',
    '## Trend',
    JSON.stringify(report.trend, null, 2),
    '',
    '## Training Plan',
    ...report.trainingPlan.map((item) => `- ${typeof item === 'string' ? item : JSON.stringify(item)}`),
    '',
    '## Diet Advice',
    ...report.dietAdvice.map((item) => `- ${typeof item === 'string' ? item : JSON.stringify(item)}`),
    '',
    '## Recovery',
    ...report.recovery.map((item) => `- ${typeof item === 'string' ? item : JSON.stringify(item)}`),
    '',
    '## Follow-ups',
    ...report.followUps.map((item) => `- ${typeof item === 'string' ? item : JSON.stringify(item)}`),
    '',
    '## Safety',
    `**${report.safety.level}**: ${report.safety.banner}`,
    '',
    '## Uncertainties',
    ...report.uncertainties.map((item) => `- ${item}`),
  ];
  return lines.join('\n');
}

export { parseRecommendationReport } from './reportParser.js';
export type { RecommendationReport } from './reportParser.js';
