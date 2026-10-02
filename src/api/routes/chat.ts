import type { FastifyInstance } from 'fastify';
import { catalogSlugParamsSchema, chatRequestBodySchema } from '../schemas.js';
import { generateAnswer } from '../../generation/generate-answer.js';
import { config } from '../../config/index.js';
import type { ServerDependencies } from '../types.js';

/**
 * POST /v1/catalogs/:slug/chat - the main RAG endpoint: retrieves grounding
 * chunks for the query and returns a cited, generated answer (or a
 * canned "not found" answer when nothing relevant exists in the catalog).
 *
 * Request/response shape is validated by zod (schemas.ts); a bad payload
 * throws ZodError, which the server's central error handler turns into a
 * 400 before this handler's body even starts. Any domain error thrown by
 * generateAnswer (CatalogNotFoundError, RetrievalValidationError, or an
 * upstream Claude/OpenAI failure) propagates the same way, so this
 * handler itself contains no try/catch - that is by design, not an
 * oversight.
 */
export function registerChatRoutes(app: FastifyInstance, deps: ServerDependencies): void {
  app.post('/v1/catalogs/:slug/chat', async (request, reply) => {
    const params = catalogSlugParamsSchema.parse(request.params);
    const body = chatRequestBodySchema.parse(request.body);

    const result = await generateAnswer(deps.repository, deps.embeddingClient, deps.claudeClient, {
      query: body.query,
      catalogSlug: params.slug,
      languageCode: body.languageCode,
      topK: config.RETRIEVAL_TOP_K,
      relevanceThreshold: config.RETRIEVAL_RELEVANCE_THRESHOLD,
      embeddingDimensions: config.EMBEDDING_DIMENSIONS,
      lexicalLimit: config.RETRIEVAL_LEXICAL_LIMIT,
      lexicalMinSimilarity: config.RETRIEVAL_LEXICAL_MIN_SIMILARITY,
    });

    return reply.status(200).send({
      answer: result.answer,
      citations: result.citations,
      noContextFound: result.noContextFound,
    });
  });
}
