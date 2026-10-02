import { describe, expect, it, vi } from 'vitest';
import {
  ApiAuthError,
  ApiCatalogNotFoundError,
  ApiRateLimitedError,
  ApiUnavailableError,
  ApiUnknownError,
  ApiValidationError,
  ChatApiClient,
} from '../src/api-client.js';
import type { WidgetConfig } from '../src/config.js';

function config(overrides: Partial<WidgetConfig> = {}): WidgetConfig {
  return {
    apiBaseUrl: 'https://api.example.com',
    apiKey: 'widget-key-123',
    catalogSlug: 'tupperware',
    languageCode: 'en',
    title: 'Ask about this catalog',
    placeholder: 'Type your question...',
    greeting: 'Hi!',
    bubbleText: 'Looking for something specific? Ask me \u{1F44B}',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('ChatApiClient.sendMessage', () => {
  it('posts to /v1/catalogs/:slug/chat with the query and languageCode', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ answer: 'ok', citations: [], noContextFound: false }));
    const client = new ChatApiClient({ fetchImpl });

    await client.sendMessage(config(), 'how much is the pan');

    const call = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('https://api.example.com/v1/catalogs/tupperware/chat');
    expect(call[1].method).toBe('POST');
    const body = JSON.parse(call[1].body as string) as Record<string, unknown>;
    expect(body).toEqual({ query: 'how much is the pan', languageCode: 'en' });
  });

  it('URL-encodes the catalog slug', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ answer: 'ok', citations: [], noContextFound: false }));
    const client = new ChatApiClient({ fetchImpl });

    await client.sendMessage(config({ catalogSlug: 'a b/c' }), 'q');

    const call = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('https://api.example.com/v1/catalogs/a%20b%2Fc/chat');
  });

  it('sends the API key as x-api-key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ answer: 'ok', citations: [], noContextFound: false }));
    const client = new ChatApiClient({ fetchImpl });

    await client.sendMessage(config({ apiKey: 'secret-key' }), 'q');

    const call = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('secret-key');
  });

  it('returns the parsed JSON body on success', async () => {
    const responseBody = { answer: 'The pan costs $49.99 [1].', citations: [], noContextFound: false };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(responseBody));
    const client = new ChatApiClient({ fetchImpl });

    const result = await client.sendMessage(config(), 'q');
    expect(result).toEqual(responseBody);
  });

  it('throws ApiAuthError on 401', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: { code: 'unauthorized', message: 'x' } }, 401));
    const client = new ChatApiClient({ fetchImpl });
    await expect(client.sendMessage(config(), 'q')).rejects.toBeInstanceOf(ApiAuthError);
  });

  it('throws ApiAuthError on 403', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: { code: 'forbidden', message: 'x' } }, 403));
    const client = new ChatApiClient({ fetchImpl });
    await expect(client.sendMessage(config(), 'q')).rejects.toBeInstanceOf(ApiAuthError);
  });

  it('throws ApiRateLimitedError on 429 and parses Retry-After', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { code: 'rate_limited', message: 'x' } }, 429, { 'retry-after': '30' }));
    const client = new ChatApiClient({ fetchImpl });

    let caught: unknown;
    try {
      await client.sendMessage(config(), 'q');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiRateLimitedError);
    expect((caught as ApiRateLimitedError).retryAfterSeconds).toBe(30);
  });

  it('sets retryAfterSeconds to null when the server sends no Retry-After header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: { code: 'rate_limited', message: 'x' } }, 429));
    const client = new ChatApiClient({ fetchImpl });

    let caught: unknown;
    try {
      await client.sendMessage(config(), 'q');
    } catch (err) {
      caught = err;
    }
    expect((caught as ApiRateLimitedError).retryAfterSeconds).toBeNull();
  });

  it('throws ApiCatalogNotFoundError on 404', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: { code: 'catalog_not_found', message: 'x' } }, 404));
    const client = new ChatApiClient({ fetchImpl });
    await expect(client.sendMessage(config(), 'q')).rejects.toBeInstanceOf(ApiCatalogNotFoundError);
  });

  it('throws ApiValidationError on 400 and uses the server message when present', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { code: 'validation_error', message: 'query: too long' } }, 400));
    const client = new ChatApiClient({ fetchImpl });

    let caught: unknown;
    try {
      await client.sendMessage(config(), 'q');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiValidationError);
    expect((caught as ApiValidationError).message).toBe('query: too long');
  });

  it('falls back to a generic message on 400 when the body cannot be parsed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not json', { status: 400 }));
    const client = new ChatApiClient({ fetchImpl });

    await expect(client.sendMessage(config(), 'q')).rejects.toBeInstanceOf(ApiValidationError);
  });

  it('throws ApiUnavailableError on 503', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: { code: 'upstream_unavailable', message: 'x' } }, 503));
    const client = new ChatApiClient({ fetchImpl });
    await expect(client.sendMessage(config(), 'q')).rejects.toBeInstanceOf(ApiUnavailableError);
  });

  it('throws ApiUnknownError with the status for an unmapped status code', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 418));
    const client = new ChatApiClient({ fetchImpl });

    let caught: unknown;
    try {
      await client.sendMessage(config(), 'q');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiUnknownError);
    expect((caught as ApiUnknownError).status).toBe(418);
  });

  it('throws ApiUnavailableError when fetch rejects with a network error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const client = new ChatApiClient({ fetchImpl });
    await expect(client.sendMessage(config(), 'q')).rejects.toBeInstanceOf(ApiUnavailableError);
  });

  it('throws ApiUnavailableError when the request times out', async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    });
    const client = new ChatApiClient({ fetchImpl, timeoutMs: 5 });
    await expect(client.sendMessage(config(), 'q')).rejects.toBeInstanceOf(ApiUnavailableError);
  });

  it('aborts the request once the timeout elapses', async () => {
    let aborted = false;
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });
    const client = new ChatApiClient({ fetchImpl, timeoutMs: 5 });
    await client.sendMessage(config(), 'q').catch(() => undefined);
    expect(aborted).toBe(true);
  });
});
