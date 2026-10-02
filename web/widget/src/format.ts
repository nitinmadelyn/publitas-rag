import type { Citation } from './types.js';

const HTML_ESCAPE_PATTERN = /[&<>"']/g;
const HTML_ESCAPE_MAP: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escapes text for safe insertion into innerHTML. The widget renders the
 * model's answer as HTML (so linkifyCitations below can turn [n] markers
 * into real links), so every piece of text that reaches the DOM - the
 * answer, a user's own question echoed back, an error message - must go
 * through this first. Never trust generated or user-supplied text
 * directly in innerHTML.
 */
export function escapeHtml(text: string): string {
  return text.replace(HTML_ESCAPE_PATTERN, (char) => {
    const replacement = HTML_ESCAPE_MAP[char];
    return replacement ?? char;
  });
}

const CITATION_MARKER_PATTERN = /\[(\d+)\]/g;

/**
 * Turns [n] citation markers in an already-escaped answer into clickable
 * links to that citation's source catalog page. Takes escaped input and
 * returns escaped-plus-markup output - never call this before
 * escapeHtml, or the injected <a> tags would themselves get escaped away.
 * A marker number with no matching citation (filtered out server-side, or
 * just literal brackets in prose) is left as plain text instead of
 * becoming a dead link.
 */
export function linkifyCitations(escapedAnswer: string, citations: readonly Citation[]): string {
  const byIndex = new Map(citations.map((citation) => [citation.index, citation]));

  return escapedAnswer.replace(CITATION_MARKER_PATTERN, (match: string, rawIndex: string): string => {
    const index = Number.parseInt(rawIndex, 10);
    const citation = byIndex.get(index);
    if (!citation) return match;
    return `<a href="${escapeHtml(citation.publicUrl)}" target="_blank" rel="noopener noreferrer" class="prag-citation">${match}</a>`;
  });
}

/** Composes escaping and citation linking into the one call the UI layer needs. */
export function renderAnswerHtml(answer: string, citations: readonly Citation[]): string {
  return linkifyCitations(escapeHtml(answer), citations);
}
