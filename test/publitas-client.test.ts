import { describe, expect, it, vi } from 'vitest';
import { PublitasClient, PublitasApiValidationError } from '../src/ingestion/publitas-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const validListItem = {
  id: 1,
  slug: 'example_publication',
  title: 'Blokker example publication',
  browserTitle: 'Custom title',
  onlineAt: '2013-09-11T10:19:41.000+02:00',
  url: 'https://api.publitas.com/v1/groups/example-blokker/publications/blokker-example.json',
};

const validPublicationDetail = {
  sizes: {},
  config: {
    publicationId: 10323,
    publicationTitle: 'Example',
    language: 'en',
  },
  spreads: [{ pages: ['/a/1'] }],
  translations: {},
};

describe('PublitasClient.listPublications', () => {
  it('returns parsed publications for a valid response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([validListItem]));
    const client = new PublitasClient({
      baseUrl: 'https://api.publitas.com/v1',
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });

    const result = await client.listPublications('example-blokker');
    expect(result).toEqual([validListItem]);
  });

  it('builds the correct URL, encoding the group slug', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = new PublitasClient({
      baseUrl: 'https://api.publitas.com/v1',
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });

    await client.listPublications('some group/slug');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.publitas.com/v1/groups/some%20group%2Fslug/publications.json',
      expect.anything(),
    );
  });

  it('strips a trailing slash from baseUrl before building URLs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = new PublitasClient({
      baseUrl: 'https://api.publitas.com/v1/',
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });

    await client.listPublications('example-blokker');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.publitas.com/v1/groups/example-blokker/publications.json',
      expect.anything(),
    );
  });

  it('throws PublitasApiValidationError when the response is not an array', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ not: 'an array' }));
    const client = new PublitasClient({
      baseUrl: 'https://api.publitas.com/v1',
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });

    await expect(client.listPublications('example-blokker')).rejects.toThrow(
      PublitasApiValidationError,
    );
  });

  it('throws PublitasApiValidationError when a required field is missing', async () => {
    const { slug: _slug, ...missingSlug } = validListItem;
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([missingSlug]));
    const client = new PublitasClient({
      baseUrl: 'https://api.publitas.com/v1',
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });

    await expect(client.listPublications('example-blokker')).rejects.toThrow(
      PublitasApiValidationError,
    );
  });

  it('throws PublitasApiValidationError when a field has the wrong type', async () => {
    const badItem = { ...validListItem, id: 'not-a-number' };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([badItem]));
    const client = new PublitasClient({
      baseUrl: 'https://api.publitas.com/v1',
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });

    await expect(client.listPublications('example-blokker')).rejects.toThrow(
      PublitasApiValidationError,
    );
  });

  it('accepts an empty publication list', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = new PublitasClient({
      baseUrl: 'https://api.publitas.com/v1',
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });

    const result = await client.listPublications('empty-group');
    expect(result).toEqual([]);
  });

  it('accepts onlineAt as null', async () => {
    const item = { ...validListItem, onlineAt: null };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([item]));
    const client = new PublitasClient({
      baseUrl: 'https://api.publitas.com/v1',
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });

    const result = await client.listPublications('example-blokker');
    expect(result[0]?.onlineAt).toBeNull();
  });
});

