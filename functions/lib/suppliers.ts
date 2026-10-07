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
 *     reviewer_field_picks, reviewer_field_dismissals, reviewer_table_edits,
 *     product_requirements (0123), supplier_requirements (0087)
 *   Requests (plain): document_requests, request_links, request_uploads,
 *     renewal_requests (0133)
 *   Contacts (0133): supplier_contacts, one per address, one document contact
 *   Facilities (0135): supplier_facilities, one per name; items re-pointed
 *
 * THE REQUEST TABLES WERE MISSING FROM THIS LIST UNTIL 0133, and every one of
 * them references suppliers ON DELETE CASCADE. A merge therefore DELETED every
 * request issued to the loser, the link the supplier was holding, the files
 * they had sent through it and the checklist of what they owe - silently, as
 * a side effect of the DELETE at the bottom. Anything added to the schema with
 * a supplier_id and ON DELETE CASCADE has to be added here in the same change
 * (tests/api/supplier-merge-requests.test.ts).
 *
 * The suppliers_fts AFTER DELETE trigger cleans the search index automatically.
 */
/**
 * Move one loser's supplier-scoped spec limits (0084) and required analytes
 * (0109) to the winner.
 *
 * Both reference suppliers ON DELETE CASCADE and were in no move list, so a
 * merge deleted them with the loser: every tighter limit written for that
 * supplier and every analyte its certificates were required to report.
 *
 * A LIMIT IS NEVER DROPPED QUIETLY. Where the winner already holds a row for
 * the same key -- `spec_limits` is unique on (tenant, analyte, COALESCEd
 * supplier / document type / product), 0086; `supplier_required_analytes` on
 * (tenant, supplier, document type, analyte) -- the winner's row is the one
 * kept, and the loser's WHOLE row is returned for the `supplier.merged` audit
 * details with the id of the winner's row that stood in for it. Which of two
 * thresholds is right is a person's call; the merge only makes sure both are
 * still written down somewhere.
 *
 * `UPDATE OR IGNORE` moves what does not collide (it honours the expression
 * index); whatever is still on the loser afterwards is, by construction, the
 * collisions. Moved rows keep their ids, so a frozen `limit_snapshot` and a
 * `document_spec_gaps.required_analyte_id` still point at something.
 */
