/**
 * /api/claim-types — layer-3 vocabulary CRUD (migration 0080).
 *
 * A claim type is something a document ASSERTS ("Organic", "Kosher",
 * "SQF Certified"). Asserting it satisfies nothing; it makes a DIFFERENT
 * document applicable — which requirement(s) it opens is configured through
 * /api/claim-rules.
 *
 * Same role gate and tenant scoping as /api/document-types.
 */

import { generateId, logAudit, getClientIp } from '../../lib/db';
import { requireRole, errorToResponse } from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import { isValidClaimSubjectGrain, CLAIM_SUBJECT_GRAINS } from '../../lib/registry';
import { slugifyVocab, resolveWriteTenant } from '../../lib/registry-vocab';
import type { Env, User } from '../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * GET /api/claim-types
 * ?tenant_id= (super_admin), ?active=0|1 (default active only).
 *
 * `requirement_count` is the number of requirements this claim opens. Zero
 * means the claim is DETECTABLE BUT INERT — nothing becomes missing when a
 * document asserts it. The admin UI surfaces that as the thing to fix, since
 * it is exactly what blocks gap detection.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);
    const activeFilter = url.searchParams.get('active');
    const tenantIdParam = url.searchParams.get('tenant_id');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 500);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (user.role === 'super_admin') {
      if (tenantIdParam) {
        conditions.push('ct.tenant_id = ?');
        params.push(tenantIdParam);
      }
    } else {
      conditions.push('ct.tenant_id = ?');
      params.push(user.tenant_id!);
    }

    if (activeFilter !== null) {
      conditions.push('ct.active = ?');
      params.push(Number(activeFilter));
    } else {
      conditions.push('ct.active = 1');
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await context.env.DB.prepare(
      `SELECT COUNT(*) as total FROM claim_types ct ${whereClause}`,
    )
      .bind(...params)
      .first<{ total: number }>();

    const results = await context.env.DB.prepare(
      `SELECT ct.*, t.name AS tenant_name,
              (SELECT COUNT(*) FROM claim_type_requirements ctr
                WHERE ctr.claim_type_id = ct.id) AS requirement_count,
              (SELECT COUNT(*) FROM document_claims dc
                WHERE dc.claim_type_id = ct.id AND dc.status = 'confirmed') AS document_count
         FROM claim_types ct
         LEFT JOIN tenants t ON t.id = ct.tenant_id
         ${whereClause}
        ORDER BY ct.sort_order, ct.name
        LIMIT ? OFFSET ?`,
    )
      .bind(...params, limit, offset)
      .all();

    return json({
      claimTypes: results.results,
      total: countResult?.total || 0,
      limit,
      offset,
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List claim types error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

/**
 * POST /api/claim-types
 * Fields: name (required), slug, description, subject_grain, sort_order,
 * tenant_id (super_admin only).
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const body = (await context.request.json()) as {
      name?: string;
      slug?: string;
      description?: string;
      subject_grain?: string;
      sort_order?: number;
      tenant_id?: string;
    };

    if (!body.name || !body.name.trim()) {
      return json({ error: 'name is required' }, 400);
    }

    const tenantId = resolveWriteTenant(user, body.tenant_id);

    const subjectGrain = body.subject_grain || 'any';
    if (!isValidClaimSubjectGrain(subjectGrain)) {
      return json(
        { error: `subject_grain must be one of ${CLAIM_SUBJECT_GRAINS.join(', ')}` },
        400,
      );
    }

    const name = sanitizeString(body.name);
    const description = body.description ? sanitizeString(body.description) : null;
    const slug = slugifyVocab(body.slug || name);
    if (!slug) return json({ error: 'Could not generate a valid slug from name' }, 400);

    const existing = await context.env.DB.prepare(
      'SELECT id FROM claim_types WHERE slug = ? AND tenant_id = ?',
    )
      .bind(slug, tenantId)
      .first();
    if (existing) {
      return json({ error: 'A claim type with this slug already exists for this tenant' }, 409);
    }

    const id = generateId();
    const sortOrder = Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 0;

    await context.env.DB.prepare(
      `INSERT INTO claim_types (id, tenant_id, slug, name, description, subject_grain, sort_order, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    )
      .bind(id, tenantId, slug, name, description, subjectGrain, sortOrder)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'claim_type_created',
      'claim_type',
      id,
      JSON.stringify({ name, slug, subject_grain: subjectGrain }),
      getClientIp(context.request),
    );

    const claimType = await context.env.DB.prepare('SELECT * FROM claim_types WHERE id = ?')
      .bind(id)
      .first();

    return json({ claimType }, 201);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Create claim type error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
