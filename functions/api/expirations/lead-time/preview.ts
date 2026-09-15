/**
 * GET /api/expirations/lead-time/preview
 *
 * What a proposed renewal alert lead time would change at the next scheduled
 * run, before anyone saves it. Read-only: see functions/lib/renewal-lead-time.ts.
 *
 * Query:
 *   lead_days          number (7-365), or empty / "inherit" for null
 *                      (tenant scope: the default; type scope: the organization's)
 *   document_type_id   present = preview a per-type override; absent = tenant
 *   as_of              YYYY-MM-DD, default today
 *   tenant_id          super_admin only
 *
 * Auth: super_admin + org_admin, same as the setting it previews. A document
 * type from another tenant is a 404, not a preview of zero.
 */

import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  NotFoundError,
  errorToResponse,
} from '../../../lib/permissions';
import { parseRenewalAlertLeadDays } from '../../../../shared/renewalLeadTime';
import { previewLeadTimeChange, resolveLeadTimeTenantId } from '../../../lib/renewal-lead-time';
import type { Env, User } from '../../../lib/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const url = new URL(context.request.url);
    const tenantId = resolveLeadTimeTenantId(user, url.searchParams.get('tenant_id'));
    requireTenantAccess(user, tenantId);

    const raw = url.searchParams.get('lead_days');
    if (raw === null) {
      throw new BadRequestError('lead_days is required (a number of days, or "inherit")');
    }
    const trimmed = raw.trim();
    const candidate: unknown =
      trimmed === '' || trimmed.toLowerCase() === 'inherit' ? null : /^-?\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
    const parsed = parseRenewalAlertLeadDays(candidate);
    if (!parsed.ok) throw new BadRequestError(parsed.error.replace('renewal_alert_lead_days', 'lead_days'));

    const asOf = url.searchParams.get('as_of') || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new BadRequestError('as_of must be YYYY-MM-DD');

    const documentTypeId = url.searchParams.get('document_type_id');
    if (documentTypeId) {
      const dt = await context.env.DB.prepare(
        'SELECT id FROM document_types WHERE id = ? AND tenant_id = ?',
      )
        .bind(documentTypeId, tenantId)
        .first();
      if (!dt) throw new NotFoundError('Document type not found');
    }

    const preview = await previewLeadTimeChange(context.env.DB, tenantId, asOf, {
      scope: documentTypeId ? 'document_type' : 'tenant',
      leadDays: parsed.value,
      documentTypeId: documentTypeId ?? undefined,
    });

    return new Response(JSON.stringify(preview), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Renewal alert lead time preview error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
