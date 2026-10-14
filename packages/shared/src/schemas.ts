import { z } from 'zod';

export const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Must be a valid calendar date');

const dateTimeSchema = z.string().datetime({ offset: true });
const nonEmptyString = z.string().trim().min(1);
const positiveNumber = z.number().finite().positive();
const nonNegativeNumber = z.number().finite().nonnegative();

export const dailyStatusSchema = z.enum(['training', 'rest', 'paused_sick', 'travel', 'custom']);
export const mealRecognitionStatusSchema = z.enum([
  'unrecognized',
  'processing',
  'needs_review',
  'confirmed',
  'failed',
]);
export const feedbackCategorySchema = z.enum(['normal', 'discomfort', 'pain', 'fatigue', 'other']);
export const recommendationStatusSchema = z.enum(['processing', 'completed', 'failed']);
export const profileStatusSchema = z.enum(['active', 'archived']);
export const recommendationJobStatusSchema = z.enum([
  'queued',
  'preparing',
  'sending',
  'waiting_model',
  'receiving',
  'parsing',
  'saving',
  'completed',
  'failed',
  'cancelled',
]);

export const profileSchema = z.object({
  id: z.number().int().positive().optional(),
  goal: z.enum(['fat_loss', 'muscle_gain', 'maintain', 'custom']),
  height_cm: positiveNumber,
  age: z.number().int().min(1).max(150),
  sex: z.enum(['male', 'female', 'other', 'unspecified']),
  training_experience: nonEmptyString,
  equipment: nonEmptyString,
  training_days_per_week: z.number().int().min(0).max(7),
  session_duration_minutes: z.number().int().positive(),
  diet_preferences: z.string(),
  allergies: z.string(),
  health_restrictions: z.string(),
  updated_at: dateTimeSchema.optional(),
});

export const profileRecordSchema = profileSchema.extend({
  id: z.number().int().positive(),
  name: nonEmptyString,
  status: profileStatusSchema,
  goal_description: z.string(),
  created_at: dateTimeSchema,
  archived_at: dateTimeSchema.nullable(),
});

export const dailyEntrySchema = z.object({
  id: z.number().int().positive().optional(),
  profile_id: z.number().int().positive().optional(),
  entry_date: dateOnlySchema,
  status: dailyStatusSchema,
  status_note: z.string().optional(),
  created_at: dateTimeSchema.optional(),
  updated_at: dateTimeSchema.optional(),
});

export const weightMeasurementSchema = z.object({
  id: z.number().int().positive().optional(),
  daily_entry_id: z.number().int().positive().optional(),
  measured_at: dateTimeSchema,
  weight_kg: positiveNumber,
  note: z.string().optional(),
});

export const mealSchema = z.object({
  id: z.number().int().positive().optional(),
  daily_entry_id: z.number().int().positive().optional(),
  eaten_at: dateTimeSchema,
  meal_type: nonEmptyString,
  notes: z.string().optional(),
  recognition_status: mealRecognitionStatusSchema,
  created_at: dateTimeSchema.optional(),
  updated_at: dateTimeSchema.optional(),
});

export const mealImageSchema = z.object({
  id: z.number().int().positive().optional(),
  meal_id: z.number().int().positive().optional(),
  relative_path: nonEmptyString.refine((value) => !value.startsWith('/') && !value.split('/').includes('..'), {
    message: 'Image path must be relative to the local data directory',
  }),
  mime_type: nonEmptyString,
  file_size: z.number().int().positive(),
  created_at: dateTimeSchema.optional(),
});

export const foodItemSchema = z.object({
  id: z.number().int().positive().optional(),
  meal_id: z.number().int().positive().optional(),
  name: nonEmptyString,
  amount: positiveNumber,
  unit: nonEmptyString,
  cooking_method: z.string(),
  confidence: z.number().finite().min(0).max(1),
  needs_confirmation: z.boolean(),
  is_user_confirmed: z.boolean(),
  source: z.enum(['user', 'model']),
  notes: z.string().optional(),
});

