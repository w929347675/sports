import type { AiConfig, AiRequestOptions, ChatMessage } from './types.js';
import { AiClientError } from './parse.js';

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  response_format: { type: 'json_object' };
  stream?: boolean;
}

export async function requestChatCompletion(
  config: AiConfig,
  messages: ChatMessage[],
  options: AiRequestOptions = {},
): Promise<string> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxRetries = Math.max(0, Math.min(3, Math.floor(options.maxRetries ?? 2)));
  const retryDelayMs = Math.max(0, Math.min(2_000, options.retryDelayMs ?? 100));
  const stream = options.stream ?? false;

  const requestAttempt = async () => {
    if (options.signal?.aborted) throw abortedError();
    const controller = new AbortController();
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let externalAbortListener: (() => void) | undefined;
    const externalAbort = options.signal
      ? new Promise<never>((_resolve, reject) => {
          const rejectAborted = () => reject(abortedError());
          externalAbortListener = rejectAborted;
          if (options.signal?.aborted) {
            rejectAborted();
          } else {
            options.signal?.addEventListener('abort', rejectAborted, { once: true });
          }
        })
      : undefined;
    const abortFromExternalSignal = () => controller.abort();
    options.signal?.addEventListener('abort', abortFromExternalSignal, { once: true });

    const request = async () => {
    let response: Response;
    try {
      response = await fetcher(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
          body: JSON.stringify({
            model: config.modelName,
            messages,
            response_format: { type: 'json_object' },
            ...(stream ? { stream: true } : {}),
          } satisfies ChatCompletionRequest),
        signal: controller.signal,
      });
    } catch {
      if (options.signal?.aborted) throw abortedError();
      if (timedOut) throw new AiClientError('AI_TIMEOUT', 'AI request timed out');
      throw new AiClientError('AI_NETWORK_ERROR', 'Unable to connect to the AI service');
    }

    if (options.signal?.aborted) throw abortedError();

    if (response.status === 401 || response.status === 403) {
      throw new AiClientError('AI_AUTHENTICATION_FAILED', 'AI service authentication failed');
    }
    if (!response.ok) {
      throw new AiClientError('AI_HTTP_ERROR', `AI service returned HTTP ${response.status}`, response.status);
    }

    let body: string;
    try {
      body = stream && response.headers.get('content-type')?.includes('text/event-stream')
        ? await readStreamingContent(response, options.onProgress, controller.signal)
        : await response.text();
    } catch (error) {
      if (options.signal?.aborted) throw abortedError();
      if (timedOut) throw new AiClientError('AI_TIMEOUT', 'AI request timed out');
      if (error instanceof AiClientError) throw error;
      throw new AiClientError('AI_NETWORK_ERROR', 'Unable to read the AI service response');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body) as unknown;
    } catch {
      throw new AiClientError('AI_INVALID_JSON', 'AI service returned invalid JSON');
    }

    if (!isRecord(payload) || !Array.isArray(payload.choices)) {
      throw new AiClientError('AI_INVALID_RESPONSE', 'AI service returned an invalid chat completion response');
    }
    const choice = payload.choices[0];
    if (!isRecord(choice) || !isRecord(choice.message) || typeof choice.message.content !== 'string') {
      throw new AiClientError('AI_INVALID_RESPONSE', 'AI service response is missing message content');
    }
    return choice.message.content;
    };

    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new AiClientError('AI_TIMEOUT', 'AI request timed out'));
      }, timeoutMs);
    });

    try {
      return await Promise.race([request(), timeout, ...(externalAbort ? [externalAbort] : [])]);
    } catch (error) {
      if (options.signal?.aborted) throw abortedError();
      if (error instanceof AiClientError) throw error;
      if (isAbortError(error)) throw error;
      if (timedOut) throw new AiClientError('AI_TIMEOUT', 'AI request timed out');
      throw new AiClientError('AI_NETWORK_ERROR', 'Unable to complete the AI request');
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      options.signal?.removeEventListener('abort', abortFromExternalSignal);
      if (externalAbortListener) options.signal?.removeEventListener('abort', externalAbortListener);
    }
  };

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await requestAttempt();
    } catch (error) {
      if (!(error instanceof AiClientError) || !isRetryable(error) || attempt === maxRetries) throw error;
      if (retryDelayMs > 0) await waitForRetry(retryDelayMs, options.signal);
    }
  }
  throw new AiClientError('AI_NETWORK_ERROR', 'Unable to complete the AI request');
}

async function readStreamingContent(
  response: Response,
  onProgress?: AiRequestOptions['onProgress'],
  signal?: AbortSignal,
): Promise<string> {
  if (!response.body) throw new AiClientError('AI_INVALID_RESPONSE', 'AI streaming response has no body');
  const reader = response.body.getReader();
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  const decoder = new TextDecoder();
  let pending = '';
  let content = '';

  if (signal?.aborted) throw abortedError();
  signal?.addEventListener('abort', cancelReader, { once: true });

  const consumeLine = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new AiClientError('AI_INVALID_JSON', 'AI streaming response contained invalid JSON');
    }
    const delta = (payload as { choices?: Array<{ delta?: { content?: unknown } }> }).choices?.[0]?.delta?.content;
     if (typeof delta === 'string') {
       content += delta;
       onProgress?.({ chunk: delta, receivedChars: content.length });
     }
  };

  try {
    while (true) {
      if (signal?.aborted) throw abortedError();
      const { done, value } = await reader.read();
      if (signal?.aborted) throw abortedError();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) consumeLine(line);
      if (done) break;
    }
    if (signal?.aborted) throw abortedError();
    if (pending) consumeLine(pending);
    return JSON.stringify({ choices: [{ message: { content } }] });
  } finally {
    signal?.removeEventListener('abort', cancelReader);
  }
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(abortedError());
    };

    if (signal?.aborted) {
      abort();
      return;
    }

    signal?.addEventListener('abort', abort, { once: true });
    timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
  });
}

function isRetryable(error: AiClientError) {
  return error.code === 'AI_NETWORK_ERROR' || (error.code === 'AI_HTTP_ERROR' && (error.statusCode ?? 0) >= 500);
}

function abortedError() {
  return new DOMException('AI request was cancelled', 'AbortError');
}

function isAbortError(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === 'AbortError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
