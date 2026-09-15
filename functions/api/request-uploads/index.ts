/**
 * GET /api/request-uploads — files suppliers sent through request links.
 *
 * The staff side of the supplier portal (migration 0104). Two uses:
 *
 *   ?pending=1          the inbox: arrivals with at least one claimed
 *                       requirement still waiting on a person. Oldest first,
 *                       because the file that has waited longest is the one a
 *                       supplier is most likely phoning about.
 *   ?request_id=<any>   one ask's full history, newest first. Any version id is
 *                       accepted and resolved to its root, so a link from an
 *                       old version still shows everything.
 *
 * Also: ?supplier_id=, ?limit=, ?offset=, and ?tenant_id= (super_admin only,
 * and required for one — same convention as the composer's own list).
 *
 * READING IS OPEN TO ANY TENANT USER. What arrived is evidence, not
 * configuration, and the request list it hangs off is open the same way.
 * Deciding is not — see ./[id]/decide.ts.
 *
 * NEVER IN THE PAYLOAD: `uploader_ip` or `r2_key`. They are not selected, so
 * they cannot be serialized. The file is served by ./[id]/file.ts.
 */

import { errorToResponse, NotFoundError } from '../../lib/permissions';
import { resolveRequestTenant } from '../../lib/document-requests';
import { countPendingArrivals, loadArrivals } from '../../lib/request-arrivals';
import type { RequestArrivalListResponse } from '../../../shared/types';
import type { Env, User } from '../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const db = context.env.DB;
    const url = new URL(context.request.url);

    const tenantId = resolveRequestTenant(user, url.searchParams.get('tenant_id') ?? undefined);

    let rootRequestId: string | null = null;
    const requestId = url.searchParams.get('request_id');
    if (requestId) {
      const row = await db
        .prepare('SELECT root_request_id FROM document_requests WHERE id = ? AND tenant_id = ?')
        .bind(requestId, tenantId)
        .first<{ root_request_id: string }>();
      if (!row) throw new NotFoundError('Request not found');
      rootRequestId = row.root_request_id;
    }

    const pending = url.searchParams.get('pending') === '1';
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    const supplierId = url.searchParams.get('supplier_id');

    const { arrivals, total } = await loadArrivals(db, tenantId, {
      rootRequestId,
      supplierId,
      pending,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    });

    const filtered = Boolean(rootRequestId || supplierId);
    const pendingTotal =
      pending && !filtered ? total : await countPendingArrivals(db, tenantId);

    const body: RequestArrivalListResponse = {
      arrivals,
      total,
      limit: Math.min(Math.max(Number.isFinite(limit) ? limit : 50, 1), 200),
      offset: Math.max(Number.isFinite(offset) ? offset : 0, 0),
      pending_total: pendingTotal,
    };
    return json(body);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List request uploads error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
