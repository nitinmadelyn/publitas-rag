import type { RetrievalRepository } from '../retrieval/chunk-search-repository.js';
import type { EmbeddingClientLike } from '../retrieval/retrieve.js';
import type { ClaudeClientLike } from '../generation/generate-answer.js';

/**
 * Everything a route handler needs to do real work, injected rather than
 * imported directly. Production wiring (server.ts's defaultDependencies)
 * points these at the real Postgres-backed repository and real OpenAI/
 * Claude HTTP clients; tests point them at fakes, exactly the same DI
 * pattern used throughout retrieval/ and generation/.
 */
export interface ServerDependencies {
  repository: RetrievalRepository;
  embeddingClient: EmbeddingClientLike;
  claudeClient: ClaudeClientLike;
}
