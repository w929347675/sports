import { z } from 'zod';
import type { AiErrorCode, MealRecognitionResult } from './types.js';

export class AiClientError extends Error {
  constructor(
    public readonly code: AiErrorCode,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'AiClientError';
  }
}

export const recognitionResultSchema = z.object({
  items: z.array(z.object({
    name: z.string().trim().min(1),
    amount: z.number().finite().positive(),
    unit: z.string().trim().min(1),
    confidence: z.number().finite().min(0).max(1),
    needsConfirmation: z.boolean(),
    notes: z.string().default(''),
  })),
  cookingMethod: z.string().trim().min(1).nullable(),
  uncertainties: z.array(z.string().trim().min(1)),
});

const uncertaintyPattern = /(?:uncertain|unknown|estimate|estimated|approx(?:imate)?|invisible|not visible|cannot (?:see|determine)|不确定|未知|估计|大约|约重|重量|份量|分量|不可见|看不见|无法判断|无法确定|油量|烹调油|食用油|酱料|酱汁|调味汁)/i;
const uncertainNamePattern = /(?:oil|sauce|dressing|烹调油|食用油|油量|酱料|酱汁|调味汁)/i;
const explicitPortionUncertaintyPattern = /(?:weight|amount|portion|serving|重量|份量|分量|克数|无法确定)/i;
const explicitIngredientUncertaintyPattern = /(?:oil|sauce|dressing|invisible|not visible|cannot (?:see|determine)|不可见|看不见|油量|烹调油|食用油|酱料|酱汁|调味汁)/i;

export function parseRecognitionResult(content: string): MealRecognitionResult {
  let json: unknown;
  try {
    json = JSON.parse(content) as unknown;
  } catch {
    throw new AiClientError('AI_INVALID_JSON', 'AI response content is not valid JSON');
  }

  const parsed = recognitionResultSchema.safeParse(json);
  if (!parsed.success) {
    throw new AiClientError('AI_INVALID_RESPONSE', 'AI response does not match the meal recognition schema');
  }

  const cookingMethodUncertainty = 'Cooking method is unknown and needs confirmation.';
  const uncertainties = [...parsed.data.uncertainties];
  const items = parsed.data.items.map((item) => {
    const uncertaintyNames = parsed.data.items
      .filter(({ name }) => parsed.data.uncertainties.some((uncertainty) => uncertainty.includes(name)))
      .map(({ name }) => name);
    const relatedUncertainties = parsed.data.uncertainties.filter((uncertainty) => {
      if (!uncertaintyPattern.test(uncertainty)) return false;
      if (uncertainty.includes(item.name)) return true;
      if (uncertaintyNames.some((name) => uncertainty.includes(name))) return false;
      if (explicitPortionUncertaintyPattern.test(uncertainty)) return true;
      return parsed.data.items.length === 1 && explicitIngredientUncertaintyPattern.test(uncertainty);
    });
    const semanticUncertainty = uncertaintyPattern.test(item.notes)
      || uncertainNamePattern.test(item.name)
      || relatedUncertainties.length > 0
      || parsed.data.cookingMethod === null;
    const requiresConfirmation = item.confidence < 0.6 || item.needsConfirmation || semanticUncertainty;
    let notes = item.notes;
    if (item.confidence < 0.6 && !notes.trim()) {
      notes = 'Portion is a low-confidence estimate and needs confirmation.';
    }
    for (const uncertainty of relatedUncertainties) {
      notes = appendNote(notes, uncertainty);
    }
    if (parsed.data.cookingMethod === null) {
      notes = appendNote(notes, cookingMethodUncertainty);
    }
    if (semanticUncertainty && relatedUncertainties.length === 0 && parsed.data.cookingMethod !== null) {
      notes = appendNote(notes, 'This amount is an estimate and needs confirmation.');
    }
    if (requiresConfirmation) {
      uncertainties.push(`${item.name} is estimated and needs confirmation${notes ? `: ${notes}` : '.'}`);
    }
    return { ...item, needsConfirmation: requiresConfirmation, notes };
  });

  if (parsed.data.cookingMethod === null) {
    uncertainties.push(cookingMethodUncertainty);
  }

  return {
    items,
    cookingMethod: parsed.data.cookingMethod,
    uncertainties: [...new Set(uncertainties)],
  };
}

function appendNote(notes: string, addition: string) {
  return notes.includes(addition) ? notes : [notes.trim(), addition].filter(Boolean).join(' ');
}
