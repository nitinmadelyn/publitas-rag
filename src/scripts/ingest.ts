import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { closePool } from '../db/client.js';
import { PublitasClient } from '../ingestion/publitas-client.js';
import { ingestGroup } from '../ingestion/ingest-group.js';

async function main(): Promise<void> {
  const groupSlug = process.argv[2];
  if (!groupSlug) {
    process.stderr.write('Usage: tsx src/scripts/ingest.ts <group-slug> [display-name]\n');
    process.exit(1);
  }
  const catalogDisplayName = process.argv[3] ?? groupSlug;

  const client = new PublitasClient({
    baseUrl: config.PUBLITAS_API_BASE_URL,
    timeoutMs: config.PUBLITAS_API_TIMEOUT_MS,
    maxRetries: config.PUBLITAS_API_MAX_RETRIES,
  });

  const summary = await ingestGroup({
    client,
    groupSlug,
    catalogDisplayName,
    productFetchConcurrency: config.PUBLITAS_PRODUCT_FETCH_CONCURRENCY,
  });

  logger.info({ summary }, 'Ingestion run finished');

  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'Ingestion script failed');
    process.exitCode = 1;
  })
  .finally(() => {
    void closePool();
  });
