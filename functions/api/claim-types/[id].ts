/**
 * /api/claim-types/:id — read / update / soft-delete one claim type.
 *
 * GET returns the claim type WITH the requirements it opens joined in, so the
 * mapping editor can load a claim and its rules in one round trip.
 */

import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import { isValidClaimSubjectGrain, CLAIM_SUBJECT_GRAINS } from '../../lib/registry';
import { slugifyVocab, listClaimTypeRequirements } from '../../lib/registry-vocab';
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

    const claimType = await context.env.DB.prepare('SELECT * FROM claim_types WHERE id = ?')
      .bind(id)
      .first();
    if (!claimType) throw new NotFoundError('Claim type not found');

    requireTenantAccess(user, claimType.tenant_id as string);

    const rules = await listClaimTypeRequirements(
      context.env.DB,
      claimType.tenant_id as string,
      id,
    );

    return json({ claimType, rules });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Get claim type error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

/**
 * PUT /api/claim-types/:id
 * Fields: name, slug, description, subject_grain, sort_order, active.
 * As with requirements, renaming does not silently re-slug.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const id = context.params.id as string;
    requireRole(user, 'super_admin', 'org_admin');

    const claimType = await context.env.DB.prepare('SELECT * FROM claim_types WHERE id = ?')
      .bind(id)
      .first();
    if (!claimType) throw new NotFoundError('Claim type not found');

    requireTenantAccess(user, claimType.tenant_id as string);

    const body = (await context.request.json()) as {
      name?: string;
      slug?: string;
      description?: string | null;
      subject_grain?: string;
      sort_order?: number;
      active?: number | boolean;
    };

    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (body.name !== undefined) {
      const name = sanitizeString(body.name);
      if (!name) return json({ error: 'name cannot be empty' }, 400);
      updates.push('name = ?');
      params.push(name);
    }

    if (body.slug !== undefined) {
      const slug = slugifyVocab(body.slug);
      if (!slug) return json({ error: 'Could not generate a valid slug' }, 400);
      const existing = await context.env.DB.prepare(
        'SELECT id FROM claim_types WHERE slug = ? AND tenant_id = ? AND id != ?',
      )
        .bind(slug, claimType.tenant_id, id)
        .first();
      if (existing) {
        return json({ error: 'A claim type with this slug already exists for this tenant' }, 409);
      }
      updates.push('slug = ?');
      params.push(slug);
    }

    if (body.description !== undefined) {
      updates.push('description = ?');
      params.push(body.description ? sanitizeString(body.description) : null);
    }

    if (body.subject_grain !== undefined) {
      if (!isValidClaimSubjectGrain(body.subject_grain)) {
        return json(
          { error: `subject_grain must be one of ${CLAIM_SUBJECT_GRAINS.join(', ')}` },
          400,
        );
      }
      updates.push('subject_grain = ?');
      params.push(body.subject_grain);
    }

    if (body.sort_order !== undefined) {
      const sortOrder = Number(body.sort_order);
      if (!Number.isFinite(sortOrder)) return json({ error: 'sort_order must be a number' }, 400);
      updates.push('sort_order = ?');
      params.push(sortOrder);
    }

    if (body.active !== undefined) {
      const active = typeof body.active === 'boolean' ? (body.active ? 1 : 0) : body.active;
      if (active !== 0 && active !== 1) return json({ error: 'active must be 0 or 1' }, 400);
      updates.push('active = ?');
      params.push(active);
    }

    if (updates.length === 0) return json({ error: 'No fields to update' }, 400);

    updates.push("updated_at = datetime('now')");
    params.push(id);

    await context.env.DB.prepare(`UPDATE claim_types SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...params)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      claimType.tenant_id as string,
      'claim_type_updated',
      'claim_type',
      id,
      JSON.stringify({ changes: body }),
      getClientIp(context.request),
    );

    const updated = await context.env.DB.prepare('SELECT * FROM claim_types WHERE id = ?')
      .bind(id)
      .first();

    return json({ claimType: updated });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update claim type error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

/**
 * DELETE /api/claim-types/:id
 * Soft-delete (active = 0). The claim rules attached to it are LEFT IN PLACE:
 * deactivating a claim should stop it being asserted, not silently discard the
 * QA manager's configuration work.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const id = context.params.id as string;
    requireRole(user, 'super_admin', 'org_admin');

    const claimType = await context.env.DB.prepare('SELECT * FROM claim_types WHERE id = ?')
      .bind(id)
      .first();
    if (!claimType) throw new NotFoundError('Claim type not found');

    requireTenantAccess(user, claimType.tenant_id as string);

    await context.env.DB.prepare(
      "UPDATE claim_types SET active = 0, updated_at = datetime('now') WHERE id = ?",
    )
      .bind(id)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      claimType.tenant_id as string,
      'claim_type_deleted',
      'claim_type',
      id,
      JSON.stringify({ name: claimType.name }),
      getClientIp(context.request),
    );

    return json({ success: true });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Delete claim type error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
