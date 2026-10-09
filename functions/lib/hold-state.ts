/**
 * Which documents are on hold RIGHT NOW (decision C-005, migration 0139).
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
 * A FILE IS WHAT LEAVES (C-073, C-084). A hold names one lot row or the whole
 * certificate, but what an exit hands over is a file, and a file can print
 * more than the lot it is filed under. So a document is held by:
 *
 *   1. ITS OWN holds: any active hold on the document, on any of its lot rows
 *      (`loadActiveHolds`);
 *   2. THE HOLDS ITS FILE CARRIES: an active hold on ANOTHER document cut from
 *      the same Review Queue item, when this document's file prints that
 *      lot's page too (`loadEffectiveHolds`). A multi-lot certificate is filed
 *      as one document per lot, each with the pages its record was read from.
 *      When the lots are on separate pages each file is its own; when two lots
 *      share a page (a one-page certificate with a row per lot), or a file
 *      could not be cut and holds the whole certificate, sending one lot's
 *      file sends the held lot's results with it.
 *
 * "CANNOT TELL" TIGHTENS. A file whose pages are not recorded is treated as
 * printing the held lot.
 */

import { holdLotLabel } from '../../shared/holds';
import type { HoldSource } from '../../shared/holds';
import type { DocumentHoldBrief } from '../../shared/types';
import { queueIdFromExternalRef } from './intake/duplicates';

const IN_CHUNK = 80;

interface ActiveHoldRow {
  id: string;
  document_id: string;
  lot_id: string | null;
  reason: string;
  source: HoldSource;
  placed_at: string;
  lot_number: string | null;
  sub_lot_code: string | null;
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
}): DocumentHoldBrief {
  return {
    id: r.id,
    document_id: r.document_id,
    lot_id: r.lot_id ?? null,
    lot_label: r.lot_id ? holdLotLabel(r) : null,
    reason: r.reason,
    source: r.source,
    placed_at: r.placed_at,
  };
}

/**
 * The active holds placed ON each document, oldest first, TENANT SCOPED. A
 * document with none is absent from the map. This is what the document's own
 * page lists; an exit asks `loadEffectiveHolds`.
 */
