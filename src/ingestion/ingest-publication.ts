import type { PublitasClient } from './publitas-client.js';
import { mapSpreadsToPages } from './page-mapper.js';
import { collectProductIds, buildPageChunks } from './text-extractor.js';
import { detectLanguageFromSlug, resolveLanguageCode } from './language-detector.js';
import {
  ingestPublicationTransaction,
  type PageInput,
  type ChunkInput,
} from './catalog-repository.js';
import { mapWithConcurrency } from '../lib/concurrency.js';
import { sha256Hex } from '../lib/hash.js';
import { logger } from '../lib/logger.js';
import type { PublicationListItem, ProductDetail } from '../types/publitas-api.js';

export interface IngestPublicationOptions {
  client: PublitasClient;
  groupSlug: string;
  catalogDisplayName: string;
  publication: PublicationListItem;
  productFetchConcurrency: number;
}

export interface IngestPublicationResult {
  publicationId: number;
  pageCount: number;
  chunkCount: number;
  wasChanged: boolean;
}

function buildPublicUrl(groupSlug: string, publicationSlug: string, pageNumber: number): string {
  return `https://view.publitas.com/${groupSlug}/${publicationSlug}/page/${pageNumber}`;
}

export async function ingestPublication(
  options: IngestPublicationOptions,
): Promise<IngestPublicationResult> {
  const { client, groupSlug, catalogDisplayName, publication, productFetchConcurrency } = options;

  logger.info({ groupSlug, publicationSlug: publication.slug }, 'Fetching publication detail');
  const detail = await client.getPublication(groupSlug, publication.slug);

  // Hash a normalized, stable-key-order representation of the content we
  // actually care about (config + spreads), so a hash change reliably
  // means the retailer changed something we'd re-extract, not that the
  // API happened to reorder JSON keys or add unrelated metadata.
  const contentHash = sha256Hex(JSON.stringify({ config: detail.config, spreads: detail.spreads }));

  const mappedPages = mapSpreadsToPages(detail.spreads);
  const productIds = collectProductIds(mappedPages);

  logger.info(
    {
      groupSlug,
      publicationSlug: publication.slug,
      pageCount: mappedPages.length,
      productCount: productIds.length,
    },
    'Resolving product hotspots',
  );

  const products = await mapWithConcurrency(productIds, productFetchConcurrency, (productId) =>
    client.getProduct(groupSlug, publication.slug, productId),
  );

  const productLookup = new Map<number, ProductDetail | null>();
  productIds.forEach((id, index) => {
    productLookup.set(id, products[index] ?? null);
  });

  // Publitas' config.language has been observed wrong in practice (a whole
  // catalog group reporting 'en' on publications titled "...Espanol" and
  // "...Francais"), so it's cross-checked against a language detected from
  // the publication's own slug/title, which retailers encode reliably. See
  // language-detector.ts for why this only ever overrides, never guesses
  // blind.
  const configLanguage = detail.config.language;
  const slugDetectedLanguage = detectLanguageFromSlug(publication.slug, publication.title);
  const { languageCode, source } = resolveLanguageCode(configLanguage, slugDetectedLanguage);

  if (source === 'slug_override') {
    logger.warn(
      {
        groupSlug,
        publicationSlug: publication.slug,
        configLanguage,
        slugDetectedLanguage,
        languageCode,
      },
      'Publitas config.language disagreed with the language detected from the publication slug/title; using the slug-detected value',
    );
  }

  const pages: PageInput[] = mappedPages.map((page) => {
    const chunkCandidates = buildPageChunks(page, productLookup);
    const chunks: ChunkInput[] = chunkCandidates.map((candidate, chunkIndex) => ({
      chunkIndex,
      text: candidate.text,
      textHash: sha256Hex(candidate.text),
      productRef: candidate.productRef,
      languageCode,
    }));

    return {
      pageNumber: page.pageNumber,
      publicUrl: buildPublicUrl(groupSlug, publication.slug, page.pageNumber),
      // Derived directly from the same chunk candidates rather than a
      // separate buildPageText() call, so this never computes hotspot
      // text twice or risks drifting from what actually got chunked.
      rawText: chunkCandidates
        .map((c) => c.text)
        .join('. ')
        .trim(),
      languageCode,
      chunks,
    };
  });

  const result = await ingestPublicationTransaction({
    groupSlug,
    catalogDisplayName,
    publitasId: publication.id,
    slug: publication.slug,
    title: publication.title,
    onlineAt: publication.onlineAt,
    sourceContentHash: contentHash,
    languageCode,
    pages,
  });

  const chunkCount = pages.reduce((sum, page) => sum + page.chunks.length, 0);

  if (result.wasChanged) {
    logger.info(
      { groupSlug, publicationSlug: publication.slug, pageCount: pages.length, chunkCount },
      'Publication ingested (content changed)',
    );
  } else {
    logger.info(
      { groupSlug, publicationSlug: publication.slug },
      'Publication unchanged since last ingest, skipped',
    );
  }

  return {
    publicationId: result.publicationId,
    pageCount: pages.length,
    chunkCount,
    wasChanged: result.wasChanged,
  };
}