export const workoutSchema = z.object({
  id: z.number().int().positive().optional(),
  daily_entry_id: z.number().int().positive().optional(),
  started_at: dateTimeSchema,
  workout_type: nonEmptyString,
  duration_minutes: z.number().int().positive().optional(),
  perceived_difficulty: z.number().finite().min(0).max(10).optional(),
  notes: z.string().optional(),
});

export const exerciseSchema = z.object({
  id: z.number().int().positive().optional(),
  workout_id: z.number().int().positive().optional(),
  name: nonEmptyString,
  weight: nonNegativeNumber.optional(),
  weight_unit: z.string().optional(),
  sets: z.number().int().positive(),
  repetitions: z.number().int().positive(),
  completed: z.boolean(),
  notes: z.string().optional(),
});

export const feedbackSchema = z.object({
  id: z.number().int().positive().optional(),
  daily_entry_id: z.number().int().positive().optional(),
  recorded_at: dateTimeSchema,
  category: feedbackCategorySchema,
  body_part: nonEmptyString,
  severity: z.number().finite().min(0).max(10),
  impact: z.string(),
  description: nonEmptyString,
  created_at: dateTimeSchema.optional(),
});

export const recommendationSchema = z.object({
  id: z.number().int().positive().optional(),
  profile_id: z.number().int().positive().optional(),
  job_id: nonEmptyString.nullable().optional().default(null),
  range_start: dateOnlySchema,
  range_end: dateOnlySchema,
  model_name: nonEmptyString,
  generated_at: dateTimeSchema.optional(),
  input_record_count: z.number().int().nonnegative().optional().default(0),
  image_review_count: z.number().int().nonnegative().optional().default(0),
  input_summary_json: z.string(),
  report_markdown: z.string(),
  structured_report_json: z.string(),
  error_code: nonEmptyString.nullable().optional().default(null),
  error_message: nonEmptyString.nullable().optional().default(null),
  status: recommendationStatusSchema,
});

function optionalQuery<S extends z.ZodTypeAny>(schema: S): z.ZodEffects<z.ZodOptional<S>>;
function optionalQuery<S extends z.ZodTypeAny>(schema: S, defaultValue: z.input<S>): z.ZodEffects<S>;
function optionalQuery<S extends z.ZodTypeAny>(schema: S, defaultValue?: z.input<S>) {
  return z.preprocess(
    (value) => value === '' || value === undefined ? defaultValue : value,
    defaultValue === undefined ? schema.optional() : schema,
  );
}
const urlBooleanSchema = z.enum(['true', 'false']).transform((value) => value === 'true');

export const recommendationMetadataSchema = z.object({
  job_id: nonEmptyString.nullable().default(null),
  input_record_count: z.number().int().nonnegative().default(0),
  image_review_count: z.number().int().nonnegative().default(0),
  error_code: nonEmptyString.nullable().default(null),
  error_message: nonEmptyString.nullable().default(null),
}).strict();

export const reportListQuerySchema = z.object({
  status: optionalQuery(recommendationStatusSchema),
  from: optionalQuery(dateOnlySchema),
  to: optionalQuery(dateOnlySchema),
  risk: optionalQuery(urlBooleanSchema),
  hasImages: optionalQuery(urlBooleanSchema),
  sort: optionalQuery(z.literal('generated_at')).default('generated_at'),
  order: optionalQuery(z.enum(['asc', 'desc'])).default('desc'),
  page: optionalQuery(z.coerce.number().int().positive(), 1),
  pageSize: optionalQuery(z.coerce.number().int().positive().max(100), 25),
}).strict().refine(({ from, to }) => from === undefined || to === undefined || from <= to, {
  message: 'from must not be after to',
});

export const reportBulkDeleteSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1),
}).strict();

export const reportExportQuerySchema = z.object({
  format: z.enum(['markdown', 'json']),
}).strict();

export const dailyEntryRecordSchema = dailyEntrySchema.extend({
  id: z.number().int().positive(),
  profile_id: z.number().int().positive(),
  status_note: z.string(),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
}).strict();

export const weightMeasurementRecordSchema = weightMeasurementSchema.extend({
  id: z.number().int().positive(),
  daily_entry_id: z.number().int().positive(),
  note: z.string(),
}).strict();

