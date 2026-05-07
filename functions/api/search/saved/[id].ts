/**
 * Saved searches CRUD — fetch / update / delete by id.
 *
 * Phase 3 of the Document Search v2 plan
 * (`/home/hexi/.claude/plans/peppy-coalescing-platypus.md`).
 *
 * Endpoints:
 *   GET    /api/search/saved/:id   → fetch one (owner only)
 *   PUT    /api/search/saved/:id   → update name and/or query (owner only)
 *   DELETE /api/search/saved/:id   → delete (owner only)
 *
 * Ownership model: the row's `user_id` is the only acceptor. We deliberately
 * return 404 (not 403) when a non-owner — including a super_admin —
 * targets someone else's saved search. Saved searches are a personal
 * surface; existence-leakage doesn't help anyone here.
 */

import { logAudit, getClientIp } from '../../../lib/db';
import {
  errorToResponse,
  NotFoundError,
  BadRequestError,
} from '../../../lib/permissions';
import { sanitizeString } from '../../../lib/validation';
import type { Env, User } from '../../../lib/types';

const NAME_MAX_LEN = 100;

interface SavedSearchRow {
  id: string;
  user_id: string;
  tenant_id: string;
  name: string;
  query_json: string;
  scope: string;
  created_at: string;
  updated_at: string;
}

function rowToResponse(row: SavedSearchRow) {
  let query: unknown = null;
  try {
    query = JSON.parse(row.query_json);
  } catch {
    query = null;
  }
  return {
    id: row.id,
    user_id: row.user_id,
    tenant_id: row.tenant_id,
    name: row.name,
    query,
    scope: row.scope,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Look up the saved search row by id AND user_id. Returns null when the
 * row is missing OR owned by a different user — callers should respond
 * with 404 in either case.
 */
async function findOwnedRow(
  db: D1Database,
  id: string,
  userId: string,
): Promise<SavedSearchRow | null> {
  return db
    .prepare(
      `SELECT id, user_id, tenant_id, name, query_json, scope, created_at, updated_at
       FROM saved_searches WHERE id = ? AND user_id = ?`,
    )
    .bind(id, userId)
    .first<SavedSearchRow>();
}

/**
 * GET /api/search/saved/:id
 * Returns: { saved_search: SavedSearch }
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const id = context.params.id as string;

    const row = await findOwnedRow(context.env.DB, id, user.id);
    if (!row) {
      throw new NotFoundError('Saved search not found');
    }

    return new Response(
      JSON.stringify({ saved_search: rowToResponse(row) }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Get saved search error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};

/**
 * PUT /api/search/saved/:id
 * Body: { name?: string; query?: object }
 * Returns: { saved_search: SavedSearch }
 *
 * Renaming to a name another of the caller's saved searches already uses
 * → 409. `updated_at` is bumped on every successful update.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const id = context.params.id as string;

    const row = await findOwnedRow(context.env.DB, id, user.id);
    if (!row) {
      throw new NotFoundError('Saved search not found');
    }

    let body: { name?: unknown; query?: unknown };
    try {
      body = (await context.request.json()) as typeof body;
    } catch {
      throw new BadRequestError('Invalid JSON body');
    }

    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) {
        throw new BadRequestError('name cannot be empty');
      }
      const name = sanitizeString(body.name);
      if (!name) {
        throw new BadRequestError('name cannot be empty');
      }
      if (name.length > NAME_MAX_LEN) {
        throw new BadRequestError(`name must be ${NAME_MAX_LEN} characters or fewer`);
      }

      // UNIQUE(user_id, name) — exclude the current row from the check.
      const dup = await context.env.DB.prepare(
        'SELECT id FROM saved_searches WHERE user_id = ? AND name = ? AND id != ?',
      )
        .bind(user.id, name, id)
        .first();
      if (dup) {
        return new Response(
          JSON.stringify({ error: 'A saved search with this name already exists' }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      }

      updates.push('name = ?');
      params.push(name);
    }

    if (body.query !== undefined) {
      if (body.query === null) {
        throw new BadRequestError('query cannot be null');
      }
      let queryJson: string;
      try {
        queryJson = JSON.stringify(body.query);
      } catch {
        throw new BadRequestError('query must be JSON-serializable');
      }
      updates.push('query_json = ?');
      params.push(queryJson);
    }

    if (updates.length === 0) {
      throw new BadRequestError('No fields to update');
    }

    updates.push("updated_at = datetime('now')");
    params.push(id);

    await context.env.DB.prepare(
      `UPDATE saved_searches SET ${updates.join(', ')} WHERE id = ?`,
    )
      .bind(...params)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      row.tenant_id,
      'saved_search.updated',
      'saved_search',
      id,
      JSON.stringify({
        fields: Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined),
      }),
      getClientIp(context.request),
    );

    const updated = await context.env.DB.prepare(
      `SELECT id, user_id, tenant_id, name, query_json, scope, created_at, updated_at
       FROM saved_searches WHERE id = ?`,
    )
      .bind(id)
      .first<SavedSearchRow>();

    return new Response(
      JSON.stringify({ saved_search: updated ? rowToResponse(updated) : null }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Update saved search error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};

/**
 * DELETE /api/search/saved/:id
 * Returns: { success: true }
 *
 * Hard delete — saved searches don't have a soft-delete column. Calling
 * DELETE on a non-existent or non-owned id returns 404.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const id = context.params.id as string;

    const row = await findOwnedRow(context.env.DB, id, user.id);
    if (!row) {
      throw new NotFoundError('Saved search not found');
    }

    await context.env.DB.prepare(
      'DELETE FROM saved_searches WHERE id = ? AND user_id = ?',
    )
      .bind(id, user.id)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      row.tenant_id,
      'saved_search.deleted',
      'saved_search',
      id,
      JSON.stringify({ name: row.name }),
      getClientIp(context.request),
    );

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Delete saved search error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
