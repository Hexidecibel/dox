/**
 * GET /api/suppliers/:id/product-identifiers — the SUPPLIER-SIDE view of the
 *   product identifier graph (migrations 0107 / 0113): every item number and
 *   product name this supplier's paperwork uses, with the product of ours each
 *   one names; and the product names / item numbers this supplier's
 *   certificates actually carry that do not yet resolve to one confirmed
 *   product of ours ("map each certificate product this supplier has sent").
 *   Any role in the tenant (read-only).
 *
 * GET /api/suppliers/:id/product-identifiers?coa_product=&item= — resolve one
 *   certificate product the way the lot matcher does (item number first, then
 *   name + pack, then a name that names exactly one product). Used to prefill
 *   the review-time mapping control.
 *
 * WRITES ARE NOT HERE. Adding, confirming and removing an identifier go through
 * the same endpoints the Product page uses — POST /api/products/:id/identifiers,
 * PUT / DELETE /api/product-identifiers/:id — so there is one API, with one set
 * of permissions (org_admin / super_admin) and one audit trail, and two views.
 * This replaced GET/PUT /api/product-map (supplier_product_map), removed in 0113.
 */

import { NotFoundError, errorToResponse } from '../../../lib/permissions';
import { loadProductCatalog } from '../../../lib/product-identifiers';
import { describePack, findPacks } from '../../../../shared/productVocabulary';
import { documentSupplierItem } from '../../../../shared/productIdentity';
import {
  bridgeEvidenceFromMetadata,
  resolveSupplierProduct,
} from '../../../../shared/supplierProductBridge';
import type { Env, User } from '../../../lib/types';
import type {
  ProductIdentifier,
  SupplierProductIdentifierRow,
  SupplierProductIdentifiersResponse,
  SupplierProductResolveResponse,
  SupplierUnidentifiedProduct,
} from '../../../../shared/types';

