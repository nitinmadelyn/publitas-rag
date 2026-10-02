import { Pool, types, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';

const SLOW_QUERY_THRESHOLD_MS = 500;

/** OID for Postgres' int8/bigint type. */
const PG_TYPE_OID_INT8 = 20;

/**
 * node-postgres returns int8 (bigint) columns - which every primary key
 * in this schema is (chunks.id, pages.id, catalogs.id, ...) - as strings
 * by default, since a bigint can exceed Number.MAX_SAFE_INTEGER and pg
 * refuses to silently lose precision. Every interface in this codebase
 * (RawSearchRow, RetrievedChunk, etc.) declares these ids as `number`,
 * so left at the default they'd be strings at runtime while TypeScript
 * insists they're numbers - a real bug (e.g. `chunkId + 1` silently
 * becoming string concatenation) that only shows up outside the type
 * checker, such as in a JSON API response.
 *
 * Parsing int8 as a JS number here is safe for this application's actual
 * scale (a BIGSERIAL counter reaching 2^53 would mean ~9 quadrillion
 * rows), and keeps every id a real number everywhere downstream without
 * touching a single interface. If this table could ever hold an
 * externally-sourced bigint that isn't a small sequential id, this
 * parser would need to switch to returning a string/BigInt instead.
 */
types.setTypeParser(PG_TYPE_OID_INT8, (value: string): number => parseInt(value, 10));

/**
 * A single pool for the process. Do not create Pool instances elsewhere,
 * every DB access should go through query()/withTransaction() below so
 * connection lifecycle, error logging, and slow-query detection are
 * consistent everywhere.
 */
export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.DATABASE_POOL_MAX,
  idleTimeoutMillis: config.DATABASE_POOL_IDLE_TIMEOUT_MS,
  // A connection that can't be established within 5s is almost certainly
  // a network/config problem, not a slow server; fail fast rather than
  // hanging a request indefinitely.
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  // Fired on idle client errors (e.g. the DB restarting under us). This is
  // not tied to any single request, so it can only be logged, not thrown.
  logger.error({ err }, 'Unexpected error on idle Postgres client');
});

export interface QueryOptions {
  /** Correlates this query's logs with the request that triggered it. */
  requestId?: string;
}

/**
 * Runs a parameterized query against the pool. Always use placeholders
 * ($1, $2, ...) for any value that comes from a caller or an external API;
 * never interpolate strings into SQL.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
  options: QueryOptions = {},
): Promise<QueryResult<T>> {
  const start = Date.now();
  try {
    const result = await pool.query<T>(text, params);
    const durationMs = Date.now() - start;
    if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
      logger.warn({ durationMs, query: text, requestId: options.requestId }, 'Slow query detected');
    }
    return result;
  } catch (err) {
    logger.error({ err, query: text, requestId: options.requestId }, 'Database query failed');
    throw err;
  }
}

/**
 * Runs a set of queries inside a transaction. The callback receives a
 * dedicated client so all queries inside it share the same transaction;
 * on any thrown error the transaction is rolled back and the error
 * re-thrown to the caller. The client is always released back to the pool.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
      logger.error({ err: rollbackErr }, 'Rollback failed after transaction error');
    });
    throw err;
  } finally {
    client.release();
  }
}

/** Lightweight liveness check for health endpoints and startup verification. */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (err) {
    logger.error({ err }, 'Database connectivity check failed');
    return false;
  }
}

/** Call during graceful shutdown (SIGTERM/SIGINT handlers) to drain the pool. */
export async function closePool(): Promise<void> {
  await pool.end();
  logger.info('Postgres pool closed');
}
