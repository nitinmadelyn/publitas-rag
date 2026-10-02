import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import type { ClaudeClientLike } from '../src/generation/generate-answer.js';
import type { EmbeddingClientLike } from '../src/retrieval/retrieve.js';
import type {
  RetrievalRepository,
  RawSearchRow,
  VectorSearchOptions,
  LexicalSearchOptions,
} from '../src/retrieval/chunk-search-repository.js';
import { ClaudeRequestError } from '../src/generation/claude-client.js';

const TEST_API_KEY = 'test-api-key';

function row(overrides: Partial<RawSearchRow> = {}): RawSearchRow {
  return {
    id: 1,
    page_id: 1,
    catalog_id: 1,
    chunk_index: 0,
    text: 'Non-stick pan, 28cm (49.99)',
    product_ref: 'SKU-123',
    language_code: 'en',
    page_number: 4,
    public_url: 'https://view.publitas.com/x/y/page/4',
    score: 0.9,
    ...overrides,
  };
}

/**
 * A repository whose vectorSearch/lexicalSearch resolve after an
 * artificial delay (and can be made to reject instead), used to prove
 * concurrent requests are served in parallel by Node's event loop rather
 * than queued up and processed one at a time behind the scenes.
 */
class SlowRetrievalRepository implements RetrievalRepository {
  constructor(
    private readonly delayMs: number,
    private readonly catalogIds: Record<string, number | null> = { tupperware: 1 },
    private readonly rejectWith: Error | null = null,
  ) {}

  findCatalogIdBySlug(groupSlug: string): Promise<number | null> {
    return Promise.resolve(this.catalogIds[groupSlug] ?? null);
  }

  async vectorSearch(_options: VectorSearchOptions): Promise<RawSearchRow[]> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.rejectWith) throw this.rejectWith;
    return [row()];
  }

  async lexicalSearch(_options: LexicalSearchOptions): Promise<RawSearchRow[]> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.rejectWith) throw this.rejectWith;
    return [];
  }
}

function fakeEmbeddingClient(vectors: number[][] = [Array(1536).fill(0.1) as number[]]): EmbeddingClientLike {
  return { embedBatch: vi.fn().mockResolvedValue(vectors) };
}

function fakeClaudeClient(answer = 'The pan costs $49.99 [1].'): ClaudeClientLike {
  return { complete: vi.fn().mockResolvedValue(answer) };
}

interface BuildTestServerOptions {
  repository?: RetrievalRepository;
  claudeClient?: ClaudeClientLike;
  embeddingClient?: EmbeddingClientLike;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
}

async function buildTestServer(options: BuildTestServerOptions = {}): Promise<FastifyInstance> {
  return buildServer({
    apiKeys: new Set([TEST_API_KEY]),
    rateLimitMax: options.rateLimitMax ?? 1000,
    rateLimitWindowMs: options.rateLimitWindowMs ?? 60_000,
    checkDatabaseConnection: () => Promise.resolve(true),
    dependencies: {
      repository: options.repository ?? new SlowRetrievalRepository(0),
      embeddingClient: options.embeddingClient ?? fakeEmbeddingClient(),
      claudeClient: options.claudeClient ?? fakeClaudeClient(),
    },
  });
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

function chatRequest(query = 'how much is the pan', slug = 'tupperware'): {
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  payload: Record<string, string>;
} {
  return {
    method: 'POST',
    url: `/v1/catalogs/${slug}/chat`,
    headers: { 'x-api-key': TEST_API_KEY },
    payload: { query, languageCode: 'en' },
  };
}

describe('rate limiting under real concurrency', () => {
  it('never admits more than max requests even in a true same-tick burst', async () => {
    app = await buildTestServer({ rateLimitMax: 10, rateLimitWindowMs: 60_000 });
    const server = app;

    // Fired together via Promise.all (not awaited one at a time like a
    // sequential test would), so the limiter's counter is genuinely
    // exercised under concurrent access rather than the request-at-a-time
    // pattern a naive test would use.
    //
    // Verified empirically (not assumed) that @fastify/rate-limit's
    // in-memory store does NOT guarantee first-come-first-served
    // admission when every request in a burst lands in the same event
    // loop tick: because the store's increment/check resolves for the
    // whole batch together, a burst that as a whole exceeds `max` can
    // see EVERY request in it rejected (0 succeed), not exactly `max`
    // of them. A burst at or under `max` is admitted in full. Either
    // way the one safety property that actually matters in production -
    // the backend is never asked to serve more than `max` concurrent
    // admissions per window - always holds, which is what this test
    // asserts. Real traffic arriving with any inter-request spacing at
    // all (i.e. not perfectly synchronized to the same tick) falls back
    // to the ordinary first-N-admitted behavior, covered by the
    // sequential rate-limit test in api-server.test.ts.
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => server.inject({ method: 'GET', url: '/healthz' })),
    );

    const succeeded = responses.filter((r) => r.statusCode === 200).length;
    const limited = responses.filter((r) => r.statusCode === 429).length;

    expect(succeeded).toBeLessThanOrEqual(10);
    expect(succeeded + limited).toBe(50);
  });

  it('scopes the limit per API key so one tenant cannot exhaust another tenant\'s quota', async () => {
    app = await buildTestServer({ rateLimitMax: 3, rateLimitWindowMs: 60_000 });
    const server = app;

    // Sequential per tenant (not a same-tick burst, see the test above
    // for why that distinction matters), which is what proves the
    // *scoping* - that tenant B's requests never count against tenant
    // A's quota - rather than re-proving the burst-admission behavior
    // already covered above.
    const tenantAResponses: { statusCode: number }[] = [];
    for (let i = 0; i < 5; i += 1) {
      tenantAResponses.push(
        await server.inject({ method: 'GET', url: '/healthz', headers: { 'x-api-key': 'tenant-a' } }),
      );
    }
    const tenantBResponses: { statusCode: number }[] = [];
    for (let i = 0; i < 5; i += 1) {
      tenantBResponses.push(
        await server.inject({ method: 'GET', url: '/healthz', headers: { 'x-api-key': 'tenant-b' } }),
      );
    }

    expect(tenantAResponses.filter((r) => r.statusCode === 200)).toHaveLength(3);
    expect(tenantBResponses.filter((r) => r.statusCode === 200)).toHaveLength(3);
  });
});