export const mealRecordSchema = mealSchema.extend({
  id: z.number().int().positive(),
  daily_entry_id: z.number().int().positive(),
  notes: z.string(),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
}).strict();

export const mealImageRecordSchema = mealImageSchema.extend({
  id: z.number().int().positive(),
  meal_id: z.number().int().positive(),
  created_at: dateTimeSchema,
}).strict();

export const foodItemRecordSchema = foodItemSchema.extend({
  id: z.number().int().positive(),
  meal_id: z.number().int().positive(),
  notes: z.string(),
}).strict();

export const workoutRecordSchema = workoutSchema.extend({
  id: z.number().int().positive(),
  daily_entry_id: z.number().int().positive(),
  duration_minutes: z.number().int().positive().nullable(),
  perceived_difficulty: z.number().finite().min(0).max(10).nullable(),
  notes: z.string(),
}).strict();

export const exerciseRecordSchema = exerciseSchema.extend({
  id: z.number().int().positive(),
  workout_id: z.number().int().positive(),
  weight: z.number().finite().nonnegative().nullable(),
  weight_unit: z.string(),
  notes: z.string(),
}).strict();

export const bodyFeedbackRecordSchema = feedbackSchema.extend({
  id: z.number().int().positive(),
  daily_entry_id: z.number().int().positive(),
  created_at: dateTimeSchema,
}).strict();

export const recommendationRecordSchema = recommendationSchema.extend({
  id: z.number().int().positive(),
  profile_id: z.number().int().positive(),
  generated_at: dateTimeSchema,
}).strict();

const sensitiveJobJsonKey = /^(?:api[_-]?key|base[_-]?url|model(?:[_-]?name)?|secret)$/i;
type SafeJsonValue = string | number | boolean | null | SafeJsonValue[] | { [key: string]: SafeJsonValue };
const safeJsonValueSchema: z.ZodType<SafeJsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(safeJsonValueSchema),
  z.record(safeJsonValueSchema).superRefine((value, context) => {
    for (const key of Object.keys(value)) {
      if (sensitiveJobJsonKey.test(key)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Sensitive job field is not allowed: ${key}` });
    }
  }),
  ]));

const safeJsonObjectSchema = z.record(safeJsonValueSchema).superRefine((value, context) => {
  for (const key of Object.keys(value)) {
    if (sensitiveJobJsonKey.test(key)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Sensitive job field is not allowed: ${key}` });
  }
});

export const recommendationJobImagePolicySchema = z.object({
  explicitReview: z.boolean().default(false),
  maxBytes: z.number().int().positive().optional(),
}).strict();

export const recommendationJobProfileSnapshotSchema = profileRecordSchema.strict();
export const recommendationJobSpecifiedMealPayloadSchema = z.union([
  safeJsonObjectSchema,
  z.array(safeJsonValueSchema),
]).nullable();

export const recommendationJobCreateInputSchema = z.object({
  range_start: dateOnlySchema,
  range_end: dateOnlySchema,
  image_policy: recommendationJobImagePolicySchema,
  specified_meal_ids: z.array(z.number().int().positive()).refine(
    (ids) => new Set(ids).size === ids.length,
    { message: 'Specified meal IDs must be unique' },
  ),
  specified_meal_payload: recommendationJobSpecifiedMealPayloadSchema,
  request_id: nonEmptyString.nullable().optional().default(null),
}).strict().refine(({ range_start, range_end }) => range_start <= range_end, {
  message: 'range_start must not be after range_end',
});

