import { describe, expect, it } from 'vitest';
import { toVectorLiteral } from '../src/embeddings/vector-literal.js';

describe('toVectorLiteral', () => {
  it('formats a valid embedding as a pgvector literal', () => {
    expect(toVectorLiteral([0.1, -0.2, 0.3], 3)).toBe('[0.1,-0.2,0.3]');
  });

  it('throws when the embedding length does not match expectedDimensions', () => {
    expect(() => toVectorLiteral([0.1, 0.2], 3)).toThrow(/dimensions/);
  });

  it('throws on an empty embedding when dimensions are expected', () => {
    expect(() => toVectorLiteral([], 3)).toThrow(/dimensions/);
  });

  it('accepts a zero-dimension embedding when expectedDimensions is 0', () => {
    expect(toVectorLiteral([], 0)).toBe('[]');
  });

  it('throws on NaN', () => {
    expect(() => toVectorLiteral([0.1, Number.NaN], 2)).toThrow(/non-finite/);
  });

  it('throws on positive Infinity', () => {
    expect(() => toVectorLiteral([0.1, Number.POSITIVE_INFINITY], 2)).toThrow(/non-finite/);
  });

  it('throws on negative Infinity', () => {
    expect(() => toVectorLiteral([Number.NEGATIVE_INFINITY], 1)).toThrow(/non-finite/);
  });

  it('handles a single-dimension embedding', () => {
    expect(toVectorLiteral([42], 1)).toBe('[42]');
  });

  it('preserves full float precision from the input numbers', () => {
    const value = 0.123456789012345;
    expect(toVectorLiteral([value], 1)).toBe(`[${value}]`);
  });
});
