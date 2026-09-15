/**
 * Acceptance limits — OUR thresholds for a COA test result, as opposed to the
 * one the supplier prints on the document.
 *
 * SCOPE. `supplier_id`, `document_type_id` and `product_id` are all optional and
 * NULL means "any". The read path scores every applicable row and the most
 * specific one wins (see `resolveSpecLimits`). A single row with all three NULL
 * is a tenant-wide default, which is what lets a tenant get value on day one
 * before any supplier is configured.
 *
 * Product scoping is accepted here and stored, but the review queue cannot yet
 * resolve a document's products at review time, so a product-scoped limit will
 * not fire there. The admin UI therefore does not offer it yet — better to omit
 * the option than to store a limit that quietly never runs.
 *
 * NOTHING HERE BLOCKS AN APPROVAL. These rows produce advisory warnings.
 */

import { generateId, logAudit, getClientIp } from '../../lib/db';
import { requireRole, errorToResponse } from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import { validateLimitShape } from '../../../shared/specCheck';
import {
  DEFAULT_SPEC_CRITICALITY,
  SPEC_CRITICALITY_VALUES,
  isSpecCriticality,
} from '../../../shared/specCriticality';
import type { SpecCriticality } from '../../../shared/specCriticality';
import type { Env, User } from '../../lib/types';

export interface LimitBody {
  spec_test_id?: string;
  supplier_id?: string | null;
  document_type_id?: string | null;
  product_id?: string | null;
  operator?: string;
  value_min?: number | null;
  value_max?: number | null;
  unit?: string | null;
  severity?: string;
  /** Presentation rank (migration 0095). Absent means "leave it on the default". */
  criticality?: string;
  notes?: string | null;
  active?: boolean | number;
  tenant_id?: string;
  /** Watch review-by date, YYYY-MM-DD (migration 0107). Supplier-scoped limits only. */
  review_by?: string | null;
}

/**
 * Read a review-by date off a body (migration 0107), or say why it cannot be.
 *
 * A review-by belongs to a SUPPLIER WATCH — a supplier-scoped limit tighter
 * than the company default for a period — so it is refused on a limit with no
 * supplier: a tenant-wide limit has no "company default" to return to, and a
 * date on it would put "watch period ended" on every certificate from every
 * supplier. Passing the date never loosens the limit (see shared/specCheck.ts
 * `watchStatus`); it only asks a person to extend or remove it.
 *
 * `undefined` = not submitted; `null` / '' = clear it.
 */
export function readReviewBy(
  value: unknown,
  resultingSupplierId: string | null | undefined
): { review_by: string | null } | { error: string } | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return { review_by: null };
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
    return { error: 'review_by must be a date in YYYY-MM-DD form' };
  }
  if (!resultingSupplierId) {
    return { error: 'review_by applies to a supplier-specific (watch) limit — choose a supplier first' };
  }
  return { review_by: s };
}

const SEVERITIES = new Set(['warn', 'alert']);

/**
 * Read the criticality off a body, or say why it cannot be.
 *
 * A submitted-but-unrecognised tier is a 400, NOT a silent fall back to the
 * default the way `severity` behaves. The two are not the same risk: severity
 * has always defaulted to the louder value ('alert'), while quietly defaulting
 * a typo'd criticality would DEMOTE a limit somebody deliberately marked as
 * load-stopping, and nothing in the UI would ever show that it had happened.
 *
 * Returns the default when the field is absent — a client that knows nothing
 * about ranking must keep working unchanged.
 */
export function readCriticality(
  value: string | undefined
): { criticality: SpecCriticality } | { error: string } {
  if (value === undefined) return { criticality: DEFAULT_SPEC_CRITICALITY };
  if (isSpecCriticality(value)) return { criticality: value };
  return { error: `criticality must be one of ${SPEC_CRITICALITY_VALUES.join(', ')}` };
}

export function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Coerce a numeric body field, treating '' and null alike as "absent". */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Every scope id must belong to the same tenant as the limit. Without this a
 * limit could be pinned to another tenant's supplier and would then never
 * resolve — a silently dead limit, which is the one outcome this feature must
 * not produce.
 */
export async function validateScope(
  db: D1Database,
  tenantId: string,
  body: LimitBody
): Promise<string | null> {
  const checks: Array<[string, string | null | undefined, string]> = [
    ['suppliers', body.supplier_id, 'supplier_id'],
    ['document_types', body.document_type_id, 'document_type_id'],
    ['products', body.product_id, 'product_id'],
  ];
  for (const [table, id, field] of checks) {
    if (!id) continue;
    const row = await db
      .prepare(`SELECT id FROM ${table} WHERE id = ? AND tenant_id = ?`)
      .bind(id, tenantId)
      .first();
    if (!row) return `${field} does not reference a record in this tenant`;
  }
  return null;
}

/**
 * Is there already a limit for this analyte at this exact scope?
 *
 * Migration 0086 makes (tenant, analyte, supplier, doctype, product) unique,
 * with the three nullable scope columns COALESCEd to '' in the index — SQLite
 * treats NULLs as distinct, so without that fold the commonest row of all (the
 * tenant-wide default, every scope column NULL) would be exempt from the
 * constraint. The same fold is applied here so the lookup and the index agree.
 *
 * The check exists so a duplicate arrives as a sentence rather than as the 500
 * a raw constraint violation would produce. Two limits at one scope are not a
 * harmless duplicate: `resolveSpecLimits` would pick one of them by updated_at
 * and the other would sit in the admin list looking active while judging
 * nothing.
 *
 * @returns the conflicting limit's id, or null.
 */
