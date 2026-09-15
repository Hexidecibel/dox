import { verifyToken } from '../lib/auth';
import { authenticateApiKey } from '../lib/api-key-auth';
import { checkModuleAccess } from '../lib/module-access';
import type { Env, User } from '../lib/types';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  // PATCH was missing here while two endpoints already used it — the records
  // cell editor and the setup wizard's autosave. It has never bitten because
  // the portal is same-origin and browsers only preflight cross-origin, but a
  // preflight that omits a verb the API answers is a trap for the first
  // integrator who hits it from elsewhere.
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
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
  // Scheduled R2 prefix poller endpoint. Authed by a bearer token
  // (CONNECTOR_POLL_TOKEN) checked inside the handler — bypasses JWT so
  // the companion `dox-connector-poller` Worker can drive it on cron.
  '/api/sources/poll',
  // Scheduled renewal-alert endpoint. Same posture as /api/sources/poll and
  // for the same structural reason: Pages cannot host a cron, so the schedule
  // lives in the companion `dox-renewal-alerts` Worker and reaches the Pages
  // project over HTTP. Authed by RENEWAL_ALERT_TOKEN inside the handler, which
  // fails closed when unset. Exact-path entry, NOT a prefix: `/api/expirations`
  // itself stays behind the JWT gate.
  '/api/expirations/run-scheduled',
  '/api/forms/public',
  // Records update requests — recipient form gate is the unguessable
  // token in the URL, not a login. Same scoping rule as /api/forms/public:
  // narrow prefix so we don't leak any future admin route here.
  '/api/update-requests/public',
  // Workflow approval magic links — same posture as update-request
  // public: token in URL is the gate, narrow prefix protects future
  // admin endpoints under /api/workflow-approvals/.
  '/api/workflow-approvals/public',
  // Alert landing pages — the "alerted owner" mode. A recipient who is not a
  // portal user gets an email plus one link; /alert/<token> reads through
  // here. Same posture as the two above: the unguessable per-alert token is
  // the gate, the route is read-only, and the prefix is narrow so no future
  // /api/alerts/* admin endpoint is allowlisted by accident.
  '/api/alerts/public',
  // Document export links — /export/<token>, the page an "here are the
  // documents you asked for" email points at (migration 0114). Same posture as
  // the alert landing above, and the same narrow prefix so no future
  // /api/document-exports/* admin endpoint is allowlisted by accident: the two
  // authed endpoints beneath /api/document-exports (zip, send) sit OUTSIDE this
  // prefix and stay behind the JWT gate and the `library` module gate.
  '/api/document-exports/public',
  // The external supplier request page — /r/<token> reads and uploads through
  // here. Same posture as the four above: the unguessable per-ask token is the
  // gate, and the prefix is narrow so no future /api/supplier-requests/* admin
  // endpoint is allowlisted by accident. Note this covers BOTH the GET read and
  // the POST upload beneath it; the upload handler re-derives the link from the
  // same token and rate-limits per (link, IP) in its own bucket.
  '/api/supplier-requests/public',
  // Phase B4 — public connector info endpoint serves the bare
  // minimum the public drop form needs to render. The handler at
  // /api/public/connectors/<slug> requires a `?token=` query param
  // matched against connectors.public_link_token. Narrow prefix so
  // future /api/public/* siblings still get this same allowlist.
  '/api/public',
];

/**
 * Path-segment regex for parameterized public routes. Each entry MUST
 * be anchored start-and-end so we never accidentally allowlist a
 * sibling endpoint that happens to share a prefix. We also constrain
 * the connector id segment to `[a-zA-Z0-9_-]+` to keep the match tight.
 *
 * The Phase B2 HTTP POST drop door at `/api/sources/<id>/drop`. The
 * handler validates the bearer (connectors.api_token) in constant time;
 * this regex just keeps the request from being short-circuited by the
 * JWT gate first. Sibling admin endpoints at `/api/sources/<id>/run`,
 * `/test`, `/runs`, `/sample`, and `/api-token/rotate` continue to
 * require JWT/API-key auth because they are not in this list.
 *
 * The legacy `/api/connectors/<id>/drop` path remains allowlisted too:
 * it's a thin compat shim (functions/api/connectors/[id]/drop.ts) kept
 * for external vendor integrations wired to the pre-rename URL.
 */
