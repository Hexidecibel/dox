/**
 * Saved searches / saved views — fetch / update / delete by id.
 *
 * Endpoints:
 *   GET    /api/search/saved/:id   → own view, or a view shared with the caller's organization
 *   PUT    /api/search/saved/:id   → owner only: name, query, scope (sharing needs org_admin)
 *   DELETE /api/search/saved/:id   → owner; or an org_admin of that organization for a SHARED view
 *
 * Another person's PERSONAL view is a 404 (not a 403) to everyone, including
 * a super_admin: its existence is not something to reveal. A shared view is
 * readable by its organization, and a non-owner who may not change it gets a
 * 403 that says so.
 */
import { logAudit, getClientIp } from '../../../lib/db';
import { errorToResponse, NotFoundError, BadRequestError, ForbiddenError } from '../../../lib/permissions';
import { sanitizeString } from '../../../lib/validation';
import { canPublish, parseScope, rowToResponse, SAVED_COLUMNS, validateSavedQuery, type SavedSearchRow } from '../../../lib/saved-searches';
import type { Env, User } from '../../../lib/types';

const NAME_MAX_LEN = 100;

/** The row, when the caller may SEE it (owner, or shared in their organization); else null. */
async function findVisibleRow(db: D1Database, id: string, user: User): Promise<SavedSearchRow | null> {
  return db
    .prepare(
      `SELECT ${SAVED_COLUMNS} FROM saved_searches s LEFT JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND (s.user_id = ? OR (s.scope = 'shared' AND s.tenant_id = ?))`,
    )
    .bind(id, user.id, user.tenant_id ?? '')
    .first<SavedSearchRow>();
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function failure(err: unknown, what: string): Response {
  const httpErr = errorToResponse(err);
  if (httpErr) return httpErr;
  console.error(`${what} saved search error:`, err);
  return json({ error: 'Internal server error' }, 500);
}

/** GET /api/search/saved/:id → { saved_search } */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const row = await findVisibleRow(context.env.DB, context.params.id as string, user);
    if (!row) throw new NotFoundError('Saved search not found');
    return json({ saved_search: rowToResponse(row, user) });
  } catch (err) {
    return failure(err, 'Get');
  }
};

/**
 * PUT /api/search/saved/:id
 * Body: { name?: string; query?: object; scope?: 'personal' | 'shared' }
 * Renaming to a name another of the caller's views uses → 409.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const id = context.params.id as string;
    const row = await findVisibleRow(context.env.DB, id, user);
    if (!row) throw new NotFoundError('Saved search not found');
    if (row.user_id !== user.id) throw new ForbiddenError('Only the person who saved this view can change it.');

    let body: { name?: unknown; query?: unknown; scope?: unknown };
    try {
      body = (await context.request.json()) as typeof body;
    } catch {
      throw new BadRequestError('Invalid JSON body');
    }

    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) throw new BadRequestError('name cannot be empty');
      const name = sanitizeString(body.name);
      if (!name) throw new BadRequestError('name cannot be empty');
      if (name.length > NAME_MAX_LEN) throw new BadRequestError(`name must be ${NAME_MAX_LEN} characters or fewer`);
      const dup = await context.env.DB.prepare('SELECT id FROM saved_searches WHERE user_id = ? AND name = ? AND id != ?').bind(user.id, name, id).first();
      if (dup) return json({ error: 'A saved search with this name already exists' }, 409);
      updates.push('name = ?');
      params.push(name);
    }

    if (body.query !== undefined) {
      if (body.query === null) throw new BadRequestError('query cannot be null');
      validateSavedQuery(body.query);
      let queryJson: string;
      try {
        queryJson = JSON.stringify(body.query);
      } catch {
        throw new BadRequestError('query must be JSON-serializable');
      }
      updates.push('query_json = ?');
      params.push(queryJson);
    }

    const scope = parseScope(body.scope, user);
    if (scope !== undefined && scope !== row.scope) {
      updates.push('scope = ?');
      params.push(scope);
    }

    if (updates.length === 0) throw new BadRequestError('No fields to update');
    updates.push("updated_at = datetime('now')");
    params.push(id);
    await context.env.DB.prepare(`UPDATE saved_searches SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();

    await logAudit(
      context.env.DB,
      user.id,
      row.tenant_id,
      scope !== undefined && scope !== row.scope ? (scope === 'shared' ? 'saved_search.shared' : 'saved_search.unshared') : 'saved_search.updated',
      'saved_search',
      id,
      JSON.stringify({ fields: Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined) }),
      getClientIp(context.request),
    );

    const updated = await findVisibleRow(context.env.DB, id, user);
    return json({ saved_search: updated ? rowToResponse(updated, user) : null });
  } catch (err) {
    return failure(err, 'Update');
  }
};

/**
 * DELETE /api/search/saved/:id → { success: true }
 * Hard delete. The owner may; so may an org_admin of the organization a view
 * is SHARED with (somebody has to be able to take a published view down).
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const id = context.params.id as string;
    const row = await findVisibleRow(context.env.DB, id, user);
    if (!row) throw new NotFoundError('Saved search not found');
    const moderator = row.scope === 'shared' && canPublish(user) && user.tenant_id === row.tenant_id;
    if (row.user_id !== user.id && !moderator) throw new ForbiddenError('Only the person who saved this view, or an organization admin, can delete it.');

    await context.env.DB.prepare('DELETE FROM saved_searches WHERE id = ?').bind(id).run();
    await logAudit(
      context.env.DB,
      user.id,
      row.tenant_id,
      'saved_search.deleted',
      'saved_search',
      id,
      JSON.stringify({ name: row.name, scope: row.scope, owner_id: row.user_id }),
      getClientIp(context.request),
    );
    return json({ success: true });
  } catch (err) {
    return failure(err, 'Delete');
  }
};
