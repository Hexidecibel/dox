/**
 * Saved searches CRUD — list + create.
 *
 * Phase 3 of the Document Search v2 plan
 * (`/home/hexi/.claude/plans/peppy-coalescing-platypus.md`).
 *
 * Endpoints:
 *   GET  /api/search/saved   → list the calling user's saved searches
 *   POST /api/search/saved   → create a saved search owned by the caller
 *
 * Auth: any authenticated user (super_admin / org_admin / user / reader)
 * may save and list THEIR OWN searches. Per-user isolation is enforced
 * at the query level (`WHERE user_id = ?`), not by role — readers are
 * allowed by design.
 *
 * Recent searches stay client-side (localStorage) per the plan; this
 * endpoint set is server-backed NAMED searches only.
 */

import { generateId, logAudit, getClientIp } from '../../../lib/db';
import { errorToResponse, BadRequestError } from '../../../lib/permissions';
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
    // Defensive — the column is opaque TEXT so a corrupt row shouldn't
    // crash the list endpoint. Surface as null rather than throwing.
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
 * GET /api/search/saved
 * Returns: { saved_searches: SavedSearch[] }
 *
 * Always scoped to the calling user — including super_admin. Super-admins
 * see only THEIR OWN saved searches via this endpoint; cross-user
 * inspection is not a feature this surface supports.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;

    const result = await context.env.DB.prepare(
      `SELECT id, user_id, tenant_id, name, query_json, scope, created_at, updated_at
       FROM saved_searches
       WHERE user_id = ?
       ORDER BY created_at DESC, name ASC`,
    )
      .bind(user.id)
      .all<SavedSearchRow>();

    const savedSearches = (result.results ?? []).map(rowToResponse);

    return new Response(JSON.stringify({ saved_searches: savedSearches }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('List saved searches error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};

/**
 * POST /api/search/saved
 * Body: { name: string; query: object; scope?: 'personal' }
 * Returns: 201 { saved_search: SavedSearch }
 *
 * `scope` is reserved for v2 — only 'personal' is accepted today. We
 * REJECT 'shared' rather than silently coercing because the user's
 * intent was explicit and a silent downgrade would surprise them when
 * the search doesn't show up for their team.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;

    if (!user.tenant_id) {
      // Super-admins without a tenant can't own a tenant-scoped saved
      // search. They can still browse via the list endpoint (returns []),
      // but they need a tenant to create one.
      throw new BadRequestError('Saved searches require a tenant; super_admins must impersonate a tenant to save');
    }

    let body: { name?: unknown; query?: unknown; scope?: unknown };
    try {
      body = (await context.request.json()) as typeof body;
    } catch {
      throw new BadRequestError('Invalid JSON body');
    }

    // --- name ---
    if (typeof body.name !== 'string' || !body.name.trim()) {
      throw new BadRequestError('name is required');
    }
    const name = sanitizeString(body.name);
    if (!name) {
      throw new BadRequestError('name is required');
    }
    if (name.length > NAME_MAX_LEN) {
      throw new BadRequestError(`name must be ${NAME_MAX_LEN} characters or fewer`);
    }

    // --- query ---
    if (body.query === undefined || body.query === null) {
      throw new BadRequestError('query is required');
    }
    let queryJson: string;
    try {
      queryJson = JSON.stringify(body.query);
    } catch {
      throw new BadRequestError('query must be JSON-serializable');
    }
    if (typeof queryJson !== 'string') {
      throw new BadRequestError('query must be JSON-serializable');
    }

    // --- scope ---
    let scope: 'personal' = 'personal';
    if (body.scope !== undefined) {
      if (body.scope === 'personal') {
        scope = 'personal';
      } else if (body.scope === 'shared') {
        throw new BadRequestError('shared saved searches are not yet supported');
      } else {
        throw new BadRequestError("scope must be 'personal'");
      }
    }

    // --- duplicate-name guard (UNIQUE(user_id, name)) ---
    const existing = await context.env.DB.prepare(
      'SELECT id FROM saved_searches WHERE user_id = ? AND name = ?',
    )
      .bind(user.id, name)
      .first();
    if (existing) {
      return new Response(
        JSON.stringify({ error: 'A saved search with this name already exists' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const id = generateId();
    await context.env.DB.prepare(
      `INSERT INTO saved_searches (id, user_id, tenant_id, name, query_json, scope)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, user.id, user.tenant_id, name, queryJson, scope)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      user.tenant_id,
      'saved_search.created',
      'saved_search',
      id,
      JSON.stringify({ name }),
      getClientIp(context.request),
    );

    const row = await context.env.DB.prepare(
      `SELECT id, user_id, tenant_id, name, query_json, scope, created_at, updated_at
       FROM saved_searches WHERE id = ?`,
    )
      .bind(id)
      .first<SavedSearchRow>();

    return new Response(
      JSON.stringify({ saved_search: row ? rowToResponse(row) : null }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Create saved search error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
