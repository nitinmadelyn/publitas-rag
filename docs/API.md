# API reference

Base URL: wherever the service is deployed (e.g.
`https://<your-app>.onrender.com` for the demo stack in
`docs/DEPLOYMENT.md`, or `http://localhost:3000` locally).

## Authentication

Every route except `/healthz`, `/readyz`, and `/widget/*` requires an
`x-api-key` header matching one of the comma-separated values in the
`API_KEYS` environment variable:

```
x-api-key: <your-api-key>
```

Missing or non-matching key → `401 unauthorized`. This is a single
shared-secret tier (every accepted key can query every catalog); see
`docs/SCALING.md` for the per-tenant key design this would need before
being used by multiple independent customers.

## Rate limiting

Requests are rate-limited per `x-api-key` (falling back to client IP for
unauthenticated routes), configured via `RATE_LIMIT_MAX` and
`RATE_LIMIT_WINDOW_MS` (defaults: 60 requests / 60 seconds). Exceeding it
returns `429`. See `docs/TESTING.md` for verified behavior under
concurrent bursts and the multi-instance caveat.

## Errors

Every error response has the same shape:

```json
{ "error": { "code": "string", "message": "human-readable string" } }
```

| HTTP status | `error.code` | Meaning |
|---|---|---|
| 400 | `validation_error` | Request body failed schema validation (see per-endpoint field rules below) |
| 400 | `invalid_request` | Request was well-formed but semantically invalid |
| 400 | `bad_request` | A 4xx surfaced directly from Fastify itself (e.g. malformed JSON, unsupported content-type) |
| 401 | `unauthorized` | Missing or invalid `x-api-key` |
| 404 | `catalog_not_found` | `:slug` doesn't match any ingested catalog |
| 404 | `not_found` | No route matches the request |
| 413 | (Fastify default) | Request body exceeds the 1 MiB limit |
| 429 | (rate-limit plugin default) | Rate limit exceeded |
| 500 | `internal_error` | Unexpected failure - upstream auth/config problems, a database error, or anything unmapped. The underlying error is logged server-side in full; the client never sees internal details (connection strings, stack traces, provider error bodies) |
| 503 | `upstream_unavailable` | OpenAI or Anthropic failed after exhausting retries |

## `GET /healthz`

Liveness only - the process is up and can respond. Does not touch the
database. No auth required. Used as the container `HEALTHCHECK` and the
platform's health check path (see `docs/DEPLOYMENT.md`).

**Response `200`:**
```json
{ "status": "ok" }
```

## `GET /readyz`

Readiness - the process is up *and* the database is reachable. No auth
required.

**Response `200`:**
```json
{ "status": "ready" }
```

**Response `503`** (database unreachable):
```json
{ "status": "unavailable", "reason": "database" }
```

## `POST /v1/catalogs/:slug/chat`

The main RAG endpoint: retrieves grounding chunks for `query` and
returns a cited, generated answer (or a canned "not found" answer when
nothing relevant exists in the catalog - see
`docs/ARCHITECTURE.md`'s "no context found" design note).

**Path parameters:**

| Name | Type | Rules |
|---|---|---|
| `slug` | string | 1-200 chars |

**Request body:**

| Field | Type | Rules |
|---|---|---|
| `query` | string | trimmed, 1-2000 chars |
| `languageCode` | string | matches `^[a-z]{2}(-[A-Z]{2})?$`, e.g. `en`, `pt`, `es-MX` |

```bash
curl -X POST https://<host>/v1/catalogs/color_street/chat \
  -H "x-api-key: <key>" \
  -H "content-type: application/json" \
  -d '{"query":"how much is the amethyst bowl?","languageCode":"en"}'
```

**Response `200`:**
```json
{
  "answer": "The Amethyst Bowl is $24.99 [1].",
  "citations": [
    {
      "index": 1,
      "chunkId": 42,
      "publicUrl": "https://view.publitas.com/<group>/<pub>/page/7",
      "pageNumber": 7,
      "productRef": "SKU-1234"
    }
  ],
  "noContextFound": false
}
```

- `citations` only lists chunks the model's answer actually cites (by
  `[N]` marker), not every chunk retrieval found - see
  `generation/prompt.ts`'s `extractCitedChunks`.
- `noContextFound: true` means retrieval found nothing above the
  relevance threshold; `answer` is then a canned, per-language response
  and `citations` is always `[]`. Claude was never called for this
  request (see `docs/ARCHITECTURE.md`).

## `POST /v1/catalogs/:slug/search`

Raw retrieval results, no generation step - same request shape as
`/chat`, useful for debugging retrieval quality independent of the LLM
(this is what `npm run search` calls locally).

**Response `200`:**
```json
{
  "results": [
    {
      "chunkId": 42,
      "pageId": 7,
      "catalogId": 1,
      "chunkIndex": 0,
      "text": "Amethyst Bowl (24.99)",
      "productRef": "SKU-1234",
      "languageCode": "en",
      "pageNumber": 7,
      "publicUrl": "https://view.publitas.com/<group>/<pub>/page/7",
      "score": 0.91,
      "matchType": "vector"
    }
  ]
}
```

`matchType` is `"vector"`, `"lexical"`, or `"hybrid"` (found by both) -
see `docs/ARCHITECTURE.md` for how these are merged and ranked.

## `GET /widget/widget.js`

Serves the built embeddable widget bundle. No auth required (it's meant
to be loaded by arbitrary public catalog pages). 404s if the bundle
hasn't been built (`npm run widget:build`) - see `web/widget/README.md`
for the widget's own configuration and embed snippet.
