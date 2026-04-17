/**
 * Pure reducer helpers for editing extracted tables in ReviewQueue.tsx.
 *
 * These are extracted as standalone pure functions (no React state) so they
 * can be unit tested, and so the component-level setState callbacks can be
 * kept thin. Mirrors the detailMappingActions pattern.
 *
 * All helpers take the current tables array and return a new one — they
 * never mutate the input.
 */

import type { ExtractedTable } from '../lib/types';

/** Deep clone an ExtractedTable so edits don't mutate the source. */
export function cloneTable(t: ExtractedTable): ExtractedTable {
  return {
    ...t,
    headers: [...t.headers],
    rows: t.rows.map((r) => [...r]),
  };
}

/** Deep clone an array of tables. */
export function cloneTables(tables: ExtractedTable[]): ExtractedTable[] {
  return tables.map(cloneTable);
}

export interface RenameHeaderResult {
  tables: ExtractedTable[];
  /** True if the new header matches another header in the same table. */
  duplicate: boolean;
  /** True if the rename was rejected (empty after trim, or out-of-range). */
  rejected: boolean;
}

/**
 * Rename a single column header in a table.
 *
 * Rules:
 *  - Trims whitespace from newHeader.
 *  - Rejects empty headers (returns rejected: true, tables unchanged).
 *  - Reports `duplicate: true` if the trimmed new header collides with
 *    another header in the same table (case-insensitive), but still
 *    performs the rename (caller decides whether to warn).
 *  - No-op if the header is unchanged.
 *  - Out-of-range indices are ignored (returns rejected: true).
 */
export function renameTableHeader(
  tables: ExtractedTable[],
  tableIdx: number,
  colIdx: number,
  newHeader: string,
): RenameHeaderResult {
  const trimmed = newHeader.trim();
  if (!trimmed) {
    return { tables, duplicate: false, rejected: true };
  }
  const target = tables[tableIdx];
  if (!target || colIdx < 0 || colIdx >= target.headers.length) {
    return { tables, duplicate: false, rejected: true };
  }
  if (target.headers[colIdx] === trimmed) {
    return { tables, duplicate: false, rejected: false };
  }

  // Duplicate check — case-insensitive, ignoring the column being renamed.
  const lower = trimmed.toLowerCase();
  const duplicate = target.headers.some(
    (h, i) => i !== colIdx && h.trim().toLowerCase() === lower,
  );

  const next = tables.map((t, ti) => {
    if (ti !== tableIdx) return t;
    const clone = cloneTable(t);
    clone.headers[colIdx] = trimmed;
    return clone;
  });
  return { tables: next, duplicate, rejected: false };
}

/** Find any duplicated header names in a single table (case-insensitive). */
export function findDuplicateHeaders(table: ExtractedTable): string[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const h of table.headers) {
    const key = h.trim().toLowerCase();
    if (!key) continue;
    const existing = counts.get(key);
    if (existing) {
      existing.count++;
    } else {
      counts.set(key, { label: h.trim(), count: 1 });
    }
  }
  return Array.from(counts.values())
    .filter((e) => e.count > 1)
    .map((e) => e.label);
}

/** Add a new column (header + empty cells) to a specific table. */
export function addTableColumn(
  tables: ExtractedTable[],
  tableIdx: number,
  newHeaderLabel = 'New Column',
): ExtractedTable[] {
  const target = tables[tableIdx];
  if (!target) return tables;
  return tables.map((t, ti) => {
    if (ti !== tableIdx) return t;
    return {
      ...t,
      headers: [...t.headers, newHeaderLabel],
      rows: t.rows.map((r) => [...r, '']),
    };
  });
}

/** Delete a column (header + cell in each row) from a specific table. */
export function deleteTableColumn(
  tables: ExtractedTable[],
  tableIdx: number,
  colIdx: number,
): ExtractedTable[] {
  const target = tables[tableIdx];
  if (!target) return tables;
  if (target.headers.length <= 1) return tables;
  if (colIdx < 0 || colIdx >= target.headers.length) return tables;
  return tables.map((t, ti) => {
    if (ti !== tableIdx) return t;
    return {
      ...t,
      headers: t.headers.filter((_, i) => i !== colIdx),
      rows: t.rows.map((r) => r.filter((_, i) => i !== colIdx)),
    };
  });
}

/** Append an empty row whose width matches the table's current header count. */
export function addTableRow(
  tables: ExtractedTable[],
  tableIdx: number,
): ExtractedTable[] {
  const target = tables[tableIdx];
  if (!target) return tables;
  const blankRow = new Array(target.headers.length).fill('');
  return tables.map((t, ti) => {
    if (ti !== tableIdx) return t;
    return { ...t, rows: [...t.rows, blankRow] };
  });
}

/** Delete a row from a specific table. Keeps at least 1 row. */
export function deleteTableRow(
  tables: ExtractedTable[],
  tableIdx: number,
  rowIdx: number,
): ExtractedTable[] {
  const target = tables[tableIdx];
  if (!target) return tables;
  if (target.rows.length <= 1) return tables;
  if (rowIdx < 0 || rowIdx >= target.rows.length) return tables;
  return tables.map((t, ti) => {
    if (ti !== tableIdx) return t;
    return { ...t, rows: t.rows.filter((_, i) => i !== rowIdx) };
  });
}

/** Update a single cell's value. */
export function updateTableCell(
  tables: ExtractedTable[],
  tableIdx: number,
  rowIdx: number,
  colIdx: number,
  value: string,
): ExtractedTable[] {
  const target = tables[tableIdx];
  if (!target) return tables;
  if (rowIdx < 0 || rowIdx >= target.rows.length) return tables;
  if (colIdx < 0 || colIdx >= target.headers.length) return tables;
  return tables.map((t, ti) => {
    if (ti !== tableIdx) return t;
    return {
      ...t,
      rows: t.rows.map((r, ri) =>
        ri !== rowIdx ? r : r.map((c, ci) => (ci !== colIdx ? c : value)),
      ),
    };
  });
}
