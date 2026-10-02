import { ZodError } from 'zod';
import { CatalogNotFoundError, RetrievalValidationError } from '../retrieval/errors.js';
import {
  ClaudeAuthError,
  ClaudeBadRequestError,
  ClaudeRequestError,
} from '../generation/claude-client.js';
import {
  EmbeddingAuthError,
  EmbeddingBadRequestError,
  EmbeddingRequestError,
} from '../embeddings/openai-embedding-client.js';
import { logger } from '../lib/logger.js';

/**
 * Throw this from route handlers for a deliberate, well-known API-level
 * failure (auth, payload shape) that isn't already one of the domain
 * error classes below.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
  };
}

export interface ErrorResponse {
  statusCode: number;
  body: ErrorResponseBody;
}

/**
 * Type guard for Fastify's own thrown errors (malformed JSON body,
 * payload too large, unsupported content-type, etc.), which already carry
 * a statusCode. Used as a fallback so a request-shape problem Fastify
 * itself detects gets forwarded as the matching 4xx rather than
 * collapsing into a generic 500.
 */
function hasStatusCode(err: unknown): err is { statusCode: number; message: string } {
  if (typeof err !== 'object' || err === null) return false;
  if (!('statusCode' in err) || typeof err.statusCode !== 'number') return false;
  if (!('message' in err) || typeof err.message !== 'string') return false;
  return true;
}

/**
 * Maps any error thrown out of a route handler to an HTTP status code and
 * a stable, machine-readable body. This is the single place that decides
 * what a caller is allowed to see: upstream provider failures (Claude,
 * OpenAI) are logged in full detail but never expose their raw error body
 * to the client, since that could leak account/billing information about
 * our own API keys.
 */
export function toErrorResponse(err: unknown, requestId: string): ErrorResponse {
  if (err instanceof ApiError) {
    return { statusCode: err.statusCode, body: { error: { code: err.code, message: err.message } } };
  }

  if (err instanceof ZodError) {
    const message = err.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    return { statusCode: 400, body: { error: { code: 'validation_error', message } } };
  }

  if (err instanceof RetrievalValidationError) {
    return { statusCode: 400, body: { error: { code: 'invalid_request', message: err.message } } };
  }

  if (err instanceof CatalogNotFoundError) {
    return { statusCode: 404, body: { error: { code: 'catalog_not_found', message: err.message } } };
  }

  if (err instanceof ClaudeAuthError || err instanceof EmbeddingAuthError) {
    logger.fatal({ err, requestId }, 'Upstream AI provider rejected our API key');
    return {
      statusCode: 500,
      body: { error: { code: 'internal_error', message: 'The service is temporarily misconfigured.' } },
    };
  }

  if (err instanceof ClaudeBadRequestError || err instanceof EmbeddingBadRequestError) {
    logger.error({ err, requestId }, 'Upstream AI provider rejected our request');
    return {
      statusCode: 500,
      body: { error: { code: 'internal_error', message: 'Something went wrong processing your request.' } },
    };
  }

  if (err instanceof ClaudeRequestError || err instanceof EmbeddingRequestError) {
    logger.warn({ err, requestId }, 'Upstream AI provider unavailable after retries');
    return {
      statusCode: 503,
      body: {
        error: {
          code: 'upstream_unavailable',
          message: 'The service is temporarily unavailable. Please try again shortly.',
        },
      },
    };
  }

  if (hasStatusCode(err) && err.statusCode >= 400 && err.statusCode < 500) {
    return {
      statusCode: err.statusCode,
      body: { error: { code: 'bad_request', message: err.message } },
    };
  }

  logger.error({ err, requestId }, 'Unhandled error in API request');
  return {
    statusCode: 500,
    body: { error: { code: 'internal_error', message: 'An unexpected error occurred.' } },
  };
}
