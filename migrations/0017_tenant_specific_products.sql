-- Make products tenant-specific (instead of global catalog)
-- Also removes email_domain_mappings table (feature removed)

-- 1. Create new products table with tenant_id
CREATE TABLE products_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(tenant_id, slug)
);

-- 2. Migrate data: pull tenant_id from tenant_products
INSERT INTO products_new (id, tenant_id, name, slug, description, active, created_at, updated_at)
SELECT p.id, tp.tenant_id, p.name, p.slug, p.description, p.active, p.created_at, p.updated_at
FROM products p
INNER JOIN tenant_products tp ON tp.product_id = p.id;

-- 3. Drop old tables and rename
DROP TABLE IF EXISTS tenant_products;
DROP TABLE IF EXISTS products;
ALTER TABLE products_new RENAME TO products;

-- 4. Recreate indexes
CREATE INDEX IF NOT EXISTS idx_products_tenant ON products(tenant_id);
CREATE INDEX IF NOT EXISTS idx_products_slug ON products(slug);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);

-- 5. Remove email domain mappings (feature removed)
DROP TABLE IF EXISTS email_domain_mappings;
