import { describe, expect, it } from 'vitest';
import { batchByCountAndSize } from '../src/embeddings/batcher.js';

function item(id: number, text: string): { id: number; text: string } {
  return { id, text };
}

describe('batchByCountAndSize', () => {
  it('returns an empty array for empty input', () => {
    expect(batchByCountAndSize([], 10, 1000)).toEqual([]);
  });

  it('puts everything in one batch when under both limits', () => {
    const items = [item(1, 'a'), item(2, 'b'), item(3, 'c')];
    expect(batchByCountAndSize(items, 10, 1000)).toEqual([items]);
  });

  it('splits into multiple batches once the count limit is hit', () => {
    const items = [item(1, 'a'), item(2, 'b'), item(3, 'c')];
    const batches = batchByCountAndSize(items, 2, 1000);
    expect(batches).toEqual([
      [item(1, 'a'), item(2, 'b')],
      [item(3, 'c')],
    ]);
  });

  it('splits into multiple batches once the char limit is hit', () => {
    const items = [item(1, 'aaaaa'), item(2, 'bbbbb'), item(3, 'ccccc')];
    const batches = batchByCountAndSize(items, 10, 12);
    expect(batches).toEqual([
      [item(1, 'aaaaa'), item(2, 'bbbbb')],
      [item(3, 'ccccc')],
    ]);
  });

  it('gives a single oversized item its own batch rather than dropping it', () => {
    const items = [item(1, 'x'.repeat(50))];
    expect(batchByCountAndSize(items, 10, 10)).toEqual([items]);
  });

  it('does not let an oversized item merge with a following item', () => {
    const items = [item(1, 'x'.repeat(50)), item(2, 'y')];
    const batches = batchByCountAndSize(items, 10, 10);
    expect(batches).toEqual([[item(1, 'x'.repeat(50))], [item(2, 'y')]]);
  });

  it('preserves input order across batches', () => {
    const items = Array.from({ length: 10 }, (_, i) => item(i, 'x'));
    const batches = batchByCountAndSize(items, 3, 1000);
    expect(batches.flat()).toEqual(items);
  });

  it('handles maxBatchSize of 1', () => {
    const items = [item(1, 'a'), item(2, 'b')];
    expect(batchByCountAndSize(items, 1, 1000)).toEqual([[item(1, 'a')], [item(2, 'b')]]);
  });

  it('handles items with empty text', () => {
    const items = [item(1, ''), item(2, '')];
    expect(batchByCountAndSize(items, 10, 1000)).toEqual([items]);
  });
});
