/**
 * document_search_keys (migration 0122): writing the rows, and keeping them
 * fresh.
 *
 * Triggers on documents / document_lots / lots enqueue a `search_reindex_jobs`
 * row of kind 'document_keys' (0055's queue, one pending row per document).
 * Nothing computes keys inside the writing statement — the deriver is
 * TypeScript (ambiguous dates, lot normalization), not SQL. Two things drain
 * the queue:
 *
 *   - every search that reads keys (read-repair, `drainDocumentKeyJobs` with a
 *     tenant and a small cap), so a search never quietly answers from stale
 *     keys — and reports `keys_pending` when it could not catch up;
 *   - bin/backfill-search-keys, for the whole history at once.
 *
 * The FTS drainer (search-reindex.ts) leaves these jobs alone: its job is
 * documents_fts, and counting a key rebuild as an FTS re-emit would lie in its
 * metrics.
 */

import { deriveSearchKeys, type DerivedSearchKey, type SearchKeyLot } from '../../../shared/searchKeys';

export const DOCUMENT_KEYS_JOB = 'document_keys';

/** Rows per multi-row INSERT: 10 columns each, under D1's 100 bound parameters. */
const ROWS_PER_INSERT = 9;
const ID_CHUNK = 80;

function parseObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface KeyDocRow {
  id: string;
  tenant_id: string;
  primary_metadata: string | null;
  extended_lite: string | null;
}

export interface KeyLotRow {
  document_id: string;
  lot_id: string;
  lot_number: string | null;
  sub_lot_code: string | null;
  code_date: string | null;
  expiration_date: string | null;
}

/** The keys one document states, from rows as read (pure; shared with the backfill). */
export function keysForDocument(doc: KeyDocRow, lots: KeyLotRow[]): DerivedSearchKey[] {
  const metadata = { ...parseObject(doc.extended_lite), ...parseObject(doc.primary_metadata) };
  const lotRows: SearchKeyLot[] = lots.map((l) => ({
    lot_id: l.lot_id, lot_number: l.lot_number, sub_lot_code: l.sub_lot_code, code_date: l.code_date, expiration_date: l.expiration_date,
  }));
  return deriveSearchKeys(metadata, lotRows);
}

const DOC_SELECT = (n: number) => `SELECT d.id, d.tenant_id, d.primary_metadata,
       CASE WHEN json_valid(d.extended_metadata) THEN json_remove(d.extended_metadata, '$.tables') END AS extended_lite
  FROM documents d WHERE d.id IN (${Array(n).fill('?').join(',')})`;
const LOT_SELECT = (n: number) => `SELECT dl.document_id, l.id AS lot_id, l.lot_number, l.sub_lot_code, l.code_date, l.expiration_date
  FROM document_lots dl JOIN lots l ON l.id = dl.lot_id WHERE dl.document_id IN (${Array(n).fill('?').join(',')})`;

/** The write statements that replace these documents' keys (one atomic batch). */
export function keyWriteStatements(db: D1Database, docs: KeyDocRow[], lots: KeyLotRow[]): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  const ids = docs.map((d) => d.id);
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    stmts.push(db.prepare(`DELETE FROM document_search_keys WHERE document_id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk));
  }
  const byDoc = new Map<string, KeyLotRow[]>();
  for (const l of lots) byDoc.set(l.document_id, [...(byDoc.get(l.document_id) ?? []), l]);
  const rows: unknown[][] = [];
  for (const d of docs) {
    for (const k of keysForDocument(d, byDoc.get(d.id) ?? [])) {
      rows.push([d.tenant_id, d.id, k.lot_id, k.kind, k.value_raw.slice(0, 500), k.value_norm.slice(0, 200), k.value_date, k.provenance, k.source_field]);
    }
  }
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + ROWS_PER_INSERT);
    stmts.push(
      db.prepare(
        `INSERT INTO document_search_keys (tenant_id, document_id, lot_id, kind, value_raw, value_norm, value_date, provenance, source_field)
         VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      ).bind(...chunk.flat()),
    );
  }
  return stmts;
}

export interface KeyDrainResult {
  /** Documents whose keys were rebuilt. */
  drained: number;
  /** Pending jobs left for this tenant (capped at `maxJobs + 1` when counting). */
  remaining: number;
  statements: number;
  roundTrips: number;
}

