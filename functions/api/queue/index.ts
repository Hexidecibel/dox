import {
  requireRole,
  requireTenantAccess,
  errorToResponse,
} from '../../lib/permissions';
import type { Env, User } from '../../lib/types';

/**
 * GET /api/queue
 * List processing queue items with optional filters.
 * Non-super_admins are scoped to their own tenant.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const url = new URL(context.request.url);

    const status = url.searchParams.get('status') || 'pending'; // pass 'all' to skip status filter
    const processingStatus = url.searchParams.get('processing_status');
    const documentTypeId = url.searchParams.get('document_type_id');
    let tenantId = url.searchParams.get('tenant_id');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    // Non-super_admins are forced to their own tenant
    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (status && status !== 'all') {
      conditions.push('pq.status = ?');
      params.push(status);
    }

    if (tenantId) {
      conditions.push('pq.tenant_id = ?');
      params.push(tenantId);
    }

    if (processingStatus) {
      conditions.push('pq.processing_status = ?');
      params.push(processingStatus);
    }

    if (documentTypeId) {
      conditions.push('pq.document_type_id = ?');
      params.push(documentTypeId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countResult = await context.env.DB.prepare(
      `SELECT COUNT(*) as total FROM processing_queue pq ${whereClause}`
    )
      .bind(...params)
      .first<{ total: number }>();

    // Get queue items with related info. The supplier_extraction_instructions
    // join (on the item's verified supplier_id + document_type_id, with
    // non-empty instructions) drives profile_exists in a single query — no
    // per-row lookup. sei.id is NULL when no profile row matched (including
    // when pq.supplier_id is NULL, since the ON condition can't match).
    const results = await context.env.DB.prepare(
      `SELECT pq.*, dt.name as document_type_name, dt.slug as document_type_slug,
              t.name as tenant_name, t.slug as tenant_slug,
              u.name as created_by_name, r.name as reviewed_by_name,
              CASE WHEN sei.id IS NOT NULL THEN 1 ELSE 0 END as profile_exists
       FROM processing_queue pq
       LEFT JOIN document_types dt ON pq.document_type_id = dt.id
       LEFT JOIN tenants t ON pq.tenant_id = t.id
       LEFT JOIN users u ON pq.created_by = u.id
       LEFT JOIN users r ON pq.reviewed_by = r.id
       LEFT JOIN supplier_extraction_instructions sei
         ON sei.supplier_id = pq.supplier_id
        AND sei.document_type_id = pq.document_type_id
        AND TRIM(COALESCE(sei.instructions, '')) <> ''
       ${whereClause}
       ORDER BY pq.created_at DESC
       LIMIT ? OFFSET ?`
    )
      .bind(...params, limit, offset)
      .all();

    const items = (results.results ?? []).map((row) => {
      const { profile_exists, ...rest } = row as Record<string, unknown>;
      return { ...rest, profile_exists: profile_exists === 1 };
    });

    return new Response(
      JSON.stringify({
        items,
        total: countResult?.total || 0,
        limit,
        offset,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('List queue error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
