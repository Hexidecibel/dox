import type { Env, User } from '../../lib/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const currentUser = context.data.user as User;

    const user = await context.env.DB.prepare(
      'SELECT id, email, name, role, tenant_id, active, last_login_at, created_at FROM users WHERE id = ?'
    )
      .bind(currentUser.id)
      .first();

    if (!user) {
      return new Response(
        JSON.stringify({ error: 'User not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Also fetch tenant name if user belongs to one
    let tenantName: string | null = null;
    if (currentUser.tenant_id) {
      const tenant = await context.env.DB.prepare(
        'SELECT name FROM tenants WHERE id = ?'
      )
        .bind(currentUser.tenant_id)
        .first<{ name: string }>();
      if (tenant) tenantName = tenant.name;
    }

    return new Response(
      JSON.stringify({ ...user, tenant_name: tenantName }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch {
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
