/**
 * Runs `fn` over every item in `items`, at most `concurrency` invocations
 * in flight at once. Preserves input order in the returned array. Used for
 * product hotspot fan-out, a publication can have dozens of product
 * hotspots, each requiring its own API call; unbounded parallelism would
 * hammer the Publitas API and risk tripping their rate limiting, while
 * fully sequential fetching would make ingestion of a large catalog
 * unacceptably slow.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  if (concurrency < 1) {
    throw new RangeError(`concurrency must be >= 1, got ${concurrency}`);
  }

  const results: R[] = new Array(items.length) as R[];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;

      const item = items[currentIndex] as T;
      results[currentIndex] = await fn(item, currentIndex);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}
