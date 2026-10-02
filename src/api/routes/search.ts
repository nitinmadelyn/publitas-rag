import type { FastifyInstance } from 'fastify';
import { catalogSlugParamsSchema, chatRequestBodySchema } from '../schemas.js';
import { retrieveChunks } from '../../retrieval/retrieve.js';
import { config } from '../../config/index.js';
import type { ServerDependencies } from '../types.js';

/**
 * POST /v1/catalogs/:slug/search - retrieval only, no generation call.
 * Cheaper and lower-latency than /chat (skips the Claude round trip
 * entirely), useful for a debug/admin UI, or a client that wants to build
 * its own presentation of raw matches instead of a synthesized answer.
 */
export function registerSearchRoutes(app: FastifyInstance, deps: ServerDependencies): void {
  app.post('/v1/catalogs/:slug/search', async (request, reply) => {
    const params = catalogSlugParamsSchema.parse(request.params);
    const body = chatRequestBodySchema.parse(request.body);

    const results = await retrieveChunks(deps.repository, deps.embeddingClient, {
      query: body.query,
      catalogSlug: params.slug,
      languageCode: body.languageCode,
      topK: config.RETRIEVAL_TOP_K,
      relevanceThreshold: config.RETRIEVAL_RELEVANCE_THRESHOLD,
      embeddingDimensions: config.EMBEDDING_DIMENSIONS,
      lexicalLimit: config.RETRIEVAL_LEXICAL_LIMIT,
      lexicalMinSimilarity: config.RETRIEVAL_LEXICAL_MIN_SIMILARITY,
    });

    return reply.status(200).send({ results });
  });
}