describe('PublitasClient.getPublication', () => {
  it('returns parsed publication detail for a valid response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validPublicationDetail));
    const client = new PublitasClient({
      baseUrl: 'https://api.publitas.com/v1',
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });

    const result = await client.getPublication('example-blokker', 'blokker-example');
    expect(result.config.language).toBe('en');
    expect(result.spreads).toHaveLength(1);
  });

  it('throws PublitasApiValidationError when config.language is missing', async () => {
    const { language: _language, ...configWithoutLanguage } = validPublicationDetail.config;
    const broken = { ...validPublicationDetail, config: configWithoutLanguage };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(broken));
    const client = new PublitasClient({
      baseUrl: 'https://api.publitas.com/v1',
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });

    await expect(client.getPublication('example-blokker', 'blokker-example')).rejects.toThrow(
      PublitasApiValidationError,
    );
  });

  it('drops an unknown hotspot type instead of rejecting the whole publication', async () => {
    const withUnknownHotspot = {
      ...validPublicationDetail,
      spreads: [
        {
          pages: ['/a/1'],
          hotspots: [
            {
              id: 1,
              type: 'unknownFutureType',
              position: { left: 0, top: 0, width: 0.1, height: 0.1 },
            },
          ],
        },
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(withUnknownHotspot));
    const client = new PublitasClient({
      baseUrl: 'https://api.publitas.com/v1',
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });

    const result = await client.getPublication('example-blokker', 'blokker-example');
    expect(result.spreads[0]?.hotspots).toEqual([]);
  });

  it('accepts a video hotspot with a null youtubeId (real-world editor-left-unfinished case)', async () => {
    const withNullVideo = {
      ...validPublicationDetail,
      spreads: [
        {
          pages: ['/a/1'],
          hotspots: [
            {
              id: 1,
              type: 'video',
              title: null,
              youtubeId: null,
              position: { left: 0.1, top: 0.1, width: 0.1, height: 0.1 },
            },
          ],
        },
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(withNullVideo));
    const client = new PublitasClient({
      baseUrl: 'https://api.publitas.com/v1',
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });

    const result = await client.getPublication('example-blokker', 'blokker-example');
    const hotspot = result.spreads[0]?.hotspots?.[0];
    expect(hotspot?.type).toBe('video');
    if (hotspot?.type === 'video') {
      expect(hotspot.youtubeId).toBeNull();
    }
  });

  it('drops only the malformed hotspot on a spread, keeping valid hotspots alongside it', async () => {
    const mixed = {
      ...validPublicationDetail,
      spreads: [
        {
          pages: ['/a/1'],
          hotspots: [
            { id: 1, type: 'unknownType', position: { left: 0.1, top: 0.1, width: 0.1, height: 0.1 } },
            {
              id: 2,
              type: 'externalLink',
              title: 'Visit site',
              url: 'https://example.com',
              position: { left: 0.6, top: 0.1, width: 0.1, height: 0.1 },
            },
          ],
        },
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(mixed));
    const client = new PublitasClient({
      baseUrl: 'https://api.publitas.com/v1',
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });

    const result = await client.getPublication('example-blokker', 'blokker-example');
    expect(result.spreads[0]?.hotspots).toHaveLength(1);
    expect(result.spreads[0]?.hotspots?.[0]?.id).toBe(2);
  });

  it('drops malformed hotspots independently across multiple spreads', async () => {
    const multiSpread = {
      ...validPublicationDetail,
      spreads: [
        {
          pages: ['/a/1'],
          hotspots: [{ id: 1, type: 'broken', position: { left: 0.1, top: 0.1, width: 0.1, height: 0.1 } }],
        },
        {
          pages: ['/a/2', '/a/3'],
          hotspots: [
            {
              id: 2,
              type: 'pageReference',
              title: 'Go to page 2',
              pageNumber: '2',
              position: { left: 0.1, top: 0.1, width: 0.1, height: 0.1 },
            },
          ],
        },
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(multiSpread));
    const client = new PublitasClient({
      baseUrl: 'https://api.publitas.com/v1',
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });

    const result = await client.getPublication('example-blokker', 'blokker-example');
    expect(result.spreads[0]?.hotspots).toEqual([]);
    expect(result.spreads[1]?.hotspots).toHaveLength(1);
  });

  it('leaves a spread with no hotspots key untouched', async () => {
    const noHotspots = {
      ...validPublicationDetail,
      spreads: [{ pages: ['/a/1'] }],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(noHotspots));
    const client = new PublitasClient({
      baseUrl: 'https://api.publitas.com/v1',
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });

    const result = await client.getPublication('example-blokker', 'blokker-example');
    expect(result.spreads[0]?.hotspots).toBeUndefined();
  });

  it('still rejects the whole publication when config itself is malformed (sanitization does not mask everything)', async () => {
    const { language: _language, ...configWithoutLanguage } = validPublicationDetail.config;
    const broken = { ...validPublicationDetail, config: configWithoutLanguage };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(broken));
    const client = new PublitasClient({
      baseUrl: 'https://api.publitas.com/v1',
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });

    await expect(client.getPublication('example-blokker', 'blokker-example')).rejects.toThrow(
      PublitasApiValidationError,
    );
  });

  it('accepts a valid product hotspot', async () => {
    const withProduct = {
      ...validPublicationDetail,
      spreads: [
        {
          pages: ['/a/1'],
          hotspots: [
            {
              id: 1,
              type: 'product',
              position: { left: 0.1, top: 0.1, width: 0.1, height: 0.1 },
              products: [{ id: 42, stub: 'true' }],
            },
          ],
        },
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(withProduct));
    const client = new PublitasClient({
      baseUrl: 'https://api.publitas.com/v1',
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });

    const result = await client.getPublication('example-blokker', 'blokker-example');
    const hotspot = result.spreads[0]?.hotspots?.[0];
    expect(hotspot?.type).toBe('product');
  });
});

describe('PublitasClient.getProduct', () => {
  const validProduct = {
    id: 49836,
    hotspotId: 138648,
    title: 'Sola wok',
    description: 'A nice wok',
    price: 24.99,
    discountedPrice: 19.99,
    webshopIdentifier: '2104282',
    webshopUrl: 'http://webshop.com/product/2104282',
    photos: [],
  };

  it('returns parsed product detail on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validProduct));
    const client = new PublitasClient({
      baseUrl: 'https://api.publitas.com/v1',
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });

    const result = await client.getProduct('example-blokker', 'blokker-example', 49836);
    expect(result?.title).toBe('Sola wok');
  });

  it('returns null (not a throw) when the product fetch fails after retries', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not found', { status: 404 }));
    const client = new PublitasClient({
      baseUrl: 'https://api.publitas.com/v1',
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });

    const result = await client.getProduct('example-blokker', 'blokker-example', 999);
    expect(result).toBeNull();
  });

  it('returns null when the product response fails validation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 'not-a-number' }));
    const client = new PublitasClient({
      baseUrl: 'https://api.publitas.com/v1',
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });

    const result = await client.getProduct('example-blokker', 'blokker-example', 999);
    expect(result).toBeNull();
  });
});
