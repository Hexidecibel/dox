/**
 * Unit tests for the ReviewQueue page's pure table reducers.
 *
 * These back the inline-editable table UI on the document review screen —
 * each helper takes the current ExtractedTable[] and returns a new one,
 * never mutating the input.
 */

import { describe, it, expect } from 'vitest';
import {
  addTableColumn,
  addTableRow,
  cloneTable,
  cloneTables,
  deleteTableColumn,
  deleteTableRow,
  findDuplicateHeaders,
  renameTableHeader,
  updateTableCell,
} from '../../src/pages/reviewTableActions';
import type { ExtractedTable } from '../../shared/types';

function makeTable(name = 'coa_results'): ExtractedTable {
  return {
    name,
    headers: ['lot', 'moisture', 'protein'],
    rows: [
      ['L1', '10', '11'],
      ['L2', '12', '13'],
    ],
  };
}

describe('cloneTable / cloneTables', () => {
  it('deep-clones so mutating the clone leaves the source intact', () => {
    const t = makeTable();
    const c = cloneTable(t);
    c.headers[0] = 'LOT#';
    c.rows[0][0] = 'changed';
    expect(t.headers[0]).toBe('lot');
    expect(t.rows[0][0]).toBe('L1');
  });

  it('cloneTables clones every element', () => {
    const arr = [makeTable('a'), makeTable('b')];
    const copy = cloneTables(arr);
    copy[1].headers[1] = 'NEW';
    expect(arr[1].headers[1]).toBe('moisture');
  });
});

describe('renameTableHeader', () => {
  it('renames the column at the given index', () => {
    const tables = [makeTable()];
    const result = renameTableHeader(tables, 0, 1, 'Moisture %');
    expect(result.rejected).toBe(false);
    expect(result.duplicate).toBe(false);
    expect(result.tables[0].headers).toEqual(['lot', 'Moisture %', 'protein']);
    // Pure — original untouched.
    expect(tables[0].headers[1]).toBe('moisture');
  });

  it('trims whitespace from the new header', () => {
    const tables = [makeTable()];
    const result = renameTableHeader(tables, 0, 0, '   Lot Number   ');
    expect(result.tables[0].headers[0]).toBe('Lot Number');
  });

  it('rejects an empty / whitespace-only header', () => {
    const tables = [makeTable()];
    const result = renameTableHeader(tables, 0, 0, '   ');
    expect(result.rejected).toBe(true);
    // Tables returned unchanged (referentially equal is fine).
    expect(result.tables).toBe(tables);
  });

  it('allows machine-style names like "order_number"', () => {
    const tables = [makeTable()];
    const result = renameTableHeader(tables, 0, 0, 'order_number');
    expect(result.rejected).toBe(false);
    expect(result.tables[0].headers[0]).toBe('order_number');
  });

  it('flags duplicate when renaming to match another column (case-insensitive)', () => {
    const tables = [makeTable()];
    const result = renameTableHeader(tables, 0, 2, 'Moisture');
    expect(result.rejected).toBe(false);
    expect(result.duplicate).toBe(true);
    // Still performs the rename.
    expect(result.tables[0].headers).toEqual(['lot', 'moisture', 'Moisture']);
  });

  it('does not flag duplicate when renaming to the same value (case change only)', () => {
    const tables = [makeTable()];
    const result = renameTableHeader(tables, 0, 1, 'MOISTURE');
    expect(result.duplicate).toBe(false);
    expect(result.tables[0].headers[1]).toBe('MOISTURE');
  });

  it('no-ops when the new header is identical', () => {
    const tables = [makeTable()];
    const result = renameTableHeader(tables, 0, 1, 'moisture');
    expect(result.rejected).toBe(false);
    expect(result.tables).toBe(tables);
  });

  it('rejects out-of-range table or column index', () => {
    const tables = [makeTable()];
    expect(renameTableHeader(tables, 5, 0, 'x').rejected).toBe(true);
    expect(renameTableHeader(tables, 0, 99, 'x').rejected).toBe(true);
    expect(renameTableHeader(tables, 0, -1, 'x').rejected).toBe(true);
  });

  it('only touches the target table when there are multiple', () => {
    const tables = [makeTable('a'), makeTable('b')];
    const result = renameTableHeader(tables, 1, 0, 'LOT#');
    expect(result.tables[0].headers[0]).toBe('lot');
    expect(result.tables[1].headers[0]).toBe('LOT#');
    // Untouched table referentially preserved.
    expect(result.tables[0]).toBe(tables[0]);
  });
});