async function moveSpecWatch(
  db: D1Database,
  tenantId: string,
  winnerId: string,
  loserId: string,
  reassigned: Record<string, number>,
): Promise<{ limits: Array<Record<string, unknown>>; analytes: Array<Record<string, unknown>> }> {
  const dropped = { limits: [] as Array<Record<string, unknown>>, analytes: [] as Array<Record<string, unknown>> };
  const tables = [
    {
      table: 'spec_limits',
      into: dropped.limits,
      keptAs: 'kept_winner_limit_id',
      twin: `SELECT id FROM spec_limits
              WHERE tenant_id = ? AND supplier_id = ? AND spec_test_id = ?
                AND COALESCE(document_type_id, '') = COALESCE(?, '')
                AND COALESCE(product_id, '') = COALESCE(?, '')`,
      twinKey: (r: Record<string, unknown>) => [r.spec_test_id, r.document_type_id ?? null, r.product_id ?? null],
    },
    {
      table: 'supplier_required_analytes',
      into: dropped.analytes,
      keptAs: 'kept_winner_row_id',
      twin: `SELECT id FROM supplier_required_analytes
              WHERE tenant_id = ? AND supplier_id = ? AND spec_test_id = ? AND document_type_id = ?`,
      twinKey: (r: Record<string, unknown>) => [r.spec_test_id, r.document_type_id],
    },
  ];
  for (const t of tables) {
    try {
      const before = await db
        .prepare(`SELECT COUNT(*) AS c FROM ${t.table} WHERE supplier_id = ? AND tenant_id = ?`)
        .bind(loserId, tenantId)
        .first<{ c: number }>();
      const beforeN = before?.c ?? 0;
      if (beforeN === 0) {
        reassigned[t.table] = reassigned[t.table] || 0;
        continue;
      }
      await db
        .prepare(`UPDATE OR IGNORE ${t.table} SET supplier_id = ? WHERE supplier_id = ? AND tenant_id = ?`)
        .bind(winnerId, loserId, tenantId)
        .run();
      const left = await db
        .prepare(`SELECT * FROM ${t.table} WHERE supplier_id = ? AND tenant_id = ?`)
        .bind(loserId, tenantId)
        .all<Record<string, unknown>>();
      const leftovers = left.results ?? [];
      for (const row of leftovers) {
        const twin = await db.prepare(t.twin).bind(tenantId, winnerId, ...t.twinKey(row)).first<{ id: string }>();
        t.into.push({ ...row, [t.keptAs]: twin?.id ?? null });
      }
      reassigned[t.table] = (reassigned[t.table] || 0) + (beforeN - leftovers.length);
      if (leftovers.length > 0) {
        await db.prepare(`DELETE FROM ${t.table} WHERE supplier_id = ? AND tenant_id = ?`).bind(loserId, tenantId).run();
      }
    } catch {
      // A database that predates the table (0084 / 0109): nothing to move.
    }
  }
  return dropped;
}

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
  const plainTables = [
    'documents',
    'products',
    'lots',
    'processing_queue',
    'connectors',
    // What was asked of the supplier and what came back. None has a UNIQUE
    // that involves supplier_id, so they move as they are; lines, routing and
    // upload claims hang off the request / upload ids and follow untouched.
    'document_requests',
    'request_links',
    'request_uploads',
    // Teach interviews (0070): keyed on the session id, so they move as they
    // are and their messages (CASCADE from the session) come with them.
    'teach_sessions',
  ];
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
    'product_requirements',
    // 0087: UNIQUE(tenant, supplier, requirement). Where both owe the same
    // requirement the winner's row (its tier, its provenance) is the one kept.
    'supplier_requirements',
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

    // Spec limits (0084) and required analytes (0109): moved, and a row the
    // winner already covers is recorded in the audit row below, never dropped.
    const droppedSpecWatch = await moveSpecWatch(db, tenantId, winnerId, loserId, reassigned);

    // Renewal cycles (0133) are keyed (document, due date), not on the
    // supplier, so they move as they are. Guarded like the contacts below: a
    // database that has not run 0133 has neither table.
    try {
      const cycles = await db
        .prepare('SELECT COUNT(*) AS c FROM renewal_requests WHERE supplier_id = ? AND tenant_id = ?')
        .bind(loserId, tenantId)
        .first<{ c: number }>();
      const n = cycles?.c ?? 0;
      if (n > 0) {
        await db
          .prepare('UPDATE renewal_requests SET supplier_id = ? WHERE supplier_id = ? AND tenant_id = ?')
          .bind(winnerId, loserId, tenantId)
          .run();
      }
      reassigned.renewal_requests = (reassigned.renewal_requests || 0) + n;
    } catch {
      // Pre-0133 database.
    }

    // Contacts (0133). UNIQUE(supplier_id, email_norm), plus at most one
    // active document contact per supplier. The winner's document contact
    // stays the document contact: the loser's is demoted BEFORE the move so
    // the partial unique index cannot refuse it, and an address both have is
    // kept once, as the winner's row.
    try {
      const before = await db
        .prepare('SELECT COUNT(*) AS c FROM supplier_contacts WHERE supplier_id = ? AND tenant_id = ?')
        .bind(loserId, tenantId)
        .first<{ c: number }>();
      const beforeN = before?.c ?? 0;
      if (beforeN > 0) {
        const winnerHasDocumentContact = await db
          .prepare(
            `SELECT id FROM supplier_contacts
              WHERE supplier_id = ? AND tenant_id = ? AND is_document_contact = 1 AND active = 1`,
          )
          .bind(winnerId, tenantId)
          .first<{ id: string }>();
        if (winnerHasDocumentContact) {
          await db
            .prepare('UPDATE supplier_contacts SET is_document_contact = 0 WHERE supplier_id = ? AND tenant_id = ?')
            .bind(loserId, tenantId)
            .run();
        }
        await db
          .prepare('UPDATE OR IGNORE supplier_contacts SET supplier_id = ? WHERE supplier_id = ? AND tenant_id = ?')
          .bind(winnerId, loserId, tenantId)
          .run();
        const after = await db
          .prepare('SELECT COUNT(*) AS c FROM supplier_contacts WHERE supplier_id = ? AND tenant_id = ?')
          .bind(loserId, tenantId)
          .first<{ c: number }>();
        const leftover = after?.c ?? 0;
        reassigned.supplier_contacts = (reassigned.supplier_contacts || 0) + (beforeN - leftover);
        await db
          .prepare('DELETE FROM supplier_contacts WHERE supplier_id = ? AND tenant_id = ?')
          .bind(loserId, tenantId)
          .run();
      }
    } catch {
      // Pre-0133 database: no contacts table.
    }

    // Facilities (0135). UNIQUE(supplier_id, name_norm): a facility both have
    // is kept once, as the winner's row, and the items that named the loser's
    // copy are re-pointed at it FIRST -- the delete would otherwise SET NULL
    // their facility and lose which plant they come from.
    try {
      const before = await db
        .prepare('SELECT COUNT(*) AS c FROM supplier_facilities WHERE supplier_id = ? AND tenant_id = ?')
        .bind(loserId, tenantId)
        .first<{ c: number }>();
      const beforeN = before?.c ?? 0;
      if (beforeN > 0) {
        await db
          .prepare(
            `UPDATE product_suppliers
                SET facility_id = (SELECT w.id FROM supplier_facilities w
                                     JOIN supplier_facilities l ON l.name_norm = w.name_norm
                                    WHERE l.id = product_suppliers.facility_id AND w.supplier_id = ?)
              WHERE facility_id IN (SELECT l.id FROM supplier_facilities l
                                      JOIN supplier_facilities w
                                        ON w.name_norm = l.name_norm AND w.supplier_id = ?
                                     WHERE l.supplier_id = ?)`,
          )
          .bind(winnerId, winnerId, loserId)
          .run();
        await db
          .prepare('UPDATE OR IGNORE supplier_facilities SET supplier_id = ? WHERE supplier_id = ? AND tenant_id = ?')
          .bind(winnerId, loserId, tenantId)
          .run();
        const after = await db
          .prepare('SELECT COUNT(*) AS c FROM supplier_facilities WHERE supplier_id = ? AND tenant_id = ?')
          .bind(loserId, tenantId)
          .first<{ c: number }>();
        const leftover = after?.c ?? 0;
        reassigned.supplier_facilities = (reassigned.supplier_facilities || 0) + (beforeN - leftover);
        await db
          .prepare('DELETE FROM supplier_facilities WHERE supplier_id = ? AND tenant_id = ?')
          .bind(loserId, tenantId)
          .run();
      }
    } catch {
      // Pre-0135 database: no facilities table.
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

    // Declared lot formats (0110) belong to the loser and cannot move: the
    // winner's format governs the merged lots, and version numbers are per
    // supplier. They are removed (their FK would block the delete) and their
    // content goes into the audit row below, so nothing is lost silently.
    let droppedLotSchemes: Array<{ version: number; spec: string; source: string; created_at: string }> = [];
    try {
      const rows = await db
        .prepare('SELECT version, spec, source, created_at FROM supplier_lot_schemes WHERE supplier_id = ? AND tenant_id = ? ORDER BY version')
        .bind(loserId, tenantId)
        .all<{ version: number; spec: string; source: string; created_at: string }>();
      droppedLotSchemes = rows.results ?? [];
      if (droppedLotSchemes.length > 0) {
        await db.prepare('DELETE FROM supplier_lot_schemes WHERE supplier_id = ? AND tenant_id = ?').bind(loserId, tenantId).run();
      }
    } catch {
      // Pre-0110 database: no declarations table.
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
        JSON.stringify({
          loser_id: loserId,
          loser_name: loser.name,
          winner_id: winnerId,
          ...(droppedLotSchemes.length > 0 ? { dropped_lot_schemes: droppedLotSchemes } : {}),
          ...(droppedSpecWatch.limits.length > 0 ? { dropped_spec_limits: droppedSpecWatch.limits } : {}),
          ...(droppedSpecWatch.analytes.length > 0 ? { dropped_required_analytes: droppedSpecWatch.analytes } : {}),
        }),
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
