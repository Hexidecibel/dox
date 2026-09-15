/**
 * GET /api/supplier-list/imports — applied supplier-list import runs, newest
 * first (migration 0111). Summary only; the row outcomes are on /:id.
 */

import { requireRole, errorToResponse } from '../../../lib/permissions';
import type { Env, User } from '../../../lib/types';
import type { SupplierListImportRun } from '../../../../shared/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const url = new URL(context.request.url);
    const tenantId =
      user.role === 'super_admin' ? url.searchParams.get('tenant_id') || user.tenant_id : user.tenant_id;
    if (!tenantId) return json({ error: 'tenant_id is required' }, 400);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 1), 100);

    const res = await context.env.DB.prepare(
      `SELECT i.id, i.tenant_id, i.file_name, i.input_format, i.pack, i.counts, i.created_by, i.created_at,
              u.name AS created_by_name
         FROM supplier_list_imports i
         LEFT JOIN users u ON u.id = i.created_by
        WHERE i.tenant_id = ?
        ORDER BY i.created_at DESC, i.rowid DESC
        LIMIT ?`,
    )
      .bind(tenantId, limit)
      .all<Omit<SupplierListImportRun, 'counts'> & { counts: string }>();

    const imports: SupplierListImportRun[] = (res.results ?? []).map((r) => ({
      ...r,
      counts: JSON.parse(r.counts),
    }));
    return json({ imports });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('list supplier list imports error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
