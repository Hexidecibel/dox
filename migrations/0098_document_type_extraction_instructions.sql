-- Migration 0098: document_type_extraction_instructions — the MIDDLE layer of
-- the extraction prompt stack.
--
-- WHY
-- ---
-- Extraction guidance has had exactly two layers:
--
--   1. tenants.extraction_context          (0072) — the tenant's "dairy brain",
--      one editable block per tenant, whole-block replacement of the seeded
--      DEFAULT_DAIRY_CONTEXT.
--   2. supplier_extraction_instructions    (0035/0068) — guidance for ONE
--      (supplier, document_type) pair.
--
-- There is nothing in between, and the gap is not academic. `supplier_id` on
-- 0035 is NOT NULL, so the sentence "here is how to read a Certificate of
-- Insurance, from anybody" is not expressible. The live tenant has 27 document
-- types and 21 suppliers: saying it once per pair is up to 567 rows, and a
-- brand-new supplier's first Kosher Certificate arrives with NO type guidance
-- at all — the common case for the mixed corpus now landing, not an edge case.
--
-- WHY A SEPARATE TABLE AND NOT A NULLABLE supplier_id
-- ---------------------------------------------------
-- The obvious move is to relax `supplier_extraction_instructions.supplier_id`
-- to nullable and let NULL mean "any supplier". Do not. SQLite treats NULLs as
-- DISTINCT inside a UNIQUE index, so `UNIQUE (supplier_id, document_type_id)`
-- would stop constraining exactly the rows that most need it: unlimited
-- duplicate "any supplier" rows for one document type, silently disagreeing
-- with each other, with the last writer winning by `updated_at` accident.
-- 0086 had to solve that on spec_limits with a COALESCE expression index, and
-- 0087 wrote the rule down: do NOT make a key column nullable to express a
-- wildcard.
--
-- Here both key columns are NOT NULL, so a plain UNIQUE is correct and
-- sufficient. The layers stay separable in storage the same way they are
-- separable in the prompt.
--
-- COMPOSITION, NOT REPLACEMENT
-- ----------------------------
-- This layer COMPOSES with the supplier layer rather than being overridden by
-- it — matching how the supplier layer already composes with BASE_PROMPT (it
-- is prepended as its own labelled block, not substituted into it). The
-- assembled order is general -> specific:
--
--     document-type block  ->  (supplier, type) block  ->  BASE_PROMPT
--
-- so a supplier instruction REFINES the type instruction. Only the tenant
-- industry layer (0072) is a whole-block replacement, because that is what a
-- tenant-editable template is; that behaviour is unchanged here.
--
-- Resolution lives in functions/lib/extractionInstructionStack.ts and is shared
-- by the API and (via GET /api/extraction-instructions) by bin/process-worker.
--
-- SCOPE — tenant + type, and nothing else
-- ---------------------------------------
-- Deliberately NOT scoped by supplier, product or source: that is precisely the
-- dimension this layer exists to be free of. A document type is already
-- per-tenant (0011) and may additionally be owned by a supplier (0069); a
-- supplier-owned type still gets exactly one row here, because the type IS the
-- scope. tenant_id is carried denormalized so a lookup can be tenant-scoped
-- without joining document_types, the same reason 0035 carries it.

CREATE TABLE IF NOT EXISTS document_type_extraction_instructions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_type_id TEXT NOT NULL REFERENCES document_types(id) ON DELETE CASCADE,
  instructions TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  updated_by TEXT REFERENCES users(id),
  -- Both columns NOT NULL, so a plain UNIQUE actually constrains. See the
  -- NULL-distinctness note above before ever relaxing either one.
  UNIQUE (tenant_id, document_type_id)
);

-- The only read the extraction path makes: "guidance for this type, in this
-- tenant". The UNIQUE index above already covers it, but naming it keeps the
-- intent visible next to the table and matches 0035's shape.
CREATE INDEX IF NOT EXISTS idx_dtei_tenant_doctype
  ON document_type_extraction_instructions(tenant_id, document_type_id);
