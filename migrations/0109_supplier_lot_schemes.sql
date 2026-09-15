-- 0109 — each supplier's lot format as DECLARED DATA; and a lot row's production
-- date may now say it was decoded from that format.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE PROBLEM (AJ Conner, Any-Field COA Retrieval §6, R2 / R3 / R8)
-- ═══════════════════════════════════════════════════════════════════════════
-- Darigold's lot code is a deterministic encoding of the production date:
-- plant(3) | YY | Julian day(3), a 2-digit sublot appended for the WMS composite.
-- Verified on every Darigold lot on prod that states a date. Country Morning's
-- lot is the best-by date MMDDYY plus a product suffix. Andersen prints no
-- product lot at all.
--
-- `suppliers.lot_scheme` (0075) could not say any of that. It is a closed enum
-- of four HARD-CODED transforms, three of which ('auto', 'plain',
-- 'lims_combined') do the same thing; it keys lots, but it cannot validate a lot,
-- decode a date, or tell Darigold's format from Land O'Lakes'. Meanwhile the
-- extraction prompts told the model to "convert Julian dates when identifiable":
-- a GLOBAL, silent, authoritative decode, which is exactly what AJ forbids —
--
--   "Build it as a per-supplier parser with a declared pattern, registered
--    against the supplier record. Do not write a global regex."
--   "A decoded date is never authoritative when the document states one."
--   "When decode and extraction disagree, flag. Do not resolve it in code."
--
-- ═══════════════════════════════════════════════════════════════════════════
-- `supplier_lot_schemes` — APPEND-ONLY, VERSIONED
-- ═══════════════════════════════════════════════════════════════════════════
-- One row per DECLARATION: `spec` is the JSON the pure engine in
-- shared/lotScheme.ts runs (segments with names, kinds and widths; the sublot;
-- the composite/key rule; which date the lot encodes and in which ROLE —
-- production or best_by). The spec is validated in code before insert
-- (`validateLotSchemeSpec`), because a declaration that silently mis-parses is
-- worse than none; SQL only insists it is JSON.
--
-- WHY A TABLE AND NOT A `suppliers.lot_scheme_spec` COLUMN. A supplier can change
-- its format (a new plant, a new LIMS), and a lot row's decoded production date
-- has to stay explainable after that: "decoded using version 2 of Darigold's
-- declared format". A column would overwrite the only copy of the rule that
-- produced every stored decode. Append-only costs one `ORDER BY version DESC
-- LIMIT 1` and nothing else; the current declaration is the highest version, a
-- change is a new row, and there is no UPDATE path. (Effective-dating by
-- production date was considered and NOT built: which format a lot uses cannot
-- be known before the lot is decoded, so an `effective_from` would be circular.
-- History, not scheduling, is what provenance needs.)
--
-- `spec.kind = 'none'` is a DECLARATION — "this supplier prints no decodable
-- lot" (Andersen) — and is distinct from no row, which means nobody has looked.
-- With no row the 0075 enum still applies, mapped onto an equivalent spec by
-- `legacyLotSchemeSpec`, so every existing key is byte-identical. The enum column
-- stays (the Supplier header still edits it); a declaration supersedes it.
--
-- `source`: 'admin' (the Supplier › Lot format page) or 'seed'
-- (bin/seed-supplier-lot-schemes). CHECKed: it is a closed vocabulary owned here.
-- `created_by` is NULL for a seed.
--
-- UNIQUE(supplier_id, version) over NOT NULL keys — the 0086/0087 NULL-distinctness
-- trap cannot apply. A supplier merge deletes the loser's declarations (their
-- content goes into the `supplier.merged` audit row): the winner's format governs
-- the merged lots, and two version-1 rows cannot share one supplier.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- `lots` REBUILT — `production_date_source` gains 'lot_decode'
-- ═══════════════════════════════════════════════════════════════════════════
-- When a lot row has NO extracted production date but its supplier's declared
-- format decodes one in the production role, the row stores it with
-- `production_date_source = 'lot_decode'` and `production_date_scheme_id` naming
-- the declaration that decoded it. Search presents it as "likely — confirm",
-- NEVER covering (shared/searchCoverage.ts). An extracted value is never
-- overwritten by a decode; when both exist and disagree the row is 'conflict'
-- with both values in `production_date_raw` (functions/lib/entities/lots.ts).
--
-- 0106 put a CHECK on `production_date_source`, deliberately: those words decide
-- whether a search calls a certificate covering, so an unknown one must fail the
-- write. SQLite cannot alter a CHECK, and dropping the guard (or smuggling the
-- decode in under 'reviewer') would be the dishonest version of this change. So
-- the table is rebuilt with the same columns, the widened CHECK, and one new
-- column. Done WITHOUT `ALTER TABLE ... RENAME`, which since SQLite 3.26 re-parses
-- every view and trigger and would trip over `documents_fts_source`:
--
--   1. copy the rows out (CREATE TABLE ... AS SELECT — no constraints, a plain copy)
--   2. DROP the table (its indexes and its one trigger go with it)
--   3. CREATE it again under the same name, widened
--   4. copy the rows back, column by column
--   5. re-create the four indexes and `trg_lots_au_fts` verbatim
--
-- `document_lots`, `order_items` and `lot_match_suggestions` reference lots(id)
-- with no ON DELETE action. The implicit DELETE in step 2 would violate them, so
-- foreign keys are DEFERRED for the migration's transaction (the documented D1
-- pattern): every row comes back in step 4 with the same id, and the violations
-- are gone before commit. `documents_fts_source` reads `lots` by name and is
-- untouched; no FTS row changes, because no indexed column changes.

