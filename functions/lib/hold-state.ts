/**
 * Which documents are on hold RIGHT NOW, and what each document's FILE prints
 * (decision C-005, migration 0139).
 *
 * The one read behind every exit's `held` verdict. It lives apart from
 * functions/lib/holds.ts (placing, releasing, listing, notifying) so that
 * functions/lib/sharing-rule.ts can load hold state without importing the
 * module that imports it back for `canReleaseQa`.
 *
 * NOT CAUGHT, ON PURPOSE. If this read fails, the exit that asked fails with
 * it. A sharing check that cannot find out whether a certificate is on hold
 * must not answer "not held".
 *
 * WHAT HOLDS A DOCUMENT'S FILE. Three things, all read here:
 *
 *   1. A HOLD PLACED ON THE DOCUMENT: on the whole certificate, or on one of
 *      its lot rows.
 *   2. A HOLD ON A LOT THE DOCUMENT CARRIES (C-086). A lot hold is on the
 *      `lots` ROW, not on one certificate's mention of it: every certificate
 *      linked to that row (`document_lots`) is held -- a re-scan, a "Keep
 *      both" duplicate, a corrected certificate -- from the moment it is
 *      linked. The hold still names the certificate it was placed from. A
 *      WHOLE-CERTIFICATE hold (no lot) stays on its one document. A lot row is
 *      tenant + supplier + product + lot + sublot: a hold on one row does not
 *      reach a different sublot's row.
 *   3. A HOLD ON ANOTHER DOCUMENT WHOSE LOT THIS FILE PRINTS (C-084). A
 *      multi-lot certificate is filed as one document per lot, each a cut of
 *      the pages its record was read from. When two lots share a page, or a
 *      file could not be cut and holds the whole certificate, sending one
 *      lot's file sends the held lot's results with it.
 *
 * WHICH FILE A DOCUMENT IS (C-085). The file is the document's CURRENT VERSION,
 * and the queue item it was cut from is `document_versions.source_queue_id` of
 * that version -- NOT `documents.origin_queue_id`, which names the queue item
 * the document was born from and does not move when the certificate is
 * reissued through "Replace existing".
 *
 * "CANNOT TELL" TIGHTENS. A file whose pages are not recorded is treated as
 * printing its neighbour's lot.
 */

import { holdLotLabel } from '../../shared/holds';
import type { HoldSource } from '../../shared/holds';
import type { DocumentHoldBrief } from '../../shared/types';
import { queueIdFromExternalRef } from './intake/duplicates';

const IN_CHUNK = 80;

function chunks<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface ActiveHoldRow {
  id: string;
  document_id: string;
  lot_id: string | null;
  reason: string;
  source: HoldSource;
  placed_at: string;
  lot_number: string | null;
  sub_lot_code: string | null;
  document_title?: string | null;
}

export function holdBrief(r: {
  id: string;
  document_id: string;
  lot_id: string | null;
  reason: string;
  source: HoldSource;
  placed_at: string;
  lot_number?: string | null;
  sub_lot_code?: string | null;
  document_title?: string | null;
}): DocumentHoldBrief {
  return {
    id: r.id,
    document_id: r.document_id,
    document_title: r.document_title ?? null,
    lot_id: r.lot_id ?? null,
    lot_label: r.lot_id ? holdLotLabel(r) : null,
    reason: r.reason,
    source: r.source,
    placed_at: r.placed_at,
  };
}

// ---------------------------------------------------------------------------
// What a document's file prints
// ---------------------------------------------------------------------------

/** What a document's CURRENT file is known to print. */
export interface FilePages {
  /** The Review Queue item the CURRENT version was cut from, when it was. */
  queue_id: string | null;
  /**
   * Every queue item any version of the document was written from. A file cut
   * from one of these that is not the current one printed this document's lot
   * as it stood then; which pages is no longer recorded.
   */
  queue_ids?: string[];
  /** True when the file is a page-scoped cut; false = the whole binary. */
  page_scoped: boolean;
  /** The pages of the original the file prints, or null when not recorded. */
  pages: number[] | null;
}

function parsePages(raw: unknown): number[] | null {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(v)) return null;
    const pages = v.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
    return pages.length > 0 ? pages : null;
  } catch {
    return null;
  }
}

interface FileRow {
  id: string;
  current_version?: number | null;
  /** `source_queue_id` of the current version. */
  version_queue_id?: string | null;
  /** Every version's `source_queue_id`, comma separated. */
  version_queue_ids?: string | null;
  origin_queue_id?: string | null;
  external_ref?: string | null;
  page_scoped?: unknown;
  scoped_pages?: unknown;
  source_pages?: unknown;
}

