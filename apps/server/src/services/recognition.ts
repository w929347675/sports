import { Buffer } from 'node:buffer';
import { AiClientError, createMealRecognizer, type AiConfig, type MealRecognizer } from '@fitness-coach/ai';
import { confirmFoodItemsInputSchema, idParamsSchema, recognizeMealsBatchInputSchema } from '@fitness-coach/shared';
import { ApiError, notFound } from '../errors.js';
import type { ServiceContext } from './context.js';
import { createFilesService } from './files.js';

type RecognitionDependencies = {
  recognizer?: MealRecognizer;
  recognizerFactory?: typeof createMealRecognizer;
  getModelCredentials?: () => Promise<AiConfig>;
};

const maxRecognitionImages = 12;
const maxRecognitionBytes = 20 * 1024 * 1024;

const aiErrorMessages = {
  AI_TIMEOUT: 'AI recognition timed out',
  AI_AUTHENTICATION_FAILED: 'AI service authentication failed',
  AI_NETWORK_ERROR: 'Unable to connect to the AI service',
  AI_INVALID_JSON: 'AI service returned invalid JSON',
  AI_INVALID_RESPONSE: 'AI service returned an invalid recognition result',
  AI_INVALID_INPUT: 'The recognition request is invalid',
  AI_HTTP_ERROR: 'AI service request failed',
} as const;

export function createRecognitionService(context: ServiceContext, dependencies: RecognitionDependencies = {}) {
  const { repositories } = context;
  const files = createFilesService(context);

  async function recognize(mealIdInput: unknown) {
    const { id: mealId } = idParamsSchema.parse({ id: mealIdInput });
    const meal = repositories.meal.get(mealId);
    if (!meal) notFound('Meal not found');
    if (meal.recognition_status === 'processing') {
      throw new ApiError('CONFLICT', 'Meal recognition is already processing');
    }

    repositories.meal.update(mealId, { recognition_status: 'processing' });
    try {
      let recognizer = dependencies.recognizer;
      if (!recognizer) {
        if (!dependencies.getModelCredentials) {
          throw new ApiError('CONFIGURATION_ERROR', 'Model configuration is unavailable');
        }
        const factory = dependencies.recognizerFactory ?? createMealRecognizer;
        recognizer = factory(await dependencies.getModelCredentials(), { timeoutMs: 120_000 });
      }

      const imageRecords = repositories.image.listForEntry(mealId);
      if (imageRecords.length > maxRecognitionImages) {
        throw new ApiError('VALIDATION_ERROR', 'Meal recognition supports at most 12 images');
      }
      const totalImageBytes = imageRecords.reduce((total, image) => total + image.file_size, 0);
      if (totalImageBytes > maxRecognitionBytes) {
        throw new ApiError('VALIDATION_ERROR', 'Meal recognition images exceed the 20 MiB total limit');
      }
       const images = [];
       let actualImageBytes = 0;
       for (const image of imageRecords) {
        if (image.meal_id !== mealId) {
          throw new ApiError('VALIDATION_ERROR', 'Image does not belong to meal');
         }
         const local = await files.readForMeal(mealId, image.id);
         actualImageBytes += local.bytes.length;
         if (actualImageBytes > maxRecognitionBytes) {
           throw new ApiError('VALIDATION_ERROR', 'Meal recognition images exceed the 20 MiB total limit');
         }
         images.push({ base64: Buffer.from(local.bytes).toString('base64'), mimeType: image.mime_type });
      }
      if (images.length === 0) {
        throw new ApiError('VALIDATION_ERROR', 'Meal recognition requires at least one image');
      }
      const result = await recognizer({
        mealText: meal.notes ?? '',
        userPortion: meal.notes ?? '',
        images,
      });
      return repositories.foodItem.replaceModelDrafts(mealId, result.items.map((item) => ({
        name: item.name,
        amount: item.amount,
        unit: item.unit,
        cooking_method: result.cookingMethod ?? '',
        confidence: item.confidence,
        needs_confirmation: item.needsConfirmation,
        is_user_confirmed: false,
        source: 'model' as const,
        notes: item.notes,
      })));
    } catch (error) {
      repositories.meal.update(mealId, { recognition_status: 'failed' });
      if (error instanceof AiClientError) {
        throw new ApiError(error.code, aiErrorMessages[error.code], error.code === 'AI_AUTHENTICATION_FAILED' ? 502 : 503);
      }
      throw error;
    }
  }

  return {
    recognize,
    confirm(mealIdInput: unknown, input: unknown) {
      const { id: mealId } = idParamsSchema.parse({ id: mealIdInput });
      const meal = repositories.meal.get(mealId);
      if (!meal) notFound('Meal not found');
      if (meal.recognition_status === 'processing') {
        throw new ApiError('CONFLICT', 'Meal recognition is still processing');
      }
      if (meal.recognition_status !== 'needs_review' && meal.recognition_status !== 'failed') {
        throw new ApiError('CONFLICT', 'Meal is not ready for confirmation');
      }
      if (
        meal.recognition_status === 'failed'
        && !repositories.foodItem.listForEntry(mealId).some((item) => item.source === 'model' && !item.is_user_confirmed)
      ) {
        throw new ApiError('CONFLICT', 'Failed meal has no recognition draft to confirm');
      }
      const { items } = confirmFoodItemsInputSchema.parse(input);
      try {
        return repositories.foodItem.confirmForMeal(mealId, items);
      } catch (error) {
        if ((error as Error).message === 'Food item does not belong to meal') {
          throw new ApiError('VALIDATION_ERROR', 'Food item does not belong to meal');
        }
        throw error;
      }
    },
    async recognizeBatch(input: unknown) {
      const { mealIds } = recognizeMealsBatchInputSchema.parse(input);
      const results = [];
      for (const mealId of mealIds) {
        try {
          results.push({ mealId, status: 'success' as const, data: await recognize(mealId) });
        } catch (error) {
          const apiError = error instanceof ApiError
            ? error
            : new ApiError('INTERNAL_ERROR', 'Meal recognition failed');
          results.push({
            mealId,
            status: 'failed' as const,
            error: { code: apiError.code, message: apiError.message },
          });
        }
      }
      return results;
    },
  };
}
