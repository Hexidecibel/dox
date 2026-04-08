import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import type { Env, User } from '../../lib/types';

/**
 * GET /api/suppliers/:id
 * Get a single supplier by ID with document/product/template counts.
 * Parse aliases from JSON string to array in response.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const supplierId = context.params.id as string;

    const supplier = await context.env.DB.prepare(
      `SELECT s.*, 
        (SELECT COUNT(*) FROM documents d WHERE d.supplier_id = s.id) as document_count,
        (SELECT COUNT(*) FROM products p WHERE p.supplier_id = s.id) as product_count,
        (SELECT COUNT(*) FROM extraction_templates et WHERE et.supplier_id = s.id) as template_count
      FROM suppliers s WHERE s.id = ?`
    )
      .bind(supplierId)
      .first();

    if (!supplier) {
      throw new NotFoundError('Supplier not found');
    }

    // Check tenant access
    if (user.role !== 'super_admin' && supplier.tenant_id !== user.tenant_id) {
      throw new NotFoundError('Supplier not found');
    }

    // Parse aliases from JSON string to array
    let aliases: string[] = [];
    if (supplier.aliases) {
      try {
        const parsed = JSON.parse(supplier.aliases as string);
        aliases = Array.isArray(parsed) ? parsed : [];
      } catch {
        aliases = [];
      }
    }

    return new Response(
      JSON.stringify({ supplier: { ...supplier, aliases } }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Get supplier error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * PUT /api/suppliers/:id
 * Update a supplier. org_admin+ for their tenant, super_admin for any.
 * Fields: name, aliases (array, stringified for storage), active (boolean coerced to int).
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const supplierId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin');

    const supplier = await context.env.DB.prepare(
      'SELECT * FROM suppliers WHERE id = ?'
    )
      .bind(supplierId)
      .first();

    if (!supplier) {
      throw new NotFoundError('Supplier not found');
    }

    // Verify tenant access
    requireTenantAccess(user, supplier.tenant_id as string);

    const body = (await context.request.json()) as {
      name?: string;
      aliases?: string[];
      active?: number | boolean;
    };

    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (body.name !== undefined) {
      const name = sanitizeString(body.name);
      if (!name) {
        return new Response(
          JSON.stringify({ error: 'name cannot be empty' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      updates.push('name = ?');
      params.push(name);
    }

    if (body.aliases !== undefined) {
      updates.push('aliases = ?');
      params.push(Array.isArray(body.aliases) ? JSON.stringify(body.aliases) : null);
    }

    if (body.active !== undefined) {
      // Coerce boolean to integer
      let activeVal: number;
      if (typeof body.active === 'boolean') {
        activeVal = body.active ? 1 : 0;
      } else {
        activeVal = body.active;
      }
      if (activeVal !== 0 && activeVal !== 1) {
        return new Response(
          JSON.stringify({ error: 'active must be 0 or 1' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      updates.push('active = ?');
      params.push(activeVal);
    }

    if (updates.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No fields to update' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    updates.push("updated_at = datetime('now')");
    params.push(supplierId);

    await context.env.DB.prepare(
      `UPDATE suppliers SET ${updates.join(', ')} WHERE id = ?`
    )
      .bind(...params)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      supplier.tenant_id as string,
      'supplier.updated',
      'supplier',
      supplierId,
      JSON.stringify({ changes: body, tenant_id: supplier.tenant_id }),
      getClientIp(context.request)
    );

    const updated = await context.env.DB.prepare(
      'SELECT * FROM suppliers WHERE id = ?'
    )
      .bind(supplierId)
      .first();

    // Parse aliases for response
    let aliases: string[] = [];
    if (updated?.aliases) {
      try {
        const parsed = JSON.parse(updated.aliases as string);
        aliases = Array.isArray(parsed) ? parsed : [];
      } catch {
        aliases = [];
      }
    }

    return new Response(
      JSON.stringify({ supplier: { ...updated, aliases } }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Update supplier error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * DELETE /api/suppliers/:id
 * Soft-delete a supplier (set active=0). org_admin+ for their tenant, super_admin for any.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const supplierId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin');

    const supplier = await context.env.DB.prepare(
      'SELECT * FROM suppliers WHERE id = ?'
    )
      .bind(supplierId)
      .first();

    if (!supplier) {
      throw new NotFoundError('Supplier not found');
    }

    // Verify tenant access
    requireTenantAccess(user, supplier.tenant_id as string);

    await context.env.DB.prepare(
      "UPDATE suppliers SET active = 0, updated_at = datetime('now') WHERE id = ?"
    )
      .bind(supplierId)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      supplier.tenant_id as string,
      'supplier.deleted',
      'supplier',
      supplierId,
      JSON.stringify({ name: supplier.name, tenant_id: supplier.tenant_id }),
      getClientIp(context.request)
    );

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Delete supplier error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
