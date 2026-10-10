/**
 * /api/requirements/:id — read / update / soft-delete one checklist line item.
 * Mirrors /api/document-types/:id (same role gate, same soft-delete semantics).
 */

import { drainSoon } from '../../lib/search-reindex';
import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import {
  checkDuplicateConcept,
  duplicateConceptResponse,
  slugChangeRefusal,
} from '../../lib/duplicate-concepts';
import type { DuplicateConcept } from '../../../shared/duplicateConcept';
import {
  REQUIREMENT_SCOPES,
  isRequirementScope,
  normalizeRequirementScope,
} from '../../../shared/requirementScope';
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

    const requirement = await context.env.DB.prepare('SELECT * FROM requirements WHERE id = ?')
      .bind(id)
      .first();
    if (!requirement) throw new NotFoundError('Requirement not found');

    requireTenantAccess(user, requirement.tenant_id as string);

    return json({ requirement });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Get requirement error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

/**
 * PUT /api/requirements/:id
 * Fields: name, description, checklist, sort_order, active, scope.
 *
 * `scope` (0123) changes what every supplier this requirement is attached to
 * owes — "once" becomes "once per active product". It is audited on its own
 * (`requirement.scope_changed`, with the previous value) because it is the
 * one field here that moves gap reports; preview the impact first with
 * GET /api/requirements/:id/scope-preview?scope=.
 * THE SLUG DOES NOT CHANGE (decision C-154). It is the stable identifier that
 * starter-pack updates, supplier packets and importers key on. There used to
 * be an explicit `slug` field here that could move it; sending a slug other
 * than the one the row has is now a 400 that says so.
 *
 * Renaming INTO another concept's name is refused with 409
 * `duplicate_concept`; `allow_duplicate: true` overrides, and is audited.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const id = context.params.id as string;
    requireRole(user, 'super_admin', 'org_admin');

    const requirement = await context.env.DB.prepare('SELECT * FROM requirements WHERE id = ?')
      .bind(id)
      .first();
    if (!requirement) throw new NotFoundError('Requirement not found');

    requireTenantAccess(user, requirement.tenant_id as string);

    const body = (await context.request.json()) as {
      name?: string;
      slug?: string;
      description?: string | null;
      checklist?: string | null;
      sort_order?: number;
      active?: number | boolean;
      scope?: string;
      allow_duplicate?: boolean;
    };

    const slugRefusal = slugChangeRefusal(body.slug, requirement.slug as string);
    if (slugRefusal) return slugRefusal;
    let duplicateOverride: DuplicateConcept | null = null;

    const updates: string[] = [];
    const params: (string | number | null)[] = [];
    let scopeChange: { from: string; to: string } | null = null;

    if (body.scope !== undefined) {
      if (!isRequirementScope(body.scope)) {
        return json({ error: `scope must be one of: ${REQUIREMENT_SCOPES.join(', ')}` }, 400);
      }
      const from = normalizeRequirementScope(requirement.scope);
      if (from !== body.scope) {
        updates.push('scope = ?');
        params.push(body.scope);
        scopeChange = { from, to: body.scope };
      }
    }

    if (body.name !== undefined) {
      const name = sanitizeString(body.name);
      if (!name) return json({ error: 'name cannot be empty' }, 400);
      if (name !== requirement.name) {
        const dup = await checkDuplicateConcept(context.env.DB, {
          tenantId: requirement.tenant_id as string,
          vocabulary: 'requirements',
          name,
          slug: requirement.slug as string,
          excludeId: id,
        });
        if (dup) {
          if (body.allow_duplicate !== true) return duplicateConceptResponse(dup);
          duplicateOverride = dup.duplicate;
        }
      }
      updates.push('name = ?');
      params.push(name);
    }

    if (body.description !== undefined) {
      updates.push('description = ?');
      params.push(body.description ? sanitizeString(body.description) : null);
    }

    if (body.checklist !== undefined) {
      updates.push('checklist = ?');
      params.push(body.checklist ? sanitizeString(body.checklist) : null);
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

    if (updates.length === 0) {
      // A scope "change" to the value already stored is a no-op, not an error.
      if (body.scope !== undefined) return json({ requirement });
      return json({ error: 'No fields to update' }, 400);
    }

    updates.push("updated_at = datetime('now')");
    params.push(id);

    await context.env.DB.prepare(`UPDATE requirements SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...params)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      requirement.tenant_id as string,
      'requirement_updated',
      'requirement',
      id,
      JSON.stringify({
        changes: body,
        ...(duplicateOverride ? { duplicate_override: duplicateOverride } : {}),
      }),
      getClientIp(context.request),
    );

    if (scopeChange) {
      await logAudit(
        context.env.DB,
        user.id,
        requirement.tenant_id as string,
        'requirement.scope_changed',
        'requirement',
        id,
        JSON.stringify({ name: requirement.name, from: scopeChange.from, to: scopeChange.to }),
        getClientIp(context.request),
      );
    }

    const updated = await context.env.DB.prepare('SELECT * FROM requirements WHERE id = ?')
      .bind(id)
      .first();

    drainSoon(context, context.env.DB);
    return json({ requirement: updated });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update requirement error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

/**
 * DELETE /api/requirements/:id
 * Soft-delete (active = 0). A requirement that documents already closed must
 * keep resolving by id in history, and the claim rules that open it stay
 * intact so reactivating restores the configuration untouched.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const id = context.params.id as string;
    requireRole(user, 'super_admin', 'org_admin');

    const requirement = await context.env.DB.prepare('SELECT * FROM requirements WHERE id = ?')
      .bind(id)
      .first();
    if (!requirement) throw new NotFoundError('Requirement not found');

    requireTenantAccess(user, requirement.tenant_id as string);

    await context.env.DB.prepare(
      "UPDATE requirements SET active = 0, updated_at = datetime('now') WHERE id = ?",
    )
      .bind(id)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      requirement.tenant_id as string,
      'requirement_deleted',
      'requirement',
      id,
      JSON.stringify({ name: requirement.name }),
      getClientIp(context.request),
    );

    return json({ success: true });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Delete requirement error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
