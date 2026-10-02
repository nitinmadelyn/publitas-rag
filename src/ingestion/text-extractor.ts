import type { MappedPage } from './page-mapper.js';
import type { ProductDetail } from '../types/publitas-api.js';

/** Every distinct product id referenced by product-type hotspots across a set of pages. */
export function collectProductIds(pages: readonly MappedPage[]): number[] {
  const ids = new Set<number>();
  for (const page of pages) {
    for (const hotspot of page.hotspots) {
      if (hotspot.type === 'product') {
        for (const product of hotspot.products) {
          ids.add(product.id);
        }
      }
    }
  }
  return Array.from(ids);
}

function formatPrice(
  price: number | null | undefined,
  discounted: number | null | undefined,
): string {
  if (price == null) return '';
  if (discounted != null && discounted < price) {
    return ` (was ${price}, now ${discounted})`;
  }
  return ` (${price})`;
}

export interface ChunkCandidate {
  text: string;
  /** Product id this chunk is about, as a string (matches chunks.product_ref TEXT), or null for non-product chunks. */
  productRef: string | null;
}

/**
 * Builds one retrievable chunk per meaningful unit on a page: one chunk
 * per product hotspot (independently retrievable and citable, since a
 * shopper query about one product shouldn't be diluted by five other
 * products crammed onto the same page), plus at most one combined chunk
 * for any non-product hotspots (links, page references, video titles),
 * which carry lower retrieval value individually.
 *
 * `productLookup` must already contain resolved ProductDetail (or null,
 * if that product's fetch failed) for every product id the page
 * references; fetching happens once per publication in the ingestion
 * orchestrator, not per page, to dedupe repeated product references and
 * to keep this function free of I/O.
 */
export function buildPageChunks(
  page: MappedPage,
  productLookup: ReadonlyMap<number, ProductDetail | null>,
): ChunkCandidate[] {
  const chunks: ChunkCandidate[] = [];
  const otherParts: string[] = [];

  for (const hotspot of page.hotspots) {
    switch (hotspot.type) {
      case 'product': {
        // A product hotspot's `products` field is an array (the API
        // schema allows more than one product per hotspot), so every
        // entry gets its own chunk rather than only the first.
        for (const productRef of hotspot.products) {
          const product = productLookup.get(productRef.id);
          if (product) {
            const price = formatPrice(product.price, product.discountedPrice);
            const description = product.description ? ` - ${product.description}` : '';
            chunks.push({
              text: `${product.title}${price}${description}`,
              productRef: String(productRef.id),
            });
          } else if (hotspot.title) {
            // Product fetch failed or product not in lookup; fall back to
            // whatever title the hotspot itself carries, if any. Still
            // tag it with the product id so it stays traceable even
            // though enrichment failed.
            chunks.push({ text: hotspot.title, productRef: String(productRef.id) });
          }
        }
        break;
      }
      case 'externalLink':
      case 'pageReference':
      case 'video': {
        if (hotspot.title) {
          otherParts.push(hotspot.title);
        }
        break;
      }
    }
  }

  if (otherParts.length > 0) {
    chunks.push({ text: otherParts.join('. '), productRef: null });
  }

  return chunks;
}

/**
 * Convenience wrapper returning a single concatenated string for a page,
 * used for `pages.raw_text` (a human-readable/debuggable summary of the
 * page), not for retrieval, retrieval reads `chunks`, which preserves
 * per-product granularity that this flattened form loses.
 */
export function buildPageText(
  page: MappedPage,
  productLookup: ReadonlyMap<number, ProductDetail | null>,
): string {
  return buildPageChunks(page, productLookup)
    .map((c) => c.text)
    .join('. ')
    .trim();
}
