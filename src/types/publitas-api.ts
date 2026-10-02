import { z } from 'zod';

/**
 * These schemas validate Publitas API responses at runtime, not just at
 * the type level. TypeScript types alone give no protection against the
 * API returning a differently shaped payload (a field renamed, a new
 * required field, an unexpected null); zod turns that into a caught,
 * logged error instead of a silent bad-data write or a crash three
 * layers deeper in text extraction.
 */

// --- GET /v1/groups/:slug/publications.json ---------------------------

export const publicationListItemSchema = z.object({
  id: z.number().int(),
  slug: z.string().min(1),
  title: z.string(),
  browserTitle: z.string().nullable().optional(),
  onlineAt: z.string().nullable(),
  url: z.string().url(),
});
export type PublicationListItem = z.infer<typeof publicationListItemSchema>;

export const publicationListSchema = z.array(publicationListItemSchema);

// --- GET /v1/groups/:slug/publications/:pubSlug.json -------------------

const imageSizeSchema = z.object({
  width: z.number(),
  height: z.number(),
});

export const publicationConfigSchema = z.object({
  publicationId: z.number().int(),
  publicationTitle: z.string(),
  customerName: z.string().nullable().optional(),
  relativeSize: z.number().optional(),
  locale: z.string().nullable().optional(),
  // `language` is the field we treat as authoritative for language_code
  // in our schema. Publitas sets this per publication (not per page), so
  // every page/chunk belonging to one publication inherits this value.
  language: z.string().min(1),
  downloadPdfUrl: z.string().nullable().optional(),
  currencySymbol: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
});
export type PublicationConfig = z.infer<typeof publicationConfigSchema>;

const hotspotPositionSchema = z.object({
  left: z.number(),
  top: z.number(),
  width: z.number(),
  height: z.number(),
  iconLeft: z.number().optional(),
  iconTop: z.number().optional(),
});

const hotspotBaseSchema = z.object({
  id: z.number().int(),
  title: z.string().nullable().optional(),
  showIndication: z.boolean().optional(),
  position: hotspotPositionSchema,
});

const productHotspotSchema = hotspotBaseSchema.extend({
  type: z.literal('product'),
  products: z.array(
    z.object({
      id: z.number().int(),
      // API returns this as the string "true", not a boolean. Documented
      // quirk, not a typo; only "true" is currently supported per docs.
      stub: z.string().optional(),
    }),
  ),
});

const externalLinkHotspotSchema = hotspotBaseSchema.extend({
  type: z.literal('externalLink'),
  url: z.string(),
});

const pageReferenceHotspotSchema = hotspotBaseSchema.extend({
  type: z.literal('pageReference'),
  // API returns this as a string, e.g. "2", not a number.
  pageNumber: z.string(),
});

const videoHotspotSchema = hotspotBaseSchema.extend({
  type: z.literal('video'),
  // Documented as always a string, but real catalog data disagrees: an
  // editor can leave a video hotspot's video field unset (never finished
  // configuring it) and the API returns null rather than omitting the
  // field or rejecting the publication. Observed on a live Tupperware
  // catalog (2026-09), not a hypothetical edge case.
  youtubeId: z.string().nullable(),
});

export const hotspotSchema = z.discriminatedUnion('type', [
  productHotspotSchema,
  externalLinkHotspotSchema,
  pageReferenceHotspotSchema,
  videoHotspotSchema,
]);
export type Hotspot = z.infer<typeof hotspotSchema>;
export type ProductHotspot = z.infer<typeof productHotspotSchema>;

export const spreadSchema = z.object({
  // 1 or 2 relative image paths; first spread has 1 (right-aligned),
  // last spread may have 1 (left-aligned) or 2, all others have 2.
  pages: z.array(z.string().min(1)).min(1).max(2),
  hotspots: z.array(hotspotSchema).optional(),
});
export type Spread = z.infer<typeof spreadSchema>;

export const publicationDetailSchema = z.object({
  sizes: z.record(z.string(), imageSizeSchema).optional(),
  config: publicationConfigSchema,
  spreads: z.array(spreadSchema),
  translations: z.record(z.string(), z.unknown()).optional(),
});
export type PublicationDetail = z.infer<typeof publicationDetailSchema>;

// --- GET .../products/:productId.json -----------------------------------

const productPhotoSchema = z.object({
  photoUrl: z.string(),
});

export const productDetailSchema = z.object({
  id: z.number().int(),
  hotspotId: z.number().int(),
  title: z.string(),
  description: z.string().nullable().optional(),
  price: z.number().nullable().optional(),
  discountedPrice: z.number().nullable().optional(),
  webshopIdentifier: z.string().nullable().optional(),
  webshopUrl: z.string().nullable().optional(),
  photos: z.array(productPhotoSchema).optional(),
});
export type ProductDetail = z.infer<typeof productDetailSchema>;
