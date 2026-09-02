import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  NotFoundError,
  errorToResponse,
} from '../../lib/permissions';
import type { Env, User } from '../../lib/types';

/**
 * DELETE /api/owner-routes/:id
 *
 * Removes one recipient from an owner label.
 *
 * A hard delete rather than a soft one: `owner_routes.active` exists for
 * temporarily muting a route, but "this person left" should not leave a row
 * behind that a future reader has to decide about. The audit row is the
 * history.
 *
 * NOTE what this does NOT do: it does not touch `documents.owner`. Deleting
 * the last route for a label leaves every document carrying that label
 * UNROUTED, which the renewal run then reports as a routing gap rather than
 * silently mailing the admin pool. That is the intended consequence, and it is
 * why the gap notice exists.
 *
 * Role: super_admin, org_admin.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const id = context.params.id as string;
    if (!id) throw new BadRequestError('id is required');

    const row = await context.env.DB.prepare(
      'SELECT id, tenant_id, owner_key, user_id, email FROM owner_routes WHERE id = ?',
    )
      .bind(id)
      .first<{
        id: string;
        tenant_id: string;
        owner_key: string;
        user_id: string | null;
        email: string | null;
      }>();
    if (!row) throw new NotFoundError('Owner route not found');
    requireTenantAccess(user, row.tenant_id);

    await context.env.DB.prepare('DELETE FROM owner_routes WHERE id = ?').bind(id).run();

    await logAudit(
      context.env.DB,
      user.id,
      row.tenant_id,
      'owner_route.delete',
      'owner_route',
      id,
      JSON.stringify({ owner_key: row.owner_key, user_id: row.user_id, email: row.email }),
      getClientIp(context.request),
    );

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('owner-routes delete error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
