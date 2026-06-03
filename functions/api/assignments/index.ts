import { generateId, logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import type { Env, User } from '../../lib/types';

/**
 * GET /api/assignments
 * List ownership assignments for the tenant. Joins users (owner name/email),
 * suppliers (name), and document_types (name) so the UI can render labels.
 * Optional filters: ?supplier_id= &document_type_id=.
 * super_admin may pass ?tenant_id=; everyone else is scoped to their tenant.
 * Role: super_admin, org_admin.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const url = new URL(context.request.url);
    let tenantId = url.searchParams.get('tenant_id');
    const supplierId = url.searchParams.get('supplier_id');
    const documentTypeId = url.searchParams.get('document_type_id');

    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }
    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }
    requireTenantAccess(user, tenantId);

    const conditions: string[] = ['a.tenant_id = ?'];
    const params: (string | number)[] = [tenantId];

    if (supplierId) {
      conditions.push('a.supplier_id = ?');
      params.push(supplierId);
    }
    if (documentTypeId) {
      conditions.push('a.document_type_id = ?');
      params.push(documentTypeId);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const results = await context.env.DB.prepare(
      `SELECT a.id, a.tenant_id, a.supplier_id, a.document_type_id,
              a.owner_user_id, a.owner_group_id,
              a.created_by, a.created_at, a.updated_at,
              s.name AS supplier_name,
              dt.name AS document_type_name,
              u.name AS owner_user_name, u.email AS owner_user_email
       FROM assignments a
       LEFT JOIN suppliers s ON a.supplier_id = s.id
       LEFT JOIN document_types dt ON a.document_type_id = dt.id
       LEFT JOIN users u ON a.owner_user_id = u.id
       ${whereClause}
       ORDER BY s.name ASC, dt.name ASC`
    )
      .bind(...params)
      .all();

    return new Response(
      JSON.stringify({ assignments: results.results ?? [] }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('List assignments error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * PUT /api/assignments
 * Upsert the owner for a (supplier_id, document_type_id) combo.
 * Body: { supplier_id, document_type_id, owner_user_id?, owner_group_id?, tenant_id? }
 * Both owners null = unassigned (allowed). Validates supplier + document_type
 * belong to the tenant, and owner_user_id (if given) is a user in the tenant.
 * Role: super_admin, org_admin.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const body = (await context.request.json()) as {
      supplier_id?: string;
      document_type_id?: string;
      owner_user_id?: string | null;
      owner_group_id?: string | null;
      tenant_id?: string;
    };

    if (!body.supplier_id || !body.document_type_id) {
      throw new BadRequestError('supplier_id and document_type_id are required');
    }

    let tenantId = body.tenant_id ?? null;
    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }
    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }
    requireTenantAccess(user, tenantId);

    // Validate supplier belongs to the tenant.
    const supplier = await context.env.DB.prepare(
      'SELECT id FROM suppliers WHERE id = ? AND tenant_id = ?'
    )
      .bind(body.supplier_id, tenantId)
      .first();
    if (!supplier) {
      throw new BadRequestError('supplier_id does not reference a supplier in this tenant');
    }

    // Validate document_type belongs to the tenant.
    const docType = await context.env.DB.prepare(
      'SELECT id FROM document_types WHERE id = ? AND tenant_id = ?'
    )
      .bind(body.document_type_id, tenantId)
      .first();
    if (!docType) {
      throw new BadRequestError('document_type_id does not reference a document type in this tenant');
    }

    const ownerUserId = body.owner_user_id ? body.owner_user_id : null;
    const ownerGroupId = body.owner_group_id ? body.owner_group_id : null;

    // Validate owner_user_id (if given) is a user in the tenant.
    if (ownerUserId) {
      const owner = await context.env.DB.prepare(
        'SELECT id FROM users WHERE id = ? AND tenant_id = ?'
      )
        .bind(ownerUserId, tenantId)
        .first();
      if (!owner) {
        throw new BadRequestError('owner_user_id does not reference a user in this tenant');
      }
    }

    const id = generateId();

    await context.env.DB.prepare(
      `INSERT INTO assignments
         (id, tenant_id, supplier_id, document_type_id, owner_user_id, owner_group_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, supplier_id, document_type_id) DO UPDATE SET
         owner_user_id = excluded.owner_user_id,
         owner_group_id = excluded.owner_group_id,
         updated_at = datetime('now')`
    )
      .bind(id, tenantId, body.supplier_id, body.document_type_id, ownerUserId, ownerGroupId, user.id)
      .run();

    const row = await context.env.DB.prepare(
      `SELECT a.id, a.tenant_id, a.supplier_id, a.document_type_id,
              a.owner_user_id, a.owner_group_id,
              a.created_by, a.created_at, a.updated_at,
              s.name AS supplier_name,
              dt.name AS document_type_name,
              u.name AS owner_user_name, u.email AS owner_user_email
       FROM assignments a
       LEFT JOIN suppliers s ON a.supplier_id = s.id
       LEFT JOIN document_types dt ON a.document_type_id = dt.id
       LEFT JOIN users u ON a.owner_user_id = u.id
       WHERE a.tenant_id = ? AND a.supplier_id = ? AND a.document_type_id = ?`
    )
      .bind(tenantId, body.supplier_id, body.document_type_id)
      .first();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'assignment_set',
      'assignment',
      (row?.id as string) ?? id,
      JSON.stringify({
        supplier_id: body.supplier_id,
        document_type_id: body.document_type_id,
        owner_user_id: ownerUserId,
        owner_group_id: ownerGroupId,
      }),
      getClientIp(context.request)
    );

    return new Response(
      JSON.stringify({ assignment: row }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Upsert assignment error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
