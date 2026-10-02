import type { FastifyInstance } from 'fastify';
import { config } from './config/index.js';
import { logger } from './lib/logger.js';
import { checkDatabaseConnection, closePool } from './db/client.js';
import { buildServer } from './api/server.js';

let server: FastifyInstance | undefined;

async function main(): Promise<void> {
  logger.info({ nodeEnv: config.NODE_ENV, port: config.PORT }, 'Starting publitas-rag service');

  const dbOk = await checkDatabaseConnection();
  if (!dbOk) {
    logger.fatal('Database connectivity check failed at startup, exiting');
    process.exit(1);
  }
  logger.info('Database connection verified');

  server = await buildServer();
  await server.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT }, 'HTTP server listening');
}

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Received shutdown signal, draining connections');
  try {
    if (server) {
      // Stops accepting new connections and waits for in-flight requests
      // to finish before this resolves, so an in-progress chat request
      // (which can take several seconds waiting on Claude) isn't cut off
      // mid-response during a rolling deploy.
      await server.close();
    }
    await closePool();
    logger.info('Graceful shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during graceful shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception, exiting');
  process.exit(1);
});

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Fatal error during startup');
  process.exit(1);
});
