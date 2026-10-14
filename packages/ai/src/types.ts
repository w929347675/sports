export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  modelName: string;
}

export type MealImageInput =
  | { dataUrl: string }
  | { base64: string; mimeType: string };

export interface RecognizeMealInput {
  mealText: string;
  userPortion: string;
  images: MealImageInput[];
}

export interface RecognizedMealItem {
  name: string;
  amount: number;
  unit: string;
  confidence: number;
  needsConfirmation: boolean;
  notes: string;
}

export interface MealRecognitionResult {
  items: RecognizedMealItem[];
  cookingMethod: string | null;
  uncertainties: string[];
}

export type MealRecognizer = (input: RecognizeMealInput) => Promise<MealRecognitionResult>;

export type AiErrorCode =
  | 'AI_TIMEOUT'
  | 'AI_AUTHENTICATION_FAILED'
  | 'AI_NETWORK_ERROR'
  | 'AI_INVALID_JSON'
  | 'AI_INVALID_RESPONSE'
  | 'AI_INVALID_INPUT'
  | 'AI_HTTP_ERROR';

export interface AiRequestOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  stream?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: AiProgressUpdate) => void;
}

export interface AiProgressUpdate {
  chunk: string;
  receivedChars: number;
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type ChatMessage =
  | { role: 'system'; content: string }
  | {
      role: 'user';
      content: string | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >;
    };
