/**
 * Phase 3 aggregator over the Phase 2 reviewer-decision capture tables.
 *
 * Given a (tenant, supplier, doctype) tuple, derive the per-field source
 * preference, dismissal threshold, and table filter shape that the worker /
 * UI will use to pre-fill the next review. Pure function, no side effects.
 *
 * Critical rule: when the reviewer's chosen value happened to match BOTH the
 * text and VLM payloads, classifyFieldSource() in reviewCaptureBuilder breaks
 * the tie alphabetically and returns 'text'. Those rows are NOT a real win
 * for text — both extractors agreed and the reviewer accepted either side.
 * Counting them toward the source preference would skew every aggregate
 * toward text. We exclude any pick where text_value === vlm_value from the
 * source-preference computation; tied picks still count toward
 * `most_common_value` consensus where any agreed-upon value is signal.
 */

import type { D1Database } from '@cloudflare/workers-types';

export interface LearnedFieldPreference {
  preferred_source: 'text' | 'vlm';
  confidence: number;
  pick_count: number;
  most_common_value?: string;
}

export interface LearnedTableFilter {
  table_idx_pattern: number;
  excluded_columns: number[];
  header_renames: Record<string, string>;
}

export interface LearnedPreferences {
  fields: Record<string, LearnedFieldPreference>;
  dismissed_fields: string[];
  table_filters: LearnedTableFilter[];
}

interface PickRow {
  field_key: string;
  text_value: string | null;
  vlm_value: string | null;
  chosen_source: string;
  final_value: string | null;
}

interface DismissalRow {
  field_key: string;
  queue_item_id: string;
}

interface TableEditRow {
  table_idx: number;
  operation: string;
  detail: string;
}

const MIN_PICKS_FOR_PREFERENCE = 3;
const DISMISSAL_THRESHOLD = 0.8;
const MIN_REVIEWS_FOR_DISMISSAL = 3;

function norm(v: string | null | undefined): string {
  return v == null ? '' : v.trim();
}

/**
 * Build the (tenant, supplier, doctype) WHERE clause. Supplier and doctype
 * are matched explicitly when provided; null IDs match only rows where the
 * column is also null (don't bleed signal across suppliers we couldn't
 * resolve at capture time).
 */
function buildScopeClause(
  alias: string,
  supplierId: string | null,
  documentTypeId: string | null
): { clause: string; params: (string | null)[] } {
  const supplierClause = supplierId
    ? `AND ${alias}.supplier_id = ?`
    : `AND ${alias}.supplier_id IS NULL`;
  const doctypeClause = documentTypeId
    ? `AND ${alias}.document_type_id = ?`
    : `AND ${alias}.document_type_id IS NULL`;
  const params: (string | null)[] = [];
  if (supplierId) params.push(supplierId);
  if (documentTypeId) params.push(documentTypeId);
  return {
    clause: `${supplierClause} ${doctypeClause}`,
    params,
  };
}

/**
 * Aggregate per-field source picks into a LearnedFieldPreference. Tied picks
 * (text === vlm) are excluded from the source-preference vote but counted
 * toward pick_count and most_common_value. A field needs at least
 * MIN_PICKS_FOR_PREFERENCE non-tied picks before any preference is exposed.
 */
export function aggregatePicks(picks: PickRow[]): Record<string, LearnedFieldPreference> {
  const byField = new Map<string, PickRow[]>();
  for (const pick of picks) {
    const list = byField.get(pick.field_key) ?? [];
    list.push(pick);
    byField.set(pick.field_key, list);
  }

  const out: Record<string, LearnedFieldPreference> = {};
  for (const [field_key, rows] of byField) {
    const nonTied = rows.filter(r => norm(r.text_value) !== norm(r.vlm_value));
    if (nonTied.length < MIN_PICKS_FOR_PREFERENCE) continue;

    let textVotes = 0;
    let vlmVotes = 0;
    for (const r of nonTied) {
      if (r.chosen_source === 'text') textVotes++;
      else if (r.chosen_source === 'vlm') vlmVotes++;
      // 'edited' / 'dismissed' are not source votes — skip
    }
    if (textVotes === 0 && vlmVotes === 0) continue;

    const preferred_source: 'text' | 'vlm' = vlmVotes > textVotes ? 'vlm' : 'text';
    const dominantVotes = Math.max(textVotes, vlmVotes);
    const totalSourceVotes = textVotes + vlmVotes;
    const agreement_ratio = totalSourceVotes === 0 ? 0 : dominantVotes / totalSourceVotes;
    const confidence = Math.min(nonTied.length / 5, 1.0) * agreement_ratio;

    const finalValueCounts = new Map<string, number>();
    for (const r of rows) {
      const v = norm(r.final_value);
      if (v === '') continue;
      finalValueCounts.set(v, (finalValueCounts.get(v) ?? 0) + 1);
    }
    let most_common_value: string | undefined;
    if (finalValueCounts.size === 1) {
      most_common_value = finalValueCounts.keys().next().value;
    }

    out[field_key] = {
      preferred_source,
      confidence,
      pick_count: rows.length,
      ...(most_common_value !== undefined ? { most_common_value } : {}),
    };
  }
  return out;
}

/**
 * Aggregate dismissals into a "default-hide" list. A field appears in
 * dismissed_fields when it's been explicitly dismissed in at least
 * DISMISSAL_THRESHOLD (default 80%) of the past reviews that mentioned it,
 * with a minimum of MIN_REVIEWS_FOR_DISMISSAL distinct reviews to avoid
 * noise. "Reviews that mentioned it" = picks (the field was extracted) plus
 * dismissals (the reviewer hid it).
 */
