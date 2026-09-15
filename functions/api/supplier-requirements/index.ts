/**
 * /api/supplier-requirements — WHICH requirements apply to WHICH supplier
 * (migration 0087).
 *
 * This is the applicability half of gap detection. `requirements` (0080) is the
 * tenant's vocabulary of checklist line items and `document_requirements` says
 * which documents CLOSE them; neither says a line item APPLIES to anyone. A gap
 * is the difference between the two:
 *
 *     rows here for supplier S, tier 'required'
 *   MINUS
 *     requirements closed by S's confirmed documents
 *
 * Shape and permissions mirror /api/requirements: same role gate (super_admin |
 * org_admin), same tenant scoping, same audit calls. Detach is a hard DELETE,
 * not a soft-delete — see the migration for why.
 */

import { generateId, logAudit, getClientIp } from '../../lib/db';
import { requireRole, BadRequestError, errorToResponse } from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import {
  resolveWriteTenant,
  isValidSupplierRequirementTier,
} from '../../lib/registry-vocab';
import type { Env, User } from '../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Assert that both ends of an applicability row live in `tenantId`.
 *
 * The FKs cannot do this: supplier_id references suppliers(id) and
 * requirement_id references requirements(id), neither of which carries the
 * tenant into the constraint. Same reason validateFacetIds exists in
 * functions/lib/registry.ts.
 */
async function assertInTenant(
  db: D1Database,
  tenantId: string,
  supplierId: string,
  requirementId: string,
): Promise<void> {
  const supplier = await db
    .prepare('SELECT id FROM suppliers WHERE id = ? AND tenant_id = ?')
    .bind(supplierId, tenantId)
    .first();
  if (!supplier) throw new BadRequestError('Invalid supplier for this tenant');

  const requirement = await db
    .prepare('SELECT id FROM requirements WHERE id = ? AND tenant_id = ?')
    .bind(requirementId, tenantId)
    .first();
  if (!requirement) throw new BadRequestError('Invalid requirement for this tenant');
}

