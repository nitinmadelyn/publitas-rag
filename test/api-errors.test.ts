import { describe, expect, it } from 'vitest';
import { ZodError, z } from 'zod';
import { ApiError, toErrorResponse } from '../src/api/errors.js';
import { CatalogNotFoundError, RetrievalValidationError } from '../src/retrieval/errors.js';
import {
  ClaudeAuthError,
  ClaudeBadRequestError,
  ClaudeRequestError,
} from '../src/generation/claude-client.js';
import {
  EmbeddingAuthError,
  EmbeddingBadRequestError,
  EmbeddingRequestError,
} from '../src/embeddings/openai-embedding-client.js';

describe('toErrorResponse', () => {
  it('maps ApiError to its own statusCode and code', () => {
    const result = toErrorResponse(new ApiError(401, 'unauthorized', 'nope'), 'req-1');
    expect(result.statusCode).toBe(401);
    expect(result.body.error.code).toBe('unauthorized');
    expect(result.body.error.message).toBe('nope');
  });

  it('maps a ZodError to 400 with a validation_error code', () => {
    const schema = z.object({ query: z.string().min(1) });
    let zodError: ZodError | undefined;
    try {
      schema.parse({ query: '' });
    } catch (err) {
      zodError = err as ZodError;
    }
    expect(zodError).toBeInstanceOf(ZodError);

    const result = toErrorResponse(zodError, 'req-1');
    expect(result.statusCode).toBe(400);
    expect(result.body.error.code).toBe('validation_error');
    expect(result.body.error.message).toMatch(/query/);
  });

  it('maps RetrievalValidationError to 400', () => {
    const result = toErrorResponse(new RetrievalValidationError('query must not be empty'), 'req-1');
    expect(result.statusCode).toBe(400);
    expect(result.body.error.code).toBe('invalid_request');
  });

  it('maps CatalogNotFoundError to 404', () => {
    const result = toErrorResponse(new CatalogNotFoundError('ghost'), 'req-1');
    expect(result.statusCode).toBe(404);
    expect(result.body.error.code).toBe('catalog_not_found');
  });

  it('maps ClaudeAuthError to 500 without leaking the raw error message', () => {
    const result = toErrorResponse(new ClaudeAuthError('key rejected: sk-ant-secret'), 'req-1');
    expect(result.statusCode).toBe(500);
    expect(result.body.error.message).not.toMatch(/sk-ant-secret/);
  });

  it('maps EmbeddingAuthError to 500 without leaking the raw error message', () => {
    const result = toErrorResponse(new EmbeddingAuthError('key rejected: sk-secret'), 'req-1');
    expect(result.statusCode).toBe(500);
    expect(result.body.error.message).not.toMatch(/sk-secret/);
  });

  it('maps ClaudeBadRequestError to 500 without leaking the raw upstream body', () => {
    const result = toErrorResponse(
      new ClaudeBadRequestError('rejected', 400, 'upstream internal detail'),
      'req-1',
    );
    expect(result.statusCode).toBe(500);
    expect(result.body.error.message).not.toMatch(/upstream internal detail/);
  });

  it('maps EmbeddingBadRequestError to 500 without leaking the raw upstream body', () => {
    const result = toErrorResponse(
      new EmbeddingBadRequestError('rejected', 400, 'upstream internal detail'),
      'req-1',
    );
    expect(result.statusCode).toBe(500);
    expect(result.body.error.message).not.toMatch(/upstream internal detail/);
  });

  it('maps ClaudeRequestError to 503', () => {
    const result = toErrorResponse(new ClaudeRequestError('timed out', 0, ''), 'req-1');
    expect(result.statusCode).toBe(503);
    expect(result.body.error.code).toBe('upstream_unavailable');
  });

  it('maps EmbeddingRequestError to 503', () => {
    const result = toErrorResponse(new EmbeddingRequestError('rate limited', 429, ''), 'req-1');
    expect(result.statusCode).toBe(503);
    expect(result.body.error.code).toBe('upstream_unavailable');
  });

  it('forwards a Fastify-style 4xx error (e.g. malformed body) by its own statusCode', () => {
    const fastifyLikeError = Object.assign(new Error('Body is not valid JSON'), { statusCode: 400 });
    const result = toErrorResponse(fastifyLikeError, 'req-1');
    expect(result.statusCode).toBe(400);
    expect(result.body.error.code).toBe('bad_request');
  });

  it('does not treat a 5xx statusCode on an arbitrary object as a safe passthrough', () => {
    const fastifyLikeError = Object.assign(new Error('boom'), { statusCode: 500 });
    const result = toErrorResponse(fastifyLikeError, 'req-1');
    expect(result.statusCode).toBe(500);
    expect(result.body.error.code).toBe('internal_error');
  });

  it('maps a completely unknown thrown value to a generic 500', () => {
    const result = toErrorResponse('a plain string was thrown', 'req-1');
    expect(result.statusCode).toBe(500);
    expect(result.body.error.code).toBe('internal_error');
  });

  it('maps a plain Error with no statusCode to a generic 500', () => {
    const result = toErrorResponse(new Error('something broke'), 'req-1');
    expect(result.statusCode).toBe(500);
    expect(result.body.error.code).toBe('internal_error');
  });

  it('maps null/undefined thrown values to a generic 500 without throwing itself', () => {
    expect(toErrorResponse(null, 'req-1').statusCode).toBe(500);
    expect(toErrorResponse(undefined, 'req-1').statusCode).toBe(500);
  });
});
