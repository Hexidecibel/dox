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
 * Thrown by findOrCreateSupplier when the incoming name can't plausibly be a
 * real company name (spreadsheet cell refs, pure digits, punctuation, etc.).
 * Callers should catch this and leave supplier_id null so the document routes
 * to review rather than inventing a bogus supplier row.
 */
export class ImplausibleSupplierNameError extends Error {
  constructor(value: string) {
    super(`Implausible supplier name: ${JSON.stringify(value)}`);
    this.name = 'ImplausibleSupplierNameError';
  }
}

/**
 * Cheap junk filter for extracted supplier names. Returns false for values
 * that can't be a real company name. Intentionally conservative — it only
 * rejects obvious garbage so real (even short) names pass.
 *
 * Rejects when, after trimming, the value:
 *   - has fewer than 2 alphabetic [A-Za-z] characters, OR
 *   - looks like a spreadsheet cell reference ("C2#", "A1", "D99", "AB12%"), OR
 *   - has no letters at all.
 *
 * Note: "3M" is the only known real name this rejects (1 letter). That false
 * reject is acceptable given the volume of cell-reference junk we'd otherwise
 * admit. Any name with 2+ letters and a space, or 3+ letters, passes.
 */
export function isPlausibleSupplierName(raw: string): boolean {
  const s = (raw || '').trim();
  if (!s) return false;

  const letters = (s.match(/[A-Za-z]/g) || []).length;
  if (letters < 2) return false;

  // Spreadsheet cell reference: 1-3 letters, optional space, digits, optional
  // trailing #/%/* noise. Catches "C2#", "A1", "D99", "AB12%".
  if (/^[A-Za-z]{1,3}\s?\d+[#%*]*$/.test(s)) return false;

  return true;
}

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
 * Read-only, alias-aware supplier resolver. Mirrors findOrCreateSupplier's
 * MATCHING logic exactly (slug → exact case-insensitive name → normalized-name
 * scan → alias scan) but creates nothing and writes nothing — it does NOT
 * append aliases. Returns the matched supplier id, or null when no existing
 * supplier matches.
 *
 * Returns null when the name is empty or fails the plausibility guard, so junk
 * extractions ("C2#", pure digits, etc.) are never treated as a "known"
 * supplier. Callers use this to gate auto-ingest on a verified/known supplier.
 */
export async function resolveExistingSupplierId(
  db: D1Database,
  tenantId: string,
  rawName: string | null | undefined
): Promise<string | null> {
  const trimmed = (rawName || '').trim();
  if (!trimmed) return null;
  if (!isPlausibleSupplierName(trimmed)) return null;

  const normalized = normalizeSupplierName(trimmed);
  const slug = slugify(trimmed);

  // 1. Exact slug match — cheap and indexed.
  const bySlug = await db
    .prepare('SELECT id FROM suppliers WHERE tenant_id = ? AND slug = ?')
    .bind(tenantId, slug)
    .first<{ id: string }>();
  if (bySlug) return bySlug.id;

  // 2. Exact case-insensitive name match.
  const byName = await db
    .prepare(
      'SELECT id FROM suppliers WHERE tenant_id = ? AND LOWER(name) = LOWER(?)'
    )
    .bind(tenantId, trimmed)
    .first<{ id: string }>();
  if (byName) return byName.id;

  // 3. Normalized-name + alias scan (read-only).
  const allRows = await db
    .prepare('SELECT id, name, aliases FROM suppliers WHERE tenant_id = ?')
    .bind(tenantId)
    .all<ExistingSupplier>();

  for (const row of allRows.results || []) {
    if (normalizeSupplierName(row.name) === normalized) {
      return row.id;
    }
    const aliases = parseAliases(row.aliases);
    for (const alias of aliases) {
      if (
        alias.toLowerCase() === trimmed.toLowerCase() ||
        normalizeSupplierName(alias) === normalized
      ) {
        return row.id;
      }
    }
  }

  return null;
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
  if (!isPlausibleSupplierName(trimmed)) {
    throw new ImplausibleSupplierNameError(trimmed);
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

export interface MergeSuppliersResult {
  winnerId: string;
  reassigned: Record<string, number>;
  foldedAliases: string[];
}

/**
 * Conservatively merge one or more loser suppliers into a winner. This is an
 * explicit, operator-driven operation (NOT fuzzy auto-merge): every FK row
 * pointing at a loser is reassigned to the winner, the losers' names + aliases
 * are folded into the winner's aliases, and the loser rows are deleted.
 *
 * Reassign list (verified against migrations/*.sql):
 *   Plain supplier_id (no unique collision):
 *     documents, products, lots, processing_queue, connectors
 *   Unique-constrained (UPDATE OR IGNORE then DELETE leftovers):
 *     product_suppliers, extraction_templates, supplier_extraction_instructions,
 *     reviewer_field_picks, reviewer_field_dismissals, reviewer_table_edits
 *
 * The suppliers_fts AFTER DELETE trigger cleans the search index automatically.
 */
export async function mergeSuppliers(
  db: D1Database,
  tenantId: string,
  opts: { winnerId: string; loserIds: string[]; actor: { userId: string; ip: string | null } }
): Promise<MergeSuppliersResult> {
  const { winnerId, loserIds, actor } = opts;

  const winner = await db
    .prepare('SELECT id, name, aliases FROM suppliers WHERE id = ? AND tenant_id = ?')
    .bind(winnerId, tenantId)
    .first<ExistingSupplier>();
  if (!winner) {
    throw new Error(`winner supplier ${winnerId} not found in tenant ${tenantId}`);
  }

  // Tables with a plain supplier_id column. All carry tenant_id, so the
  // reassign is scoped to the tenant defensively.
  const plainTables = ['documents', 'products', 'lots', 'processing_queue', 'connectors'];
  // Tables with a UNIQUE constraint that can collide when both winner and loser
  // already have an equivalent row. UPDATE OR IGNORE moves what it can, then we
  // delete the leftovers the winner already covered.
  const uniqueTables = [
    'product_suppliers',
    'extraction_templates',
    'supplier_extraction_instructions',
    'reviewer_field_picks',
    'reviewer_field_dismissals',
    'reviewer_table_edits',
  ];

  const reassigned: Record<string, number> = {};
  const foldedAliases: string[] = [];

  // Seed the winner's alias set (case-insensitive) so we don't re-add dups.
  const winnerAliases = parseAliases(winner.aliases);
  const aliasLower = new Set<string>([
    winner.name.toLowerCase(),
    ...winnerAliases.map((a) => a.toLowerCase()),
  ]);

  for (const loserId of loserIds) {
    if (loserId === winnerId) continue;

    const loser = await db
      .prepare('SELECT id, name, aliases FROM suppliers WHERE id = ? AND tenant_id = ?')
      .bind(loserId, tenantId)
      .first<ExistingSupplier>();
    if (!loser) continue; // not in this tenant (or already gone) — skip silently

    // NOTE: we count rows with explicit SELECT COUNT(*) rather than reading
    // .meta.changes. Several of these tables (documents in particular) carry
    // AFTER UPDATE FTS/reindex triggers whose own writes inflate .meta.changes,
    // so it can't be trusted as a "rows reassigned" tally.

    // Plain reassign.
    for (const table of plainTables) {
      const before = await db
        .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE supplier_id = ? AND tenant_id = ?`)
        .bind(loserId, tenantId)
        .first<{ c: number }>();
      const n = before?.c ?? 0;
      if (n > 0) {
        await db
          .prepare(`UPDATE ${table} SET supplier_id = ? WHERE supplier_id = ? AND tenant_id = ?`)
          .bind(winnerId, loserId, tenantId)
          .run();
      }
      reassigned[table] = (reassigned[table] || 0) + n;
    }

    // Unique-constrained reassign: move what doesn't collide, drop the rest.
    // "reassigned" = rows that actually moved = (loser rows before) minus
    // (loser rows still present after UPDATE OR IGNORE, i.e. the collisions).
    for (const table of uniqueTables) {
      const before = await db
        .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE supplier_id = ? AND tenant_id = ?`)
        .bind(loserId, tenantId)
        .first<{ c: number }>();
      const beforeN = before?.c ?? 0;

      await db
        .prepare(
          `UPDATE OR IGNORE ${table} SET supplier_id = ? WHERE supplier_id = ? AND tenant_id = ?`
        )
        .bind(winnerId, loserId, tenantId)
        .run();

      const after = await db
        .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE supplier_id = ? AND tenant_id = ?`)
        .bind(loserId, tenantId)
        .first<{ c: number }>();
      const leftover = after?.c ?? 0;

      reassigned[table] = (reassigned[table] || 0) + (beforeN - leftover);

      // Drop the leftovers the winner already covered.
      await db
        .prepare(`DELETE FROM ${table} WHERE supplier_id = ? AND tenant_id = ?`)
        .bind(loserId, tenantId)
        .run();
    }

    // Fold loser name + aliases into winner aliases (case-insensitive dedup).
    const candidates = [loser.name, ...parseAliases(loser.aliases)];
    for (const c of candidates) {
      const key = c.toLowerCase();
      if (aliasLower.has(key)) continue;
      aliasLower.add(key);
      winnerAliases.push(c);
      foldedAliases.push(c);
    }

    // Delete the loser row (FTS cleanup is trigger-driven).
    await db.prepare('DELETE FROM suppliers WHERE id = ?').bind(loserId).run();

    try {
      await logAudit(
        db,
        actor.userId,
        tenantId,
        'supplier.merged',
        'supplier',
        winnerId,
        JSON.stringify({ loser_id: loserId, loser_name: loser.name, winner_id: winnerId }),
        actor.ip
      );
    } catch {
      // Non-fatal.
    }
  }

  // Persist the winner's folded aliases once.
  if (foldedAliases.length > 0) {
    await db
      .prepare("UPDATE suppliers SET aliases = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(JSON.stringify(winnerAliases), winnerId)
      .run();
  }

  return { winnerId, reassigned, foldedAliases };
}
