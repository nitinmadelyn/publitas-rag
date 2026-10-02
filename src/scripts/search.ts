import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { closePool } from '../db/client.js';
import { OpenAIEmbeddingClient } from '../embeddings/openai-embedding-client.js';
import { retrieveChunks } from '../retrieval/retrieve.js';
import { defaultRetrievalRepository } from '../retrieval/chunk-search-repository.js';
import { CatalogNotFoundError, RetrievalValidationError } from '../retrieval/errors.js';

interface ParsedArgs {
  catalogSlug: string;
  languageCode: string;
  query: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let catalogSlug: string | undefined;
  let languageCode: string | undefined;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--catalog') {
      catalogSlug = argv[i + 1];
      i += 1;
    } else if (arg === '--lang') {
      languageCode = argv[i + 1];
      i += 1;
    } else if (arg !== undefined) {
      rest.push(arg);
    }
  }

  if (!catalogSlug || !languageCode || rest.length === 0) {
    process.stderr.write('Usage: tsx src/scripts/search.ts --catalog <slug> --lang <code> "<query text>"\n');
    process.exit(1);
  }

  return { catalogSlug, languageCode, query: rest.join(' ') };
}

async function main(): Promise<void> {
  const { catalogSlug, languageCode, query } = parseArgs(process.argv.slice(2));

  const embeddingClient = new OpenAIEmbeddingClient({
    apiKey: config.OPENAI_API_KEY,
    model: config.EMBEDDING_MODEL,
    dimensions: config.EMBEDDING_DIMENSIONS,
    timeoutMs: config.EMBEDDING_API_TIMEOUT_MS,
    maxRetries: config.EMBEDDING_API_MAX_RETRIES,
  });

  const results = await retrieveChunks(defaultRetrievalRepository, embeddingClient, {
    query,
    catalogSlug,
    languageCode,
    topK: config.RETRIEVAL_TOP_K,
    relevanceThreshold: config.RETRIEVAL_RELEVANCE_THRESHOLD,
    embeddingDimensions: config.EMBEDDING_DIMENSIONS,
    lexicalLimit: config.RETRIEVAL_LEXICAL_LIMIT,
    lexicalMinSimilarity: config.RETRIEVAL_LEXICAL_MIN_SIMILARITY,
  });

  if (results.length === 0) {
    process.stdout.write('No results.\n');
    return;
  }

  for (const [i, chunk] of results.entries()) {
    process.stdout.write(
      `${i + 1}. [${chunk.matchType} ${chunk.score.toFixed(3)}] ${chunk.text}\n   ${chunk.publicUrl}\n`,
    );
  }
}

main()
  .catch((err: unknown) => {
    if (err instanceof CatalogNotFoundError || err instanceof RetrievalValidationError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    logger.error({ err }, 'Search script failed');
    process.exitCode = 1;
  })
  .finally(() => {
    void closePool();
  });
