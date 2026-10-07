import { generateId } from '../../lib/db';
import { logAudit, getClientIp } from '../../lib/db';
import { requireRole, requireTenantAccess, errorToResponse } from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import { linkProductToSupplier } from '../../lib/entities/products';
import type { Env, User } from '../../lib/types';

function slugify(text: string): string {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * GET /api/products
 * List products filtered by tenant. Supports ?search=, ?active=1, ?tenant_id=, pagination (limit, offset).
 * Non-super_admin users always see their own tenant's products.
 * Super_admin can optionally filter by ?tenant_id=.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);
    const search = url.searchParams.get('search');
    const activeFilter = url.searchParams.get('active');
    const supplierIdFilter = url.searchParams.get('supplier_id');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    // Tenant filtering
    if (user.role !== 'super_admin') {
      conditions.push('tenant_id = ?');
      params.push(user.tenant_id!);
    } else {
      const tenantIdParam = url.searchParams.get('tenant_id');
      if (tenantIdParam) {
        conditions.push('tenant_id = ?');
        params.push(tenantIdParam);
      }
    }

    if (activeFilter === 'all') {
      // Explicitly include inactive products (e.g. the product-map editor needs
      // to map inactive-but-still-shipping products to distributor SKUs).
    } else if (activeFilter !== null) {
      conditions.push('active = ?');
      params.push(Number(activeFilter));
    } else {
      // Default to showing only active products
      conditions.push('active = 1');
    }

    if (supplierIdFilter) {
      // A product belongs to a supplier via EITHER the legacy single-FK column
      // (products.supplier_id) OR the product_suppliers provenance graph
      // (Model B). Backfilled products carry only the latter, so both paths
      // must be checked. Table-qualify the legacy column so it isn't ambiguous
      // with the subquery.
      conditions.push(
        '(products.supplier_id = ? OR products.id IN (SELECT product_id FROM product_suppliers WHERE supplier_id = ?))'
      );
      params.push(supplierIdFilter, supplierIdFilter);
    }

    if (search) {
      conditions.push('(name LIKE ? OR description LIKE ?)');
      const pattern = `%${search}%`;
      params.push(pattern, pattern);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countResult = await context.env.DB.prepare(
      `SELECT COUNT(*) as total FROM products ${whereClause}`
    )
      .bind(...params)
      .first<{ total: number }>();

    // Get products
    // Scoped to one supplier, each row also carries THIS supplier's link facts
    // (migration 0123): who recorded the link, whether it is no longer
    // supplied, and a "nothing owed per product" declaration. NULL on a
    // legacy-only link, which has no product_suppliers row.
    const linkColumns = supplierIdFilter
      ? `, (SELECT ps.source FROM product_suppliers ps WHERE ps.product_id = products.id AND ps.supplier_id = ?) AS link_source,
           (SELECT ps.discontinued_at FROM product_suppliers ps WHERE ps.product_id = products.id AND ps.supplier_id = ?) AS link_discontinued_at,
           (SELECT ps.nothing_owed_reason FROM product_suppliers ps WHERE ps.product_id = products.id AND ps.supplier_id = ?) AS link_nothing_owed_reason,
           (SELECT ps.approval_status FROM product_suppliers ps WHERE ps.product_id = products.id AND ps.supplier_id = ?) AS link_approval_status,
           (SELECT ps.approval_source FROM product_suppliers ps WHERE ps.product_id = products.id AND ps.supplier_id = ?) AS link_approval_source,
           (SELECT ps.approval_note FROM product_suppliers ps WHERE ps.product_id = products.id AND ps.supplier_id = ?) AS link_approval_note,
           (SELECT ps.approval_decided_at FROM product_suppliers ps WHERE ps.product_id = products.id AND ps.supplier_id = ?) AS link_approval_decided_at,
           (SELECT ps.facility_id FROM product_suppliers ps WHERE ps.product_id = products.id AND ps.supplier_id = ?) AS link_facility_id,
           (SELECT f.name FROM product_suppliers ps JOIN supplier_facilities f ON f.id = ps.facility_id
             WHERE ps.product_id = products.id AND ps.supplier_id = ?) AS link_facility_name`
      : '';
    // One bind per link column above (approval + facility: migration 0135).
    const linkParams = supplierIdFilter ? Array.from({ length: 9 }, () => supplierIdFilter) : [];
    const results = await context.env.DB.prepare(
      `SELECT products.*${linkColumns} FROM products ${whereClause} ORDER BY name ASC LIMIT ? OFFSET ?`
    )
      .bind(...linkParams, ...params, limit, offset)
      .all();

    return new Response(
      JSON.stringify({
        products: results.results,
        total: countResult?.total || 0,
        limit,
        offset,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('List products error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * POST /api/products
 * Create a new product. org_admin+ can create for their tenant.
 * Fields: name (required), description (optional), tenant_id (required for super_admin, auto-set for others).
 * Auto-generates slug from name. Slug uniqueness is per-tenant.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const body = (await context.request.json()) as {
      name?: string;
      description?: string;
      tenant_id?: string;
      supplier_id?: string;
      // Dual-attribution / traceability (migration 0078).
      brand_owner?: string | null;
      producer?: string | null;
      plant_code?: string | null;
    };

    // Determine tenant_id
    let tenantId: string;
    if (user.role === 'super_admin') {
      if (!body.tenant_id) {
        return new Response(
          JSON.stringify({ error: 'tenant_id is required' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      tenantId = body.tenant_id;
    } else {
      tenantId = user.tenant_id!;
    }

    requireTenantAccess(user, tenantId);

    if (!body.name || !body.name.trim()) {
      return new Response(
        JSON.stringify({ error: 'name is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Sanitize inputs
    body.name = sanitizeString(body.name);
    if (body.description) body.description = sanitizeString(body.description);

    const slug = slugify(body.name);

    if (!slug) {
      return new Response(
        JSON.stringify({ error: 'Could not generate a valid slug from name' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // A supplier context (Supplier > Products tab) must name a supplier of
    // THIS tenant: the link it writes is what the tab lists by.
    const supplierId = body.supplier_id || null;
    let supplierName: string | null = null;
    if (supplierId) {
      const sup = await context.env.DB.prepare(
        'SELECT id, name FROM suppliers WHERE id = ? AND tenant_id = ?'
      )
        .bind(supplierId, tenantId)
        .first<{ id: string; name: string }>();
      if (!sup) {
        return new Response(
          JSON.stringify({ error: 'Supplier not found' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }
      supplierName = sup.name;
    }

    // Check slug uniqueness within tenant
    const existing = await context.env.DB.prepare(
      'SELECT id, name, active FROM products WHERE slug = ? AND tenant_id = ?'
    )
      .bind(slug, tenantId)
      .first<{ id: string; name: string; active: number }>();

    if (existing) {
      if (!supplierId) {
        return new Response(
          JSON.stringify({
            error: `A product named "${existing.name}" already exists in this organization`,
            existing_product_id: existing.id,
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // From a supplier's Products tab, "add a product this supplier ships"
      // whose name the catalog already holds means: this supplier ships THAT
      // product. Products are the tenant's own catalog, one row per product,
      // so the answer is a link, never a second row and never a bare 409 the
      // person cannot act on (AJ, 2026-09-20: the retry said "slug exists"
      // for a product the tab never showed).
      const link = await linkProductToSupplier(context.env.DB, tenantId, existing.id, supplierId, { source: 'admin' });
      if (link.linked || link.legacyBackfilled) {
        await logAudit(
          context.env.DB,
          user.id,
          tenantId,
          'product.supplier_linked',
          'product',
          existing.id,
          JSON.stringify({
            product_name: existing.name,
            supplier_id: supplierId,
            supplier_name: supplierName,
            via: 'product_create_existing_name',
            legacy_supplier_id_set: link.legacyBackfilled,
          }),
          getClientIp(context.request)
        );
      }
      const product = await context.env.DB.prepare('SELECT * FROM products WHERE id = ?')
        .bind(existing.id)
        .first();
      const inactive = !existing.active;
      const message = !link.linked
        ? `"${existing.name}" is already listed under ${supplierName}.`
        : `"${existing.name}" already existed in your product catalog, so it was linked to ${supplierName} instead of creating a duplicate.`;
      return new Response(
        JSON.stringify({
          product,
          linked_existing: true,
          already_linked: !link.linked,
          inactive,
          message: inactive
            ? `${message} It is deactivated, so it will not show in active lists until it is reactivated on the Products page.`
            : message,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const id = generateId();

    await context.env.DB.prepare(
      `INSERT INTO products (id, tenant_id, name, slug, description, active, supplier_id, brand_owner, producer, plant_code)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
    )
      .bind(
        id,
        tenantId,
        body.name,
        slug,
        body.description || null,
        supplierId,
        body.brand_owner ? sanitizeString(body.brand_owner) : null,
        body.producer ? sanitizeString(body.producer) : null,
        body.plant_code ? sanitizeString(body.plant_code) : null,
      )
      .run();

    // The provenance graph every supplier-scoped read joins through.
    if (supplierId) {
      await linkProductToSupplier(context.env.DB, tenantId, id, supplierId, { source: 'admin' });
    }

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'product_created',
      'product',
      id,
      JSON.stringify({ name: body.name, slug, tenant_id: tenantId, supplier_id: supplierId }),
      getClientIp(context.request)
    );

    const product = await context.env.DB.prepare(
      'SELECT * FROM products WHERE id = ?'
    )
      .bind(id)
      .first();

    return new Response(JSON.stringify({ product }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Create product error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
