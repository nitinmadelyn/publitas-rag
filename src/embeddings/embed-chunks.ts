import type { ChunkRepository, PendingChunk, EmbeddingSuccess } from './chunk-repository.js';
import { batchByCountAndSize, type TextBatchItem } from './batcher.js';
import { toVectorLiteral } from './vector-literal.js';
import { EmbeddingAuthError, EmbeddingBadRequestError } from './openai-embedding-client.js';
import { mapWithConcurrency } from '../lib/concurrency.js';
import { logger } from '../lib/logger.js';

/**
 * The minimal shape embed-chunks.ts needs from an embedding provider.
 * OpenAIEmbeddingClient satisfies this structurally; tests inject a fake.
 */
export interface EmbeddingClientLike {
  embedBatch(texts: readonly string[]): Promise<number[][]>;
}

export interface EmbedPendingChunksOptions {
  /** Restrict to one catalog's chunks; omit to sweep the whole table. */
  catalogSlug?: string;
  embeddingModel: string;
  embeddingDimensions: number;
  batchSize: number;
  fetchPageSize: number;
  maxAttempts: number;
  maxCharsPerChunk: number;
  maxCharsPerBatch: number;
  requestConcurrency: number;
  /** Stop after embedding this many chunks; omit to embed everything pending. Mainly for tests/dry runs. */
  limit?: number;
  /** Abort the whole run after this many consecutive fully-failed batches, a strong signal of a systemic problem (bad key, provider outage, network down) rather than a one-off bad chunk. */
  maxConsecutiveBatchFailures?: number;
}

export interface EmbedPendingChunksResult {
  embedded: number;
  failed: number;
  batchesRun: number;
  aborted: boolean;
  abortReason?: string;
}

const DEFAULT_MAX_CONSECUTIVE_BATCH_FAILURES = 5;

function truncateForEmbedding(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  logger.warn(
    { originalLength: text.length, maxChars },
    'Truncating oversized chunk text before embedding',
  );
  return text.slice(0, maxChars);
}

interface BatchOutcome {
  succeeded: number;
  failedCount: number;
  abortReason?: string;
}

/**
 * Embeds one API-call-sized batch and writes the results. On a
 * non-retryable 4xx (EmbeddingBadRequestError) covering more than one
 * chunk, bisects the batch and retries each half independently, isolating
 * a single poisoned chunk (e.g. one whose text somehow trips a provider
 * content policy) instead of failing every chunk in the batch for it.
 * Bounded to O(log n) extra requests in the worst single-poison-item case.
 */
async function runBatch(
  repository: ChunkRepository,
  embeddingClient: EmbeddingClientLike,
  batch: readonly TextBatchItem[],
  embeddingModel: string,
  embeddingDimensions: number,
): Promise<BatchOutcome> {
  if (batch.length === 0) return { succeeded: 0, failedCount: 0 };

  try {
    const vectors = await embeddingClient.embedBatch(batch.map((item) => item.text));

    if (vectors.length !== batch.length) {
      throw new Error(
        `Embedding client returned ${vectors.length} vectors for a batch of ${batch.length} chunks`,
      );
    }

    const successes: EmbeddingSuccess[] = [];
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      const vector = vectors[i];
      if (!item || !vector) {
        throw new Error('Internal error: batch/vector index mismatch while assembling embedding successes');
      }
      successes.push({ chunkId: item.id, vectorLiteral: toVectorLiteral(vector, embeddingDimensions) });
    }

    await repository.writeEmbeddingSuccesses(successes, embeddingModel);
    return { succeeded: successes.length, failedCount: 0 };
  } catch (err) {
    if (err instanceof EmbeddingAuthError) {
      return { succeeded: 0, failedCount: batch.length, abortReason: err.message };
    }

    if (err instanceof EmbeddingBadRequestError && batch.length > 1) {
      const mid = Math.ceil(batch.length / 2);
      const left = await runBatch(
        repository,
        embeddingClient,
        batch.slice(0, mid),
        embeddingModel,
        embeddingDimensions,
      );
      const right = await runBatch(
        repository,
        embeddingClient,
        batch.slice(mid),
        embeddingModel,
        embeddingDimensions,
      );
      const abortReason = left.abortReason ?? right.abortReason;
      return {
        succeeded: left.succeeded + right.succeeded,
        failedCount: left.failedCount + right.failedCount,
        ...(abortReason !== undefined ? { abortReason } : {}),
      };
    }

    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, batchSize: batch.length }, 'Embedding batch failed');
    await Promise.all(batch.map((item) => repository.recordEmbeddingFailure(item.id, message)));
    return { succeeded: 0, failedCount: batch.length };
  }
}

