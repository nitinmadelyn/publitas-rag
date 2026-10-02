import { logger } from './logger.js';

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;

  constructor(message: string, status: number, url: string, body: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export class HttpTimeoutError extends Error {
  readonly url: string;

  constructor(url: string, timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = 'HttpTimeoutError';
    this.url = url;
  }
}

export interface HttpClientOptions {
  timeoutMs: number;
  maxRetries: number;
  /** Base delay for exponential backoff, in ms. Actual delay is baseDelayMs * 2^attempt, plus jitter. */
  baseDelayMs?: number;
  /** Injectable for testing; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_DELAY_MS = 250;
const MAX_BACKOFF_DELAY_MS = 10_000;

/**
 * Status codes worth retrying: 429 (rate limited, back off and retry),
 * and 5xx (server-side, likely transient). Anything else (400, 401, 404,
 * etc.) is a client-side or permanent problem, retrying won't help and
 * would just hammer the API pointlessly.
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full jitter backoff: random delay between 0 and the exponential cap, avoids thundering-herd retries. */
function backoffDelay(attempt: number, baseDelayMs: number): number {
  const cap = Math.min(MAX_BACKOFF_DELAY_MS, baseDelayMs * 2 ** attempt);
  return Math.floor(Math.random() * cap);
}

export class HttpClient {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpClientOptions) {
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  /**
   * Fetches a URL and returns the parsed JSON body. Retries on network
   * errors, timeouts, 429, and 5xx, up to maxRetries times. Does not
   * retry on 4xx (other than 429), since those indicate a request the
   * server will never accept, retrying wastes time and quota.
   */
  async getJson<T>(url: string, requestId?: string): Promise<T> {
    let lastError: Error = new Error('getJson: unreachable initial state');

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = backoffDelay(attempt, this.baseDelayMs);
        logger.warn(
          { url, attempt, delayMs: delay, requestId },
          'Retrying Publitas API request after failure',
        );
        await sleep(delay);
      }

      try {
        return await this.attemptOnce<T>(url);
      } catch (err) {
        lastError = err as Error;

        const isRetryable =
          err instanceof HttpTimeoutError ||
          (err instanceof HttpError && isRetryableStatus(err.status)) ||
          this.isNetworkError(err);

        if (!isRetryable || attempt === this.maxRetries) {
          logger.error(
            { err: lastError, url, attempt, requestId },
            'Publitas API request failed, not retrying further',
          );
          throw lastError;
        }
      }
    }

    // Unreachable: the loop above always either returns or throws.
    throw lastError;
  }

  private isNetworkError(err: unknown): boolean {
    // Node's fetch throws TypeError for DNS failures, connection refused, etc.
    return err instanceof TypeError;
  }

  private async attemptOnce<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });

      if (!response.ok) {
        const body = await response.text().catch(() => '<unreadable body>');
        throw new HttpError(
          `Request to ${url} failed with status ${response.status}`,
          response.status,
          url,
          body.slice(0, 500),
        );
      }

      const text = await response.text();
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new HttpError(
          `Response from ${url} was not valid JSON`,
          response.status,
          url,
          text.slice(0, 500),
        );
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new HttpTimeoutError(url, this.timeoutMs);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
