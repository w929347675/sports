import { describe, expect, it, vi } from 'vitest';
import { createMealRecognizer } from './imageRecognition.js';
import { parseRecognitionResult } from './parse.js';
import type { AiConfig, FetchLike, MealRecognizer, RecognizeMealInput } from './types.js';

const config: AiConfig = {
  baseUrl: 'https://model.example/v1',
  apiKey: 'secret-test-key',
  modelName: 'vision-model',
};

const input: RecognizeMealInput = {
  mealText: '鸡胸肉和米饭',
  userPortion: '一碗米饭，一块鸡胸肉',
  images: [{ dataUrl: 'data:image/jpeg;base64,ZmFrZQ==' }, { base64: 'c2Vjb25k', mimeType: 'image/png' }],
};

const recognitionJson = {
  items: [
    {
      name: '鸡胸肉',
      amount: 150,
      unit: 'g',
      confidence: 0.9,
      needsConfirmation: false,
      notes: '',
    },
  ],
  cookingMethod: '煎',
  uncertainties: [],
};

function runRecognition(input: RecognizeMealInput, fetcher: FetchLike, timeoutMs?: number) {
  return createMealRecognizer(config, { fetch: fetcher, timeoutMs })(input);
}

function responseWithContent(content: string, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
}

describe('recognizeMeal', () => {
  it('creates an injectable recognizer whose call accepts only meal input', async () => {
    const fetcher: FetchLike = vi.fn(async () => responseWithContent(JSON.stringify(recognitionJson)));
    const recognizer: MealRecognizer = createMealRecognizer(config, { fetch: fetcher });

    const result = await recognizer(input);

    expect(recognizer).toHaveLength(1);
    expect(result.items[0]?.name).toBe('鸡胸肉');
  });

  it('sends a compatible chat completion request without exposing the API key', async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const fetcher: FetchLike = vi.fn(async (url, init) => {
      request = { url: String(url), init: init ?? {} };
      return responseWithContent(JSON.stringify(recognitionJson));
    });

    const result = await runRecognition(input, fetcher);
    const body = JSON.parse(String(request?.init.body)) as {
      model: string;
      response_format: { type: string };
      messages: Array<{ role: string; content: unknown }>;
    };

    expect(request?.url).toBe('https://model.example/v1/chat/completions');
    expect(request?.init.headers).toEqual({
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    });
    expect(body.model).toBe(config.modelName);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0]).toMatchObject({ role: 'system' });
    expect(body.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: expect.stringContaining(input.mealText) },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,ZmFrZQ==' } },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,c2Vjb25k' } },
      ],
    });
    expect(JSON.stringify(body)).not.toContain(config.apiKey);
    expect(JSON.stringify(result)).not.toContain(config.apiKey);
  });

  it('rejects a meal input without images with a stable readable error', async () => {
    const fetcher: FetchLike = vi.fn(async () => responseWithContent(JSON.stringify(recognitionJson)));

    await expect(runRecognition({ mealText: '燕麦', userPortion: '一杯', images: [] }, fetcher))
      .rejects.toMatchObject({ code: 'AI_INVALID_INPUT' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps authentication failures to a stable readable error without the key', async () => {
    const fetcher: FetchLike = vi.fn(async () => responseWithContent('unauthorized', 401));

    await expect(runRecognition(input, fetcher)).rejects.toMatchObject({
      code: 'AI_AUTHENTICATION_FAILED',
    });
    await expect(runRecognition(input, fetcher)).rejects.not.toThrow(config.apiKey);
  });

  it('maps network rejection to a stable readable error without the key', async () => {
    const fetcher: FetchLike = vi.fn(async () => {
      throw new Error(`connection failed for ${config.apiKey}`);
    });

    await expect(runRecognition(input, fetcher)).rejects.toMatchObject({
      code: 'AI_NETWORK_ERROR',
    });
    await expect(runRecognition(input, fetcher)).rejects.not.toThrow(config.apiKey);
  });

  it('maps an aborted request caused by the timeout to a stable timeout error', async () => {
    const fetcher: FetchLike = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));

    await expect(runRecognition(input, fetcher, 5)).rejects.toMatchObject({
      code: 'AI_TIMEOUT',
    });
  });

  it('maps invalid JSON in the model content separately from an invalid response shape', async () => {
    const invalidJsonFetcher: FetchLike = vi.fn(async () => responseWithContent('{not-json'));
    const invalidShapeFetcher: FetchLike = vi.fn(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }));

    await expect(runRecognition(input, invalidJsonFetcher)).rejects.toMatchObject({
      code: 'AI_INVALID_JSON',
    });
    await expect(runRecognition(input, invalidShapeFetcher)).rejects.toMatchObject({
      code: 'AI_INVALID_RESPONSE',
    });
  });

  it('maps a response body read failure to a network error', async () => {
    const response = {
      ok: true,
      status: 200,
      text: async () => { throw new Error('stream failed'); },
    } as unknown as Response;
    const fetcher: FetchLike = vi.fn(async () => response);

    await expect(runRecognition(input, fetcher)).rejects.toMatchObject({
      code: 'AI_NETWORK_ERROR',
    });
  });
});

