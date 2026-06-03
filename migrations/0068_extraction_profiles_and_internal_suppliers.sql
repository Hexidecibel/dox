-- Migration 0068: unify extraction profiles into supplier_extraction_instructions
-- (Connectors -> Sources refactor, profile-store workstream).
--
-- Design: ONE extraction profile keyed (tenant_id, supplier_id, document_type_id)
-- holds BOTH field_mappings AND natural-language instructions, for every output
-- kind (coa/order/shipment). Internal ERP/WMS origins are modeled as supplier
-- rows with origin_kind='internal', so everything keys uniformly.
--
-- Before today:
--   * field_mappings lived on connectors.config (JSON $.field_mappings) and the
--     dedicated connectors.field_mappings column.
--   * connector-level instructions lived on connectors.extraction_instructions
--     (migration 0061).
--   * per-(supplier,document_type) instructions lived in
--     supplier_extraction_instructions (migration 0035).
--
-- After 0068: supplier_extraction_instructions is the single source of truth.
-- We ADD a field_mappings column to it and backfill from connectors. We DO NOT
-- drop connectors.field_mappings / connectors.extraction_instructions — those
-- stay in place for a later cleanup migration; they simply stop being read.
--
-- Idempotency: ALTER ... ADD COLUMN is not natively idempotent in SQLite, but
-- bin/migrate-staging tolerates "duplicate column name" on re-run (see that
-- script). The backfill uses INSERT ... ON CONFLICT, so re-running is safe
-- (last-write-wins) and never duplicates rows.

-- 1) Add the unified field_mappings column (JSON text, nullable).
--    Nullable so existing rows authored via the instructions-only editor (0035)
--    keep working; a NULL here means "no field mappings authored for this pair".
ALTER TABLE supplier_extraction_instructions ADD COLUMN field_mappings TEXT;

-- 2) Backfill from connectors that already carry BOTH supplier_id and
--    document_type_id (i.e. supplier-dedicated channels — typically COA feeds
--    after migration 0067 set origin/supplier/doctype).
--
--    UPSERT key: UNIQUE(supplier_id, document_type_id) — the constraint declared
--    in migration 0035. We match that exact column pair in ON CONFLICT.
--
--    Source of field_mappings: prefer the dedicated connectors.field_mappings
--    column; fall back to json_extract(config,'$.field_mappings') for connectors
--    whose mappings only live inside the config blob. We normalize empty/absent
--    mappings ('{}' or NULL) to NULL so a connector with no real mappings does
--    not clobber existing authored mappings on collision.
--
--    instructions is NOT NULL in the table, so coalesce a NULL connector
--    instruction to '' (empty guidance) to satisfy the constraint.
--
--    tenant_id, supplier_id, document_type_id must all be present — the WHERE
--    clause filters out connectors missing any of them.
--
--    Collision handling: if multiple connectors share the same
--    (supplier_id, document_type_id), the last INSERT wins (acceptable per the
--    workstream brief). ON CONFLICT updates instructions + field_mappings,
--    preserving id/created_at and bumping updated_at.
INSERT INTO supplier_extraction_instructions
  (id, supplier_id, document_type_id, tenant_id, instructions, field_mappings, created_at, updated_at)
SELECT
  lower(hex(randomblob(8))) AS id,
  c.supplier_id,
  c.document_type_id,
  c.tenant_id,
  COALESCE(c.extraction_instructions, '') AS instructions,
  -- prefer dedicated column, fall back to config JSON; NULL if effectively empty
  CASE
    WHEN c.field_mappings IS NOT NULL
         AND TRIM(c.field_mappings) <> ''
         AND TRIM(c.field_mappings) <> '{}'
      THEN c.field_mappings
    WHEN json_extract(c.config, '$.field_mappings') IS NOT NULL
      THEN json_extract(c.config, '$.field_mappings')
    ELSE NULL
  END AS field_mappings,
  datetime('now'),
  datetime('now')
FROM connectors c
WHERE c.supplier_id IS NOT NULL
  AND c.document_type_id IS NOT NULL
  AND c.tenant_id IS NOT NULL
ON CONFLICT(supplier_id, document_type_id) DO UPDATE SET
  -- Don't blank out existing authored guidance with an empty connector string.
  instructions   = CASE
                     WHEN excluded.instructions IS NOT NULL AND excluded.instructions <> ''
                       THEN excluded.instructions
                     ELSE supplier_extraction_instructions.instructions
                   END,
  -- Only overwrite field_mappings when the connector actually had some.
  field_mappings = COALESCE(excluded.field_mappings, supplier_extraction_instructions.field_mappings),
  updated_at     = datetime('now');

-- 3) Internal sources with NULL supplier_id (origin_kind='internal').
--    These ERP/WMS connectors carry field_mappings + instructions but no
--    supplier_id, so they cannot be keyed into the unified store yet. We
--    CANNOT reliably synthesize supplier rows in pure SQL:
--      * suppliers.name + suppliers.slug + UNIQUE(tenant_id, slug) must be
--        derived, and connectors.name is a free-text label ("Acme ERP poll")
--        that does not cleanly map to a stable supplier identity.
--      * A wrong/duplicate synthetic supplier would pollute the supplier list
--        and the dedupe tooling.
--
--    DEFERRED TO APP LEVEL: the Sources admin / backfill job creates (or
--    matches) an internal supplier row per nameless internal connector, then
--    writes its field_mappings + instructions through the
--    PUT /api/extraction-instructions surface (now field_mappings-aware).
--    No rows are created here; this section is intentionally a no-op so the
--    migration stays safe and idempotent.
--
--    (Left as a comment-only section by design — see workstream notes.)
