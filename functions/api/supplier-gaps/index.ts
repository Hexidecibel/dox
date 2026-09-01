/**
 * /api/supplier-gaps — "what does this supplier still owe us?"
 *
 * The set difference migration 0087 unblocked:
 *
 *     ( requirements that APPLY to supplier S — supplier_requirements, plus
 *       anything a CONFIRMED claim on S's documents opened )
 *   MINUS
 *     ( requirements CLOSED by S's confirmed document_requirements links )
 *
 * All of the judgment lives in `shared/requirementGap.ts` (pure) and all of the
 * SQL in `functions/lib/requirement-gaps.ts`; this file is transport only —
 * parse, scope to a tenant, delegate, serialize.
 *
 * ROLE GATE mirrors /api/requirements: reading is open to any authenticated
 * user of the tenant (a gap report is evidence, not configuration — same
 * reasoning as /api/spec-checks), and tenant scoping is unconditional. A
 * non-super_admin is pinned to `user.tenant_id` before a single row is read,
 * so an org_admin cannot see another tenant regardless of what they pass.
 *
 * DEFAULT: `required` tier only. `?include_recommended=1` opts in. The
 * response always echoes `tiers_counted` so a client cannot silently misread
 * which tiers a number covers.
 */

import { errorToResponse, BadRequestError } from '../../lib/permissions';
import { loadSupplierGaps } from '../../lib/requirement-gaps';
import { rollupSupplierGaps } from '../../../shared/requirementGap';
import type { SupplierGapListResponse } from '../../../shared/requirementGap';
import type { Env, User } from '../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Accepts 1/true/yes; everything else (including absent) is false. */
function boolParam(raw: string | null): boolean {
  if (raw == null) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Which tenant this report covers.
 *
 * A super_admin has no tenant of their own, so they must name one — either
 * directly or implicitly via a supplier they are asking about. Guessing (for
 * example, "all tenants") would produce a roll-up whose numbers belong to
 * nobody, which is worse than a 400.
 */
async function resolveReadTenant(
  db: D1Database,
  user: User,
  tenantIdParam: string | null,
  supplierId: string | null,
): Promise<string> {
  if (user.role !== 'super_admin') return user.tenant_id!;
  if (tenantIdParam) return tenantIdParam;
  if (supplierId) {
    const row = await db
      .prepare('SELECT tenant_id FROM suppliers WHERE id = ?')
      .bind(supplierId)
      .first<{ tenant_id: string }>();
    if (!row) throw new BadRequestError('Unknown supplier');
    return row.tenant_id;
  }
  throw new BadRequestError('tenant_id or supplier_id is required for super_admin');
}

/**
 * GET /api/supplier-gaps
 *
 * ?supplier_id=            one supplier (omit to list across every supplier)
 * ?include_recommended=1   count the advisory tier too (default: off)
 * ?status=open|satisfied|not_configured   narrow the list
 * ?tenant_id=              super_admin only
 * ?limit= / ?offset=       page the supplier list (default 100, max 200)
 *
 * A single-supplier request still returns the list shape, with one entry. One
 * shape means the UI has one parser and `rollup` means the same thing whether
 * it covers one supplier or two hundred.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);

    const supplierId = url.searchParams.get('supplier_id');
    const tenantIdParam = url.searchParams.get('tenant_id');
    const includeRecommended = boolParam(url.searchParams.get('include_recommended'));
    const statusFilter = url.searchParams.get('status');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 200);
    const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);

    if (statusFilter && !['open', 'satisfied', 'not_configured'].includes(statusFilter)) {
      return json(
        { error: 'status must be one of: open, satisfied, not_configured' },
        400,
      );
    }

    const tenantId = await resolveReadTenant(
      context.env.DB,
      user,
      tenantIdParam,
      supplierId,
    );

    const { gaps, total } = await loadSupplierGaps(context.env.DB, tenantId, {
      supplierId,
      includeRecommended,
      limit,
      offset,
    });

    // Filtering happens AFTER computation, on the page that was loaded: the
    // status is derived, not stored, so it cannot be a WHERE clause. `total`
    // therefore stays the count of suppliers in scope and the rollup describes
    // the filtered set — labelled as such by the caller's own filter.
    const filtered = statusFilter ? gaps.filter((g) => g.status === statusFilter) : gaps;

    const body: SupplierGapListResponse = {
      gaps: filtered,
      rollup: rollupSupplierGaps(filtered),
      tiers_counted: includeRecommended ? ['required', 'recommended'] : ['required'],
      include_recommended: includeRecommended,
      total,
      limit,
      offset,
    };

    return json(body);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Supplier gap report error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
