-- Migration 0086: give spec_limits a real identity.
--
-- WHY
-- ---
-- 0084 shipped spec_limits with no uniqueness at all. Nothing stops two rows
-- from holding different thresholds for the same analyte at the same scope, and
-- when that happens `resolveSpecLimits` picks the more recently updated one --
-- silently, with no way for anyone to see that a second limit exists. A
-- spreadsheet importer run twice would double every row and the second run's
-- numbers would quietly win. The identity of a limit is its (tenant, analyte,
-- scope) tuple; this migration says so in the schema.
--
-- THE NULL TRAP -- the whole reason this is an EXPRESSION index
-- -------------------------------------------------------------
-- SQLite treats NULLs as DISTINCT in a UNIQUE index. All three scope columns
-- are nullable and NULL means "any", so the most common row of all -- the
-- tenant-wide default with supplier_id, document_type_id and product_id all
-- NULL -- would be exempt from a plain
--
--     UNIQUE (tenant_id, spec_test_id, supplier_id, document_type_id, product_id)
--
-- Every all-NULL row would compare distinct from every other all-NULL row and
-- the constraint would enforce nothing where it is needed most. Migration 0073
-- hit this on lots.sub_lot_code and solved it with a '' sentinel, because that
-- column was NOT NULL DEFAULT '' and could be.
--
-- Here the sentinel is NOT available. NULL is load-bearing in the read path:
-- `applies()` and `specificity()` in shared/specCheck.ts branch on the column
-- being falsy, functions/api/spec-limits/index.ts writes `body.supplier_id ||
-- null`, and the GET joins LEFT JOIN on suppliers/document_types/products. A
-- stored '' would be a foreign key value that matches no row. So we COALESCE at
-- the index instead: the stored value stays NULL and only the index key is
-- folded to ''. Scope resolution is untouched.
--
-- SCOPE OF THE CONSTRAINT
-- -----------------------
-- `active` is deliberately NOT in the key. A deactivated limit still occupies
-- its scope; letting an inactive row sit alongside an active one at the same
-- scope would recreate exactly the invisible-duplicate problem this closes, and
-- the honest way to replace a limit is to edit it (bumping `version`, which
-- document_spec_checks.limit_snapshot already records) rather than to leave a
-- tombstone behind.
--
-- IF THIS MIGRATION FAILS with "UNIQUE constraint failed", the database already
-- holds duplicate-scope limits. Find them before retrying:
--
--   SELECT tenant_id, spec_test_id,
--          COALESCE(supplier_id,''), COALESCE(document_type_id,''),
--          COALESCE(product_id,''), COUNT(*) n, GROUP_CONCAT(id)
--     FROM spec_limits
--    GROUP BY 1,2,3,4,5 HAVING n > 1;
--
-- Keep the row whose threshold is correct, delete the rest. Do not widen the
-- index to make the collision legal.

CREATE UNIQUE INDEX IF NOT EXISTS idx_spec_limits_scope
  ON spec_limits (
    tenant_id,
    spec_test_id,
    COALESCE(supplier_id, ''),
    COALESCE(document_type_id, ''),
    COALESCE(product_id, '')
  );
