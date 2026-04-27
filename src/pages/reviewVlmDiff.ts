/**
 * Pure helpers for comparing text-based vs VLM (vision) extraction results.
 *
 * Extracted out of ReviewQueue.tsx so the logic is unit-testable without
 * mounting the component. All functions are side-effect-free — given the same
 * inputs they return the same output — which keeps the test matrix small.
 *
 * The "text" extraction lives in ProcessingQueueItem.ai_fields / tables /
 * confidence_score. The "vlm" extraction lives in the vlm_* sibling columns
 * added by migration 0034 and populated by process-worker when
 * QWEN_VLM_MODE=dual.
 */

import type { ExtractedTable, ProcessingQueueItem } from '../lib/types';

export type ExtractionSource = 'text' | 'vlm';

export interface FieldDiffRow {
  key: string;
  textValue: string | null;
  vlmValue: string | null;
  /** 'match' = same trimmed value on both sides, 'differ' = both present and unequal, 'text_only' / 'vlm_only' = one side missing. */
  status: 'match' | 'differ' | 'text_only' | 'vlm_only';
}

export interface ExtractionPayload {
  fields: Record<string, string>;
  tables: ExtractedTable[];
  confidence: number | null;
  /** Only populated for VLM path. */
  model?: string | null;
  /** Only populated for VLM path. */
  durationMs?: number | null;
  /** Only populated for VLM path, non-null when extraction threw. */
  error?: string | null;
}

/**
 * Drop keys whose values are null, undefined, empty, or whitespace-only. Mirrors
 * the worker-side helper of the same name (bin/process-worker) so the field
 * counts the UI shows exactly match what the backend would persist.
 */
export function compactFields<T = unknown>(rec: Record<string, T> | null | undefined): Record<string, T> {
  if (!rec || typeof rec !== 'object') return {};
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (v == null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    out[k] = v as T;
  }
  return out;
}

/**
 * Best-effort parser for a JSON blob that came back from the worker. Returns
 * an empty object / array on parse failure so the caller can always rely on
 * the output shape — bad JSON should degrade gracefully in the UI, never
 * crash it. Empty / whitespace-only string values are dropped so the field
 * counts match what compactFields() produces server-side.
 */
function parseFields(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v == null) continue;
      const s = String(v);
      if (s.trim() === '') continue;
      out[k] = s;
    }
    return out;
  } catch {
    return {};
  }
}

function parseTables(raw: string | null | undefined): ExtractedTable[] {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t) =>
        t &&
        typeof t === 'object' &&
        Array.isArray((t as ExtractedTable).headers) &&
        Array.isArray((t as ExtractedTable).rows)
    ) as ExtractedTable[];
  } catch {
    return [];
  }
}

/** Extract the text-path payload (ai_fields + tables + confidence). */
export function readTextPayload(item: ProcessingQueueItem): ExtractionPayload {
  return {
    fields: parseFields(item.ai_fields),
    tables: parseTables(item.tables),
    confidence: item.confidence_score,
  };
}

/** Extract the VLM-path payload (vlm_extracted_fields + vlm_extracted_tables + vlm_confidence). */
export function readVlmPayload(item: ProcessingQueueItem): ExtractionPayload {
  return {
    fields: parseFields(item.vlm_extracted_fields),
    tables: parseTables(item.vlm_extracted_tables),
    confidence: item.vlm_confidence,
    model: item.vlm_model,
    durationMs: item.vlm_duration_ms,
    error: item.vlm_error,
  };
}

/** True if the text path actually produced any usable output. */
export function hasTextExtraction(item: ProcessingQueueItem): boolean {
  if (!item.ai_fields) return !!(item.tables && item.tables !== '[]');
  const parsed = parseFields(item.ai_fields);
  return Object.keys(parsed).length > 0;
}

