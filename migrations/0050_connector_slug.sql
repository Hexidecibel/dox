-- Migration 0050: connector slugs
--
-- Phase B0.5 — adds a globally-unique, URL-safe slug column to the
-- connectors table so the universal-doors model can use vendor-friendly
-- addresses everywhere (email: <slug>@supdox.com, HTTP API:
-- /api/connectors/<slug>/drop, S3 bucket: dox-drops-<slug>, public link:
-- /drop/<slug>/<token>). Internal admin routes continue to use the
-- random-hex id.
--
-- SQLite gotcha: ALTER TABLE ... ADD COLUMN ... NOT NULL fails on a
-- non-empty table without a non-null DEFAULT. We deliberately add slug
-- as NULLABLE here and rely on the application layer
-- (functions/api/connectors/index.ts) to enforce non-null on create. The
-- backfill step (separate UPDATE statements run via wrangler d1
-- execute against the staging DB before this code ships) is responsible
-- for filling in slugs on every existing row, after which every prod row
-- will satisfy the NOT NULL invariant the app enforces going forward.
--
-- The unique index allows multiple NULLs in SQLite but rejects duplicate
-- non-NULL values — that's the property we want during the backfill
-- window.

ALTER TABLE connectors ADD COLUMN slug TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_connectors_slug ON connectors(slug);
