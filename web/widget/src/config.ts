export interface WidgetConfig {
  apiBaseUrl: string;
  apiKey: string;
  catalogSlug: string;
  languageCode: string;
  title: string;
  placeholder: string;
  greeting: string;
  bubbleText: string;
}

/**
 * The raw data-* attributes read off the embedding <script> tag. Kept as
 * an explicit interface (rather than DOMStringMap directly) so
 * parseWidgetConfig stays pure and DOM-free: widget.ts is the only file
 * that touches document.currentScript.dataset, and it passes that value
 * in as a plain object here.
 */
export interface RawWidgetDataset {
  // `?: string | undefined` (not plain `?: string`) on purpose: under
  // exactOptionalPropertyTypes those are different shapes. Plain `?:
  // string` forbids ever assigning `undefined` to a present key; this
  // codebase builds RawWidgetDataset both by omitting keys (in tests)
  // and by copying values straight off a DOMStringMap (in widget.ts),
  // where noUncheckedIndexedAccess types every property read as
  // `string | undefined` even though the key itself always exists.
  apiBaseUrl?: string | undefined;
  apiKey?: string | undefined;
  catalog?: string | undefined;
  lang?: string | undefined;
  title?: string | undefined;
  placeholder?: string | undefined;
  greeting?: string | undefined;
  bubbleText?: string | undefined;
}

export class WidgetConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WidgetConfigError';
  }
}

const DEFAULT_TITLE = 'Ask about this catalog';
const DEFAULT_PLACEHOLDER = 'Type your question...';
const DEFAULT_GREETING =
  "Hi! Ask me anything about this catalog and I'll answer using what's actually in it.";
// Shown in a small teaser bubble next to the launcher button before the
// visitor has opened the chat, to prompt them to engage. Overridable per
// embed via data-bubble-text (e.g. for a catalog-specific hook or a
// language other than the widget copy's default English).
const DEFAULT_BUBBLE_TEXT = 'Looking for something specific? Ask me \u{1F44B}';

/**
 * Validates and normalizes the script tag's data-* attributes into a
 * WidgetConfig. Deliberately hand-rolled rather than pulling in zod (used
 * everywhere on the server side): this file ships to every visitor's
 * browser as part of the bundle, and a validation library that exists to
 * report every issue in a request body is unnecessary weight for four
 * required strings read once at page load. Reports the first missing
 * attribute rather than all of them, which is enough for a site owner
 * debugging their own embed snippet.
 */
export function parseWidgetConfig(dataset: RawWidgetDataset): WidgetConfig {
  const apiBaseUrl = dataset.apiBaseUrl?.trim();
  if (!apiBaseUrl) {
    throw new WidgetConfigError(
      'Missing required attribute on the widget script tag: data-api-base-url',
    );
  }

  const apiKey = dataset.apiKey?.trim();
  if (!apiKey) {
    throw new WidgetConfigError('Missing required attribute on the widget script tag: data-api-key');
  }

  const catalogSlug = dataset.catalog?.trim();
  if (!catalogSlug) {
    throw new WidgetConfigError('Missing required attribute on the widget script tag: data-catalog');
  }

  const languageCode = dataset.lang?.trim();
  if (!languageCode) {
    throw new WidgetConfigError('Missing required attribute on the widget script tag: data-lang');
  }

  return {
    // Strips a trailing slash so `${apiBaseUrl}/v1/...` never produces a
    // double slash regardless of how the site owner wrote the attribute.
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ''),
    apiKey,
    catalogSlug,
    languageCode,
    title: withDefault(dataset.title, DEFAULT_TITLE),
    placeholder: withDefault(dataset.placeholder, DEFAULT_PLACEHOLDER),
    greeting: withDefault(dataset.greeting, DEFAULT_GREETING),
    bubbleText: withDefault(dataset.bubbleText, DEFAULT_BUBBLE_TEXT),
  };
}

/**
 * Falls back to `fallback` for both an absent value and an explicitly
 * empty/whitespace-only one (`data-title=""` should behave the same as
 * omitting data-title entirely) - `??` alone wouldn't cover the empty-
 * string case, so this is a named helper instead of an inline `||`.
 */
function withDefault(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}
