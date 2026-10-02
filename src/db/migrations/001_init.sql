-- 001_init.sql
-- Core schema for catalogs, pages, and retrievable chunks.
--
-- IMPORTANT: the vector(1536) dimension below must match EMBEDDING_DIMENSIONS
-- in config. pgvector cannot alter a column's dimension in place; changing
-- embedding models to a different dimension requires a new migration that
-- drops and recreates the chunks.embedding column and its index, plus a
-- full re-embed of existing chunks. This is a deliberate one-way door,
-- documented here so it isn't hit by surprise.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm; -- used for a fallback keyword search on chunks.text

-- Generic trigger function to keep updated_at current on any row change.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- catalogs: one row per Publitas "group" (a retailer's catalog collection)
-- ---------------------------------------------------------------------------
CREATE TABLE catalogs (
  id                  BIGSERIAL PRIMARY KEY,
  group_slug          TEXT NOT NULL UNIQUE,
  display_name        TEXT NOT NULL,
  default_language    TEXT, -- BCP-47-ish code, e.g. 'pt', 'en', 'nl'; nullable until first ingest detects it
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER catalogs_set_updated_at
  BEFORE UPDATE ON catalogs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- publications: one row per Publitas publication within a catalog/group
-- ---------------------------------------------------------------------------
CREATE TABLE publications (
  id                  BIGSERIAL PRIMARY KEY,
  catalog_id          BIGINT NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
  publitas_id         BIGINT NOT NULL, -- the "id" field from the Publitas API, not our PK
  slug                TEXT NOT NULL,
  title               TEXT NOT NULL,
  online_at           TIMESTAMPTZ,
  ingested_at         TIMESTAMPTZ,     -- null until first successful ingestion run
  source_content_hash TEXT,            -- hash of raw API response, used to skip unchanged re-ingests
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (catalog_id, publitas_id)
);

CREATE TRIGGER publications_set_updated_at
  BEFORE UPDATE ON publications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_publications_catalog_id ON publications(catalog_id);

-- ---------------------------------------------------------------------------
-- pages: one row per page/spread within a publication
-- ---------------------------------------------------------------------------
CREATE TABLE pages (
  id                  BIGSERIAL PRIMARY KEY,
  publication_id      BIGINT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  page_number         INTEGER NOT NULL CHECK (page_number > 0),
  public_url          TEXT NOT NULL, -- deep link back to view.publitas.com/.../page/N for citations
  raw_text            TEXT,          -- concatenated hotspot labels / descriptions before chunking
  language_code       TEXT,          -- detected at ingestion time; can differ per page within one publication
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (publication_id, page_number)
);

CREATE TRIGGER pages_set_updated_at
  BEFORE UPDATE ON pages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_pages_publication_id ON pages(publication_id);
CREATE INDEX idx_pages_language_code ON pages(language_code);

-- ---------------------------------------------------------------------------
-- chunks: the retrievable unit. Chunked per page or per hotspot group,
-- never by raw character count, since catalog content is already structured.
-- ---------------------------------------------------------------------------
CREATE TABLE chunks (
  id                  BIGSERIAL PRIMARY KEY,
  page_id             BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  catalog_id          BIGINT NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE, -- denormalized for fast filtering
  chunk_index         INTEGER NOT NULL, -- ordering of chunks within a page, 0-based
  text                TEXT NOT NULL,
  text_hash           TEXT NOT NULL,    -- sha256 of `text`, used for idempotent re-embedding
  product_ref         TEXT,             -- product id/SKU if this chunk maps to a specific hotspot/product
  language_code       TEXT NOT NULL,
  embedding            vector(1536),    -- NULL until the embedding pipeline processes this row
  embedded_at          TIMESTAMPTZ,
  embedding_model      TEXT,            -- records which model produced `embedding`, for future migrations
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (page_id, chunk_index)
);

CREATE TRIGGER chunks_set_updated_at
  BEFORE UPDATE ON chunks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_chunks_page_id ON chunks(page_id);
CREATE INDEX idx_chunks_catalog_id ON chunks(catalog_id);
CREATE INDEX idx_chunks_catalog_language ON chunks(catalog_id, language_code);
CREATE INDEX idx_chunks_text_trgm ON chunks USING gin (text gin_trgm_ops); -- fallback lexical search

-- Vector similarity index. HNSW gives better recall/latency tradeoff than
-- IVFFlat and doesn't require a pre-existing row count to build well, which
-- matters here since catalogs are ingested incrementally.
-- vector_cosine_ops matches the cosine distance operator (<=>) used in
-- retrieval queries; this MUST stay consistent with the query operator or
-- the index will silently not be used.
CREATE INDEX idx_chunks_embedding_hnsw
  ON chunks
  USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

-- Partial index supporting "which chunks still need (re-)embedding" queries
-- without scanning the whole table.
CREATE INDEX idx_chunks_pending_embedding
  ON chunks (id)
  WHERE embedding IS NULL;