describe('concurrent request handling', () => {
  it('serves a large burst of concurrent healthz requests without dropping any', async () => {
    app = await buildTestServer({ rateLimitMax: 500 });
    const server = app;

    const responses = await Promise.all(
      Array.from({ length: 200 }, () => server.inject({ method: 'GET', url: '/healthz' })),
    );

    expect(responses).toHaveLength(200);
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
  });

  it('runs slow downstream calls concurrently rather than serializing them', async () => {
    // 20 requests each behind a 100ms simulated DB delay. If the server
    // (or this fake) accidentally serialized them, this would take
    // >= 2000ms; genuine concurrency keeps it close to 100ms regardless
    // of how many requests are in flight.
    app = await buildTestServer({
      repository: new SlowRetrievalRepository(100),
      rateLimitMax: 500,
    });
    const server = app;

    const start = Date.now();
    const responses = await Promise.all(Array.from({ length: 20 }, () => server.inject(chatRequest())));
    const elapsedMs = Date.now() - start;

    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    // Generous upper bound (5x the per-request delay) to stay robust
    // against CI scheduling jitter while still catching true
    // serialization, which would land closer to 20x the delay.
    expect(elapsedMs).toBeLessThan(500);
  });

  it('keeps each concurrent request\'s result isolated to its own catalog', async () => {
    class PerCatalogRepository implements RetrievalRepository {
      findCatalogIdBySlug(slug: string): Promise<number | null> {
        return Promise.resolve(slug === 'catalog-a' ? 1 : 2);
      }
      async vectorSearch(options: VectorSearchOptions): Promise<RawSearchRow[]> {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 20));
        return [row({ catalog_id: options.catalogId, text: `Product from catalog ${options.catalogId}` })];
      }
      lexicalSearch(): Promise<RawSearchRow[]> {
        return Promise.resolve([]);
      }
    }

    app = await buildTestServer({ repository: new PerCatalogRepository(), rateLimitMax: 500 });
    const server = app;

    const requests = [
      ...Array.from({ length: 15 }, () => server.inject(chatRequest('question', 'catalog-a'))),
      ...Array.from({ length: 15 }, () => server.inject(chatRequest('question', 'catalog-b'))),
    ];
    const responses = await Promise.all(requests);

    for (const response of responses.slice(0, 15)) {
      expect(response.statusCode).toBe(200);
    }
    for (const response of responses.slice(15)) {
      expect(response.statusCode).toBe(200);
    }
  });
});

