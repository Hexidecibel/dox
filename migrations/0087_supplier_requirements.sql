-- Migration 0087: supplier_requirements — WHICH requirements apply to WHOM.
--
-- WHY
-- ---
-- 0080 gave a tenant a vocabulary of checklist line items (`requirements`) and
-- a junction saying which documents CLOSE them (`document_requirements`). What
-- it did NOT give is the applicability half: nothing anywhere says that a
-- requirement APPLIES to a particular supplier. A requirement today is a
-- tenant-wide noun with no supplier dimension at all.
--
-- That makes the sentence the client actually asks — "this supplier owes us N
-- documents" — structurally unrepresentable, not merely unimplemented. Gap
-- detection is a set difference:
--
--     (requirements that APPLY to this supplier)      <-- THIS TABLE
--   MINUS
--     (requirements CLOSED by that supplier's docs)   <-- document_requirements
--
-- Without the left-hand side there is no gap to compute, and the supplier
-- satisfied/open view and the "request the missing documents" composer have
-- nothing to enumerate.
--
-- WHY A TABLE AND NOT A COLUMN
-- ----------------------------
-- Applicability is many-to-many: one requirement applies to many suppliers, one
-- supplier owes many requirements. A `supplier_id` column on `requirements`
-- would force a duplicate vocabulary row per supplier — the same line item
-- appearing N times, each with its own id, so `document_requirements` rows for
-- "Allergen Matrix" would no longer be comparable across suppliers and every
-- roll-up would have to string-match names. The vocabulary stays one row per
-- line item; applicability is its own join.
--
-- TIER — two values, decided by the client
-- ----------------------------------------
-- 'required'    counts as a gap when unsatisfied.
-- 'recommended' is advisory: surfaced, never counted as a gap by default.
--
-- Gap reports default to `required` only. Modelled as TEXT + CHECK rather than
-- the 0/1 INTEGER used by claim_type_requirements.is_required because the
-- client has already named two tiers and may name a third; a text value reads
-- correctly in a report and widening a CHECK is a smaller rebuild than
-- reinterpreting a boolean after the fact.
--
-- THE SQLite NULL-IN-UNIQUE TRAP — avoided at the source, not patched over
-- -----------------------------------------------------------------------
-- SQLite treats NULLs as DISTINCT in a UNIQUE index, so a nullable key column
-- silently exempts exactly the rows you most want constrained. 0086 hit this on
-- spec_limits (all-NULL "tenant-wide default" scope rows) and had to reach for
-- an expression index over COALESCE(col,''); 0073 hit it on lots.sub_lot_code
-- and used a '' sentinel.
--
-- Here the trap does not apply, and that is a deliberate design choice rather
-- than luck: all three key columns are NOT NULL. This table answers ONE
-- question — does requirement R apply to supplier S — and a NULL supplier_id
-- meaning "every supplier" would be a SECOND, different question (a tenant-wide
-- default) smuggled into the same rows. It would also be the precise shape that
-- defeats the constraint: unlimited duplicate all-suppliers rows for the same
-- requirement, invisibly disagreeing on tier.
--
-- So a plain UNIQUE is correct and sufficient here. If a tenant-wide default is
-- ever wanted, do NOT relax supplier_id to nullable — that reintroduces 0086's
-- problem. Either seed explicit per-supplier rows, or add a separate defaults
-- table; if a nullable column is genuinely unavoidable, the index must become
-- the 0086 expression form:
--
--   CREATE UNIQUE INDEX ... ON supplier_requirements (
--     tenant_id, requirement_id, COALESCE(supplier_id, ''));
--
-- DETACH IS A DELETE, not a soft-delete. `requirements` soft-deletes (active=0)
-- because history must keep resolving its ids: document_requirements rows point
-- at them. Nothing points at a supplier_requirements row — it is pure
-- configuration, re-addable in one click — so a tombstone would only be another
-- state for the gap query to have to exclude.

CREATE TABLE IF NOT EXISTS supplier_requirements (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  -- Denormalized off suppliers/requirements so a gap query can scope by tenant
  -- without two joins, and so a row cannot silently straddle tenants (the
  -- cross-tenant check lives in the API, as it does for claim_type_requirements).
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  tier TEXT NOT NULL DEFAULT 'required'
    CHECK (tier IN ('required','recommended')),
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  created_by TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  updated_by TEXT,
  UNIQUE(tenant_id, supplier_id, requirement_id)
);

-- The gap query's own access path: "everything supplier S owes", optionally
-- narrowed to tier='required'.
CREATE INDEX IF NOT EXISTS idx_supplier_requirements_supplier
  ON supplier_requirements(tenant_id, supplier_id, tier);

-- The inverse question the admin UI asks: "which suppliers owe this line item"
-- (and what a soft-delete of the requirement would affect).
CREATE INDEX IF NOT EXISTS idx_supplier_requirements_requirement
  ON supplier_requirements(requirement_id);
