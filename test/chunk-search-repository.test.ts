import { describe, expect, it } from 'vitest';
import { buildVectorSearchQuery, buildLexicalSearchQuery } from '../src/retrieval/chunk-search-repository.js';

describe('buildVectorSearchQuery', () => {
  it('builds params in the correct order', () => {
    const built = buildVectorSearchQuery({
      queryVectorLiteral: '[0.1,0.2]',
      catalogId: 7,
      languageCode: 'en',
      limit: 8,
    });
    expect(built.params).toEqual(['[0.1,0.2]', 7, 'en', 8]);
  });

  it('orders by cosine distance ascending (closest first) via the <=> operator', () => {
    const built = buildVectorSearchQuery({
      queryVectorLiteral: '[0.1]',
      catalogId: 1,
      languageCode: 'en',
      limit: 5,
    });
    expect(built.text).toContain('ORDER BY c.embedding <=> $1::vector');
  });

  it('excludes chunks that have not been embedded yet', () => {
    const built = buildVectorSearchQuery({
      queryVectorLiteral: '[0.1]',
      catalogId: 1,
      languageCode: 'en',
      limit: 5,
    });
    expect(built.text).toContain('c.embedding IS NOT NULL');
  });

  it('scopes to a single catalog and language', () => {
    const built = buildVectorSearchQuery({
      queryVectorLiteral: '[0.1]',
      catalogId: 1,
      languageCode: 'en',
      limit: 5,
    });
    expect(built.text).toContain('c.catalog_id = $2');
    expect(built.text).toContain('c.language_code = $3');
  });
});

describe('buildLexicalSearchQuery', () => {
  it('builds params in the correct order', () => {
    const built = buildLexicalSearchQuery({
      queryText: 'wok',
      catalogId: 7,
      languageCode: 'en',
      minSimilarity: 0.3,
      limit: 10,
    });
    expect(built.params).toEqual(['wok', 7, 'en', 0.3, 10]);
  });

  it('filters and orders by pg_trgm similarity()', () => {
    const built = buildLexicalSearchQuery({
      queryText: 'wok',
      catalogId: 1,
      languageCode: 'en',
      minSimilarity: 0.3,
      limit: 10,
    });
    expect(built.text).toContain('similarity(c.text, $1) >= $4');
    expect(built.text).toContain('ORDER BY score DESC');
  });

  it('scopes to a single catalog and language', () => {
    const built = buildLexicalSearchQuery({
      queryText: 'wok',
      catalogId: 1,
      languageCode: 'en',
      minSimilarity: 0.3,
      limit: 10,
    });
    expect(built.text).toContain('c.catalog_id = $2');
    expect(built.text).toContain('c.language_code = $3');
  });
});
