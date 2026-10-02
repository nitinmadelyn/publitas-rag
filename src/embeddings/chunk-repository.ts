import { query } from '../db/client.js';

export interface PendingChunk {
  id: number;
  text: string;
}

export interface FetchPendingChunksOptions {
  afterId: number;
  pageSize: number;
  maxAttempts: number;
  catalogId?: number;
}

export interface SqlQuery {
  text: string;
  params: unknown[];
}

/**
 * Pure query builder, split out from fetchPendingChunks so the SQL/param
 * assembly (in particular the optional catalog filter's placeholder
 * numbering) can be unit tested without a live database.
 *
 * Cursor-paginated by id (WHERE id > afterId ... ORDER BY id) rather than
 * OFFSET: OFFSET gets slower as it grows and can skip or duplicate rows
 * under concurrent writes, while an id cursor is O(1) per page and stable.
 * embedding_attempts < maxAttempts excludes chunks that have permanently
 * failed (see 002_embedding_retry_tracking.sql), which is also what makes
 * repeatedly calling this with an advancing cursor terminate: a chunk that
 * fails this run is left behind by the cursor and only revisited on a
 * fresh run (afterId resets to 0), not looped on forever within one run.
 */
export function buildPendingChunksQuery(options: FetchPendingChunksOptions): SqlQuery {
  const { afterId, pageSize, maxAttempts, catalogId } = options;

  const params: unknown[] = [afterId, maxAttempts];
  let catalogFilter = '';
  if (catalogId !== undefined) {
    params.push(catalogId);
    catalogFilter = `AND catalog_id = $${params.length}`;
  }
  params.push(pageSize);
  const pageSizeParam = params.length;

  return {
    text: `
      SELECT id, text
      FROM chunks
      WHERE embedding IS NULL
        AND id > $1
        AND embedding_attempts < $2
        ${catalogFilter}
      ORDER BY id
      LIMIT $${pageSizeParam}
    `,
    params,
  };
}

export async function fetchPendingChunks(options: FetchPendingChunksOptions): Promise<PendingChunk[]> {
  const built = buildPendingChunksQuery(options);
  const result = await query<{ id: number; text: string }>(built.text, built.params);
  return result.rows;
}

export interface EmbeddingSuccess {
  chunkId: number;
  vectorLiteral: string;
}

/**
 * Pure builder for the bulk UPDATE ... FROM (VALUES ...) query, unit
 * tested separately from the DB call itself (see writeEmbeddingSuccesses).
 * Writing every row in a batch with one round trip (rather than one UPDATE
 * per chunk) matters at the volumes a full catalog re-embed can reach,
 * tens of thousands of chunks, where per-row round trips would dominate
 * wall-clock time.
 *
 * Precondition: `successes` must be non-empty, an empty VALUES list is
 * invalid SQL. writeEmbeddingSuccesses guards this before calling in.
 */
export function buildEmbeddingUpdateQuery(
  successes: readonly EmbeddingSuccess[],
  embeddingModel: string,
): SqlQuery {
  const params: unknown[] = [embeddingModel];
  const valueRows: string[] = [];

  for (const success of successes) {
    params.push(success.chunkId, success.vectorLiteral);
    const idIdx = params.length - 1;
    const vecIdx = params.length;
    valueRows.push(`($${idIdx}::bigint, $${vecIdx}::vector)`);
  }

  return {
    text: `
      UPDATE chunks AS c
      SET embedding = v.embedding,
          embedded_at = now(),
          embedding_model = $1,
          embedding_attempts = 0,
          embedding_last_error = NULL
      FROM (VALUES ${valueRows.join(', ')}) AS v(id, embedding)
      WHERE c.id = v.id
    `,
    params,
  };
}

export async function writeEmbeddingSuccesses(
  successes: readonly EmbeddingSuccess[],
  embeddingModel: string,
): Promise<void> {
  if (successes.length === 0) return;
  const built = buildEmbeddingUpdateQuery(successes, embeddingModel);
  await query(built.text, built.params);
}

/**
 * Records a failed embedding attempt: increments embedding_attempts and
 * stores the error message, without touching `embedding` (which stays
 * NULL). Applied one row at a time since failures are expected to be rare
 * relative to successes, unlike the success path above where batching
 * matters for throughput.
 */
export async function recordEmbeddingFailure(chunkId: number, errorMessage: string): Promise<void> {
  await query(
    `
    UPDATE chunks
    SET embedding_attempts = embedding_attempts + 1,
        embedding_last_error = $2
    WHERE id = $1
    `,
    [chunkId, errorMessage.slice(0, 2000)],
  );
}

export async function findCatalogIdBySlug(groupSlug: string): Promise<number | null> {
  const result = await query<{ id: number }>('SELECT id FROM catalogs WHERE group_slug = $1', [
    groupSlug,
  ]);
  const row = result.rows[0];
  return row ? row.id : null;
}

/**
 * The full set of DB operations the embedding pipeline needs, gathered
 * behind an interface so embed-chunks.ts can be unit tested against a fake
 * implementation instead of a live database (mirrors how PublitasClient
 * and HttpClient take an injectable fetchImpl).
 */
export interface ChunkRepository {
  fetchPendingChunks(options: FetchPendingChunksOptions): Promise<PendingChunk[]>;
  writeEmbeddingSuccesses(successes: readonly EmbeddingSuccess[], embeddingModel: string): Promise<void>;
  recordEmbeddingFailure(chunkId: number, errorMessage: string): Promise<void>;
  findCatalogIdBySlug(groupSlug: string): Promise<number | null>;
}

/** Default, DB-backed repository. Tests inject a fake ChunkRepository instead of this. */
export const defaultChunkRepository: ChunkRepository = {
  fetchPendingChunks,
  writeEmbeddingSuccesses,
  recordEmbeddingFailure,
  findCatalogIdBySlug,
};
