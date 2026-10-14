import type {
  ApiResult,
  ConfirmFoodItemsInput,
  DailyEntry,
  Feedback,
  FoodItem,
  Meal,
  ModelSettings,
  Profile,
  ProfileRecord,
  ProfileSummary,
  RecommendationJob as SharedRecommendationJob,
  RecommendationJobRequest,
  WeightMeasurement,
  Workout,
} from '@fitness-coach/shared';

export type ProfileInput = Omit<Profile, 'id' | 'updated_at'>;
export type ManagedProfileInput = Omit<ProfileRecord, 'id' | 'status' | 'created_at' | 'updated_at' | 'archived_at'>;
export type ManagedProfile = Omit<ProfileRecord, 'created_at' | 'updated_at'> & {
  created_at: string;
  updated_at: string;
  last_entry_at: string | null;
  last_recommendation_at: string | null;
  record_days: number;
  report_count: number;
  has_unconfirmed_diet: boolean;
  has_high_risk_feedback: boolean;
};
export type ManagedProfileDetail = ManagedProfile & {
  summary: Pick<ManagedProfile, 'last_entry_at' | 'last_recommendation_at' | 'record_days' | 'report_count' | 'has_unconfirmed_diet' | 'has_high_risk_feedback'>;
  daily_entries: DailyEntryView[];
  recommendations: Recommendation[];
};
export type ProfileListFilters = {
  status?: 'active' | 'archived' | 'all';
  timeField?: 'created_at' | 'updated_at' | 'last_entry_at' | 'last_recommendation_at';
  from?: string;
  to?: string;
  sort?: 'created_at' | 'updated_at' | 'last_entry_at' | 'last_recommendation_at';
  order?: 'asc' | 'desc';
};
export type CurrentProfileResponse = { profile: ProfileRecord | null };
export type DailyEntryInput = Pick<DailyEntry, 'status' | 'status_note'>;
export type WeightInput = Omit<WeightMeasurement, 'id' | 'daily_entry_id'>;
export type MealInput = Omit<Meal, 'id' | 'daily_entry_id' | 'created_at' | 'updated_at'>;
export type WorkoutInput = Omit<Workout, 'id' | 'daily_entry_id'>;
export type FeedbackInput = Omit<Feedback, 'id' | 'daily_entry_id' | 'created_at'>;
export type RecordPatch = { id: number } & Record<string, unknown>;

export type RecommendationReport = {
  summary: string;
  trend: { observations: string[]; [key: string]: unknown };
  trainingPlan: Array<{ day: number; focus: string; exercises: string[]; [key: string]: unknown }>;
  dietAdvice: string[];
  recovery: string[];
  followUps: string[];
  safety: { level: string; banner: string; [key: string]: unknown };
  uncertainties: string[];
};

export type Recommendation = {
  id: number;
  profile_id: number;
  range_start: string;
  range_end: string;
  model_name: string;
  generated_at?: string;
  job_id?: string | null;
  input_record_count: number;
  image_review_count: number;
  input_summary_json: string;
  report_markdown: string;
  structured_report_json: string;
  error_code?: string | null;
  error_message?: string | null;
  status: 'processing' | 'completed' | 'failed';
  inputSummary?: Record<string, unknown>;
  report?: RecommendationReport;
  profile?: { id: number; name: string };
};

export type RecommendationJob = SharedRecommendationJob;
export type RecommendationJobInput = Omit<RecommendationJobRequest, 'specifiedMealIds'> & {
  specifiedMealIds?: number[];
};

export type ReportListQuery = {
  status?: '' | Recommendation['status'];
  from?: string;
  to?: string;
  risk?: '' | 'true' | 'false';
  hasImages?: '' | 'true' | 'false';
  sort?: 'generated_at';
  order?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
};

export type ManagedReportList = {
  items: Recommendation[];
  page: number;
  pageSize: number;
  total: number;
};

export type RecommendationPreview = {
  range: { start: string; end: string };
  inputSummary: Record<string, unknown>;
  imageCount: number;
  highRisk: boolean;
  explicitReview: boolean;
  safety: { level: string; banner: string };
};

export type BackupMetadata = {
  filename: string;
  size: number;
  createdAt: string;
};

export type BackupResult = {
  filename: string;
  size: number;
  manifest: { schema_version: number; includes_images: boolean };
};

