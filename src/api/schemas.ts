import { z } from 'zod';

/**
 * A catalog slug as it appears in Publitas URLs: lowercase-ish,
 * hyphen/underscore separated. Bounded to 200 chars, generous headroom
 * over any real slug, mainly to reject pathological input early rather
 * than letting an oversized string reach the database.
 */
export const catalogSlugParamsSchema = z.object({
  slug: z.string().min(1, 'slug must not be empty').max(200, 'slug is too long'),
});

export type CatalogSlugParams = z.infer<typeof catalogSlugParamsSchema>;

/** e.g. "en", "es-MX", "pt-BR" - matches the codes language-detector.ts produces. */
const LANGUAGE_CODE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;

export const chatRequestBodySchema = z.object({
  query: z
    .string()
    .trim()
    .min(1, 'query must not be empty')
    .max(2000, 'query must be at most 2000 characters'),
  languageCode: z
    .string()
    .regex(LANGUAGE_CODE_PATTERN, 'languageCode must look like "en" or "es-MX"'),
});

export type ChatRequestBody = z.infer<typeof chatRequestBodySchema>;
