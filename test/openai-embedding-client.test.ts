import { describe, expect, it, vi } from 'vitest';
import {
  OpenAIEmbeddingClient,
  EmbeddingAuthError,
  EmbeddingBadRequestError,
  EmbeddingRequestError,
} from '../src/embeddings/openai-embedding-client.js';

function embeddingResponse(embeddings: number[][], status = 200): Response {
  return new Response(
    JSON.stringify({
      data: embeddings.map((embedding, index) => ({ embedding, index })),
      model: 'text-embedding-3-large',
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

describe('OpenAIEmbeddingClient.embedBatch', () => {
  it('returns [] without calling fetch for an empty batch', async () => {
    const fetchImpl = vi.fn();
    const client = new OpenAIEmbeddingClient({
      apiKey: 'sk-test',
      model: 'text-embedding-3-large',
      dimensions: 3,
      timeoutMs: 1000,
      maxRetries: 2,
      baseDelayMs: 1,
      fetchImpl,
    });

    expect(await client.embedBatch([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns embeddings on a successful request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      embeddingResponse([
        [0.1, 0.2],
        [0.3, 0.4],
      ]),
    );
    const client = new OpenAIEmbeddingClient({
      apiKey: 'sk-test',
      model: 'text-embedding-3-large',
      dimensions: 2,
      timeoutMs: 1000,
      maxRetries: 2,
      baseDelayMs: 1,
      fetchImpl,
    });

    const result = await client.embedBatch(['hello', 'world']);
    expect(result).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
  });

  it('sends model, input and dimensions in the request body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(embeddingResponse([[0.1]]));
    const client = new OpenAIEmbeddingClient({
      apiKey: 'sk-test',
      model: 'text-embedding-3-large',
      dimensions: 1,
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });

    await client.embedBatch(['hello']);
    const call = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as Record<string, unknown>;
    expect(body).toEqual({ model: 'text-embedding-3-large', input: ['hello'], dimensions: 1 });
  });

  it('sends the API key as a Bearer token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(embeddingResponse([[0.1]]));
    const client = new OpenAIEmbeddingClient({
      apiKey: 'sk-secret',
      model: 'text-embedding-3-large',
      dimensions: 1,
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });

    await client.embedBatch(['hello']);
    const call = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-secret');
  });

  it('re-sorts embeddings by the response index rather than trusting array order', async () => {
    const outOfOrder = new Response(
      JSON.stringify({
        data: [
          { embedding: [9, 9], index: 1 },
          { embedding: [1, 1], index: 0 },
        ],
        model: 'text-embedding-3-large',
      }),
      { status: 200 },
    );
    const fetchImpl = vi.fn().mockResolvedValue(outOfOrder);
    const client = new OpenAIEmbeddingClient({
      apiKey: 'sk-test',
      model: 'text-embedding-3-large',
      dimensions: 2,
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });

    const result = await client.embedBatch(['first', 'second']);
    expect(result).toEqual([
      [1, 1],
      [9, 9],
    ]);
  });

  it('throws EmbeddingAuthError on 401 without retrying', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse('unauthorized', 401));
    const client = new OpenAIEmbeddingClient({
      apiKey: 'sk-bad',
      model: 'text-embedding-3-large',
      dimensions: 2,
      timeoutMs: 1000,
      maxRetries: 3,
      baseDelayMs: 1,
      fetchImpl,
    });

    await expect(client.embedBatch(['hello'])).rejects.toBeInstanceOf(EmbeddingAuthError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws EmbeddingAuthError on 403 without retrying', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse('forbidden', 403));
    const client = new OpenAIEmbeddingClient({
      apiKey: 'sk-bad',
      model: 'text-embedding-3-large',
      dimensions: 2,
      timeoutMs: 1000,
      maxRetries: 3,
      baseDelayMs: 1,
      fetchImpl,
    });

    await expect(client.embedBatch(['hello'])).rejects.toBeInstanceOf(EmbeddingAuthError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws EmbeddingBadRequestError on 400 without retrying', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse('bad request', 400));
    const client = new OpenAIEmbeddingClient({
      apiKey: 'sk-test',
      model: 'text-embedding-3-large',
      dimensions: 2,
      timeoutMs: 1000,
      maxRetries: 3,
      baseDelayMs: 1,
      fetchImpl,
    });

    await expect(client.embedBatch(['hello'])).rejects.toBeInstanceOf(EmbeddingBadRequestError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse('rate limited', 429))
      .mockResolvedValueOnce(embeddingResponse([[0.1]]));
    const client = new OpenAIEmbeddingClient({
      apiKey: 'sk-test',
      model: 'text-embedding-3-large',
      dimensions: 1,
      timeoutMs: 1000,
      maxRetries: 3,
      baseDelayMs: 1,
      fetchImpl,
    });

    const result = await client.embedBatch(['hello']);
    expect(result).toEqual([[0.1]]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries on 500 and succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse('server error', 500))
      .mockResolvedValueOnce(embeddingResponse([[0.1]]));
    const client = new OpenAIEmbeddingClient({
      apiKey: 'sk-test',
      model: 'text-embedding-3-large',
      dimensions: 1,
      timeoutMs: 1000,
      maxRetries: 3,
      baseDelayMs: 1,
      fetchImpl,
    });

    const result = await client.embedBatch(['hello']);
    expect(result).toEqual([[0.1]]);
  });

  it('retries on a network error (TypeError) and succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(embeddingResponse([[0.1]]));
    const client = new OpenAIEmbeddingClient({
      apiKey: 'sk-test',
      model: 'text-embedding-3-large',
      dimensions: 1,
      timeoutMs: 1000,
      maxRetries: 3,
      baseDelayMs: 1,
      fetchImpl,
    });

    const result = await client.embedBatch(['hello']);
    expect(result).toEqual([[0.1]]);
  });

  it('treats an aborted/timed-out request as retryable', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('The operation was aborted', 'AbortError'))
      .mockResolvedValueOnce(embeddingResponse([[0.1]]));
    const client = new OpenAIEmbeddingClient({
      apiKey: 'sk-test',
      model: 'text-embedding-3-large',
      dimensions: 1,
      timeoutMs: 1000,
      maxRetries: 2,
      baseDelayMs: 1,
      fetchImpl,
    });

    const result = await client.embedBatch(['hello']);
    expect(result).toEqual([[0.1]]);
  });

  it('throws EmbeddingRequestError once retries on a 429 are exhausted', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse('rate limited', 429));
    const client = new OpenAIEmbeddingClient({
      apiKey: 'sk-test',
      model: 'text-embedding-3-large',
      dimensions: 1,
      timeoutMs: 1000,
      maxRetries: 2,
      baseDelayMs: 1,
      fetchImpl,
    });

    await expect(client.embedBatch(['hello'])).rejects.toBeInstanceOf(EmbeddingRequestError);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('makes exactly one attempt when maxRetries is 0', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse('server error', 500));
    const client = new OpenAIEmbeddingClient({
      apiKey: 'sk-test',
      model: 'text-embedding-3-large',
      dimensions: 1,
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });

    await expect(client.embedBatch(['hello'])).rejects.toBeInstanceOf(EmbeddingRequestError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws when the response has a different number of embeddings than inputs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(embeddingResponse([[0.1]]));
    const client = new OpenAIEmbeddingClient({
      apiKey: 'sk-test',
      model: 'text-embedding-3-large',
      dimensions: 1,
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });

    await expect(client.embedBatch(['a', 'b'])).rejects.toThrow(/returned 1 embeddings/);
  });
});
