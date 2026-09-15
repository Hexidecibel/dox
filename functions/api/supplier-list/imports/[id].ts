/** GET /api/supplier-list/imports/:id — one applied run with its row outcomes (migration 0112). */

import { requireRole, requireTenantAccess, NotFoundError, errorToResponse } from '../../../lib/permissions';
import type { Env, User } from '../../../lib/types';
import type { SupplierListImportRunDetail } from '../../../../shared/types';

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
    const row = await context.env.DB.prepare(
      `SELECT i.id, i.tenant_id, i.file_name, i.input_format, i.pack, i.counts, i.row_outcomes,
              i.created_by, i.created_at, u.name AS created_by_name
         FROM supplier_list_imports i
         LEFT JOIN users u ON u.id = i.created_by
        WHERE i.id = ?`,
    )
      .bind(context.params.id as string)
      .first<Record<string, unknown>>();
    if (!row) throw new NotFoundError('Import run not found');
    requireTenantAccess(user, row.tenant_id as string);
    const detail = {
      ...row,
      counts: JSON.parse(row.counts as string),
      row_outcomes: JSON.parse(row.row_outcomes as string),
    } as SupplierListImportRunDetail;
    return json({ import: detail });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('get supplier list import error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
