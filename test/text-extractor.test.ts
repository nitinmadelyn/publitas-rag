import { describe, expect, it } from 'vitest';
import {
  buildPageChunks,
  buildPageText,
  collectProductIds,
} from '../src/ingestion/text-extractor.js';
import type { MappedPage } from '../src/ingestion/page-mapper.js';
import type { Hotspot, ProductDetail } from '../src/types/publitas-api.js';

function page(hotspots: Hotspot[]): MappedPage {
  return { pageNumber: 1, imagePath: '/a/1', hotspots };
}

function productHotspot(productIds: number[], title?: string | null): Hotspot {
  return {
    id: 1,
    title: title ?? null,
    type: 'product',
    position: { left: 0, top: 0, width: 0.1, height: 0.1 },
    products: productIds.map((id) => ({ id, stub: 'true' })),
  };
}

function product(overrides: Partial<ProductDetail>): ProductDetail {
  return {
    id: 1,
    hotspotId: 1,
    title: 'Default Product',
    description: null,
    price: null,
    discountedPrice: null,
    webshopIdentifier: null,
    webshopUrl: null,
    photos: [],
    ...overrides,
  };
}

describe('collectProductIds', () => {
  it('returns an empty array when there are no product hotspots', () => {
    const pages = [page([])];
    expect(collectProductIds(pages)).toEqual([]);
  });

  it('collects unique product ids across multiple pages', () => {
    const pages = [page([productHotspot([1, 2])]), page([productHotspot([2, 3])])];
    expect(collectProductIds(pages).sort()).toEqual([1, 2, 3]);
  });

  it('ignores non-product hotspot types', () => {
    const link: Hotspot = {
      id: 5,
      title: 'a link',
      type: 'externalLink',
      url: 'https://example.com',
      position: { left: 0, top: 0, width: 0.1, height: 0.1 },
    };
    expect(collectProductIds([page([link])])).toEqual([]);
  });
});

describe('buildPageText', () => {
  it('renders a resolved product with title, price, and description', () => {
    const lookup = new Map([
      [1, product({ id: 1, title: 'Wok', price: 24.99, description: 'A nice wok' })],
    ]);
    const text = buildPageText(page([productHotspot([1])]), lookup);
    expect(text).toContain('Wok');
    expect(text).toContain('24.99');
    expect(text).toContain('A nice wok');
  });

  it('renders discounted price alongside original price', () => {
    const lookup = new Map([
      [1, product({ id: 1, title: 'Wok', price: 24.99, discountedPrice: 19.99 })],
    ]);
    const text = buildPageText(page([productHotspot([1])]), lookup);
    expect(text).toContain('was 24.99');
    expect(text).toContain('now 19.99');
  });

  it('does not render a discount block when discountedPrice is not lower than price', () => {
    const lookup = new Map([
      [1, product({ id: 1, title: 'Wok', price: 24.99, discountedPrice: 24.99 })],
    ]);
    const text = buildPageText(page([productHotspot([1])]), lookup);
    expect(text).not.toContain('was');
    expect(text).toContain('(24.99)');
  });

  it('falls back to hotspot title when product lookup returns null (fetch failed)', () => {
    const lookup = new Map<number, ProductDetail | null>([[1, null]]);
    const text = buildPageText(page([productHotspot([1], 'Fallback title')]), lookup);
    expect(text).toBe('Fallback title');
  });

  it('produces empty string when product lookup is null and hotspot has no title', () => {
    const lookup = new Map<number, ProductDetail | null>([[1, null]]);
    const text = buildPageText(page([productHotspot([1], null)]), lookup);
    expect(text).toBe('');
  });

  it('produces empty string when product id is missing from lookup entirely', () => {
    const lookup = new Map<number, ProductDetail | null>();
    const text = buildPageText(page([productHotspot([1], null)]), lookup);
    expect(text).toBe('');
  });

  it('includes externalLink hotspot titles', () => {
    const link: Hotspot = {
      id: 2,
      title: 'Visit our site',
      type: 'externalLink',
      url: 'https://example.com',
      position: { left: 0, top: 0, width: 0.1, height: 0.1 },
    };
    const text = buildPageText(page([link]), new Map());
    expect(text).toBe('Visit our site');
  });

  it('includes pageReference hotspot titles', () => {
    const ref: Hotspot = {
      id: 3,
      title: 'Go to page 2',
      type: 'pageReference',
      pageNumber: '2',
      position: { left: 0, top: 0, width: 0.1, height: 0.1 },
    };
    const text = buildPageText(page([ref]), new Map());
    expect(text).toBe('Go to page 2');
  });

  it('includes video hotspot titles', () => {
    const video: Hotspot = {
      id: 4,
      title: 'Watch this',
      type: 'video',
      youtubeId: 'abc123',
      position: { left: 0, top: 0, width: 0.1, height: 0.1 },
    };
    const text = buildPageText(page([video]), new Map());
    expect(text).toBe('Watch this');
  });

  it('skips non-product hotspots with a null title', () => {
    const link: Hotspot = {
      id: 2,
      title: null,
      type: 'externalLink',
      url: 'https://example.com',
      position: { left: 0, top: 0, width: 0.1, height: 0.1 },
    };
    const text = buildPageText(page([link]), new Map());
    expect(text).toBe('');
  });

  it('joins multiple hotspots with a period separator', () => {
    const lookup = new Map([[1, product({ id: 1, title: 'Wok' })]]);
    const link: Hotspot = {
      id: 2,
      title: 'Visit site',
      type: 'externalLink',
      url: 'https://example.com',
      position: { left: 0, top: 0, width: 0.1, height: 0.1 },
    };
    const text = buildPageText(page([productHotspot([1]), link]), lookup);
    expect(text).toBe('Wok. Visit site');
  });

  it('returns empty string for a page with no hotspots at all', () => {
    expect(buildPageText(page([]), new Map())).toBe('');
  });
});