/**
 * GET /api/supplier-requirements
 *
 * ?supplier_id=   list everything one supplier owes (the common call)
 * ?requirement_id= the inverse: which suppliers this line item applies to
 * ?tier=required|recommended  narrow to one tier
 * ?review=unconfirmed  rows from the initial bulk seed (source IS NULL)
 * ?review=flagged      derived rows no longer on the verified list (0112)
 * ?review=any          either — the worklist
 * ?source=human|packet|derived  narrow to one provenance
 * ?tenant_id=     super_admin only
 *
 * Rows carry the requirement's name/slug/checklist joined in, so the supplier
 * view can render a checklist without a second round trip.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);
    const supplierId = url.searchParams.get('supplier_id');
    const requirementId = url.searchParams.get('requirement_id');
    const tier = url.searchParams.get('tier');
    const review = url.searchParams.get('review');
    const source = url.searchParams.get('source');
    const tenantIdParam = url.searchParams.get('tenant_id');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 500);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (user.role === 'super_admin') {
      if (tenantIdParam) {
        conditions.push('sr.tenant_id = ?');
        params.push(tenantIdParam);
      }
    } else {
      conditions.push('sr.tenant_id = ?');
      params.push(user.tenant_id!);
    }

    if (supplierId) {
      conditions.push('sr.supplier_id = ?');
      params.push(supplierId);
    }
    if (requirementId) {
      conditions.push('sr.requirement_id = ?');
      params.push(requirementId);
    }
    if (tier) {
      if (!isValidSupplierRequirementTier(tier)) {
        return json({ error: 'tier must be one of: required, recommended' }, 400);
      }
      conditions.push('sr.tier = ?');
      params.push(tier);
    }

    if (review) {
      if (review === 'unconfirmed') conditions.push('sr.source IS NULL');
      else if (review === 'flagged') conditions.push('sr.review_flag IS NOT NULL');
      else if (review === 'any') conditions.push('(sr.source IS NULL OR sr.review_flag IS NOT NULL)');
      else return json({ error: 'review must be one of: unconfirmed, flagged, any' }, 400);
    }
    if (source) {
      if (!['human', 'packet', 'derived'].includes(source)) {
        return json({ error: 'source must be one of: human, packet, derived' }, 400);
      }
      conditions.push('sr.source = ?');
      params.push(source);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await context.env.DB.prepare(
      `SELECT COUNT(*) as total FROM supplier_requirements sr ${whereClause}`,
    )
      .bind(...params)
      .first<{ total: number }>();

    const results = await context.env.DB.prepare(
      `SELECT sr.*,
              r.name AS requirement_name, r.slug AS requirement_slug,
              r.checklist AS requirement_checklist, r.active AS requirement_active,
              s.name AS supplier_name, s.slug AS supplier_slug
         FROM supplier_requirements sr
         JOIN requirements r ON r.id = sr.requirement_id
         JOIN suppliers s ON s.id = sr.supplier_id
         ${whereClause}
        ORDER BY s.name, r.checklist, r.sort_order, r.name
        LIMIT ? OFFSET ?`,
    )
      .bind(...params, limit, offset)
      .all();

    return json({
      supplierRequirements: results.results,
      total: countResult?.total || 0,
      limit,
      offset,
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List supplier requirements error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

/**
 * POST /api/supplier-requirements
 * Attach a requirement to a supplier. Body: supplier_id, requirement_id,
 * tier?, notes?, tenant_id? (super_admin only).
 *
 * Re-attaching an existing pair is NOT a 409: it updates the tier in place and
 * returns 200. Either way the row is now a person's statement, so it is
 * stamped `source = 'human'` (0102) and any review flag (0112) is cleared —
 * without that, a row a person added through the editor would sit in the
 * "unconfirmed bulk seed" worklist, and a derived row a person re-tiered would
 * be re-tiered back by the next import. Attaching is an idempotent statement of applicability ("this
 * supplier owes this"), and a bulk apply-a-checklist call re-run must converge
 * rather than half-fail.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const body = (await context.request.json()) as {
      supplier_id?: string;
      requirement_id?: string;
      tier?: string;
      notes?: string | null;
      tenant_id?: string;
    };

    if (!body.supplier_id) return json({ error: 'supplier_id is required' }, 400);
    if (!body.requirement_id) return json({ error: 'requirement_id is required' }, 400);

    const tier = body.tier ?? 'required';
    if (!isValidSupplierRequirementTier(tier)) {
      return json({ error: 'tier must be one of: required, recommended' }, 400);
    }

    const tenantId = resolveWriteTenant(user, body.tenant_id);
    await assertInTenant(context.env.DB, tenantId, body.supplier_id, body.requirement_id);

    const notes = body.notes ? sanitizeString(body.notes) : null;

    const existing = await context.env.DB.prepare(
      `SELECT id FROM supplier_requirements
        WHERE tenant_id = ? AND supplier_id = ? AND requirement_id = ?`,
    )
      .bind(tenantId, body.supplier_id, body.requirement_id)
      .first<{ id: string }>();

    if (existing) {
      await context.env.DB.prepare(
        `UPDATE supplier_requirements
            SET tier = ?, notes = COALESCE(?, notes), source = 'human',
                review_flag = NULL, review_flagged_at = NULL,
                updated_at = datetime('now'), updated_by = ?
          WHERE id = ?`,
      )
        .bind(tier, notes, user.id, existing.id)
        .run();

      const row = await context.env.DB.prepare(
        'SELECT * FROM supplier_requirements WHERE id = ?',
      )
        .bind(existing.id)
        .first();

      await logAudit(
        context.env.DB,
        user.id,
        tenantId,
        'supplier_requirement_updated',
        'supplier_requirement',
        existing.id,
        JSON.stringify({ tier }),
        getClientIp(context.request),
      );

      return json({ supplierRequirement: row });
    }

    const id = generateId();
    await context.env.DB.prepare(
      `INSERT INTO supplier_requirements
         (id, tenant_id, supplier_id, requirement_id, tier, notes, source, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, 'human', ?, ?)`,
    )
      .bind(id, tenantId, body.supplier_id, body.requirement_id, tier, notes, user.id, user.id)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'supplier_requirement_created',
      'supplier_requirement',
      id,
      JSON.stringify({
        supplier_id: body.supplier_id,
        requirement_id: body.requirement_id,
        tier,
      }),
      getClientIp(context.request),
    );

    const created = await context.env.DB.prepare(
      'SELECT * FROM supplier_requirements WHERE id = ?',
    )
      .bind(id)
      .first();

    return json({ supplierRequirement: created }, 201);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Create supplier requirement error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
