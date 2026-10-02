import 'dotenv/config';
import { z } from 'zod';

/**
 * Every environment variable the service depends on is declared here, once.
 * If a required value is missing or malformed, the process must fail at
 * startup with a readable error rather than surfacing a confusing runtime
 * crash later (e.g. a null DATABASE_URL reaching the pg driver mid-request).
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((v) => v.startsWith('postgresql://') || v.startsWith('postgres://'), {
      message: 'DATABASE_URL must be a postgres connection string',
    }),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30_000),

  PUBLITAS_API_BASE_URL: z.string().url().default('https://api.publitas.com/v1'),
  PUBLITAS_API_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  PUBLITAS_API_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
  PUBLITAS_PRODUCT_FETCH_CONCURRENCY: z.coerce.number().int().positive().max(20).default(5),

  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-large'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),
  CHAT_MODEL: z.string().min(1).default('claude-sonnet-5'),

  // --- Embedding pipeline (Phase 4) ---
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().positive().max(2048).default(96),
  EMBEDDING_MAX_CHARS_PER_BATCH: z.coerce.number().int().positive().default(100_000),
  EMBEDDING_MAX_CHARS_PER_CHUNK: z.coerce.number().int().positive().default(32_000),
  EMBEDDING_FETCH_PAGE_SIZE: z.coerce.number().int().positive().default(500),
  EMBEDDING_REQUEST_CONCURRENCY: z.coerce.number().int().positive().max(20).default(3),
  EMBEDDING_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  EMBEDDING_API_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  EMBEDDING_API_MAX_RETRIES: z.coerce.number().int().nonnegative().default(4),

  // --- Generation (Phase 6) ---
  CLAUDE_API_KEY: z.string().min(1, 'CLAUDE_API_KEY is required'),
  CLAUDE_MAX_TOKENS: z.coerce.number().int().positive().max(8192).default(1024),
  CLAUDE_API_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  CLAUDE_API_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),

  // --- Retrieval (Phase 5) ---
  RETRIEVAL_TOP_K: z.coerce.number().int().positive().max(50).default(8),
  RETRIEVAL_RELEVANCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75),
  // Max lexical (pg_trgm) fallback hits considered per query.
  RETRIEVAL_LEXICAL_LIMIT: z.coerce.number().int().positive().max(50).default(10),
  // Minimum pg_trgm similarity() score for a lexical hit to be considered at all.
  RETRIEVAL_LEXICAL_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.3),

  // --- API layer (Phase 7) ---
  // Comma-separated list of accepted x-api-key header values. The default
  // below is only safe for local development; every non-development
  // deployment must override it. Per-tenant keys (one key per B2B
  // customer, scoped to their own catalog slugs) are a follow-up; this is
  // deliberately a single shared-secret tier for the first API cut.
  API_KEYS: z.string().min(1).default('dev-local-key-change-me'),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  // '*' allows any origin (fine for a public read-only catalog chat widget
  // embedded on arbitrary customer sites); set a comma-separated allowlist
  // to restrict it.
  CORS_ALLOWED_ORIGINS: z.string().min(1).default('*'),
});

export type Env = z.infer<typeof envSchema>;

export class ConfigValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n${issues.join('\n')}`);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

/**
 * Pure function: parses a raw env-like object into a validated Env, or
 * throws ConfigValidationError. No process.exit, no I/O, fully unit
 * testable with arbitrary input objects.
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `  - ${issue.path.join('.')}: ${issue.message}`,
    );
    throw new ConfigValidationError(issues);
  }
  return parsed.data;
}

/**
 * Real startup path: reads process.env, and on failure writes to stderr
 * and exits the process. Not called from tests, only from the app entrypoint
 * (and implicitly below, once, at module load for the exported singleton).
 */
function loadConfigOrExit(): Env {
  try {
    return parseEnv(process.env);
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

export const config: Env = loadConfigOrExit();
