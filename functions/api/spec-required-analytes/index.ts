/**
 * Required analytes per supplier — what a supplier's certificates MUST report
 * (migration 0107).
 *
 * SME ruling (AJ Conner, 2026-09-14): whatever a supplier's COA reports counts
 * as complete by default. The customer can configure ADDITIONAL REQUIRED
 * ANALYTES per supplier, and only that configuration can make a COA incomplete.
 * Together with supplier-scoped spec limits this is the "supplier on watch"
 * mechanism: tighter thresholds and extra analytes for a watch period, then back
 * to company defaults. `review_by` is the reminder that the period is up — it
 * never switches the requirement off (see `watchStatus` in shared/specCheck.ts).
 *
 * Scope is (supplier, document type, analyte), all required. See the migration
 * for why "any document type" is not offered here although spec_limits has it.
 *
 * NOTHING HERE BLOCKS AN APPROVAL. A missing analyte is a finding.
 */

import { generateId, logAudit, getClientIp } from '../../lib/db';
import { requireRole, errorToResponse } from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import type { Env, User } from '../../lib/types';

export interface RequiredAnalyteBody {
  tenant_id?: string;
  supplier_id?: string;
  document_type_id?: string;
  spec_test_id?: string;
  effective_from?: string | null;
  review_by?: string | null;
  reason?: string | null;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * A YYYY-MM-DD date field. `undefined` = not submitted; null / '' = clear.
 */
export function readDay(
  value: unknown,
  field: string
): { value: string | null } | { error: string } | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return { value: null };
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
    return { error: `${field} must be a date in YYYY-MM-DD form` };
  }
  return { value: s };
}

/** review_by before effective_from is a watch that ends before it starts. */
export function dayOrderError(effectiveFrom: string | null, reviewBy: string | null): string | null {
  if (effectiveFrom && reviewBy && reviewBy < effectiveFrom) {
    return 'review_by cannot be earlier than effective_from';
  }
  return null;
}

/**
 * Every referenced row must belong to this tenant. Without this a requirement
 * could point at another tenant's supplier and never apply — a silently dead
 * rule, which is the one outcome configuration must not produce.
 */
async function validateRefs(db: D1Database, tenantId: string, body: RequiredAnalyteBody): Promise<string | null> {
  const checks: Array<[string, string | undefined, string]> = [
    ['suppliers', body.supplier_id, 'supplier_id'],
    ['document_types', body.document_type_id, 'document_type_id'],
    ['spec_tests', body.spec_test_id, 'spec_test_id'],
  ];
  for (const [table, id, field] of checks) {
    if (!id) return `${field} is required`;
    const row = await db.prepare(`SELECT id FROM ${table} WHERE id = ? AND tenant_id = ?`).bind(id, tenantId).first();
    if (!row) return `${field} does not reference a record in this tenant`;
  }
  return null;
}

/**
 * GET /api/spec-required-analytes — list, joined to names. Any tenant user may
 * read (the Review Queue and a supplier page show them); writes are admin.
 * Query: supplier_id, tenant_id (super_admin).
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);
    const conditions: string[] = [];
    const params: string[] = [];
    if (user.role === 'super_admin') {
      const t = url.searchParams.get('tenant_id');
      if (t) {
        conditions.push('ra.tenant_id = ?');
        params.push(t);
      }
    } else {
      conditions.push('ra.tenant_id = ?');
      params.push(user.tenant_id!);
    }
    const supplierId = url.searchParams.get('supplier_id');
    if (supplierId) {
      conditions.push('ra.supplier_id = ?');
      params.push(supplierId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const results = await context.env.DB.prepare(
      `SELECT ra.*,
              st.name AS test_name,
              s.name AS supplier_name,
              dt.name AS document_type_name,
              u.name AS created_by_name
         FROM supplier_required_analytes ra
         JOIN spec_tests st ON st.id = ra.spec_test_id
    LEFT JOIN suppliers s ON s.id = ra.supplier_id
    LEFT JOIN document_types dt ON dt.id = ra.document_type_id
    LEFT JOIN users u ON u.id = ra.created_by
         ${where}
        ORDER BY s.name ASC, st.name ASC`
    )
      .bind(...params)
      .all();
    return json({ requiredAnalytes: results.results ?? [] });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List required analytes error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

/** POST /api/spec-required-analytes — add one. org_admin+. */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const body = (await context.request.json()) as RequiredAnalyteBody;

    let tenantId: string;
    if (user.role === 'super_admin') {
      if (!body.tenant_id) return json({ error: 'tenant_id is required for super_admin' }, 400);
      tenantId = body.tenant_id;
    } else {
      tenantId = user.tenant_id!;
    }

    const refError = await validateRefs(context.env.DB, tenantId, body);
    if (refError) return json({ error: refError }, 400);

    const from = readDay(body.effective_from, 'effective_from');
    if (from && 'error' in from) return json({ error: from.error }, 400);
    const review = readDay(body.review_by, 'review_by');
    if (review && 'error' in review) return json({ error: review.error }, 400);
    const effectiveFrom = from ? from.value : null;
    const reviewBy = review ? review.value : null;
    const orderError = dayOrderError(effectiveFrom, reviewBy);
    if (orderError) return json({ error: orderError }, 400);

    const existing = await context.env.DB.prepare(
      `SELECT id FROM supplier_required_analytes
        WHERE tenant_id = ? AND supplier_id = ? AND document_type_id = ? AND spec_test_id = ?`
    )
      .bind(tenantId, body.supplier_id, body.document_type_id, body.spec_test_id)
      .first<{ id: string }>();
    if (existing) {
      return json(
        {
          error: 'That analyte is already required for this supplier and document type — edit it instead.',
          existing_id: existing.id,
        },
        409
      );
    }

    const id = generateId();
    const reason = body.reason ? sanitizeString(body.reason) : null;
    await context.env.DB.prepare(
      `INSERT INTO supplier_required_analytes
         (id, tenant_id, supplier_id, document_type_id, spec_test_id,
          effective_from, review_by, reason, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        tenantId,
        body.supplier_id,
        body.document_type_id,
        body.spec_test_id,
        effectiveFrom,
        reviewBy,
        reason,
        user.id,
        user.id
      )
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'spec_required_analyte.created',
      'supplier_required_analytes',
      id,
      JSON.stringify({
        supplier_id: body.supplier_id,
        document_type_id: body.document_type_id,
        spec_test_id: body.spec_test_id,
        effective_from: effectiveFrom,
        review_by: reviewBy,
        reason,
      }),
      getClientIp(context.request)
    );

    const created = await context.env.DB.prepare('SELECT * FROM supplier_required_analytes WHERE id = ?')
      .bind(id)
      .first();
    return json({ requiredAnalyte: created }, 201);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Create required analyte error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
