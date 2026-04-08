-- Multi-product support: store per-product field sets from AI extraction
ALTER TABLE processing_queue ADD COLUMN product_fields TEXT;
