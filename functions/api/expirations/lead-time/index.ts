/**
 * The organization's renewal alert lead time (migration 0111).
 *
 * "Warn owners N days before a document is due." One number per tenant, with a
 * per-document-type override edited on Document Types (PUT
 * /api/document-types/:id `renewal_alert_lead_days`). NULL = the code default
 * (60). Resolution and validation live in shared/renewalLeadTime.ts; the alert
 * engine (functions/lib/renewal-alerts.ts) applies it per document on both the
 * scheduled run and the manual "Send alert now" button.
 *
 * Auth mirrors /api/spec-unit-policy: super_admin + org_admin. super_admin
 * names the tenant (?tenant_id= / body.tenant_id); org_admin is pinned to its
 * own. Under /api/expirations, so the Compliance module gate applies.
 *
 * Every change is stamped (updated_at / updated_by) and audit-logged with the
 * previous value, because this setting decides when customers' suppliers
 * start being chased and "who moved it to 30?" must be answerable.
 */

import { logAudit, getClientIp } from '../../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  NotFoundError,
  errorToResponse,
} from '../../../lib/permissions';
import {
  DEFAULT_RENEWAL_ALERT_LEAD_DAYS,
  MAX_RENEWAL_ALERT_LEAD_DAYS,
  MIN_RENEWAL_ALERT_LEAD_DAYS,
  RENEWAL_ALERT_LEAD_PRESETS,
  parseRenewalAlertLeadDays,
  resolveRenewalAlertLead,
} from '../../../../shared/renewalLeadTime';
import { resolveLeadTimeTenantId } from '../../../lib/renewal-lead-time';
import type { Env, User } from '../../../lib/types';

interface TenantLeadRow {
  renewal_alert_lead_days: number | null;
  renewal_alert_lead_updated_at: string | null;
  renewal_alert_lead_updated_by: string | null;
  updated_by_name: string | null;
}

interface TypeOverrideRow {
  id: string;
  name: string;
  renewal_alert_lead_days: number;
  renewal_alert_lead_updated_at: string | null;
}

const SELECT_TENANT = `SELECT t.renewal_alert_lead_days,
                              t.renewal_alert_lead_updated_at,
                              t.renewal_alert_lead_updated_by,
                              u.name AS updated_by_name
                         FROM tenants t
                         LEFT JOIN users u ON u.id = t.renewal_alert_lead_updated_by
                        WHERE t.id = ?`;

async function buildResponse(db: D1Database, tenantId: string): Promise<Response> {
  const row = await db.prepare(SELECT_TENANT).bind(tenantId).first<TenantLeadRow>();
  if (!row) throw new NotFoundError('Tenant not found');

  const overrides = await db
    .prepare(
      `SELECT id, name, renewal_alert_lead_days, renewal_alert_lead_updated_at
         FROM document_types
        WHERE tenant_id = ? AND active = 1 AND renewal_alert_lead_days IS NOT NULL
        ORDER BY name`,
    )
    .bind(tenantId)
    .all<TypeOverrideRow>();

  return new Response(
    JSON.stringify({
      tenant_id: tenantId,
      lead_days: row.renewal_alert_lead_days ?? null,
      effective: resolveRenewalAlertLead(null, row.renewal_alert_lead_days),
      default_lead_days: DEFAULT_RENEWAL_ALERT_LEAD_DAYS,
      min_lead_days: MIN_RENEWAL_ALERT_LEAD_DAYS,
      max_lead_days: MAX_RENEWAL_ALERT_LEAD_DAYS,
      presets: RENEWAL_ALERT_LEAD_PRESETS,
      updated_at: row.renewal_alert_lead_updated_at ?? null,
      updated_by: row.renewal_alert_lead_updated_by ?? null,
      updated_by_name: row.updated_by_name ?? null,
      document_type_overrides: (overrides.results ?? []).map((o) => ({
        id: o.id,
        name: o.name,
        lead_days: o.renewal_alert_lead_days,
        updated_at: o.renewal_alert_lead_updated_at ?? null,
      })),
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

function internalError(label: string, err: unknown): Response {
  console.error(label, err);
  return new Response(JSON.stringify({ error: 'Internal server error' }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** GET /api/expirations/lead-time[?tenant_id=] */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const url = new URL(context.request.url);
    const tenantId = resolveLeadTimeTenantId(user, url.searchParams.get('tenant_id'));
    requireTenantAccess(user, tenantId);
    return await buildResponse(context.env.DB, tenantId);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    return internalError('Get renewal alert lead time error:', err);
  }
};

/**
 * PUT /api/expirations/lead-time
 * Body: { lead_days: number | null, tenant_id? }
 *
 * `lead_days` is REQUIRED (null is a real answer: "use the default"). A missing
 * key is refused rather than read as null, so a malformed client cannot reset
 * an organization's warning period by omission.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    let body: { lead_days?: unknown; tenant_id?: string };
    try {
      body = (await context.request.json()) as typeof body;
    } catch {
      throw new BadRequestError('Body must be JSON');
    }
    if (!body || !('lead_days' in body)) {
      throw new BadRequestError('lead_days is required (a number of days, or null for the default)');
    }
    const parsed = parseRenewalAlertLeadDays(body.lead_days);
    if (!parsed.ok) throw new BadRequestError(parsed.error.replace('renewal_alert_lead_days', 'lead_days'));

    const tenantId = resolveLeadTimeTenantId(user, body.tenant_id);
    requireTenantAccess(user, tenantId);

    const before = await context.env.DB.prepare(SELECT_TENANT).bind(tenantId).first<TenantLeadRow>();
    if (!before) throw new NotFoundError('Tenant not found');
    const previous = before.renewal_alert_lead_days ?? null;

    // A no-op save changes nothing and audits nothing: the stamp should say
    // when the number last MOVED, not when someone last pressed Save.
    if (previous !== parsed.value) {
      await context.env.DB.prepare(
        `UPDATE tenants
            SET renewal_alert_lead_days = ?,
                renewal_alert_lead_updated_at = datetime('now'),
                renewal_alert_lead_updated_by = ?
          WHERE id = ?`,
      )
        .bind(parsed.value, user.id, tenantId)
        .run();

      await logAudit(
        context.env.DB,
        user.id,
        tenantId,
        'renewal_alert_lead_time_updated',
        'tenants',
        tenantId,
        JSON.stringify({ lead_days: parsed.value, previous_lead_days: previous }),
        getClientIp(context.request),
      );
    }

    return await buildResponse(context.env.DB, tenantId);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    return internalError('Update renewal alert lead time error:', err);
  }
};
