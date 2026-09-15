/**
 * PUT    /api/product-identifiers/:id — confirm, mark former, or edit the note.
 * DELETE /api/product-identifiers/:id — remove. The audit row carries the whole
 *                                        row, since nothing else keeps it.
 *
 * org_admin / super_admin, own tenant. The value, kind and supplier of an
 * identifier are its identity and are not editable: a wrong number is removed
 * and the right one added, so the audit log shows both.
 */

import { getClientIp, logAudit } from '../../lib/db';
import {
  BadRequestError,
  NotFoundError,
  errorToResponse,
  requireRole,
  requireTenantAccess,
} from '../../lib/permissions';
import type { ProductIdentifier } from '../../../shared/types';
import type { Env, User } from '../../lib/types';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function loadIdentifier(db: D1Database, user: User, id: string): Promise<ProductIdentifier> {
  const row = await db.prepare('SELECT * FROM product_identifiers WHERE id = ?').bind(id).first<ProductIdentifier>();
  if (!row || (user.role !== 'super_admin' && row.tenant_id !== user.tenant_id)) throw new NotFoundError('Identifier not found');
  requireTenantAccess(user, row.tenant_id);
  return row;
}

export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const row = await loadIdentifier(context.env.DB, user, context.params.id as string);
    const body = (await context.request.json().catch(() => ({}))) as { confirmed?: boolean; superseded?: boolean; note?: string | null };

    const sets: string[] = [];
    const binds: Array<string | number | null> = [];
    const changes: Record<string, unknown> = {};
    if (body.confirmed !== undefined) {
      if (typeof body.confirmed !== 'boolean') throw new BadRequestError('confirmed must be true or false');
      sets.push('confirmed = ?', 'confirmed_by = ?', "confirmed_at = CASE WHEN ? = 1 THEN datetime('now') END");
      binds.push(body.confirmed ? 1 : 0, body.confirmed ? user.id : null, body.confirmed ? 1 : 0);
      changes.confirmed = body.confirmed;
    }
    if (body.superseded !== undefined) {
      if (typeof body.superseded !== 'boolean') throw new BadRequestError('superseded must be true or false');
      if (body.superseded && row.kind !== 'supplier_item' && row.kind !== 'our_sku') {
        throw new BadRequestError('only an item number or our SKU can be marked former');
      }
      sets.push('superseded = ?');
      binds.push(body.superseded ? 1 : 0);
      changes.superseded = body.superseded;
    }
    if (body.note !== undefined) {
      const note = body.note ? String(body.note).trim().slice(0, 1000) || null : null;
      sets.push('note = ?');
      binds.push(note);
      changes.note = note;
    }
    if (sets.length === 0) throw new BadRequestError('nothing to change');
    sets.push("updated_at = datetime('now')");
    await context.env.DB.prepare(`UPDATE product_identifiers SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, row.id).run();

    const action = changes.confirmed === true && Object.keys(changes).length === 1 ? 'product_identifier.confirmed' : 'product_identifier.updated';
    await logAudit(
      context.env.DB, user.id, row.tenant_id, action, 'product', row.product_id,
      JSON.stringify({ identifier_id: row.id, kind: row.kind, value: row.value, before: { confirmed: row.confirmed, superseded: row.superseded, note: row.note }, changes }),
      getClientIp(context.request),
    );
    const updated = await context.env.DB
      .prepare('SELECT pi.*, s.name AS supplier_name FROM product_identifiers pi LEFT JOIN suppliers s ON s.id = pi.supplier_id WHERE pi.id = ?')
      .bind(row.id)
      .first<ProductIdentifier>();
    return json({ identifier: updated });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update product identifier error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const row = await loadIdentifier(context.env.DB, user, context.params.id as string);
    await context.env.DB.prepare('DELETE FROM product_identifiers WHERE id = ?').bind(row.id).run();
    await logAudit(
      context.env.DB, user.id, row.tenant_id, 'product_identifier.removed', 'product', row.product_id,
      JSON.stringify({ identifier: row }),
      getClientIp(context.request),
    );
    return json({ success: true });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Remove product identifier error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
