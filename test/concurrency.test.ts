import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '../src/lib/concurrency.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('mapWithConcurrency', () => {
  it('returns an empty array for empty input', async () => {
    const result = await mapWithConcurrency([], 3, (x: number) => Promise.resolve(x));
    expect(result).toEqual([]);
  });

  it('preserves input order in the output regardless of completion order', async () => {
    const items = [30, 10, 20];
    const result = await mapWithConcurrency(items, 3, async (delayMs) => {
      await sleep(delayMs);
      return delayMs;
    });
    expect(result).toEqual([30, 10, 20]);
  });

  it('processes all items exactly once', async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const seen: number[] = [];
    const result = await mapWithConcurrency(items, 4, (item) => {
      seen.push(item);
      return Promise.resolve(item * 2);
    });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
    expect(result).toEqual(items.map((i) => i * 2));
  });

  it('never exceeds the concurrency limit at any point in time', async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await mapWithConcurrency(items, 3, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(5);
      active -= 1;
      return item;
    });

    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it('works correctly when concurrency exceeds item count', async () => {
    const items = [1, 2];
    const result = await mapWithConcurrency(items, 10, (x) => Promise.resolve(x * 10));
    expect(result).toEqual([10, 20]);
  });

  it('works correctly with concurrency of exactly 1 (fully sequential)', async () => {
    const order: number[] = [];
    const items = [1, 2, 3];
    await mapWithConcurrency(items, 1, async (item) => {
      order.push(item);
      await sleep(1);
      return item;
    });
    expect(order).toEqual([1, 2, 3]);
  });

  it('propagates an error thrown by fn and stops returning further results', async () => {
    const items = [1, 2, 3];
    await expect(
      mapWithConcurrency(items, 2, (item) => {
        if (item === 2) throw new Error('boom');
        return Promise.resolve(item);
      }),
    ).rejects.toThrow('boom');
  });

  it('throws RangeError for concurrency less than 1', async () => {
    await expect(mapWithConcurrency([1, 2], 0, (x) => Promise.resolve(x))).rejects.toThrow(
      RangeError,
    );
  });

  it('handles a single item', async () => {
    const result = await mapWithConcurrency([42], 5, (x) => Promise.resolve(x + 1));
    expect(result).toEqual([43]);
  });
});
