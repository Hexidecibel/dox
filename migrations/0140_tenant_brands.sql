-- Migration 0140: the tenant brand record.
--
-- WHY
-- ---
-- Every page an outsider sees and every mail the portal sends showed the
-- organisation's name as plain text in one fixed navy, with no logo, no
-- colours and no support line. The client asked for a per-tenant brand record
-- on 2026-09-14; the design was answered on 2026-09-29
-- (~/drops/aj-2026-09-29/brand-table-answer.md): "a tenant brand table, even
-- with one row per tenant". Decision C-006 puts it ahead of complaint intake,
-- which reads the same record. Decisions C-094..C-116 fill in what the answer
-- left open (docs/decision-log.md).
--
-- WHAT THIS ADDS
-- --------------
-- tenant_brands -- ONE ROW PER TENANT, keyed by the tenant.
--     NO ROW MEANS "NO BRAND": every surface draws exactly what it drew
--     before this migration. Nothing is inserted here for any tenant; a row
--     appears the first time an admin sets something, and is DELETED again
--     when the last thing is cleared. A row with every column NULL is read
--     as no row (C-109), so the two states cannot be told apart from outside.
--
--     display_name -- what outsiders read. NULL falls back to tenants.name.
--     primary_color / accent_color -- '#RRGGBB', upper case, or NULL. The
--         CHECK is the third validation, after the API and the reader: this
--         value is written into style attributes of HTML mail, so a row
--         edited by hand must not be able to hold anything else.
--     support_text / support_email / support_phone -- the default support
--         line. Typed by an admin; shown to outsiders.
--     support_overrides -- JSON object keyed by SURFACE
--         ({"supplier_request": {"text": ..., "email": ..., "phone": ...}}).
--         JSON on purpose: the surfaces are a list in shared/tenantBrand.ts
--         (BRAND_SURFACES), so complaint intake adds a key there and no
--         migration. Validated on write AND on read; an entry that does not
--         validate is dropped by the reader, never shown.
--     logo_id -- the CURRENT logo, a row of tenant_brand_logos, or NULL.
--     updated_by / updated_at -- who last changed it. Every change is also
--         an audit row (tenant.brand_updated, old and new values).
--
-- tenant_brand_logos -- EVERY LOGO A TENANT HAS PUBLISHED, one row each.
--     The public logo route serves a row of this table and nothing else: it
--     looks the row up by url_token and reads the r2_key THE ROW holds, so no
--     caller-supplied string ever reaches the bucket. A replaced or removed
--     logo keeps its row, because mail already sent points at its URL --
--     until an admin WITHDRAWS it (C-111): the object is deleted and the row
--     stays, marked, so the URL answers 404 and the record of what was
--     published and who pulled it is kept.
--
--     url_token -- 40 hex characters, the only thing in the public URL.
--         Derived from the tenant and the content hash, so the same image
--         uploaded twice is one row and one URL, and a different image is a
--         different URL (a long cache lifetime is therefore safe).
--     sha256 -- of the bytes. UNIQUE with the tenant.
--     r2_key -- brand/<tenant>/logo-<sha256>.<ext>.
--     content_type -- what the BYTES are (sniffed), one of three raster
--         types. SVG is not in the list and never will be.
--     withdrawn_at / withdrawn_by / withdrawn_reason -- set together when an
--         admin withdraws the logo, cleared together if the same image is
--         deliberately uploaded again. Added with ALTER (this file was amended
--         once, before it was applied anywhere but local dev), so the shape
--         rule is a trigger rather than a table CHECK.
--
-- trg_tenant_brands_logo_same_tenant_* -- a brand may only point at a logo of
--     its own tenant. The reader joins on the tenant as well; this refuses the
--     write.
--
-- trg_tenant_brand_logos_withdrawal_shape -- withdrawn_at and a non-blank
--     reason are set together or not at all.
-- trg_tenant_brand_logos_no_withdraw_current -- a logo the brand is showing
--     cannot be marked withdrawn; it is taken off the brand first (the
--     application does both, in that order).
-- trg_tenant_brands_logo_not_withdrawn_* -- and a brand cannot be pointed at a
--     withdrawn logo.
--
-- ADDITIVE. No existing table or row changes. Safe to apply before the code.
-- The CREATEs are IF NOT EXISTS. The three ALTERs are not re-runnable; a LOCAL
-- database that ran the first cut takes this file with
-- `./bin/migrate --reapply --only 0140_tenant_brands.sql`, which leaves out an
-- ADD COLUMN whose column is already there.

