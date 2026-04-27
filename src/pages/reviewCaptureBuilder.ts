/**
 * Pure builders for Phase 2 reviewer-decision capture payloads.
 *
 * Extracted out of ReviewQueue.tsx so the diff/classify logic is unit-testable
 * without mounting the component. Given the editedFields the user is about to
 * approve, plus the original text/vlm extractions, derive:
 *   - field_picks: per-field source classification (text|vlm|edited)
 *   - dismissals: explicit field removals
 *   - table_edits: column excludes / table excludes / header renames / cell edits
 *
 * All functions are side-effect-free.
 */
import type { ExtractedTable } from '../lib/types';

export type ChosenSource = 'text' | 'vlm' | 'edited' | 'dismissed';

export interface FieldPickCapture {
  field_key: string;
  text_value: string | null;
  vlm_value: string | null;
  chosen_source: ChosenSource;
  final_value: string | null;
}

export interface FieldDismissalCapture {
  field_key: string;
  action: 'dismissed' | 'extended';
}

export interface TableEditCapture {
  table_idx: number;
  operation: string;
  detail: Record<string, unknown>;
}

const norm = (v: unknown): string => {
  if (v == null) return '';
  return String(v).trim();
};

/**
 * Classify a single approved value against the text and VLM payloads.
 * - matches text exactly → 'text'
 * - matches VLM exactly → 'vlm'
 * - matches neither → 'edited'
 * VLM wins when both sides match (the reviewer "preferred" VLM by default
 * in dual-extraction items where the values agree).
 */
export function classifyFieldSource(
  finalValue: string | null | undefined,
  textValue: string | null | undefined,
  vlmValue: string | null | undefined
): ChosenSource {
  const f = norm(finalValue);
  const t = norm(textValue);
  const v = norm(vlmValue);
  if (f === t && t !== '') return 'text';
  if (f === v && v !== '') return 'vlm';
  if (f === '' && t === '' && v === '') return 'edited';
  return 'edited';
}

/**
 * Build the field_picks array for the approve payload. Walks the union of
 * keys from edited/text/vlm and emits one capture row per key that is present
 * on at least one side. Skips keys where every value is empty (nothing to
 * record). Also skips dismissed keys — those go into the dismissals capture.
 */
export function buildFieldPicks(args: {
  editedFields: Record<string, string>;
  textFields: Record<string, string>;
  vlmFields: Record<string, string>;
  dismissedFields?: Set<string>;
}): FieldPickCapture[] {
  const { editedFields, textFields, vlmFields, dismissedFields } = args;
  const dismissed = dismissedFields ?? new Set<string>();
  const keys = new Set<string>([
    ...Object.keys(editedFields),
    ...Object.keys(textFields),
    ...Object.keys(vlmFields),
  ]);

  const out: FieldPickCapture[] = [];
  for (const key of keys) {
    if (dismissed.has(key)) continue;
    const final = editedFields[key];
    const text = textFields[key];
    const vlm = vlmFields[key];
    if (norm(final) === '' && norm(text) === '' && norm(vlm) === '') continue;
    out.push({
      field_key: key,
      text_value: text != null ? text : null,
      vlm_value: vlm != null ? vlm : null,
      chosen_source: classifyFieldSource(final, text, vlm),
      final_value: final != null ? final : null,
    });
  }
  out.sort((a, b) => a.field_key.localeCompare(b.field_key));
  return out;
}

/**
 * Build the dismissals capture from the dismissedFields Set state.
 * Action defaults to 'dismissed' for now; 'extended' (move to extended
 * metadata) will be wired in a future UI iteration.
 */
export function buildDismissals(
  dismissedFields: Set<string> | undefined
): FieldDismissalCapture[] {
  if (!dismissedFields || dismissedFields.size === 0) return [];
  return Array.from(dismissedFields)
    .sort()
    .map(field_key => ({ field_key, action: 'dismissed' as const }));
}

/**
 * Build the table_edits capture from per-item state:
 *   - excludedTables: Set<number> of table indices marked excluded
 *   - excludedColumns: per-table Set<number> of column indices marked excluded
 *   - editedTables: ExtractedTable[] (current state, possibly mutated)
 *   - originalTables: ExtractedTable[] (snapshot from worker output)
 * Header renames are detected by comparing edited vs original headers.
 * Row deletes are detected by comparing row count (only "row_deleted"
 * count is emitted; per-row identity isn't preserved in current state).
 */
export function buildTableEdits(args: {
  excludedTables?: Set<number>;
  excludedColumns?: Record<number, Set<number>>;
  editedTables?: ExtractedTable[];
  originalTables?: ExtractedTable[];
}): TableEditCapture[] {
  const { excludedTables, excludedColumns, editedTables, originalTables } = args;
  const out: TableEditCapture[] = [];

  if (excludedTables) {
    for (const idx of excludedTables) {
      out.push({ table_idx: idx, operation: 'table_excluded', detail: {} });
    }
  }

  if (excludedColumns) {
    for (const [tableIdxStr, cols] of Object.entries(excludedColumns)) {
      const tableIdx = Number(tableIdxStr);
      if (!cols || cols.size === 0) continue;
      for (const colIdx of cols) {
        const header = originalTables?.[tableIdx]?.headers?.[colIdx];
        out.push({
          table_idx: tableIdx,
          operation: 'column_excluded',
          detail: { column_idx: colIdx, ...(header ? { header } : {}) },
        });
      }
    }
  }

  if (editedTables && originalTables) {
    for (let ti = 0; ti < editedTables.length; ti++) {
      const edited = editedTables[ti];
      const original = originalTables[ti];
      if (!edited || !original) continue;

      // Header renames
      const editedHeaders = edited.headers ?? [];
      const originalHeaders = original.headers ?? [];
      const maxLen = Math.max(editedHeaders.length, originalHeaders.length);
      for (let ci = 0; ci < maxLen; ci++) {
        const before = originalHeaders[ci];
        const after = editedHeaders[ci];
        if (before != null && after != null && before !== after) {
          out.push({
            table_idx: ti,
            operation: 'header_renamed',
            detail: { column_idx: ci, from: before, to: after },
          });
        }
      }

      // Row count delta — emit row_deleted entries when current < original
      const beforeRows = (original.rows ?? []).length;
      const afterRows = (edited.rows ?? []).length;
      if (afterRows < beforeRows) {
        out.push({
          table_idx: ti,
          operation: 'row_deleted',
          detail: { rows_removed: beforeRows - afterRows },
        });
      }
    }
  }

  return out;
}
