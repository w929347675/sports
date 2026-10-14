import { describe, expect, it, vi } from 'vitest';
import { requestChatCompletion } from './client.js';
import type { AiConfig, FetchLike } from './types.js';

const config: AiConfig = {
  baseUrl: 'https://model.example/v1',
  apiKey: 'client-test-secret',
  modelName: 'test-model',
};

const messages = [{ role: 'user', content: 'Return JSON.' }] as const;

function successResponse() {
  return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
}

describe('requestChatCompletion retry policy', () => {
  it('retries a network failure once and returns the next successful response', async () => {
    let attempts = 0;
    const fetcher: FetchLike = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary network failure');
      return successResponse();
    });

    await expect(requestChatCompletion(config, [...messages], { fetch: fetcher, maxRetries: 1, retryDelayMs: 0 })).resolves.toBe('{"ok":true}');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retries a 5xx response but does not retry a 4xx response', async () => {
    const serverErrorFetcher: FetchLike = vi.fn()
      .mockResolvedValueOnce(new Response('temporary', { status: 503 }))
      .mockResolvedValueOnce(successResponse());
    await expect(requestChatCompletion(config, [...messages], { fetch: serverErrorFetcher, maxRetries: 1, retryDelayMs: 0 })).resolves.toBe('{"ok":true}');
    expect(serverErrorFetcher).toHaveBeenCalledTimes(2);

    const clientErrorFetcher: FetchLike = vi.fn(async () => new Response('bad request', { status: 400 }));
    await expect(requestChatCompletion(config, [...messages], { fetch: clientErrorFetcher, maxRetries: 3, retryDelayMs: 0 })).rejects.toMatchObject({ code: 'AI_HTTP_ERROR' });
    expect(clientErrorFetcher).toHaveBeenCalledTimes(1);
  });

  it('never retries authentication failures, invalid JSON, or exhausted server errors', async () => {
    const authFetcher: FetchLike = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    await expect(requestChatCompletion(config, [...messages], { fetch: authFetcher, maxRetries: 3, retryDelayMs: 0 })).rejects.toMatchObject({ code: 'AI_AUTHENTICATION_FAILED' });
    expect(authFetcher).toHaveBeenCalledTimes(1);

    const invalidJsonFetcher: FetchLike = vi.fn(async () => new Response('{not-json', { status: 200 }));
    await expect(requestChatCompletion(config, [...messages], { fetch: invalidJsonFetcher, maxRetries: 3, retryDelayMs: 0 })).rejects.toMatchObject({ code: 'AI_INVALID_JSON' });
    expect(invalidJsonFetcher).toHaveBeenCalledTimes(1);

    const exhaustedFetcher: FetchLike = vi.fn(async () => new Response('unavailable', { status: 503 }));
    await expect(requestChatCompletion(config, [...messages], { fetch: exhaustedFetcher, maxRetries: 2, retryDelayMs: 0 })).rejects.toMatchObject({ code: 'AI_HTTP_ERROR' });
    expect(exhaustedFetcher).toHaveBeenCalledTimes(3);
  });

  it('does not retry a timeout and aborts the current attempt', async () => {
    const fetcher: FetchLike = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));

    await expect(requestChatCompletion(config, [...messages], { fetch: fetcher, timeoutMs: 5, maxRetries: 3, retryDelayMs: 0 })).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('requests and combines streaming chat completion chunks', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetcher: FetchLike = vi.fn(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response([
        'data: {"choices":[{"delta":{"content":"{\\"summary\\":\\"ok"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":"\\"}"}}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });

    await expect(requestChatCompletion(config, [...messages], { fetch: fetcher, stream: true }))
      .resolves.toBe('{"summary":"ok"}');
    expect(requestBody).toMatchObject({ stream: true });
  });

  it('propagates external cancellation to fetch and does not retry it', async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const fetcher: FetchLike = vi.fn((_url, init) => {
      requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });

    const request = requestChatCompletion(config, [...messages], {
      fetch: fetcher,
      signal: controller.signal,
      maxRetries: 3,
      retryDelayMs: 0,
    });
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestSignal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('aborts during retry delay without starting another fetch', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const fetcher: FetchLike = vi.fn(async () => {
        throw new Error('temporary network failure');
      });

      const request = requestChatCompletion(config, [...messages], {
        fetch: fetcher,
        signal: controller.signal,
        maxRetries: 1,
        retryDelayMs: 1_000,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(1);

      controller.abort();
      const outcome = Promise.race([
        request.then(() => 'resolved', (error: unknown) => error),
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 1)),
      ]);
      await vi.advanceTimersByTimeAsync(1);

      await expect(outcome).resolves.toMatchObject({ name: 'AbortError' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts an unfinished streaming response and cancels its reader without retrying', async () => {
    const controller = new AbortController();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelCalls = 0;
    let firstChunkSeen!: () => void;
    const firstChunk = new Promise<void>((resolve) => {
      firstChunkSeen = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      start(currentController) {
        streamController = currentController;
        currentController.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"{\\"ok\\":"}}]}\n\n',
        ));
      },
      cancel() {
        cancelCalls += 1;
      },
    });
    const fetcher: FetchLike = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));

    try {
      const request = requestChatCompletion(config, [...messages], {
        fetch: fetcher,
        signal: controller.signal,
        stream: true,
        maxRetries: 3,
        retryDelayMs: 0,
        onProgress: () => firstChunkSeen(),
      });

      await firstChunk;
      controller.abort();

      await expect(request).rejects.toMatchObject({ name: 'AbortError' });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(cancelCalls).toBe(1);
    } finally {
      try {
        streamController?.close();
      } catch {
        // The reader may already have been cancelled by the implementation.
      }
    }
  });

  it('reports each streaming content chunk and cumulative received characters', async () => {
    const progress: Array<{ chunk: string; receivedChars: number }> = [];
    const fetcher: FetchLike = vi.fn(async () => new Response([
      'data: {"choices":[{"delta":{"content":"{\\"ok\\":"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"true}"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } }));

    await expect(requestChatCompletion(config, [...messages], {
      fetch: fetcher,
      stream: true,
      onProgress: (update) => progress.push(update),
    })).resolves.toBe('{"ok":true}');

    expect(progress).toEqual([
      { chunk: '{"ok":', receivedChars: 6 },
      { chunk: 'true}', receivedChars: 11 },
    ]);
    expect(progress.join(' ')).not.toContain(config.apiKey);
  });
});
