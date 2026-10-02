import type { RetrievalRepository } from '../retrieval/chunk-search-repository.js';
import type { EmbeddingClientLike, RetrievedChunk } from '../retrieval/retrieve.js';
import { retrieveChunks } from '../retrieval/retrieve.js';
import { buildGenerationPrompt, extractCitedChunks, type Citation } from './prompt.js';
import { logger } from '../lib/logger.js';

/**
 * The minimal shape generate-answer.ts needs from a chat-completion
 * provider. ClaudeClient satisfies this structurally; tests inject a fake.
 */
export interface ClaudeClientLike {
  complete(system: string, userPrompt: string): Promise<string>;
}

export interface GenerateAnswerOptions {
  query: string;
  catalogSlug: string;
  languageCode: string;
  topK: number;
  relevanceThreshold: number;
  embeddingDimensions: number;
  lexicalLimit: number;
  lexicalMinSimilarity: number;
}

export interface GenerateAnswerResult {
  answer: string;
  citations: Citation[];
  retrievedChunks: RetrievedChunk[];
  /** true when retrieval found nothing and the LLM was never called. */
  noContextFound: boolean;
}

/**
 * Canned "nothing found" answers, one per catalogue language this project
 * currently detects (see ingestion/language-detector.ts). Falls back to
 * English for any language code not in this table rather than failing the
 * request outright.
 */
const NO_CONTEXT_ANSWERS: Readonly<Record<string, string>> = {
  en: "I don't have information about that in this catalogue.",
  fr: "Je n'ai pas d'information à ce sujet dans ce catalogue.",
  es: 'No tengo información sobre eso en este catálogo.',
  pt: 'Não tenho informações sobre isso neste catálogo.',
  de: 'Dazu habe ich in diesem Katalog keine Informationen.',
  nl: 'Ik heb daar geen informatie over in deze catalogus.',
  it: 'Non ho informazioni su questo in questo catalogo.',
};

const DEFAULT_NO_CONTEXT_ANSWER = "I don't have information about that in this catalogue.";

function noContextAnswer(languageCode: string): string {
  const answer = NO_CONTEXT_ANSWERS[languageCode.toLowerCase()];
  return answer ?? DEFAULT_NO_CONTEXT_ANSWER;
}

/**
 * The single entry point the chat CLI / API layer calls: retrieves
 * grounding chunks for the query, and only then asks Claude for an answer
 * built strictly from those chunks, with citations resolved back to
 * source pages.
 *
 * Deliberately skips the LLM call entirely when retrieval finds nothing:
 * there is no grounding material to answer from, so calling the model
 * would only risk an ungrounded, uncited guess for the cost of an API
 * call. A canned, language-appropriate "not found" answer is returned
 * instead, and the caller can tell the two cases apart via
 * noContextFound.
 */
export async function generateAnswer(
  repository: RetrievalRepository,
  embeddingClient: EmbeddingClientLike,
  claudeClient: ClaudeClientLike,
  options: GenerateAnswerOptions,
): Promise<GenerateAnswerResult> {
  const retrievedChunks = await retrieveChunks(repository, embeddingClient, {
    query: options.query,
    catalogSlug: options.catalogSlug,
    languageCode: options.languageCode,
    topK: options.topK,
    relevanceThreshold: options.relevanceThreshold,
    embeddingDimensions: options.embeddingDimensions,
    lexicalLimit: options.lexicalLimit,
    lexicalMinSimilarity: options.lexicalMinSimilarity,
  });

  if (retrievedChunks.length === 0) {
    logger.info(
      { catalogSlug: options.catalogSlug, languageCode: options.languageCode },
      'No grounding chunks found for query; skipping the Claude call',
    );
    return {
      answer: noContextAnswer(options.languageCode),
      citations: [],
      retrievedChunks: [],
      noContextFound: true,
    };
  }

  const { system, user } = buildGenerationPrompt(
    options.query,
    retrievedChunks,
    options.languageCode,
  );
  const answer = await claudeClient.complete(system, user);
  const citations = extractCitedChunks(answer, retrievedChunks);

  logger.info(
    {
      catalogSlug: options.catalogSlug,
      languageCode: options.languageCode,
      retrievedCount: retrievedChunks.length,
      citationCount: citations.length,
    },
    'Generated an answer',
  );

  return { answer, citations, retrievedChunks, noContextFound: false };
}
