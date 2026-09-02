/**
 * /api/notes/:id — read one note, or retract it (migration 0088).
 *
 * NO PUT, DELIBERATELY. Every sibling resource in this API has one; notes do
 * not, and its absence is the feature. A note's text is fixed at the moment it
 * is posted. See migrations/0088_entity_notes.sql for the reasoning; the short
 * version is that a compliance note which can be silently rewritten is worth
 * less than no note at all, because a reader cannot tell what it said at the
 * time. A correction is another note — the thread is the amendment mechanism.
 *
 * DELETE is a SOFT delete (retraction), unlike /api/supplier-requirements/:id
 * where detach is hard. That route deletes pure configuration nothing points
 * at; this one is removing a person's statement from a record. Hard-deleting
 * would let the append-only guarantee be laundered — delete-and-repost is an
 * edit with extra steps and no trace — so the row stays, stamped with who
 * retracted it and when, and drops out of the default read.
 */

import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  ForbiddenError,
  NotFoundError,
  errorToResponse,
} from '../../lib/permissions';
import type { Env, User } from '../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const id = context.params.id as string;

    const row = await context.env.DB.prepare(
      `SELECT n.*,
              u.name  AS author_name,
              u.email AS author_email,
              d.name  AS deleted_by_name
         FROM entity_notes n
         LEFT JOIN users u ON u.id = n.author_id
         LEFT JOIN users d ON d.id = n.deleted_by
        WHERE n.id = ?`,
    )
      .bind(id)
      .first();
    if (!row) throw new NotFoundError('Note not found');

    requireTenantAccess(user, row.tenant_id as string);

    // A retracted note is gone as far as everyone but an admin is concerned.
    // Reported as 404 rather than 403 so the retraction does not itself leak
    // the fact that something was said.
    if (row.deleted_at && user.role !== 'super_admin' && user.role !== 'org_admin') {
      throw new NotFoundError('Note not found');
    }

    return json({ note: row });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Get note error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

/**
 * DELETE /api/notes/:id — retract.
 *
 * The author may retract their own note; org_admin and super_admin may retract
 * any note in their tenant. A `user` cannot retract a colleague's note: on a
 * shared compliance record, removing someone else's statement is an
 * administrative act.
 *
 * Retracting an already-retracted note is a no-op success, not a 404 — the
 * requested end state already holds, and a double-click should not read as an
 * error.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const id = context.params.id as string;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const row = await context.env.DB.prepare(
      'SELECT * FROM entity_notes WHERE id = ?',
    )
      .bind(id)
      .first<{
        id: string;
        tenant_id: string;
        entity_type: string;
        entity_id: string;
        author_id: string;
        deleted_at: string | null;
      }>();
    if (!row) throw new NotFoundError('Note not found');

    requireTenantAccess(user, row.tenant_id);

    const isAdmin = user.role === 'super_admin' || user.role === 'org_admin';
    if (!isAdmin && row.author_id !== user.id) {
      throw new ForbiddenError('Only the author or an admin can retract a note');
    }

    if (row.deleted_at) return json({ success: true });

    await context.env.DB.prepare(
      `UPDATE entity_notes
          SET deleted_at = datetime('now'), deleted_by = ?
        WHERE id = ? AND deleted_at IS NULL`,
    )
      .bind(user.id, id)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      row.tenant_id,
      'note_retracted',
      'entity_note',
      id,
      JSON.stringify({
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        author_id: row.author_id,
      }),
      getClientIp(context.request),
    );

    return json({ success: true });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Retract note error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