export function aggregateDismissals(
  dismissals: DismissalRow[],
  picks: PickRow[],
  pickItemMap: Map<string, Set<string>>
): string[] {
  const dismissalCount = new Map<string, Set<string>>();
  for (const d of dismissals) {
    const set = dismissalCount.get(d.field_key) ?? new Set<string>();
    set.add(d.queue_item_id);
    dismissalCount.set(d.field_key, set);
  }

  const out: string[] = [];
  for (const [field_key, dismissedItems] of dismissalCount) {
    const pickedItems = pickItemMap.get(field_key) ?? new Set<string>();
    const totalReviews = new Set<string>([...dismissedItems, ...pickedItems]).size;
    if (totalReviews < MIN_REVIEWS_FOR_DISMISSAL) continue;
    const ratio = dismissedItems.size / totalReviews;
    if (ratio >= DISMISSAL_THRESHOLD) out.push(field_key);
  }
  out.sort();
  return out;
}

/**
 * Aggregate table edits into per-(table_idx) filter rows: which columns get
 * excluded by default, which header renames are consistent. Header renames
 * apply only when the SAME (from, to) pair appears in a majority of edits
 * for that column — otherwise we'd codify a one-off rename.
 */
export function aggregateTableEdits(edits: TableEditRow[]): LearnedTableFilter[] {
  const byTable = new Map<number, TableEditRow[]>();
  for (const e of edits) {
    const list = byTable.get(e.table_idx) ?? [];
    list.push(e);
    byTable.set(e.table_idx, list);
  }

  const out: LearnedTableFilter[] = [];
  for (const [table_idx_pattern, rows] of byTable) {
    const colExcludeCounts = new Map<number, number>();
    const renameVotes = new Map<string, Map<string, number>>();
    let totalForExcludes = 0;
    let totalForRenames = 0;

    for (const row of rows) {
      let detail: Record<string, unknown> = {};
      try {
        detail = JSON.parse(row.detail) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (row.operation === 'column_excluded') {
        const colIdx = Number(detail.column_idx);
        if (Number.isFinite(colIdx)) {
          colExcludeCounts.set(colIdx, (colExcludeCounts.get(colIdx) ?? 0) + 1);
          totalForExcludes++;
        }
      } else if (row.operation === 'header_renamed') {
        const from = typeof detail.from === 'string' ? detail.from : null;
        const to = typeof detail.to === 'string' ? detail.to : null;
        if (from && to) {
          const fromMap = renameVotes.get(from) ?? new Map<string, number>();
          fromMap.set(to, (fromMap.get(to) ?? 0) + 1);
          renameVotes.set(from, fromMap);
          totalForRenames++;
        }
      }
    }

    const excluded_columns: number[] = [];
    for (const [colIdx, count] of colExcludeCounts) {
      if (totalForExcludes >= 2 && count >= 2) excluded_columns.push(colIdx);
    }
    excluded_columns.sort((a, b) => a - b);

    const header_renames: Record<string, string> = {};
    for (const [from, toMap] of renameVotes) {
      let bestTo: string | null = null;
      let bestCount = 0;
      let totalForFrom = 0;
      for (const [to, count] of toMap) {
        totalForFrom += count;
        if (count > bestCount) {
          bestCount = count;
          bestTo = to;
        }
      }
      if (bestTo && totalForFrom >= 2 && bestCount / totalForFrom >= 0.5) {
        header_renames[from] = bestTo;
      }
    }

    if (excluded_columns.length === 0 && Object.keys(header_renames).length === 0) continue;
    out.push({ table_idx_pattern, excluded_columns, header_renames });
  }

  out.sort((a, b) => a.table_idx_pattern - b.table_idx_pattern);
  return out;
}

export async function getLearnedPreferences(
  db: D1Database,
  tenantId: string,
  supplierId: string | null,
  documentTypeId: string | null
): Promise<LearnedPreferences> {
  const picksScope = buildScopeClause('p', supplierId, documentTypeId);
  const dismissalsScope = buildScopeClause('d', supplierId, documentTypeId);
  const editsScope = buildScopeClause('e', supplierId, documentTypeId);

  const picksRes = await db
    .prepare(
      `SELECT field_key, text_value, vlm_value, chosen_source, final_value, queue_item_id
       FROM reviewer_field_picks p
       WHERE p.tenant_id = ? ${picksScope.clause}`
    )
    .bind(tenantId, ...picksScope.params)
    .all<PickRow & { queue_item_id: string }>();

  const dismissalsRes = await db
    .prepare(
      `SELECT field_key, queue_item_id
       FROM reviewer_field_dismissals d
       WHERE d.tenant_id = ? ${dismissalsScope.clause}`
    )
    .bind(tenantId, ...dismissalsScope.params)
    .all<DismissalRow>();

  const editsRes = await db
    .prepare(
      `SELECT table_idx, operation, detail
       FROM reviewer_table_edits e
       WHERE e.tenant_id = ? ${editsScope.clause}`
    )
    .bind(tenantId, ...editsScope.params)
    .all<TableEditRow>();

  const picks = picksRes.results ?? [];
  const dismissals = dismissalsRes.results ?? [];
  const edits = editsRes.results ?? [];

  const pickItemMap = new Map<string, Set<string>>();
  for (const p of picks) {
    const set = pickItemMap.get(p.field_key) ?? new Set<string>();
    set.add(p.queue_item_id);
    pickItemMap.set(p.field_key, set);
  }

  return {
    fields: aggregatePicks(picks),
    dismissed_fields: aggregateDismissals(dismissals, picks, pickItemMap),
    table_filters: aggregateTableEdits(edits),
  };
}
