import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closePool } from './client.js';
import { logger } from '../lib/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function getAppliedMigrations(): Promise<Set<string>> {
  const result = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  return new Set(result.rows.map((row) => row.filename));
}

async function runMigrations(): Promise<void> {
  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();

  const allFiles = await readdir(MIGRATIONS_DIR);
  const migrationFiles = allFiles.filter((f) => f.endsWith('.sql')).sort();

  if (migrationFiles.length === 0) {
    logger.warn({ dir: MIGRATIONS_DIR }, 'No migration files found');
    return;
  }

  const pending = migrationFiles.filter((f) => !applied.has(f));
  if (pending.length === 0) {
    logger.info('No pending migrations, database is up to date');
    return;
  }

  for (const filename of pending) {
    const filePath = path.join(MIGRATIONS_DIR, filename);
    const sql = await readFile(filePath, 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
      await client.query('COMMIT');
      logger.info({ filename }, 'Applied migration');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err, filename }, 'Migration failed, rolled back');
      throw err;
    } finally {
      client.release();
    }
  }

  logger.info({ count: pending.length }, 'All pending migrations applied');
}

runMigrations()
  .then(() => closePool())
  .catch((err: unknown) => {
    logger.error({ err }, 'Migration run failed');
    return closePool().finally(() => {
      process.exit(1);
    });
  });