export const recommendationJobSchema = z.object({
  job_id: nonEmptyString,
  profile_id: z.number().int().positive(),
  profile_snapshot: recommendationJobProfileSnapshotSchema,
  range_start: dateOnlySchema,
  range_end: dateOnlySchema,
  image_policy: recommendationJobImagePolicySchema,
  specified_meal_ids: z.array(z.number().int().positive()),
  specified_meal_payload: recommendationJobSpecifiedMealPayloadSchema,
  status: recommendationJobStatusSchema,
  phase_percent: z.number().int().min(0).max(100),
  received_chars: z.number().int().nonnegative(),
  started_at: dateTimeSchema.nullable(),
  updated_at: dateTimeSchema,
  completed_at: dateTimeSchema.nullable(),
  error_code: nonEmptyString.nullable(),
  error_message: nonEmptyString.nullable(),
  error_phase: nonEmptyString.nullable(),
  request_id: nonEmptyString.nullable(),
  recommendation_id: z.number().int().positive().nullable(),
}).strict();

export const recommendationJobRequestSchema = z.object({
  start: dateOnlySchema.optional(),
  end: dateOnlySchema.optional(),
  explicitReview: z.boolean().default(false),
  specifiedMealIds: z.array(z.number().int().positive()).refine(
    (ids) => new Set(ids).size === ids.length,
    { message: 'Specified meal IDs must be unique' },
  ).default([]),
}).strict().refine(({ start, end }) => start === undefined || end === undefined || start <= end, {
  message: 'start must not be after end',
});

export const settingsSchema = z.object({
  base_url: z.string().url(),
  model_name: nonEmptyString,
  data_directory: nonEmptyString,
});

export const modelSettingsInputSchema = z.object({
  base_url: z.string().url(),
  model_name: nonEmptyString,
  api_key: nonEmptyString,
});

export const modelSettingsSchema = z.object({
  baseUrl: z.string().url().optional(),
  modelName: nonEmptyString.optional(),
  configured: z.boolean(),
});

export const dateParamsSchema = z.object({ date: dateOnlySchema });
export const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });
export const dateRangeQuerySchema = z.object({
  from: dateOnlySchema,
  to: dateOnlySchema,
}).refine(({ from, to }) => from <= to, { message: 'from must not be after to' });

export const profileInputSchema = profileSchema.omit({ id: true, updated_at: true });
export const profileRecordInputSchema = profileRecordSchema.omit({ id: true, created_at: true, updated_at: true, archived_at: true });
export const dailyEntryInputSchema = dailyEntrySchema.omit({
  id: true,
  entry_date: true,
  created_at: true,
  updated_at: true,
});
export const weightInputSchema = weightMeasurementSchema.omit({ id: true, daily_entry_id: true });
export const mealInputSchema = mealSchema.omit({
  id: true,
  daily_entry_id: true,
  created_at: true,
  updated_at: true,
});
export const mealCreateInputSchema = mealInputSchema.extend({ recognition_status: z.literal('unrecognized').default('unrecognized') }).strict();
const mealUserFieldsSchema = mealInputSchema.omit({ recognition_status: true });
export const mealUserPatchSchema = mealUserFieldsSchema.partial().strict().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'At least one field must be provided' },
);
export const workoutInputSchema = workoutSchema.omit({ id: true, daily_entry_id: true });
export const exerciseInputSchema = exerciseSchema.omit({ id: true, workout_id: true });
export const feedbackInputSchema = feedbackSchema.omit({ id: true, daily_entry_id: true, created_at: true });

function patchWithId<S extends z.AnyZodObject>(schema: S) {
  return schema.partial().extend({ id: z.number().int().positive() }).refine(
    (value) => Object.keys(value).some((key) => key !== 'id'),
    { message: 'At least one field must be provided' },
  );
}

export const weightPatchSchema = patchWithId(weightInputSchema);
export const mealPatchSchema = mealUserFieldsSchema.partial().extend({ id: z.number().int().positive() }).strict().refine(
  (value) => Object.keys(value).some((key) => key !== 'id'),
  { message: 'At least one field must be provided' },
);
export const workoutPatchSchema = patchWithId(workoutInputSchema);
export const exercisePatchSchema = patchWithId(exerciseInputSchema);
export const feedbackPatchSchema = patchWithId(feedbackInputSchema);
export const recordIdBodySchema = z.object({ id: z.number().int().positive() });

