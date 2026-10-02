import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/lib/hash.js';

describe('sha256Hex', () => {
  it('produces a deterministic hash for the same input', () => {
    expect(sha256Hex('hello')).toBe(sha256Hex('hello'));
  });

  it('produces different hashes for different input', () => {
    expect(sha256Hex('hello')).not.toBe(sha256Hex('world'));
  });

  it('produces a 64-character lowercase hex string', () => {
    const hash = sha256Hex('anything');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles an empty string', () => {
    expect(sha256Hex('')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is sensitive to whitespace and key order in JSON-like input', () => {
    const a = sha256Hex(JSON.stringify({ a: 1, b: 2 }));
    const b = sha256Hex(JSON.stringify({ b: 2, a: 1 }));
    expect(a).not.toBe(b);
  });
});