CREATE TABLE IF NOT EXISTS tenant_brand_logos (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  url_token TEXT NOT NULL UNIQUE
    CHECK (length(url_token) = 40 AND url_token NOT GLOB '*[^0-9a-f]*'),
  sha256 TEXT NOT NULL
    CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL
    CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT REFERENCES users(id),
  UNIQUE (tenant_id, sha256)
);

CREATE TABLE IF NOT EXISTS tenant_brands (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  display_name TEXT
    CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 80),
  primary_color TEXT
    CHECK (primary_color IS NULL OR (length(primary_color) = 7
      AND primary_color GLOB '#[0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]')),
  accent_color TEXT
    CHECK (accent_color IS NULL OR (length(accent_color) = 7
      AND accent_color GLOB '#[0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]')),
  support_text TEXT
    CHECK (support_text IS NULL OR length(support_text) BETWEEN 1 AND 200),
  support_email TEXT
    CHECK (support_email IS NULL OR length(support_email) BETWEEN 3 AND 254),
  support_phone TEXT
    CHECK (support_phone IS NULL OR length(support_phone) BETWEEN 3 AND 40),
  support_overrides TEXT
    CHECK (support_overrides IS NULL OR length(support_overrides) <= 8000),
  logo_id TEXT REFERENCES tenant_brand_logos(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_brand_logos_tenant
  ON tenant_brand_logos(tenant_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_tenant_brands_logo_same_tenant_insert
BEFORE INSERT ON tenant_brands
FOR EACH ROW
WHEN NEW.logo_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM tenant_brand_logos l
     WHERE l.id = NEW.logo_id AND l.tenant_id = NEW.tenant_id)
BEGIN
  SELECT RAISE(ABORT, 'tenant_brands.logo_id must be a logo of the same tenant');
END;

CREATE TRIGGER IF NOT EXISTS trg_tenant_brands_logo_same_tenant_update
BEFORE UPDATE OF logo_id, tenant_id ON tenant_brands
FOR EACH ROW
WHEN NEW.logo_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM tenant_brand_logos l
     WHERE l.id = NEW.logo_id AND l.tenant_id = NEW.tenant_id)
BEGIN
  SELECT RAISE(ABORT, 'tenant_brands.logo_id must be a logo of the same tenant');
END;

ALTER TABLE tenant_brand_logos ADD COLUMN withdrawn_at TEXT;
ALTER TABLE tenant_brand_logos ADD COLUMN withdrawn_by TEXT REFERENCES users(id);
ALTER TABLE tenant_brand_logos ADD COLUMN withdrawn_reason TEXT;

CREATE TRIGGER IF NOT EXISTS trg_tenant_brand_logos_withdrawal_shape
BEFORE UPDATE OF withdrawn_at, withdrawn_by, withdrawn_reason ON tenant_brand_logos
FOR EACH ROW
WHEN (NEW.withdrawn_at IS NULL
        AND (NEW.withdrawn_reason IS NOT NULL OR NEW.withdrawn_by IS NOT NULL))
  OR (NEW.withdrawn_at IS NOT NULL
        AND (NEW.withdrawn_reason IS NULL OR length(trim(NEW.withdrawn_reason)) = 0))
BEGIN
  SELECT RAISE(ABORT, 'a withdrawal is a time and a reason together, or neither');
END;

CREATE TRIGGER IF NOT EXISTS trg_tenant_brand_logos_no_withdraw_current
BEFORE UPDATE OF withdrawn_at ON tenant_brand_logos
FOR EACH ROW
WHEN NEW.withdrawn_at IS NOT NULL
  AND EXISTS (SELECT 1 FROM tenant_brands b WHERE b.logo_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'take the logo off the brand before withdrawing it');
END;

CREATE TRIGGER IF NOT EXISTS trg_tenant_brands_logo_not_withdrawn_insert
BEFORE INSERT ON tenant_brands
FOR EACH ROW
WHEN NEW.logo_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM tenant_brand_logos l
     WHERE l.id = NEW.logo_id AND l.withdrawn_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'tenant_brands.logo_id must not be a withdrawn logo');
END;

CREATE TRIGGER IF NOT EXISTS trg_tenant_brands_logo_not_withdrawn_update
BEFORE UPDATE OF logo_id ON tenant_brands
FOR EACH ROW
WHEN NEW.logo_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM tenant_brand_logos l
     WHERE l.id = NEW.logo_id AND l.withdrawn_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'tenant_brands.logo_id must not be a withdrawn logo');
END;
