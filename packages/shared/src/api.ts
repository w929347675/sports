export type ApiSuccess<T> = {
  ok: true;
  data: T;
};

export type ApiFailure = {
  ok: false;
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
};

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export type HealthResponse = {
  ok: true;
  service: 'fitness-coach-server';
};

export type ProfileResponse = Omit<import('./schemas.js').Profile, 'api_key'>;
export type ProfileStatus = import('./schemas.js').ProfileRecord['status'];
export type ProfileSummary = {
  id: number;
  name: string;
  status: ProfileStatus;
  updated_at: string;
  recent_entry_date?: string;
  recent_report_at?: string;
};
export type CurrentProfile = {
  profile: import('./schemas.js').ProfileRecord | null;
};

export type RecommendationJobDetail = import('./schemas.js').RecommendationJob;
export type RecommendationJobCreateRequest = import('./schemas.js').RecommendationJobRequest;
export type RecommendationJobResponse = ApiResult<RecommendationJobDetail>;
export type RecommendationJobDetailResponse = RecommendationJobResponse;
export type RecommendationJobCreateResponse = ApiResult<RecommendationJobDetail>;
