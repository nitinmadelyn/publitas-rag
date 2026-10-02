# What I'd change for real production scale

This project is scoped and built as a working demo, not a system
serving millions of B2B end users. Everything in this document is a
deliberate "not done here, and here's exactly why and how" - the gap
between "correct and well-tested at demo scale" and "ready for real
production traffic." Ordered roughly by what would bite first as usage
grows.

## 1. Multi-tenancy and API keys

**Now:** a single shared-secret tier (`API_KEYS`, a comma-separated env
var) - every accepted key can query every catalog (`src/api/auth.ts`).
Fine for one team's own demo/internal use; wrong for multiple
independent B2B customers sharing one deployment.

**At scale:** move API keys into the database (a `tenants`/`api_keys`
table, hashed at rest like a password), scope each key to a specific set
of catalog slugs it's allowed to query, and add per-tenant usage
tracking (request counts, token spend) for billing and abuse detection.
The auth hook's interface (`ApiKeyAuthOptions`) already isolates this
concern to one file - swapping the lookup from an in-memory `Set` to a
DB/cache-backed lookup touches `src/api/auth.ts` and its wiring in
`server.ts`, not the route handlers.

## 2. Rate limiting: shared store, per-tenant quotas

**Now:** `@fastify/rate-limit` with its default in-memory store - see
`docs/TESTING.md` for the exact, empirically-verified behavior. Two real
gaps: the store is per-process (an N-instance deployment enforces
`N x RATE_LIMIT_MAX`, not the configured limit), and every tenant shares
one global quota.

**At scale:** swap to `@fastify/rate-limit`'s Redis store (a small
config change, the plugin supports it natively) so the limit is
enforced globally across every instance, and key quotas by tenant ID
rather than raw API key so a single customer can be given a different
limit tier (free/paid) without a code change.

## 3. Database: connection limits, read scaling, index tuning