/** True if the VLM path actually produced fields or tables (errors don't count). */
export function hasVlmExtraction(item: ProcessingQueueItem): boolean {
  if (item.vlm_extracted_fields) {
    const parsed = parseFields(item.vlm_extracted_fields);
    if (Object.keys(parsed).length > 0) return true;
  }
  if (item.vlm_extracted_tables) {
    const parsed = parseTables(item.vlm_extracted_tables);
    if (parsed.length > 0) return true;
  }
  return false;
}

/**
 * Main predicate — should the dual-compare UI appear for this queue item?
 * We only show the side-by-side when BOTH sides actually produced something;
 * a VLM error alone is not enough to change the primary layout.
 */
export function shouldShowDualCompare(item: ProcessingQueueItem): boolean {
  return hasTextExtraction(item) && hasVlmExtraction(item);
}

/**
 * Build the per-field diff rows for side-by-side display. The union of keys
 * from both sides is preserved; if a key exists only on one side it's
 * marked text_only / vlm_only. Equal values (post-trim) are match;
 * different non-null values are differ.
 *
 * Empty / whitespace-only values are treated as "missing" — this matches
 * how the frontend renders empty TextFields.
 */
export function diffFields(
  textFields: Record<string, string>,
  vlmFields: Record<string, string>
): FieldDiffRow[] {
  const keys = new Set<string>();
  for (const k of Object.keys(textFields)) keys.add(k);
  for (const k of Object.keys(vlmFields)) keys.add(k);

  const sorted = Array.from(keys).sort();
  const rows: FieldDiffRow[] = [];
  for (const key of sorted) {
    const rawT = textFields[key];
    const rawV = vlmFields[key];
    const textValue = rawT != null && rawT.trim() !== '' ? rawT : null;
    const vlmValue = rawV != null && rawV.trim() !== '' ? rawV : null;

    let status: FieldDiffRow['status'];
    if (textValue != null && vlmValue != null) {
      status = textValue.trim() === vlmValue.trim() ? 'match' : 'differ';
    } else if (textValue != null) {
      status = 'text_only';
    } else if (vlmValue != null) {
      status = 'vlm_only';
    } else {
      // Both sides null — skip the row entirely, nothing interesting to show.
      continue;
    }

    rows.push({ key, textValue, vlmValue, status });
  }
  return rows;
}

/**
 * Summary counts for a diff — used for the "3 match, 2 differ, 1 text-only"
 * badge that sits above the comparison UI.
 */
export function summarizeDiff(rows: FieldDiffRow[]): {
  match: number;
  differ: number;
  textOnly: number;
  vlmOnly: number;
  total: number;
} {
  let match = 0;
  let differ = 0;
  let textOnly = 0;
  let vlmOnly = 0;
  for (const r of rows) {
    if (r.status === 'match') match++;
    else if (r.status === 'differ') differ++;
    else if (r.status === 'text_only') textOnly++;
    else if (r.status === 'vlm_only') vlmOnly++;
  }
  return { match, differ, textOnly, vlmOnly, total: rows.length };
}

/**
 * Given a user's per-field source pick, merge the two field sets into a
 * single object. Keys absent from picks fall back to the provided default
 * source. Empty strings are preserved — the user may intentionally blank a
 * field during review.
 */
export function mergeFieldSelection(
  textFields: Record<string, string>,
  vlmFields: Record<string, string>,
  picks: Record<string, ExtractionSource>,
  defaultSource: ExtractionSource
): Record<string, string> {
  const keys = new Set<string>();
  for (const k of Object.keys(textFields)) keys.add(k);
  for (const k of Object.keys(vlmFields)) keys.add(k);

  const out: Record<string, string> = {};
  for (const key of keys) {
    const source = picks[key] ?? defaultSource;
    const value = source === 'vlm' ? vlmFields[key] : textFields[key];
    // Fall back to the other side if the chosen side is missing — the user
    // probably meant "use whatever is available" in the default case.
    if (value != null && value !== '') {
      out[key] = value;
    } else {
      const other = source === 'vlm' ? textFields[key] : vlmFields[key];
      if (other != null && other !== '') {
        out[key] = other;
      }
    }
  }
  return out;
}
