import { requireRole, errorToResponse } from '../../lib/permissions';
import type { Env, User } from '../../lib/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const currentUser = context.data.user as User;
    requireRole(currentUser, 'super_admin', 'org_admin');

    const url = new URL(context.request.url);
    const tenantIdFilter = url.searchParams.get('tenantId');

    let query: string;
    const bindings: string[] = [];

    if (currentUser.role === 'super_admin') {
      if (tenantIdFilter) {
        query = 'SELECT id, email, name, role, tenant_id, active, last_login_at, created_at FROM users WHERE tenant_id = ? ORDER BY name ASC';
        bindings.push(tenantIdFilter);
      } else {
        query = 'SELECT id, email, name, role, tenant_id, active, last_login_at, created_at FROM users ORDER BY name ASC';
      }
    } else {
      // org_admin sees only their tenant's users
      if (!currentUser.tenant_id) {
        return new Response(JSON.stringify([]), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      query = 'SELECT id, email, name, role, tenant_id, active, last_login_at, created_at FROM users WHERE tenant_id = ? ORDER BY name ASC';
      bindings.push(currentUser.tenant_id);
    }

    const result = await context.env.DB.prepare(query)
      .bind(...bindings)
      .all();

    return new Response(JSON.stringify(result.results), {
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

// POST is handled by /api/auth/register — redirect callers there
export const onRequestPost: PagesFunction<Env> = async (context) => {
  // Forward to the register endpoint logic
  return new Response(
    JSON.stringify({ error: 'Use POST /api/auth/register to create users' }),
    { status: 308, headers: { 'Content-Type': 'application/json', 'Location': '/api/auth/register' } }
  );
};
