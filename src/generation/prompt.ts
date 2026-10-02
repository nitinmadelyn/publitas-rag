import type { RetrievedChunk } from '../retrieval/retrieve.js';

/**
 * A citation the model actually referenced in its answer, resolved back
 * to the retrieved chunk it points at. index matches the [n] marker the
 * model was instructed to use in prose.
 */
export interface Citation {
  index: number;
  chunkId: number;
  publicUrl: string;
  pageNumber: number;
  productRef: string | null;
}

export interface BuiltPrompt {
  system: string;
  user: string;
}

const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  pt: 'Portuguese',
  de: 'German',
  nl: 'Dutch',
  it: 'Italian',
};

function languageInstruction(languageCode: string): string {
  const name = LANGUAGE_NAMES[languageCode.toLowerCase()];
  return name
    ? `Answer in ${name} (language code: ${languageCode}).`
    : `Answer in the language identified by the code "${languageCode}".`;
}

/**
 * The system prompt is the single place grounding and citation discipline
 * are enforced: no outside knowledge, every claim cited, an explicit
 * instruction to say so rather than guess when the context is
 * insufficient. This is a pure function of languageCode so it is trivial
 * to unit test and safe to call on every request without any I/O.
 */
export function buildSystemPrompt(languageCode: string): string {
  return [
    'You are a shopping assistant answering questions about a single retail catalogue, using only the numbered excerpts the user provides as context.',
    'Rules:',
    '- Answer using only information in the provided excerpts. Do not use outside knowledge and do not guess.',
    '- Every factual claim must be followed by a citation marker like [1] or [2] referencing the excerpt number it came from. Use only the excerpt numbers given, never invent one.',
    '- If the excerpts do not contain enough information to answer the question, say so plainly instead of guessing.',
    '- Be concise and direct; this is a shopper looking for a quick answer, not an essay.',
    languageInstruction(languageCode),
  ].join('\n');
}

function formatChunk(chunk: RetrievedChunk, index: number): string {
  const productLine = chunk.productRef !== null ? `Product reference: ${chunk.productRef}\n` : '';
  return `[${index}] (catalogue page ${chunk.pageNumber})\n${productLine}${chunk.text}`;
}

/**
 * Builds the user-turn content: the retrieved chunks as numbered excerpts
 * (1-indexed, in the order retrieval ranked them), followed by the
 * question. The excerpt numbering here is the contract extractCitedChunks
 * relies on to map a [n] marker in the model's answer back to a chunk.
 */
export function buildUserPrompt(query: string, chunks: readonly RetrievedChunk[]): string {
  const context = chunks.map((chunk, i) => formatChunk(chunk, i + 1)).join('\n\n');
  return `Context excerpts:\n\n${context}\n\nQuestion: ${query}`;
}

export function buildGenerationPrompt(
  query: string,
  chunks: readonly RetrievedChunk[],
  languageCode: string,
): BuiltPrompt {
  return {
    system: buildSystemPrompt(languageCode),
    user: buildUserPrompt(query, chunks),
  };
}

const CITATION_PATTERN = /\[(\d+)\]/g;

/**
 * Scans the model's answer text for [n] markers and resolves each unique
 * one back to the chunk it refers to (1-indexed, matching the numbering
 * buildUserPrompt used). A marker number the model hallucinated that does
 * not correspond to any excerpt actually provided is silently dropped
 * rather than surfaced as a broken citation, since the UI consuming this
 * result should never link to something that does not exist.
 */
export function extractCitedChunks(
  answerText: string,
  chunks: readonly RetrievedChunk[],
): Citation[] {
  const citedIndexes = new Set<number>();

  for (const match of answerText.matchAll(CITATION_PATTERN)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      citedIndexes.add(parsed);
    }
  }

  const sortedIndexes = Array.from(citedIndexes).sort((a, b) => a - b);
  const citations: Citation[] = [];

  for (const index of sortedIndexes) {
    const chunk = chunks[index - 1];
    if (!chunk) continue;
    citations.push({
      index,
      chunkId: chunk.chunkId,
      publicUrl: chunk.publicUrl,
      pageNumber: chunk.pageNumber,
      productRef: chunk.productRef,
    });
  }

  return citations;
}
