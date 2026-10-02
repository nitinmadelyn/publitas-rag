import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { config } from '../config/index.js';
import { checkDatabaseConnection } from '../db/client.js';
import { defaultRetrievalRepository } from '../retrieval/chunk-search-repository.js';
import { OpenAIEmbeddingClient } from '../embeddings/openai-embedding-client.js';
import { ClaudeClient } from '../generation/claude-client.js';
import type { ServerDependencies } from './types.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerSearchRoutes } from './routes/search.js';
import { createApiKeyAuthHook } from './auth.js';
import { toErrorResponse } from './errors.js';

export interface ServerOptions {
  dependencies?: ServerDependencies;
  apiKeys?: ReadonlySet<string>;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  corsOrigins?: string;
  /** Overridable for tests; defaults to the real Postgres pool check. */
  checkDatabaseConnection?: () => Promise<boolean>;
}

function parseApiKeys(raw: string): ReadonlySet<string> {
  return new Set(
    raw
      .split(',')
      .map((key) => key.trim())
      .filter((key) => key.length > 0),
  );
}

function defaultDependencies(): ServerDependencies {
  return {
    repository: defaultRetrievalRepository,
    embeddingClient: new OpenAIEmbeddingClient({
      apiKey: config.OPENAI_API_KEY,
      model: config.EMBEDDING_MODEL,
      dimensions: config.EMBEDDING_DIMENSIONS,
      timeoutMs: config.EMBEDDING_API_TIMEOUT_MS,
      maxRetries: config.EMBEDDING_API_MAX_RETRIES,
    }),
    claudeClient: new ClaudeClient({
      apiKey: config.CLAUDE_API_KEY,
      model: config.CHAT_MODEL,
      maxTokens: config.CLAUDE_MAX_TOKENS,
      timeoutMs: config.CLAUDE_API_TIMEOUT_MS,
      maxRetries: config.CLAUDE_API_MAX_RETRIES,
    }),
  };
}

/**
 * Builds a fully configured Fastify instance without binding a port.
 * Production startup (index.ts) calls this with no arguments and then
 * calls .listen() itself; tests call this with fake dependencies and
 * drive it with .inject(), so the whole API layer is testable without a
 * real database, a real OpenAI key, or a real Claude key.
 *
 * Every option here has a config-backed default, so production wiring is
 * just `await buildServer()`.
 */
export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const deps = options.dependencies ?? defaultDependencies();
  const apiKeys = options.apiKeys ?? parseApiKeys(config.API_KEYS);
  const rateLimitMax = options.rateLimitMax ?? config.RATE_LIMIT_MAX;
  const rateLimitWindowMs = options.rateLimitWindowMs ?? config.RATE_LIMIT_WINDOW_MS;
  const corsOrigins = options.corsOrigins ?? config.CORS_ALLOWED_ORIGINS;
  const checkDb = options.checkDatabaseConnection ?? checkDatabaseConnection;

  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    genReqId: () => randomUUID(),
    // Honors X-Forwarded-For from a load balancer/reverse proxy so
    // rate-limiting and access logs see the real client IP rather than
    // the proxy's, which matters once this runs behind one at any scale.
    trustProxy: true,
    // A chat query or search query is never legitimately larger than a
    // few KB; 1 MiB is generous headroom while still rejecting an
    // oversized/abusive body before it reaches JSON parsing.
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin: corsOrigins === '*' ? true : corsOrigins.split(',').map((origin) => origin.trim()),
  });

  await app.register(rateLimit, {
    max: rateLimitMax,
    timeWindow: rateLimitWindowMs,
    // Keyed by API key rather than IP wherever possible, so one tenant's
    // traffic can never exhaust another tenant's quota; falls back to IP
    // for requests that never got past auth (or the health routes, which
    // never carry a key at all).
    keyGenerator: (request) => {
      const header = request.headers['x-api-key'];
      const key = Array.isArray(header) ? header[0] : header;
      return key ?? request.ip;
    },
  });

  registerHealthRoutes(app, { checkDatabaseConnection: checkDb });

  // Serves the built embeddable widget bundle (web/widget/dist/widget.js)
  // from this same service at GET /widget/widget.js, deliberately
  // outside the auth-gated scope below (the whole point of the widget is
  // that arbitrary customer pages load it unauthenticated; only the
  // chat/search API calls it makes need the x-api-key). This lets a demo
  // deployment serve both the API and the widget from one free Render
  // service with no separate CDN/static host to pay for or configure -
  // an embedding page just points its <script src> at this service's
  // own /widget/widget.js instead of a third-party asset host.
  //
  // __dirname resolution: this file lives at src/api/server.ts and
  // compiles to dist/api/server.js - two directories deep from the repo
  // root either way (src/api or dist/api), so '../../web/widget/dist'
  // resolves to <repo root>/web/widget/dist identically under `npm run
  // dev` (tsx running the .ts file directly) and the built
  // `dist/api/server.js`. The Dockerfile copies web/widget/dist into the
  // production image at that same relative path for this to hold there
  // too.
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const widgetDistDir = path.join(currentDir, '../../web/widget/dist');
  // The widget bundle (`npm run widget:build`) is a separate build step
  // from this server's own build/start. A checkout or deploy that hasn't
  // run it yet must not take the whole API down over a missing static
  // asset - so this degrades to "the widget route 404s" with a startup
  // warning, rather than a crash, if the directory isn't there.
  if (existsSync(widgetDistDir)) {
    await app.register(fastifyStatic, {
      root: widgetDistDir,
      prefix: '/widget/',
      // Never list directory contents; only serve the exact built files
      // (widget.js and its .map) that exist in dist.
      list: false,
      // A build is immutable per deploy (the filename never changes),
      // but content can change between deploys, so cache for a while
      // yet still revalidate rather than caching forever.
      cacheControl: true,
      maxAge: '1h',
    });
  } else {
    app.log.warn(
      { widgetDistDir },
      'Widget bundle not found; /widget/widget.js will 404. Run `npm run widget:build` before deploying if the embeddable widget needs to be served from this service.',
    );
  }

  // setErrorHandler/setNotFoundHandler must be registered before any
  // child plugin that should inherit them: Fastify resolves a scope's
  // error/404 handling at boot time when that scope's register() call is
  // awaited, not dynamically per request, so a handler set on `app` after
  // a child has already finished registering never applies to that
  // child's routes - it silently falls back to Fastify's own default
  // error and 404 responses instead.
  app.setErrorHandler((err, request, reply) => {
    const { statusCode, body } = toErrorResponse(err, request.id);
    void reply.status(statusCode).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: { code: 'not_found', message: `No route matches ${request.method} ${request.url}` },
    });
  });

  const requireApiKey = createApiKeyAuthHook({ apiKeys });
  await app.register((scoped) => {
    scoped.addHook('onRequest', requireApiKey);
    registerChatRoutes(scoped, deps);
    registerSearchRoutes(scoped, deps);
  });

  return app;
}
