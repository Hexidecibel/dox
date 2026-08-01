/**
 * /api/claim-rules — the claim -> requirement mapping (claim_type_requirements).
 *
 * This is the client's "conditional triggers" config expressed as rows:
 * "a document that claims Organic makes an Organic Certificate applicable".
 * Entered ONCE per claim, then reused by every document that asserts it.
 *
 * It is the unlock for gap detection (P4): without a mapping, a detected claim
 * cannot resolve to a NAMED missing document — it is detectable but inert.
 *
 * GET  /api/claim-rules[?claim_type_id=][&tenant_id=]  -> every rule, joined
 * PUT  /api/claim-rules                                -> replace one claim's set
 *
 * PUT takes the WHOLE set for a claim rather than per-row add/remove, because
 * the editor is a checkbox list: what the user sees ticked is what gets saved,
 * with no partial-failure state where half the boxes applied.
 */

import { logAudit, getClientIp } from '../../lib/db';
import { requireRole, requireTenantAccess, errorToResponse, NotFoundError } from '../../lib/permissions';
import {
  parseClaimRules,
  syncClaimTypeRequirements,
  listClaimTypeRequirements,
} from '../../lib/registry-vocab';
import type { Env, User } from '../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * GET /api/claim-rules
 * Every mapping for the tenant with both vocabularies joined in, so the editor
 * renders the whole config in one request rather than N+1 per claim.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);
    const claimTypeId = url.searchParams.get('claim_type_id') || undefined;
    const tenantIdParam = url.searchParams.get('tenant_id');

    let tenantId: string;
    if (user.role === 'super_admin') {
      if (!tenantIdParam) return json({ error: 'tenant_id is required for super_admin' }, 400);
      tenantId = tenantIdParam;
    } else {
      tenantId = user.tenant_id!;
    }

    const rules = await listClaimTypeRequirements(context.env.DB, tenantId, claimTypeId);
    return json({ rules });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List claim rules error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

/**
 * PUT /api/claim-rules
 * Body: { claim_type_id, requirements: [id | { requirement_id, is_required, notes }] }
 *
 * Replaces the requirement set the claim opens. An empty array is a legitimate
 * save — it means "this claim opens nothing", which is how a user clears a rule.
 * The tenant is taken from the claim type itself (not the body) so a mapping
 * cannot be pointed at another tenant's vocabulary.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const body = (await context.request.json()) as {
      claim_type_id?: string;
      requirements?: unknown;
    };

    const claimTypeId = body.claim_type_id?.trim();
    if (!claimTypeId) return json({ error: 'claim_type_id is required' }, 400);

    const claimType = await context.env.DB.prepare(
      'SELECT id, tenant_id, name FROM claim_types WHERE id = ?',
    )
      .bind(claimTypeId)
      .first<{ id: string; tenant_id: string; name: string }>();
    if (!claimType) throw new NotFoundError('Claim type not found');

    requireTenantAccess(user, claimType.tenant_id);

    const rules = parseClaimRules(body.requirements);

    await syncClaimTypeRequirements(context.env.DB, claimType.tenant_id, claimTypeId, rules);

    await logAudit(
      context.env.DB,
      user.id,
      claimType.tenant_id,
      'claim_rules_updated',
      'claim_type',
      claimTypeId,
      JSON.stringify({ claim_type: claimType.name, requirement_count: rules.length }),
      getClientIp(context.request),
    );

    const saved = await listClaimTypeRequirements(
      context.env.DB,
      claimType.tenant_id,
      claimTypeId,
    );

    return json({ rules: saved });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update claim rules error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
