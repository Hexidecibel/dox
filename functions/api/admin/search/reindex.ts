/**
 * POST /api/admin/search/reindex
 *
 * Phase 2 admin entry point for the FTS5 reindex queue. Lets a super_admin:
 *   - Enqueue a full-rebuild job for one tenant (or all tenants).
 *   - Drain pending jobs synchronously (useful from staging-walkthrough
 *     scripts and one-shot ops).
 *   - Both: enqueue then drain in one call (default behavior).
 *
 * The drainer itself lives in `functions/lib/search-reindex.ts` so it
 * can be called from a future process-worker integration too.
 *
 * Body (all fields optional):
 *   {
 *     "action":    "enqueue" | "drain" | "enqueue_and_drain",  // default "enqueue_and_drain"
 *     "tenant_id": "<id>",                                     // omit = all tenants
 *     "batch_size": 500,
 *     "max_jobs":   100
 *   }
 *
 * Auth: super_admin only.
 *
 * Response:
 *   {
 *     "enqueued": <number of jobs newly inserted>,
 *     "drain":    { "jobsCompleted": ..., "jobsFailed": ..., ... }
 *   }
 */

import {
  requireRole,
  BadRequestError,
  errorToResponse,
} from '../../../lib/permissions';
import { logAudit, getClientIp } from '../../../lib/db';
import {
  drainSearchReindexQueue,
  enqueueFullTenantReindex,
} from '../../../lib/search-reindex';
import type { Env, User } from '../../../lib/types';

interface ReindexBody {
  action?: 'enqueue' | 'drain' | 'enqueue_and_drain';
  tenant_id?: string;
  batch_size?: number;
  max_jobs?: number;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin');

    let body: ReindexBody = {};
    try {
      const text = await context.request.text();
      if (text.trim().length > 0) {
        body = JSON.parse(text) as ReindexBody;
      }
    } catch {
      throw new BadRequestError('Invalid JSON body');
    }

    const action = body.action ?? 'enqueue_and_drain';
    if (!['enqueue', 'drain', 'enqueue_and_drain'].includes(action)) {
      throw new BadRequestError(
        `action must be one of: enqueue, drain, enqueue_and_drain`,
      );
    }

    const batchSize = body.batch_size ?? 500;
    const maxJobs = body.max_jobs ?? 100;

    let enqueued = 0;

    if (action === 'enqueue' || action === 'enqueue_and_drain') {
      if (body.tenant_id) {
        const r = await enqueueFullTenantReindex(context.env.DB, body.tenant_id);
        if (r.enqueued) enqueued++;
      } else {
        // Enqueue a tenant-wide rebuild job for every active tenant.
        const tenants = await context.env.DB
          .prepare(`SELECT id FROM tenants WHERE active = 1`)
          .all<{ id: string }>();
        for (const t of tenants.results ?? []) {
          const r = await enqueueFullTenantReindex(context.env.DB, t.id);
          if (r.enqueued) enqueued++;
        }
      }
    }

    let drainResult = null;
    if (action === 'drain' || action === 'enqueue_and_drain') {
      drainResult = await drainSearchReindexQueue(context.env.DB, {
        batchSize,
        maxJobs,
      });
    }

    try {
      await logAudit(
        context.env.DB,
        user.id,
        body.tenant_id ?? null,
        'admin.search.reindex',
        'search_reindex_jobs',
        null,
        JSON.stringify({ action, enqueued, drain: drainResult }),
        getClientIp(context.request),
      );
    } catch {
      // Non-fatal — audit failure shouldn't break the admin endpoint.
    }

    return new Response(
      JSON.stringify({ enqueued, drain: drainResult }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Reindex error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
