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
 * PER DOCUMENT. A hold names one lot row or the whole certificate, but a file
 * is the unit that leaves: any active hold on a document, on any of its lots,
 * holds the document (C-073). The lot is carried so a refusal can say which.
 */

import { holdLotLabel } from '../../shared/holds';
import type { HoldSource } from '../../shared/holds';
import type { DocumentHoldBrief } from '../../shared/types';

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
  lot_id: string | null;
  reason: string;
  source: HoldSource;
  placed_at: string;
  lot_number?: string | null;
  sub_lot_code?: string | null;
}): DocumentHoldBrief {
  return {
    id: r.id,
    lot_id: r.lot_id ?? null,
    lot_label: r.lot_id ? holdLotLabel(r) : null,
    reason: r.reason,
    source: r.source,
    placed_at: r.placed_at,
  };
}

/**
 * The active holds of each document, oldest first, TENANT SCOPED. A document
 * with none is absent from the map.
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
 * oldest active hold) on each held row and touches nothing else. A row that is
 * not held gains no key at all.
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
    const holds = await loadActiveHolds(db, tenantId, ids);
    if (holds.size === 0) return;
    for (const r of rows) {
      const list = typeof r.id === 'string' ? holds.get(r.id) : undefined;
      if (list && list.length > 0) (r as Record<string, unknown>).active_hold = list[0];
    }
  } catch (err) {
    console.error('[holds] marking held result rows failed:', err instanceof Error ? err.message : String(err));
  }
}
