/**
 * /api/requirements/:id — read / update / soft-delete one checklist line item.
 * Mirrors /api/document-types/:id (same role gate, same soft-delete semantics).
 */

import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import { slugifyVocab } from '../../lib/registry-vocab';
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
 * Fields: name, slug, description, checklist, sort_order, active.
 * Renaming does NOT re-slug automatically — the slug is the stable identifier
 * that starter packs and importers key on, and silently rewriting it would
 * break a re-run of `bin/create-tenant`. Pass `slug` explicitly to change it.
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
        'SELECT id FROM requirements WHERE slug = ? AND tenant_id = ? AND id != ?',
      )
        .bind(slug, requirement.tenant_id, id)
        .first();
      if (existing) {
        return json({ error: 'A requirement with this slug already exists for this tenant' }, 409);
      }
      updates.push('slug = ?');
      params.push(slug);
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

    if (updates.length === 0) return json({ error: 'No fields to update' }, 400);

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
      JSON.stringify({ changes: body }),
      getClientIp(context.request),
    );

    const updated = await context.env.DB.prepare('SELECT * FROM requirements WHERE id = ?')
      .bind(id)
      .first();

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
