import { getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import { mergeSuppliers } from '../../lib/suppliers';
import type { Env, User } from '../../lib/types';

/**
 * POST /api/suppliers/merge
 * Body: { winner_id: string, loser_ids: string[] }
 *
 * Explicit operator-driven merge: reassigns every supplier_id FK from the
 * losers to the winner, folds the losers' names + aliases into the winner,
 * and deletes the loser rows. NOT fuzzy auto-merge — the caller picks the
 * winner and losers.
 *
 * Auth: org_admin or super_admin for the tenant.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const body = (await context.request.json()) as {
      winner_id?: string;
      loser_ids?: string[];
    };

    const winnerId = body.winner_id?.trim();
    const loserIds = Array.isArray(body.loser_ids)
      ? body.loser_ids.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean)
      : [];

    if (!winnerId) {
      throw new BadRequestError('winner_id is required');
    }
    if (loserIds.length === 0) {
      throw new BadRequestError('loser_ids must be a non-empty array');
    }
    if (loserIds.includes(winnerId)) {
      throw new BadRequestError('winner_id cannot appear in loser_ids');
    }

    // Resolve tenant the same way other suppliers endpoints do: super_admin may
    // pass tenant_id, everyone else is pinned to their own tenant.
    let tenantId: string | null = null;
    if (user.role === 'super_admin') {
      // Derive tenant from the winner supplier so super_admin doesn't have to
      // pass it explicitly; fall back to body.tenant_id if provided.
      const bodyTenant = (body as { tenant_id?: string }).tenant_id;
      if (bodyTenant) {
        tenantId = bodyTenant;
      } else {
        const row = await context.env.DB.prepare(
          'SELECT tenant_id FROM suppliers WHERE id = ?'
        )
          .bind(winnerId)
          .first<{ tenant_id: string }>();
        tenantId = row?.tenant_id ?? null;
      }
    } else {
      tenantId = user.tenant_id;
    }

    if (!tenantId) {
      throw new BadRequestError('tenant_id could not be resolved');
    }

    requireTenantAccess(user, tenantId);

    const result = await mergeSuppliers(context.env.DB, tenantId, {
      winnerId,
      loserIds,
      actor: { userId: user.id, ip: getClientIp(context.request) },
    });

    return new Response(
      JSON.stringify({
        winner_id: result.winnerId,
        reassigned: result.reassigned,
        foldedAliases: result.foldedAliases,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Supplier merge error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
