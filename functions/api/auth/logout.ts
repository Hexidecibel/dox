import { logAudit, getClientIp } from '../../lib/db';
import type { Env, User } from '../../lib/types';

/**
 * Hash a token using SHA-256 for session lookup.
 */
async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * POST /api/auth/logout
 * Revoke the current session server-side.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;

    const authHeader = context.request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'No token provided' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const token = authHeader.slice(7);
    const tokenHash = await hashToken(token);

    // Revoke the session
    await context.env.DB.prepare(
      'UPDATE sessions SET revoked = 1 WHERE token_hash = ? AND user_id = ?'
    )
      .bind(tokenHash, user.id)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      user.tenant_id,
      'logout',
      'user',
      user.id,
      null,
      getClientIp(context.request)
    );

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch {
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