export async function findScopeConflict(
  db: D1Database,
  tenantId: string,
  specTestId: string,
  scope: { supplier_id?: string | null; document_type_id?: string | null; product_id?: string | null },
  excludeId?: string
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT id FROM spec_limits
        WHERE tenant_id = ?
          AND spec_test_id = ?
          AND COALESCE(supplier_id, '') = ?
          AND COALESCE(document_type_id, '') = ?
          AND COALESCE(product_id, '') = ?
          AND id != ?`
    )
    .bind(
      tenantId,
      specTestId,
      scope.supplier_id || '',
      scope.document_type_id || '',
      scope.product_id || '',
      excludeId || ''
    )
    .first<{ id: string }>();
  return row ? row.id : null;
}

export function scopeConflictResponse(existingId: string): Response {
  return new Response(
    JSON.stringify({
      error: 'A limit for that analyte already exists at that scope — edit it instead.',
      existing_id: existingId,
    }),
    { status: 409, headers: { 'Content-Type': 'application/json' } }
  );
}

/** GET /api/spec-limits — list, joined to the analyte and the scope names. */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);
    const tenantIdParam = url.searchParams.get('tenant_id');
    const specTestId = url.searchParams.get('spec_test_id');

    const conditions: string[] = [];
    const params: string[] = [];

    if (user.role === 'super_admin') {
      if (tenantIdParam) {
        conditions.push('sl.tenant_id = ?');
        params.push(tenantIdParam);
      }
    } else {
      conditions.push('sl.tenant_id = ?');
      params.push(user.tenant_id!);
    }
    if (specTestId) {
      conditions.push('sl.spec_test_id = ?');
      params.push(specTestId);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const results = await context.env.DB.prepare(
      `SELECT sl.*,
              st.name AS test_name,
              st.default_unit AS test_default_unit,
              s.name  AS supplier_name,
              dt.name AS document_type_name,
              p.name  AS product_name
         FROM spec_limits sl
         JOIN spec_tests st ON st.id = sl.spec_test_id
    LEFT JOIN suppliers s ON s.id = sl.supplier_id
    LEFT JOIN document_types dt ON dt.id = sl.document_type_id
    LEFT JOIN products p ON p.id = sl.product_id
         ${where}
        ORDER BY st.name ASC, sl.created_at DESC`
    )
      .bind(...params)
      .all();

    return new Response(JSON.stringify({ specLimits: results.results ?? [] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List spec limits error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/** POST /api/spec-limits — create a limit. org_admin+. */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const body = (await context.request.json()) as LimitBody;

    let tenantId: string;
    if (user.role === 'super_admin') {
      if (!body.tenant_id) return badRequest('tenant_id is required for super_admin');
      tenantId = body.tenant_id;
    } else {
      tenantId = user.tenant_id!;
    }

    if (!body.spec_test_id) return badRequest('spec_test_id is required');
    const specTest = await context.env.DB.prepare(
      'SELECT id FROM spec_tests WHERE id = ? AND tenant_id = ?'
    )
      .bind(body.spec_test_id, tenantId)
      .first();
    if (!specTest) return badRequest('spec_test_id does not reference an analyte in this tenant');

    const operator = String(body.operator || '');
    const valueMin = num(body.value_min);
    const valueMax = num(body.value_max);
    const shapeError = validateLimitShape({ operator, value_min: valueMin, value_max: valueMax });
    if (shapeError) return badRequest(shapeError);

    const severity = body.severity && SEVERITIES.has(body.severity) ? body.severity : 'alert';

    const criticality = readCriticality(body.criticality);
    if ('error' in criticality) return badRequest(criticality.error);

    const reviewBy = readReviewBy(body.review_by, body.supplier_id);
    if (reviewBy && 'error' in reviewBy) return badRequest(reviewBy.error);

    const scopeError = await validateScope(context.env.DB, tenantId, body);
    if (scopeError) return badRequest(scopeError);

    const conflict = await findScopeConflict(context.env.DB, tenantId, body.spec_test_id, body);
    if (conflict) return scopeConflictResponse(conflict);

    const id = generateId();
    await context.env.DB.prepare(
      `INSERT INTO spec_limits
         (id, tenant_id, spec_test_id, supplier_id, document_type_id, product_id,
          operator, value_min, value_max, unit, severity, criticality, notes, active, updated_by,
          review_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        tenantId,
        body.spec_test_id,
        body.supplier_id || null,
        body.document_type_id || null,
        body.product_id || null,
        operator,
        valueMin,
        valueMax,
        body.unit ? sanitizeString(body.unit) : null,
        severity,
        criticality.criticality,
        body.notes ? sanitizeString(body.notes) : null,
        body.active === false || body.active === 0 ? 0 : 1,
        user.id,
        reviewBy && 'review_by' in reviewBy ? reviewBy.review_by : null
      )
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'spec_limit.created',
      'spec_limits',
      id,
      JSON.stringify({
        spec_test_id: body.spec_test_id,
        operator,
        valueMin,
        valueMax,
        unit: body.unit,
        criticality: criticality.criticality,
        supplier_id: body.supplier_id || null,
        review_by: reviewBy && 'review_by' in reviewBy ? reviewBy.review_by : null,
      }),
      getClientIp(context.request)
    );

    const created = await context.env.DB.prepare('SELECT * FROM spec_limits WHERE id = ?')
      .bind(id)
      .first();

    return new Response(JSON.stringify({ specLimit: created }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Create spec limit error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
