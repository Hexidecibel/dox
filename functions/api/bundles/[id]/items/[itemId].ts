import { logAudit, getClientIp } from '../../../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../../../lib/permissions';
import type { Env, User } from '../../../../lib/types';

/**
 * DELETE /api/bundles/:id/items/:itemId
 * Remove an item from a bundle.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const bundleId = context.params.id as string;
    const itemId = context.params.itemId as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const bundle = await context.env.DB.prepare(
      'SELECT * FROM document_bundles WHERE id = ?'
    )
      .bind(bundleId)
      .first();

    if (!bundle) {
      throw new NotFoundError('Bundle not found');
    }

    requireTenantAccess(user, bundle.tenant_id as string);

    // Only allow removing items from draft bundles (unless super_admin)
    if (bundle.status !== 'draft' && user.role !== 'super_admin') {
      return new Response(
        JSON.stringify({ error: 'Cannot modify a finalized bundle' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const item = await context.env.DB.prepare(
      'SELECT * FROM document_bundle_items WHERE id = ? AND bundle_id = ?'
    )
      .bind(itemId, bundleId)
      .first();

    if (!item) {
      throw new NotFoundError('Bundle item not found');
    }

    await context.env.DB.prepare(
      'DELETE FROM document_bundle_items WHERE id = ?'
    )
      .bind(itemId)
      .run();

    // Update bundle's updated_at
    await context.env.DB.prepare(
      "UPDATE document_bundles SET updated_at = datetime('now') WHERE id = ?"
    )
      .bind(bundleId)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      bundle.tenant_id as string,
      'bundle_item_removed',
      'bundle',
      bundleId,
      JSON.stringify({ item_id: itemId, document_id: item.document_id }),
      getClientIp(context.request)
    );

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Remove bundle item error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
