import { describe, expect, it } from 'vitest';
import { mergeSearchResults } from '../src/retrieval/retrieve.js';
import type { RawSearchRow } from '../src/retrieval/chunk-search-repository.js';

function row(overrides: Partial<RawSearchRow> = {}): RawSearchRow {
  return {
    id: 1,
    page_id: 1,
    catalog_id: 1,
    chunk_index: 0,
    text: 'Wok (49.99)',
    product_ref: '123',
    language_code: 'en',
    page_number: 1,
    public_url: 'https://view.publitas.com/x/y/page/1',
    score: 0.9,
    ...overrides,
  };
}

describe('mergeSearchResults', () => {
  it('returns an empty array when both inputs are empty', () => {
    expect(mergeSearchResults([], [], 0.75, 8)).toEqual([]);
  });

  it('keeps a vector-only match above the relevance threshold', () => {
    const result = mergeSearchResults([row({ id: 1, score: 0.8 })], [], 0.75, 8);
    expect(result).toHaveLength(1);
    expect(result[0]?.matchType).toBe('vector');
    expect(result[0]?.score).toBe(0.8);
  });

  it('drops a vector-only match below the relevance threshold', () => {
    const result = mergeSearchResults([row({ id: 1, score: 0.5 })], [], 0.75, 8);
    expect(result).toEqual([]);
  });

  it('keeps a vector-only match exactly at the threshold (inclusive boundary)', () => {
    const result = mergeSearchResults([row({ id: 1, score: 0.75 })], [], 0.75, 8);
    expect(result).toHaveLength(1);
  });

  it('keeps a lexical-only match even when its score is below the vector relevance threshold', () => {
    const result = mergeSearchResults([], [row({ id: 1, score: 0.35 })], 0.75, 8);
    expect(result).toHaveLength(1);
    expect(result[0]?.matchType).toBe('lexical');
    expect(result[0]?.score).toBe(0.35);
  });

  it('marks a chunk found by both searches as hybrid and keeps the higher score', () => {
    const result = mergeSearchResults(
      [row({ id: 1, score: 0.6 })],
      [row({ id: 1, score: 0.9 })],
      0.5,
      8,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.matchType).toBe('hybrid');
    expect(result[0]?.score).toBe(0.9);
  });

  it('sorts the merged results by score descending', () => {
    const result = mergeSearchResults(
      [row({ id: 1, score: 0.8 }), row({ id: 2, score: 0.95 })],
      [row({ id: 3, score: 0.5 })],
      0.3,
      8,
    );
    expect(result.map((r) => r.chunkId)).toEqual([2, 1, 3]);
  });

  it('caps the merged results at topK', () => {
    const vectorRows = Array.from({ length: 5 }, (_, i) => row({ id: i + 1, score: 0.9 - i * 0.01 }));
    const result = mergeSearchResults(vectorRows, [], 0.5, 2);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.chunkId)).toEqual([1, 2]);
  });

  it('maps all row fields onto the RetrievedChunk shape correctly', () => {
    const result = mergeSearchResults(
      [
        row({
          id: 42,
          page_id: 7,
          catalog_id: 3,
          chunk_index: 2,
          text: 'Non-stick pan',
          product_ref: 'SKU-99',
          language_code: 'nl',
          page_number: 4,
          public_url: 'https://view.publitas.com/a/b/page/4',
          score: 0.88,
        }),
      ],
      [],
      0.5,
      8,
    );
    expect(result[0]).toEqual({
      chunkId: 42,
      pageId: 7,
      catalogId: 3,
      chunkIndex: 2,
      text: 'Non-stick pan',
      productRef: 'SKU-99',
      languageCode: 'nl',
      pageNumber: 4,
      publicUrl: 'https://view.publitas.com/a/b/page/4',
      score: 0.88,
      matchType: 'vector',
    });
  });

  it('handles a chunk with a null product_ref', () => {
    const result = mergeSearchResults([row({ id: 1, product_ref: null })], [], 0.5, 8);
    expect(result[0]?.productRef).toBeNull();
  });
});
