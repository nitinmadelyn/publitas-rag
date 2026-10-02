import { describe, expect, it, vi } from 'vitest';
import { embedPendingChunks, type EmbeddingClientLike, type EmbedPendingChunksOptions } from '../src/embeddings/embed-chunks.js';
import {
  EmbeddingAuthError,
  EmbeddingBadRequestError,
  EmbeddingRequestError,
} from '../src/embeddings/openai-embedding-client.js';
import type {
  ChunkRepository,
  PendingChunk,
  EmbeddingSuccess,
  FetchPendingChunksOptions,
} from '../src/embeddings/chunk-repository.js';

function baseOptions(overrides: Partial<EmbedPendingChunksOptions> = {}): EmbedPendingChunksOptions {
  return {
    embeddingModel: 'text-embedding-3-large',
    embeddingDimensions: 2,
    batchSize: 10,
    fetchPageSize: 100,
    maxAttempts: 5,
    maxCharsPerChunk: 1000,
    maxCharsPerBatch: 100_000,
    requestConcurrency: 2,
    ...overrides,
  };
}

function makeChunk(id: number, text = 'text'): PendingChunk {
  return { id, text };
}

function makeEmbeddingClient(
  impl: (texts: readonly string[]) => Promise<number[][]>,
): EmbeddingClientLike {
  return { embedBatch: vi.fn(impl) };
}

class FakeRepository implements ChunkRepository {
  private readonly pages: PendingChunk[][];
  private readonly catalogIds: Record<string, number | null>;
  private pageIndex = 0;

  readonly fetchCalls: FetchPendingChunksOptions[] = [];
  readonly writes: { successes: EmbeddingSuccess[]; model: string }[] = [];
  readonly failures: { chunkId: number; message: string }[] = [];

  constructor(pages: PendingChunk[][], catalogIds: Record<string, number | null> = {}) {
    this.pages = pages;
    this.catalogIds = catalogIds;
  }

  fetchPendingChunks(options: FetchPendingChunksOptions): Promise<PendingChunk[]> {
    this.fetchCalls.push(options);
    const page = this.pages[this.pageIndex] ?? [];
    this.pageIndex += 1;
    return Promise.resolve(page);
  }

  writeEmbeddingSuccesses(successes: readonly EmbeddingSuccess[], embeddingModel: string): Promise<void> {
    this.writes.push({ successes: [...successes], model: embeddingModel });
    return Promise.resolve();
  }

  recordEmbeddingFailure(chunkId: number, errorMessage: string): Promise<void> {
    this.failures.push({ chunkId, message: errorMessage });
    return Promise.resolve();
  }

  findCatalogIdBySlug(groupSlug: string): Promise<number | null> {
    return Promise.resolve(this.catalogIds[groupSlug] ?? null);
  }
}

