/**
 * Unit tests for the Phase 3 learnedPreferences aggregator. Pure-function
 * tests over the three aggregation helpers — the DB-bound getLearnedPreferences
 * is exercised in API integration tests.
 *
 * Critical case: tied picks (text_value === vlm_value) must NOT count toward
 * the source-preference vote. classifyFieldSource() in reviewCaptureBuilder
 * breaks ties alphabetically and returns 'text' — counting those would skew
 * every aggregate toward text. Verified explicitly below.
 */

import { describe, it, expect } from 'vitest';
import {
  aggregatePicks,
  aggregateDismissals,
  aggregateTableEdits,
} from '../../functions/lib/learnedPreferences';

interface PickRow {
  field_key: string;
  text_value: string | null;
  vlm_value: string | null;
  chosen_source: string;
  final_value: string | null;
}

function pick(overrides: Partial<PickRow> & { field_key: string; chosen_source: string }): PickRow {
  return {
    field_key: overrides.field_key,
    text_value: overrides.text_value ?? null,
    vlm_value: overrides.vlm_value ?? null,
    chosen_source: overrides.chosen_source,
    final_value: overrides.final_value ?? null,
  };
}

describe('aggregatePicks', () => {
  it('returns empty when there is no data', () => {
    expect(aggregatePicks([])).toEqual({});
  });

  it('does not expose preference when ALL picks are tied', () => {
    // Three picks where text and VLM agreed; classifyFieldSource returned 'text'
    // alphabetically, but these are not real text-side wins.
    const picks = [
      pick({ field_key: 'lot_number', text_value: 'L-1', vlm_value: 'L-1', chosen_source: 'text', final_value: 'L-1' }),
      pick({ field_key: 'lot_number', text_value: 'L-2', vlm_value: 'L-2', chosen_source: 'text', final_value: 'L-2' }),
      pick({ field_key: 'lot_number', text_value: 'L-3', vlm_value: 'L-3', chosen_source: 'text', final_value: 'L-3' }),
    ];
    expect(aggregatePicks(picks)).toEqual({});
  });

  it('mixed picks: 3 vlm + 1 text + 2 ties → vlm wins with 0.75 agreement', () => {
    const picks = [
      pick({ field_key: 'lot_number', text_value: 'L-A', vlm_value: 'L-B', chosen_source: 'vlm', final_value: 'L-B' }),
      pick({ field_key: 'lot_number', text_value: 'L-C', vlm_value: 'L-D', chosen_source: 'vlm', final_value: 'L-D' }),
      pick({ field_key: 'lot_number', text_value: 'L-E', vlm_value: 'L-F', chosen_source: 'vlm', final_value: 'L-F' }),
      pick({ field_key: 'lot_number', text_value: 'L-G', vlm_value: 'L-H', chosen_source: 'text', final_value: 'L-G' }),
      pick({ field_key: 'lot_number', text_value: 'L-X', vlm_value: 'L-X', chosen_source: 'text', final_value: 'L-X' }),
      pick({ field_key: 'lot_number', text_value: 'L-Y', vlm_value: 'L-Y', chosen_source: 'text', final_value: 'L-Y' }),
    ];
    const result = aggregatePicks(picks);
    expect(result.lot_number).toBeDefined();
    expect(result.lot_number.preferred_source).toBe('vlm');
    // 4 non-tied picks, 3 vlm + 1 text → agreement = 0.75; min(4/5,1) = 0.8 → confidence = 0.6
    expect(result.lot_number.pick_count).toBe(6);
    expect(result.lot_number.confidence).toBeCloseTo(0.6, 5);
  });

  it('insufficient non-tied picks → no preference exposed', () => {
    const picks = [
      pick({ field_key: 'lot_number', text_value: 'L-A', vlm_value: 'L-B', chosen_source: 'vlm', final_value: 'L-B' }),
      pick({ field_key: 'lot_number', text_value: 'L-C', vlm_value: 'L-D', chosen_source: 'vlm', final_value: 'L-D' }),
    ];
    expect(aggregatePicks(picks)).toEqual({});
  });

  it('exposes most_common_value when all picks chose the same final value', () => {
    const picks = [
      pick({ field_key: 'product_code', text_value: 'X', vlm_value: 'Y', chosen_source: 'vlm', final_value: 'PROD-9' }),
      pick({ field_key: 'product_code', text_value: 'X', vlm_value: 'Y', chosen_source: 'vlm', final_value: 'PROD-9' }),
      pick({ field_key: 'product_code', text_value: 'X', vlm_value: 'Y', chosen_source: 'vlm', final_value: 'PROD-9' }),
    ];
    expect(aggregatePicks(picks).product_code.most_common_value).toBe('PROD-9');
  });

  it('omits most_common_value when final values disagree', () => {
    const picks = [
      pick({ field_key: 'lot_number', text_value: 'X', vlm_value: 'Y', chosen_source: 'vlm', final_value: 'A' }),
      pick({ field_key: 'lot_number', text_value: 'X', vlm_value: 'Y', chosen_source: 'vlm', final_value: 'B' }),
      pick({ field_key: 'lot_number', text_value: 'X', vlm_value: 'Y', chosen_source: 'vlm', final_value: 'C' }),
    ];
    expect(aggregatePicks(picks).lot_number.most_common_value).toBeUndefined();
  });

  it('confidence saturates at pick_count >= 5 with 100% agreement', () => {
    const picks = Array.from({ length: 5 }, (_, i) =>
      pick({ field_key: 'supplier_name', text_value: `T-${i}`, vlm_value: `V-${i}`, chosen_source: 'vlm', final_value: `V-${i}` })
    );
    const result = aggregatePicks(picks);
    expect(result.supplier_name.confidence).toBe(1);
  });

  it('treats edited and dismissed picks as non-source votes', () => {
    const picks = [
      pick({ field_key: 'lot_number', text_value: 'A', vlm_value: 'B', chosen_source: 'edited', final_value: 'C' }),
      pick({ field_key: 'lot_number', text_value: 'A', vlm_value: 'B', chosen_source: 'edited', final_value: 'C' }),
      pick({ field_key: 'lot_number', text_value: 'A', vlm_value: 'B', chosen_source: 'edited', final_value: 'C' }),
    ];
    expect(aggregatePicks(picks)).toEqual({});
  });
});

