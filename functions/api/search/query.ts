/**
 * POST /api/search/query — the one search executor (search redesign, Phase 1).
 *
 * Body: `SearchQueryRequest` (shared/types.ts):
 *   {
 *     query: { v: 1, text, clauses: [{ id, field, op, values, exclude?, role?, sublot?, source }], view },
 *     tenant_id?,            // super_admin only
 *     limit?, offset?,       // documents page (limit ≤ 200)
 *     facets?: boolean,      // default true
 *     interpret?: boolean,   // read lots / dates / PO / invoice / order out of `text`
 *   }
 *
 * Every clause runs, in any order (AJ's I1): scope clauses (supplier, type,
 * product, status, uploaded) are hard filters with sticky-exclusion facets;
 * identifying clauses (lot, production / code / best-by date, order, PO,
 * invoice, identifier) are judged by the unchanged coverage engine and answer
 * covering / likely / nearby — or "no document on file covers …" (I3).
 * A malformed clause is a 400 that says why; nothing is guessed.
 *
 * Response: `SearchQueryResponse`, including `stats` (statements, round trips)
 * so the cost of an answer is visible.
 */

import { BadRequestError, errorToResponse, requireRole, requireTenantAccess } from '../../lib/permissions';
import { callerHasModule } from '../../lib/module-access';
import { runSearch } from '../../lib/search/execute';
import type { Env, User } from '../../lib/types';
import type { SearchQueryRequest } from '../../../shared/types';
import { savedView, type SearchQuery } from '../../../shared/searchQuery';
import { FACET_FIELDS, type FacetField } from '../../../shared/searchFields';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user', 'reader');

    let body: SearchQueryRequest;
    try {
      body = (await context.request.json()) as SearchQueryRequest;
    } catch {
      throw new BadRequestError('Invalid JSON body');
    }
    const raw = (body?.query ?? null) as Partial<SearchQuery> | null;
    if (!raw || typeof raw !== 'object') throw new BadRequestError('query is required');
    const query: SearchQuery = {
      v: 1,
      text: typeof raw.text === 'string' ? raw.text : '',
      clauses: Array.isArray(raw.clauses) ? raw.clauses : [],
      view: savedView(raw.view),
    };
    if (raw.view && typeof raw.view === 'object' && typeof raw.view.page === 'number') query.view.page = raw.view.page;

    let tenantId = body.tenant_id || null;
    if (user.role !== 'super_admin') tenantId = user.tenant_id;
    if (!tenantId) throw new BadRequestError('tenant_id is required');
    requireTenantAccess(user, tenantId);

    const limit = Math.min(Math.max(Number(body.limit ?? 20) || 20, 1), 200);
    const offset = Math.max(Number(body.offset ?? 0) || 0, 0);

    // Orders and customers are the fulfillment module's records. A caller
    // without it gets an answer built without them, and told so.
    const fulfillment = await callerHasModule(context.env.DB, user, context.data, 'fulfillment');

    const result = await runSearch(context.env.DB, tenantId, {
      query,
      fulfillment,
      limit,
      offset,
      facets: body.facets !== false,
      interpret: body.interpret === true,
      facetFields: Array.isArray(body.facet_fields)
        ? body.facet_fields.filter((f): f is FacetField => (FACET_FIELDS as readonly string[]).includes(f as string))
        : undefined,
    });

    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Search query error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
