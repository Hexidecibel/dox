/**
 * Shared supplier resolution + creation logic.
 *
 * Two callers use this today:
 *   - functions/api/suppliers/lookup-or-create.ts (HTTP endpoint, manual)
 *   - functions/lib/queue-approve.ts (queue approval, both single + multi product)
 *
 * The same input string ("Medosweet", "MEDOSWEET FARMS", "Medosweet Farms, Inc.")
 * should resolve to ONE supplier row. We do this by normalizing the name —
 * lowercasing, stripping common business suffixes, collapsing whitespace —
 * and matching the normalized form against existing suppliers' names AND
 * their JSON-decoded `aliases` array. When a match is found, the raw
 * incoming name is appended to that supplier's aliases (case-insensitive
 * dedup) so later lookups can use it directly.
 */

import type { D1Database } from '@cloudflare/workers-types';
import { generateId, logAudit } from './db';

/**
 * Strip common business-name boilerplate so "Medosweet Farms, Inc." and
 * "MEDOSWEET FARMS" collapse to the same key. Conservative — we only chop
 * the trailing tokens that everyone agrees are noise. Internal punctuation
 * is preserved (a comma in the middle of a name is meaningful), but trailing
 * punctuation gets normalized away.
 */
export function normalizeSupplierName(raw: string): string {
  if (!raw) return '';
  let s = raw.toLowerCase().trim();

  // Repeatedly strip trailing suffixes until none of them apply. Order matters:
  // longer / more specific patterns first so we don't accidentally chop
  // "L.L.C" when "LLC" would have been matched on a later pass.
  // Patterns are anchored to the end of the string and handle optional
  // leading commas / periods / whitespace so both "Foo, Inc." and "Foo Inc"
  // collapse the same way.
  const trailingPatterns: RegExp[] = [
    /[\s,]*l\.l\.c\.?$/i,
    /[\s,]*llc\.?$/i,
    /[\s,]*inc\.?$/i,
    /[\s,]*co\.?$/i,
    /[\s,]+farms?$/i,
    /[\s,]+company$/i,
    /[\s,]+corp\.?$/i,
    /[\s,]+corporation$/i,
    /[.,\s]+$/,
  ];

  let changed = true;
  while (changed) {
    changed = false;
    for (const pat of trailingPatterns) {
      const next = s.replace(pat, '');
      if (next !== s) {
        s = next.trim();
        changed = true;
      }
    }
  }

  // Collapse internal whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

interface ExistingSupplier {
  id: string;
  name: string;
  aliases: string | null;
}

function parseAliases(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => typeof x === 'string');
  } catch {
    return [];
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export interface FindOrCreateSupplierResult {
  id: string;
  created: boolean;
  aliasAdded: boolean;
}

/**
 * Resolve a supplier by name with normalized + alias-aware matching, creating
 * a new row only when no candidate matches. When an existing row is matched
 * by anything other than its canonical `name`, the raw incoming string is
 * appended to that row's aliases JSON array so the next lookup hits without
 * needing to re-normalize.
 *
 * Audit logs are emitted on creation and on alias addition.
 */
export async function findOrCreateSupplier(
  db: D1Database,
  tenantId: string,
  rawName: string,
  actor: { userId: string; ip: string | null }
): Promise<FindOrCreateSupplierResult> {
  const trimmed = (rawName || '').trim();
  if (!trimmed) {
    throw new Error('rawName is required');
  }

  const normalized = normalizeSupplierName(trimmed);
  const slug = slugify(trimmed);

  // 1. Exact slug match — cheap and indexed.
  const bySlug = await db
    .prepare('SELECT id, name, aliases FROM suppliers WHERE tenant_id = ? AND slug = ?')
    .bind(tenantId, slug)
    .first<ExistingSupplier>();
  if (bySlug) {
    const aliasAdded = await maybeAppendAlias(db, bySlug, trimmed, tenantId, actor);
    return { id: bySlug.id, created: false, aliasAdded };
  }

  // 2. Exact case-insensitive name match.
  const byName = await db
    .prepare(
      'SELECT id, name, aliases FROM suppliers WHERE tenant_id = ? AND LOWER(name) = LOWER(?)'
    )
    .bind(tenantId, trimmed)
    .first<ExistingSupplier>();
  if (byName) {
    const aliasAdded = await maybeAppendAlias(db, byName, trimmed, tenantId, actor);
    return { id: byName.id, created: false, aliasAdded };
  }

  // 3. Normalized-name + alias scan. This is O(N) per tenant — fine because
  // tenants with thousands of suppliers are rare and creation is uncommon.
  const allRows = await db
    .prepare('SELECT id, name, aliases FROM suppliers WHERE tenant_id = ?')
    .bind(tenantId)
    .all<ExistingSupplier>();

  for (const row of allRows.results || []) {
    if (normalizeSupplierName(row.name) === normalized) {
      const aliasAdded = await maybeAppendAlias(db, row, trimmed, tenantId, actor);
      return { id: row.id, created: false, aliasAdded };
    }
    const aliases = parseAliases(row.aliases);
    for (const alias of aliases) {
      if (
        alias.toLowerCase() === trimmed.toLowerCase() ||
        normalizeSupplierName(alias) === normalized
      ) {
        const aliasAdded = await maybeAppendAlias(db, row, trimmed, tenantId, actor);
        return { id: row.id, created: false, aliasAdded };
      }
    }
  }

  // 4. No match — create.
  const id = generateId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(id, tenantId, trimmed, slug)
    .run();

  try {
    await logAudit(
      db,
      actor.userId,
      tenantId,
      'supplier.created',
      'supplier',
      id,
      JSON.stringify({ name: trimmed, source: 'findOrCreateSupplier' }),
      actor.ip
    );
  } catch {
    // Non-fatal.
  }

  return { id, created: true, aliasAdded: false };
}

/**
 * Append `incoming` to row.aliases when:
 *   - it isn't already the canonical name (case-insensitive)
 *   - it isn't already in the aliases array (case-insensitive)
 * Returns true when the aliases column was updated.
 */
async function maybeAppendAlias(
  db: D1Database,
  row: ExistingSupplier,
  incoming: string,
  tenantId: string,
  actor: { userId: string; ip: string | null }
): Promise<boolean> {
  if (row.name.toLowerCase() === incoming.toLowerCase()) return false;
  const existing = parseAliases(row.aliases);
  for (const a of existing) {
    if (a.toLowerCase() === incoming.toLowerCase()) return false;
  }
  const next = [...existing, incoming];
  await db
    .prepare("UPDATE suppliers SET aliases = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(JSON.stringify(next), row.id)
    .run();

  try {
    await logAudit(
      db,
      actor.userId,
      tenantId,
      'supplier.alias_added',
      'supplier',
      row.id,
      JSON.stringify({ alias: incoming }),
      actor.ip
    );
  } catch {
    // Non-fatal.
  }

  return true;
}
