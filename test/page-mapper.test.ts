import { describe, expect, it } from 'vitest';
import { mapSpreadsToPages } from '../src/ingestion/page-mapper.js';
import type { Hotspot, Spread } from '../src/types/publitas-api.js';

function makeHotspot(overrides: Partial<Hotspot> & { left: number }): Hotspot {
  return {
    id: 1,
    title: 'test hotspot',
    type: 'externalLink',
    url: 'https://example.com',
    position: { left: overrides.left, top: 0, width: 0.1, height: 0.1 },
    ...overrides,
  } as Hotspot;
}

describe('mapSpreadsToPages', () => {
  it('assigns page number 1 to a single-page first spread', () => {
    const spreads: Spread[] = [{ pages: ['/a/1'] }];
    const result = mapSpreadsToPages(spreads);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ pageNumber: 1, imagePath: '/a/1' });
  });

  it('assigns sequential page numbers across a two-page spread', () => {
    const spreads: Spread[] = [{ pages: ['/a/1'] }, { pages: ['/a/2', '/a/3'] }];
    const result = mapSpreadsToPages(spreads);
    expect(result.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    expect(result.map((p) => p.imagePath)).toEqual(['/a/1', '/a/2', '/a/3']);
  });

  it('handles a typical publication shape: single first spread, two-page middles, single or double last', () => {
    const spreads: Spread[] = [
      { pages: ['/a/1'] },
      { pages: ['/a/2', '/a/3'] },
      { pages: ['/a/4', '/a/5'] },
      { pages: ['/a/6'] },
    ];
    const result = mapSpreadsToPages(spreads);
    expect(result.map((p) => p.pageNumber)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('returns an empty array for an empty spreads list', () => {
    expect(mapSpreadsToPages([])).toEqual([]);
  });

  it('assigns hotspots with no hotspots key to empty arrays on both pages', () => {
    const spreads: Spread[] = [{ pages: ['/a/1', '/a/2'] }];
    const result = mapSpreadsToPages(spreads);
    expect(result[0]?.hotspots).toEqual([]);
    expect(result[1]?.hotspots).toEqual([]);
  });

  it('splits hotspots by left < 0.5 to the first page and >= 0.5 to the second', () => {
    const leftHotspot = makeHotspot({ id: 1, left: 0.1 });
    const rightHotspot = makeHotspot({ id: 2, left: 0.9 });
    const spreads: Spread[] = [{ pages: ['/a/1', '/a/2'], hotspots: [leftHotspot, rightHotspot] }];
    const result = mapSpreadsToPages(spreads);
    expect(result[0]?.hotspots).toEqual([leftHotspot]);
    expect(result[1]?.hotspots).toEqual([rightHotspot]);
  });

  it('treats a hotspot at exactly left=0.5 as belonging to the right page', () => {
    const midpointHotspot = makeHotspot({ id: 3, left: 0.5 });
    const spreads: Spread[] = [{ pages: ['/a/1', '/a/2'], hotspots: [midpointHotspot] }];
    const result = mapSpreadsToPages(spreads);
    expect(result[0]?.hotspots).toEqual([]);
    expect(result[1]?.hotspots).toEqual([midpointHotspot]);
  });

  it('assigns all hotspots to the single page of a one-page spread regardless of left position', () => {
    const h1 = makeHotspot({ id: 1, left: 0.1 });
    const h2 = makeHotspot({ id: 2, left: 0.9 });
    const spreads: Spread[] = [{ pages: ['/a/1'], hotspots: [h1, h2] }];
    const result = mapSpreadsToPages(spreads);
    expect(result[0]?.hotspots).toEqual([h1, h2]);
  });

  it('handles multiple spreads each with their own hotspots independently', () => {
    const h1 = makeHotspot({ id: 1, left: 0.1 });
    const h2 = makeHotspot({ id: 2, left: 0.1 });
    const spreads: Spread[] = [
      { pages: ['/a/1'], hotspots: [h1] },
      { pages: ['/a/2', '/a/3'], hotspots: [h2] },
    ];
    const result = mapSpreadsToPages(spreads);
    expect(result[0]?.hotspots).toEqual([h1]);
    expect(result[1]?.hotspots).toEqual([h2]);
    expect(result[2]?.hotspots).toEqual([]);
  });
});