describe('buildPageChunks', () => {
  it('returns an empty array for a page with no hotspots', () => {
    expect(buildPageChunks(page([]), new Map())).toEqual([]);
  });

  it('produces one chunk per resolved product, tagged with its product id', () => {
    const lookup = new Map([[1, product({ id: 1, title: 'Wok', price: 24.99 })]]);
    const chunks = buildPageChunks(page([productHotspot([1])]), lookup);
    expect(chunks).toEqual([{ text: 'Wok (24.99)', productRef: '1' }]);
  });

  it('produces one chunk per product hotspot when there are several on a page', () => {
    const lookup = new Map([
      [1, product({ id: 1, title: 'Wok' })],
      [2, product({ id: 2, title: 'Pan' })],
    ]);
    const hotspotA = productHotspot([1]);
    const hotspotB = { ...productHotspot([2]), id: 2 };
    const chunks = buildPageChunks(page([hotspotA, hotspotB]), lookup);
    expect(chunks).toEqual([
      { text: 'Wok', productRef: '1' },
      { text: 'Pan', productRef: '2' },
    ]);
  });

  it('produces a separate chunk for every product referenced by a single hotspot (bug fix: previously only the first was kept)', () => {
    const lookup = new Map([
      [1, product({ id: 1, title: 'Wok' })],
      [2, product({ id: 2, title: 'Pan' })],
      [3, product({ id: 3, title: 'Lid' })],
    ]);
    const chunks = buildPageChunks(page([productHotspot([1, 2, 3])]), lookup);
    expect(chunks).toEqual([
      { text: 'Wok', productRef: '1' },
      { text: 'Pan', productRef: '2' },
      { text: 'Lid', productRef: '3' },
    ]);
  });

  it('falls back to the hotspot title (tagged with the product id) when a product fails to resolve', () => {
    const lookup = new Map<number, ProductDetail | null>([[1, null]]);
    const chunks = buildPageChunks(page([productHotspot([1], 'Fallback title')]), lookup);
    expect(chunks).toEqual([{ text: 'Fallback title', productRef: '1' }]);
  });

  it('produces no chunk for a product that fails to resolve and has no fallback title', () => {
    const lookup = new Map<number, ProductDetail | null>([[1, null]]);
    const chunks = buildPageChunks(page([productHotspot([1], null)]), lookup);
    expect(chunks).toEqual([]);
  });

  it('combines multiple non-product hotspots into a single trailing chunk', () => {
    const link: Hotspot = {
      id: 2,
      title: 'Visit our site',
      type: 'externalLink',
      url: 'https://example.com',
      position: { left: 0, top: 0, width: 0.1, height: 0.1 },
    };
    const video: Hotspot = {
      id: 3,
      title: 'Watch this',
      type: 'video',
      youtubeId: 'abc123',
      position: { left: 0, top: 0, width: 0.1, height: 0.1 },
    };
    const chunks = buildPageChunks(page([link, video]), new Map());
    expect(chunks).toEqual([{ text: 'Visit our site. Watch this', productRef: null }]);
  });

  it('places product chunks before the combined non-product chunk, regardless of hotspot order on the page', () => {
    const lookup = new Map([[1, product({ id: 1, title: 'Wok' })]]);
    const link: Hotspot = {
      id: 2,
      title: 'Visit site',
      type: 'externalLink',
      url: 'https://example.com',
      position: { left: 0, top: 0, width: 0.1, height: 0.1 },
    };
    // Link appears BEFORE the product hotspot in source order.
    const chunks = buildPageChunks(page([link, productHotspot([1])]), lookup);
    expect(chunks).toEqual([
      { text: 'Wok', productRef: '1' },
      { text: 'Visit site', productRef: null },
    ]);
  });

  it('produces only the combined chunk when a page has no product hotspots at all', () => {
    const ref: Hotspot = {
      id: 3,
      title: 'Go to page 2',
      type: 'pageReference',
      pageNumber: '2',
      position: { left: 0, top: 0, width: 0.1, height: 0.1 },
    };
    const chunks = buildPageChunks(page([ref]), new Map());
    expect(chunks).toEqual([{ text: 'Go to page 2', productRef: null }]);
  });

  it('produces no combined chunk when every non-product hotspot has a null title', () => {
    const link: Hotspot = {
      id: 2,
      title: null,
      type: 'externalLink',
      url: 'https://example.com',
      position: { left: 0, top: 0, width: 0.1, height: 0.1 },
    };
    expect(buildPageChunks(page([link]), new Map())).toEqual([]);
  });

  it('preserves discount formatting inside a product chunk', () => {
    const lookup = new Map([
      [1, product({ id: 1, title: 'Wok', price: 24.99, discountedPrice: 19.99 })],
    ]);
    const chunks = buildPageChunks(page([productHotspot([1])]), lookup);
    expect(chunks[0]?.text).toBe('Wok (was 24.99, now 19.99)');
  });

  it('buildPageText stays consistent with buildPageChunks (joins the same chunk texts)', () => {
    const lookup = new Map([[1, product({ id: 1, title: 'Wok' })]]);
    const link: Hotspot = {
      id: 2,
      title: 'Visit site',
      type: 'externalLink',
      url: 'https://example.com',
      position: { left: 0, top: 0, width: 0.1, height: 0.1 },
    };
    const testPage = page([productHotspot([1]), link]);
    const chunks = buildPageChunks(testPage, lookup);
    const text = buildPageText(testPage, lookup);
    expect(text).toBe(chunks.map((c) => c.text).join('. '));
  });
});
