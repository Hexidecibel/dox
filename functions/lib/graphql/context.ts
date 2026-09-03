import { verifyToken } from '../auth';
import { loadModuleAccess } from '../module-access';
import type { ModuleKey } from '../../../shared/modules';
import type { Env, User } from '../types';

export interface GraphQLContext {
  db: D1Database;
  files: R2Bucket;
  user: User | null;
  request: Request;
  env: Env;
  /**
   * The modules this caller may see — the SAME answer the REST middleware
   * gate computes, carried here because `/api/graphql` never reaches that
   * gate.
   *
   * ⚠ CARRIED, NOT YET ENFORCED. No resolver reads this today, so GraphQL
   * remains as open as it was before modules existed; per-resolver
   * enforcement is a follow-up. It is computed now so that follow-up is a
   * one-line check inside a resolver rather than a second, divergent
   * implementation of the resolution rules — which is how the two paths would
   * end up disagreeing about who can see what.
   *
   * Empty for an anonymous caller: nobody is signed in, so no module is
   * theirs. Every resolver already refuses a null user, so this changes
   * nothing today and states the honest answer for whatever reads it later.
   */
  visibleModules: ModuleKey[];
}

/**
 * Build the GraphQL context from a Cloudflare Pages request.
 * Extracts the JWT from the Authorization header, verifies it,
 * and looks up the full user record from D1.
 */
export async function buildContext(
  request: Request,
  env: Env
): Promise<GraphQLContext> {
  let user: User | null = null;

  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const payload = await verifyToken(token, env.JWT_SECRET);

    if (payload) {
      const dbUser = await env.DB.prepare(
        'SELECT id, email, name, role, tenant_id, active FROM users WHERE id = ?'
      )
        .bind(payload.sub)
        .first<User>();

      if (dbUser && dbUser.active) {
        user = dbUser;
      }
    }
  }

  // Falls open on a database error, like every other module read: scope, not
  // security. `loadModuleAccess` swallows its own failures and returns
  // everything, so a D1 blip cannot take the GraphQL endpoint down.
  const visibleModules = user ? (await loadModuleAccess(env.DB, user)).visible : [];

  return {
    db: env.DB,
    files: env.FILES,
    user,
    request,
    env,
    visibleModules,
  };
}
