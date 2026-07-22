-- Migration 0078: product attribution fields.
--
-- Adds brand/producer attribution and a plant code to products. plant_code
-- is the traceability / CoA join key that ties a product to the plant that
-- produced it — it is a soft join key (no FK), matched at query time against
-- extracted document metadata.

ALTER TABLE products ADD COLUMN brand_owner TEXT;
ALTER TABLE products ADD COLUMN producer TEXT;
ALTER TABLE products ADD COLUMN plant_code TEXT;

CREATE INDEX IF NOT EXISTS idx_products_plant_code ON products(plant_code);
