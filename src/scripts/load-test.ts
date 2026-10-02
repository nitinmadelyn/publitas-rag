import autocannon, { type Result } from 'autocannon';
import { logger } from '../lib/logger.js';

/**
 * Runs a load test against a running load-test-server.ts instance (real
 * app, real Postgres, fake OpenAI/Claude - see that file's header for
 * why). Configuration is via environment variables so this can run
 * identically from a developer's machine or a CI job:
 *
 *   LOAD_TEST_TARGET_URL   - base URL of the load-test server (default
 *                            http://localhost:3100)
 *   LOAD_TEST_API_KEY      - x-api-key to send (default
 *                            dev-local-key-change-me, matching config's
 *                            own API_KEYS default)
 *   LOAD_TEST_CATALOG_SLUG - an already-ingested catalog slug to query
 *                            against (required, no safe default - a
 *                            nonexistent slug would only measure the
 *                            404 path)
 *   LOAD_TEST_CONNECTIONS  - concurrent connections (default 50)
 *   LOAD_TEST_DURATION_S   - test duration in seconds (default 30)
 *   LOAD_TEST_MAX_P99_MS   - fail (nonzero exit) if p99 latency exceeds
 *                            this, for use as a CI gate (default 2000)
 *   LOAD_TEST_MAX_ERROR_RATE - fail if the non-2xx rate exceeds this
 *                              fraction (default 0.01, i.e. 1%)
 */

const TARGET_URL = process.env.LOAD_TEST_TARGET_URL ?? 'http://localhost:3100';
const API_KEY = process.env.LOAD_TEST_API_KEY ?? 'dev-local-key-change-me';
const CATALOG_SLUG = process.env.LOAD_TEST_CATALOG_SLUG;
const CONNECTIONS = Number.parseInt(process.env.LOAD_TEST_CONNECTIONS ?? '50', 10);
const DURATION_S = Number.parseInt(process.env.LOAD_TEST_DURATION_S ?? '30', 10);
const MAX_P99_MS = Number.parseInt(process.env.LOAD_TEST_MAX_P99_MS ?? '2000', 10);
const MAX_ERROR_RATE = Number.parseFloat(process.env.LOAD_TEST_MAX_ERROR_RATE ?? '0.01');

function printSummary(label: string, result: Result): void {
  const total = result.requests.total;
  const errors = result.non2xx + result.errors;
  const errorRate = total > 0 ? errors / total : 0;

  process.stdout.write(`\n--- ${label} ---\n`);
  process.stdout.write(`  requests:      ${total} (${result.requests.average.toFixed(1)}/s average)\n`);
  process.stdout.write(
    `  latency (ms):  p50=${result.latency.p50} p95=${result.latency.p97_5} p99=${result.latency.p99} max=${result.latency.max}\n`,
  );
  process.stdout.write(`  errors:        ${errors} non-2xx/connection errors (${(errorRate * 100).toFixed(2)}%)\n`);
}

async function runScenario(label: string, path: string, body?: Record<string, unknown>): Promise<Result> {
  return autocannon({
    url: `${TARGET_URL}${path}`,
    connections: CONNECTIONS,
    duration: DURATION_S,
    method: body ? 'POST' : 'GET',
    headers: {
      'x-api-key': API_KEY,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    title: label,
  });
}

async function main(): Promise<void> {
  if (!CATALOG_SLUG) {
    logger.fatal(
      'LOAD_TEST_CATALOG_SLUG is required - set it to a catalog slug already ingested into this database (npm run ingest) before running a load test against the chat endpoint.',
    );
    process.exit(1);
  }

  logger.info(
    { targetUrl: TARGET_URL, connections: CONNECTIONS, durationS: DURATION_S, catalogSlug: CATALOG_SLUG },
    'Starting load test',
  );

  const healthResult = await runScenario('GET /healthz', '/healthz');
  printSummary('GET /healthz', healthResult);

  const chatResult = await runScenario('POST /v1/catalogs/:slug/chat', `/v1/catalogs/${CATALOG_SLUG}/chat`, {
    query: 'what products are on sale',
    languageCode: 'en',
  });
  printSummary('POST /v1/catalogs/:slug/chat', chatResult);

  const chatTotal = chatResult.requests.total;
  const chatErrors = chatResult.non2xx + chatResult.errors;
  const chatErrorRate = chatTotal > 0 ? chatErrors / chatTotal : 1;
  const chatP99 = chatResult.latency.p99;

  process.stdout.write('\n--- verdict ---\n');
  let failed = false;
  if (chatP99 > MAX_P99_MS) {
    process.stdout.write(`  FAIL: chat p99 latency ${chatP99}ms exceeds threshold ${MAX_P99_MS}ms\n`);
    failed = true;
  }
  if (chatErrorRate > MAX_ERROR_RATE) {
    process.stdout.write(
      `  FAIL: chat error rate ${(chatErrorRate * 100).toFixed(2)}% exceeds threshold ${(MAX_ERROR_RATE * 100).toFixed(2)}%\n`,
    );
    failed = true;
  }
  if (!failed) {
    process.stdout.write('  PASS: within latency and error-rate thresholds\n');
  }

  process.exit(failed ? 1 : 0);
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Load test run failed');
  process.exit(1);
});
