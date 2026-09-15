/**
 * Extend, re-date or remove one required analyte (migration 0109). See
 * `spec-required-analytes/index.ts`.
 *
 * Only the watch dates and the reason are editable. Changing WHICH analyte or
 * WHICH supplier is a different requirement: remove this one and add that one,
 * so the audit trail says two things happened rather than one row quietly
 * becoming another.
 */

import { logAudit, getClientIp } from '../../lib/db';
import { requireRole, requireTenantAccess, NotFoundError, errorToResponse } from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import { json, readDay, dayOrderError, type RequiredAnalyteBody } from './index';
import type { Env, User } from '../../lib/types';

async function load(db: D1Database, id: string): Promise<Record<string, unknown>> {
  const row = (await db.prepare('SELECT * FROM supplier_required_analytes WHERE id = ?').bind(id).first()) as Record<
    string,
    unknown
  > | null;
  if (!row) throw new NotFoundError('Required analyte not found');
  return row;
}

export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const row = await load(context.env.DB, context.params.id as string);
    requireTenantAccess(user, row.tenant_id as string);

    const body = (await context.request.json()) as RequiredAnalyteBody;
    for (const field of ['supplier_id', 'document_type_id', 'spec_test_id'] as const) {
      if (body[field] !== undefined && body[field] !== row[field]) {
        return json(
          { error: `${field} cannot be changed — remove this requirement and add a new one` },
          400
        );
      }
    }

    const from = readDay(body.effective_from, 'effective_from');
    if (from && 'error' in from) return json({ error: from.error }, 400);
    const review = readDay(body.review_by, 'review_by');
    if (review && 'error' in review) return json({ error: review.error }, 400);

    const effectiveFrom = from ? from.value : ((row.effective_from as string | null) ?? null);
    const reviewBy = review ? review.value : ((row.review_by as string | null) ?? null);
    const orderError = dayOrderError(effectiveFrom, reviewBy);
    if (orderError) return json({ error: orderError }, 400);

    const updates: string[] = [];
    const params: (string | null)[] = [];
    if (from) {
      updates.push('effective_from = ?');
      params.push(effectiveFrom);
    }
    if (review) {
      updates.push('review_by = ?');
      params.push(reviewBy);
    }
    if (body.reason !== undefined) {
      updates.push('reason = ?');
      params.push(body.reason ? sanitizeString(body.reason) : null);
    }
    if (updates.length === 0) return json({ error: 'No fields to update' }, 400);
    updates.push("updated_at = datetime('now')", 'updated_by = ?');
    params.push(user.id);

    await context.env.DB.prepare(`UPDATE supplier_required_analytes SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...params, row.id as string)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      row.tenant_id as string,
      'spec_required_analyte.updated',
      'supplier_required_analytes',
      row.id as string,
      JSON.stringify({
        before: { effective_from: row.effective_from, review_by: row.review_by, reason: row.reason },
        after: {
          effective_from: effectiveFrom,
          review_by: reviewBy,
          reason: body.reason !== undefined ? body.reason : row.reason,
        },
      }),
      getClientIp(context.request)
    );

    const updated = await context.env.DB.prepare('SELECT * FROM supplier_required_analytes WHERE id = ?')
      .bind(row.id as string)
      .first();
    return json({ requiredAnalyte: updated });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update required analyte error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const row = await load(context.env.DB, context.params.id as string);
    requireTenantAccess(user, row.tenant_id as string);

    await context.env.DB.prepare('DELETE FROM supplier_required_analytes WHERE id = ?').bind(row.id as string).run();

    await logAudit(
      context.env.DB,
      user.id,
      row.tenant_id as string,
      'spec_required_analyte.deleted',
      'supplier_required_analytes',
      row.id as string,
      JSON.stringify({
        supplier_id: row.supplier_id,
        document_type_id: row.document_type_id,
        spec_test_id: row.spec_test_id,
        review_by: row.review_by,
        reason: row.reason,
      }),
      getClientIp(context.request)
    );
    return json({ success: true });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Delete required analyte error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
