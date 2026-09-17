/**
 * GET /api/document-exports/links — "Documents you sent".
 *
 * WHY THIS EXISTS. 0115 made it one click to mail a dozen certificates to an
 * address, and then said nothing more about them. AJ Conner, reviewing
 * v2.7.0-v2.20.0: "the link is the credential, so a forwarded mail hands the
 * set to whoever holds the URL." A credential you cannot list and cannot
 * withdraw is not a credential anybody is managing; it is one that was issued.
 *
 * WHO SEES WHAT. An admin (super_admin / org_admin) sees everything the
 * organization sent; anybody else sees their own sends. This is the same shape
 * `/api/audit` uses -- the tenant-wide view of who sent what to whom is
 * oversight, and oversight is an admin function, while a person's own record of
 * what they mailed is theirs. A non-admin asking for scope=tenant is not an
 * error: the list narrows to their own and the response says which scope it
 * actually answered in, so a client can never render "the whole organization"
 * over a filtered list.
 *
 * THE TOKEN IS NEVER RETURNED. See `buildExportLinkSummary`.
 */
import { errorToResponse } from '../../../lib/permissions';
import {
  buildExportLinkSummary,
  loadExportLinkTitles,
  type ExportLinkListRow,
} from '../../../lib/document-export';
import type { DocumentExportLinkListResponse } from '../../../../shared/types';
import type { Env, User } from '../../../lib/types';

/** One page of sends. Generous: this is a review screen, not a feed. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function isExportAdmin(user: User): boolean {
  return user.role === 'super_admin' || user.role === 'org_admin';
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);

    const tenantId =
      user.role === 'super_admin'
        ? url.searchParams.get('tenant_id') || user.tenant_id
        : user.tenant_id;
    if (!tenantId) {
      return json({ error: 'No organization selected.' }, 400);
    }
    if (user.role !== 'super_admin' && tenantId !== user.tenant_id) {
      return json({ error: 'Forbidden' }, 403);
    }

    const canSeeTenant = isExportAdmin(user);
    const asked = url.searchParams.get('scope');
    // Admins default to the organization view (that is the point of the
    // screen for them); everybody else is pinned to their own regardless.
    const scope: 'tenant' | 'mine' =
      !canSeeTenant || asked === 'mine' ? 'mine' : 'tenant';

    const rawLimit = Number(url.searchParams.get('limit'));
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;

    const params: (string | number)[] = [tenantId];
    let where = 'l.tenant_id = ?';
    if (scope === 'mine') {
      where += ' AND l.created_by = ?';
      params.push(user.id);
    }

    const res = await context.env.DB.prepare(
      `SELECT l.*,
              u.name  AS sent_by_name,
              u.email AS sent_by_email,
              r.name  AS revoked_by_name
         FROM document_export_links l
         LEFT JOIN users u ON u.id = l.created_by
         LEFT JOIN users r ON r.id = l.revoked_by
        WHERE ${where}
        ORDER BY l.created_at DESC
        LIMIT ?`,
    )
      .bind(...params, limit)
      .all<ExportLinkListRow>();

    const rows = res.results ?? [];
    const titles = await loadExportLinkTitles(context.env.DB, tenantId, rows);
    const now = new Date();

    const body: DocumentExportLinkListResponse = {
      links: rows.map((row) =>
        buildExportLinkSummary(
          row,
          titles,
          canSeeTenant || row.created_by === user.id,
          now,
        ),
      ),
      scope,
      can_see_tenant: canSeeTenant,
    };
    return json(body);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List document export links error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
