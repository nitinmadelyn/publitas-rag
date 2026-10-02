import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildGenerationPrompt,
  extractCitedChunks,
} from '../src/generation/prompt.js';
import type { RetrievedChunk } from '../src/retrieval/retrieve.js';

function chunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunkId: 1,
    pageId: 1,
    catalogId: 1,
    chunkIndex: 0,
    text: 'Non-stick pan, 28cm (49.99)',
    productRef: 'SKU-123',
    languageCode: 'en',
    pageNumber: 4,
    publicUrl: 'https://view.publitas.com/x/y/page/4',
    score: 0.9,
    matchType: 'vector',
    ...overrides,
  };
}

describe('buildSystemPrompt', () => {
  it('instructs the model to only use the provided context', () => {
    const prompt = buildSystemPrompt('en');
    expect(prompt).toMatch(/only/i);
    expect(prompt).toMatch(/citation/i);
  });

  it('names the target language when a known language code is given', () => {
    expect(buildSystemPrompt('fr')).toMatch(/French/);
    expect(buildSystemPrompt('pt')).toMatch(/Portuguese/);
    expect(buildSystemPrompt('es')).toMatch(/Spanish/);
  });

  it('is case-insensitive when matching a known language code', () => {
    expect(buildSystemPrompt('FR')).toMatch(/French/);
  });

  it('falls back to naming the raw code for an unrecognized language', () => {
    const prompt = buildSystemPrompt('xx');
    expect(prompt).toMatch(/"xx"/);
  });
});

describe('buildUserPrompt', () => {
  it('numbers chunks starting at 1 in the order given', () => {
    const prompt = buildUserPrompt('how much is the pan', [
      chunk({ chunkId: 10, text: 'first chunk text' }),
      chunk({ chunkId: 20, text: 'second chunk text' }),
    ]);
    expect(prompt).toMatch(/\[1\][\s\S]*first chunk text/);
    expect(prompt).toMatch(/\[2\][\s\S]*second chunk text/);
  });

  it('includes the page number for each chunk', () => {
    const prompt = buildUserPrompt('q', [chunk({ pageNumber: 7 })]);
    expect(prompt).toMatch(/page 7/);
  });

  it('includes the product reference when present', () => {
    const prompt = buildUserPrompt('q', [chunk({ productRef: 'SKU-999' })]);
    expect(prompt).toMatch(/SKU-999/);
  });

  it('omits a product reference line when productRef is null', () => {
    const prompt = buildUserPrompt('q', [chunk({ productRef: null })]);
    expect(prompt).not.toMatch(/Product reference/);
  });

  it('appends the question at the end', () => {
    const prompt = buildUserPrompt('what colors are available', [chunk()]);
    expect(prompt.trim().endsWith('Question: what colors are available')).toBe(true);
  });

  it('handles an empty chunk list without throwing', () => {
    const prompt = buildUserPrompt('q', []);
    expect(prompt).toMatch(/Question: q/);
  });
});

describe('buildGenerationPrompt', () => {
  it('returns both a system and a user prompt', () => {
    const result = buildGenerationPrompt('q', [chunk()], 'en');
    expect(result.system.length).toBeGreaterThan(0);
    expect(result.user.length).toBeGreaterThan(0);
  });
});

describe('extractCitedChunks', () => {
  it('resolves a single citation marker to its chunk', () => {
    const chunks = [chunk({ chunkId: 1 }), chunk({ chunkId: 2 })];
    const citations = extractCitedChunks('The pan costs $49.99 [1].', chunks);
    expect(citations).toEqual([
      {
        index: 1,
        chunkId: 1,
        publicUrl: chunks[0]?.publicUrl,
        pageNumber: chunks[0]?.pageNumber,
        productRef: chunks[0]?.productRef,
      },
    ]);
  });

  it('resolves multiple distinct citation markers, sorted by index', () => {
    const chunks = [chunk({ chunkId: 1 }), chunk({ chunkId: 2 }), chunk({ chunkId: 3 })];
    const citations = extractCitedChunks('See [3] and also [1].', chunks);
    expect(citations.map((c) => c.index)).toEqual([1, 3]);
  });

  it('deduplicates a citation marker repeated multiple times', () => {
    const chunks = [chunk({ chunkId: 1 })];
    const citations = extractCitedChunks('It is available [1]. Also see [1] again.', chunks);
    expect(citations).toHaveLength(1);
  });

  it('returns an empty array when the answer has no citation markers', () => {
    const chunks = [chunk()];
    expect(extractCitedChunks('No idea.', chunks)).toEqual([]);
  });

  it('silently drops a citation marker that does not map to any chunk', () => {
    const chunks = [chunk({ chunkId: 1 })];
    const citations = extractCitedChunks('See [1] and also [99].', chunks);
    expect(citations.map((c) => c.index)).toEqual([1]);
  });

  it('ignores a citation marker of 0 or negative (not a valid 1-indexed excerpt)', () => {
    const chunks = [chunk({ chunkId: 1 })];
    expect(extractCitedChunks('See [0].', chunks)).toEqual([]);
  });

  it('returns an empty array when there are no chunks at all', () => {
    expect(extractCitedChunks('See [1].', [])).toEqual([]);
  });

  it('handles an answer containing bracketed text that is not a citation', () => {
    const chunks = [chunk({ chunkId: 1 })];
    const citations = extractCitedChunks('Note [see manual] but cite [1].', chunks);
    expect(citations.map((c) => c.index)).toEqual([1]);
  });
});
