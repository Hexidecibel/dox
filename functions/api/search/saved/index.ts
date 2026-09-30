/**
 * Saved searches / saved views — list + create.
 *
 * Endpoints:
 *   GET  /api/search/saved   → the caller's own views, plus every view shared
 *                              with their organization (search Phase 3)
 *   POST /api/search/saved   → create a view owned by the caller
 *
 * Auth: any authenticated user (super_admin / org_admin / user / reader) may
 * save and list THEIR OWN views; a reader can save. Publishing to the whole
 * organization (`scope: 'shared'`) is an org_admin's (functions/lib/saved-searches.ts).
 *
 * The query is a v1 `SearchQuery` (clauses + view: result mode, Easy/Advanced,
 * columns, sort), validated clause by clause with the executor's own rules;
 * a pre-redesign flat state is still accepted and read.
 *
 * Recent searches stay client-side (localStorage); this is NAMED views only.
 */

import { generateId, logAudit, getClientIp } from '../../../lib/db';
import { errorToResponse, BadRequestError } from '../../../lib/permissions';
import { sanitizeString } from '../../../lib/validation';
import { parseScope, rowToResponse, SAVED_COLUMNS, validateSavedQuery, type SavedSearchRow } from '../../../lib/saved-searches';
import type { Env, User } from '../../../lib/types';

const NAME_MAX_LEN = 100;

/**
 * GET /api/search/saved
 * Returns: { saved_searches: SavedSearch[] } — own first, then shared ones.
 *
 * A super_admin with no tenant sees only their own (none: they cannot create).
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const result = await context.env.DB.prepare(
      `SELECT ${SAVED_COLUMNS}
         FROM saved_searches s LEFT JOIN users u ON u.id = s.user_id
        WHERE s.user_id = ? OR (s.scope = 'shared' AND s.tenant_id = ?)
        ORDER BY CASE WHEN s.user_id = ? THEN 0 ELSE 1 END, s.created_at DESC, s.name ASC`,
    )
      .bind(user.id, user.tenant_id ?? '', user.id)
      .all<SavedSearchRow>();

    const savedSearches = (result.results ?? []).map((r) => rowToResponse(r, user));
    return new Response(JSON.stringify({ saved_searches: savedSearches }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List saved searches error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

/**
 * POST /api/search/saved
 * Body: { name: string; query: object; scope?: 'personal' | 'shared' }
 * Returns: 201 { saved_search }
 *
 * `shared` by anyone but an org_admin is a 403 that says why — never a
 * silent downgrade to personal, because the person meant their team to see it.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;

    if (!user.tenant_id) {
      throw new BadRequestError('Saved searches require a tenant; super_admins must impersonate a tenant to save');
    }

    let body: { name?: unknown; query?: unknown; scope?: unknown };
    try {
      body = (await context.request.json()) as typeof body;
    } catch {
      throw new BadRequestError('Invalid JSON body');
    }

    if (typeof body.name !== 'string' || !body.name.trim()) throw new BadRequestError('name is required');
    const name = sanitizeString(body.name);
    if (!name) throw new BadRequestError('name is required');
    if (name.length > NAME_MAX_LEN) throw new BadRequestError(`name must be ${NAME_MAX_LEN} characters or fewer`);

    if (body.query === undefined || body.query === null) throw new BadRequestError('query is required');
    validateSavedQuery(body.query);
    let queryJson: string;
    try {
      queryJson = JSON.stringify(body.query);
    } catch {
      throw new BadRequestError('query must be JSON-serializable');
    }
    if (typeof queryJson !== 'string') throw new BadRequestError('query must be JSON-serializable');

    const scope = parseScope(body.scope, user) ?? 'personal';

    // UNIQUE(user_id, name)
    const existing = await context.env.DB.prepare('SELECT id FROM saved_searches WHERE user_id = ? AND name = ?').bind(user.id, name).first();
    if (existing) {
      return new Response(JSON.stringify({ error: 'A saved search with this name already exists' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const id = generateId();
    await context.env.DB.prepare(
      `INSERT INTO saved_searches (id, user_id, tenant_id, name, query_json, scope) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, user.id, user.tenant_id, name, queryJson, scope)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      user.tenant_id,
      scope === 'shared' ? 'saved_search.shared' : 'saved_search.created',
      'saved_search',
      id,
      JSON.stringify({ name, scope }),
      getClientIp(context.request),
    );

    const row = await context.env.DB.prepare(
      `SELECT ${SAVED_COLUMNS} FROM saved_searches s LEFT JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    )
      .bind(id)
      .first<SavedSearchRow>();

    return new Response(JSON.stringify({ saved_search: row ? rowToResponse(row, user) : null }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Create saved search error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
