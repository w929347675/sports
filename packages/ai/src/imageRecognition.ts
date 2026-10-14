import { requestChatCompletion } from './client.js';
import { AiClientError, parseRecognitionResult } from './parse.js';
import { mealRecognitionSystemPrompt, mealRecognitionUserText } from './prompts.js';
import type { AiConfig, AiRequestOptions, ChatMessage, MealRecognizer, RecognizeMealInput } from './types.js';

export function createMealRecognizer(config: AiConfig, options: AiRequestOptions = {}): MealRecognizer {
  return (input) => recognizeMeal(input, config, options);
}

async function recognizeMeal(
  input: RecognizeMealInput,
  config: AiConfig,
  options: AiRequestOptions = {},
) {
  if (input.images.length === 0) {
    throw new AiClientError('AI_INVALID_INPUT', 'Meal recognition requires at least one image');
  }
  const text = mealRecognitionUserText(input.mealText, input.userPortion);
  const content: Extract<ChatMessage, { role: 'user' }>['content'] = [
    { type: 'text', text },
    ...input.images.map((image) => ({
      type: 'image_url' as const,
      image_url: { url: imageDataUrl(image) },
    })),
  ];
  const messages: ChatMessage[] = [
    { role: 'system', content: mealRecognitionSystemPrompt },
    { role: 'user', content },
  ];

  const responseContent = await requestChatCompletion(config, messages, options);
  return parseRecognitionResult(responseContent);
}

function imageDataUrl(image: RecognizeMealInput['images'][number]) {
  return 'dataUrl' in image ? image.dataUrl : `data:${image.mimeType};base64,${image.base64}`;
}
