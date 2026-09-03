import { verifyToken } from '../auth';
import { loadModuleAccess } from '../module-access';
import type { ModuleAccess } from '../module-access';
import type { Env, User } from '../types';

export interface GraphQLContext {
  db: D1Database;
  files: R2Bucket;
  user: User | null;
  request: Request;
  env: Env;
  /**
   * What this caller may see — the SAME answer the REST middleware gate
   * computes, carried here because `/api/graphql` sits in `PUBLIC_ROUTES` and
   * authenticates itself, so it never reaches that gate.
   *
   * ENFORCED, by `gateResolvers` in `./module-gate.ts`. The whole
   * `ModuleAccess` is carried and not just its `visible` list because a
   * refusal has to say WHICH of the two layers refused: "your company turned
   * Order Fulfillment off" and "your role does not include it" are fixed on
   * different screens by different people, and `tenantEnabled` is the only
   * thing that tells them apart.
   *
   * NULL FOR AN ANONYMOUS CALLER, deliberately, rather than an empty set.
   * There is no answer to "which modules are yours" for nobody, and an empty
   * list would be indistinguishable from a real user narrowed to nothing —
   * which would make every field report `module_disabled` at the door instead
   * of the honest "Authentication required". The gate skips a null user for
   * exactly the reason the middleware does (see NO USER MEANS NO GATE in
   * `functions/api/_middleware.ts`) and lets the resolver's own `requireAuth`
   * answer.
   */
  moduleAccess: ModuleAccess | null;
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
  //
  // Resolved ONCE per request, here, rather than lazily inside the gate: a
  // single GraphQL document can touch many fields, and a per-field lookup
  // would turn one query into N. This is the equivalent of the middleware's
  // per-request memo on `context.data`.
  const moduleAccess = user ? await loadModuleAccess(env.DB, user) : null;

  return {
    db: env.DB,
    files: env.FILES,
    user,
    request,
    env,
    moduleAccess,
  };
}
