-- Migration 0067: unified intake routing (Phase P0 — additive, no behavior change)
--
-- Adds source/output-kind routing columns so a single engine can route every
-- queued document by (source_id, output_kind). Nothing consumes these yet;
-- this phase is schema + read plumbing only.
--
-- The "sources" store is the existing `connectors` table.

ALTER TABLE processing_queue ADD COLUMN source_id TEXT;
ALTER TABLE processing_queue ADD COLUMN output_kind TEXT;       -- 'coa' | 'order' | 'shipment'; NULL => treated as 'coa'
ALTER TABLE processing_queue ADD COLUMN origin_kind TEXT;       -- 'supplier' | 'internal' | 'other'
ALTER TABLE processing_queue ADD COLUMN connector_run_id TEXT;  -- batch grouping
ALTER TABLE processing_queue ADD COLUMN supplier_id TEXT;       -- pre-resolved when the door knows it
ALTER TABLE processing_queue ADD COLUMN ai_records TEXT;        -- worker write-back of structured records (consumed in a later phase)
CREATE INDEX idx_pq_output_kind ON processing_queue(tenant_id, output_kind, processing_status);

ALTER TABLE connectors ADD COLUMN origin_kind TEXT;        -- supplier | internal | other
ALTER TABLE connectors ADD COLUMN output_kind TEXT;        -- coa | order | shipment
ALTER TABLE connectors ADD COLUMN supplier_id TEXT;        -- nullable; set for supplier-dedicated COA channels
ALTER TABLE connectors ADD COLUMN document_type_id TEXT;   -- nullable
ALTER TABLE connectors ADD COLUMN intake_mode TEXT DEFAULT 'sync';  -- 'sync' | 'queue'

-- Existing connectors are all order-producing internal ERP/WMS feeds today.
UPDATE connectors SET output_kind = 'order'    WHERE output_kind IS NULL;
UPDATE connectors SET origin_kind = 'internal' WHERE origin_kind IS NULL;
UPDATE connectors SET intake_mode = 'sync'     WHERE intake_mode IS NULL;