describe('embedPendingChunks', () => {
  it('embeds every pending chunk across a single page and batch', async () => {
    const repo = new FakeRepository([[makeChunk(1, 'a'), makeChunk(2, 'b')]]);
    const client = makeEmbeddingClient((texts) => Promise.resolve(texts.map(() => [0.1, 0.2])));

    const result = await embedPendingChunks(repo, client, baseOptions());

    expect(result).toEqual({ embedded: 2, failed: 0, batchesRun: 1, aborted: false });
    expect(repo.writes).toHaveLength(1);
    expect(repo.writes[0]?.successes).toHaveLength(2);
    expect(repo.writes[0]?.model).toBe('text-embedding-3-large');
  });

  it('sweeps multiple pages until fetchPendingChunks returns empty', async () => {
    const repo = new FakeRepository([[makeChunk(1), makeChunk(2)], [makeChunk(3)]]);
    const client = makeEmbeddingClient((texts) => Promise.resolve(texts.map(() => [0.1, 0.2])));

    const result = await embedPendingChunks(repo, client, baseOptions());

    expect(result.embedded).toBe(3);
    expect(result.aborted).toBe(false);
    expect(repo.fetchCalls).toHaveLength(3); // page1, page2, then the empty page that ends the loop
  });

  it('returns zero work done when there are no pending chunks', async () => {
    const repo = new FakeRepository([[]]);
    const client = makeEmbeddingClient(() => Promise.resolve([]));

    const result = await embedPendingChunks(repo, client, baseOptions());

    expect(result).toEqual({ embedded: 0, failed: 0, batchesRun: 0, aborted: false });
  });

  it('stops once the limit option is reached', async () => {
    const repo = new FakeRepository([[makeChunk(1), makeChunk(2)], [makeChunk(3), makeChunk(4)]]);
    const client = makeEmbeddingClient((texts) => Promise.resolve(texts.map(() => [0.1, 0.2])));

    const result = await embedPendingChunks(repo, client, baseOptions({ limit: 2 }));

    expect(result.embedded).toBe(2);
    expect(repo.writes).toHaveLength(1);
  });

  it('resolves a catalogSlug to a catalogId and passes it through to fetchPendingChunks', async () => {
    const repo = new FakeRepository([[makeChunk(1)]], { tupperware: 42 });
    const client = makeEmbeddingClient((texts) => Promise.resolve(texts.map(() => [0.1, 0.2])));

    const result = await embedPendingChunks(repo, client, baseOptions({ catalogSlug: 'tupperware' }));

    expect(result.aborted).toBe(false);
    expect(result.embedded).toBe(1);
    expect(repo.fetchCalls[0]?.catalogId).toBe(42);
  });

  it('aborts with a clear reason when the catalogSlug does not exist', async () => {
    const repo = new FakeRepository([[makeChunk(1)]], {});
    const client = makeEmbeddingClient(() => Promise.resolve([]));

    const result = await embedPendingChunks(repo, client, baseOptions({ catalogSlug: 'ghost-catalog' }));

    expect(result).toEqual({
      embedded: 0,
      failed: 0,
      batchesRun: 0,
      aborted: true,
      abortReason: 'Unknown catalog slug: ghost-catalog',
    });
    expect(repo.fetchCalls).toHaveLength(0);
  });

  it('records a failure and continues past a transient error exhausted for one batch', async () => {
    const repo = new FakeRepository([[makeChunk(1), makeChunk(2)]]);
    const client = makeEmbeddingClient(() =>
      Promise.reject(new EmbeddingRequestError('exhausted retries', 500, '')),
    );

    const result = await embedPendingChunks(repo, client, baseOptions({ maxConsecutiveBatchFailures: 10 }));

    expect(result.failed).toBe(2);
    expect(result.embedded).toBe(0);
    expect(result.aborted).toBe(false);
    expect(repo.failures).toHaveLength(2);
    expect(repo.failures[0]?.message).toBe('exhausted retries');
  });

  it('aborts the whole run immediately on an auth error', async () => {
    const repo = new FakeRepository([[makeChunk(1)], [makeChunk(2)]]);
    const client = makeEmbeddingClient(() => Promise.reject(new EmbeddingAuthError('bad key')));

    const result = await embedPendingChunks(repo, client, baseOptions());

    expect(result.aborted).toBe(true);
    expect(result.abortReason).toBe('bad key');
  });

  it('aborts after too many consecutive fully-failed batches', async () => {
    const repo = new FakeRepository([[makeChunk(1)], [makeChunk(2)], [makeChunk(3)]]);
    const client = makeEmbeddingClient(() =>
      Promise.reject(new EmbeddingRequestError('exhausted retries', 500, '')),
    );

    const result = await embedPendingChunks(repo, client, baseOptions({ maxConsecutiveBatchFailures: 2 }));

    expect(result.aborted).toBe(true);
    expect(result.abortReason).toContain('consecutive fully-failed batches');
    expect(repo.fetchCalls).toHaveLength(2); // stopped before fetching the third page
  });

  it('bisects a batch to isolate one poisoned chunk instead of failing the whole batch', async () => {
    const repo = new FakeRepository([[makeChunk(1, 'good'), makeChunk(2, 'poison')]]);
    const client = makeEmbeddingClient((texts) => {
      if (texts.includes('poison')) {
        return Promise.reject(new EmbeddingBadRequestError('rejected', 400, ''));
      }
      return Promise.resolve(texts.map(() => [0.1, 0.2]));
    });

    const result = await embedPendingChunks(repo, client, baseOptions());

    expect(result.embedded).toBe(1);
    expect(result.failed).toBe(1);
    expect(repo.failures).toEqual([{ chunkId: 2, message: 'rejected' }]);
    const successfulIds = repo.writes.flatMap((w) => w.successes.map((s) => s.chunkId));
    expect(successfulIds).toEqual([1]);
  });

  it('truncates oversized chunk text before sending to the embedding client', async () => {
    const longText = 'x'.repeat(50);
    const repo = new FakeRepository([[makeChunk(1, longText)]]);
    let receivedText = '';
    const client = makeEmbeddingClient((texts) => {
      receivedText = texts[0] ?? '';
      return Promise.resolve([[0.1, 0.2]]);
    });

    await embedPendingChunks(repo, client, baseOptions({ maxCharsPerChunk: 10 }));

    expect(receivedText).toHaveLength(10);
  });

  it('runs batches concurrently within a single page up to requestConcurrency', async () => {
    const repo = new FakeRepository([[makeChunk(1), makeChunk(2), makeChunk(3), makeChunk(4)]]);
    let inFlight = 0;
    let maxObservedConcurrency = 0;
    const client = makeEmbeddingClient(async (texts) => {
      inFlight += 1;
      maxObservedConcurrency = Math.max(maxObservedConcurrency, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return texts.map(() => [0.1, 0.2]);
    });

    await embedPendingChunks(repo, client, baseOptions({ batchSize: 1, requestConcurrency: 4 }));

    expect(maxObservedConcurrency).toBeGreaterThan(1);
  });
});
