import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import { logAudit, getClientIp } from '../../lib/db';
import type { Env, User } from '../../lib/types';

/**
 * POST /api/lot-matches/:id
 *
 * Resolve a weak lot_match_suggestions row produced by the matching engine.
 * Body: { action: 'accept' | 'reject' }
 *
 *   accept → promote to a STRONG link: stamp the COA reference onto the
 *            order_item (coa_document_id, lot_id, lot_matched=1,
 *            coa_match_status='matched', coa_matched_at) and set the
 *            suggestion's status to 'accepted'.
 *   reject → set the suggestion's status to 'rejected'; leave the order_item
 *            untouched.
 *
 * Only acts on rows currently 'pending'. Tenant-scoped via the suggestion's
 * tenant_id. Audited.
 */
async function handle(context: Parameters<PagesFunction<Env>>[0]): Promise<Response> {
  try {
    const user = context.data.user as User;
    const suggestionId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    let body: { action?: string };
    try {
      body = (await context.request.json()) as { action?: string };
    } catch {
      throw new BadRequestError('Invalid JSON body');
    }

    const action = body.action;
    if (action !== 'accept' && action !== 'reject') {
      throw new BadRequestError("action must be 'accept' or 'reject'");
    }

    const suggestion = await context.env.DB.prepare(
      `SELECT id, tenant_id, order_item_id, document_id, lot_id, match_confidence, status
       FROM lot_match_suggestions WHERE id = ?`
    )
      .bind(suggestionId)
      .first<{
        id: string;
        tenant_id: string;
        order_item_id: string;
        document_id: string;
        lot_id: string | null;
        match_confidence: number | null;
        status: string;
      }>();

    if (!suggestion) {
      throw new NotFoundError('Lot match suggestion not found');
    }

    requireTenantAccess(user, suggestion.tenant_id);

    if (suggestion.status !== 'pending') {
      throw new BadRequestError(
        `Cannot resolve: suggestion is already '${suggestion.status}'`
      );
    }

    if (action === 'accept') {
      // Promote to a strong link on the order_item.
      await context.env.DB.prepare(
        `UPDATE order_items
         SET coa_document_id = ?,
             lot_id = COALESCE(?, lot_id),
             lot_matched = 1,
             match_confidence = ?,
             coa_match_status = 'matched',
             coa_matched_at = datetime('now')
         WHERE id = ?`
      )
        .bind(
          suggestion.document_id,
          suggestion.lot_id,
          suggestion.match_confidence,
          suggestion.order_item_id
        )
        .run();

      await context.env.DB.prepare(
        `UPDATE lot_match_suggestions SET status = 'accepted' WHERE id = ?`
      )
        .bind(suggestionId)
        .run();
    } else {
      await context.env.DB.prepare(
        `UPDATE lot_match_suggestions SET status = 'rejected' WHERE id = ?`
      )
        .bind(suggestionId)
        .run();
    }

    try {
      await logAudit(
        context.env.DB,
        user.id,
        suggestion.tenant_id,
        action === 'accept' ? 'lot_match.accepted' : 'lot_match.rejected',
        'lot_match_suggestion',
        suggestionId,
        JSON.stringify({
          order_item_id: suggestion.order_item_id,
          document_id: suggestion.document_id,
          lot_id: suggestion.lot_id,
        }),
        getClientIp(context.request)
      );
    } catch {
      // Non-fatal — audit failure shouldn't block resolution.
    }

    return new Response(
      JSON.stringify({ success: true, status: action === 'accept' ? 'accepted' : 'rejected' }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Lot match resolve error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

export const onRequestPost: PagesFunction<Env> = handle;
export const onRequestPut: PagesFunction<Env> = handle;
