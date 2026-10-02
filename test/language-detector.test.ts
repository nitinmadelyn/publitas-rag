import { describe, expect, it } from 'vitest';
import { detectLanguageFromSlug, resolveLanguageCode } from '../src/ingestion/language-detector.js';

describe('detectLanguageFromSlug', () => {
  it('detects English from the slug', () => {
    expect(detectLanguageFromSlug('color-street-stylist-launch-guide-english', 'x')).toBe('en');
  });

  it('detects French from a hyphenated slug', () => {
    expect(detectLanguageFromSlug('color-street-stylist-launch-guide-french', 'x')).toBe('fr');
  });

  it('detects French from the endonym "francais"', () => {
    expect(detectLanguageFromSlug('color-street-core-2023-francais', 'x')).toBe('fr');
  });

  it('detects Spanish from the endonym "espanol", accented, in the title', () => {
    expect(detectLanguageFromSlug('color-street-core-2023-espanol', 'Color Street Core 2023 Español')).toBe(
      'es',
    );
  });

  it('detects Spanish from an accented title even when the slug has no marker', () => {
    expect(detectLanguageFromSlug('core-catalog', 'Catálogo Core en Español')).toBe('es');
  });

  it('detects Portuguese', () => {
    expect(detectLanguageFromSlug('tupperware-digital-09-2026', 'Catálogo Português')).toBe('pt');
  });

  it('returns null when neither slug nor title contains a recognizable language name', () => {
    expect(detectLanguageFromSlug('color-street-opportunity-brochure-canada', 'Opportunity Brochure Canada')).toBeNull();
  });

  it('returns null for a plain slug with no language marker at all', () => {
    expect(detectLanguageFromSlug('core-catalog-eng', 'Core Catalog ENG')).toBeNull();
  });

  it('falls back to the title when the slug has no marker', () => {
    expect(detectLanguageFromSlug('catalog-2023-en-3-full', 'Color Street Core 2023 English')).toBe('en');
  });

  it('is case-insensitive', () => {
    expect(detectLanguageFromSlug('CATALOG-FRENCH-2024', 'x')).toBe('fr');
  });

  it('matches on whole tokens only, not substrings inside an unrelated word', () => {
    // "englishmuffin" is one token, not a match for "english" as a substring.
    expect(detectLanguageFromSlug('englishmuffin-recipes', 'x')).toBeNull();
  });

  it('prefers the slug over the title when both contain a (possibly different) language marker', () => {
    expect(detectLanguageFromSlug('catalog-french', 'Spanish Edition')).toBe('fr');
  });
});

describe('resolveLanguageCode', () => {
  it('keeps configLanguage when slug detection found nothing', () => {
    expect(resolveLanguageCode('en', null)).toEqual({ languageCode: 'en', source: 'config' });
  });

  it('keeps configLanguage when slug detection agrees with it', () => {
    expect(resolveLanguageCode('fr', 'fr')).toEqual({ languageCode: 'fr', source: 'config' });
  });

  it('overrides configLanguage when slug detection disagrees with it', () => {
    expect(resolveLanguageCode('en', 'fr')).toEqual({ languageCode: 'fr', source: 'slug_override' });
  });

  it('overrides even when configLanguage is an empty string', () => {
    expect(resolveLanguageCode('', 'es')).toEqual({ languageCode: 'es', source: 'slug_override' });
  });
});
