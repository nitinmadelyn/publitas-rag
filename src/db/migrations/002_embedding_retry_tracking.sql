-- 002_embedding_retry_tracking.sql
-- Tracks embedding attempts so a chunk whose text permanently fails to
-- embed (e.g. rejected by the provider with a non-retryable error) does
-- not get re-fetched and re-fail on every single run of the embedding
-- pipeline forever. embedPendingChunks() excludes rows once
-- embedding_attempts reaches EMBEDDING_MAX_ATTEMPTS; an operator can
-- requeue a chunk by resetting embedding_attempts back to 0 (e.g. after
-- fixing the extractor and re-ingesting the source publication).

ALTER TABLE chunks
  ADD COLUMN embedding_attempts    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN embedding_last_error  TEXT;
