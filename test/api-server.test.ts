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

class FakeRetrievalRepository implements RetrievalRepository {
  constructor(
    private readonly catalogIds: Record<string, number | null>,
    private readonly vectorRows: RawSearchRow[] = [],
    private readonly lexicalRows: RawSearchRow[] = [],
  ) {}

  findCatalogIdBySlug(groupSlug: string): Promise<number | null> {
    return Promise.resolve(this.catalogIds[groupSlug] ?? null);
  }

  vectorSearch(_options: VectorSearchOptions): Promise<RawSearchRow[]> {
    return Promise.resolve(this.vectorRows);
  }

  lexicalSearch(_options: LexicalSearchOptions): Promise<RawSearchRow[]> {
    return Promise.resolve(this.lexicalRows);
  }
}

// The route handlers always pass config.EMBEDDING_DIMENSIONS (1536 by
// default) through to retrieveChunks, which validates the embedding
// client's output against it - so the fake must return vectors of that
// length, not an arbitrary short one.
function fakeEmbeddingClient(vectors: number[][] = [Array(1536).fill(0.1) as number[]]): EmbeddingClientLike {
  return { embedBatch: vi.fn().mockResolvedValue(vectors) };
}

function fakeClaudeClient(answer = 'The pan costs $49.99 [1].'): {
  client: ClaudeClientLike;
  complete: ReturnType<typeof vi.fn>;
} {
  const complete = vi.fn().mockResolvedValue(answer);
  return { client: { complete }, complete };
}

interface BuildTestServerOptions {
  catalogIds?: Record<string, number | null>;
  vectorRows?: RawSearchRow[];
  lexicalRows?: RawSearchRow[];
  claudeClient?: ClaudeClientLike;
  embeddingClient?: EmbeddingClientLike;
  checkDatabaseConnection?: () => Promise<boolean>;
  rateLimitMax?: number;
}