describe('aggregateDismissals', () => {
  it('returns empty when there is nothing dismissed', () => {
    expect(aggregateDismissals([], [], new Map())).toEqual([]);
  });

  it('adds field when dismissed in 3 of 4 reviews (75% < 80% threshold)', () => {
    // 3 dismissals + 1 pick = 4 total reviews; 3/4 = 0.75 → below threshold
    const dismissals = [
      { field_key: 'product_code', queue_item_id: 'q1' },
      { field_key: 'product_code', queue_item_id: 'q2' },
      { field_key: 'product_code', queue_item_id: 'q3' },
    ];
    const pickItemMap = new Map<string, Set<string>>();
    pickItemMap.set('product_code', new Set(['q4']));
    expect(aggregateDismissals(dismissals, [], pickItemMap)).toEqual([]);
  });

  it('adds field when dismissed in 4 of 5 reviews (80% >= threshold, >= 3 reviews)', () => {
    const dismissals = [
      { field_key: 'product_code', queue_item_id: 'q1' },
      { field_key: 'product_code', queue_item_id: 'q2' },
      { field_key: 'product_code', queue_item_id: 'q3' },
      { field_key: 'product_code', queue_item_id: 'q4' },
    ];
    const pickItemMap = new Map<string, Set<string>>();
    pickItemMap.set('product_code', new Set(['q5']));
    expect(aggregateDismissals(dismissals, [], pickItemMap)).toEqual(['product_code']);
  });

  it('ignores fields below the 3-review minimum', () => {
    const dismissals = [
      { field_key: 'lot_number', queue_item_id: 'q1' },
      { field_key: 'lot_number', queue_item_id: 'q2' },
    ];
    expect(aggregateDismissals(dismissals, [], new Map())).toEqual([]);
  });

  it('does not add field when dismissed in 2 of 4 reviews', () => {
    const dismissals = [
      { field_key: 'product_code', queue_item_id: 'q1' },
      { field_key: 'product_code', queue_item_id: 'q2' },
    ];
    const pickItemMap = new Map<string, Set<string>>();
    pickItemMap.set('product_code', new Set(['q3', 'q4']));
    expect(aggregateDismissals(dismissals, [], pickItemMap)).toEqual([]);
  });
});

describe('aggregateTableEdits', () => {
  it('returns empty when no edits', () => {
    expect(aggregateTableEdits([])).toEqual([]);
  });

  it('aggregates repeated column excludes into excluded_columns', () => {
    const edits = [
      { table_idx: 0, operation: 'column_excluded', detail: JSON.stringify({ column_idx: 2 }) },
      { table_idx: 0, operation: 'column_excluded', detail: JSON.stringify({ column_idx: 2 }) },
    ];
    const result = aggregateTableEdits(edits);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      table_idx_pattern: 0,
      excluded_columns: [2],
      header_renames: {},
    });
  });

  it('skips one-off column excludes', () => {
    const edits = [
      { table_idx: 0, operation: 'column_excluded', detail: JSON.stringify({ column_idx: 2 }) },
    ];
    expect(aggregateTableEdits(edits)).toEqual([]);
  });

  it('aggregates consistent header renames', () => {
    const edits = [
      { table_idx: 1, operation: 'header_renamed', detail: JSON.stringify({ from: 'Test', to: 'Method' }) },
      { table_idx: 1, operation: 'header_renamed', detail: JSON.stringify({ from: 'Test', to: 'Method' }) },
    ];
    const result = aggregateTableEdits(edits);
    expect(result).toHaveLength(1);
    expect(result[0].header_renames).toEqual({ Test: 'Method' });
  });
});
