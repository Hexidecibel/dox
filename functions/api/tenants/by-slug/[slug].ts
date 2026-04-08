import { requireRole, NotFoundError, errorToResponse } from '../../../lib/permissions';
import type { Env, User } from '../../../lib/types';

/**
 * GET /api/tenants/by-slug/:slug
 * Lookup a tenant by slug. Used by the email worker to resolve tenant from email address.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const slug = context.params.slug as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const tenant = await context.env.DB.prepare(
      'SELECT id, name, slug FROM tenants WHERE slug = ? AND active = 1'
    ).bind(slug).first<{ id: string; name: string; slug: string }>();

    if (!tenant) {
      throw new NotFoundError('Tenant not found');
    }

    return new Response(
      JSON.stringify({ tenant }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Tenant slug lookup error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
