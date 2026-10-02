import type { RawSearchRow, RetrievalRepository } from './chunk-search-repository.js';
import { toVectorLiteral } from '../embeddings/vector-literal.js';
import { RetrievalValidationError, CatalogNotFoundError } from './errors.js';
import { logger } from '../lib/logger.js';

/**
 * The minimal shape retrieve.ts needs from an embedding provider.
 * OpenAIEmbeddingClient satisfies this structurally; tests inject a fake.
 */
export interface EmbeddingClientLike {
  embedBatch(texts: readonly string[]): Promise<number[][]>;
}

export type MatchType = 'vector' | 'lexical' | 'hybrid';

export interface RetrievedChunk {
  chunkId: number;
  pageId: number;
  catalogId: number;
  chunkIndex: number;
  text: string;
  productRef: string | null;
  languageCode: string;
  pageNumber: number;
  publicUrl: string;
  score: number;
  matchType: MatchType;
}

export interface RetrieveChunksOptions {
  query: string;
  catalogSlug: string;
  languageCode: string;
  topK: number;
  relevanceThreshold: number;
  embeddingDimensions: number;
  lexicalLimit: number;
  lexicalMinSimilarity: number;
}

function toRetrievedChunk(row: RawSearchRow, matchType: MatchType, score: number): RetrievedChunk {
  return {
    chunkId: row.id,
    pageId: row.page_id,
    catalogId: row.catalog_id,
    chunkIndex: row.chunk_index,
    text: row.text,
    productRef: row.product_ref,
    languageCode: row.language_code,
    pageNumber: row.page_number,
    publicUrl: row.public_url,
    score,
    matchType,
  };
}

/**
 * Merges vector and lexical result sets into one ranked, deduplicated list.
 * A chunk found by both becomes 'hybrid' and keeps the higher of the two
 * scores (cosine similarity and trigram similarity are both roughly 0..1,
 * so comparing them directly is a reasonable approximation, not a
 * mathematically calibrated blend).
 *
 * relevanceThreshold is applied only to vector-only matches: a lexical hit
 * is a literal substring/token match (an exact SKU, model number, or brand
 * name), valuable signal on its own even when its raw trigram score sits
 * under a threshold calibrated for embedding similarity, a different scale
 * with a different meaning. Pure vector noise below the threshold is
 * dropped since it isn't backed by any exact-match signal.
 */
export function mergeSearchResults(
  vectorRows: readonly RawSearchRow[],
  lexicalRows: readonly RawSearchRow[],
  relevanceThreshold: number,
  topK: number,
): RetrievedChunk[] {
  const byId = new Map<number, RetrievedChunk>();

  for (const row of vectorRows) {
    byId.set(row.id, toRetrievedChunk(row, 'vector', row.score));
  }

  for (const row of lexicalRows) {
    const existing = byId.get(row.id);
    if (existing) {
      byId.set(row.id, {
        ...existing,
        matchType: 'hybrid',
        score: Math.max(existing.score, row.score),
      });
    } else {
      byId.set(row.id, toRetrievedChunk(row, 'lexical', row.score));
    }
  }

  const merged = Array.from(byId.values()).filter(
    (chunk) => chunk.matchType !== 'vector' || chunk.score >= relevanceThreshold,
  );

  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, topK);
}

/**
 * The single entry point retrieval-consuming code (the chat/generation
 * layer, Phase 6) calls: embeds the query, runs a hybrid vector + lexical
 * search scoped to one catalog and language, and returns a ranked,
 * deduplicated, citation-ready result set (publicUrl on every chunk links
 * straight back to the source catalog page).
 *
 * Deliberately same-language-only: a catalog's pages carry an
 * authoritative language_code from Publitas' own config, and mixing
 * languages in one result set would surface citations the shopper can't
 * read. Language selection is the caller's responsibility (e.g. the
 * shopper's UI locale, or the catalog's default_language as a fallback).
 */
export async function retrieveChunks(
  repository: RetrievalRepository,
  embeddingClient: EmbeddingClientLike,
  options: RetrieveChunksOptions,
): Promise<RetrievedChunk[]> {
  const trimmedQuery = options.query.trim();
  if (trimmedQuery.length === 0) {
    throw new RetrievalValidationError('query must not be empty');
  }
  if (options.languageCode.trim().length === 0) {
    throw new RetrievalValidationError('languageCode must not be empty');
  }
  if (options.topK < 1) {
    throw new RetrievalValidationError('topK must be at least 1');
  }

  const catalogId = await repository.findCatalogIdBySlug(options.catalogSlug);
  if (catalogId === null) {
    throw new CatalogNotFoundError(options.catalogSlug);
  }

  const vectors = await embeddingClient.embedBatch([trimmedQuery]);
  const queryVector = vectors[0];
  if (!queryVector) {
    throw new Error('Embedding client returned no vector for the query');
  }
  const queryVectorLiteral = toVectorLiteral(queryVector, options.embeddingDimensions);

  const [vectorRows, lexicalRows] = await Promise.all([
    repository.vectorSearch({
      queryVectorLiteral,
      catalogId,
      languageCode: options.languageCode,
      limit: options.topK,
    }),
    repository.lexicalSearch({
      queryText: trimmedQuery,
      catalogId,
      languageCode: options.languageCode,
      minSimilarity: options.lexicalMinSimilarity,
      limit: options.lexicalLimit,
    }),
  ]);

  const merged = mergeSearchResults(vectorRows, lexicalRows, options.relevanceThreshold, options.topK);

  logger.info(
    {
      catalogSlug: options.catalogSlug,
      languageCode: options.languageCode,
      vectorHits: vectorRows.length,
      lexicalHits: lexicalRows.length,
      merged: merged.length,
    },
    'Retrieval completed',
  );

  return merged;
}
