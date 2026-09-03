/**
 * Criticality — the rank a spec limit carries (migration 0095).
 *
 * What is worth pinning here is not that a string round-trips. It is the three
 * properties the feature is worthless without:
 *
 *   1. THE DEFAULT IS THE MIDDLE TIER. A client that never touches the control,
 *      and every row written before the column existed, must land on "tracked".
 *      Defaulting to the top tier would recreate the flat screen this exists to
 *      fix; defaulting to the bottom would silently demote real limits.
 *   2. RANK NEVER CHANGES A VERDICT. The same result, judged against the same
 *      threshold, is in_spec / out_of_spec / not_checked regardless of tier. The
 *      moment that stops being true, criticality has become a way to hide a
 *      failure.
 *   3. THE TIER TRAVELS WITH THE VERDICT, so the reviewer UI can sort without
 *      re-resolving a limit it never loaded — and a printed-spec verdict, which
 *      has no configured limit behind it, carries none.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SPEC_CRITICALITY,
  SPEC_CRITICALITY_VALUES,
  compareSpecCriticality,
  isSpecCriticality,
  parseSpecCriticality,
  specCriticalityRank,
} from '../../shared/specCriticality';
import { checkConfiguredLimits } from '../../shared/specCheck';
import type { ConfiguredLimit, SpecSource, SpecTestDef } from '../../shared/specCheck';

const COLIFORM: SpecTestDef = {
  id: 'st-coliform',
  name: 'Coliform',
  aliases: ['Total Coliform'],
  default_unit: 'CFU/g',
};

const LIMIT: ConfiguredLimit = {
  id: 'limit-coliform',
  spec_test_id: COLIFORM.id,
  operator: '<=',
  value_min: null,
  value_max: 10,
  unit: 'CFU/g',
  severity: 'alert',
  active: true,
  supplier_id: null,
  document_type_id: null,
  product_id: null,
};

/** One micro table with a single coliform result. */
function sourceWith(result: string): SpecSource[] {
  return [
    {
      scope: 'ai_fields',
      tables: [
        {
          name: 'Micro',
          headers: ['Test', 'Result', 'Unit'],
          rows: [['Coliform', result, 'CFU/g']],
        },
      ],
    },
  ];
}

describe('the vocabulary', () => {
  it('defaults to the middle tier, not the top one', () => {
    expect(SPEC_CRITICALITY_VALUES).toHaveLength(3);
    expect(DEFAULT_SPEC_CRITICALITY).toBe(SPEC_CRITICALITY_VALUES[1]);
    // The top tier is the one a flat screen would hand out to everything.
    expect(DEFAULT_SPEC_CRITICALITY).not.toBe(SPEC_CRITICALITY_VALUES[0]);
  });

  it('treats anything unrecognised as the default rather than throwing', () => {
    // A row from before migration 0095, a corrupted snapshot, a typo from an
    // importer: all of them still have to render.
    expect(parseSpecCriticality(undefined)).toBe(DEFAULT_SPEC_CRITICALITY);
    expect(parseSpecCriticality(null)).toBe(DEFAULT_SPEC_CRITICALITY);
    expect(parseSpecCriticality('URGENT')).toBe(DEFAULT_SPEC_CRITICALITY);
    expect(parseSpecCriticality(3)).toBe(DEFAULT_SPEC_CRITICALITY);
    expect(isSpecCriticality('URGENT')).toBe(false);
    expect(isSpecCriticality(SPEC_CRITICALITY_VALUES[0])).toBe(true);
  });

  it('ranks the load-stopping tier first', () => {
    const [top, middle, bottom] = SPEC_CRITICALITY_VALUES;
    expect(specCriticalityRank(top)).toBe(0);
    expect(compareSpecCriticality(top, middle)).toBeLessThan(0);
    expect(compareSpecCriticality(bottom, middle)).toBeGreaterThan(0);

    const shuffled = [bottom, top, middle];
    expect([...shuffled].sort(compareSpecCriticality)).toEqual([top, middle, bottom]);
  });
});

describe('checkConfiguredLimits', () => {
  it('reaches the same verdict at every tier — rank is not an input', () => {
    const verdictAt = (criticality: ConfiguredLimit['criticality']) =>
      checkConfiguredLimits(
        sourceWith('40'),
        [COLIFORM],
        [{ ...LIMIT, criticality }],
        {},
        { includePasses: true }
      ).verdicts.map((v) => v.verdict);

    for (const tier of SPEC_CRITICALITY_VALUES) {
      expect(verdictAt(tier)).toEqual(['out_of_spec']);
    }
    expect(verdictAt(undefined)).toEqual(['out_of_spec']);

    // And a passing result stays a pass at the top tier.
    const passes = checkConfiguredLimits(
      sourceWith('2'),
      [COLIFORM],
      [{ ...LIMIT, criticality: SPEC_CRITICALITY_VALUES[0] }],
      {},
      { includePasses: true }
    );
    expect(passes.verdicts.map((v) => v.verdict)).toEqual(['in_spec']);
  });

  it('carries the tier onto every verdict the limit produces', () => {
    const [top] = SPEC_CRITICALITY_VALUES;
    const out = checkConfiguredLimits(
      sourceWith('40'),
      [COLIFORM],
      [{ ...LIMIT, criticality: top }],
      {},
      { includePasses: true }
    );
    expect(out.verdicts[0].criticality).toBe(top);
    expect(out.verdicts[0].source).toBe('limit');
  });

  it('lands a limit with no stored tier on the default', () => {
    const out = checkConfiguredLimits(sourceWith('40'), [COLIFORM], [LIMIT], {});
    expect(out.verdicts[0].criticality).toBe(DEFAULT_SPEC_CRITICALITY);
  });
});
