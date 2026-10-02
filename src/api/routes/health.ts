import type { FastifyInstance } from 'fastify';

export interface HealthRouteDependencies {
  checkDatabaseConnection: () => Promise<boolean>;
}

/**
 * Liveness/readiness probes. Deliberately unauthenticated (no x-api-key
 * required) and registered outside the rate-limited/auth-gated scope in
 * server.ts, since a load balancer or orchestrator polling these every
 * few seconds must never be rate limited or need a secret.
 *
 * checkDatabaseConnection is injected rather than imported directly so
 * these routes are testable without a real Postgres connection, matching
 * the DI pattern used throughout the rest of this codebase.
 */
export function registerHealthRoutes(app: FastifyInstance, deps: HealthRouteDependencies): void {
  /** Process is up and able to respond. Does not touch the database. */
  app.get('/healthz', () => {
    return { status: 'ok' };
  });

  /** Process is up AND able to serve real traffic (DB reachable). */
  app.get('/readyz', async (_request, reply) => {
    const dbOk = await deps.checkDatabaseConnection();
    if (!dbOk) {
      return reply.status(503).send({ status: 'unavailable', reason: 'database' });
    }
    return reply.status(200).send({ status: 'ready' });
  });
}
