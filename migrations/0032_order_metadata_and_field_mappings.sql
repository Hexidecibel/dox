-- Migration 0032: mirror documents primary_metadata/extended_metadata pattern on orders
--
-- Wave 1 of the open-ended field-mapping refactor. Adds two JSON-blob columns
-- to the orders table so the connector orchestrator can persist whatever
-- metadata shape the connector's v2 field_mappings config produces, without
-- requiring a schema change per new field. This mirrors the pattern that
-- migration 0022 added for documents (primary_metadata + extended_metadata).
--
-- source_data on orders remains the "raw untouched" channel; primary_metadata
-- is the mapped canonical-core fields, extended_metadata is the user-defined
-- overflow. Existing rows have NULL in both columns and behave as before.

ALTER TABLE orders ADD COLUMN primary_metadata TEXT;
ALTER TABLE orders ADD COLUMN extended_metadata TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_primary_metadata ON orders(primary_metadata);
CREATE INDEX IF NOT EXISTS idx_orders_extended_metadata ON orders(extended_metadata);
