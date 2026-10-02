import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { closePool } from '../db/client.js';
import { OpenAIEmbeddingClient } from '../embeddings/openai-embedding-client.js';
import { embedPendingChunks } from '../embeddings/embed-chunks.js';
import { defaultChunkRepository } from '../embeddings/chunk-repository.js';

interface ParsedArgs {
  catalogSlug?: string;
  limit?: number;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let catalogSlug: string | undefined;
  let limit: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--catalog') {
      const value = argv[i + 1];
      if (value !== undefined) catalogSlug = value;
      i += 1;
    } else if (arg === '--limit') {
      const value = argv[i + 1];
      if (value !== undefined) {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) limit = parsed;
      }
      i += 1;
    }
  }

  return {
    ...(catalogSlug !== undefined ? { catalogSlug } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

async function main(): Promise<void> {
  const { catalogSlug, limit } = parseArgs(process.argv.slice(2));

  const embeddingClient = new OpenAIEmbeddingClient({
    apiKey: config.OPENAI_API_KEY,
    model: config.EMBEDDING_MODEL,
    dimensions: config.EMBEDDING_DIMENSIONS,
    timeoutMs: config.EMBEDDING_API_TIMEOUT_MS,
    maxRetries: config.EMBEDDING_API_MAX_RETRIES,
  });

  const result = await embedPendingChunks(defaultChunkRepository, embeddingClient, {
    ...(catalogSlug !== undefined ? { catalogSlug } : {}),
    embeddingModel: config.EMBEDDING_MODEL,
    embeddingDimensions: config.EMBEDDING_DIMENSIONS,
    batchSize: config.EMBEDDING_BATCH_SIZE,
    fetchPageSize: config.EMBEDDING_FETCH_PAGE_SIZE,
    maxAttempts: config.EMBEDDING_MAX_ATTEMPTS,
    maxCharsPerChunk: config.EMBEDDING_MAX_CHARS_PER_CHUNK,
    maxCharsPerBatch: config.EMBEDDING_MAX_CHARS_PER_BATCH,
    requestConcurrency: config.EMBEDDING_REQUEST_CONCURRENCY,
    ...(limit !== undefined ? { limit } : {}),
  });

  logger.info({ result }, 'Embedding run finished');

  if (result.aborted || result.failed > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'Embedding script failed');
    process.exitCode = 1;
  })
  .finally(() => {
    void closePool();
  });
