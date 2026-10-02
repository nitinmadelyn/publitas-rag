import { describe, expect, it, vi } from 'vitest';
import { generateAnswer, type ClaudeClientLike } from '../src/generation/generate-answer.js';
import type { EmbeddingClientLike } from '../src/retrieval/retrieve.js';
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

function makeEmbeddingClient(vectors: number[][] = [[0.1, 0.2]]): {
  client: EmbeddingClientLike;
  embedBatch: ReturnType<typeof vi.fn>;
} {
  const embedBatch = vi.fn().mockResolvedValue(vectors);
  return { client: { embedBatch }, embedBatch };
}

function makeClaudeClient(answer = 'The pan costs $49.99 [1].'): {
  client: ClaudeClientLike;
  complete: ReturnType<typeof vi.fn>;
} {
  const complete = vi.fn().mockResolvedValue(answer);
  return { client: { complete }, complete };
}

function baseOptions(): Parameters<typeof generateAnswer>[3] {
  return {
    query: 'how much is the pan',
    catalogSlug: 'tupperware',
    languageCode: 'en',
    topK: 8,
    relevanceThreshold: 0.75,
    embeddingDimensions: 2,
    lexicalLimit: 10,
    lexicalMinSimilarity: 0.3,
  };
}

describe('generateAnswer', () => {
  it('skips the Claude call and returns a canned answer when no chunks are retrieved', async () => {
    const repo = new FakeRetrievalRepository({ tupperware: 1 }, [], []);
    const { client: embeddingClient } = makeEmbeddingClient();
    const { client: claudeClient, complete } = makeClaudeClient();

    const result = await generateAnswer(repo, embeddingClient, claudeClient, baseOptions());

    expect(result.noContextFound).toBe(true);
    expect(result.citations).toEqual([]);
    expect(result.retrievedChunks).toEqual([]);
    expect(result.answer.length).toBeGreaterThan(0);
    expect(complete).not.toHaveBeenCalled();
  });

  it('returns the English canned answer for an unrecognized language code', async () => {
    const repo = new FakeRetrievalRepository({ tupperware: 1 }, [], []);
    const { client: embeddingClient } = makeEmbeddingClient();
    const { client: claudeClient } = makeClaudeClient();

    const result = await generateAnswer(
      repo,
      embeddingClient,
      claudeClient,
      { ...baseOptions(), languageCode: 'xx' },
    );

    expect(result.answer).toMatch(/don't have information/i);
  });

  it('returns the French canned answer when nothing is found for a French query', async () => {
    const repo = new FakeRetrievalRepository({ tupperware: 1 }, [], []);
    const { client: embeddingClient } = makeEmbeddingClient();
    const { client: claudeClient } = makeClaudeClient();

    const result = await generateAnswer(
      repo,
      embeddingClient,
      claudeClient,
      { ...baseOptions(), languageCode: 'fr' },
    );

    expect(result.answer).toMatch(/pas d'information/);
  });

  it('calls Claude and returns a grounded answer with citations when chunks are found', async () => {
    const repo = new FakeRetrievalRepository(
      { tupperware: 1 },
      [row({ id: 1, score: 0.9 })],
      [],
    );
    const { client: embeddingClient } = makeEmbeddingClient();
    const { client: claudeClient, complete } = makeClaudeClient('The pan costs $49.99 [1].');

    const result = await generateAnswer(repo, embeddingClient, claudeClient, baseOptions());

    expect(result.noContextFound).toBe(false);
    expect(result.answer).toBe('The pan costs $49.99 [1].');
    expect(result.retrievedChunks).toHaveLength(1);
    expect(result.citations).toEqual([
      {
        index: 1,
        chunkId: 1,
        publicUrl: 'https://view.publitas.com/x/y/page/4',
        pageNumber: 4,
        productRef: 'SKU-123',
      },
    ]);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('passes a system prompt and a user prompt containing the query to Claude', async () => {
    const repo = new FakeRetrievalRepository({ tupperware: 1 }, [row()], []);
    const { client: embeddingClient } = makeEmbeddingClient();
    const { client: claudeClient, complete } = makeClaudeClient();

    await generateAnswer(repo, embeddingClient, claudeClient, {
      ...baseOptions(),
      query: 'is it dishwasher safe',
    });

    const [system, user] = complete.mock.calls[0] as [string, string];
    expect(system.length).toBeGreaterThan(0);
    expect(user).toMatch(/is it dishwasher safe/);
  });

  it('returns an empty citations array when the answer cites nothing', async () => {
    const repo = new FakeRetrievalRepository({ tupperware: 1 }, [row()], []);
    const { client: embeddingClient } = makeEmbeddingClient();
    const { client: claudeClient } = makeClaudeClient('I am not sure.');

    const result = await generateAnswer(repo, embeddingClient, claudeClient, baseOptions());

    expect(result.citations).toEqual([]);
  });

  it('propagates a CatalogNotFoundError from retrieval without calling Claude', async () => {
    const repo = new FakeRetrievalRepository({});
    const { client: embeddingClient } = makeEmbeddingClient();
    const { client: claudeClient, complete } = makeClaudeClient();

    await expect(
      generateAnswer(repo, embeddingClient, claudeClient, baseOptions()),
    ).rejects.toThrow(/No catalog found/);
    expect(complete).not.toHaveBeenCalled();
  });

  it('propagates a RetrievalValidationError for an empty query without calling Claude', async () => {
    const repo = new FakeRetrievalRepository({ tupperware: 1 });
    const { client: embeddingClient } = makeEmbeddingClient();
    const { client: claudeClient, complete } = makeClaudeClient();

    await expect(
      generateAnswer(repo, embeddingClient, claudeClient, { ...baseOptions(), query: '   ' }),
    ).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();
  });

  it('merges vector and lexical hits before building the prompt', async () => {
    const repo = new FakeRetrievalRepository(
      { tupperware: 1 },
      [row({ id: 1, score: 0.9 })],
      [row({ id: 2, score: 0.4, text: 'lexical match text' })],
    );
    const { client: embeddingClient } = makeEmbeddingClient();
    const { client: claudeClient, complete } = makeClaudeClient();

    const result = await generateAnswer(repo, embeddingClient, claudeClient, baseOptions());

    expect(result.retrievedChunks.map((c) => c.chunkId).sort()).toEqual([1, 2]);
    const [, user] = complete.mock.calls[0] as [string, string];
    expect(user).toMatch(/lexical match text/);
  });
});