PRAGMA defer_foreign_keys = true;

CREATE TABLE supplier_lot_schemes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  spec TEXT NOT NULL CHECK (json_valid(spec)),
  source TEXT NOT NULL CHECK (source IN ('admin', 'seed')),
  note TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (supplier_id, version)
);

CREATE INDEX idx_supplier_lot_schemes_current
  ON supplier_lot_schemes (tenant_id, supplier_id, version);

CREATE TABLE lots_pre0109 AS SELECT * FROM lots;

DROP TABLE lots;

CREATE TABLE lots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  supplier_id TEXT REFERENCES suppliers(id),
  product_id  TEXT REFERENCES products(id),
  lot_number  TEXT NOT NULL,
  lot_key     TEXT NOT NULL,
  code_date TEXT, expiration_date TEXT, mfg_date TEXT,
  primary_metadata TEXT,
  first_seen_source TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  sub_lot_code TEXT NOT NULL DEFAULT '',
  production_date TEXT,
  production_date_raw TEXT,
  production_date_source TEXT
    CHECK (production_date_source IS NULL OR production_date_source IN ('extracted', 'extracted_code_date_legacy', 'reviewer', 'lot_decode')),
  production_date_status TEXT
    CHECK (production_date_status IS NULL OR production_date_status IN ('resolved', 'ambiguous', 'unparseable', 'conflict')),
  production_date_document_id TEXT,
  production_date_scheme_id TEXT
);

INSERT INTO lots (
  id, tenant_id, supplier_id, product_id, lot_number, lot_key,
  code_date, expiration_date, mfg_date, primary_metadata, first_seen_source,
  created_at, updated_at, sub_lot_code,
  production_date, production_date_raw, production_date_source, production_date_status,
  production_date_document_id
)
SELECT
  id, tenant_id, supplier_id, product_id, lot_number, lot_key,
  code_date, expiration_date, mfg_date, primary_metadata, first_seen_source,
  created_at, updated_at, sub_lot_code,
  production_date, production_date_raw, production_date_source, production_date_status,
  production_date_document_id
FROM lots_pre0109;

DROP TABLE lots_pre0109;

CREATE UNIQUE INDEX idx_lots_identity ON lots(tenant_id, product_id, lot_key, sub_lot_code);
CREATE INDEX idx_lots_lotkey   ON lots(tenant_id, lot_key);
CREATE INDEX idx_lots_supplier ON lots(tenant_id, supplier_id);
CREATE INDEX idx_lots_production_date
  ON lots (tenant_id, production_date)
  WHERE production_date IS NOT NULL;

CREATE TRIGGER trg_lots_au_fts
AFTER UPDATE OF lot_number, sub_lot_code, lot_key ON lots
BEGIN
  DELETE FROM documents_fts
   WHERE rowid IN (
     SELECT m.rowid
       FROM documents_fts_map m
       JOIN document_lots dl ON dl.document_id = m.doc_id
      WHERE dl.lot_id = NEW.id
   );

  INSERT INTO documents_fts (
    rowid, title, description, tags_text, file_name,
    extracted_text, primary_metadata_text, extended_metadata_text,
    supplier_text, document_type_text, product_text, lot_text,
    category_text, aliases_text, criteria_text, applies_to_text,
    doc_id, tenant_id
  )
  SELECT
    m.rowid,
    src.title, src.description, src.tags_text, src.file_name,
    src.extracted_text, src.primary_metadata_text, src.extended_metadata_text,
    src.supplier_text, src.document_type_text, src.product_text, src.lot_text,
    src.category_text, src.aliases_text, src.criteria_text, src.applies_to_text,
    src.doc_id, src.tenant_id
  FROM documents_fts_source src
  JOIN documents_fts_map m ON m.doc_id = src.doc_id
  WHERE src.doc_id IN (
    SELECT dl.document_id FROM document_lots dl WHERE dl.lot_id = NEW.id
  );
END;
