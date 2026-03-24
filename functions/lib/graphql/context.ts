import { verifyToken } from '../auth';
import type { Env, User } from '../types';

export interface GraphQLContext {
  db: D1Database;
  files: R2Bucket;
  user: User | null;
  request: Request;
  env: Env;
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

  return {
    db: env.DB,
    files: env.FILES,
    user,
    request,
    env,
  };
}
