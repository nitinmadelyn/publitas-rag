import { describe, expect, it, vi } from 'vitest';
import { HttpClient, HttpError, HttpTimeoutError } from '../src/lib/http-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

describe('HttpClient', () => {
  it('returns parsed JSON on a successful request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ hello: 'world' }));
    const client = new HttpClient({ timeoutMs: 1000, maxRetries: 3, baseDelayMs: 1, fetchImpl });

    const result = await client.getJson<{ hello: string }>('https://example.com/data');
    expect(result).toEqual({ hello: 'world' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries on a 500 and succeeds on the second attempt', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse('server error', 500))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new HttpClient({ timeoutMs: 1000, maxRetries: 3, baseDelayMs: 1, fetchImpl });

    const result = await client.getJson<{ ok: boolean }>('https://example.com/data');
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries on a 429', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse('rate limited', 429))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new HttpClient({ timeoutMs: 1000, maxRetries: 3, baseDelayMs: 1, fetchImpl });

    const result = await client.getJson<{ ok: boolean }>('https://example.com/data');
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry on a 404 and throws immediately', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse('not found', 404));
    const client = new HttpClient({ timeoutMs: 1000, maxRetries: 3, baseDelayMs: 1, fetchImpl });

    await expect(client.getJson('https://example.com/missing')).rejects.toThrow(HttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry on a 400', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse('bad request', 400));
    const client = new HttpClient({ timeoutMs: 1000, maxRetries: 3, baseDelayMs: 1, fetchImpl });

    await expect(client.getJson('https://example.com/bad')).rejects.toThrow(HttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries on a network error (TypeError from fetch)', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new HttpClient({ timeoutMs: 1000, maxRetries: 3, baseDelayMs: 1, fetchImpl });

    const result = await client.getJson<{ ok: boolean }>('https://example.com/data');
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws the last error after exhausting all retries', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse('server error', 503));
    const client = new HttpClient({ timeoutMs: 1000, maxRetries: 2, baseDelayMs: 1, fetchImpl });

    await expect(client.getJson('https://example.com/data')).rejects.toThrow(HttpError);
    // 1 initial attempt + 2 retries = 3 total calls
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('throws HttpError with malformed JSON body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse('not json{{{', 200));
    const client = new HttpClient({ timeoutMs: 1000, maxRetries: 0, baseDelayMs: 1, fetchImpl });

    await expect(client.getJson('https://example.com/data')).rejects.toThrow(HttpError);
  });

  it('throws HttpTimeoutError when the request exceeds timeoutMs', async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    });
    const client = new HttpClient({ timeoutMs: 10, maxRetries: 0, baseDelayMs: 1, fetchImpl });

    await expect(client.getJson('https://example.com/slow')).rejects.toThrow(HttpTimeoutError);
  });

  it('retries after a timeout and succeeds on the next attempt', async () => {
    let callCount = 0;
    const fetchImpl = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        });
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    const client = new HttpClient({ timeoutMs: 10, maxRetries: 2, baseDelayMs: 1, fetchImpl });

    const result = await client.getJson<{ ok: boolean }>('https://example.com/slow');
    expect(result).toEqual({ ok: true });
  });

  it('does not retry when maxRetries is 0', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse('server error', 500));
    const client = new HttpClient({ timeoutMs: 1000, maxRetries: 0, baseDelayMs: 1, fetchImpl });

    await expect(client.getJson('https://example.com/data')).rejects.toThrow(HttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('includes the response body (truncated) on HttpError for debuggability', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse('detailed server error message', 500));
    const client = new HttpClient({ timeoutMs: 1000, maxRetries: 0, baseDelayMs: 1, fetchImpl });

    try {
      await client.getJson('https://example.com/data');
      expect.fail('expected getJson to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const httpError = err as HttpError;
      expect(httpError.status).toBe(500);
      expect(httpError.body).toContain('detailed server error message');
    }
  });
});
