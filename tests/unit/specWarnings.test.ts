/**
 * functions/lib/spec-warnings.ts — attaching spec verdicts to a queue row.
 *
 * The engine itself is covered by `specCheck.test.ts`. What matters here is the
 * plumbing: finding every place a queue row hides test results, tagging each
 * with the scope name the review UI routes on, and never throwing. A row that
 * reaches a reviewer without its warnings is a silent failure, so the
 * degradation path is asserted explicitly.
 */

import { describe, it, expect } from 'vitest';
import { specSourcesFor, specResultsFor, withSpecResults } from '../../functions/lib/spec-warnings';

const MICRO_TABLE = {
  name: 'microbiological_analysis',
  headers: ['test', 'specification', 'result', 'units', 'pass_fail'],
  rows: [
    ['SPC', '<20000', '4500', 'CFU/g', 'Pass'],
    ['Coliform', '<10', '40', 'CFU/g', ''],
  ],
};

describe('specSourcesFor', () => {
  it('finds tables on the flat extraction path', () => {
    const sources = specSourcesFor({ tables: JSON.stringify([MICRO_TABLE]) });
    expect(sources).toHaveLength(1);
    expect(sources[0].scope).toBe('ai_fields');
    expect(sources[0].tables).toHaveLength(1);
  });

  it('finds tables and groups on every record of the records path', () => {
    const payload = {
      record_cardinality: 'multi_lot',
      record_key_basis: 'lot',
      page_metadata: {},
      records: [
        { record_index: 0, fields: {}, tables: [MICRO_TABLE] },
        { record_index: 1, fields: {}, groups: { micro: { coliform: { value: '40', spec: '<10' } } } },
      ],
    };
    const sources = specSourcesFor({ ai_records: JSON.stringify(payload) });
    expect(sources.map((s) => s.scope)).toEqual(['record[0]', 'record[1]']);
    expect(sources[0].tables).toHaveLength(1);
    expect(sources[1].groups).toBeTruthy();
  });

  it('skips records that carry no results at all', () => {
    const payload = { records: [{ record_index: 0, fields: { lot_code: 'L1' } }] };
    expect(specSourcesFor({ ai_records: JSON.stringify(payload) })).toEqual([]);
  });

  it('accepts already-parsed objects as well as JSON strings', () => {
    expect(specSourcesFor({ tables: [MICRO_TABLE] })).toHaveLength(1);
  });

  it('degrades to nothing on malformed or oversized payloads', () => {
    expect(specSourcesFor({ tables: '{not json' })).toEqual([]);
    expect(specSourcesFor({ ai_records: '[object Object]' })).toEqual([]);
    expect(specSourcesFor({ tables: null, ai_records: undefined })).toEqual([]);
    // Past the CPU guard, a pathological payload is skipped rather than parsed.
    expect(specSourcesFor({ tables: `[${'"x",'.repeat(120_000)}]` })).toEqual([]);
  });
});

describe('specResultsFor', () => {
  it('surfaces the out-of-spec row from a real-shaped queue item', () => {
    const results = specResultsFor({ tables: JSON.stringify([MICRO_TABLE]) });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      verdict: 'out_of_spec',
      test_name_raw: 'Coliform',
      scope: 'ai_fields',
    });
  });

  it('never throws, whatever the row contains', () => {
    expect(() => specResultsFor({})).not.toThrow();
    expect(() => specResultsFor({ tables: 42, ai_records: false })).not.toThrow();
    expect(specResultsFor({ tables: 42 })).toEqual([]);
  });
});

describe('withSpecResults', () => {
  it('attaches the array without mutating the row', () => {
    const row = { id: 'q1', tables: JSON.stringify([MICRO_TABLE]) };
    const out = withSpecResults(row);
    expect(out.id).toBe('q1');
    expect(out.spec_results).toHaveLength(1);
    expect(row).not.toHaveProperty('spec_results');
  });

  it('attaches an empty array for a clean item, never undefined', () => {
    // The UI branches on length; undefined would be a different code path.
    expect(withSpecResults({ id: 'q2' }).spec_results).toEqual([]);
  });
});