export const confirmFoodItemInputSchema = foodItemSchema.pick({
  id: true,
  name: true,
  amount: true,
  unit: true,
  cooking_method: true,
  confidence: true,
  needs_confirmation: true,
  notes: true,
});
export const confirmFoodItemsInputSchema = z.object({
  items: z.array(confirmFoodItemInputSchema).refine((items) => {
    const ids = items.flatMap((item) => item.id === undefined ? [] : [item.id]);
    return new Set(ids).size === ids.length;
  }, { message: 'Food item IDs must be unique' }),
});
export const recognizeMealsBatchInputSchema = z.object({
  mealIds: z.array(z.number().int().positive()).min(1).refine(
    (mealIds) => new Set(mealIds).size === mealIds.length,
    { message: 'Meal IDs must be unique' },
  ),
});

export const profileExportInputSchema = z.object({
  profileIds: z.array(z.number().int().positive()).min(1),
});

export const profileTransferImportExecuteInputSchema = z.object({
  importId: nonEmptyString,
  resolutions: z.array(z.object({
    profileId: z.number().int().positive(),
    strategy: z.enum(['new', 'skip', 'overwrite', 'cancel']),
    newName: z.string().optional(),
  }).strict()).optional(),
}).strict();

export const imageUploadSchema = z.object({
  filename: nonEmptyString,
  mime_type: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: z.instanceof(Uint8Array).refine((value) => value.length > 0, 'Image must not be empty'),
  file_size: z.number().int().positive().max(10 * 1024 * 1024),
});

export type Profile = z.infer<typeof profileSchema>;
export type ProfileRecord = z.infer<typeof profileRecordSchema>;
export type DailyEntry = z.infer<typeof dailyEntrySchema>;
export type WeightMeasurement = z.infer<typeof weightMeasurementSchema>;
export type Meal = z.infer<typeof mealSchema>;
export type MealImage = z.infer<typeof mealImageSchema>;
export type FoodItem = z.infer<typeof foodItemSchema>;
export type Workout = z.infer<typeof workoutSchema>;
export type Exercise = z.infer<typeof exerciseSchema>;
export type Feedback = z.infer<typeof feedbackSchema>;
export type Recommendation = z.infer<typeof recommendationSchema>;
export type DailyEntryRecord = z.infer<typeof dailyEntryRecordSchema>;
export type WeightMeasurementRecord = z.infer<typeof weightMeasurementRecordSchema>;
export type MealRecord = z.infer<typeof mealRecordSchema>;
export type MealImageRecord = z.infer<typeof mealImageRecordSchema>;
export type FoodItemRecord = z.infer<typeof foodItemRecordSchema>;
export type WorkoutRecord = z.infer<typeof workoutRecordSchema>;
export type ExerciseRecord = z.infer<typeof exerciseRecordSchema>;
export type BodyFeedbackRecord = z.infer<typeof bodyFeedbackRecordSchema>;
export type RecommendationRecord = z.infer<typeof recommendationRecordSchema>;
export type RecommendationJobStatus = z.infer<typeof recommendationJobStatusSchema>;
export type RecommendationJobImagePolicy = z.infer<typeof recommendationJobImagePolicySchema>;
export type RecommendationJobProfileSnapshot = z.infer<typeof recommendationJobProfileSnapshotSchema>;
export type RecommendationJobSpecifiedMealPayload = z.infer<typeof recommendationJobSpecifiedMealPayloadSchema>;
export type RecommendationJobCreateInput = z.infer<typeof recommendationJobCreateInputSchema>;
export type RecommendationJob = z.infer<typeof recommendationJobSchema>;
export type RecommendationJobRequest = z.infer<typeof recommendationJobRequestSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type ModelSettings = z.infer<typeof modelSettingsSchema>;
export type ConfirmFoodItemInput = z.infer<typeof confirmFoodItemInputSchema>;
export type ConfirmFoodItemsInput = z.infer<typeof confirmFoodItemsInputSchema>;
export type RecognizeMealsBatchInput = z.infer<typeof recognizeMealsBatchInputSchema>;
export type ProfileExportInput = z.infer<typeof profileExportInputSchema>;
export type ProfileTransferImportExecuteInput = z.infer<typeof profileTransferImportExecuteInputSchema>;
