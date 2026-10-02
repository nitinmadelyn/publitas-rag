# publitas-rag

RAG chat over Publitas digital catalogs. Answers only from retrieved catalog
content, cites the source page, and refuses gracefully when nothing relevant
is found.

Built as a production-shaped reference implementation: typed end to end,
validated at every external boundary, tested for correctness and for
behavior under concurrent load, and deployable on a free-tier stack for a
live demo.

## What's here

```
src/
  types/          Zod schemas for the Publitas API and internal domain types
  lib/             HTTP client, bounded concurrency, shared utilities
  ingestion/       Publitas API client, page mapping, text extraction, upserts
  embeddings/      OpenAI embedding client
  retrieval/       Hybrid (vector + lexical) search over pgvector/Postgres
  generation/      Claude client, prompt construction, citation extraction
  api/             Fastify server: routes, auth, rate limiting, error mapping
  db/               Migrations and connection pool
  scripts/         CLI entry points (ingest, embed, chat, load test)
web/widget/        Embeddable chat widget (vanilla TS, no framework)
test/               Unit, integration, and resilience tests (vitest)
docs/               Architecture, API reference, testing, deployment, scaling
```

## Quickstart

```bash
npm install
cp .env.example .env
# edit .env: set a real OPENAI_API_KEY and CLAUDE_API_KEY at minimum

npm run db:up            # Postgres + pgvector via docker compose
npm run db:migrate

npm run ingest <group-slug>   # pull a catalog from the Publitas API
npm run embed                  # embed its chunks

npm run dev                    # start the API on :3000
```

```bash
curl -X POST http://localhost:3000/v1/catalogs/<slug>/chat \
  -H "x-api-key: dev-local-key-change-me" \
  -H "content-type: application/json" \
  -d '{"query":"any discount going on currently?","languageCode":"en"}'
```

Full local-dev, verification, and container-build instructions are in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Documentation

| Doc | Covers |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System diagram, data flows, design decisions, DI pattern |
| [`docs/API.md`](docs/API.md) | REST endpoints, auth, rate limits, error codes |
| [`docs/TESTING.md`](docs/TESTING.md) | Testing philosophy, concurrency/resilience findings, load test harness |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Local dev, verification commands, Docker, Supabase + Render demo deploy |
| [`docs/SCALING.md`](docs/SCALING.md) | What changes at real production scale (multi-tenancy, caching, horizontal scaling, OCR, etc.) |

## Notable scope decision

Retrieval currently covers only the *hotspot* layer of a publication
(product titles, prices, descriptions, link/page-reference/video titles),
not the printed text on a catalog page image, since Publitas' API does not
expose that text and this system has no OCR stage. This is a deliberate,
documented scope boundary, not a bug: see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#retrieval-scope-hotspot-data-only-not-full-catalog-page-text)
for why, what it means in practice, and what adding full-page coverage
would require.

## License

Portfolio/reference project, not an official Publitas repository.
