import { buildServer } from '../api/server.js';
import { defaultRetrievalRepository } from '../retrieval/chunk-search-repository.js';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { ClaudeRequestError } from '../generation/claude-client.js';
import type { EmbeddingClientLike } from '../retrieval/retrieve.js';
import type { ClaudeClientLike } from '../generation/generate-answer.js';

/**
 * Starts the real Fastify app (real routes, real validation, real rate
 * limiter, real Postgres-backed retrieval) against a REAL database, but
 * with the two external network calls - OpenAI embeddings and Anthropic
 * completion - replaced by fast, deterministic, in-process fakes.
 *
 * Why: those two providers are both rate-limited and billed per call.
 * Running a meaningful load test (hundreds of req/s, sustained for
 * minutes) against them directly would be slow, expensive, and would
 * mostly measure OpenAI/Anthropic's own latency and rate limits rather
 * than anything about this service. The actual questions a load test on
 * *this* codebase needs to answer - does the Postgres connection pool
 * hold up under concurrency, does the rate limiter behave correctly,
 * does the Fastify/Node event loop stay responsive, does memory stay
 * bounded over a sustained run - are all about our own stack, and none
 * of them require the upstream AI providers to be real.
 *
 * This reuses buildServer()'s existing dependency-injection seam (the
 * same one test/api-server.test.ts and test/resilience.test.ts use) with
 * one real dependency (the Postgres repository) and two fake ones, so
 * there is no separate/forked server implementation to keep in sync with
 * the production one - this IS the production server, just pointed at
 * fakes for the two paid upstreams.
 *
 * Configuration is via environment variables (not the main envSchema in
 * config/index.ts on purpose): these knobs exist only for this script
 * and would be noise in the production config surface.
 *   LOAD_TEST_PORT              - port to listen on (default 3100)
 *   LOAD_TEST_CLAUDE_LATENCY_MS - simulated Claude latency (default 150)
 *   LOAD_TEST_CLAUDE_FAILURE_RATE - 0-1, fraction of Claude calls that
 *                                   fail with a retryable error, to
 *                                   exercise the failure path under load
 *                                   (default 0)
 *   LOAD_TEST_EMBEDDING_LATENCY_MS - simulated OpenAI latency (default 20)
 */

const PORT = Number.parseInt(process.env.LOAD_TEST_PORT ?? '3100', 10);
const CLAUDE_LATENCY_MS = Number.parseInt(process.env.LOAD_TEST_CLAUDE_LATENCY_MS ?? '150', 10);
const CLAUDE_FAILURE_RATE = Number.parseFloat(process.env.LOAD_TEST_CLAUDE_FAILURE_RATE ?? '0');
const EMBEDDING_LATENCY_MS = Number.parseInt(process.env.LOAD_TEST_EMBEDDING_LATENCY_MS ?? '20', 10);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeEmbeddingClient(): EmbeddingClientLike {
  return {
    async embedBatch(texts: readonly string[]): Promise<number[][]> {
      await delay(EMBEDDING_LATENCY_MS);
      // A deterministic, cheap-to-compute vector per text (not random)
      // so repeated load-test runs are reproducible. It carries no real
      // semantic meaning - it only needs to be a valid-shaped vector so
      // the real pgvector query path executes exactly as it would in
      // production, exercising real index scan cost under load.
      return texts.map((text) => {
        const seed = Array.from(text).reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
        return Array.from({ length: config.EMBEDDING_DIMENSIONS }, (_, i) =>
          Math.sin(seed + i) * 0.5,
        );
      });
    },
  };
}

function fakeClaudeClient(): ClaudeClientLike {
  return {
    async complete(_system: string, userPrompt: string): Promise<string> {
      await delay(CLAUDE_LATENCY_MS);
      if (CLAUDE_FAILURE_RATE > 0 && Math.random() < CLAUDE_FAILURE_RATE) {
        // Reuses the real ClaudeRequestError class (rather than a
        // one-off error type) specifically so the server's existing
        // error handler (api/errors.ts) maps it to the exact same 503
        // upstream_unavailable response a real Claude 529 would produce
        // in production - the failure-injection path exercises the real
        // mapping, not an approximation of it.
        throw new ClaudeRequestError('simulated upstream overload (load-test-server)', 529, '');
      }
      // Cites chunk [1] whenever the prompt contains at least one
      // grounding chunk, so responses look realistic without an actual
      // model call.
      const hasContext = userPrompt.includes('[1]') || /\[Chunk 1\]/i.test(userPrompt);
      return hasContext
        ? 'Based on the catalog, here is what I found [1].'
        : "I don't have information about that in this catalogue.";
    },
  };
}

async function main(): Promise<void> {
  logger.warn(
    { port: PORT, claudeLatencyMs: CLAUDE_LATENCY_MS, claudeFailureRate: CLAUDE_FAILURE_RATE },
    'Starting LOAD TEST server - real Postgres, FAKE OpenAI/Claude clients. Do not point production traffic at this port.',
  );

  const app = await buildServer({
    dependencies: {
      repository: defaultRetrievalRepository,
      embeddingClient: fakeEmbeddingClient(),
      claudeClient: fakeClaudeClient(),
    },
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Load test server shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Load test server failed to start');
  process.exit(1);
});
