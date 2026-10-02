import { logger } from '../lib/logger.js';

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const DEFAULT_BASE_DELAY_MS = 500;
const MAX_BACKOFF_DELAY_MS = 20_000;

/** 401/403: the API key itself is bad. Never retryable; the caller should abort the whole run. */
export class EmbeddingAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingAuthError';
  }
}

/** A 4xx (other than 429) rejecting the request body itself, e.g. malformed input or a context-length violation. Not retryable as-is; the caller may bisect the batch to isolate a poison item. */
export class EmbeddingBadRequestError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'EmbeddingBadRequestError';
    this.status = status;
    this.body = body;
  }
}

/** 429, 5xx, or a timeout (status 0), after retries are exhausted. */
export class EmbeddingRequestError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'EmbeddingRequestError';
    this.status = status;
    this.body = body;
  }
}

export interface EmbeddingClientOptions {
  apiKey: string;
  model: string;
  dimensions: number;
  timeoutMs: number;
  maxRetries: number;
  baseDelayMs?: number;
  /** Injectable for testing; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface OpenAIEmbeddingResponseItem {
  embedding: number[];
  index: number;
}

interface OpenAIEmbeddingResponse {
  data: OpenAIEmbeddingResponseItem[];
  model: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full jitter backoff, mirrors lib/http-client.ts's strategy for the Publitas client. */
function backoffDelay(attempt: number, baseDelayMs: number): number {
  const cap = Math.min(MAX_BACKOFF_DELAY_MS, baseDelayMs * 2 ** attempt);
  return Math.floor(Math.random() * cap);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Thin client over OpenAI's /v1/embeddings endpoint. Deliberately
 * hand-rolled rather than the `openai` SDK: the SDK pulls in a large
 * dependency surface for a single endpoint, and this project already has
 * an established retry/backoff pattern (lib/http-client.ts) that this
 * mirrors for consistency.
 */
export class OpenAIEmbeddingClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly dimensions: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: EmbeddingClientOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  /**
   * Embeds a batch of texts in one request, returned in the same order as
   * `texts`. OpenAI documents that the response preserves input order, but
   * this also re-sorts by the response's own `index` field defensively
   * rather than trusting that alone.
   *
   * Throws EmbeddingAuthError for 401/403 (never retried), throws
   * EmbeddingBadRequestError for other non-retryable 4xx (never retried),
   * and throws EmbeddingRequestError once retries on a transient failure
   * (429/5xx/network/timeout) are exhausted.
   */
  async embedBatch(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    let lastError: Error = new Error('embedBatch: unreachable initial state');

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = backoffDelay(attempt, this.baseDelayMs);
        logger.warn(
          { attempt, delayMs: delay, batchSize: texts.length },
          'Retrying OpenAI embeddings request',
        );
        await sleep(delay);
      }

      try {
        return await this.attemptOnce(texts);
      } catch (err) {
        if (err instanceof EmbeddingAuthError || err instanceof EmbeddingBadRequestError) {
          throw err;
        }
        lastError = err as Error;

        const isNetworkError = err instanceof TypeError;
        const isRetryableRequestError =
          err instanceof EmbeddingRequestError && (err.status === 0 || isRetryableStatus(err.status));
        const isRetryable = isNetworkError || isRetryableRequestError;

        if (!isRetryable || attempt === this.maxRetries) {
          logger.error(
            { err: lastError, batchSize: texts.length, attempt },
            'OpenAI embeddings request failed, not retrying further',
          );
          throw lastError;
        }
      }
    }

    // Unreachable: the loop above always either returns or throws.
    throw lastError;
  }

  private async attemptOnce(texts: readonly string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(OPENAI_EMBEDDINGS_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          dimensions: this.dimensions,
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '<unreadable body>');

        if (response.status === 401 || response.status === 403) {
          throw new EmbeddingAuthError(`OpenAI rejected the API key (status ${response.status})`);
        }
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          throw new EmbeddingBadRequestError(
            `OpenAI embeddings request rejected with status ${response.status}`,
            response.status,
            body.slice(0, 1000),
          );
        }
        throw new EmbeddingRequestError(
          `OpenAI embeddings request failed with status ${response.status}`,
          response.status,
          body.slice(0, 1000),
        );
      }

      const json = (await response.json()) as OpenAIEmbeddingResponse;
      const sorted = [...json.data].sort((a, b) => a.index - b.index);

      if (sorted.length !== texts.length) {
        throw new Error(
          `OpenAI returned ${sorted.length} embeddings for a batch of ${texts.length} inputs`,
        );
      }

      return sorted.map((item) => item.embedding);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new EmbeddingRequestError(
          `OpenAI embeddings request timed out after ${this.timeoutMs}ms`,
          0,
          '',
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
