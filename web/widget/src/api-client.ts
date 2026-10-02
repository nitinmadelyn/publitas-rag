import type { WidgetConfig } from './config.js';
import type { ApiErrorBody, ChatResponseBody } from './types.js';

/** The API key is wrong/missing - a widget misconfiguration, not a user problem. */
export class ApiAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiAuthError';
  }
}

/** 429: too many requests. retryAfterSeconds is null when the server didn't send Retry-After. */
export class ApiRateLimitedError extends Error {
  readonly retryAfterSeconds: number | null;

  constructor(message: string, retryAfterSeconds: number | null) {
    super(message);
    this.name = 'ApiRateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ApiCatalogNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiCatalogNotFoundError';
  }
}

/** 400: the query itself was rejected (empty, too long, bad language code). */
export class ApiValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiValidationError';
  }
}

/** 503, or a network failure/timeout reaching the API at all. */
export class ApiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiUnavailableError';
  }
}

/** Any other non-2xx status this client doesn't have a specific case for. */
export class ApiUnknownError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiUnknownError';
    this.status = status;
  }
}

export interface ChatApiClientOptions {
  /** Injectable for testing; defaults to the browser's global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function parseRetryAfterSeconds(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const parsed = Number.parseInt(header, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Thin client over the RAG chat API's POST /v1/catalogs/:slug/chat
 * endpoint. Mirrors the hand-rolled, dependency-injected HTTP client
 * pattern used throughout the server codebase (lib/http-client.ts,
 * embeddings/openai-embedding-client.ts): every non-2xx response is
 * mapped to a specific, catchable error class so the UI layer can show a
 * message that actually matches what went wrong, rather than a generic
 * "something broke".
 */
export class ChatApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ChatApiClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async sendMessage(config: WidgetConfig, query: string): Promise<ChatResponseBody> {
    const url = `${config.apiBaseUrl}/v1/catalogs/${encodeURIComponent(config.catalogSlug)}/chat`;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
        },
        body: JSON.stringify({ query, languageCode: config.languageCode }),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new ApiUnavailableError('The request took too long and was cancelled. Please try again.');
      }
      throw new ApiUnavailableError('Could not reach the chat service. Check your connection and try again.');
    } finally {
      clearTimeout(timeout);
    }

    if (response.ok) {
      return (await response.json()) as ChatResponseBody;
    }

    if (response.status === 401 || response.status === 403) {
      throw new ApiAuthError('The chat widget is misconfigured. Please contact the site owner.');
    }
    if (response.status === 429) {
      throw new ApiRateLimitedError(
        'Too many questions at once. Please wait a moment and try again.',
        parseRetryAfterSeconds(response),
      );
    }
    if (response.status === 404) {
      throw new ApiCatalogNotFoundError('This catalog is not available for chat right now.');
    }
    if (response.status === 400) {
      const detail = await this.tryReadErrorMessage(response);
      throw new ApiValidationError(detail ?? 'That question could not be processed. Try rephrasing it.');
    }
    if (response.status === 503) {
      throw new ApiUnavailableError('The chat service is temporarily unavailable. Please try again shortly.');
    }
    throw new ApiUnknownError(
      `Unexpected response from the chat service (status ${response.status}).`,
      response.status,
    );
  }

  private async tryReadErrorMessage(response: Response): Promise<string | null> {
    try {
      const body = (await response.json()) as ApiErrorBody;
      return typeof body.error.message === 'string' ? body.error.message : null;
    } catch {
      return null;
    }
  }
}
