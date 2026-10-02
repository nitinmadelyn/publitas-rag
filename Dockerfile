# syntax=docker/dockerfile:1

# --- Stage 1: build -------------------------------------------------------
# Installs full (dev + prod) dependencies once, compiles the server
# (tsc -> dist/) and bundles the embeddable widget (esbuild ->
# web/widget/dist/widget.js). Kept as its own stage so none of this - the
# TypeScript compiler, esbuild, @types/*, eslint, vitest - ends up in the
# production image.
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY web/widget/tsconfig.json ./web/widget/tsconfig.json
COPY web/widget/build.mjs ./web/widget/build.mjs
COPY web/widget/src ./web/widget/src

RUN npm run build
RUN npm run widget:build

# --- Stage 2: production runtime ------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
# Production dependencies only - this is the image that actually ships,
# so dev tooling (typescript, eslint, vitest, esbuild, autocannon, ...)
# has no reason to be in it.
RUN npm ci --omit=dev && npm cache clean --force

# Compiled server output and its runtime-read migration SQL files.
COPY --from=build /app/dist ./dist
# The built widget bundle, served at GET /widget/widget.js by
# src/api/server.ts - see that file for why it lives at this exact
# relative path (../../web/widget/dist from dist/api/server.js).
COPY --from=build /app/web/widget/dist ./web/widget/dist

# Runs as a non-root user, standard container hardening: a compromised
# Node process inside the container should not have root inside it either.
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nodejs
USER nodejs

EXPOSE 3000

# Liveness probe used by `docker run --health-cmd` or a platform that
# reads HEALTHCHECK directly (Render/Railway/Fly read their own configured
# health check path instead, see render.yaml, but this keeps the image
# self-describing for any other orchestrator too). Uses Node itself
# rather than curl/wget so no extra package has to be installed in the
# slim base image just for this.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Applies any pending migrations (idempotent - see src/db/migrate.ts,
# tracked via a schema_migrations table) before every start, so a fresh
# database or a deploy carrying a new migration is handled automatically
# without a separate manual migration step. Safe to run on every
# container start/restart, including a second instance starting
# concurrently with the first during a rolling deploy, since a migration
# already marked applied is skipped.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
