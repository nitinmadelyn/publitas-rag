import { describe, expect, it, vi } from 'vitest';
import { retrieveChunks, type EmbeddingClientLike, type RetrieveChunksOptions } from '../src/retrieval/retrieve.js';
import { RetrievalValidationError, CatalogNotFoundError } from '../src/retrieval/errors.js';
import type {
  RetrievalRepository,
  RawSearchRow,
  VectorSearchOptions,
  LexicalSearchOptions,
} from '../src/retrieval/chunk-search-repository.js';

function row(overrides: Partial<RawSearchRow> = {}): RawSearchRow {
  return {
    id: 1,
    page_id: 1,
    catalog_id: 1,
    chunk_index: 0,
    text: 'Wok (49.99)',
    product_ref: '123',
    language_code: 'en',
    page_number: 1,
    public_url: 'https://view.publitas.com/x/y/page/1',
    score: 0.9,
    ...overrides,
  };
}

function baseOptions(overrides: Partial<RetrieveChunksOptions> = {}): RetrieveChunksOptions {
  return {
    query: 'wok',
    catalogSlug: 'tupperware',
    languageCode: 'en',
    topK: 8,
    relevanceThreshold: 0.75,
    embeddingDimensions: 2,
    lexicalLimit: 10,
    lexicalMinSimilarity: 0.3,
    ...overrides,
  };
}

class FakeRetrievalRepository implements RetrievalRepository {
  readonly vectorCalls: VectorSearchOptions[] = [];
  readonly lexicalCalls: LexicalSearchOptions[] = [];

  constructor(
    private readonly catalogIds: Record<string, number | null>,
    private readonly vectorRows: RawSearchRow[] = [],
    private readonly lexicalRows: RawSearchRow[] = [],
  ) {}

  findCatalogIdBySlug(groupSlug: string): Promise<number | null> {
    return Promise.resolve(this.catalogIds[groupSlug] ?? null);
  }

  vectorSearch(options: VectorSearchOptions): Promise<RawSearchRow[]> {
    this.vectorCalls.push(options);
    return Promise.resolve(this.vectorRows);
  }

  lexicalSearch(options: LexicalSearchOptions): Promise<RawSearchRow[]> {
    this.lexicalCalls.push(options);
    return Promise.resolve(this.lexicalRows);
  }
}

/**
 * Returns the fake client and its underlying mock function as separate
 * values (rather than letting callers read `.embedBatch` off the client
 * object for assertions), which sidesteps @typescript-eslint/unbound-method:
 * that rule flags any member-expression read of a method typed by an
 * interface, even a test mock, since a real implementation's method could
 * rely on `this`.
 */
function makeEmbeddingClient(vectors: number[][] = [[0.1, 0.2]]): {
  client: EmbeddingClientLike;
  embedBatch: ReturnType<typeof vi.fn>;
} {
  const embedBatch = vi.fn().mockResolvedValue(vectors);
  return { client: { embedBatch }, embedBatch };
}

describe('retrieveChunks', () => {
  it('throws RetrievalValidationError on an empty query without touching the repository or embedding client', async () => {
    const repo = new FakeRetrievalRepository({ tupperware: 1 });
    const { client, embedBatch } = makeEmbeddingClient();

    await expect(retrieveChunks(repo, client, baseOptions({ query: '   ' }))).rejects.toBeInstanceOf(
      RetrievalValidationError,
    );
    expect(repo.vectorCalls).toHaveLength(0);
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it('throws RetrievalValidationError on an empty languageCode', async () => {
    const repo = new FakeRetrievalRepository({ tupperware: 1 });
    const { client } = makeEmbeddingClient();

    await expect(
      retrieveChunks(repo, client, baseOptions({ languageCode: '' })),
    ).rejects.toBeInstanceOf(RetrievalValidationError);
  });

  it('throws RetrievalValidationError when topK is less than 1', async () => {
    const repo = new FakeRetrievalRepository({ tupperware: 1 });
    const { client } = makeEmbeddingClient();

    await expect(retrieveChunks(repo, client, baseOptions({ topK: 0 }))).rejects.toBeInstanceOf(
      RetrievalValidationError,
    );
  });

  it('throws CatalogNotFoundError when the catalog slug does not resolve, without calling the embedding client', async () => {
    const repo = new FakeRetrievalRepository({});
    const { client, embedBatch } = makeEmbeddingClient();

    await expect(
      retrieveChunks(repo, client, baseOptions({ catalogSlug: 'ghost' })),
    ).rejects.toBeInstanceOf(CatalogNotFoundError);
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it('trims the query before embedding and before the lexical search', async () => {
    const repo = new FakeRetrievalRepository({ tupperware: 1 });
    const { client, embedBatch } = makeEmbeddingClient();

    await retrieveChunks(repo, client, baseOptions({ query: '  wok  ' }));

    expect(embedBatch).toHaveBeenCalledWith(['wok']);
    expect(repo.lexicalCalls[0]?.queryText).toBe('wok');
  });

  it('resolves the catalog slug and passes the resulting catalogId to both searches', async () => {
    const repo = new FakeRetrievalRepository({ tupperware: 42 });
    const { client } = makeEmbeddingClient();

    await retrieveChunks(repo, client, baseOptions());

    expect(repo.vectorCalls[0]?.catalogId).toBe(42);
    expect(repo.lexicalCalls[0]?.catalogId).toBe(42);
  });

  it('converts the embedded query vector into a pgvector literal for the vector search', async () => {
    const repo = new FakeRetrievalRepository({ tupperware: 1 });
    const { client } = makeEmbeddingClient([[0.5, -0.25]]);

    await retrieveChunks(repo, client, baseOptions({ embeddingDimensions: 2 }));

    expect(repo.vectorCalls[0]?.queryVectorLiteral).toBe('[0.5,-0.25]');
  });

  it('returns merged results from both vector and lexical searches', async () => {
    const repo = new FakeRetrievalRepository(
      { tupperware: 1 },
      [row({ id: 1, score: 0.9 })],
      [row({ id: 2, score: 0.4 })],
    );
    const { client } = makeEmbeddingClient();

    const result = await retrieveChunks(repo, client, baseOptions());

    expect(result.map((r) => r.chunkId).sort()).toEqual([1, 2]);
  });

  it('propagates topK, relevanceThreshold and lexical options through to the repository calls', async () => {
    const repo = new FakeRetrievalRepository({ tupperware: 1 });
    const { client } = makeEmbeddingClient();

    await retrieveChunks(
      repo,
      client,
      baseOptions({ topK: 5, lexicalLimit: 3, lexicalMinSimilarity: 0.4 }),
    );

    expect(repo.vectorCalls[0]?.limit).toBe(5);
    expect(repo.lexicalCalls[0]?.limit).toBe(3);
    expect(repo.lexicalCalls[0]?.minSimilarity).toBe(0.4);
  });

  it('returns an empty array when nothing is found by either search', async () => {
    const repo = new FakeRetrievalRepository({ tupperware: 1 });
    const { client } = makeEmbeddingClient();

    const result = await retrieveChunks(repo, client, baseOptions());

    expect(result).toEqual([]);
  });

  it('throws when the embedding client returns no vectors at all', async () => {
    const repo = new FakeRetrievalRepository({ tupperware: 1 });
    const { client } = makeEmbeddingClient([]);

    await expect(retrieveChunks(repo, client, baseOptions())).rejects.toThrow(/no vector/);
  });
});
