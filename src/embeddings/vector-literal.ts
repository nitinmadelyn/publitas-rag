/**
 * Converts a JS number array into pgvector's text input format, e.g.
 * "[0.012,-0.045,...]". node-postgres has no native pgvector type support,
 * so writes cast this string to `vector` in SQL ($n::vector) rather than
 * depending on the `pgvector` npm package for a single conversion.
 */
export function toVectorLiteral(embedding: readonly number[], expectedDimensions: number): string {
  if (embedding.length !== expectedDimensions) {
    throw new Error(
      `Embedding has ${embedding.length} dimensions, expected ${expectedDimensions}`,
    );
  }
  for (const value of embedding) {
    if (!Number.isFinite(value)) {
      throw new Error('Embedding contains a non-finite value (NaN or Infinity)');
    }
  }
  return `[${embedding.join(',')}]`;
}
