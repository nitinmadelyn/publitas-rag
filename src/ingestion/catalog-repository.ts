import type { PoolClient } from 'pg';
import { withTransaction } from '../db/client.js';

export interface UpsertCatalogResult {
  catalogId: number;
}

export async function upsertCatalog(
  client: PoolClient,
  groupSlug: string,
  displayName: string,
): Promise<UpsertCatalogResult> {
  const result = await client.query<{ id: number }>(
    `
    INSERT INTO catalogs (group_slug, display_name)
    VALUES ($1, $2)
    ON CONFLICT (group_slug)
    DO UPDATE SET display_name = EXCLUDED.display_name
    RETURNING id
    `,
    [groupSlug, displayName],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`upsertCatalog: no row returned for group_slug=${groupSlug}`);
  }
  return { catalogId: row.id };
}

export async function setCatalogDefaultLanguage(
  client: PoolClient,
  catalogId: number,
  languageCode: string,
): Promise<void> {
  // Only set if not already set, the "default" language is a best-effort
  // label for the catalog as a whole; the authoritative per-publication
  // value lives on publications/pages and is what retrieval actually filters on.
  await client.query(
    `UPDATE catalogs SET default_language = COALESCE(default_language, $2) WHERE id = $1`,
    [catalogId, languageCode],
  );
}

export interface ExistingPublication {
  id: number;
  sourceContentHash: string | null;
}

export async function findPublicationByPublitasId(
  client: PoolClient,
  catalogId: number,
  publitasId: number,
): Promise<ExistingPublication | null> {
  const result = await client.query<{ id: number; source_content_hash: string | null }>(
    `SELECT id, source_content_hash FROM publications WHERE catalog_id = $1 AND publitas_id = $2`,
    [catalogId, publitasId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, sourceContentHash: row.source_content_hash };
}

export interface UpsertPublicationInput {
  catalogId: number;
  publitasId: number;
  slug: string;
  title: string;
  onlineAt: string | null;
  sourceContentHash: string;
}

export async function upsertPublication(
  client: PoolClient,
  input: UpsertPublicationInput,
): Promise<{ publicationId: number }> {
  const result = await client.query<{ id: number }>(
    `
    INSERT INTO publications (catalog_id, publitas_id, slug, title, online_at, ingested_at, source_content_hash)
    VALUES ($1, $2, $3, $4, $5, now(), $6)
    ON CONFLICT (catalog_id, publitas_id)
    DO UPDATE SET
      slug = EXCLUDED.slug,
      title = EXCLUDED.title,
      online_at = EXCLUDED.online_at,
      ingested_at = now(),
      source_content_hash = EXCLUDED.source_content_hash
    RETURNING id
    `,
    [
      input.catalogId,
      input.publitasId,
      input.slug,
      input.title,
      input.onlineAt,
      input.sourceContentHash,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `upsertPublication: no row returned for catalog_id=${input.catalogId} publitas_id=${input.publitasId}`,
    );
  }
  return { publicationId: row.id };
}

export interface ChunkInput {
  /** 0-based ordering of this chunk within its page. */
  chunkIndex: number;
  text: string;
  /** sha256 of `text`; lets the embedding pipeline (Phase 4) skip chunks whose text hasn't changed. */
  textHash: string;
  /** Product id this chunk is about, or null for a non-product chunk. */
  productRef: string | null;
  languageCode: string;
}

export interface PageInput {
  pageNumber: number;
  publicUrl: string;
  rawText: string;
  languageCode: string;
  chunks: readonly ChunkInput[];
}

/**
 * Replaces all pages (and, transitively, all chunks) for a publication.
 * Chosen over a diff-and-patch approach deliberately: page count and
 * hotspot content can change between ingests (a retailer edits a live
 * catalog), and matching old pages/chunks to new ones is fragile if
 * content is inserted, removed, or reordered. A full replace inside the
 * same transaction as the publication upsert is simple and correct.
 *
 * Deleting a page cascades to delete its chunks (chunks.page_id has ON
 * DELETE CASCADE), so no separate chunk-delete step is needed here, and
 * no stale chunk can outlive the page it was extracted from.
 *
 * Known tradeoff: when a publication's content_hash DOES change, every
 * page (even ones whose own content didn't change) gets torn down and
 * reinserted, which means every chunk gets a new id and loses whatever
 * embedding it had, even if `text_hash` is identical to before. A
 * smarter upsert-by-text_hash strategy could avoid re-embedding unchanged
 * chunks; not implemented here since content_hash unchanged (the common
 * case, most re-ingests are no-ops) already skips this function entirely
 * via the check in ingestPublicationTransaction below. Worth revisiting
 * if embedding costs from partial catalog updates become material.
 */
export async function replacePages(
  client: PoolClient,
  publicationId: number,
  catalogId: number,
  pages: readonly PageInput[],
): Promise<void> {
  await client.query(`DELETE FROM pages WHERE publication_id = $1`, [publicationId]);

  for (const page of pages) {
    const pageResult = await client.query<{ id: number }>(
      `
      INSERT INTO pages (publication_id, page_number, public_url, raw_text, language_code)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
      `,
      [publicationId, page.pageNumber, page.publicUrl, page.rawText, page.languageCode],
    );
    const pageRow = pageResult.rows[0];
    if (!pageRow) {
      throw new Error(`replacePages: no row returned inserting page_number=${page.pageNumber}`);
    }
    const pageId = pageRow.id;

    for (const chunk of page.chunks) {
      await client.query(
        `
        INSERT INTO chunks (page_id, catalog_id, chunk_index, text, text_hash, product_ref, language_code)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          pageId,
          catalogId,
          chunk.chunkIndex,
          chunk.text,
          chunk.textHash,
          chunk.productRef,
          chunk.languageCode,
        ],
      );
    }
  }
}

export interface IngestPublicationTransactionInput {
  groupSlug: string;
  catalogDisplayName: string;
  publitasId: number;
  slug: string;
  title: string;
  onlineAt: string | null;
  sourceContentHash: string;
  languageCode: string;
  pages: readonly PageInput[];
}

export interface IngestPublicationTransactionResult {
  catalogId: number;
  publicationId: number;
  /** false if the publication's content hash matched the existing row and nothing was written. */
  wasChanged: boolean;
}

/**
 * Full atomic write for one publication: catalog upsert, hash check,
 * publication upsert, page replace. Everything happens in a single
 * transaction so a failure partway through never leaves a publication
 * with a new content_hash but stale/missing pages.
 */
export async function ingestPublicationTransaction(
  input: IngestPublicationTransactionInput,
): Promise<IngestPublicationTransactionResult> {
  return withTransaction(async (client) => {
    const { catalogId } = await upsertCatalog(client, input.groupSlug, input.catalogDisplayName);
    await setCatalogDefaultLanguage(client, catalogId, input.languageCode);

    const existing = await findPublicationByPublitasId(client, catalogId, input.publitasId);
    if (existing?.sourceContentHash === input.sourceContentHash) {
      return { catalogId, publicationId: existing.id, wasChanged: false };
    }

    const { publicationId } = await upsertPublication(client, {
      catalogId,
      publitasId: input.publitasId,
      slug: input.slug,
      title: input.title,
      onlineAt: input.onlineAt,
      sourceContentHash: input.sourceContentHash,
    });

    await replacePages(client, publicationId, catalogId, input.pages);

    return { catalogId, publicationId, wasChanged: true };
  });
}
