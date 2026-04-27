/**
 * Unit tests for the Phase 2 reviewer-decision capture builders. These are
 * pure functions consumed by ReviewQueue.tsx's approve handler — given the
 * post-edit UI state, derive what should be sent in the approve PUT.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyFieldSource,
  buildFieldPicks,
  buildDismissals,
  buildTableEdits,
} from '../../src/pages/reviewCaptureBuilder';
import type { ExtractedTable } from '../../src/lib/types';

describe('classifyFieldSource', () => {
  it('returns text when final matches text exactly', () => {
    expect(classifyFieldSource('hello', 'hello', 'world')).toBe('text');
  });

  it('returns vlm when final matches vlm exactly', () => {
    expect(classifyFieldSource('world', 'hello', 'world')).toBe('vlm');
  });

  it('returns edited when final matches neither', () => {
    expect(classifyFieldSource('xyz', 'hello', 'world')).toBe('edited');
  });

  it('returns vlm when text and vlm both match (tie-breaker)', () => {
    expect(classifyFieldSource('same', 'same', 'same')).toBe('text');
  });

  it('treats whitespace and null as equal-empty (edited fallback)', () => {
    expect(classifyFieldSource(null, '', '   ')).toBe('edited');
  });

  it('trims values when comparing', () => {
    expect(classifyFieldSource('  L-123  ', 'L-123', 'L-456')).toBe('text');
  });
});

describe('buildFieldPicks', () => {
  it('classifies each key by source', () => {
    const picks = buildFieldPicks({
      editedFields: { supplier: 'ACME CORP', lot: 'L-EDIT', code: 'C-1' },
      textFields: { supplier: 'ACME', lot: 'L-1', code: 'C-1' },
      vlmFields: { supplier: 'ACME CORP', lot: 'L-2', code: 'C-1' },
    });
    expect(picks).toHaveLength(3);
    const bySource = Object.fromEntries(picks.map(p => [p.field_key, p.chosen_source]));
    expect(bySource.supplier).toBe('vlm');
    expect(bySource.lot).toBe('edited');
    expect(bySource.code).toBe('text');
  });

  it('skips dismissed fields', () => {
    const picks = buildFieldPicks({
      editedFields: { supplier: 'ACME', lot: 'L-1' },
      textFields: { supplier: 'ACME', lot: 'L-1' },
      vlmFields: { supplier: 'ACME', lot: 'L-1' },
      dismissedFields: new Set(['lot']),
    });
    expect(picks.map(p => p.field_key)).toEqual(['supplier']);
  });

  it('returns empty array when nothing has values', () => {
    const picks = buildFieldPicks({
      editedFields: {},
      textFields: {},
      vlmFields: {},
    });
    expect(picks).toEqual([]);
  });

  it('preserves text_value/vlm_value/final_value in capture rows', () => {
    const picks = buildFieldPicks({
      editedFields: { lot: 'L-EDIT' },
      textFields: { lot: 'L-T' },
      vlmFields: { lot: 'L-V' },
    });
    expect(picks).toEqual([
      {
        field_key: 'lot',
        text_value: 'L-T',
        vlm_value: 'L-V',
        chosen_source: 'edited',
        final_value: 'L-EDIT',
      },
    ]);
  });

  it('sorts output by field_key for stable ordering', () => {
    const picks = buildFieldPicks({
      editedFields: { z: '1', a: '2', m: '3' },
      textFields: {},
      vlmFields: {},
    });
    expect(picks.map(p => p.field_key)).toEqual(['a', 'm', 'z']);
  });
});

describe('buildDismissals', () => {
  it('returns empty when set undefined or empty', () => {
    expect(buildDismissals(undefined)).toEqual([]);
    expect(buildDismissals(new Set())).toEqual([]);
  });

  it('emits one row per dismissed field, sorted', () => {
    const out = buildDismissals(new Set(['lot', 'code', 'supplier']));
    expect(out).toEqual([
      { field_key: 'code', action: 'dismissed' },
      { field_key: 'lot', action: 'dismissed' },
      { field_key: 'supplier', action: 'dismissed' },
    ]);
  });
});

describe('buildTableEdits', () => {
  const mkTable = (name: string, headers: string[], rows: string[][]): ExtractedTable => ({
    name,
    headers,
    rows,
  });

  it('returns empty when no state provided', () => {
    expect(buildTableEdits({})).toEqual([]);
  });

  it('emits table_excluded for each excluded table index', () => {
    const out = buildTableEdits({ excludedTables: new Set([0, 2]) });
    expect(out).toEqual(
      expect.arrayContaining([
        { table_idx: 0, operation: 'table_excluded', detail: {} },
        { table_idx: 2, operation: 'table_excluded', detail: {} },
      ])
    );
    expect(out).toHaveLength(2);
  });

  it('emits column_excluded with header when originalTables provided', () => {
    const original = [mkTable('t', ['a', 'b', 'c'], [])];
    const out = buildTableEdits({
      excludedColumns: { 0: new Set([1, 2]) },
      originalTables: original,
    });
    expect(out).toEqual([
      { table_idx: 0, operation: 'column_excluded', detail: { column_idx: 1, header: 'b' } },
      { table_idx: 0, operation: 'column_excluded', detail: { column_idx: 2, header: 'c' } },
    ]);
  });

  it('detects header_renamed by diffing edited vs original', () => {
    const original = [mkTable('t', ['lot', 'code'], [['1', '2']])];
    const edited = [mkTable('t', ['lot_number', 'code'], [['1', '2']])];
    const out = buildTableEdits({ editedTables: edited, originalTables: original });
    expect(out).toEqual([
      { table_idx: 0, operation: 'header_renamed', detail: { column_idx: 0, from: 'lot', to: 'lot_number' } },
    ]);
  });

  it('detects row_deleted by row count drop', () => {
    const original = [mkTable('t', ['a'], [['1'], ['2'], ['3']])];
    const edited = [mkTable('t', ['a'], [['1']])];
    const out = buildTableEdits({ editedTables: edited, originalTables: original });
    expect(out).toEqual([
      { table_idx: 0, operation: 'row_deleted', detail: { rows_removed: 2 } },
    ]);
  });

  it('combines multiple operations', () => {
    const original = [
      mkTable('t1', ['a', 'b'], [['1', '2'], ['3', '4']]),
      mkTable('t2', ['x'], [['9']]),
    ];
    const edited = [
      mkTable('t1', ['lot', 'b'], [['1', '2']]),
      mkTable('t2', ['x'], [['9']]),
    ];
    const out = buildTableEdits({
      excludedTables: new Set([1]),
      excludedColumns: { 0: new Set([1]) },
      editedTables: edited,
      originalTables: original,
    });
    const ops = out.map(o => o.operation).sort();
    expect(ops).toEqual(['column_excluded', 'header_renamed', 'row_deleted', 'table_excluded']);
  });
});
