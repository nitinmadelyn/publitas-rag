import { describe, expect, it, vi } from 'vitest';
import {
  ClaudeClient,
  ClaudeAuthError,
  ClaudeBadRequestError,
  ClaudeRequestError,
} from '../src/generation/claude-client.js';

function messageResponse(text: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      model: 'claude-sonnet-5',
      stop_reason: 'end_turn',
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

function baseClientOptions(fetchImpl: typeof fetch): ConstructorParameters<typeof ClaudeClient>[0] {
  return {
    apiKey: 'sk-ant-test',
    model: 'claude-sonnet-5',
    maxTokens: 1024,
    timeoutMs: 1000,
    maxRetries: 2,
    baseDelayMs: 1,
    fetchImpl,
  };
}

describe('ClaudeClient.complete', () => {
  it('returns the text of a successful response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(messageResponse('The pan costs $49.99 [1].'));
    const client = new ClaudeClient(baseClientOptions(fetchImpl));

    const result = await client.complete('system prompt', 'user prompt');
    expect(result).toBe('The pan costs $49.99 [1].');
  });

  it('concatenates multiple text content blocks', async () => {
    const response = new Response(
      JSON.stringify({
        content: [
          { type: 'text', text: 'Part one. ' },
          { type: 'text', text: 'Part two.' },
        ],
        stop_reason: 'end_turn',
      }),
      { status: 200 },
    );
    const fetchImpl = vi.fn().mockResolvedValue(response);
    const client = new ClaudeClient(baseClientOptions(fetchImpl));

    const result = await client.complete('system', 'user');
    expect(result).toBe('Part one. Part two.');
  });

  it('sends model, max_tokens, system and the user message in the request body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(messageResponse('ok'));
    const client = new ClaudeClient(baseClientOptions(fetchImpl));

    await client.complete('be concise', 'what is the price');
    const call = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as Record<string, unknown>;
    expect(body).toEqual({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      system: 'be concise',
      messages: [{ role: 'user', content: 'what is the price' }],
    });
  });

  it('sends the API key as x-api-key and the anthropic-version header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(messageResponse('ok'));
    const client = new ClaudeClient(baseClientOptions(fetchImpl));

    await client.complete('system', 'user');
    const call = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('posts to the Anthropic messages endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(messageResponse('ok'));
    const client = new ClaudeClient(baseClientOptions(fetchImpl));

    await client.complete('system', 'user');
    const call = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('https://api.anthropic.com/v1/messages');
    expect(call[1].method).toBe('POST');
  });

  it('throws ClaudeAuthError on 401 without retrying', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse('unauthorized', 401));
    const client = new ClaudeClient(baseClientOptions(fetchImpl));

    await expect(client.complete('s', 'u')).rejects.toBeInstanceOf(ClaudeAuthError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws ClaudeAuthError on 403 without retrying', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse('forbidden', 403));
    const client = new ClaudeClient(baseClientOptions(fetchImpl));

    await expect(client.complete('s', 'u')).rejects.toBeInstanceOf(ClaudeAuthError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws ClaudeBadRequestError on 400 without retrying', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse('bad request', 400));
    const client = new ClaudeClient(baseClientOptions(fetchImpl));

    await expect(client.complete('s', 'u')).rejects.toBeInstanceOf(ClaudeBadRequestError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws ClaudeBadRequestError on 404 (e.g. unknown model id) without retrying', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse('not found', 404));
    const client = new ClaudeClient(baseClientOptions(fetchImpl));

    await expect(client.complete('s', 'u')).rejects.toBeInstanceOf(ClaudeBadRequestError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse('rate limited', 429))
      .mockResolvedValueOnce(messageResponse('ok'));
    const client = new ClaudeClient(baseClientOptions(fetchImpl));

    const result = await client.complete('s', 'u');
    expect(result).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries on 500 and succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse('server error', 500))
      .mockResolvedValueOnce(messageResponse('ok'));
    const client = new ClaudeClient(baseClientOptions(fetchImpl));

    const result = await client.complete('s', 'u');
    expect(result).toBe('ok');
  });

  it('retries on 529 (Anthropic overloaded_error) and succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse('overloaded', 529))
      .mockResolvedValueOnce(messageResponse('ok'));
    const client = new ClaudeClient(baseClientOptions(fetchImpl));

    const result = await client.complete('s', 'u');
    expect(result).toBe('ok');
  });

  it('retries on a network error (TypeError) and succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(messageResponse('ok'));
    const client = new ClaudeClient(baseClientOptions(fetchImpl));

    const result = await client.complete('s', 'u');
    expect(result).toBe('ok');
  });

  it('treats an aborted/timed-out request as retryable', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('The operation was aborted', 'AbortError'))
      .mockResolvedValueOnce(messageResponse('ok'));
    const client = new ClaudeClient(baseClientOptions(fetchImpl));

    const result = await client.complete('s', 'u');
    expect(result).toBe('ok');
  });

  it('throws ClaudeRequestError once retries on a 429 are exhausted', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse('rate limited', 429));
    const client = new ClaudeClient({ ...baseClientOptions(fetchImpl), maxRetries: 2 });

    await expect(client.complete('s', 'u')).rejects.toBeInstanceOf(ClaudeRequestError);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('makes exactly one attempt when maxRetries is 0', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse('server error', 500));
    const client = new ClaudeClient({ ...baseClientOptions(fetchImpl), maxRetries: 0 });

    await expect(client.complete('s', 'u')).rejects.toBeInstanceOf(ClaudeRequestError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws when the response has no text content blocks', async () => {
    const response = new Response(
      JSON.stringify({ content: [{ type: 'tool_use' }], stop_reason: 'tool_use' }),
      { status: 200 },
    );
    const fetchImpl = vi.fn().mockResolvedValue(response);
    const client = new ClaudeClient(baseClientOptions(fetchImpl));

    await expect(client.complete('s', 'u')).rejects.toThrow(/no text content/);
  });

  it('throws when the response has an empty content array', async () => {
    const response = new Response(JSON.stringify({ content: [], stop_reason: 'end_turn' }), {
      status: 200,
    });
    const fetchImpl = vi.fn().mockResolvedValue(response);
    const client = new ClaudeClient(baseClientOptions(fetchImpl));

    await expect(client.complete('s', 'u')).rejects.toThrow(/no text content/);
  });
});
