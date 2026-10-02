import { query } from '../db/client.js';
import { findCatalogIdBySlug } from '../embeddings/chunk-repository.js';
import type { SqlQuery } from '../embeddings/chunk-repository.js';

export { findCatalogIdBySlug };

export interface RawSearchRow {
  id: number;
  page_id: number;
  catalog_id: number;
  chunk_index: number;
  text: string;
  product_ref: string | null;
  language_code: string;
  page_number: number;
  public_url: string;
  score: number;
}

export interface VectorSearchOptions {
  queryVectorLiteral: string;
  catalogId: number;
  languageCode: string;
  limit: number;
}

/**
 * Cosine-similarity search over chunks.embedding, scoped to one catalog and
 * language. `ORDER BY embedding <=> $1` drives the HNSW index built with
 * vector_cosine_ops (see 001_init.sql); score is exposed as 1 - distance so
 * higher is always more relevant, matching the lexical score's scale.
 */
export function buildVectorSearchQuery(options: VectorSearchOptions): SqlQuery {
  const { queryVectorLiteral, catalogId, languageCode, limit } = options;
  return {
    text: `
      SELECT c.id, c.page_id, c.catalog_id, c.chunk_index, c.text, c.product_ref, c.language_code,
             p.page_number, p.public_url,
             1 - (c.embedding <=> $1::vector) AS score
      FROM chunks c
      JOIN pages p ON p.id = c.page_id
      WHERE c.catalog_id = $2
        AND c.language_code = $3
        AND c.embedding IS NOT NULL
      ORDER BY c.embedding <=> $1::vector
      LIMIT $4
    `,
    params: [queryVectorLiteral, catalogId, languageCode, limit],
  };
}

export async function vectorSearch(options: VectorSearchOptions): Promise<RawSearchRow[]> {
  const built = buildVectorSearchQuery(options);
  const result = await query<RawSearchRow>(built.text, built.params);
  return result.rows;
}

export interface LexicalSearchOptions {
  queryText: string;
  catalogId: number;
  languageCode: string;
  minSimilarity: number;
  limit: number;
}

/**
 * Trigram-based lexical fallback (pg_trgm), which catches exact SKU codes,
 * model numbers and brand names that semantic embedding search sometimes
 * ranks poorly, a short, mostly-numeric string carries little semantic
 * meaning to an embedding model, even though it's exactly what a shopper
 * typed.
 *
 * Deliberately not using the `%` operator, which would ride the
 * idx_chunks_text_trgm GIN index but depends on the session-level
 * pg_trgm.similarity_threshold GUC, awkward to set per-query through a
 * pooled connection without a dedicated transaction. At catalog-level
 * chunk volumes (hundreds to low thousands), filtering by catalog_id
 * first already narrows the scan enough that a plain
 * `similarity() >= threshold` predicate is fast and much easier to reason
 * about and test. Revisit with the `%` operator (and a session-scoped
 * SET LOCAL for the threshold) if a single catalog's chunk count grows
 * into the hundreds of thousands.
 */
export function buildLexicalSearchQuery(options: LexicalSearchOptions): SqlQuery {
  const { queryText, catalogId, languageCode, minSimilarity, limit } = options;
  return {
    text: `
      SELECT c.id, c.page_id, c.catalog_id, c.chunk_index, c.text, c.product_ref, c.language_code,
             p.page_number, p.public_url,
             similarity(c.text, $1) AS score
      FROM chunks c
      JOIN pages p ON p.id = c.page_id
      WHERE c.catalog_id = $2
        AND c.language_code = $3
        AND similarity(c.text, $1) >= $4
      ORDER BY score DESC
      LIMIT $5
    `,
    params: [queryText, catalogId, languageCode, minSimilarity, limit],
  };
}

export async function lexicalSearch(options: LexicalSearchOptions): Promise<RawSearchRow[]> {
  const built = buildLexicalSearchQuery(options);
  const result = await query<RawSearchRow>(built.text, built.params);
  return result.rows;
}

/**
 * The DB operations retrieveChunks() needs, gathered behind an interface
 * so it can be unit tested against a fake instead of a live database
 * (same pattern as ChunkRepository in embeddings/chunk-repository.ts).
 */
export interface RetrievalRepository {
  findCatalogIdBySlug(groupSlug: string): Promise<number | null>;
  vectorSearch(options: VectorSearchOptions): Promise<RawSearchRow[]>;
  lexicalSearch(options: LexicalSearchOptions): Promise<RawSearchRow[]>;
}

/** Default, DB-backed repository. Tests inject a fake RetrievalRepository instead of this. */
export const defaultRetrievalRepository: RetrievalRepository = {
  findCatalogIdBySlug,
  vectorSearch,
  lexicalSearch,
};
