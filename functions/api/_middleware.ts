import { verifyToken, hashApiKey } from '../lib/auth';
import type { Env, User } from '../lib/types';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
};

const securityHeaders: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'",
};

/**
 * Public routes that do not require authentication.
 *
 * Note on /api/forms/public: scoped narrowly so we don't accidentally
 * expose any future /api/forms/* admin route. /api/records/* stays
 * gated — only the public-facing slug endpoints are open.
 */
const PUBLIC_ROUTES = [
  '/api/auth/login',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/graphql',
  '/api/webhooks/email-ingest',
  '/api/webhooks/connectors',
  '/api/forms/public',
  // Records update requests — recipient form gate is the unguessable
  // token in the URL, not a login. Same scoping rule as /api/forms/public:
  // narrow prefix so we don't leak any future admin route here.
  '/api/update-requests/public',
];

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some((route) => pathname === route || pathname.startsWith(route + '/'));
}

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

const cors: PagesFunction<Env> = async (context) => {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...corsHeaders, ...securityHeaders } });
  }

  const response = await context.next();
  const newResponse = new Response(response.body, response);

  for (const [key, value] of Object.entries(corsHeaders)) {
    newResponse.headers.set(key, value);
  }

  for (const [key, value] of Object.entries(securityHeaders)) {
    newResponse.headers.set(key, value);
  }

  return newResponse;
};

const auth: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);

  if (isPublicRoute(url.pathname)) {
    return context.next();
  }

  // Check Authorization header first, then fall back to ?token= query param
  const authHeader = context.request.headers.get('Authorization');
  const apiKeyHeader = context.request.headers.get('X-API-Key');
  let token: string | undefined;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else {
    token = url.searchParams.get('token') || undefined;
  }

  // --- API Key authentication ---
  if (!token && apiKeyHeader && apiKeyHeader.startsWith('dox_sk_')) {
    const keyHash = await hashApiKey(apiKeyHeader);
    const row = await context.env.DB.prepare(
      `SELECT ak.*, u.id as uid, u.email, u.name, u.role, u.tenant_id, u.active
       FROM api_keys ak
       JOIN users u ON ak.user_id = u.id
       WHERE ak.key_hash = ? AND ak.revoked = 0`
    )
      .bind(keyHash)
      .first<{
        id: string;
        expires_at: string | null;
        uid: string;
        email: string;
        name: string;
        role: string;
        tenant_id: string | null;
        active: number;
      }>();

    if (!row) {
      return new Response(JSON.stringify({ error: 'Invalid API key' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Check expiration
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return new Response(JSON.stringify({ error: 'API key expired' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!row.active) {
      return new Response(JSON.stringify({ error: 'Account not found or inactive' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Update last_used_at (fire and forget)
    context.env.DB.prepare(
      "UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?"
    )
      .bind(row.id)
      .run();

    context.data.user = {
      id: row.uid,
      email: row.email,
      name: row.name,
      role: row.role as User['role'],
      tenant_id: row.tenant_id,
      active: row.active,
    };

    return context.next();
  }

  // --- JWT authentication ---
  if (!token) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const payload = await verifyToken(token, context.env.JWT_SECRET);

  if (!payload) {
    return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Check if the session has been revoked server-side
  const tokenHash = await hashToken(token);
  const session = await context.env.DB.prepare(
    'SELECT revoked FROM sessions WHERE token_hash = ? AND user_id = ?'
  )
    .bind(tokenHash, payload.sub)
    .first<{ revoked: number }>();

  if (session && session.revoked) {
    return new Response(JSON.stringify({ error: 'Session expired' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Look up the full user record from D1
  const user = await context.env.DB.prepare(
    'SELECT id, email, name, role, tenant_id, active FROM users WHERE id = ?'
  )
    .bind(payload.sub)
    .first<User>();

  if (!user || !user.active) {
    return new Response(JSON.stringify({ error: 'Account not found or inactive' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Attach user to context data so handlers can access it
  context.data.user = user;

  return context.next();
};

export const onRequest: PagesFunction<Env>[] = [cors, auth];

// Durable Object classes are NOT hosted by this Pages project. They live
// in dedicated Workers (see `workers/sheet-session/`) and are bound here
// via `script_name` in `wrangler.toml`. Cloudflare Pages cannot host DO
// classes — every DO must be deployed as its own Worker first.
