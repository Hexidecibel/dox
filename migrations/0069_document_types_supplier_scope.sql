-- Reparent document types under suppliers (HYBRID model).
-- A NULL supplier_id means the doctype is shared/global within the tenant
-- (all existing rows stay NULL — no document relinking). A non-null
-- supplier_id means the doctype is owned by that supplier.
--
-- SQLite ALTER TABLE cannot add a foreign key, so we add the column plus a
-- supporting index. supplier_id references suppliers(id) conceptually.
--
-- The document_types_fts triggers (migration 0054) enumerate named columns
-- (name, slug, description, doc_type_id, tenant_id) only, so ADD COLUMN does
-- not affect them — no trigger change required.

ALTER TABLE document_types ADD COLUMN supplier_id TEXT;

CREATE INDEX IF NOT EXISTS idx_document_types_supplier
  ON document_types(tenant_id, supplier_id);
