import type { PublitasClient } from './publitas-client.js';
import { ingestPublication } from './ingest-publication.js';
import { logger } from '../lib/logger.js';

export interface IngestGroupOptions {
  client: PublitasClient;
  groupSlug: string;
  catalogDisplayName: string;
  productFetchConcurrency: number;
}

export interface IngestGroupSummary {
  groupSlug: string;
  totalPublications: number;
  changed: number;
  unchanged: number;
  failed: number;
  failures: { publicationSlug: string; error: string }[];
}

/**
 * Publications are ingested sequentially, not in parallel. A group's
 * publication list is typically small (tens, not thousands), and
 * sequential ingestion keeps our total request rate against Publitas'
 * API predictable and easy to reason about; parallelizing this loop
 * would multiply against the already-concurrent product hotspot fetches
 * inside each publication, ballooning simultaneous requests without a
 * clear benefit at this scale. If ingesting hundreds of catalogs
 * routinely becomes the norm, this is the loop to revisit first.
 */
export async function ingestGroup(options: IngestGroupOptions): Promise<IngestGroupSummary> {
  const { client, groupSlug, catalogDisplayName, productFetchConcurrency } = options;

  const publications = await client.listPublications(groupSlug);
  logger.info({ groupSlug, count: publications.length }, 'Listed publications for group');

  const summary: IngestGroupSummary = {
    groupSlug,
    totalPublications: publications.length,
    changed: 0,
    unchanged: 0,
    failed: 0,
    failures: [],
  };

  for (const publication of publications) {
    try {
      const result = await ingestPublication({
        client,
        groupSlug,
        catalogDisplayName,
        publication,
        productFetchConcurrency,
      });
      if (result.wasChanged) {
        summary.changed += 1;
      } else {
        summary.unchanged += 1;
      }
    } catch (err) {
      // One broken publication (malformed data, a permanent 4xx, etc.)
      // must not abort ingestion of the rest of the group.
      summary.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      summary.failures.push({ publicationSlug: publication.slug, error: message });
      logger.error(
        { err, groupSlug, publicationSlug: publication.slug },
        'Failed to ingest publication',
      );
    }
  }

  logger.info({ groupSlug, summary }, 'Group ingestion complete');
  return summary;
}
