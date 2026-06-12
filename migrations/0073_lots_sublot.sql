-- COA sublot split (Option B): push sublot grain down into the lots layer.
--
-- Each sublot of a COA becomes its own `lots` row, matched to orders via a
-- concatenated lot_key = norm(lot_number) + sub_lot_code (e.g. "10426110" +
-- "05" = "1042611005"). The WMS already combines lot+sublot into one lot value,
-- so order_items.lot_number already carries the combined key — no order-side
-- change is needed. This migration is COA-side only.
--
-- sub_lot_code stores the 2-digit sublot (e.g. "05"); main-lot-only rows use
-- '' (the empty string), NEVER NULL. SQLite treats NULLs as DISTINCT in unique
-- indexes, so a NULL sub_lot_code would silently let duplicate main lots
-- through idx_lots_identity. The '' sentinel is the one real correctness trap.
--
-- The identity index moves from (tenant_id, product_id, lot_key) to
-- (tenant_id, product_id, lot_key, sub_lot_code). lot_key already embeds the
-- sublot, so sub_lot_code is in the index mainly for explicitness + so a
-- main-lot row and its sublot rows can never collide on key alone.

ALTER TABLE lots ADD COLUMN sub_lot_code TEXT NOT NULL DEFAULT '';

DROP INDEX idx_lots_identity;
CREATE UNIQUE INDEX idx_lots_identity ON lots(tenant_id, product_id, lot_key, sub_lot_code);