export async function loadActiveHolds(
  db: D1Database,
  tenantId: string,
  documentIds: string[],
): Promise<Map<string, DocumentHoldBrief[]>> {
  const out = new Map<string, DocumentHoldBrief[]>();
  const ids = [...new Set(documentIds.filter((id) => typeof id === 'string' && id))];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const part = ids.slice(i, i + IN_CHUNK);
    const res = await db
      .prepare(
        `SELECT h.id, h.document_id, h.lot_id, h.reason, h.source, h.placed_at,
                l.lot_number, l.sub_lot_code
           FROM document_holds h
           LEFT JOIN lots l ON l.id = h.lot_id
          WHERE h.tenant_id = ? AND h.released_at IS NULL
            AND h.document_id IN (${part.map(() => '?').join(', ')})
          ORDER BY h.placed_at ASC, h.rowid ASC`,
      )
      .bind(tenantId, ...part)
      .all<ActiveHoldRow>();
    for (const r of res.results ?? []) {
      const list = out.get(r.document_id) ?? [];
      list.push(holdBrief(r));
      out.set(r.document_id, list);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The holds a file carries for other lots of the same certificate (C-084)
// ---------------------------------------------------------------------------

/** What a document's file is known to print. */
export interface FilePages {
  /** The Review Queue item the document was cut from, when it was. */
  queue_id: string | null;
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

export function filePagesOf(row: {
  origin_queue_id?: string | null;
  external_ref?: string | null;
  page_scoped?: unknown;
  scoped_pages?: unknown;
  source_pages?: unknown;
}): FilePages {
  return {
    queue_id: row.origin_queue_id || queueIdFromExternalRef(row.external_ref ?? null),
    page_scoped: Number(row.page_scoped) === 1,
    pages: parsePages(row.scoped_pages) ?? parsePages(row.source_pages),
  };
}

/**
 * Does `file` print the lot that `held` is filed under? PURE.
 *
 *   - different certificates (or either not cut from a queue item): no;
 *   - `file` is the whole binary: yes, it prints every lot;
 *   - both page lists known: yes when they share a page;
 *   - anything not recorded: yes. Cannot tell tightens.
 */
export function fileCarriesLot(file: FilePages, held: FilePages): boolean {
  if (!file.queue_id || !held.queue_id || file.queue_id !== held.queue_id) return false;
  if (!file.page_scoped) return true;
  if (!file.pages || !held.pages) return true;
  return file.pages.some((p) => held.pages!.includes(p));
}

const PAGE_COLUMNS = `d.origin_queue_id, d.external_ref,
       CASE WHEN json_valid(d.extended_metadata) THEN json_extract(d.extended_metadata, '$.page_scoped') END AS page_scoped,
       CASE WHEN json_valid(d.extended_metadata) THEN json_extract(d.extended_metadata, '$.scoped_pages') END AS scoped_pages,
       CASE WHEN json_valid(d.extended_metadata) THEN json_extract(d.extended_metadata, '$.source_pages') END AS source_pages`;

type PageRow = Parameters<typeof filePagesOf>[0];

/**
 * EVERYTHING THAT HOLDS EACH DOCUMENT'S FILE: its own active holds first, then
 * the holds on other lots of the same certificate that its file prints. This
 * is what every exit judges. A carried hold keeps the `document_id` of the
 * certificate it is on, and names that lot.
 */
export async function loadEffectiveHolds(
  db: D1Database,
  tenantId: string,
  documentIds: string[],
): Promise<Map<string, DocumentHoldBrief[]>> {
  const ids = [...new Set(documentIds.filter((id) => typeof id === 'string' && id))];
  const out = await loadActiveHolds(db, tenantId, ids);
  if (ids.length === 0) return out;

  // Every active hold of the organization whose certificate was cut from a
  // Review Queue item. Holds are few; this is one read, not one per document.
  const heldRes = await db
    .prepare(
      `SELECT h.id, h.document_id, h.lot_id, h.reason, h.source, h.placed_at,
              l.lot_number, l.sub_lot_code,
              (SELECT l2.lot_number || CASE WHEN COALESCE(l2.sub_lot_code, '') != '' THEN ' / ' || l2.sub_lot_code ELSE '' END
                 FROM document_lots dl JOIN lots l2 ON l2.id = dl.lot_id
                WHERE dl.document_id = h.document_id
                ORDER BY l2.lot_number LIMIT 1) AS document_lot_label,
              ${PAGE_COLUMNS}
         FROM document_holds h
         JOIN documents d ON d.id = h.document_id AND d.tenant_id = h.tenant_id
         LEFT JOIN lots l ON l.id = h.lot_id
        WHERE h.tenant_id = ? AND h.released_at IS NULL
          AND (d.origin_queue_id IS NOT NULL OR d.external_ref LIKE 'queue-%')
        ORDER BY h.placed_at ASC, h.rowid ASC`,
    )
    .bind(tenantId)
    .all<ActiveHoldRow & PageRow & { document_lot_label: string | null }>();
  const held = (heldRes.results ?? []).map((r) => ({ row: r, pages: filePagesOf(r) })).filter((h) => h.pages.queue_id);
  if (held.length === 0) return out;

  const queues = new Set(held.map((h) => h.pages.queue_id as string));
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const part = ids.slice(i, i + IN_CHUNK);
    const res = await db
      .prepare(
        `SELECT d.id, ${PAGE_COLUMNS}
           FROM documents d
          WHERE d.tenant_id = ? AND d.id IN (${part.map(() => '?').join(', ')})`,
      )
      .bind(tenantId, ...part)
      .all<{ id: string } & PageRow>();
    for (const doc of res.results ?? []) {
      const file = filePagesOf(doc);
      if (!file.queue_id || !queues.has(file.queue_id)) continue;
      for (const h of held) {
        if (h.row.document_id === doc.id) continue;
        if (!fileCarriesLot(file, h.pages)) continue;
        const brief = holdBrief(h.row);
        // A hold on a sibling's WHOLE certificate still names that lot here.
        if (!brief.lot_label && h.row.document_lot_label) brief.lot_label = h.row.document_lot_label;
        const list = out.get(doc.id) ?? [];
        if (!list.some((x) => x.id === brief.id)) list.push(brief);
        out.set(doc.id, list);
      }
    }
  }
  return out;
}

/**
 * The hold a LINE for one lot row should name: the one on that lot when there
 * is one, else the oldest. Any of them stops the file; this only picks which
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
