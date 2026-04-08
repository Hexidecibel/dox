-- Add supplier_id to products table
ALTER TABLE products ADD COLUMN supplier_id TEXT REFERENCES suppliers(id);
CREATE INDEX IF NOT EXISTS idx_products_supplier ON products(supplier_id);
