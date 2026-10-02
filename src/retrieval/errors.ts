export class RetrievalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetrievalValidationError';
  }
}

export class CatalogNotFoundError extends Error {
  readonly catalogSlug: string;

  constructor(catalogSlug: string) {
    super(`No catalog found for slug: ${catalogSlug}`);
    this.name = 'CatalogNotFoundError';
    this.catalogSlug = catalogSlug;
  }
}
