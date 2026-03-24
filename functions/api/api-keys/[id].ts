import { logAudit, getClientIp } from '../../lib/db';
import { requireRole, errorToResponse, ForbiddenError } from '../../lib/permissions';
import type { Env, User } from '../../lib/types';

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const currentUser = context.data.user as User;
    requireRole(currentUser, 'super_admin', 'org_admin');

    const keyId = context.params.id as string;

    const apiKey = await context.env.DB.prepare(
      'SELECT * FROM api_keys WHERE id = ?'
    )
      .bind(keyId)
      .first<{ id: string; name: string; tenant_id: string | null; revoked: number }>();

    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'API key not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // org_admin can only revoke keys in their tenant
    if (currentUser.role === 'org_admin') {
      if (apiKey.tenant_id !== currentUser.tenant_id) {
        throw new ForbiddenError('You can only revoke keys in your tenant');
      }
    }

    if (apiKey.revoked) {
      return new Response(
        JSON.stringify({ error: 'API key is already revoked' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    await context.env.DB.prepare(
      'UPDATE api_keys SET revoked = 1 WHERE id = ?'
    )
      .bind(keyId)
      .run();

    await logAudit(
      context.env.DB,
      currentUser.id,
      apiKey.tenant_id,
      'api_key.revoked',
      'api_key',
      keyId,
      JSON.stringify({ name: apiKey.name }),
      getClientIp(context.request)
    );

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
