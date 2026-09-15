import { requireRole, requireTenantAccess, BadRequestError, errorToResponse } from '../../lib/permissions';
import { runRenewalAlerts } from '../../lib/renewal-alerts';
import type { Env, User } from '../../lib/types';

/**
 * POST /api/expirations/notify
 *
 * MANUAL renewal alert. A human in the Renewals page presses "Send alert" and
 * this fires immediately for one tenant.
 *
 * All of the actual work - selecting the alert set, grouping it by owner,
 * routing each group, minting a per-group /alert/<token> link, sending, and
 * stamping the re-alert ledger - lives in `functions/lib/renewal-alerts.ts`,
 * which is shared verbatim with the scheduled path
 * (POST /api/expirations/run-scheduled, driven by the dox-renewal-alerts
 * Worker). This endpoint is the auth + parameter shell around it. That split
 * is deliberate: a manual button and a cron that send DIFFERENT things to
 * DIFFERENT people is how a scheduled alert quietly stops matching what anyone
 * tested.
 *
 * WHAT THIS NO LONGER DOES
 * ------------------------
 * It used to select every org_admin of the tenant plus every super_admin in
 * the install and send them one email listing everything. That is the
 * "an alert everyone receives is an alert nobody acts on" failure; see
 * `functions/lib/alert-routing.ts` for the ladder that replaced it and
 * `migrations/0091` for how a free-text owner label became resolvable.
 *
 * Records whose owner does not resolve are NOT silently re-broadcast to the
 * admin pool. They come back in `unrouted` and produce a separate, plainly
 * worded routing-gap notice plus an audit row.
 *
 * COOLDOWN: skipped here on purpose (`respectCooldown: false`). A person
 * asking for the digest right now gets the whole current alert set, not
 * whatever the weekly quiet period left over. The ledger is still WRITTEN, so
 * pressing this at 09:00 suppresses the cron's repeat later the same day.
 *
 * Degrades cleanly when RESEND_API_KEY is unset - returns
 * { sent:false, reason:'email_not_configured' } rather than 500'ing.
 *
 * LEAD TIME (migration 0111): which documents are alerting is decided per
 * document by its resolved lead time (type override -> tenant -> 60-day
 * default), exactly as the scheduled run decides it. `window_days` is NOT a
 * parameter any more: it used to be passed straight from the Renewals
 * dashboard's look-ahead selector, which let a view filter decide who was
 * mailed. A caller that still sends it gets `window_days_ignored: true` back
 * rather than a silent difference.
 *
 * Body/query params: tenant_id (super_admin only), as_of (default today).
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const url = new URL(context.request.url);
    let body: Record<string, unknown> = {};
    try {
      const text = await context.request.text();
      if (text) body = JSON.parse(text);
    } catch {
      // Empty / non-JSON body is fine - all params have defaults.
    }

    const param = (k: string): string | null =>
      (body[k] != null ? String(body[k]) : null) ?? url.searchParams.get(k);

    // -- tenant scope --------------------------------------------------------
    let tenantId = param('tenant_id');
    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }
    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }
    requireTenantAccess(user, tenantId);

    const windowDaysIgnored = param('window_days') !== null;
    const asOf = param('as_of') || new Date().toISOString().slice(0, 10);

    const result = await runRenewalAlerts(context.env.DB, context.env.RESEND_API_KEY, {
      tenantId,
      asOf,
      appUrl: url.origin,
      respectCooldown: false,
      actorUserId: user.id,
    });

    return json({
      sent: result.sent,
      recipients: result.recipients,
      document_count: result.document_count,
      alerting_count: result.alerting_count,
      suppressed_count: result.suppressed_count,
      groups: result.groups,
      unrouted: result.unrouted,
      tenant_lead: result.tenant_lead,
      ...(windowDaysIgnored ? { window_days_ignored: true } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Expirations notify error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}
