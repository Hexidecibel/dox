-- Per-tenant editable extraction-prompt layer.
--
-- The "industry layer" of the extraction prompt (the dairy domain brain) was a
-- hardcoded constant shared by every tenant. This makes it an editable per-tenant
-- field: when extraction_context is NULL the worker / Pages-Function path falls
-- back to the seeded DEFAULT_DAIRY_CONTEXT constant (zero regression). Universal
-- mechanics (don't-hallucinate, JSON shape, supplier-vs-customer) stay hardcoded
-- in BASE_PROMPT and are NOT part of this column.
--
-- All three columns are nullable TEXT. extraction_context NULL = use default.
-- updated_at / updated_by track the last edit through
-- /api/tenant-extraction-context (org_admin+).

ALTER TABLE tenants ADD COLUMN extraction_context TEXT;
ALTER TABLE tenants ADD COLUMN extraction_context_updated_at TEXT;
ALTER TABLE tenants ADD COLUMN extraction_context_updated_by TEXT;