**Now:** a single `pg.Pool` (`DATABASE_POOL_MAX`, default 10) against
one Postgres instance, sized for one API instance under moderate load
(see `docs/TESTING.md`'s connection pool sizing note).

**At scale:**
- **Connection limits.** Every Postgres instance has a hard max
  connections; N horizontally-scaled API instances each holding a pool
  of `DATABASE_POOL_MAX` will exhaust it quickly. Put **PgBouncer** (or
  a managed pooler, e.g. Supabase's own pooler, RDS Proxy) in front of
  Postgres in transaction-pooling mode, and size each instance's own
  pool much smaller (2-5) since the pooler is now doing the real
  multiplexing.
- **Read scaling.** Retrieval (`vectorSearch`/`lexicalSearch`) is
  read-only and is the overwhelming majority of query volume. A read
  replica (or several, behind a round-robin/least-connections router)
  taking retrieval traffic off the primary, which then only handles
  ingestion/embedding writes and the occasional chat-path insert (none
  currently - chat is fully read-only against `chunks`), is the highest-
  leverage single change once read load actually matters.
- **HNSW index tuning.** `001_init.sql`'s HNSW index uses default
  build/search parameters. At real data volume (many catalogs, many
  thousands of chunks each), `m` and `ef_construction` at build time and
  `hnsw.ef_search` at query time trade off recall against latency and
  are worth tuning against real query patterns rather than left at
  pgvector's defaults - the load test harness (`docs/TESTING.md`) is the
  right tool to measure that trade-off before changing it.
- **Managed Postgres.** Supabase's free tier (`docs/DEPLOYMENT.md`) is a
  demo choice. A real deployment wants a managed Postgres with
  point-in-time recovery, automated backups, and a support SLA (RDS,
  Cloud SQL, a paid Supabase/Neon tier) - and pgvector must be confirmed
  supported on whatever tier is chosen before committing to it.

## 4. Caching

**Now:** none. Every chat request re-embeds the query (one OpenAI call)
and re-runs retrieval, even for a question asked seconds ago by a
different shopper on the same catalog.

**At scale, two layers worth adding, in order of impact:**
- **Query embedding cache** (Redis, keyed on a hash of `query +
  languageCode`, short TTL): the embedding step is pure and
  deterministic for the same input, so this is a safe, easy win that
  directly cuts OpenAI cost and per-request latency for repeated/common
  questions ("how do I contact support", "what's on sale") without
  touching retrieval or generation logic at all.
- **Full answer cache** (same key shape, longer TTL, invalidated on
  re-ingest of that catalog): higher risk (a stale answer after a price
  change until the TTL/invalidation fires) but the highest-leverage cost
  cut, since it also skips the Claude call. Would need explicit
  invalidation wired into `ingest-publication.ts`'s "content changed"
  path, not just a TTL, to avoid serving a stale price after a catalog
  update.

## 5. Horizontal scaling and statelessness

**Now:** the service is already stateless by design - no in-process
session state, no sticky-session requirement, the only per-process state
is the rate limiter's in-memory counters and the Postgres pool (both
addressed above). This means horizontal scaling is mostly "add
instances behind a load balancer" once the rate-limit store and
connection pooling above are in place, not a redesign.

**At scale:** run N instances behind a load balancer with autoscaling
on CPU/request-rate, `trustProxy: true` (already set in `server.ts`) so
rate limiting and access logs see real client IPs through the LB, and
graceful shutdown (already implemented in `index.ts` - `server.close()`
drains in-flight requests before exiting) so a rolling deploy or
scale-down never cuts off an in-progress chat request.

## 6. Ingestion and embedding at scale

**Now:** `npm run ingest` and `npm run embed` are operator-triggered CLI
scripts, run manually or on a schedule outside the API service.

**At scale:**
- **Trigger on change, not on a timer.** If Publitas exposes a webhook
  for "publication updated," ingestion should react to that instead of
  polling on a schedule - lower latency for content updates, less wasted
  work re-checking unchanged publications (though the content-hash skip
  already makes an unnecessary poll cheap, not free).
- **Move off a blocking CLI script onto a job queue** (BullMQ/SQS +
  workers) once ingestion volume means a single script run takes
  meaningfully long or needs to be retried/observed like any other
  production job - retries, dead-letter handling, and per-publication
  progress visibility come for free with a queue and have to be
  hand-rolled in a CLI script.
- **Scale ingestion/embedding independently from the API.** These are
  bursty, throughput-oriented, and CPU/network-bound in a different way
  than the low-latency read-serving API path; once either needs its own
  scaling policy, this is the natural seam to split into a separate
  worker service - the module boundary (`src/ingestion`, `src/embeddings`)
  already exists for exactly this reason (see `docs/ARCHITECTURE.md`,
  "single deployable service, not microservices").

## 7. Observability

**Now:** structured JSON logs (`pino`) with request/response logging and
slow-query detection (`>500ms`, `src/db/client.ts`), but no metrics, no
tracing, no alerting - logs are the only signal, and only as good as
whoever is watching them.

**At scale:**
- **Metrics**: request rate, latency percentiles, and error rate per
  route (the load test harness's own output format is a reasonable
  starting shape); retrieval-specific metrics worth tracking separately
  since they're the actual product quality signal - `noContextFound`
  rate per catalog (a rising rate suggests either genuinely unanswerable
  questions or a retrieval regression) and the vector/lexical/hybrid
  match-type distribution.
- **Tracing** (OpenTelemetry): a chat request fans out to three external
  calls (embedding, two retrieval queries, Claude) - without tracing,
  diagnosing "why is this one request slow" means correlating log lines
  by `requestId` by hand.
- **Alerting** on the health-check failing, error rate crossing a
  threshold, and Claude/OpenAI `503` rate spiking (an upstream outage,
  visible in the resilience-test-verified error path but currently
  silent in production beyond a log line).

## 8. Cost controls

**Now:** no per-tenant spend tracking or budget enforcement; the only
cost lever is the "skip Claude when no context found" design (already
in place, see `docs/ARCHITECTURE.md`) and the load-test harness's
deliberate avoidance of hitting paid APIs during testing.

**At scale:** track token usage (Claude) and embedding calls per tenant
alongside the multi-tenancy work in item 1, so spend is attributable and
a runaway/abusive tenant can be throttled or billed accurately rather
than silently costing the whole deployment.

## 9. CI/CD

**Now:** verification (`typecheck`, `lint`, `test`, `build`) is run
manually before every change is considered done - real discipline, but
enforced by convention, not by a pipeline.

**At scale:** a GitHub Actions workflow running the exact commands in
`docs/DEPLOYMENT.md`'s "Verification commands" on every PR, a required-
checks branch protection rule, and a staging environment (a second
Render/Supabase pair, or equivalent) that deploys automatically on merge
to `main` before a manual promote to production.

## 10. Full-page text coverage (OCR)

Covered in depth in `docs/ARCHITECTURE.md`'s "Retrieval scope" section -
repeated here only to flag it as a scale/scope decision, not a bug: it's
a new external dependency, added ingestion cost and latency per page,
and its own failure modes to test, so it belongs in its own phase with
its own load-testing pass, not bolted on to any of the above.
