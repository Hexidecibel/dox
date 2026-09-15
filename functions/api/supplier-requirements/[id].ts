/**
 * /api/supplier-requirements/:id — read / change tier / detach one
 * applicability row (migration 0087).
 *
 * Mirrors /api/requirements/:id, with ONE deliberate difference: DELETE here is
 * a hard delete, not a soft-delete. A requirement soft-deletes because
 * document_requirements rows point at it and history must keep resolving; an
 * applicability row is pure configuration that nothing references, so a
 * tombstone would only be another state the gap query has to exclude.
 */

import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import { isValidSupplierRequirementTier } from '../../lib/registry-vocab';
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
    const id = context.params.id as string;

    const row = await context.env.DB.prepare(
      `SELECT sr.*,
              r.name AS requirement_name, r.slug AS requirement_slug,
              r.checklist AS requirement_checklist,
              s.name AS supplier_name, s.slug AS supplier_slug
         FROM supplier_requirements sr
         JOIN requirements r ON r.id = sr.requirement_id
         JOIN suppliers s ON s.id = sr.supplier_id
        WHERE sr.id = ?`,
    )
      .bind(id)
      .first();
    if (!row) throw new NotFoundError('Supplier requirement not found');

    requireTenantAccess(user, row.tenant_id as string);

    return json({ supplierRequirement: row });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Get supplier requirement error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

/**
 * PUT /api/supplier-requirements/:id
 * Fields: tier, notes. The (supplier, requirement) pair is the row's identity —
 * repointing it would be a detach plus an attach, so it is not editable here.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const id = context.params.id as string;
    requireRole(user, 'super_admin', 'org_admin');

    const row = await context.env.DB.prepare(
      'SELECT * FROM supplier_requirements WHERE id = ?',
    )
      .bind(id)
      .first();
    if (!row) throw new NotFoundError('Supplier requirement not found');

    requireTenantAccess(user, row.tenant_id as string);

    const body = (await context.request.json()) as {
      tier?: string;
      notes?: string | null;
    };

    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (body.tier !== undefined) {
      if (!isValidSupplierRequirementTier(body.tier)) {
        return json({ error: 'tier must be one of: required, recommended' }, 400);
      }
      updates.push('tier = ?');
      params.push(body.tier);
      // A tier is a decision. Whatever produced the row (the bulk seed, a
      // packet, the verified list), a person has now chosen its tier, so it is
      // theirs: an import will not re-tier it and the worklist drops it.
      updates.push("source = 'human'", 'review_flag = NULL', 'review_flagged_at = NULL');
    }

    if (body.notes !== undefined) {
      updates.push('notes = ?');
      params.push(body.notes ? sanitizeString(body.notes) : null);
    }

    if (updates.length === 0) return json({ error: 'No fields to update' }, 400);

    updates.push("updated_at = datetime('now')");
    updates.push('updated_by = ?');
    params.push(user.id);
    params.push(id);

    await context.env.DB.prepare(
      `UPDATE supplier_requirements SET ${updates.join(', ')} WHERE id = ?`,
    )
      .bind(...params)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      row.tenant_id as string,
      'supplier_requirement_updated',
      'supplier_requirement',
      id,
      JSON.stringify({ changes: body }),
      getClientIp(context.request),
    );

    const updated = await context.env.DB.prepare(
      'SELECT * FROM supplier_requirements WHERE id = ?',
    )
      .bind(id)
      .first();

    return json({ supplierRequirement: updated });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update supplier requirement error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

/** DELETE /api/supplier-requirements/:id — detach. Hard delete, see header. */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const id = context.params.id as string;
    requireRole(user, 'super_admin', 'org_admin');

    const row = await context.env.DB.prepare(
      'SELECT * FROM supplier_requirements WHERE id = ?',
    )
      .bind(id)
      .first();
    if (!row) throw new NotFoundError('Supplier requirement not found');

    requireTenantAccess(user, row.tenant_id as string);

    await context.env.DB.prepare('DELETE FROM supplier_requirements WHERE id = ?')
      .bind(id)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      row.tenant_id as string,
      'supplier_requirement_deleted',
      'supplier_requirement',
      id,
      JSON.stringify({
        supplier_id: row.supplier_id,
        requirement_id: row.requirement_id,
        tier: row.tier,
      }),
      getClientIp(context.request),
    );

    return json({ success: true });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Delete supplier requirement error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