describe('findDuplicateHeaders', () => {
  it('returns empty when headers are unique', () => {
    expect(findDuplicateHeaders(makeTable())).toEqual([]);
  });

  it('detects duplicate headers case-insensitively', () => {
    const t: ExtractedTable = {
      name: 'x',
      headers: ['Lot', 'moisture', 'LOT'],
      rows: [['a', 'b', 'c']],
    };
    expect(findDuplicateHeaders(t)).toEqual(['Lot']);
  });

  it('ignores empty headers', () => {
    const t: ExtractedTable = {
      name: 'x',
      headers: ['', '', 'ok'],
      rows: [['a', 'b', 'c']],
    };
    expect(findDuplicateHeaders(t)).toEqual([]);
  });
});

describe('addTableColumn', () => {
  it('adds a column with default label and empty cells', () => {
    const tables = [makeTable()];
    const next = addTableColumn(tables, 0);
    expect(next[0].headers).toEqual(['lot', 'moisture', 'protein', 'New Column']);
    expect(next[0].rows.every((r) => r.length === 4 && r[3] === '')).toBe(true);
  });

  it('uses a custom label when provided', () => {
    const tables = [makeTable()];
    const next = addTableColumn(tables, 0, 'Notes');
    expect(next[0].headers[3]).toBe('Notes');
  });

  it('is a no-op for invalid tableIdx', () => {
    const tables = [makeTable()];
    expect(addTableColumn(tables, 5)).toBe(tables);
  });
});

describe('deleteTableColumn', () => {
  it('removes a column from headers + every row', () => {
    const tables = [makeTable()];
    const next = deleteTableColumn(tables, 0, 1);
    expect(next[0].headers).toEqual(['lot', 'protein']);
    expect(next[0].rows).toEqual([
      ['L1', '11'],
      ['L2', '13'],
    ]);
  });

  it('refuses to delete the last remaining column', () => {
    const tables: ExtractedTable[] = [
      { name: 'solo', headers: ['only'], rows: [['a']] },
    ];
    expect(deleteTableColumn(tables, 0, 0)).toBe(tables);
  });

  it('is a no-op for out-of-range colIdx', () => {
    const tables = [makeTable()];
    expect(deleteTableColumn(tables, 0, 99)).toBe(tables);
  });
});

describe('addTableRow', () => {
  it('appends a blank row matching header width', () => {
    const tables = [makeTable()];
    const next = addTableRow(tables, 0);
    expect(next[0].rows.length).toBe(3);
    expect(next[0].rows[2]).toEqual(['', '', '']);
  });
});

describe('deleteTableRow', () => {
  it('removes a row', () => {
    const tables = [makeTable()];
    const next = deleteTableRow(tables, 0, 0);
    expect(next[0].rows).toEqual([['L2', '12', '13']]);
  });

  it('refuses to delete the last remaining row', () => {
    const tables: ExtractedTable[] = [
      { name: 'solo', headers: ['a', 'b'], rows: [['x', 'y']] },
    ];
    expect(deleteTableRow(tables, 0, 0)).toBe(tables);
  });
});

describe('updateTableCell', () => {
  it('updates a single cell', () => {
    const tables = [makeTable()];
    const next = updateTableCell(tables, 0, 1, 2, '99');
    expect(next[0].rows[1][2]).toBe('99');
    // Unrelated row/col untouched.
    expect(next[0].rows[0][2]).toBe('11');
    // Original unchanged.
    expect(tables[0].rows[1][2]).toBe('13');
  });

  it('is a no-op for invalid indices', () => {
    const tables = [makeTable()];
    expect(updateTableCell(tables, 0, 99, 0, 'x')).toBe(tables);
    expect(updateTableCell(tables, 0, 0, 99, 'x')).toBe(tables);
  });
});