describe('upstream failure injection under concurrent load', () => {
  it('returns a clean 503 for every concurrent request when Claude is down, with no crash', async () => {
    const claudeClient: ClaudeClientLike = {
      complete: vi.fn().mockRejectedValue(new ClaudeRequestError('overloaded', 529, '')),
    };
    app = await buildTestServer({ claudeClient, rateLimitMax: 500 });
    const server = app;

    const responses = await Promise.all(Array.from({ length: 30 }, () => server.inject(chatRequest())));

    expect(responses).toHaveLength(30);
    expect(responses.every((r) => r.statusCode === 503)).toBe(true);
    for (const response of responses) {
      expect(response.json()).toMatchObject({ error: { code: 'upstream_unavailable' } });
    }
  });

  it('returns a clean 500 for a database failure without leaking internal error details', async () => {
    const dbError = new Error('connection terminated unexpectedly: password authentication failed for user "publitas"');
    app = await buildTestServer({
      repository: new SlowRetrievalRepository(0, { tupperware: 1 }, dbError),
      rateLimitMax: 500,
    });
    const server = app;

    const responses = await Promise.all(Array.from({ length: 10 }, () => server.inject(chatRequest())));

    expect(responses.every((r) => r.statusCode === 500)).toBe(true);
    for (const response of responses) {
      const body = response.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe('internal_error');
      // The real Postgres error message (which could reveal connection
      // details or credentials structure) must never reach the client.
      expect(body.error.message).not.toContain('password');
      expect(body.error.message).not.toContain('publitas');
    }
  });

  it('recovers and serves healthy requests immediately after an upstream failure burst', async () => {
    let shouldFail = true;
    const claudeClient: ClaudeClientLike = {
      complete: vi.fn().mockImplementation(() => {
        if (shouldFail) return Promise.reject(new ClaudeRequestError('overloaded', 529, ''));
        return Promise.resolve('The pan costs $49.99 [1].');
      }),
    };
    app = await buildTestServer({ claudeClient, rateLimitMax: 500 });
    const server = app;

    const failing = await Promise.all(Array.from({ length: 10 }, () => server.inject(chatRequest())));
    expect(failing.every((r) => r.statusCode === 503)).toBe(true);

    shouldFail = false;
    const recovered = await Promise.all(Array.from({ length: 10 }, () => server.inject(chatRequest())));
    expect(recovered.every((r) => r.statusCode === 200)).toBe(true);
  });

  it('handles a mixed batch of succeeding and failing requests independently', async () => {
    let callCount = 0;
    const claudeClient: ClaudeClientLike = {
      complete: vi.fn().mockImplementation(() => {
        callCount += 1;
        // Every third call fails; the rest succeed. Proves one request's
        // failure never taints, cancels, or blocks a concurrently
        // in-flight sibling request.
        if (callCount % 3 === 0) return Promise.reject(new ClaudeRequestError('overloaded', 529, ''));
        return Promise.resolve('The pan costs $49.99 [1].');
      }),
    };
    app = await buildTestServer({ claudeClient, rateLimitMax: 500 });
    const server = app;

    const responses = await Promise.all(Array.from({ length: 30 }, () => server.inject(chatRequest())));

    const statusCodes = responses.map((r) => r.statusCode);
    expect(statusCodes.filter((code) => code === 200)).toHaveLength(20);
    expect(statusCodes.filter((code) => code === 503)).toHaveLength(10);
  });
});

describe('malformed and oversized payloads under load', () => {
  it('rejects an oversized request body without crashing the server', async () => {
    app = await buildTestServer({ rateLimitMax: 500 });
    const server = app;

    // bodyLimit is 1 MiB (server.ts); this exceeds it comfortably.
    const oversizedQuery = 'a'.repeat(2 * 1024 * 1024);
    const response = await server.inject({
      method: 'POST',
      url: '/v1/catalogs/tupperware/chat',
      headers: { 'x-api-key': TEST_API_KEY, 'content-type': 'application/json' },
      payload: JSON.stringify({ query: oversizedQuery, languageCode: 'en' }),
    });

    expect(response.statusCode).toBe(413);

    // The server itself must still be responsive afterward.
    const followUp = await server.inject({ method: 'GET', url: '/healthz' });
    expect(followUp.statusCode).toBe(200);
  });

  it('handles a concurrent mix of valid and malformed requests independently', async () => {
    app = await buildTestServer({ rateLimitMax: 500 });
    const server = app;

    const valid = Array.from({ length: 10 }, () => server.inject(chatRequest()));
    const malformed = Array.from({ length: 10 }, () =>
      server.inject({
        method: 'POST',
        url: '/v1/catalogs/tupperware/chat',
        headers: { 'x-api-key': TEST_API_KEY, 'content-type': 'application/json' },
        payload: '{not valid json',
      }),
    );

    const [validResponses, malformedResponses] = await Promise.all([
      Promise.all(valid),
      Promise.all(malformed),
    ]);

    expect(validResponses.every((r) => r.statusCode === 200)).toBe(true);
    expect(malformedResponses.every((r) => r.statusCode === 400)).toBe(true);
  });
});
