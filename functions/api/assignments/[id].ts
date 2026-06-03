import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../lib/permissions';
import type { Env, User } from '../../lib/types';

/**
 * DELETE /api/assignments/:id
 * Remove an ownership assignment (clears the combo's owner entirely).
 * Role: super_admin, org_admin (tenant-scoped).
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const id = context.params.id as string;

    const assignment = await context.env.DB.prepare(
      'SELECT * FROM assignments WHERE id = ?'
    )
      .bind(id)
      .first();

    if (!assignment) {
      throw new NotFoundError('Assignment not found');
    }

    requireTenantAccess(user, assignment.tenant_id as string);

    await context.env.DB.prepare('DELETE FROM assignments WHERE id = ?')
      .bind(id)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      assignment.tenant_id as string,
      'assignment_deleted',
      'assignment',
      id,
      JSON.stringify({
        supplier_id: assignment.supplier_id,
        document_type_id: assignment.document_type_id,
      }),
      getClientIp(context.request)
    );

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Delete assignment error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