async function buildTestServer(options: BuildTestServerOptions = {}): Promise<FastifyInstance> {
  return buildServer({
    apiKeys: new Set([TEST_API_KEY]),
    rateLimitMax: options.rateLimitMax ?? 1000,
    rateLimitWindowMs: 60_000,
    checkDatabaseConnection: options.checkDatabaseConnection ?? ((): Promise<boolean> => Promise.resolve(true)),
    dependencies: {
      repository: new FakeRetrievalRepository(
        options.catalogIds ?? { tupperware: 1 },
        options.vectorRows ?? [row()],
        options.lexicalRows ?? [],
      ),
      embeddingClient: options.embeddingClient ?? fakeEmbeddingClient(),
      claudeClient: options.claudeClient ?? fakeClaudeClient().client,
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

describe('GET /healthz', () => {
  it('returns 200 without requiring an API key', async () => {
    app = await buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /readyz', () => {
  it('returns 200 when the database check succeeds', async () => {
    app = await buildTestServer({ checkDatabaseConnection: () => Promise.resolve(true) });
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
  });

  it('returns 503 when the database check fails', async () => {
    app = await buildTestServer({ checkDatabaseConnection: () => Promise.resolve(false) });
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable', reason: 'database' });
  });

  it('does not require an API key', async () => {
    app = await buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).not.toBe(401);
  });
});

describe('POST /v1/catalogs/:slug/chat', () => {
  it('returns 401 when no x-api-key header is sent', async () => {
    app = await buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/catalogs/tupperware/chat',
      payload: { query: 'how much is the pan', languageCode: 'en' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns 401 when the x-api-key header is wrong', async () => {
    app = await buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/catalogs/tupperware/chat',
      headers: { 'x-api-key': 'wrong-key' },
      payload: { query: 'how much is the pan', languageCode: 'en' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns a grounded answer with citations for a valid request', async () => {
    app = await buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/catalogs/tupperware/chat',
      headers: { 'x-api-key': TEST_API_KEY },
      payload: { query: 'how much is the pan', languageCode: 'en' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ answer: string; citations: unknown[]; noContextFound: boolean }>();
    expect(body.answer).toBe('The pan costs $49.99 [1].');
    expect(body.noContextFound).toBe(false);
    expect(body.citations).toEqual([
      {
        index: 1,
        chunkId: 1,
        publicUrl: 'https://view.publitas.com/x/y/page/4',
        pageNumber: 4,
        productRef: 'SKU-123',
      },
    ]);
  });

  it('returns 400 for an empty query', async () => {
    app = await buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/catalogs/tupperware/chat',
      headers: { 'x-api-key': TEST_API_KEY },
      payload: { query: '', languageCode: 'en' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'validation_error' } });
  });

  it('returns 400 for a query over the length limit', async () => {
    app = await buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/catalogs/tupperware/chat',
      headers: { 'x-api-key': TEST_API_KEY },
      payload: { query: 'a'.repeat(2001), languageCode: 'en' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 400 for a malformed languageCode', async () => {
    app = await buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/catalogs/tupperware/chat',
      headers: { 'x-api-key': TEST_API_KEY },
      payload: { query: 'how much', languageCode: 'not-a-code!' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when the request body is missing required fields', async () => {
    app = await buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/catalogs/tupperware/chat',
      headers: { 'x-api-key': TEST_API_KEY },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 400 for malformed JSON in the request body', async () => {
    app = await buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/catalogs/tupperware/chat',
      headers: { 'x-api-key': TEST_API_KEY, 'content-type': 'application/json' },
      payload: '{not valid json',
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 404 when the catalog slug does not exist', async () => {
    app = await buildTestServer({ catalogIds: {} });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/catalogs/ghost-catalog/chat',
      headers: { 'x-api-key': TEST_API_KEY },
      payload: { query: 'anything', languageCode: 'en' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'catalog_not_found' } });
  });

  it('returns the canned no-context answer when retrieval finds nothing, without calling Claude', async () => {
    const { client: claudeClient, complete } = fakeClaudeClient();
    app = await buildTestServer({ vectorRows: [], lexicalRows: [], claudeClient });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/catalogs/tupperware/chat',
      headers: { 'x-api-key': TEST_API_KEY },
      payload: { query: 'anything at all', languageCode: 'en' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ noContextFound: boolean }>();
    expect(body.noContextFound).toBe(true);
    expect(complete).not.toHaveBeenCalled();
  });

  it('returns 503 when Claude is unavailable after retries', async () => {
    const claudeClient: ClaudeClientLike = {
      complete: vi.fn().mockRejectedValue(new ClaudeRequestError('overloaded', 529, '')),
    };
    app = await buildTestServer({ claudeClient });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/catalogs/tupperware/chat',
      headers: { 'x-api-key': TEST_API_KEY },
      payload: { query: 'how much is the pan', languageCode: 'en' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'upstream_unavailable' } });
  });

  it('returns 404 for a nonexistent route', async () => {
    app = await buildTestServer();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/does-not-exist',
      headers: { 'x-api-key': TEST_API_KEY },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});

describe('POST /v1/catalogs/:slug/search', () => {
  it('returns 401 without an API key', async () => {
    app = await buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/catalogs/tupperware/search',
      payload: { query: 'pan', languageCode: 'en' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns raw retrieval results without calling Claude', async () => {
    const { client: claudeClient, complete } = fakeClaudeClient();
    app = await buildTestServer({ claudeClient });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/catalogs/tupperware/search',
      headers: { 'x-api-key': TEST_API_KEY },
      payload: { query: 'pan', languageCode: 'en' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ results: { chunkId: number }[] }>();
    expect(body.results).toHaveLength(1);
    expect(body.results[0]?.chunkId).toBe(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown catalog', async () => {
    app = await buildTestServer({ catalogIds: {} });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/catalogs/ghost/search',
      headers: { 'x-api-key': TEST_API_KEY },
      payload: { query: 'pan', languageCode: 'en' },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('rate limiting', () => {
  it('returns 429 once the per-window request limit is exceeded', async () => {
    app = await buildTestServer({ rateLimitMax: 2 });
    const server = app;

    const makeRequest = (): Promise<{ statusCode: number }> =>
      server.inject({ method: 'GET', url: '/healthz' });

    const first = await makeRequest();
    const second = await makeRequest();
    const third = await makeRequest();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
  });
});

describe('GET /widget/widget.js', () => {
  it('serves the built widget bundle without requiring an API key', async () => {
    app = await buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/widget/widget.js' });
    expect(response.statusCode).toBe(200);
    expect(response.body.length).toBeGreaterThan(0);
  });

  it('returns a clean 404 (not a crash) for a nonexistent file under /widget/', async () => {
    app = await buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/widget/does-not-exist.js' });
    expect(response.statusCode).toBe(404);

    // The server must still be responsive afterward.
    const followUp = await app.inject({ method: 'GET', url: '/healthz' });
    expect(followUp.statusCode).toBe(200);
  });
});

describe('CORS', () => {
  it('reflects the origin header when CORS_ALLOWED_ORIGINS is *', async () => {
    app = await buildServer({
      apiKeys: new Set([TEST_API_KEY]),
      corsOrigins: '*',
      checkDatabaseConnection: () => Promise.resolve(true),
      dependencies: {
        repository: new FakeRetrievalRepository({ tupperware: 1 }, [row()], []),
        embeddingClient: fakeEmbeddingClient(),
        claudeClient: fakeClaudeClient().client,
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'https://example-customer-site.com' },
    });

    expect(response.headers['access-control-allow-origin']).toBe('https://example-customer-site.com');
  });
});
