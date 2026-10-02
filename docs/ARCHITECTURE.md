# Architecture

This document explains how the pieces fit together, the two data flows
(ingestion and chat), and the design decisions worth understanding before
extending this codebase. If you only read one doc before touching the
code, read this one.

## System overview

```
                          ┌─────────────────────────────┐
                          │        Publitas API          │
                          │  (publications, hotspots,     │
                          │   products - source of truth) │
                          └──────────────┬────────────────┘
                                         │ npm run ingest
                                         ▼
┌──────────────┐   npm run embed   ┌───────────────────────────┐
│  OpenAI       │◄──────────────────│  Postgres (pgvector)       │
│  Embeddings   │──────────────────►│  catalogs / publications /  │
│  API          │  vectors written  │  pages / chunks              │
└──────────────┘                   └──────────┬────────────────┘
                                                │ retrieval (vector +
                                                │ lexical hybrid search)
                                                ▼
┌──────────────┐   generateAnswer()   ┌───────────────────────────┐
│  Anthropic    │◄─────────────────────│  Fastify API (src/api/)   │
│  Claude API   │──────────────────────►│  /v1/catalogs/:slug/chat  │
└──────────────┘   cited answer text   │  /v1/catalogs/:slug/search │
                                        │  /healthz /readyz          │
                                        │  /widget/widget.js         │
                                        └──────────┬────────────────┘
                                                    │ HTTPS (x-api-key)
                                                    ▼
                                        ┌───────────────────────────┐
                                        │  Embeddable widget          │
                                        │  (Shadow DOM, one script    │
                                        │   tag, any catalog page)    │
                                        └───────────────────────────┘
```

One deployable Node/TypeScript service (`src/`) plus one static widget
bundle (`web/widget/`), backed by a single Postgres database with the
`pgvector` extension. No separate microservices, no message queue, no
cache layer - see "Single deployable service" below for why, and
`docs/SCALING.md` for when that stops being true.

## Repository layout

| Path | What lives here |
|---|---|
| `src/ingestion/` | Pulls publications/hotspots/products from the Publitas API, extracts retrievable text, upserts into Postgres |
| `src/embeddings/` | Batches un-embedded chunks, calls OpenAI, writes vectors back |
| `src/retrieval/` | Hybrid vector + lexical search against `chunks`, merges and ranks results |
| `src/generation/` | Builds the grounding prompt, calls Claude, extracts citations from the answer |
| `src/api/` | Fastify app: routes, auth, rate limiting, error mapping, request validation |
| `src/db/` | Connection pool, migration runner, `migrations/*.sql` |
| `src/config/` | Single `zod`-validated environment schema, fails fast on startup |
| `src/lib/` | Cross-cutting utilities (HTTP client with retry/backoff, logger, concurrency helper, hashing) |
| `src/scripts/` | CLI entrypoints (`ingest`, `embed`, `search`, `chat`, `load-test`, `load-test-server`) |
| `web/widget/` | The embeddable chat widget - its own `src/`, `test/`, build (`esbuild`), and `tsconfig.json` |
| `test/` | Server-side unit/integration tests (one file per module, plus `api-server.test.ts` and `resilience.test.ts` for the HTTP layer) |
| `docs/` | This documentation set |

## Data flow 1: ingestion (offline, operator-triggered)

1. `npm run ingest <group-slug>` (`src/scripts/ingest.ts`) lists every
   publication in a Publitas group, then ingests each one
   (`ingest-publication.ts`).
2. For each publication: fetch its detail (spreads + hotspots), map
   spreads to individual pages (`page-mapper.ts` - hotspots are
   spread-level in the API, split by `position.left < 0.5` for two-page
   spreads), resolve every referenced product hotspot to its title/price/
   description via the Products endpoint (bounded concurrency, see
   `lib/concurrency.ts`), then build one retrievable chunk per product
   hotspot plus one combined chunk for other hotspot types
   (`text-extractor.ts`). See "Retrieval scope" below for exactly what
   text this does and doesn't cover.
3. Everything for one publication (catalog/publication/pages/chunks) is
   upserted in a single transaction, keyed on a content hash so an
   unchanged publication is skipped entirely on re-ingest
   (`catalog-repository.ts`). A broken publication within a group never
   aborts the rest of the group (`ingest-group.ts`).
4. `npm run embed` (`src/scripts/embed.ts`) finds chunks with no
   embedding yet, batches them by count and total character size
   (`embeddings/batcher.ts` - a proxy for OpenAI's per-request token
   ceiling), calls OpenAI with bounded concurrency and retry/backoff,
   and writes `vector(1536)` values back to `chunks.embedding`.

Both scripts are idempotent and safe to re-run: ingestion skips
unchanged publications via the content hash, embedding only processes
chunks that don't have a vector yet.

## Data flow 2: a chat request (online, per HTTP request)

`POST /v1/catalogs/:slug/chat` (`src/api/routes/chat.ts` →
`src/generation/generate-answer.ts`):

1. Validate the request body (`query`, `languageCode`) with `zod`
   (`api/schemas.ts`) - a malformed request never reaches business logic.
2. Resolve `:slug` to a `catalog_id`; unknown slug → `404`.
3. Embed the query text (one OpenAI call) and run retrieval:
   - **Vector search**: `ORDER BY embedding <=> $query_vector` against an
     HNSW index, filtered by `catalog_id` and `language_code` (same-
     language only - see "Multilingual" below).
   - **Lexical fallback**: a `pg_trgm` similarity search over
     `chunks.text`, for exact-match signal (a SKU, a model number, a
     brand name) that a semantic embedding can under-rank.
   - Results are merged and deduplicated (`retrieve.ts`,
     `mergeSearchResults`): a chunk found by both becomes `hybrid` and
     keeps the higher score; the relevance threshold applies only to
     vector-only matches, since a lexical hit is exact-match evidence on
     its own even at a lower raw trigram score.