/** Distinct certificate products read per supplier; past this is a design review, not a slow tab. */
const DISTINCT_CAP = 500;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function loadSupplier(db: D1Database, user: User, supplierId: string) {
  const supplier = await db
    .prepare('SELECT id, tenant_id, name FROM suppliers WHERE id = ?')
    .bind(supplierId)
    .first<{ id: string; tenant_id: string; name: string }>();
  // Another tenant's supplier is indistinguishable from a missing one.
  if (!supplier || (user.role !== 'super_admin' && supplier.tenant_id !== user.tenant_id)) {
    throw new NotFoundError('Supplier not found');
  }
  return supplier;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const db = context.env.DB;
    const supplier = await loadSupplier(db, user, context.params.id as string);
    const url = new URL(context.request.url);
    const catalog = await loadProductCatalog(db, supplier.tenant_id);

    const coaProduct = url.searchParams.get('coa_product');
    const item = url.searchParams.get('item');
    if (coaProduct !== null || item !== null) {
      const resolution = resolveSupplierProduct(
        catalog,
        bridgeEvidenceFromMetadata(
          { product_name: coaProduct ?? undefined, product_code: item ?? undefined },
          { supplierId: supplier.id },
        ),
      );
      const body: SupplierProductResolveResponse = { resolution };
      return json(body);
    }

    // This supplier's identifiers, with the product each one names.
    const idRes = await db
      .prepare(
        `SELECT pi.*, s.name AS supplier_name, p.name AS product_name, p.active AS product_active
           FROM product_identifiers pi
           JOIN products p ON p.id = pi.product_id
           LEFT JOIN suppliers s ON s.id = pi.supplier_id
          WHERE pi.tenant_id = ? AND pi.supplier_id = ?
          ORDER BY p.name, CASE pi.kind WHEN 'supplier_item' THEN 0 ELSE 1 END, pi.superseded, pi.value`,
      )
      .bind(supplier.tenant_id, supplier.id)
      .all<ProductIdentifier & { product_name: string; product_active: 0 | 1 }>();
    const rows = idRes.results ?? [];
    const productIds = [...new Set(rows.map((r) => r.product_id))];
    const extras = new Map<string, { skus: string[]; packs: string[] }>();
    if (productIds.length > 0) {
      const placeholders = productIds.map(() => '?').join(',');
      const ex = await db
        .prepare(
          `SELECT product_id, kind, value FROM product_identifiers
            WHERE tenant_id = ? AND kind IN ('our_sku', 'pack') AND product_id IN (${placeholders})
            ORDER BY superseded, value`,
        )
        .bind(supplier.tenant_id, ...productIds)
        .all<{ product_id: string; kind: string; value: string }>();
      for (const r of ex.results ?? []) {
        const e = extras.get(r.product_id) ?? { skus: [], packs: [] };
        (r.kind === 'our_sku' ? e.skus : e.packs).push(r.value);
        extras.set(r.product_id, e);
      }
    }
    const packFor = (productId: string, productName: string): string | null => {
      const declared = extras.get(productId)?.packs[0];
      const text = declared ?? productName;
      const p = findPacks(text).find((x) => x.quantity !== null) ?? findPacks(text)[0];
      return p ? describePack(p) : null;
    };
    const identifiers: SupplierProductIdentifierRow[] = rows.map((r) => ({
      ...r,
      product_our_skus: extras.get(r.product_id)?.skus ?? [],
      product_pack: packFor(r.product_id, r.product_name),
    }));

    // What this supplier's certificates actually carry, grouped.
    const docRes = await db
      .prepare(
        `SELECT json_extract(d.primary_metadata, '$.product_name') AS product_name,
                COALESCE(json_extract(d.primary_metadata, '$.product_code'),
                         json_extract(d.primary_metadata, '$.item_number'),
                         json_extract(d.primary_metadata, '$.supplier_item_number')) AS supplier_item,
                json_extract(d.primary_metadata, '$.net_weight') AS net_weight,
                json_extract(d.primary_metadata, '$.package_size') AS package_size,
                COUNT(*) AS document_count,
                MAX(d.created_at) AS last_seen,
                MAX(d.id) AS sample_document_id
           FROM documents d
          WHERE d.tenant_id = ? AND d.supplier_id = ? AND d.status = 'active' AND json_valid(d.primary_metadata)
            AND (json_extract(d.primary_metadata, '$.product_name') IS NOT NULL
                 OR json_extract(d.primary_metadata, '$.product_code') IS NOT NULL)
          GROUP BY 1, 2, 3, 4
          ORDER BY document_count DESC, last_seen DESC
          LIMIT ?`,
      )
      .bind(supplier.tenant_id, supplier.id, DISTINCT_CAP)
      .all<{
        product_name: string | null; supplier_item: string | number | null; net_weight: string | null;
        package_size: string | null; document_count: number; last_seen: string | null; sample_document_id: string;
      }>();

    // Fold pack-only differences together: a person maps a name + item, the
    // pack is evidence the resolver reads per certificate.
    const grouped = new Map<string, SupplierUnidentifiedProduct>();
    for (const r of docRes.results ?? []) {
      const metadata: Record<string, unknown> = {
        product_name: r.product_name ?? undefined,
        product_code: r.supplier_item == null ? undefined : String(r.supplier_item),
        net_weight: r.net_weight ?? undefined,
        package_size: r.package_size ?? undefined,
      };
      const resolution = resolveSupplierProduct(catalog, bridgeEvidenceFromMetadata(metadata, { supplierId: supplier.id }));
      if (resolution.product_id && resolution.confirmed) continue;
      const supplierItem = documentSupplierItem(metadata);
      const key = `${r.product_name ?? ''}::${supplierItem ?? ''}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.document_count += r.document_count;
        if ((r.last_seen ?? '') > (existing.last_seen ?? '')) existing.last_seen = r.last_seen;
        if (!existing.resolution.note && resolution.note) existing.resolution = resolution;
        continue;
      }
      grouped.set(key, {
        product_name: r.product_name,
        supplier_item: supplierItem,
        document_count: r.document_count,
        last_seen: r.last_seen,
        sample_document_id: r.sample_document_id,
        resolution,
      });
    }

    const body: SupplierProductIdentifiersResponse = {
      supplier: { id: supplier.id, name: supplier.name },
      identifiers,
      unidentified: [...grouped.values()].sort((a, b) => b.document_count - a.document_count),
    };
    return json(body);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Supplier product identifiers error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