export type ProfileTransferConflict = {
  type: 'profile_id' | 'profile_name';
  profileId: number;
  existingProfileId: number;
  incomingName: string;
  existingName: string;
};

export type ProfileTransferPreview = {
  importId: string;
  manifest: {
    format: string;
    version: number;
    created_at: string;
    schema_version: number;
    profiles: Array<{ id: number; name: string; status: 'active' | 'archived' }>;
    counts: Record<string, number>;
    images: Array<{ profile_id: number; path: string; size: number; sha256: string }>;
  };
  profileStats: Array<{
    id: number;
    name: string;
    status: 'active' | 'archived';
    images: number;
    reports: number;
    records: Record<string, number>;
  }>;
  conflicts: ProfileTransferConflict[];
};

export type ProfileTransferResolution = {
  profileId: number;
  strategy: 'new' | 'skip' | 'overwrite' | 'cancel';
  newName?: string;
};

export type ProfileTransferResult = {
  results: Array<{ sourceProfileId: number; targetProfileId: number; status: 'imported' | 'skipped' }>;
  cleanup_failures?: string[];
};

export function entryTimestamp(date: string) { return `${date}T12:00:00Z`; }

export type DailyEntryView = DailyEntry & {
  weights: Array<WeightMeasurement & { id: number }>;
  meals: Array<Meal & {
    id: number;
    images: Array<{
      id: number;
      relative_path: string;
      mime_type: string;
      file_size: number;
      warning?: string;
    }>;
    food_items: FoodItem[];
  }>;
  workouts: Array<Workout & {
    id: number;
    exercises: Array<{
      id: number;
      name: string;
      weight?: number;
      weight_unit?: string;
      sets: number;
      repetitions: number;
      completed: boolean;
      notes?: string;
    }>;
  }>;
  feedback: Array<Feedback & { id: number }>;
};

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;

  constructor(code: string, message: string, status: number, requestId?: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

async function download(path: string, init?: RequestInit): Promise<void> {
  const response = await fetch(path, init);
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const payload = await response.json() as ApiResult<unknown>;
      if (payload && 'error' in payload) message = payload.error.message;
    } catch {
      // Keep the generic message when the server did not return JSON.
    }
    throw new ApiRequestError('INTERNAL_ERROR', message, response.status, response.headers.get('x-request-id') ?? undefined);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = response.headers.get('content-disposition')?.match(/filename="?([^";]+)"?/)?.[1] ?? 'fitness-coach-export.json';
  anchor.click();
  URL.revokeObjectURL(url);
}

async function request<T>(path: string, init: RequestInit = {}, retries = 0): Promise<T> {
  try {
    const response = await fetch(path, init);
    const contentType = response.headers.get('content-type') ?? '';
    const payload = contentType.includes('application/json') ? await response.json() as ApiResult<T> : undefined;
    if (!response.ok || !payload || payload.ok === false) {
      const error = payload && 'error' in payload ? payload.error : { code: 'INTERNAL_ERROR', message: `Request failed (${response.status})` };
      if (retries > 0 && response.status >= 500) return request<T>(path, init, retries - 1);
      throw new ApiRequestError(error.code, error.message, response.status, response.headers.get('x-request-id') ?? undefined);
    }
    return payload.data;
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;
    if (retries > 0) return request<T>(path, init, retries - 1);
    throw new ApiRequestError('NETWORK_ERROR', '无法连接本地服务，请检查服务是否正在运行。', 0);
  }
}

