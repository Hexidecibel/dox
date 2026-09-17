/**
 * POST /api/document-exports/links/:id/revoke — pull a sent link back.
 *
 * IMMEDIATE AND TOTAL. There is one gate, `loadUsableExportLink`, and all three
 * recipient routes (the landing read, the zip, and the per-file download) go
 * through it; it returns null for a revoked row, and every one of them answers
 * the same 404 it answers for a token that never existed. So the next request
 * after this one lands -- landing page, zip or single file -- fails. Nothing is
 * cached: each of those routes sets Cache-Control: no-store.
 *
 * WHAT IT DOES NOT DO. It cannot un-download a file somebody already took, and
 * the UI says so rather than implying otherwise. What it stops is every further
 * use of the URL, which is the whole of what a link-based hand-off can offer.
 *
 * THERE IS NO "EXTEND". It was considered and refused: lengthening a link after
 * the fact quietly changes the terms of a mail already sent ("this link expires
 * on the 15th") and hides that decision inside a row nobody re-reads. A new
 * send is the honest answer -- it names its own recipients, writes its own
 * audit row, and the old link still dies on the day the old email promised.
 *
 * WHO MAY. The sender, and any admin of the tenant. A person must be able to
 * withdraw their own mistake without finding an admin, and an admin must be
 * able to withdraw somebody else's without waiting for them to come back from
 * leave.
 */
import { logAudit, getClientIp } from '../../../../lib/db';
import { errorToResponse, NotFoundError } from '../../../../lib/permissions';
import {
  buildExportLinkSummary,
  loadExportLinkTitles,
  parseStringList,
  revokeExportLink,
  type ExportLinkListRow,
} from '../../../../lib/document-export';
import type { DocumentExportRevokeResponse } from '../../../../../shared/types';
import type { Env, User } from '../../../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const id = context.params.id as string;
    const isAdmin = user.role === 'super_admin' || user.role === 'org_admin';

    const row = await context.env.DB.prepare(
      `SELECT l.*,
              u.name  AS sent_by_name,
              u.email AS sent_by_email,
              r.name  AS revoked_by_name
         FROM document_export_links l
         LEFT JOIN users u ON u.id = l.created_by
         LEFT JOIN users r ON r.id = l.revoked_by
        WHERE l.id = ?`,
    )
      .bind(id)
      .first<ExportLinkListRow>();
    // A link from another tenant is NOT FOUND, never forbidden: a different
    // answer for "exists elsewhere" would make this endpoint a probe.
    if (!row) throw new NotFoundError('That sent link no longer exists');
    if (user.role !== 'super_admin' && row.tenant_id !== user.tenant_id) {
      throw new NotFoundError('That sent link no longer exists');
    }
    if (!isAdmin && row.created_by !== user.id) {
      return json(
        {
          error:
            'Only the person who sent this link, or an administrator, can revoke it.',
        },
        403,
      );
    }

    const changed = await revokeExportLink(context.env.DB, row.id, user.id);
    if (changed) {
      await logAudit(
        context.env.DB,
        user.id,
        row.tenant_id,
        'document_export.revoked',
        'document_export_link',
        row.id,
        JSON.stringify({
          recipients: parseStringList(row.recipients),
          document_ids: parseStringList(row.document_ids),
          document_count: parseStringList(row.document_ids).length,
          sent_by: row.created_by,
          sent_at: row.created_at,
          // The counts AT THE MOMENT it was pulled: "was it opened before we
          // caught it" is the first question anybody asks afterwards.
          view_count: Number(row.view_count) || 0,
          download_count: Number(row.download_count) || 0,
          expires_at: row.expires_at,
        }),
        getClientIp(context.request),
      );
    }

    const fresh = await context.env.DB.prepare(
      `SELECT l.*,
              u.name  AS sent_by_name,
              u.email AS sent_by_email,
              r.name  AS revoked_by_name
         FROM document_export_links l
         LEFT JOIN users u ON u.id = l.created_by
         LEFT JOIN users r ON r.id = l.revoked_by
        WHERE l.id = ?`,
    )
      .bind(row.id)
      .first<ExportLinkListRow>();
    const current = fresh ?? row;
    const titles = await loadExportLinkTitles(context.env.DB, current.tenant_id, [current]);

    const body: DocumentExportRevokeResponse = {
      link: buildExportLinkSummary(current, titles, true),
    };
    return json(body);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Revoke document export link error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
