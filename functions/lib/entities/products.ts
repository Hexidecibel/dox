/**
 * Shared product resolution + creation logic.
 *
 * Callers (queue-approve single + multi product, and any future intake
 * pipeline) should funnel product creation through here so the
 * product↔supplier provenance graph (`product_suppliers`, Model B) stays
 * consistent regardless of entry point.
 *
 * Resolution is a case-insensitive name match scoped to the tenant. When a
 * product is created we set `products.supplier_id` from `opts.supplierId`
 * (legacy single-FK column, kept for back-compat). When a supplier is known
 * we ALSO upsert a `product_suppliers` row so a product can carry multiple
 * suppliers over time. On the found-but-orphaned path we backfill the legacy
 * `supplier_id` only when it is currently NULL — never overwriting a
 * deliberate existing association.
 *
 * Mirrors the structure of functions/lib/suppliers.ts#findOrCreateSupplier.
 */

import type { D1Database } from '@cloudflare/workers-types';
import { generateId } from '../db';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export interface FindOrCreateProductOpts {
  supplierId?: string | null;
  supplierSku?: string | null;
}

export interface FindOrCreateProductResult {
  id: string;
}

/**
 * Resolve a product by name within a tenant, creating it if absent, and wire
 * up the supplier provenance link when a supplier is provided.
 */
export async function findOrCreateProduct(
  db: D1Database,
  tenantId: string,
  name: string,
  opts: FindOrCreateProductOpts = {}
): Promise<FindOrCreateProductResult> {
  const trimmed = (name || '').trim();
  if (!trimmed) {
    throw new Error('product name is required');
  }

  const supplierId = opts.supplierId ?? null;
  const supplierSku = opts.supplierSku ?? null;

  // 1. Case-insensitive name match scoped to tenant.
  const existing = await db
    .prepare('SELECT id, supplier_id FROM products WHERE LOWER(name) = LOWER(?) AND tenant_id = ?')
    .bind(trimmed, tenantId)
    .first<{ id: string; supplier_id: string | null }>();

  let productId: string;

  if (existing) {
    productId = existing.id;

    // Backfill the legacy supplier_id only when it is currently NULL. Never
    // overwrite an existing (possibly deliberate) association.
    if (supplierId && !existing.supplier_id) {
      await db
        .prepare('UPDATE products SET supplier_id = ? WHERE id = ?')
        .bind(supplierId, productId)
        .run();
    }
  } else {
    // 2. Create. supplierId may be null — that's acceptable.
    productId = generateId();
    const slug = slugify(trimmed);
    await db
      .prepare('INSERT INTO products (id, name, slug, tenant_id, supplier_id) VALUES (?, ?, ?, ?, ?)')
      .bind(productId, trimmed, slug, tenantId, supplierId)
      .run();
  }

  // 3. Upsert the provenance link when a supplier is known.
  if (supplierId) {
    await db
      .prepare(
        `INSERT INTO product_suppliers (id, tenant_id, product_id, supplier_id, supplier_sku)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(product_id, supplier_id) DO NOTHING`
      )
      .bind(generateId(), tenantId, productId, supplierId, supplierSku)
      .run();
  }

  return { id: productId };
}
