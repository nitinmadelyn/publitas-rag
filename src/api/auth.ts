import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from './errors.js';

export interface ApiKeyAuthOptions {
  apiKeys: ReadonlySet<string>;
}

/**
 * Builds a Fastify onRequest hook that requires a valid `x-api-key`
 * header. Deliberately a single shared-secret tier for the first API cut
 * (see config API_KEYS) rather than per-tenant keys; every accepted key
 * can currently query every catalog. Swapping this for a per-tenant,
 * DB-backed key store later only touches this file and the
 * ServerOptions.apiKeys wiring in server.ts, not the route handlers.
 */
export function createApiKeyAuthHook(
  options: ApiKeyAuthOptions,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  // Must genuinely be async (return a real Promise), not just typed as
  // one: Fastify's hook runner inspects a 2-argument onRequest hook's
  // *return value*, not its declared type, to decide whether to await a
  // promise or wait for a third `done` callback that this signature never
  // provides. A plain sync function returning undefined here satisfies
  // this file's own void return type but hangs every request forever,
  // since Fastify keeps waiting for a done() call that will never come.
  // eslint-disable-next-line @typescript-eslint/require-await
  return async function apiKeyAuthHook(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = request.headers['x-api-key'];
    const key = Array.isArray(header) ? header[0] : header;

    if (!key || !options.apiKeys.has(key)) {
      throw new ApiError(401, 'unauthorized', 'A valid x-api-key header is required.');
    }
  };
}
