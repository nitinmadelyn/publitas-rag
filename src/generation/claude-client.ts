import { logger } from '../lib/logger.js';

const CLAUDE_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_BASE_DELAY_MS = 500;
const MAX_BACKOFF_DELAY_MS = 20_000;

/** 401/403: the API key itself is bad. Never retryable; the caller should abort the whole run. */
export class ClaudeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeAuthError';
  }
}

/**
 * A 4xx (other than 429) rejecting the request itself, e.g. a malformed
 * body or an unknown model id. Not retryable as-is.
 */
export class ClaudeBadRequestError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'ClaudeBadRequestError';
    this.status = status;
    this.body = body;
  }
}

/**
 * 429, 5xx (including Anthropic's 529 overloaded_error), or a timeout
 * (status 0), after retries are exhausted.
 */
export class ClaudeRequestError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'ClaudeRequestError';
    this.status = status;
    this.body = body;
  }
}

export interface ClaudeClientOptions {
  apiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  maxRetries: number;
  baseDelayMs?: number;
  /** Injectable for testing; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface ClaudeContentBlock {
  type: string;
  text?: string;
}

interface ClaudeMessageResponse {
  content: ClaudeContentBlock[];
  stop_reason: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full jitter backoff, mirrors the OpenAI embedding client's strategy. */
function backoffDelay(attempt: number, baseDelayMs: number): number {
  const cap = Math.min(MAX_BACKOFF_DELAY_MS, baseDelayMs * 2 ** attempt);
  return Math.floor(Math.random() * cap);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Thin client over Anthropic's Messages API. Hand-rolled rather than the
 * `@anthropic-ai/sdk` package: this project uses exactly one endpoint (a
 * single-turn completion with a system prompt), and it already has an
 * established retry/backoff pattern (lib/http-client.ts,
 * openai-embedding-client.ts) that this mirrors for consistency rather
 * than pulling in a second, differently-shaped HTTP abstraction.
 */
export class ClaudeClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClaudeClientOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.maxTokens = options.maxTokens;
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  /**
   * Sends a single-turn completion request (one system prompt, one user
   * message) and returns the concatenated text of every text content
   * block in the response.
   *
   * Throws ClaudeAuthError for 401/403 (never retried), throws
   * ClaudeBadRequestError for other non-retryable 4xx (never retried), and
   * throws ClaudeRequestError once retries on a transient failure
   * (429/5xx/network/timeout) are exhausted.
   */
  async complete(system: string, userPrompt: string): Promise<string> {
    let lastError: Error = new Error('complete: unreachable initial state');

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = backoffDelay(attempt, this.baseDelayMs);
        logger.warn({ attempt, delayMs: delay }, 'Retrying Claude generation request');
        await sleep(delay);
      }

      try {
        return await this.attemptOnce(system, userPrompt);
      } catch (err) {
        if (err instanceof ClaudeAuthError || err instanceof ClaudeBadRequestError) {
          throw err;
        }
        lastError = err as Error;

        const isNetworkError = err instanceof TypeError;
        const isRetryableRequestError =
          err instanceof ClaudeRequestError && (err.status === 0 || isRetryableStatus(err.status));
        const isRetryable = isNetworkError || isRetryableRequestError;

        if (!isRetryable || attempt === this.maxRetries) {
          logger.error(
            { err: lastError, attempt },
            'Claude generation request failed, not retrying further',
          );
          throw lastError;
        }
      }
    }

    // Unreachable: the loop above always either returns or throws.
    throw lastError;
  }

  private async attemptOnce(system: string, userPrompt: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(CLAUDE_MESSAGES_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_API_VERSION,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: this.maxTokens,
          system,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '<unreadable body>');

        if (response.status === 401 || response.status === 403) {
          throw new ClaudeAuthError(`Claude rejected the API key (status ${response.status})`);
        }
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          throw new ClaudeBadRequestError(
            `Claude generation request rejected with status ${response.status}`,
            response.status,
            body.slice(0, 1000),
          );
        }
        throw new ClaudeRequestError(
          `Claude generation request failed with status ${response.status}`,
          response.status,
          body.slice(0, 1000),
        );
      }

      const json = (await response.json()) as ClaudeMessageResponse;
      const text = json.content
        .filter((block): block is ClaudeContentBlock & { text: string } =>
          block.type === 'text' && typeof block.text === 'string',
        )
        .map((block) => block.text)
        .join('');

      if (text.length === 0) {
        throw new Error('Claude returned a response with no text content blocks');
      }

      return text;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new ClaudeRequestError(
          `Claude generation request timed out after ${this.timeoutMs}ms`,
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
