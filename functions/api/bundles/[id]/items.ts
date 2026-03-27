import { generateId, logAudit, getClientIp } from '../../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../../lib/permissions';
import type { Env, User } from '../../../lib/types';

/**
 * GET /api/bundles/:id/items
 * List items in a bundle.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const bundleId = context.params.id as string;

    const bundle = await context.env.DB.prepare(
      'SELECT * FROM document_bundles WHERE id = ?'
    )
      .bind(bundleId)
      .first();

    if (!bundle) {
      throw new NotFoundError('Bundle not found');
    }

    requireTenantAccess(user, bundle.tenant_id as string);

    const items = await context.env.DB.prepare(
      `SELECT bi.*, d.title as document_title, dt.name as document_type_name,
              dv.file_name, dv.file_size, dv.mime_type
       FROM document_bundle_items bi
       INNER JOIN documents d ON bi.document_id = d.id
       LEFT JOIN document_types dt ON d.document_type_id = dt.id
       LEFT JOIN document_versions dv ON dv.document_id = d.id
         AND dv.version_number = COALESCE(bi.version_number, d.current_version)
       WHERE bi.bundle_id = ?
       ORDER BY bi.sort_order ASC, bi.created_at ASC`
    )
      .bind(bundleId)
      .all();

    return new Response(
      JSON.stringify({ items: items.results }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('List bundle items error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * POST /api/bundles/:id/items
 * Add a document to a bundle.
 * Body: { document_id, version_number?, sort_order? }
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const bundleId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const bundle = await context.env.DB.prepare(
      'SELECT * FROM document_bundles WHERE id = ?'
    )
      .bind(bundleId)
      .first();

    if (!bundle) {
      throw new NotFoundError('Bundle not found');
    }

    requireTenantAccess(user, bundle.tenant_id as string);

    // Only allow adding items to draft bundles (unless super_admin)
    if (bundle.status !== 'draft' && user.role !== 'super_admin') {
      return new Response(
        JSON.stringify({ error: 'Cannot modify a finalized bundle' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const body = (await context.request.json()) as {
      document_id?: string;
      version_number?: number;
      sort_order?: number;
    };

    if (!body.document_id) {
      return new Response(
        JSON.stringify({ error: 'document_id is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Validate document exists and belongs to same tenant
    const doc = await context.env.DB.prepare(
      "SELECT * FROM documents WHERE id = ? AND status != 'deleted'"
    )
      .bind(body.document_id)
      .first();

    if (!doc) {
      return new Response(
        JSON.stringify({ error: 'Document not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (doc.tenant_id !== bundle.tenant_id) {
      return new Response(
        JSON.stringify({ error: 'Document must belong to the same tenant as the bundle' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const id = generateId();

    try {
      await context.env.DB.prepare(
        `INSERT INTO document_bundle_items (id, bundle_id, document_id, version_number, sort_order)
         VALUES (?, ?, ?, ?, ?)`
      )
        .bind(
          id,
          bundleId,
          body.document_id,
          body.version_number ?? null,
          body.sort_order ?? 0
        )
        .run();
    } catch (dbErr: any) {
      if (dbErr.message?.includes('UNIQUE constraint')) {
        return new Response(
          JSON.stringify({ error: 'Document is already in this bundle' }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw dbErr;
    }

    // Update bundle's updated_at
    await context.env.DB.prepare(
      "UPDATE document_bundles SET updated_at = datetime('now') WHERE id = ?"
    )
      .bind(bundleId)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      bundle.tenant_id as string,
      'bundle_item_added',
      'bundle',
      bundleId,
      JSON.stringify({ item_id: id, document_id: body.document_id }),
      getClientIp(context.request)
    );

    // Return the created item with details
    const item = await context.env.DB.prepare(
      `SELECT bi.*, d.title as document_title, dt.name as document_type_name,
              dv.file_name, dv.file_size, dv.mime_type
       FROM document_bundle_items bi
       INNER JOIN documents d ON bi.document_id = d.id
       LEFT JOIN document_types dt ON d.document_type_id = dt.id
       LEFT JOIN document_versions dv ON dv.document_id = d.id
         AND dv.version_number = COALESCE(bi.version_number, d.current_version)
       WHERE bi.id = ?`
    )
      .bind(id)
      .first();

    return new Response(
      JSON.stringify({ item }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Add bundle item error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
