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
import type { ProductSupplierSource } from '../../../shared/requirementScope';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export interface FindOrCreateProductOpts {
  supplierId?: string | null;
  supplierSku?: string | null;
  /**
   * Who is recording that the supplier ships this product (0123) — stamped on
   * a NEW `product_suppliers` row only. 'certificate' marks a product named by
   * a certificate, which the gap engine flags as a possible duplicate of one of
   * the tenant's own SKUs until an identifier confirms it.
   */
  source?: ProductSupplierSource | null;
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
    await linkProductToSupplier(db, tenantId, productId, supplierId, {
      supplierSku,
      source: opts.source ?? null,
    });
  }

  return { id: productId };
}

export interface LinkProductToSupplierResult {
  /** A new product_suppliers row was written (false = the link already existed). */
  linked: boolean;
  /** products.supplier_id was NULL and now names this supplier. */
  legacyBackfilled: boolean;
}

/**
 * Record that `supplierId` supplies `productId`: a `product_suppliers` row
 * (Model B, the graph every supplier-scoped read joins through) plus the
 * legacy `products.supplier_id` column when -- and only when -- it is NULL.
 * Idempotent; never overwrites a legacy association that names another
 * supplier. The one write path for "this supplier ships this product", used
 * by intake (`findOrCreateProduct`), POST /api/products from a supplier's
 * Products tab, and `bin/link-supplier-products`.
 *
 * `source` (0123) is written on a NEW row only. An existing link keeps what it
 * says -- including NULL, which means "linked before anyone recorded how" --
 * and a link a person marked no longer supplied is NOT revived by a
 * certificate that names the product again.
 */
export async function linkProductToSupplier(
  db: D1Database,
  tenantId: string,
  productId: string,
  supplierId: string,
  opts: { supplierSku?: string | null; source?: ProductSupplierSource | null } = {}
): Promise<LinkProductToSupplierResult> {
  const ins = await db
    .prepare(
      `INSERT INTO product_suppliers (id, tenant_id, product_id, supplier_id, supplier_sku, source)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(product_id, supplier_id) DO NOTHING`
    )
    .bind(generateId(), tenantId, productId, supplierId, opts.supplierSku ?? null, opts.source ?? null)
    .run();
  const upd = await db
    .prepare('UPDATE products SET supplier_id = ? WHERE id = ? AND tenant_id = ? AND supplier_id IS NULL')
    .bind(supplierId, productId, tenantId)
    .run();
  return {
    linked: (ins.meta?.changes ?? 0) > 0,
    legacyBackfilled: (upd.meta?.changes ?? 0) > 0,
  };
}
