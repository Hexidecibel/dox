/**
 * Saved searches / saved VIEWS (search redesign Phase 3) — the rules both
 * `/api/search/saved` handlers share.
 *
 * A saved view holds a v1 `SearchQuery` (clauses, text and the view: result
 * mode, Easy/Advanced, columns, sort). Older rows hold the pre-redesign flat
 * `SearchState`, which is still accepted and still read
 * (`savedPayloadToQuery`).
 *
 *   personal  visible to its owner only (the original surface).
 *   shared    published to the owner's WHOLE organization. Only an org_admin
 *             (or a super_admin acting in a tenant) may publish, and only the
 *             owner may edit one; an org_admin of that organization may also
 *             unpublish or delete a shared view — a view the whole
 *             organization sees must have somebody who can take it down.
 *             (SME question open: whether anyone should be able to publish.)
 *
 * Existence of another person's PERSONAL view is never revealed (404).
 */

import type { User } from './types';
import { BadRequestError, ForbiddenError } from './permissions';
import { validateClause } from '../../shared/searchFields';
import type { Clause } from '../../shared/searchQuery';

export type SavedScope = 'personal' | 'shared';

export interface SavedSearchRow {
  id: string;
  user_id: string;
  tenant_id: string;
  name: string;
  query_json: string;
  scope: string;
  created_at: string;
  updated_at: string;
  owner_name?: string | null;
}

export const SAVED_COLUMNS = `s.id, s.user_id, s.tenant_id, s.name, s.query_json, s.scope, s.created_at, s.updated_at,
  u.name AS owner_name`;

export function rowToResponse(row: SavedSearchRow, viewer: User) {
  let query: unknown = null;
  try {
    query = JSON.parse(row.query_json);
  } catch {
    // The column is opaque TEXT: a corrupt row must not crash the list.
    query = null;
  }
  return {
    id: row.id,
    user_id: row.user_id,
    tenant_id: row.tenant_id,
    name: row.name,
    query,
    scope: row.scope,
    owner_name: row.owner_name ?? null,
    mine: row.user_id === viewer.id,
    can_edit: row.user_id === viewer.id,
    can_delete: row.user_id === viewer.id || (row.scope === 'shared' && canPublish(viewer) && viewer.tenant_id === row.tenant_id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** May this person publish a view to their whole organization? */
export function canPublish(user: User): boolean {
  return (user.role === 'org_admin' || user.role === 'super_admin') && !!user.tenant_id;
}

export function parseScope(raw: unknown, user: User): SavedScope | undefined {
  if (raw === undefined) return undefined;
  if (raw !== 'personal' && raw !== 'shared') throw new BadRequestError("scope must be 'personal' or 'shared'");
  if (raw === 'shared' && !canPublish(user)) {
    throw new ForbiddenError('Only an organization admin can share a saved view with the organization.');
  }
  return raw;
}

/**
 * A v1 query is checked clause by clause with the SAME rules the executor
 * refuses with, so a view that could never run is refused when saved, not
 * when a colleague opens it. A legacy flat state is stored as given.
 */
export function validateSavedQuery(q: unknown): void {
  if (!q || typeof q !== 'object') throw new BadRequestError('query must be an object');
  const v = q as { v?: unknown; clauses?: unknown };
  if (v.v !== 1) return;
  if (!Array.isArray(v.clauses)) throw new BadRequestError('query.clauses must be an array');
  if (v.clauses.length > 30) throw new BadRequestError('A saved view holds at most 30 clauses.');
  for (const c of v.clauses as Clause[]) {
    if (!c || typeof c !== 'object' || !Array.isArray(c.values)) throw new BadRequestError('Each clause needs a field, an op and values.');
    const err = validateClause(c);
    if (err) throw new BadRequestError(err);
  }
}
