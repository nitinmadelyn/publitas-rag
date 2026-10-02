# Deployment

## Demo deployment: Supabase + Render, free tier

This is the cheapest viable stack for a live demo link, not a
production-scale deployment - see `docs/SCALING.md` for what changes at
real scale (managed Postgres with real connection limits, a shared
rate-limit store, multiple instances, etc.).

### 1. Database: Supabase (free tier)

1. Create a project at [supabase.com](https://supabase.com) (no credit
   card required on the free tier).
2. Project Settings -> Database -> Connection string -> URI. Use the
   **Transaction pooler** connection string (port 6543), not the direct
   connection - this service opens many short-lived connections per
   request cycle, which is exactly what the pooler exists for, and the
   free tier's direct-connection limit is low.
3. That connection string is `DATABASE_URL`. It already includes
   `?sslmode=require` - Supabase requires TLS, and `pg`'s pool honors
   that from the connection string with no extra config needed.
4. Nothing else to set up by hand: `CREATE EXTENSION IF NOT EXISTS
   vector;` and `pg_trgm` are the first two lines of
   `src/db/migrations/001_init.sql`, and the Dockerfile's `CMD` runs
   migrations automatically on every container start (see the
   Dockerfile's comments). If your Supabase plan's role lacks
   `CREATE EXTENSION` privilege, enable `vector` manually first under
   Database -> Extensions in the dashboard, then redeploy.

### 2. API service: Render (free tier)

1. Push this repo to GitHub.
2. In the Render dashboard: **New +** -> **Blueprint**, point it at the
   repo. Render reads `render.yaml` (repo root) and creates the service
   from the project's `Dockerfile`.
3. Fill in the secrets Render prompts for (everything marked
   `sync: false` in `render.yaml`): `DATABASE_URL` (from step 1),
   `OPENAI_API_KEY`, `CLAUDE_API_KEY`, and `API_KEYS` (generate real
   random key(s) for this deployment - do not reuse the local
   `dev-local-key-change-me` default).
4. Deploy. Render builds the Docker image, starts the container, and
   polls `healthCheckPath: /healthz` (set in `render.yaml`) before
   routing traffic to it.
5. Before the chat endpoint returns anything useful, ingest at least one
   catalog against this database: run `npm run ingest` and `npm run
   embed` locally with `DATABASE_URL` pointed at the same Supabase
   connection string (a one-time local step against the remote DB - no
   need to run ingestion inside the deployed container).

### 3. Verifying the deployment

```bash
curl https://<your-app>.onrender.com/healthz   # {"status":"ok"}
curl https://<your-app>.onrender.com/readyz    # {"status":"ready"} once DB is reachable
curl -X POST https://<your-app>.onrender.com/v1/catalogs/<slug>/chat \
  -H "x-api-key: <your API_KEYS value>" \
  -H "content-type: application/json" \
  -d '{"query":"any discount going on currently?","languageCode":"en"}'
```

The embeddable widget bundle is served from this same service (no
separate static host needed), so an embed snippet on any page becomes:

```html
<script
  src="https://<your-app>.onrender.com/widget/widget.js"
  data-api-base-url="https://<your-app>.onrender.com"
  data-api-key="<your API_KEYS value>"
  data-catalog="<slug>"
  data-lang="en"
  async
></script>
```

See `web/widget/README.md` for every `data-*` attribute and the
teaser-bubble/security notes.

### Known trade-off: cold starts

Render's free plan spins the container down after ~15 minutes of no
traffic; the next request pays a ~30-50s cold start while it spins back
up (the `HEALTHCHECK`/`healthCheckPath` in this repo only affects an
*already-running* instance, not the free plan's idle-suspend behavior).
Acceptable for a portfolio/interview demo you mention this about
upfront; not acceptable for something meant to feel instant. Two ways to
avoid it without leaving the free tier entirely:

- A free scheduled job (e.g. a GitHub Actions workflow on a cron
  trigger) that pings `GET /healthz` every 10 minutes keeps the instance
  warm, at the cost of essentially unlimited free CI minutes for a
  request this trivial.
- Upgrade only the Render service to a paid instance (Supabase can stay
  on its free tier) once cold starts actually matter.

## Local development

```bash
npm install
cp .env.example .env
# edit .env: set real OPENAI_API_KEY and CLAUDE_API_KEY values

npm run db:up        # starts Postgres (pgvector) via docker compose
npm run db:migrate   # applies src/db/migrations/*.sql
npm run dev           # starts the service (tsx watch, verifies DB connectivity)
```

**Port note:** the container's Postgres is exposed on host port `5433`,
not the default `5432`, since `5432` is frequently already bound by a
locally installed Postgres. `.env.example`'s `DATABASE_URL` already
points at `5433`. If you'd rather use `5432`, change the port mapping in
`docker-compose.yml` back to `5432:5432` and update `DATABASE_URL` to
match, once you've confirmed nothing else on your machine is using it
(`lsof -i :5432` on macOS/Linux).

## Verification commands

```bash
npm run typecheck         # tsc --noEmit against src + test
npm run widget:typecheck  # tsc --noEmit against web/widget
npm run lint               # eslint, zero warnings allowed
npm run format:check
npm test                   # vitest, server + widget
npm run build               # compiles src -> dist, copies migration SQL
npm run widget:build        # bundles the widget -> web/widget/dist/widget.js
```

All of the above must pass clean before any phase in this project is
considered done - this is the standing verification bar for every
change, not a one-time check.

## Container build

```bash
docker build -t publitas-rag .
docker run --env-file .env -p 3000:3000 publitas-rag
```

The `Dockerfile` is a two-stage build (full toolchain in the build
stage, production-only `node_modules` in the runtime stage), runs as a
non-root user, and its `CMD` applies pending migrations
(`node dist/db/migrate.js`, idempotent - see `src/db/migrate.ts`) before
starting the server on every container start, so a fresh database or a
new migration in a deploy is handled automatically.