function jsonRequest(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const api = {
  getProfile: () => request<Profile | null>('/api/profile', {}, 1),
  getCurrentProfile: () => request<CurrentProfileResponse>('/api/current-profile', {}, 1),
  listProfiles: (filters: ProfileListFilters = {}) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value) search.set(key, value);
    return request<ManagedProfile[]>(`/api/profiles${search.size > 0 ? `?${search}` : ''}`, {}, 1);
  },
  getProfileById: (profileId: number) => request<ManagedProfileDetail>(`/api/profiles/${profileId}`, {}, 1),
  createProfile: (input: ManagedProfileInput) => request<ProfileRecord>('/api/profiles', jsonRequest('POST', input)),
  updateProfile: (profileId: number, input: ManagedProfileInput) => request<ProfileRecord>(`/api/profiles/${profileId}`, jsonRequest('PATCH', input)),
  archiveProfile: (profileId: number) => request<ProfileRecord>(`/api/profiles/${profileId}/archive`, { method: 'POST' }),
  restoreProfile: (profileId: number) => request<ProfileRecord>(`/api/profiles/${profileId}/restore`, { method: 'POST' }),
  deleteProfiles: (profileIds: number[]) => request<{ deleted: number[]; cleanup_failures: string[] }>('/api/profiles', jsonRequest('DELETE', { ids: profileIds })),
  switchCurrentProfile: (profileId: number) => request<CurrentProfileResponse>('/api/current-profile', jsonRequest('PUT', { profileId })),
  saveProfile: (input: ProfileInput) => request<Profile>('/api/profile', jsonRequest('PUT', input)),
  getModelSettings: () => request<ModelSettings>('/api/settings/model', { method: 'GET' }, 1),
  saveModelSettings: (input: { base_url: string; model_name: string; api_key: string }) =>
    request<ModelSettings>('/api/settings/model', jsonRequest('PUT', input)),
  clearModelSettings: () => request<ModelSettings>('/api/settings/model', { method: 'DELETE' }),
  testModelConnection: () => request<{ connected: boolean; modelName: string }>('/api/settings/model/test', { method: 'POST' }),
  createBackup: () => request<BackupResult>('/api/backups', { method: 'POST' }),
  listBackups: () => request<BackupMetadata[]>('/api/backups', { method: 'GET' }, 1),
  exportProfiles: (profileIds: number[]) => download('/api/profiles/export', jsonRequest('POST', { profileIds })),
  previewProfileImport: (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return request<ProfileTransferPreview>('/api/profile-transfers/import/preview', { method: 'POST', body: formData });
  },
  executeProfileImport: (importId: string, resolutions: ProfileTransferResolution[]) =>
    request<ProfileTransferResult>('/api/profile-transfers/import/execute', jsonRequest('POST', { importId, resolutions })),
  downloadJsonExport: (includeImages: boolean) => download(`/api/export/json?include-images=${includeImages ? 'true' : 'false'}`),
  getDailyEntry: (date: string) => request<DailyEntryView | null>(`/api/daily-entries/${date}`, {}, 1),
  listDailyEntries: (from: string, to: string) => request<DailyEntry[]>(`/api/daily-entries?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {}, 1),
  saveDailyEntry: (date: string, input: DailyEntryInput) => request<DailyEntry>(`/api/daily-entries/${date}`, jsonRequest('PUT', input)),
  createWeight: (date: string, input: WeightInput) => request<WeightMeasurement & { id: number }>(`/api/daily-entries/${date}/weights`, jsonRequest('POST', input)),
  patchWeight: (date: string, input: RecordPatch) => request<WeightMeasurement & { id: number }>(`/api/daily-entries/${date}/weights`, jsonRequest('PATCH', input)),
  deleteWeight: (date: string, id: number) => request<WeightMeasurement & { id: number }>(`/api/daily-entries/${date}/weights`, jsonRequest('DELETE', { id })),
  createMeal: (date: string, input: MealInput) => request<Meal & { id: number }>(`/api/daily-entries/${date}/meals`, jsonRequest('POST', input)),
  patchMeal: (date: string, input: RecordPatch) => request<Meal & { id: number }>(`/api/daily-entries/${date}/meals`, jsonRequest('PATCH', input)),
  deleteMeal: (date: string, id: number) => request<Meal & { id: number }>(`/api/daily-entries/${date}/meals`, jsonRequest('DELETE', { id })),
  uploadMealImage: (mealId: number, file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return request(`/api/meals/${mealId}/images`, { method: 'POST', body: formData });
  },
  recognizeMeal: (mealId: number) => request<{ meal: Meal; food_items: FoodItem[] }>(`/api/meals/${mealId}/recognize`, { method: 'POST' }),
  recognizeMealsBatch: (mealIds: number[]) => request<Array<
    | { mealId: number; status: 'success'; data: { meal: Meal; food_items: FoodItem[] } }
    | { mealId: number; status: 'failed'; error: { code: string; message: string } }
  >>('/api/meals/recognize-batch', jsonRequest('POST', { mealIds })),
  confirmFoodItems: (mealId: number, input: ConfirmFoodItemsInput) =>
    request<{ meal: Meal; food_items: FoodItem[] }>(`/api/meals/${mealId}/confirm-food-items`, jsonRequest('POST', input)),
  listRecommendations: () => request<Recommendation[]>('/api/recommendations', { method: 'GET' }, 1),
  getRecommendation: (id: number) => request<Recommendation>(`/api/recommendations/${id}`, { method: 'GET' }, 1),
  listProfileRecommendations: (profileId: number, query: ReportListQuery = {}, signal?: AbortSignal) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') search.set(key, String(value));
    }
    return request<ManagedReportList>(`/api/profiles/${profileId}/recommendations${search.size ? `?${search}` : ''}`, { method: 'GET', signal }, 1);
  },
  getProfileRecommendation: (profileId: number, id: number) => request<Recommendation>(`/api/profiles/${profileId}/recommendations/${id}`, { method: 'GET' }, 1),
  createRecommendationJob: (profileId: number, input: RecommendationJobInput) =>
    request<RecommendationJob>(`/api/profiles/${profileId}/recommendation-jobs`, jsonRequest('POST', input)),
  getRecommendationJob: (profileId: number, jobId: string, signal?: AbortSignal) =>
    request<RecommendationJob>(`/api/profiles/${profileId}/recommendation-jobs/${encodeURIComponent(jobId)}`, { method: 'GET', signal }, 1),
  cancelRecommendationJob: (profileId: number, jobId: string) =>
    request<RecommendationJob>(`/api/profiles/${profileId}/recommendation-jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }),
  retryRecommendationJob: (profileId: number, jobId: string) =>
    request<RecommendationJob>(`/api/profiles/${profileId}/recommendation-jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST' }),
  deleteProfileRecommendation: (profileId: number, id: number) => request<{ id: number; profile: { id: number; name: string } }>(`/api/profiles/${profileId}/recommendations/${id}`, { method: 'DELETE' }),
  bulkDeleteProfileRecommendations: (profileId: number, ids: number[]) => request<{ deleted: number[] }>(`/api/profiles/${profileId}/recommendations/bulk-delete`, jsonRequest('POST', { ids })),
  downloadRecommendationExport: (profileId: number, id: number, format: 'markdown' | 'json') => download(`/api/profiles/${profileId}/recommendations/${id}/export?format=${format}`),
  previewRecommendation: (input: { start: string; end: string; explicitReview?: boolean; specifiedMealIds?: number[] }) =>
    request<RecommendationPreview>('/api/recommendations/preview', jsonRequest('POST', input)),
  createWorkout: (date: string, input: WorkoutInput) => request<Workout & { id: number }>(`/api/daily-entries/${date}/workouts`, jsonRequest('POST', input)),
  patchWorkout: (date: string, input: RecordPatch) => request<Workout & { id: number }>(`/api/daily-entries/${date}/workouts`, jsonRequest('PATCH', input)),
  deleteWorkout: (date: string, id: number) => request<Workout & { id: number }>(`/api/daily-entries/${date}/workouts`, jsonRequest('DELETE', { id })),
  createExercise: (workoutId: number, input: { name: string; weight?: number; weight_unit?: string; sets: number; repetitions: number; completed: boolean; notes?: string }) =>
    request(`/api/workouts/${workoutId}/exercises`, jsonRequest('POST', input)),
  patchExercise: (workoutId: number, input: RecordPatch) => request(`/api/workouts/${workoutId}/exercises`, jsonRequest('PATCH', input)),
  deleteExercise: (workoutId: number, id: number) => request(`/api/workouts/${workoutId}/exercises`, jsonRequest('DELETE', { id })),
  createFeedback: (date: string, input: FeedbackInput) => request<Feedback & { id: number }>(`/api/daily-entries/${date}/feedback`, jsonRequest('POST', input)),
  patchFeedback: (date: string, input: RecordPatch) => request<Feedback & { id: number }>(`/api/daily-entries/${date}/feedback`, jsonRequest('PATCH', input)),
  deleteFeedback: (date: string, id: number) => request<Feedback & { id: number }>(`/api/daily-entries/${date}/feedback`, jsonRequest('DELETE', { id })),
};
