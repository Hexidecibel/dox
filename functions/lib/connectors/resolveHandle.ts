/**
 * Slug-or-id resolution for connector path params.
 *
 * Phase B0.5 introduces the URL-safe `slug` column on connectors. Public
 * endpoints (`/api/connectors/:id/drop`, `/api/connectors/:id/run`,
 * etc.) accept EITHER a slug or the random-hex id in the path so vendor
 * URLs can stay stable while admin tools keep using the unambiguous id.
 *
 * Resolution order: slug first (the path param shape passes
 * `CONNECTOR_SLUG_REGEX` for hex ids too — they're [a-f0-9]+ — so the
 * regex test is necessary but not sufficient), id second. We deliberately
 * issue both queries for ambiguous handles rather than try to encode
 * "look like a slug" vs "look like an id" client-side: ids and short
 * lowercase slugs share the same character class.
 */

import { CONNECTOR_SLUG_REGEX } from '../../../shared/connectorSlug';

export interface ConnectorResolveOptions {
  /**
   * Optional column projection. Defaults to `*` because most callers
   * already expect every connector column. Pass an explicit list to
   * keep the row tight (e.g. for the public drop endpoint).
   */
  columns?: string;
}

/**
 * Look up a connector by slug-or-id. Returns null if neither matches.
 * Caller is responsible for any tenancy / soft-delete / active checks
 * beyond the lookup itself — this helper only resolves the row.
 */
export async function resolveConnectorHandle<T = Record<string, unknown>>(
  db: D1Database,
  handle: string,
  options: ConnectorResolveOptions = {},
): Promise<T | null> {
  if (typeof handle !== 'string' || handle.length === 0) return null;

  const cols = options.columns ?? '*';

  // Slug attempt first. The regex is anchored start-and-end so we don't
  // accidentally match a substring of a longer id-shaped value.
  if (CONNECTOR_SLUG_REGEX.test(handle)) {
    const bySlug = await db
      .prepare(`SELECT ${cols} FROM connectors WHERE slug = ?`)
      .bind(handle)
      .first<T>();
    if (bySlug) return bySlug;
  }

  // Fall through to id lookup. We do NOT skip this when the slug regex
  // matched — a hex id like `abcdef0123456789...` matches the regex but
  // isn't necessarily in the slug column.
  const byId = await db
    .prepare(`SELECT ${cols} FROM connectors WHERE id = ?`)
    .bind(handle)
    .first<T>();

  return byId;
}
