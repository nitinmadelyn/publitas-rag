# Testing

## Philosophy and conventions

Three layers, applied consistently across every module in `src/`:

- **Pure/logic functions always get direct unit tests.** Chunking,
  merging search results, prompt building, citation extraction, config
  parsing, language detection - anything with no I/O is tested as a pure
  function against concrete inputs/outputs.
- **I/O-touching modules use dependency injection, tested with fakes.**
  Every module that talks to Postgres, OpenAI, Anthropic, or the
  Publitas API is defined behind a small interface (see
  `docs/ARCHITECTURE.md`'s DI table) with a real production
  implementation and a fake used in tests. No live network call or real
  database is required to run `npm test`.
- **CLI scripts and DOM-composition modules are not directly unit
  tested.** `src/scripts/*.ts` and `web/widget/src/{ui,widget}.ts` are
  thin composition roots over already-tested logic; testing them would
  mean re-verifying wiring, not behavior. They're verified by running
  them (see each phase's manual verification notes) rather than a unit
  test suite.

```bash
npm test              # full suite (server + widget), one command
npm run test:coverage # with coverage
npm run test:watch    # watch mode
```

As of the current commit: **346 tests across 26 files**, plus `npm run
typecheck`, `npm run widget:typecheck`, and `npm run lint` all clean.

## Concurrency and resilience (`test/resilience.test.ts`)

On top of correctness tests, a dedicated suite exercises behavior under
genuine concurrency and induced failure - the two things a
request-at-a-time test suite structurally cannot catch. It fires real
concurrent bursts (`Promise.all`, not sequential `await`-in-a-loop) at
the actual Fastify app via `.inject()`, with fake dependencies:

- The rate limiter never admits more than its configured `max` per
  window, even under a true same-tick burst.
- The rate limit is correctly scoped per API key (one tenant's traffic
  cannot exhaust another's quota).
- Slow downstream calls run concurrently, not serialized - proven by
  wall clock: 20 requests behind a 100ms simulated delay complete in
  ~100ms total, not ~2000ms.
- A burst of concurrent requests against different catalogs never leaks
  one request's data into another's response.
- An upstream (Claude) outage produces a clean `503` for every affected
  concurrent request - no hang, no crash, no unhandled rejection - and
  the server serves healthy requests again immediately once the outage
  clears.
- A database failure produces a clean `500` with a generic message; the
  real Postgres error text (which can contain connection details) never
  reaches the client.
- Oversized (`>1MiB`) and malformed-JSON request bodies are rejected
  cleanly under concurrent load without affecting sibling requests or
  destabilizing the server.

**Real finding worth knowing before scaling this past one instance:**
`@fastify/rate-limit`'s default in-memory store does not guarantee
first-come-first-served admission when every request in a burst lands in
the exact same event-loop tick - the whole burst can be admitted or the
whole burst rejected together, rather than exactly `max` of them getting
through. It never *over*-admits (the safety property that actually
matters), but the granularity is coarser than "first N win" under a
perfectly synchronized burst. More importantly, this store is
**per-process and in-memory**: running more than one instance of this
service behind a load balancer means each instance enforces its own
independent limit, so the *effective* combined limit across N instances
is `N x RATE_LIMIT_MAX`, not `RATE_LIMIT_MAX`. Before running multiple
instances in production, swap in `@fastify/rate-limit`'s Redis store
option so the limit is enforced globally - see `docs/SCALING.md`.

## Load test harness (`npm run loadtest:server` + `npm run loadtest`)

For measuring actual throughput/latency against a real Postgres instance
under sustained concurrent load:

```bash
npm run db:up
npm run ingest -- --group <group-slug>       # if not already ingested
npm run embed
npm run loadtest:server &                    # starts on :3100
LOAD_TEST_CATALOG_SLUG=<a-real-ingested-slug> npm run loadtest
```

`loadtest:server` boots the real application (real routes, real
validation, real rate limiter, real Postgres-backed retrieval) but
replaces the two paid, rate-limited external calls - OpenAI embeddings
and Anthropic completion - with fast, deterministic, in-process fakes
(`src/scripts/load-test-server.ts`). This is a deliberate choice, not a
shortcut: a load test's job here is to find out whether *this service's*
own stack (connection pool, event loop, rate limiter, Fastify overhead)
holds up under concurrency, and running it against the real upstreams
would mostly measure their latency and rate limits instead, at real
dollar cost. The fakes' simulated latency and failure rate are
configurable (`LOAD_TEST_CLAUDE_LATENCY_MS`,
`LOAD_TEST_CLAUDE_FAILURE_RATE`) so a run can also inject upstream
slowness/failures while under load.

`loadtest` (`src/scripts/load-test.ts`) drives it with `autocannon`,
reports p50/p95/p99 latency and error rate for both `GET /healthz` and
`POST /v1/catalogs/:slug/chat`, and exits non-zero if p99 latency or
error rate exceed configurable thresholds (`LOAD_TEST_MAX_P99_MS`,
`LOAD_TEST_MAX_ERROR_RATE`) - suitable as a CI gate, not just a manual
check. Full option list is documented in each script's file header.

`autocannon` and its type definitions are dev-only dependencies (never
shipped to production); `npm audit --omit=dev` reports zero
vulnerabilities in the production dependency tree.

## Connection pool sizing

`DATABASE_POOL_MAX` defaults to 10 (`src/config/index.ts`). This is a
starting point for a single instance under moderate load, not a number
verified against a specific target throughput - use the load test
harness above, with `DATABASE_POOL_MAX` set to candidate values, to find
where retrieval latency starts climbing under your actual expected
concurrency before deploying, and re-check after any change to
`RETRIEVAL_TOP_K` or `RETRIEVAL_LEXICAL_LIMIT` (both affect how much work
each request asks Postgres to do).
