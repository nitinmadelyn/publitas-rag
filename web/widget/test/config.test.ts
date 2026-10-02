import { describe, expect, it } from 'vitest';
import { parseWidgetConfig, WidgetConfigError, type RawWidgetDataset } from '../src/config.js';

function validDataset(overrides: RawWidgetDataset = {}): RawWidgetDataset {
  return {
    apiBaseUrl: 'https://api.example.com',
    apiKey: 'widget-key-123',
    catalog: 'tupperware-digital-09-2026',
    lang: 'pt',
    ...overrides,
  };
}

describe('parseWidgetConfig', () => {
  it('parses a minimal valid dataset and applies defaults', () => {
    const config = parseWidgetConfig(validDataset());
    expect(config.apiBaseUrl).toBe('https://api.example.com');
    expect(config.apiKey).toBe('widget-key-123');
    expect(config.catalogSlug).toBe('tupperware-digital-09-2026');
    expect(config.languageCode).toBe('pt');
    expect(config.title).toBe('Ask about this catalog');
    expect(config.placeholder.length).toBeGreaterThan(0);
    expect(config.greeting.length).toBeGreaterThan(0);
    expect(config.bubbleText).toBe('Looking for something specific? Ask me \u{1F44B}');
  });

  it('strips a single trailing slash from apiBaseUrl', () => {
    const config = parseWidgetConfig(validDataset({ apiBaseUrl: 'https://api.example.com/' }));
    expect(config.apiBaseUrl).toBe('https://api.example.com');
  });

  it('strips multiple trailing slashes from apiBaseUrl', () => {
    const config = parseWidgetConfig(validDataset({ apiBaseUrl: 'https://api.example.com///' }));
    expect(config.apiBaseUrl).toBe('https://api.example.com');
  });

  it('overrides title, placeholder and greeting when provided', () => {
    const config = parseWidgetConfig(
      validDataset({ title: 'Ask us!', placeholder: 'Your question', greeting: 'Hello there' }),
    );
    expect(config.title).toBe('Ask us!');
    expect(config.placeholder).toBe('Your question');
    expect(config.greeting).toBe('Hello there');
  });

  it('overrides bubbleText when provided', () => {
    const config = parseWidgetConfig(validDataset({ bubbleText: 'Precisa de ajuda?' }));
    expect(config.bubbleText).toBe('Precisa de ajuda?');
  });

  it('falls back to the default bubbleText when the attribute is empty', () => {
    const config = parseWidgetConfig(validDataset({ bubbleText: '   ' }));
    expect(config.bubbleText).toBe('Looking for something specific? Ask me \u{1F44B}');
  });

  it('trims whitespace from every field', () => {
    const config = parseWidgetConfig(
      validDataset({ apiKey: '  widget-key-123  ', catalog: '  tupperware  ', lang: '  pt  ' }),
    );
    expect(config.apiKey).toBe('widget-key-123');
    expect(config.catalogSlug).toBe('tupperware');
    expect(config.languageCode).toBe('pt');
  });

  it('throws WidgetConfigError when apiBaseUrl is missing', () => {
    const dataset = validDataset();
    delete dataset.apiBaseUrl;
    expect(() => parseWidgetConfig(dataset)).toThrow(WidgetConfigError);
  });

  it('throws WidgetConfigError when apiKey is missing', () => {
    const dataset = validDataset();
    delete dataset.apiKey;
    expect(() => parseWidgetConfig(dataset)).toThrow(WidgetConfigError);
  });

  it('throws WidgetConfigError when catalog is missing', () => {
    const dataset = validDataset();
    delete dataset.catalog;
    expect(() => parseWidgetConfig(dataset)).toThrow(WidgetConfigError);
  });

  it('throws WidgetConfigError when lang is missing', () => {
    const dataset = validDataset();
    delete dataset.lang;
    expect(() => parseWidgetConfig(dataset)).toThrow(WidgetConfigError);
  });

  it('treats a whitespace-only required field as missing', () => {
    expect(() => parseWidgetConfig(validDataset({ apiKey: '   ' }))).toThrow(WidgetConfigError);
  });

  it('includes the specific missing attribute name in the error message', () => {
    const dataset = validDataset();
    delete dataset.catalog;
    expect(() => parseWidgetConfig(dataset)).toThrow(/data-catalog/);
  });

  it('reports the first missing field when several are missing', () => {
    expect(() => parseWidgetConfig({})).toThrow(/data-api-base-url/);
  });
});
