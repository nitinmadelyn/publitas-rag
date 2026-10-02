/**
 * Publitas' own `config.language` field has proven unreliable in
 * practice: a whole catalog group (color_street) was observed with
 * config.language = 'en' on every publication, including ones titled
 * "Color Street Core 2023 Espanol" and "...Francais" — the same class of
 * API data-quality issue already hit with a hotspot's youtubeId field
 * being documented as always-string but observed null.
 *
 * As a defense, this module detects a language from the publication's own
 * slug/title (retailers reliably encode it there, e.g.
 * "color-street-stylist-launch-guide-french"), and ingest-publication.ts
 * prefers that over config.language when the two disagree, logging a
 * warning so the mismatch is visible rather than silently corrected away.
 *
 * Deliberately narrow: only full-word matches against a small set of
 * language names/endonyms are recognized, so an unrelated slug (e.g. one
 * containing "canada", a country, not a language) is left alone and falls
 * back to config.language rather than risking a wrong guess.
 */
const LANGUAGE_KEYWORDS: Readonly<Record<string, string>> = {
  english: 'en',
  anglais: 'en',
  ingles: 'en',
  french: 'fr',
  francais: 'fr',
  spanish: 'es',
  espanol: 'es',
  portuguese: 'pt',
  portugues: 'pt',
  german: 'de',
  deutsch: 'de',
  dutch: 'nl',
  nederlands: 'nl',
  italian: 'it',
  italiano: 'it',
};

/** Lowercases and strips diacritics (Español -> espanol, Français -> francais) so accented and unaccented spellings match the same keyword. */
function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function findLanguageToken(value: string): string | null {
  const tokens = normalize(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);

  for (const token of tokens) {
    const code = LANGUAGE_KEYWORDS[token];
    if (code) return code;
  }
  return null;
}

/**
 * Looks for a recognizable language name as a whole token in the slug
 * first, then the title. Returns null (not a guess) when neither contains
 * one, letting the caller fall back to config.language.
 */
export function detectLanguageFromSlug(slug: string, title: string): string | null {
  return findLanguageToken(slug) ?? findLanguageToken(title);
}

export type LanguageResolutionSource = 'config' | 'slug_override';

export interface LanguageResolution {
  languageCode: string;
  source: LanguageResolutionSource;
}

/**
 * Decides the language_code actually stored for a publication. Only
 * overrides configLanguage when the slug/title detector found a different,
 * specific language, never when it found nothing (a null detection is not
 * evidence configLanguage is wrong) and never when the two already agree.
 */
export function resolveLanguageCode(
  configLanguage: string,
  slugDetectedLanguage: string | null,
): LanguageResolution {
  if (slugDetectedLanguage !== null && slugDetectedLanguage !== configLanguage) {
    return { languageCode: slugDetectedLanguage, source: 'slug_override' };
  }
  return { languageCode: configLanguage, source: 'config' };
}
