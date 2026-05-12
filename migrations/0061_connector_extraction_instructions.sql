-- Migration 0061: Per-connector natural-language extraction instructions (R2.b).
--
-- Connectors don't carry a supplier_id — orders/customers/items extraction is
-- whole-stream, not per-vendor — so per-supplier instructions (migration 0035,
-- DOCUMENT path) don't apply. Reviewers configure connector-level guidance
-- once and the orchestrator prepends it to the Qwen parsing prompt on every
-- subsequent run.
--
-- See `functions/lib/connectors/email.ts:parseWithAI` for the prepend point
-- and `src/pages/admin/ConnectorDetail.tsx` for the editor surface.

ALTER TABLE connectors ADD COLUMN extraction_instructions TEXT;
