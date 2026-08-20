import {
  requireRole,
  requireTenantAccess,
  errorToResponse,
} from '../../lib/permissions';
import type { Env, User } from '../../lib/types';
import { withInvariantWarnings } from '../../lib/queue-warnings';
import { specConfigLoader, withSpecConfig } from '../../lib/spec-warnings';

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
    const mine = url.searchParams.get('mine') === '1' || url.searchParams.get('owned_by_me') === '1';
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

    // "Mine" filter: restrict to items whose (supplier_id, document_type_id)
    // has an assignments row owned by the current user (same tenant). INNER
    // JOIN so unowned items — and items with NULL supplier_id, which can't
    // match the ON condition — are excluded. Powers both the Review "Mine"
    // view and the notifications bell feed. Composes with the other filters.
    const mineJoin = mine
      ? `INNER JOIN assignments am
           ON am.tenant_id = pq.tenant_id
          AND am.supplier_id = pq.supplier_id
          AND am.document_type_id = pq.document_type_id
          AND am.owner_user_id = ?`
      : '';
    const mineParam: string[] = mine ? [user.id] : [];

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countResult = await context.env.DB.prepare(
      `SELECT COUNT(*) as total FROM processing_queue pq ${mineJoin} ${whereClause}`
    )
      .bind(...mineParam, ...params)
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
       ${mineJoin}
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
      .bind(...mineParam, ...params, limit, offset)
      .all();

    // Two independent advisory passes, both computed from the item's own data:
    //   invariant_warnings — the extraction looks wrong (functions/lib/queue-warnings.ts)
    //   spec_results       — the RESULT looks wrong (functions/lib/spec-warnings.ts)
    // Neither blocks an approval; they are kept separate because an extraction
    // defect is a data chore and an out-of-spec micro result is a safety event.
    // One spec-config read per tenant per request, not per row.
    const loadSpecConfigFor = specConfigLoader(context.env.DB);
    const items = await Promise.all(
      (results.results ?? []).map(async (row) => {
        const { profile_exists, ...rest } = row as Record<string, unknown>;
        const config = await loadSpecConfigFor(String(rest.tenant_id ?? ''));
        return withSpecConfig(
          withInvariantWarnings({ ...rest, profile_exists: profile_exists === 1 }),
          config,
          {
            supplier_id: rest.supplier_id == null ? null : String(rest.supplier_id),
            document_type_id: rest.document_type_id == null ? null : String(rest.document_type_id),
            // Product-scoped limits resolve at approve time, once the document's
            // products are actually linked. Nothing is silently skipped here:
            // the admin UI does not offer product scoping yet.
            product_ids: [],
          }
        );
      })
    );

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
