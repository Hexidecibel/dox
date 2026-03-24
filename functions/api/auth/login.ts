import { verifyPassword, generateToken } from '../../lib/auth';
import { logAudit, getClientIp } from '../../lib/db';
import { checkRateLimit, recordAttempt, clearRateLimit } from '../../lib/ratelimit';
import { sanitizeString } from '../../lib/validation';
import type { Env, User } from '../../lib/types';

const MAX_LOGIN_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW = 900; // 15 minutes

/**
 * Hash a token using SHA-256 for session storage.
 */
async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const body = (await context.request.json()) as {
      email?: string;
      password?: string;
    };

    if (!body.email || !body.password) {
      return new Response(
        JSON.stringify({ error: 'Email and password are required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const email = sanitizeString(body.email).toLowerCase();
    const ip = getClientIp(context.request) || 'unknown';
    const rateLimitKey = `login:${ip}:${email}`;

    // Check rate limit before processing
    const rateCheck = await checkRateLimit(
      context.env.DB,
      rateLimitKey,
      MAX_LOGIN_ATTEMPTS,
      RATE_LIMIT_WINDOW
    );

    if (!rateCheck.allowed) {
      return new Response(
        JSON.stringify({ error: 'Too many login attempts. Try again later.' }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const user = await context.env.DB.prepare(
      'SELECT id, email, name, role, tenant_id, active, password_hash, force_password_change FROM users WHERE email = ?'
    )
      .bind(email)
      .first<User & { password_hash: string; force_password_change: number }>();

    if (!user) {
      await recordAttempt(context.env.DB, rateLimitKey, RATE_LIMIT_WINDOW);
      return new Response(
        JSON.stringify({ error: 'Invalid email or password' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (!user.active) {
      return new Response(
        JSON.stringify({ error: 'Account is inactive' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const valid = await verifyPassword(body.password, user.password_hash);
    if (!valid) {
      await recordAttempt(context.env.DB, rateLimitKey, RATE_LIMIT_WINDOW);
      return new Response(
        JSON.stringify({ error: 'Invalid email or password' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Successful login — clear rate limit
    await clearRateLimit(context.env.DB, rateLimitKey);

    // Update last login timestamp
    await context.env.DB.prepare(
      'UPDATE users SET last_login_at = datetime(\'now\') WHERE id = ?'
    )
      .bind(user.id)
      .run();

    const token = await generateToken(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        tenantId: user.tenant_id,
      },
      context.env.JWT_SECRET
    );

    // Create a session record for server-side revocation
    const tokenHash = await hashToken(token);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const sessionId = crypto.randomUUID().replace(/-/g, '');

    await context.env.DB.prepare(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at)
       VALUES (?, ?, ?, ?)`
    )
      .bind(sessionId, user.id, tokenHash, expiresAt)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      user.tenant_id,
      'login',
      'user',
      user.id,
      null,
      getClientIp(context.request)
    );

    return new Response(
      JSON.stringify({
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          tenant_id: user.tenant_id,
          force_password_change: user.force_password_change || 0,
        },
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch {
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
