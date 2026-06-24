import { generateId, logAudit, getClientIp } from '../lib/db';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  NotFoundError,
  errorToResponse,
} from '../lib/permissions';
import { normalizeProductNameKey } from '../lib/entities/lots';
import type { Env, User } from '../lib/types';
import type { ProductMapEntry } from '../../shared/types';

/**
 * Resolve the supplier and its tenant, enforcing tenant access. Returns the
 * supplier row's tenant_id (the canonical tenant scope for the map row).
 */
async function resolveSupplierTenant(
  db: D1Database,
  user: User,
  supplierId: string
): Promise<string> {
  const supplier = await db
    .prepare('SELECT id, tenant_id FROM suppliers WHERE id = ?')
    .bind(supplierId)
    .first<{ id: string; tenant_id: string }>();
  if (!supplier) {
    throw new NotFoundError('Supplier not found');
  }
  requireTenantAccess(user, supplier.tenant_id);
  return supplier.tenant_id;
}

/**
 * GET /api/product-map?supplier_id=&coa_product=
 * Look up the teachable COA-product -> order-product mapping for a supplier,
 * keyed on the normalized COA product name. Returns { mapping | null }.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user', 'reader');

    const url = new URL(context.request.url);
    const supplierId = url.searchParams.get('supplier_id');
    const coaProduct = url.searchParams.get('coa_product');

    if (!supplierId) {
      throw new BadRequestError('supplier_id is required');
    }
    if (!coaProduct) {
      throw new BadRequestError('coa_product is required');
    }

    const tenantId = await resolveSupplierTenant(context.env.DB, user, supplierId);
    const key = normalizeProductNameKey(coaProduct);

    const mapping = await context.env.DB.prepare(
      `SELECT m.*, p.name AS order_product_name
       FROM supplier_product_map m
       LEFT JOIN products p ON p.id = m.order_product_id
       WHERE m.tenant_id = ? AND m.supplier_id = ? AND m.coa_product_name_key = ?`
    )
      .bind(tenantId, supplierId, key)
      .first<ProductMapEntry>();

    return new Response(JSON.stringify({ mapping: mapping ?? null }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Get product-map error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/**
 * PUT /api/product-map
 * Body: { supplier_id, coa_product, order_product_id, distributor_sku?, coa_product_id? }
 * Upsert (UNIQUE(tenant_id, supplier_id, coa_product_name_key)) the mapping.
 * org_admin/user (matches doc-mutation gating). Returns { mapping }.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const body = (await context.request.json()) as {
      supplier_id?: string;
      coa_product?: string;
      order_product_id?: string;
      distributor_sku?: string | null;
      coa_product_id?: string | null;
    };

    if (!body.supplier_id) {
      throw new BadRequestError('supplier_id is required');
    }
    if (!body.coa_product || !body.coa_product.trim()) {
      throw new BadRequestError('coa_product is required');
    }
    if (!body.order_product_id) {
      throw new BadRequestError('order_product_id is required');
    }

    const tenantId = await resolveSupplierTenant(
      context.env.DB,
      user,
      body.supplier_id
    );
    const key = normalizeProductNameKey(body.coa_product);

    await upsertProductMap(context.env.DB, {
      id: generateId(),
      tenantId,
      supplierId: body.supplier_id,
      coaProductNameKey: key,
      coaProductId: body.coa_product_id ?? null,
      orderProductId: body.order_product_id,
      distributorSku: body.distributor_sku ?? null,
      createdBy: user.id,
    });

    const mapping = await context.env.DB.prepare(
      `SELECT * FROM supplier_product_map
       WHERE tenant_id = ? AND supplier_id = ? AND coa_product_name_key = ?`
    )
      .bind(tenantId, body.supplier_id, key)
      .first<ProductMapEntry>();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'product_map.upserted',
      'supplier_product_map',
      mapping?.id ?? key,
      JSON.stringify({
        supplier_id: body.supplier_id,
        coa_product_name_key: key,
        order_product_id: body.order_product_id,
      }),
      getClientIp(context.request)
    );

    return new Response(JSON.stringify({ mapping }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Put product-map error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/**
 * Shared upsert against the UNIQUE(tenant_id, supplier_id, coa_product_name_key)
 * index. Exported so the COA approve handler can write the map at approve time
 * (the primary write path — a brand-new supplier has no id for a client PUT).
 */
export async function upsertProductMap(
  db: D1Database,
  row: {
    id: string;
    tenantId: string;
    supplierId: string;
    coaProductNameKey: string;
    coaProductId: string | null;
    orderProductId: string;
    distributorSku: string | null;
    createdBy: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO supplier_product_map
         (id, tenant_id, supplier_id, coa_product_name_key, coa_product_id,
          order_product_id, distributor_sku, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(tenant_id, supplier_id, coa_product_name_key) DO UPDATE SET
         coa_product_id = excluded.coa_product_id,
         order_product_id = excluded.order_product_id,
         distributor_sku = excluded.distributor_sku,
         updated_at = datetime('now')`
    )
    .bind(
      row.id,
      row.tenantId,
      row.supplierId,
      row.coaProductNameKey,
      row.coaProductId,
      row.orderProductId,
      row.distributorSku,
      row.createdBy
    )
    .run();
}