4. **Zero grounding chunks found → skip Claude entirely.** A canned,
   per-language "I don't have that information" answer is returned
   immediately (`generate-answer.ts`, `NO_CONTEXT_ANSWERS`). This is a
   deliberate anti-hallucination and cost-control decision: never let the
   model improvise past what retrieval actually found, and never pay for
   a Claude call that's about to be told "no context available" anyway.
5. Otherwise, build a system + user prompt with the retrieved chunks as
   numbered, citable context (`generation/prompt.ts`), call Claude, and
   extract which chunks the model actually cited from its answer text
   (`extractCitedChunks`) so the response's `citations` array only lists
   sources the model actually used, not everything retrieval found.
6. Return `{ answer, citations, noContextFound }`.

Every upstream call in this path (embedding, Claude, Postgres) goes
through the same dependency-injection seam
(`ServerDependencies` in `api/types.ts`), which is what makes the whole
path testable with fakes (`test/api-server.test.ts`,
`test/resilience.test.ts`) and reusable, unmodified, as the load test
harness (`docs/TESTING.md`).

## Design decisions worth knowing before extending this

- **Single deployable service, not microservices.** Ingestion,
  embedding, retrieval, and chat live in one codebase with clear module
  boundaries (`src/ingestion`, `src/embeddings`, `src/retrieval`,
  `src/generation`). Splitting into separate services is not warranted
  at this project's actual scale - see `docs/SCALING.md` for exactly
  when and how that changes.
- **Embedding dimension is a one-way door.** `chunks.embedding` is
  `vector(1536)`, matching `EMBEDDING_DIMENSIONS` in config. pgvector
  cannot alter a column's dimension in place. Changing embedding models
  to a different dimension requires a new migration that drops and
  recreates the column and its index, plus a full re-embed of every
  existing chunk. Documented directly in `001_init.sql`.
- **Multilingual, same-language retrieval only.** Every catalog and
  every chunk carries a `language_code`; retrieval filters by it rather
  than searching across languages. This was an explicit decision:
  cross-lingual retrieval (e.g. an English query matching a French
  chunk) needs its own relevance validation before it can be trusted,
  and was scoped out as a stretch goal, not missed.
- **Config validation is fail-fast and testable.** `parseEnv()`
  (`src/config/index.ts`) is a pure function with no `process.exit`,
  fully unit tested. Only the real startup path (the module-level
  singleton) wraps it with exit-on-failure, so tests never risk killing
  the test runner process.
- **No context found → skip the LLM call.** Covered in the chat request
  flow above; repeated here because it's the single most important
  correctness property of the whole system (no hallucinated answers).

## Retrieval scope: hotspot data only, not full catalog page text

**This is a deliberate scope decision, not a bug or an oversight.** The
system answers questions using only the *hotspot* layer of a Publitas
publication - product titles, prices, descriptions, and the titles of
link/page-reference/video hotspots - never the raw printed text visible
on a catalog page.

**Why:** Publitas' publication API
(`GET /v1/groups/:slug/publications/:pubSlug.json`) returns each catalog
page as a raster image (`spreads[].pages`, relative image file paths),
not as text. The only *structured, machine-readable* text the API
exposes is the hotspot layer, fetched per-product via the separate
Products endpoint. There is no OCR step anywhere in this pipeline
(`src/ingestion/text-extractor.ts`, `buildPageChunks`) to extract the
printed copy off those page images, so that text is simply not part of
the retrieval corpus.

**What this means in practice:** a question like "what's the price of
the amethyst bowl?" works well, because price/title/description are
hotspot fields. A question like "how do I download the app?" or
anything answerable only from promotional copy printed directly on a
page graphic (a footer line, a QR code caption, a headline banner) will
correctly return "I don't have that information" (`noContextFound:
true`) rather than a hallucinated guess, because that text was never
extracted or embedded in the first place. This was verified directly
during Phase 6 testing and is the expected, correct behavior for the
system as scoped, not a retrieval failure to debug.

**If full-page text coverage becomes a requirement:** the real fix is
adding an OCR stage (e.g. Textract, Google Vision, or Tesseract) over
`spreads[].pages` during ingestion, chunking the extracted text
alongside the existing hotspot chunks, and tagging chunks with a
`chunk_type` (`hotspot` vs. `page_text`) so retrieval and citations can
distinguish "from a product tag" from "from page copy." That is a
meaningful scope addition - a new external dependency, added cost and
latency per page ingested, and new failure modes to test - and should
be scoped as its own phase rather than added incidentally.

## Dependency injection pattern used throughout

Every module that talks to something external (Postgres, OpenAI,
Anthropic, the Publitas API) is defined behind a small interface with a
`defaultXxx` production implementation and a `FakeXxx`/inline fake used
in tests:

| Interface | Production implementation | Used by |
|---|---|---|
| `RetrievalRepository` | `defaultRetrievalRepository` (real SQL) | retrieval, chat/search routes |
| `EmbeddingClientLike` | `OpenAIEmbeddingClient` | retrieval, embedding pipeline |
| `ClaudeClientLike` | `ClaudeClient` | generation |
| `ServerDependencies` | `defaultDependencies()` in `api/server.ts` | every route handler |

This is what makes `buildServer(options)` the single source of truth for
both production wiring (`await buildServer()`, no arguments, every
default is config-backed) and every test/load-test variant (pass fakes
for `dependencies`) - there is no separate, parallel "test server"
implementation to keep in sync.