/**
 * Embeds every chunk with embedding IS NULL (below maxAttempts), for one
 * catalog or the whole table. Designed to be safely re-run: it is the
 * entry point for both the initial backfill right after ingestion and
 * ongoing catch-up after new content is ingested (see the cursor
 * pagination and retry-budget design in chunk-repository.ts that make
 * repeated runs converge rather than loop forever on chunks that can't be
 * embedded).
 */
export async function embedPendingChunks(
  repository: ChunkRepository,
  embeddingClient: EmbeddingClientLike,
  options: EmbedPendingChunksOptions,
): Promise<EmbedPendingChunksResult> {
  const maxConsecutiveFailures = options.maxConsecutiveBatchFailures ?? DEFAULT_MAX_CONSECUTIVE_BATCH_FAILURES;

  let catalogId: number | undefined;
  if (options.catalogSlug !== undefined) {
    const found = await repository.findCatalogIdBySlug(options.catalogSlug);
    if (found === null) {
      return {
        embedded: 0,
        failed: 0,
        batchesRun: 0,
        aborted: true,
        abortReason: `Unknown catalog slug: ${options.catalogSlug}`,
      };
    }
    catalogId = found;
  }

  let afterId = 0;
  let embedded = 0;
  let failed = 0;
  let batchesRun = 0;
  let consecutiveBatchFailures = 0;

  for (;;) {
    if (options.limit !== undefined && embedded >= options.limit) break;

    const page: PendingChunk[] = await repository.fetchPendingChunks({
      afterId,
      pageSize: options.fetchPageSize,
      maxAttempts: options.maxAttempts,
      ...(catalogId !== undefined ? { catalogId } : {}),
    });

    if (page.length === 0) break;

    const last = page[page.length - 1];
    if (!last) break; // unreachable given the length check above; keeps noUncheckedIndexedAccess happy
    afterId = last.id;

    const prepared: TextBatchItem[] = page.map((chunk) => ({
      id: chunk.id,
      text: truncateForEmbedding(chunk.text, options.maxCharsPerChunk),
    }));

    const batches = batchByCountAndSize(prepared, options.batchSize, options.maxCharsPerBatch);

    const outcomes = await mapWithConcurrency(batches, options.requestConcurrency, (batch) =>
      runBatch(repository, embeddingClient, batch, options.embeddingModel, options.embeddingDimensions),
    );

    for (const outcome of outcomes) {
      batchesRun += 1;
      embedded += outcome.succeeded;
      failed += outcome.failedCount;

      if (outcome.abortReason !== undefined) {
        return { embedded, failed, batchesRun, aborted: true, abortReason: outcome.abortReason };
      }

      if (outcome.succeeded === 0 && outcome.failedCount > 0) {
        consecutiveBatchFailures += 1;
      } else {
        consecutiveBatchFailures = 0;
      }

      if (consecutiveBatchFailures >= maxConsecutiveFailures) {
        return {
          embedded,
          failed,
          batchesRun,
          aborted: true,
          abortReason: `Aborted after ${consecutiveBatchFailures} consecutive fully-failed batches`,
        };
      }
    }

    logger.info(
      { afterId, pageSize: page.length, totalEmbedded: embedded, totalFailed: failed },
      'Embedding pipeline progress',
    );
  }

  return { embedded, failed, batchesRun, aborted: false };
}
