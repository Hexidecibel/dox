/**
 * POST /api/expirations/run-scheduled
 *
 * The SCHEDULED renewal alert. Driven once a day by the companion
 * `dox-renewal-alerts` Worker (see `workers/renewal-alerts/`), which exists
 * only because Cloudflare Pages cannot host a cron trigger - the same reason
 * `dox-connector-poller` exists, and this endpoint follows that precedent
 * deliberately rather than inventing a second pattern.
 *
 * WHY THIS ENDPOINT EXISTS AT ALL
 * ------------------------------
 * Until now the renewal alert fired only when a human clicked a button on the
 * Renewals page. That makes the portal good at onboarding and useless at the
 * thing the client actually pays for month to month: "Renewal is the frequent
 * use case... If the portal only handles onboarding well, the cutover fails
 * quietly in November." An alert nobody remembers to press is not an alert.
 *
 * AUTH
 * ----
 * Bearer token (`Authorization: Bearer <RENEWAL_ALERT_TOKEN>`), checked here.
 * The route is allowlisted in `functions/api/_middleware.ts` so the JWT layer
 * is bypassed. Fails CLOSED: an unset RENEWAL_ALERT_TOKEN denies everyone
 * rather than opening the endpoint.
 *
 * A SEPARATE token from CONNECTOR_POLL_TOKEN on purpose. They have different
 * blast radii - one dispatches ingest runs, one sends mail to customers'
 * customers - and sharing a secret between them means a leak of either is a
 * leak of both.
 *
 * WHAT IT DOES
 * ------------
 * Walks every active tenant and runs the shared engine
 * (`functions/lib/renewal-alerts.ts`) for each with `respectCooldown: true`.
 * All the domain logic - owner grouping, routing, the re-alert ledger, the
 * per-group /alert/<token> deep link, the routing-gap notice - is in that
 * module and is byte-for-byte what the manual button runs. The Worker holds no
 * logic; it only holds the schedule.
 *
 * CONCURRENCY
 * -----------
 * Single-flighted through the same `app_state` lock table the connector poller
 * uses, under a different key. A daily job overlapping itself would mean two
 * digests to the same owner in the same minute, which is precisely the fatigue
 * this feature is trying to avoid. 15-minute TTL: long enough for a big
 * multi-tenant walk, far shorter than the daily interval.
 *
 * Responses: a JSON summary the Worker logs. The Worker does not retry -
 * tomorrow's tick picks up anything today's missed, because the ledger tracks
 * what was actually SENT rather than what was attempted.
 */

import type { Env } from '../../lib/types';
import { runRenewalAlerts, type RenewalAlertResult } from '../../lib/renewal-alerts';
import { DEFAULT_WINDOW_DAYS } from '../../lib/expirations';
import { isModuleEnabledForTenant } from '../../lib/module-access';
import { MODULES } from '../../../shared/modules';

const LOCK_TTL_MS = 15 * 60 * 1000;
const LOCK_KEY = 'renewal_alert_lock';

/**
 * Create `app_state` on first use. Idempotent, and identical to the connector
 * poller's - the table is an implementation detail of scheduled endpoints, not
 * a schema commitment, so it is not a migration.
 */
async function ensureAppStateTable(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS app_state (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    )
    .run();
}