describe('parseRecognitionResult', () => {
  it('accepts unknown amount and cooking method while marking them for confirmation', () => {
    const result = parseRecognitionResult(JSON.stringify({
      items: [{
        name: '疑似沙拉酱',
        amount: 120,
        unit: 'g',
        confidence: 0.25,
        needsConfirmation: false,
        notes: '',
      }],
      cookingMethod: null,
      uncertainties: [],
    }));

    expect(result.items[0]).toMatchObject({
      amount: 120,
      needsConfirmation: true,
    });
    expect(result.items[0]?.notes).toMatch(/estimate|confirm/i);
    expect(result.cookingMethod).toBeNull();
    expect(result.uncertainties.join(' ')).toMatch(/cooking|unknown|confirm/i);
  });

  it('rejects malformed recognition items through the Zod contract', () => {
    expect(() => parseRecognitionResult(JSON.stringify({
      items: [{ name: '米饭', amount: '一碗' }],
      cookingMethod: '蒸',
      uncertainties: [],
    }))).toThrow();
  });

  it('rejects an unknown amount because output amounts must remain positive for food_items', () => {
    expect(() => parseRecognitionResult(JSON.stringify({
      items: [{
        name: '不可见食材',
        amount: null,
        unit: 'g',
        confidence: 0.2,
        needsConfirmation: true,
        notes: '无法确定，仅为估计',
      }],
      cookingMethod: null,
      uncertainties: ['重量无法确定'],
    }))).toThrow();
  });

  it('preserves confirmation for uncertain oil or invisible ingredients', () => {
    const result = parseRecognitionResult(JSON.stringify({
      items: [{
        name: '烹调油',
        amount: 10,
        unit: 'g',
        confidence: 0.9,
        needsConfirmation: true,
        notes: '油量不可见，仅为估计',
      }],
      cookingMethod: '煎',
      uncertainties: [],
    }));

    expect(result.items[0]?.needsConfirmation).toBe(true);
    expect(result.uncertainties.join(' ')).toMatch(/oil|unknown|confirm|不可见|估计/i);
  });

  it('forces confirmation for uncertain weight semantics without flagging every gram amount', () => {
    const result = parseRecognitionResult(JSON.stringify({
      items: [
        {
          name: '鸡胸肉',
          amount: 150,
          unit: 'g',
          confidence: 0.9,
          needsConfirmation: false,
          notes: '约重，份量估计',
        },
        {
          name: '米饭',
          amount: 180,
          unit: 'g',
          confidence: 0.9,
          needsConfirmation: false,
          notes: '',
        },
      ],
      cookingMethod: '蒸',
      uncertainties: [],
    }));

    expect(result.items[0]?.needsConfirmation).toBe(true);
    expect(result.items[1]?.needsConfirmation).toBe(false);
    expect(result.items[0]?.notes).toMatch(/estimate|confirm|估计/i);
  });

  it('associates a global weight uncertainty with the single estimated item', () => {
    const result = parseRecognitionResult(JSON.stringify({
      items: [{
        name: '米饭',
        amount: 180,
        unit: 'g',
        confidence: 0.9,
        needsConfirmation: false,
        notes: '',
      }],
      cookingMethod: '蒸',
      uncertainties: ['重量无法确定'],
    }));

    expect(result.items[0]).toMatchObject({ needsConfirmation: true });
    expect(result.items[0]?.notes).toContain('重量无法确定');
    expect(result.uncertainties).toEqual(['重量无法确定', expect.stringContaining('米饭')]);
  });

  it('associates a named weight uncertainty only with the named item', () => {
    const result = parseRecognitionResult(JSON.stringify({
      items: [
        { name: '鸡肉', amount: 100, unit: 'g', confidence: 0.9, needsConfirmation: false, notes: '' },
        { name: '米饭', amount: 180, unit: 'g', confidence: 0.9, needsConfirmation: false, notes: '' },
      ],
      cookingMethod: '蒸',
      uncertainties: ['鸡肉重量无法确定'],
    }));

    expect(result.items).toEqual([
      expect.objectContaining({ name: '鸡肉', needsConfirmation: true, notes: expect.stringContaining('鸡肉重量无法确定') }),
      expect.objectContaining({ name: '米饭', needsConfirmation: false, notes: expect.not.stringContaining('鸡肉重量无法确定') }),
    ]);
  });

  it('applies an explicit global portion uncertainty to estimated items without names', () => {
    const result = parseRecognitionResult(JSON.stringify({
      items: [
        { name: '米饭', amount: 180, unit: 'g', confidence: 0.9, needsConfirmation: false, notes: '' },
        { name: '鸡肉', amount: 120, unit: 'g', confidence: 0.9, needsConfirmation: false, notes: '' },
      ],
      cookingMethod: '蒸',
      uncertainties: ['份量无法确定'],
    }));

    expect(result.items).toEqual([
      expect.objectContaining({ name: '米饭', needsConfirmation: true, notes: expect.stringContaining('份量无法确定') }),
      expect.objectContaining({ name: '鸡肉', needsConfirmation: true, notes: expect.stringContaining('份量无法确定') }),
    ]);
  });

  it('marks every item when the cooking method is unknown and records the reason in notes', () => {
    const result = parseRecognitionResult(JSON.stringify({
      items: [{
        name: '米饭',
        amount: 180,
        unit: 'g',
        confidence: 0.9,
        needsConfirmation: false,
        notes: '',
      }],
      cookingMethod: null,
      uncertainties: [],
    }));

    expect(result.items[0]).toMatchObject({ needsConfirmation: true });
    expect(result.items[0]?.notes).toMatch(/cooking method|烹调方式|unknown|unknown/i);
    expect(result.uncertainties).toContain('Cooking method is unknown and needs confirmation.');
  });
});
