import { describe, expect, it } from 'vitest';
import { buildPendingChunksQuery, buildEmbeddingUpdateQuery } from '../src/embeddings/chunk-repository.js';

describe('buildPendingChunksQuery', () => {
  it('builds a query without a catalog filter when catalogId is omitted', () => {
    const built = buildPendingChunksQuery({ afterId: 0, pageSize: 50, maxAttempts: 5 });
    expect(built.params).toEqual([0, 5, 50]);
    expect(built.text).not.toContain('catalog_id');
    expect(built.text).toContain('LIMIT $3');
  });

  it('builds a query with a catalog filter and correct placeholder numbering when catalogId is given', () => {
    const built = buildPendingChunksQuery({ afterId: 10, pageSize: 50, maxAttempts: 5, catalogId: 7 });
    expect(built.params).toEqual([10, 5, 7, 50]);
    expect(built.text).toContain('catalog_id = $3');
    expect(built.text).toContain('LIMIT $4');
  });

  it('propagates afterId and maxAttempts into the params in the correct positions', () => {
    const built = buildPendingChunksQuery({ afterId: 123, pageSize: 1, maxAttempts: 9 });
    expect(built.params[0]).toBe(123);
    expect(built.params[1]).toBe(9);
  });

  it('always filters on embedding IS NULL and the attempts budget', () => {
    const built = buildPendingChunksQuery({ afterId: 0, pageSize: 10, maxAttempts: 5 });
    expect(built.text).toContain('embedding IS NULL');
    expect(built.text).toContain('embedding_attempts < $2');
  });
});

describe('buildEmbeddingUpdateQuery', () => {
  it('builds a single-row VALUES clause with correctly numbered placeholders', () => {
    const built = buildEmbeddingUpdateQuery(
      [{ chunkId: 1, vectorLiteral: '[0.1,0.2]' }],
      'text-embedding-3-large',
    );
    expect(built.params).toEqual(['text-embedding-3-large', 1, '[0.1,0.2]']);
    expect(built.text).toContain('($2::bigint, $3::vector)');
    expect(built.text).toContain('embedding_model = $1');
  });

  it('builds a multi-row VALUES clause with placeholders advancing correctly across rows', () => {
    const built = buildEmbeddingUpdateQuery(
      [
        { chunkId: 1, vectorLiteral: '[1]' },
        { chunkId: 2, vectorLiteral: '[2]' },
        { chunkId: 3, vectorLiteral: '[3]' },
      ],
      'text-embedding-3-large',
    );
    expect(built.params).toEqual(['text-embedding-3-large', 1, '[1]', 2, '[2]', 3, '[3]']);
    expect(built.text).toContain('($2::bigint, $3::vector)');
    expect(built.text).toContain('($4::bigint, $5::vector)');
    expect(built.text).toContain('($6::bigint, $7::vector)');
  });

  it('resets embedding_attempts and clears embedding_last_error on success', () => {
    const built = buildEmbeddingUpdateQuery([{ chunkId: 1, vectorLiteral: '[1]' }], 'model');
    expect(built.text).toContain('embedding_attempts = 0');
    expect(built.text).toContain('embedding_last_error = NULL');
  });
});