export function filePagesOf(row: Omit<FileRow, 'id'>): FilePages {
  // The current version's own queue item. A version 1 written before 0139
  // recorded it falls back to where the document was born; a LATER version
  // with nothing recorded was uploaded by hand and came from no queue item.
  const born = row.origin_queue_id || queueIdFromExternalRef(row.external_ref ?? null);
  const current = row.version_queue_id || ((Number(row.current_version) || 1) <= 1 ? born : null) || null;
  const all = new Set<string>((row.version_queue_ids ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  if (born) all.add(born);
  if (current) all.add(current);
  return {
    queue_id: current,
    queue_ids: [...all],
    page_scoped: Number(row.page_scoped) === 1,
    pages: parsePages(row.scoped_pages) ?? parsePages(row.source_pages),
  };
}

/**
 * Does `file` print the lot that `held` is filed under? PURE.
 *
 *   - `file` was cut from no queue item, or the two share none: no;
 *   - the same queue item wrote both CURRENT versions:
 *       `file` is the whole binary -> yes, it prints every lot;
 *       both page lists known     -> yes when they share a page;
 *       anything not recorded     -> yes. Cannot tell tightens;
 *   - `file` was cut from a queue item that wrote an EARLIER version of
 *     `held` (the held certificate has since been reissued): yes. Which page
 *     the lot was on then is no longer recorded.
 */
export function fileCarriesLot(file: FilePages, held: FilePages): boolean {
  if (!file.queue_id) return false;
  if (held.queue_id && file.queue_id === held.queue_id) {
    if (!file.page_scoped) return true;
    if (!file.pages || !held.pages) return true;
    return file.pages.some((p) => held.pages!.includes(p));
  }
  return (held.queue_ids ?? []).includes(file.queue_id);
}

const FILE_COLUMNS = `d.id, d.current_version, d.origin_queue_id, d.external_ref,
       (SELECT dv.source_queue_id FROM document_versions dv
         WHERE dv.document_id = d.id AND dv.version_number = d.current_version) AS version_queue_id,
       (SELECT group_concat(DISTINCT dv.source_queue_id) FROM document_versions dv
         WHERE dv.document_id = d.id AND dv.source_queue_id IS NOT NULL) AS version_queue_ids,
       CASE WHEN json_valid(d.extended_metadata) THEN json_extract(d.extended_metadata, '$.page_scoped') END AS page_scoped,
       CASE WHEN json_valid(d.extended_metadata) THEN json_extract(d.extended_metadata, '$.scoped_pages') END AS scoped_pages,
       CASE WHEN json_valid(d.extended_metadata) THEN json_extract(d.extended_metadata, '$.source_pages') END AS source_pages`;

/** What each document's current file prints. TENANT SCOPED. */
export async function loadFilePages(
  db: D1Database,
  tenantId: string,
  documentIds: string[],
): Promise<Map<string, FilePages>> {
  const out = new Map<string, FilePages>();
  const ids = [...new Set(documentIds.filter(Boolean))];
  for (const part of chunks(ids)) {
    const res = await db
      .prepare(
        `SELECT ${FILE_COLUMNS}
           FROM documents d
          WHERE d.tenant_id = ? AND d.id IN (${part.map(() => '?').join(', ')})`,
      )
      .bind(tenantId, ...part)
      .all<FileRow>();
    for (const r of res.results ?? []) out.set(r.id, filePagesOf(r));
  }
  return out;
}

/**
 * EVERY DOCUMENT OF THE ORGANIZATION ON A REVIEW QUEUE ITEM'S FILE: one with
 * ANY version written from it (`document_versions.source_queue_id`, 0139), or
 * born from it (`origin_queue_id`, or the queue id inside `external_ref`, for a
 * version nothing was recorded on). Deleted documents count: a part that was
 * deleted is still on the page.
 *
 * "Any version", not only the current one, on purpose: a certificate reissued
 * since still had its lot printed on the earlier file.
 */
export async function documentsOnQueueFiles(
  db: D1Database,
  tenantId: string,
  queueIds: string[],
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const ids = [...new Set(queueIds.filter(Boolean))];
  for (const q of ids) out.set(q, new Set<string>());
  // 2 + 4n binds per statement, and D1 binds at most 100.
  for (const part of chunks(ids, 20)) {
    const marks = part.map(() => '?').join(', ');
    const refs = part.map(() => `(d.external_ref = 'queue-' || ? OR d.external_ref LIKE 'queue-' || ? || '-%')`).join(' OR ');
    const res = await db
      .prepare(
        `SELECT DISTINCT d.id AS document_id, dv.source_queue_id AS queue_id, NULL AS external_ref
           FROM document_versions dv
           JOIN documents d ON d.id = dv.document_id
          WHERE d.tenant_id = ? AND dv.source_queue_id IN (${marks})
         UNION
         SELECT d.id AS document_id, d.origin_queue_id AS queue_id, d.external_ref AS external_ref
           FROM documents d
          WHERE d.tenant_id = ? AND (d.origin_queue_id IN (${marks}) OR ${refs})`,
      )
      .bind(tenantId, ...part, tenantId, ...part, ...part.flatMap((q) => [q, q]))
      .all<{ document_id: string; queue_id: string | null; external_ref: string | null }>();
    for (const r of res.results ?? []) {
      // Born from it by either mark: the origin column, or (before 0130) the
      // queue id inside external_ref.
      for (const q of [r.queue_id, queueIdFromExternalRef(r.external_ref)]) {
        if (q) out.get(q)?.add(r.document_id);
      }
    }
  }
  return out;
}

/**
 * For each document, the OTHER documents whose lot its file prints (C-084):
 * neighbours cut from the same queue item that share a page with it, or all of
 * them when the file is the whole binary. Used for holds AND for the sharing
 * rule (C-088): a file takes the strictest of everything it prints.
 */
export async function loadPrintedNeighbours(
  db: D1Database,
  tenantId: string,
  documentIds: string[],
  known?: Map<string, FilePages>,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const ids = [...new Set(documentIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const pageMap = known ?? (await loadFilePages(db, tenantId, ids));
  const queues = [...new Set(ids.map((id) => pageMap.get(id)?.queue_id).filter((q): q is string => Boolean(q)))];
  if (queues.length === 0) return out;
  const onQueue = await documentsOnQueueFiles(db, tenantId, queues);
  const others = [...new Set([...onQueue.values()].flatMap((s) => [...s]))].filter((id) => !pageMap.has(id));
  const neighbourFiles = others.length > 0 ? await loadFilePages(db, tenantId, others) : new Map<string, FilePages>();
  const fileOf = (id: string) => pageMap.get(id) ?? neighbourFiles.get(id);
  for (const id of ids) {
    const file = pageMap.get(id);
    if (!file?.queue_id) continue;
    const printed: string[] = [];
    for (const other of onQueue.get(file.queue_id) ?? []) {
      if (other === id) continue;
      const otherFile = fileOf(other);
      if (otherFile && fileCarriesLot(file, otherFile)) printed.push(other);
    }
    if (printed.length > 0) out.set(id, printed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Everything that holds a document's file
// ---------------------------------------------------------------------------

/**
 * EVERYTHING THAT HOLDS EACH DOCUMENT'S FILE, in the order a person should
 * read it: holds placed on the document; holds on a lot row it carries, placed
 * from another certificate (C-086); holds on a neighbour whose lot its file
 * prints (C-084). This is what every exit judges. Each hold keeps the
 * `document_id` (and title) of the certificate it was PLACED from.
 */
export async function loadEffectiveHolds(
  db: D1Database,
  tenantId: string,
  documentIds: string[],
  known?: { pages?: Map<string, FilePages>; neighbours?: Map<string, string[]> },
): Promise<Map<string, DocumentHoldBrief[]>> {
  const out = new Map<string, DocumentHoldBrief[]>();
  const ids = [...new Set(documentIds.filter((id) => typeof id === 'string' && id))];
  if (ids.length === 0) return out;

  // Every active hold of the organization. Holds are few, and one read here
  // replaces one per document, per lot and per neighbour.
  const res = await db
    .prepare(
      `SELECT h.id, h.document_id, h.lot_id, h.reason, h.source, h.placed_at,
              l.lot_number, l.sub_lot_code, d.title AS document_title,
              (SELECT l2.lot_number || CASE WHEN COALESCE(l2.sub_lot_code, '') != '' THEN ' / ' || l2.sub_lot_code ELSE '' END
                 FROM document_lots dl JOIN lots l2 ON l2.id = dl.lot_id
                WHERE dl.document_id = h.document_id
                ORDER BY l2.lot_number LIMIT 1) AS document_lot_label
         FROM document_holds h
         JOIN documents d ON d.id = h.document_id AND d.tenant_id = h.tenant_id
         LEFT JOIN lots l ON l.id = h.lot_id AND l.tenant_id = h.tenant_id
        WHERE h.tenant_id = ? AND h.released_at IS NULL
        ORDER BY h.placed_at ASC, h.rowid ASC`,
    )
    .bind(tenantId)
    .all<ActiveHoldRow & { document_lot_label: string | null }>();
  const all = res.results ?? [];
  if (all.length === 0) return out;

  const briefs = all.map((r) => {
    const b = holdBrief(r);
    return { brief: b, placedOn: r.document_id, lotId: r.lot_id, documentLotLabel: r.document_lot_label };
  });

  // 2. Which documents carry each held lot row.
  const heldLots = [...new Set(briefs.map((b) => b.lotId).filter((l): l is string => Boolean(l)))];
  const docsOfLot = new Map<string, Set<string>>();
  for (const part of chunks(heldLots)) {
    const links = await db
      .prepare(
        `SELECT dl.lot_id, dl.document_id
           FROM document_lots dl
           JOIN lots l ON l.id = dl.lot_id AND l.tenant_id = ?
           JOIN documents d ON d.id = dl.document_id AND d.tenant_id = ?
          WHERE dl.lot_id IN (${part.map(() => '?').join(', ')})`,
      )
      .bind(tenantId, tenantId, ...part)
      .all<{ lot_id: string; document_id: string }>();
    for (const r of links.results ?? []) {
      const set = docsOfLot.get(r.lot_id) ?? new Set<string>();
      set.add(r.document_id);
      docsOfLot.set(r.lot_id, set);
    }
  }

  // Every document a hold applies to DIRECTLY (1 and 2), own holds first.
  const direct = new Map<string, DocumentHoldBrief[]>();
  const add = (map: Map<string, DocumentHoldBrief[]>, docId: string, brief: DocumentHoldBrief) => {
    const list = map.get(docId) ?? [];
    if (!list.some((x) => x.id === brief.id)) list.push(brief);
    map.set(docId, list);
  };
  for (const b of briefs) add(direct, b.placedOn, b.brief);
  for (const b of briefs) {
    if (!b.lotId) continue;
    for (const docId of docsOfLot.get(b.lotId) ?? []) add(direct, docId, b.brief);
  }

  for (const id of ids) for (const b of direct.get(id) ?? []) add(out, id, b);

  // 3. Holds on a neighbour whose lot this file prints.
  const neighbours = known?.neighbours ?? (await loadPrintedNeighbours(db, tenantId, ids, known?.pages));
  for (const id of ids) {
    for (const other of neighbours.get(id) ?? []) {
      for (const b of direct.get(other) ?? []) {
        // A hold on a neighbour's WHOLE certificate still names that lot here.
        const from = briefs.find((x) => x.brief.id === b.id);
        const brief = !b.lot_label && from?.documentLotLabel ? { ...b, lot_label: from.documentLotLabel } : b;
        add(out, id, brief);
      }
    }
  }
  return out;
}

/**
 * The hold a LINE for one lot row should name: the one on that lot when there
 * is one, else the first. Any of them stops the file; this only picks which
 * reason the person reads first.
 */
export function holdForLot(holds: readonly DocumentHoldBrief[] | undefined, lotId: string | null | undefined): DocumentHoldBrief | null {
  if (!holds || holds.length === 0) return null;
  return (lotId ? holds.find((h) => h.lot_id === lotId) : undefined) ?? holds[0];
}

/**
 * Mark the rows of a result list that are on hold: sets `active_hold` (the
 * first hold that stops the file) on each held row and touches nothing else. A
 * row that is not held gains no key at all.
 *
 * DISPLAY ONLY. Search calls this AFTER it has produced its answer: a hold is
 * not a search field, filters nothing, and changes no coverage judgement. A
 * failure here leaves the list as it was -- unlike an exit, a result row that
 * is missing a chip has let nothing out.
 */
export async function attachActiveHolds<T extends { id?: unknown }>(
  db: D1Database,
  tenantId: string,
  rows: T[] | null | undefined,
): Promise<void> {
  if (!rows || rows.length === 0) return;
  try {
    const ids = rows.map((r) => r.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
    const holds = await loadEffectiveHolds(db, tenantId, ids);
    if (holds.size === 0) return;
    for (const r of rows) {
      const list = typeof r.id === 'string' ? holds.get(r.id) : undefined;
      if (list && list.length > 0) (r as Record<string, unknown>).active_hold = list[0];
    }
  } catch (err) {
    console.error('[holds] marking held result rows failed:', err instanceof Error ? err.message : String(err));
  }
}