/**
 * Rebuild keys for up to `maxJobs` pending 'document_keys' jobs (one tenant, or
 * all). Claim + read is one atomic batch and write + complete is another, so a
 * change that lands mid-drain enqueues a NEW pending row (0055's uniqueness is
 * on pending rows only) rather than being lost under a stale 'completed'.
 *
 * `pendingIds` lets a caller that already read the pending list (the search
 * executor reads it inside its first batch) skip the extra round trip.
 */
export async function drainDocumentKeyJobs(
  db: D1Database,
  opts: { tenantId?: string; maxJobs?: number; pending?: Array<{ id: string; entity_id: string }> } = {},
): Promise<KeyDrainResult> {
  const maxJobs = opts.maxJobs ?? 100;
  let statements = 0;
  let roundTrips = 0;
  let pending = opts.pending;
  if (!pending) {
    const res = await db
      .prepare(
        `SELECT id, entity_id FROM search_reindex_jobs
          WHERE entity_kind = 'document_keys' AND status = 'pending' ${opts.tenantId ? 'AND tenant_id = ?' : ''}
          ORDER BY created_at LIMIT ?`,
      )
      .bind(...(opts.tenantId ? [opts.tenantId] : []), maxJobs + 1)
      .all<{ id: string; entity_id: string }>();
    statements += 1;
    roundTrips += 1;
    pending = res.results ?? [];
  }
  const take = pending.slice(0, maxJobs);
  const remaining = Math.max(0, pending.length - take.length);
  if (take.length === 0) return { drained: 0, remaining, statements, roundTrips };

  const jobIds = take.map((j) => j.id);
  const docIds = [...new Set(take.map((j) => j.entity_id))];
  const read: D1PreparedStatement[] = [];
  for (let i = 0; i < jobIds.length; i += ID_CHUNK) {
    const chunk = jobIds.slice(i, i + ID_CHUNK);
    read.push(db.prepare(`UPDATE search_reindex_jobs SET status = 'processing' WHERE status = 'pending' AND id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk));
  }
  const docStart = read.length;
  for (let i = 0; i < docIds.length; i += ID_CHUNK) {
    const chunk = docIds.slice(i, i + ID_CHUNK);
    read.push(db.prepare(DOC_SELECT(chunk.length)).bind(...chunk));
    read.push(db.prepare(LOT_SELECT(chunk.length)).bind(...chunk));
  }
  const readRes = await db.batch(read);
  statements += read.length;
  roundTrips += 1;
  const docs: KeyDocRow[] = [];
  const lots: KeyLotRow[] = [];
  for (let i = docStart; i < readRes.length; i += 2) {
    docs.push(...((readRes[i].results ?? []) as KeyDocRow[]));
    lots.push(...((readRes[i + 1].results ?? []) as KeyLotRow[]));
  }

  const write = keyWriteStatements(db, docs, lots);
  // A job whose document is gone has nothing to write; it completes all the same.
  for (let i = 0; i < jobIds.length; i += ID_CHUNK) {
    const chunk = jobIds.slice(i, i + ID_CHUNK);
    write.push(db.prepare(
      `UPDATE search_reindex_jobs SET status = 'completed', processed_at = datetime('now'), last_error = NULL
        WHERE status = 'processing' AND id IN (${chunk.map(() => '?').join(',')})`,
    ).bind(...chunk));
  }
  await db.batch(write);
  statements += write.length;
  roundTrips += 1;
  return { drained: docs.length, remaining, statements, roundTrips };
}

/** Rebuild keys for named documents now (tests, and callers that just wrote). */
export async function rebuildDocumentKeys(db: D1Database, docIds: string[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < docIds.length; i += ID_CHUNK) {
    const chunk = docIds.slice(i, i + ID_CHUNK);
    const [d, l] = await db.batch([db.prepare(DOC_SELECT(chunk.length)).bind(...chunk), db.prepare(LOT_SELECT(chunk.length)).bind(...chunk)]);
    const docs = (d.results ?? []) as KeyDocRow[];
    const stmts = keyWriteStatements(db, docs, (l.results ?? []) as KeyLotRow[]);
    stmts.push(db.prepare(
      `UPDATE search_reindex_jobs SET status = 'completed', processed_at = datetime('now')
        WHERE entity_kind = 'document_keys' AND status = 'pending' AND entity_id IN (${chunk.map(() => '?').join(',')})`,
    ).bind(...chunk));
    await db.batch(stmts);
    n += docs.length;
  }
  return n;
}
