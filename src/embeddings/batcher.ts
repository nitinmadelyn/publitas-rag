export interface TextBatchItem {
  id: number;
  text: string;
}

/**
 * Greedily groups items into batches respecting both a max item count and
 * a max total character count (a fast proxy for the request's total token
 * count, OpenAI enforces a per-request token ceiling across all inputs
 * combined, not just per item). A single item longer than maxCharsPerBatch
 * still gets its own one-item batch rather than being dropped; the caller
 * is expected to have already truncated any individual text to a sane
 * per-item limit before batching (see EMBEDDING_MAX_CHARS_PER_CHUNK).
 */
export function batchByCountAndSize<T extends TextBatchItem>(
  items: readonly T[],
  maxBatchSize: number,
  maxCharsPerBatch: number,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentChars = 0;

  for (const item of items) {
    const itemChars = item.text.length;
    const wouldExceedCount = current.length >= maxBatchSize;
    const wouldExceedChars = current.length > 0 && currentChars + itemChars > maxCharsPerBatch;

    if (wouldExceedCount || wouldExceedChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(item);
    currentChars += itemChars;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}
