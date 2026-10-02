import { HttpClient } from '../lib/http-client.js';
import { logger } from '../lib/logger.js';
import {
  publicationListSchema,
  publicationDetailSchema,
  productDetailSchema,
  hotspotSchema,
  type PublicationListItem,
  type PublicationDetail,
  type ProductDetail,
} from '../types/publitas-api.js';

export class PublitasApiValidationError extends Error {
  readonly url: string;
  readonly issues: string;

  constructor(url: string, issues: string) {
    super(`Publitas API response at ${url} did not match expected shape: ${issues}`);
    this.name = 'PublitasApiValidationError';
    this.url = url;
    this.issues = issues;
  }
}

export interface PublitasClientOptions {
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  fetchImpl?: typeof fetch;
}

interface SpreadLike {
  hotspots?: unknown;
  [key: string]: unknown;
}

// Publitas' own API docs have already proven wrong once in practice: a
// video hotspot an editor never finished configuring came back with
// youtubeId: null on a live catalog, though the docs (and our schema,
// before this fix) say it is always a string. Rather than reject an
// entire multi-page publication over one editor's unfinished hotspot,
// drop just that hotspot and log a warning so the loss is visible.
function dropMalformedHotspots(raw: unknown, url: string): unknown {
  if (raw === null || typeof raw !== 'object' || !('spreads' in raw)) {
    return raw;
  }
  const spreadsValue = (raw as { spreads?: unknown }).spreads;
  if (!Array.isArray(spreadsValue)) {
    return raw;
  }

  const sanitizedSpreads = spreadsValue.map((spread: unknown, spreadIndex: number) => {
    if (spread === null || typeof spread !== 'object' || !('hotspots' in spread)) {
      return spread;
    }
    const spreadLike = spread as SpreadLike;
    if (!Array.isArray(spreadLike.hotspots)) {
      return spread;
    }

    const validHotspots = spreadLike.hotspots.filter((hotspot: unknown, hotspotIndex: number) => {
      const result = hotspotSchema.safeParse(hotspot);
      if (!result.success) {
        const issues = result.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ');
        logger.warn(
          { url, spreadIndex, hotspotIndex, issues },
          'Dropping malformed hotspot that failed schema validation',
        );
      }
      return result.success;
    });

    return { ...spreadLike, hotspots: validHotspots };
  });

  return { ...(raw as object), spreads: sanitizedSpreads };
}

export class PublitasClient {
  private readonly baseUrl: string;
  private readonly http: HttpClient;

  constructor(options: PublitasClientOptions) {
    // Normalize: strip a trailing slash so URL building below never
    // produces a double slash regardless of how the base URL was configured.
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.http = new HttpClient({
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    });
  }

  /**
   * Lists every publication in a group. The v1 API returns the full list
   * in one response, there is no pagination parameter documented or
   * observed; a very large group's list is still a single JSON array
   * response. If Publitas introduces pagination in the future, this is
   * the method that would need a cursor/offset loop added.
   */
  async listPublications(groupSlug: string): Promise<PublicationListItem[]> {
    const url = `${this.baseUrl}/groups/${encodeURIComponent(groupSlug)}/publications.json`;
    const raw = await this.http.getJson<unknown>(url);

    const parsed = publicationListSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new PublitasApiValidationError(url, issues);
    }
    return parsed.data;
  }

  async getPublication(groupSlug: string, publicationSlug: string): Promise<PublicationDetail> {
    const url = `${this.baseUrl}/groups/${encodeURIComponent(groupSlug)}/publications/${encodeURIComponent(publicationSlug)}.json`;
    const raw = await this.http.getJson<unknown>(url);

    // One malformed hotspot (an editor's half-finished video embed, a
    // stray null field) should not reject an otherwise-good 40 page
    // publication. Drop bad hotspots individually, with a warning log,
    // before validating the publication as a whole.
    const sanitized = dropMalformedHotspots(raw, url);

    const parsed = publicationDetailSchema.safeParse(sanitized);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new PublitasApiValidationError(url, issues);
    }
    return parsed.data;
  }

  async getProduct(
    groupSlug: string,
    publicationSlug: string,
    productId: number,
  ): Promise<ProductDetail | null> {
    const url = `${this.baseUrl}/groups/${encodeURIComponent(groupSlug)}/publications/${encodeURIComponent(publicationSlug)}/products/${productId}.json`;

    try {
      const raw = await this.http.getJson<unknown>(url);
      const parsed = productDetailSchema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ');
        throw new PublitasApiValidationError(url, issues);
      }
      return parsed.data;
    } catch (err) {
      // A single missing/broken product should not fail the whole
      // publication ingest. Log and treat as "no product data available",
      // the text extractor falls back to the hotspot title (if any).
      logger.warn(
        { err, url, groupSlug, publicationSlug, productId },
        'Failed to fetch product detail',
      );
      return null;
    }
  }
}
