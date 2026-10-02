import type { Hotspot, Spread } from '../types/publitas-api.js';

export interface MappedPage {
  pageNumber: number;
  /** Relative image path from the API, e.g. "/1230/10323/pages/abc123" */
  imagePath: string;
  hotspots: Hotspot[];
}

class MalformedSpreadError extends Error {
  constructor(reason: string) {
    super(`Malformed spread from Publitas API: ${reason}`);
    this.name = 'MalformedSpreadError';
  }
}

/**
 * Publitas returns hotspots at the spread level (1-2 pages per spread),
 * anchored with `position.left` in [0, 1] across the WHOLE spread width,
 * not per individual page. To assign a hotspot to a single page for
 * per-page text extraction, we split two-page spreads at the midpoint:
 * left < 0.5 belongs to the first (left) page, left >= 0.5 to the second
 * (right) page. A hotspot straddling the exact midpoint is an edge case
 * Publitas' own reader doesn't disambiguate either; this heuristic is
 * good enough for retrieval text and is intentionally simple rather than
 * trying to model partial overlap.
 */
export function mapSpreadsToPages(spreads: readonly Spread[]): MappedPage[] {
  const pages: MappedPage[] = [];
  let pageNumber = 0;

  for (const spread of spreads) {
    const hotspots = spread.hotspots ?? [];
    const [firstImagePath, secondImagePath] = spread.pages;

    // The zod schema guarantees spread.pages has 1-2 entries, but that
    // guarantee doesn't flow through to TypeScript's array indexing.
    // Rather than silence the checker with an assertion, treat an
    // actually-empty array as the malformed-API-response case it would
    // have to be, and fail loudly instead of silently producing a page
    // with an undefined image path.
    if (firstImagePath === undefined) {
      throw new MalformedSpreadError('spread.pages was empty after schema validation');
    }

    if (spread.pages.length === 1) {
      pageNumber += 1;
      pages.push({
        pageNumber,
        imagePath: firstImagePath,
        hotspots,
      });
      continue;
    }

    if (secondImagePath === undefined) {
      throw new MalformedSpreadError(
        'spread.pages reported length 2 but second entry was undefined',
      );
    }

    // Two-page spread: split hotspots by horizontal midpoint.
    const leftHotspots = hotspots.filter((h) => h.position.left < 0.5);
    const rightHotspots = hotspots.filter((h) => h.position.left >= 0.5);

    pageNumber += 1;
    pages.push({
      pageNumber,
      imagePath: firstImagePath,
      hotspots: leftHotspots,
    });

    pageNumber += 1;
    pages.push({
      pageNumber,
      imagePath: secondImagePath,
      hotspots: rightHotspots,
    });
  }

  return pages;
}