async function acquireLock(db: D1Database, token: string): Promise<boolean> {
  await ensureAppStateTable(db);
  const now = Date.now();
  const cutoff = now - LOCK_TTL_MS;

  try {
    await db
      .prepare(`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)`)
      .bind(LOCK_KEY, token, now)
      .run();
    return true;
  } catch {
    /* existing row - attempt to steal a stale one */
  }

  const updated = await db
    .prepare(
      `UPDATE app_state SET value = ?, updated_at = ?
        WHERE key = ? AND updated_at < ?`,
    )
    .bind(token, now, LOCK_KEY, cutoff)
    .run();
  const changes = (updated as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0;
  return changes > 0;
}

async function releaseLock(db: D1Database, token: string): Promise<void> {
  try {
    await db
      .prepare(`DELETE FROM app_state WHERE key = ? AND value = ?`)
      .bind(LOCK_KEY, token)
      .run();
  } catch {
    /* swallow - the lock expires on its own */
  }
}

function unauthorized(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Constant-time-ish comparison. The token is high entropy and this endpoint is
 * rate-limited by being unlisted, but a length-independent compare costs
 * nothing and matches how the connector drop door checks its bearer.
 */
function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const expected = context.env.RENEWAL_ALERT_TOKEN;
  if (!expected) {
    return unauthorized('Scheduled renewal alerts are not configured');
  }
  const authHeader = context.request.headers.get('Authorization') || '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return unauthorized('Missing bearer token');
  }
  if (!tokensMatch(authHeader.slice('bearer '.length).trim(), expected)) {
    return unauthorized('Invalid bearer token');
  }

  const url = new URL(context.request.url);
  let body: Record<string, unknown> = {};
  try {
    const text = await context.request.text();
    if (text) body = JSON.parse(text);
  } catch {
    /* empty body is the normal case for a cron tick */
  }
  const param = (k: string): string | null =>
    (body[k] != null ? String(body[k]) : null) ?? url.searchParams.get(k);

  const windowRaw = parseInt(param('window_days') || String(DEFAULT_WINDOW_DAYS), 10);
  const windowDays = Number.isFinite(windowRaw) && windowRaw >= 0 ? windowRaw : DEFAULT_WINDOW_DAYS;
  const asOf = param('as_of') || new Date().toISOString().slice(0, 10);
  // Scoping to one tenant is for operator debugging ("re-run just Medosweet"),
  // not for normal operation. Absent = every active tenant.
  const onlyTenant = param('tenant_id');

  const lockToken = crypto.randomUUID();
  if (!(await acquireLock(context.env.DB, lockToken))) {
    return json({ error: 'Renewal alert run already in progress', code: 'busy' }, 429);
  }

  try {
    const tenantRes = onlyTenant
      ? await context.env.DB.prepare(`SELECT id FROM tenants WHERE id = ? AND active = 1`)
          .bind(onlyTenant)
          .all<{ id: string }>()
      : await context.env.DB.prepare(`SELECT id FROM tenants WHERE active = 1`).all<{ id: string }>();

    const allTenantIds = (tenantRes.results ?? []).map((t) => t.id);

    // MODULE FILTER — the machine path has to gate itself.
    //
    // This endpoint is allowlisted past `_middleware.ts` (there is no user to
    // resolve, only a bearer token), so the module gate that stops a person
    // reaching a switched-off surface cannot possibly run here. A tenant that
    // turned Compliance off would keep receiving renewal digests every
    // morning: a module you HID that still EMAILS you is the bug the customer
    // reports, and it is worse than the surface having stayed visible, because
    // they cannot even find the screen that explains where the mail is coming
    // from.
    //
    // `MODULES.compliance.key` rather than the bare string: renaming the
    // module then fails to compile here, which is the whole discipline in
    // `shared/modules.ts`. Fails OPEN per tenant — a tenant keeps its alerts
    // if we cannot read the table.
    const tenantIds: string[] = [];
    for (const tenantId of allTenantIds) {
      if (await isModuleEnabledForTenant(context.env.DB, tenantId, MODULES.compliance.key)) {
        tenantIds.push(tenantId);
      }
    }
    const skippedModuleOff = allTenantIds.length - tenantIds.length;

    const results: RenewalAlertResult[] = [];
    for (const tenantId of tenantIds) {
      try {
        results.push(
          await runRenewalAlerts(context.env.DB, context.env.RESEND_API_KEY, {
            tenantId,
            asOf,
            windowDays,
            // The link a recipient clicks has to be the PUBLIC origin of the
            // request that produced it - the Worker POSTs to the real
            // hostname, so this is the real hostname.
            appUrl: url.origin,
            respectCooldown: true,
            actorUserId: null,
          }),
        );
      } catch (err) {
        // One tenant's failure must not silence every tenant after it in the
        // loop. Logged and counted; tomorrow's run retries it, because the
        // ledger only records what actually sent.
        console.error(
          `[renewal-alerts] tenant ${tenantId} failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const summary = {
      ran_at: new Date().toISOString(),
      as_of: asOf,
      window_days: windowDays,
      tenants_checked: tenantIds.length,
      tenants_completed: results.length,
      // Reported rather than silent: an operator reading a run that alerted
      // fewer tenants than yesterday needs to see that the difference was a
      // configuration choice and not a failure.
      tenants_skipped_module_off: skippedModuleOff,
      emails_sent: results.reduce((n, r) => n + r.groups.filter((g) => g.sent).length, 0),
      documents_alerted: results.reduce((n, r) => n + r.document_count, 0),
      documents_suppressed: results.reduce((n, r) => n + r.suppressed_count, 0),
      // Surfaced at the TOP of the summary, not buried per tenant: an operator
      // scanning `wrangler tail` needs to see that records went unalerted.
      documents_unrouted: results.reduce((n, r) => n + r.unrouted.count, 0),
      tenants: results.map((r) => ({
        tenant_id: r.tenant_id,
        tenant_name: r.tenant_name,
        sent: r.sent,
        document_count: r.document_count,
        alerting_count: r.alerting_count,
        suppressed_count: r.suppressed_count,
        unrouted_count: r.unrouted.count,
        unrouted_owner_labels: r.unrouted.owner_labels,
        groups: r.groups.map((g) => ({
          owner_label: g.owner_label,
          via: g.via,
          recipient_count: g.recipients.length,
          document_count: g.document_count,
          sent: g.sent,
        })),
        reason: r.reason,
      })),
    };

    return json(summary);
  } catch (err) {
    console.error('scheduled renewal alert failed:', err);
    return json({ error: err instanceof Error ? err.message : 'Internal server error' }, 500);
  } finally {
    await releaseLock(context.env.DB, lockToken);
  }
};

/** Helpful 405 rather than a confusing 401 if somebody GETs it by mistake. */
export const onRequestGet: PagesFunction<Env> = async () =>
  new Response(JSON.stringify({ error: 'Use POST' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json', Allow: 'POST' },
  });