const PUBLIC_ROUTE_PATTERNS: RegExp[] = [
  /^\/api\/sources\/[a-zA-Z0-9_-]+\/drop$/,
  /^\/api\/connectors\/[a-zA-Z0-9_-]+\/drop$/,
];

function isPublicRoute(pathname: string): boolean {
  if (PUBLIC_ROUTES.some((route) => pathname === route || pathname.startsWith(route + '/'))) {
    return true;
  }
  return PUBLIC_ROUTE_PATTERNS.some((re) => re.test(pathname));
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
    // Lookup, expiry (a date-only expiry is valid THROUGH that day) and the
    // active-user check all live in one place that takes an explicit clock.
    const result = await authenticateApiKey(context.env.DB, apiKeyHeader, new Date());
    if (!result.ok) {
      return new Response(JSON.stringify({ error: result.error }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Update last_used_at (fire and forget)
    context.env.DB.prepare(
      "UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?"
    )
      .bind(result.keyId)
      .run();

    context.data.user = result.user;

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

/**
 * The module gate — hidden has to mean unreachable.
 *
 * Runs AFTER `auth`, so `context.data.user` is already resolved however the
 * caller authenticated. That ordering is the whole point of API KEYS
 * INHERITING THE GATE: a key authenticates as the user who created it, so it
 * arrives here as that user and is narrowed exactly as that user is. A key
 * that walked past this would make "disabled" mean nothing more than "hidden
 * from the nav".
 *
 * NO USER MEANS NO GATE. Public routes reach this handler too (the `auth`
 * handler calls `next()` for them without setting a user), and so do the
 * machine paths — `/api/webhooks/*`, `/api/sources/poll`,
 * `/api/expirations/run-scheduled`, and the token-gated public reads behind
 * `/alert/`, `/r/`, `/u/`, `/a/` and `/drop/`. There is nobody to resolve
 * visibility for on those, which is PRECISELY why the scheduled jobs filter
 * themselves (see `functions/lib/module-access.ts`,
 * `isModuleEnabledForTenant`).
 *
 * ⚠ `/api/graphql` is in PUBLIC_ROUTES and authenticates itself, so it never
 * reaches this gate with a user. Its visible set is computed in
 * `functions/lib/graphql/context.ts` instead.
 *
 * 403, NOT 404. The caller is authenticated and the module is listed — greyed
 * — on the Settings screen, so the honest answer is "this exists and you may
 * not have it". A 404 would be indistinguishable from a genuinely missing
 * record and would make every "it just stopped working" ticket unanswerable.
 *
 * FAILS OPEN on a database error, by construction: `checkModuleAccess` returns
 * "allowed" when it cannot read, and logs. Module visibility is a SCOPE
 * control, not a confidentiality boundary — tenant isolation
 * (`requireTenantAccess`) and the four permission tiers (`requireRole`) are
 * the security boundary and are untouched by any of this. Failing closed on a
 * transient D1 blip would take the whole app down to protect a preference.
 */
const moduleGate: PagesFunction<Env> = async (context) => {
  const user = context.data.user as User | undefined;
  if (!user) return context.next();

  const url = new URL(context.request.url);
  // Skips both reads for every path no module owns, which is most of them —
  // `/api/documents` included, deliberately: it is a shared read primitive
  // that compliance and fulfillment both depend on. See `shared/modules.ts`.
  const denial = await checkModuleAccess(context.env.DB, user, url.pathname, context.data);
  if (!denial) return context.next();

  return new Response(
    JSON.stringify({ error: denial.message, code: denial.code, module: denial.module }),
    { status: 403, headers: { 'Content-Type': 'application/json' } },
  );
};

export const onRequest: PagesFunction<Env>[] = [cors, auth, moduleGate];

// Durable Object classes are NOT hosted by this Pages project. They live
// in dedicated Workers (see `workers/sheet-session/`) and are bound here
// via `script_name` in `wrangler.toml`. Cloudflare Pages cannot host DO
// classes — every DO must be deployed as its own Worker first.
