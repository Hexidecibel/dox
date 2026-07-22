import { requireRole, requireTenantAccess, BadRequestError, errorToResponse } from '../../lib/permissions';
import { computeExpirations, alertingRows, DEFAULT_WINDOW_DAYS } from '../../lib/expirations';
import { sendEmail, buildRenewalAlertEmail } from '../../lib/email';
import type { Env, User } from '../../lib/types';

/**
 * POST /api/expirations/notify
 *
 * Manual-trigger renewal alert. Resolves the expiring/expired/overdue set for
 * a tenant (via the shared computeExpirations helper), then sends ONE summary
 * email to the tenant's org_admins + all super_admins. `keep_current` docs are
 * never included (they never alert).
 *
 * Recipient logic (MINIMAL — no per-owner routing yet; assignments.owner_user_id
 * is the FUTURE hook): all active org_admins of the target tenant + all active
 * super_admins, deduped by email. Each doc's `owner` string is shown in the
 * body for triage.
 *
 * Degrades cleanly when RESEND_API_KEY is unset — returns a no-op result
 * ({ sent:false, reason:'email_not_configured' }) instead of 500'ing, mirroring
 * how other email sites skip sending.
 *
 * Body/query params: tenant_id (super_admin only), window_days (default 60),
 * as_of (default today).
 *
 * Returns { sent, recipients, document_count, ... }.
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
      // Empty / non-JSON body is fine — all params have defaults.
    }

    const param = (k: string): string | null =>
      (body[k] != null ? String(body[k]) : null) ?? url.searchParams.get(k);

    // ── tenant scope ────────────────────────────────────────────────────────
    let tenantId = param('tenant_id');
    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }
    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }
    requireTenantAccess(user, tenantId);

    const windowRaw = parseInt(param('window_days') || String(DEFAULT_WINDOW_DAYS), 10);
    const windowDays = Number.isFinite(windowRaw) && windowRaw >= 0 ? windowRaw : DEFAULT_WINDOW_DAYS;
    const asOf = param('as_of') || new Date().toISOString().slice(0, 10);

    // ── resolve the alert set (shared computation) ─────────────────────────
    const { rows } = await computeExpirations(context.env.DB, tenantId, asOf, windowDays);
    const alerts = alertingRows(rows);

    // ── recipients: tenant org_admins + all super_admins ───────────────────
    const recipRes = await context.env.DB.prepare(
      `SELECT DISTINCT email FROM users
        WHERE active = 1
          AND email IS NOT NULL
          AND (
            (role = 'org_admin' AND tenant_id = ?)
            OR role = 'super_admin'
          )`,
    )
      .bind(tenantId)
      .all<{ email: string }>();
    const recipients = (recipRes.results ?? [])
      .map((r) => r.email)
      .filter((e): e is string => !!e);

    // ── tenant name for the email header ────────────────────────────────────
    const tenantRow = await context.env.DB.prepare('SELECT name FROM tenants WHERE id = ?')
      .bind(tenantId)
      .first<{ name: string }>();
    const tenantName = tenantRow?.name ?? 'your organization';

    const documentCount = alerts.length;

    // Nothing to alert on → no-op success.
    if (documentCount === 0) {
      return json({ sent: false, reason: 'no_documents', recipients, document_count: 0 });
    }
    if (recipients.length === 0) {
      return json({ sent: false, reason: 'no_recipients', recipients, document_count: documentCount });
    }
    if (!context.env.RESEND_API_KEY) {
      return json({ sent: false, reason: 'email_not_configured', recipients, document_count: documentCount });
    }

    const { subject, html } = buildRenewalAlertEmail(alerts, tenantName);
    // ONE email to all recipients (Resend accepts an array of `to`).
    const ok = await sendEmail(context.env.RESEND_API_KEY, {
      to: recipients,
      subject,
      html,
    });

    return json({ sent: ok, recipients, document_count: documentCount });
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
