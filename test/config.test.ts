import { describe, expect, it } from 'vitest';
import { ConfigValidationError, parseEnv } from '../src/config/index.js';

/**
 * Minimal valid env, used as a base and mutated per test so each test
 * only asserts on the one thing it's checking.
 */
function validEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    OPENAI_API_KEY: 'sk-test-key',
    CLAUDE_API_KEY: 'sk-ant-test-key',
    ...overrides,
  };
}

describe('parseEnv', () => {
  it('parses a minimal valid env and applies defaults', () => {
    const result = parseEnv(validEnv());
    expect(result.NODE_ENV).toBe('development');
    expect(result.LOG_LEVEL).toBe('info');
    expect(result.PORT).toBe(3000);
    expect(result.RETRIEVAL_TOP_K).toBe(8);
    expect(result.RETRIEVAL_RELEVANCE_THRESHOLD).toBe(0.75);
    expect(result.EMBEDDING_DIMENSIONS).toBe(1536);
  });

  it('accepts a fully specified env and overrides defaults', () => {
    const result = parseEnv(
      validEnv({
        NODE_ENV: 'production',
        LOG_LEVEL: 'debug',
        PORT: '8080',
        RETRIEVAL_TOP_K: '20',
        RETRIEVAL_RELEVANCE_THRESHOLD: '0.9',
      }),
    );
    expect(result.NODE_ENV).toBe('production');
    expect(result.LOG_LEVEL).toBe('debug');
    expect(result.PORT).toBe(8080);
    expect(result.RETRIEVAL_TOP_K).toBe(20);
    expect(result.RETRIEVAL_RELEVANCE_THRESHOLD).toBe(0.9);
  });

  // --- Missing required values -----------------------------------------

  it('throws when DATABASE_URL is missing', () => {
    const env = validEnv();
    delete env.DATABASE_URL;
    expect(() => parseEnv(env)).toThrow(ConfigValidationError);
  });

  it('throws when OPENAI_API_KEY is missing', () => {
    const env = validEnv();
    delete env.OPENAI_API_KEY;
    expect(() => parseEnv(env)).toThrow(ConfigValidationError);
  });

  it('throws when CLAUDE_API_KEY is missing', () => {
    const env = validEnv();
    delete env.CLAUDE_API_KEY;
    expect(() => parseEnv(env)).toThrow(ConfigValidationError);
  });

  it('reports every missing/invalid field in one error, not just the first', () => {
    try {
      parseEnv({});
      expect.fail('expected parseEnv to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const configError = err as ConfigValidationError;
      expect(configError.issues.some((i) => i.includes('DATABASE_URL'))).toBe(true);
      expect(configError.issues.some((i) => i.includes('OPENAI_API_KEY'))).toBe(true);
      expect(configError.issues.some((i) => i.includes('CLAUDE_API_KEY'))).toBe(true);
    }
  });

  // --- Malformed values ---------------------------------------------------

  it('throws when DATABASE_URL is not a postgres connection string', () => {
    const env = validEnv({ DATABASE_URL: 'mysql://user:pass@localhost:3306/db' });
    expect(() => parseEnv(env)).toThrow(ConfigValidationError);
  });

  it('throws when DATABASE_URL is an empty string', () => {
    const env = validEnv({ DATABASE_URL: '' });
    expect(() => parseEnv(env)).toThrow(ConfigValidationError);
  });

  it('throws when NODE_ENV is not one of the allowed values', () => {
    const env = validEnv({ NODE_ENV: 'staging' });
    expect(() => parseEnv(env)).toThrow(ConfigValidationError);
  });

  it('throws when PORT is not numeric', () => {
    const env = validEnv({ PORT: 'not-a-number' });
    expect(() => parseEnv(env)).toThrow(ConfigValidationError);
  });

  it('throws when PORT is negative', () => {
    const env = validEnv({ PORT: '-1' });
    expect(() => parseEnv(env)).toThrow(ConfigValidationError);
  });

  it('throws when PORT is zero', () => {
    const env = validEnv({ PORT: '0' });
    expect(() => parseEnv(env)).toThrow(ConfigValidationError);
  });

  it('throws when RETRIEVAL_RELEVANCE_THRESHOLD is out of [0, 1] range', () => {
    expect(() => parseEnv(validEnv({ RETRIEVAL_RELEVANCE_THRESHOLD: '1.5' }))).toThrow(
      ConfigValidationError,
    );
    expect(() => parseEnv(validEnv({ RETRIEVAL_RELEVANCE_THRESHOLD: '-0.1' }))).toThrow(
      ConfigValidationError,
    );
  });

  it('accepts RETRIEVAL_RELEVANCE_THRESHOLD at exact boundaries 0 and 1', () => {
    expect(
      parseEnv(validEnv({ RETRIEVAL_RELEVANCE_THRESHOLD: '0' })).RETRIEVAL_RELEVANCE_THRESHOLD,
    ).toBe(0);
    expect(
      parseEnv(validEnv({ RETRIEVAL_RELEVANCE_THRESHOLD: '1' })).RETRIEVAL_RELEVANCE_THRESHOLD,
    ).toBe(1);
  });

  it('throws when RETRIEVAL_TOP_K exceeds the max of 50', () => {
    expect(() => parseEnv(validEnv({ RETRIEVAL_TOP_K: '51' }))).toThrow(ConfigValidationError);
  });

  it('throws when PUBLITAS_API_BASE_URL is not a valid URL', () => {
    expect(() => parseEnv(validEnv({ PUBLITAS_API_BASE_URL: 'not-a-url' }))).toThrow(
      ConfigValidationError,
    );
  });

  it('throws when EMBEDDING_DIMENSIONS is not a positive integer', () => {
    expect(() => parseEnv(validEnv({ EMBEDDING_DIMENSIONS: '0' }))).toThrow(ConfigValidationError);
    expect(() => parseEnv(validEnv({ EMBEDDING_DIMENSIONS: '-100' }))).toThrow(
      ConfigValidationError,
    );
    expect(() => parseEnv(validEnv({ EMBEDDING_DIMENSIONS: '1.5' }))).toThrow(
      ConfigValidationError,
    );
  });

  // --- Edge cases around whitespace / accidental values -------------------

  it('treats a whitespace-only DATABASE_URL as invalid', () => {
    expect(() => parseEnv(validEnv({ DATABASE_URL: '   ' }))).toThrow(ConfigValidationError);
  });

  it('does not silently coerce an array-like or object-like env value', () => {
    // process.env values are always strings in real Node, but a caller
    // constructing the input object by hand could pass the wrong shape;
    // this guards the parse function's own contract.
    const env = validEnv({ PORT: '3000,4000' });
    expect(() => parseEnv(env)).toThrow(ConfigValidationError);
  });
});
