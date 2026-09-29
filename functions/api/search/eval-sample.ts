/**
 * GET /api/search/eval-sample?tenant_id=&n=&seed= — what bin/eval-search asks
 * questions about: a deterministic sample of approved documents with their lot
 * rows, printed identifiers and product names, plus verified negatives
 * (functions/lib/search/sample.ts). Read-only.
 *
 * org_admin (own tenant) and super_admin (named tenant) only: it lists lots,
 * POs and invoice numbers across the tenant in one response, which is more
 * than a reader's one-question-at-a-time search is meant to hand out. The
 * shape is an allow-list — no metadata blob, no document text, no user.
 */

import { BadRequestError, errorToResponse, requireRole, requireTenantAccess } from '../../lib/permissions';
import { loadEvalSample, SAMPLE_MAX } from '../../lib/search/sample';
import type { Env, User } from '../../lib/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const url = new URL(context.request.url);
    let tenantId = url.searchParams.get('tenant_id') || null;
    if (user.role !== 'super_admin') tenantId = user.tenant_id;
    if (!tenantId) throw new BadRequestError('tenant_id is required');
    requireTenantAccess(user, tenantId);

    const nRaw = url.searchParams.get('n');
    const n = nRaw === null ? 25 : Number(nRaw);
    if (!Number.isFinite(n) || n < 1 || n > SAMPLE_MAX) throw new BadRequestError(`n must be between 1 and ${SAMPLE_MAX}`);
    const seed = (url.searchParams.get('seed') || 'eval').slice(0, 100);

    const sample = await loadEvalSample(context.env.DB, tenantId, { n, seed });
    return new Response(JSON.stringify(sample), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Search eval sample error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
