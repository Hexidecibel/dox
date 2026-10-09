/**
 * The pure hold rule (decision C-005, migration 0139): which judged results
 * place which hold, and what `judgeExit` answers for a held document.
 *
 * The cases here are the client's rules table read literally:
 *   B1  Critical + out of spec            -> hold
 *   E1  MPN against CFU                   -> notify, NEVER held, any analyte
 *   E2  sample-size mismatch              -> hold ONLY on a zero-tolerance analyte
 * and the three things that must never place one: a could-not-check on its
 * own, a printed-limit verdict, and the bulk recheck.
 */
import { describe, it, expect } from 'vitest';
import {
  HOLD_OUTWARD_TEXT,
  HOLD_REASON_MAX,
  automaticHoldsForResults,
  cleanHoldReason,
  describeActiveHolds,
  holdLotLabel,
  holdRefusalText,
  holdSourceForResult,
  holdSourceKey,
  type HoldJudgedResult,
} from '../../shared/holds';
import {
  describeRefusals,
  judgeExit,
  parseRefusedHeader,
  sharingRefusalMessage,
  SHARING_EXITS,
  SHARING_RULES,
  type ExitActor,
} from '../../shared/sharingRule';
import {
  HOLDING_SPEC_CRITICALITY,
  SPEC_CRITICALITY_HELP,
  SPEC_CRITICALITY_LABELS,
  SPEC_CRITICALITY_VALUES,
} from '../../shared/specCriticality';
import { judgeOrderDocumentLine, type OrderDocumentLineFacts } from '../../shared/orderDocuments';
import { compareToLimit, parseMeasuredValue } from '../../shared/specCheck';
import { specResultsWithConfig } from '../../functions/lib/spec-warnings';
import { holdResultFromVerdict } from '../../functions/lib/holds';

const result = (over: Partial<HoldJudgedResult> = {}): HoldJudgedResult => ({
  verdict: 'out_of_spec',
  source: 'limit',
  criticality: HOLDING_SPEC_CRITICALITY,
  not_checked_category: null,
  analyte_category: null,
  result_key: 'record[0]::t0r2',
  result_location: 'Record 1, table 1, row 3',
  test_name_raw: 'Coliform',
  value_raw: '40',
  unit_raw: 'CFU/g',
  limit_text: '<= 10 CFU/g',
  reason: '40 exceeds 10',
  ...over,
});

describe('which judged result places which hold', () => {
  it('B1: out of spec against a Critical limit holds', () => {
    expect(holdSourceForResult(result())).toBe('spec_critical');
  });

  it('the holding tier is the top one, and only that one', () => {
    expect(HOLDING_SPEC_CRITICALITY).toBe(SPEC_CRITICALITY_VALUES[0]);
    expect(SPEC_CRITICALITY_LABELS[HOLDING_SPEC_CRITICALITY]).toBe('Critical');
    for (const tier of SPEC_CRITICALITY_VALUES.slice(1)) {
      expect(holdSourceForResult(result({ criticality: tier }))).toBeNull();
    }
    // A limit with no criticality recorded reads as the default tier elsewhere;
    // here it simply is not Critical.
    expect(holdSourceForResult(result({ criticality: null }))).toBeNull();
    expect(holdSourceForResult(result({ criticality: undefined }))).toBeNull();
  });

  it('a Critical limit that PASSED holds nothing', () => {
    expect(holdSourceForResult(result({ verdict: 'in_spec' }))).toBeNull();
  });

  it('NEVER from not_checked on its own, however critical the limit', () => {
    expect(holdSourceForResult(result({ verdict: 'not_checked' }))).toBeNull();
    expect(
      holdSourceForResult(result({ verdict: 'not_checked', analyte_category: 'zero_tolerance' })),
    ).toBeNull();
  });

  it('E2: a sample-size mismatch holds ONLY on a zero-tolerance analyte', () => {
    const mismatch = { verdict: 'not_checked' as const, not_checked_category: 'sample_basis_mismatch', criticality: 'medium' };
    expect(holdSourceForResult(result({ ...mismatch, analyte_category: 'zero_tolerance' }))).toBe('zero_tolerance');
    for (const category of ['indicator', 'compositional', 'regulatory_ceiling', null, undefined, 'something else']) {
      expect(holdSourceForResult(result({ ...mismatch, analyte_category: category }))).toBeNull();
    }
  });

  it('E1: a method mismatch NEVER holds, even on a zero-tolerance analyte', () => {
    expect(
      holdSourceForResult(
        result({ verdict: 'not_checked', not_checked_category: 'method_mismatch', analyte_category: 'zero_tolerance' }),
      ),
    ).toBeNull();
  });

  it('a bare "Negative" with no sample size passes in the engine and holds nothing (C-016 is a notice)', () => {
    // What the engine does with it today, unchanged by holds.
    const cmp = compareToLimit(parseMeasuredValue('Negative'), { operator: 'absent', min: null, max: null, unit: null, raw: 'Absent/25g', basis_grams: 25 });
    expect(cmp.verdict).toBe('in_spec');
    expect(
      holdSourceForResult(result({ verdict: 'in_spec', analyte_category: 'zero_tolerance', value_raw: 'Negative' })),
    ).toBeNull();
  });

  it("a verdict against the certificate's OWN printed limit holds nothing", () => {
    expect(holdSourceForResult(result({ source: 'printed' }))).toBeNull();
    expect(
      holdSourceForResult(
        result({ source: 'printed', verdict: 'not_checked', not_checked_category: 'sample_basis_mismatch', analyte_category: 'zero_tolerance' }),
      ),
    ).toBeNull();
  });
});

describe('automaticHoldsForResults', () => {
  it('NEVER places anything from the bulk recheck', () => {
    const results = [
      result(),
      result({ verdict: 'not_checked', not_checked_category: 'sample_basis_mismatch', analyte_category: 'zero_tolerance', result_key: 'k2' }),
    ];
    expect(automaticHoldsForResults(results, { origin: 'bulk_recheck', version: 1 })).toEqual([]);
    expect(automaticHoldsForResults(results, { origin: 'approval', version: 1 })).toHaveLength(2);
  });

  it('one proposal per judged result, keyed on version + source + location', () => {
    const out = automaticHoldsForResults([result(), result(), result({ result_key: 'record[0]::t0r5', test_name_raw: 'E. coli' })], {
      origin: 'approval',
      version: 2,
    });
    expect(out.map((p) => p.source_key)).toEqual(['v2:limit:record[0]::t0r2', 'v2:limit:record[0]::t0r5']);
    expect(out[0]).toMatchObject({
      source: 'spec_critical',
      reason: 'Critical result out of spec: Coliform 40 CFU/g (limit <= 10 CFU/g).',
      detail: { test: 'Coliform', value: '40', unit: 'CFU/g', limit: '<= 10 CFU/g', version: 2, location: 'Record 1, table 1, row 3' },
    });
  });

  it('a new VERSION of the certificate is a new result', () => {
    expect(holdSourceKey(1, 'limit', 'k')).not.toBe(holdSourceKey(2, 'limit', 'k'));
    // A nonsense version does not produce a key that collides with nothing.
    expect(holdSourceKey(Number.NaN, 'limit', 'k')).toBe('v1:limit:k');
    expect(holdSourceKey(0, 'limit', 'k')).toBe('v1:limit:k');
  });

  it('words the zero-tolerance hold without calling the result a failure', () => {
    const [p] = automaticHoldsForResults(
      [result({ verdict: 'not_checked', not_checked_category: 'sample_basis_mismatch', analyte_category: 'zero_tolerance', test_name_raw: 'Salmonella', value_raw: 'Absent in 10 g' })],
      { origin: 'approval', version: 1 },
    );
    expect(p.source).toBe('zero_tolerance');
    expect(p.reason).toContain('Salmonella');
    expect(p.reason).toContain('smaller than the limit requires');
    expect(p.reason).not.toMatch(/out of spec|failed/i);
  });

  it('nothing in, nothing out; passes and ordinary could-not-checks place nothing', () => {
    expect(automaticHoldsForResults([], { origin: 'approval', version: 1 })).toEqual([]);
    expect(
      automaticHoldsForResults(
        [result({ verdict: 'in_spec' }), result({ verdict: 'not_checked' }), result({ criticality: 'medium' })],
        { origin: 'approval', version: 1 },
      ),
    ).toEqual([]);
  });

  it('caps a reason at the stored length', () => {
    const [p] = automaticHoldsForResults([result({ test_name_raw: 'x'.repeat(2000) })], { origin: 'approval', version: 1 });
    expect(p.reason.length).toBeLessThanOrEqual(HOLD_REASON_MAX);
  });
});

describe('the engine still produces the shapes the hold rule reads (a hold is a consequence, never an input)', () => {
  const tests = [{ id: 't-sal', name: 'Salmonella', aliases: [], category: 'zero_tolerance' }];
  const limit = {
    id: 'l-sal', spec_test_id: 't-sal', supplier_id: null, product_id: null, document_type_id: null,
    operator: 'absent' as const, value_min: null, value_max: null, unit: 'per 25 g',
    severity: 'alert' as const, criticality: HOLDING_SPEC_CRITICALITY, active: true,
  };
  const judge = (result: string) => {
    const { results } = specResultsWithConfig(
      { tables: JSON.stringify([{ name: 'Micro', headers: ['Test', 'Result'], rows: [['Salmonella', result]] }]) },
      { tests, limits: [limit], unitPolicy: {} },
      { supplier_id: null, document_type_id: null, product_ids: [] },
      { includePasses: true },
    );
    const v = results.find((x) => x.source === 'limit');
    expect(v, `no configured-limit verdict for "${result}"`).toBeTruthy();
    return v!;
  };

  it('a smaller sample on a zero-tolerance analyte: not judged, categorised, banded zero-tolerance -> the E2 hold', () => {
    // If the engine ever stops producing this shape the E2 hold silently stops
    // firing, so it is pinned from the real engine, not from a hand-built row.
    const v = judge('Negative/10g');
    expect(v).toMatchObject({ verdict: 'not_checked', not_checked_category: 'sample_basis_mismatch' });
    expect(v.band?.category).toBe('zero_tolerance');
    expect(holdSourceForResult(holdResultFromVerdict(v))).toBe('zero_tolerance');
  });

  it('detected on a Critical absence limit: out of spec -> the B1 hold', () => {
    const v = judge('Positive');
    expect(v.verdict).toBe('out_of_spec');
    expect(holdSourceForResult(holdResultFromVerdict(v))).toBe('spec_critical');
  });

  it('a bare "Negative" passes, as it always has, and holds nothing', () => {
    const v = judge('Negative');
    expect(v.verdict).toBe('in_spec');
    expect(holdSourceForResult(holdResultFromVerdict(v))).toBeNull();
  });

  it('a sample at least as large as required passes and holds nothing', () => {
    const v = judge('Negative/25g');
    expect(v.verdict).toBe('in_spec');
    expect(holdSourceForResult(holdResultFromVerdict(v))).toBeNull();
  });
});

describe('judgeExit with a hold', () => {
  const actors: ExitActor[] = [
    { method: 'jwt', canReleaseQa: false },
    { method: 'jwt', canReleaseQa: true },
    { method: 'api_key', canReleaseQa: false },
    { method: 'link', canReleaseQa: false },
    { method: 'link', canReleaseQa: true },
  ];

  it('a held document passes exactly one door: a logged-in person opening one file', () => {
    for (const rule of SHARING_RULES) {
      for (const exit of SHARING_EXITS) {
        for (const actor of actors) {
          const verdict = judgeExit(rule, exit, actor, true);
          if (exit === 'portal_file' && actor.method === 'jwt') {
            expect(verdict, `${rule}/${exit}/${actor.method}`).toBe('allow');
          } else {
            expect(verdict, `${rule}/${exit}/${actor.method}`).toBe('held');
          }
        }
      }
    }
  });

  it('nobody releases a held document by sending it: not QA, not an administrator', () => {
    expect(judgeExit('free', 'order_send', { method: 'jwt', canReleaseQa: true }, true)).toBe('held');
    expect(judgeExit('qa', 'zip', { method: 'jwt', canReleaseQa: true }, true)).toBe('held');
  });

  it('with no hold the verdicts are exactly what they were', () => {
    for (const rule of SHARING_RULES) {
      for (const exit of SHARING_EXITS) {
        for (const actor of actors) {
          expect(judgeExit(rule, exit, actor, false)).toBe(judgeExit(rule, exit, actor));
          expect(judgeExit(rule, exit, actor)).not.toBe('held');
        }
      }
    }
  });
});

describe('what a held refusal says', () => {
  it('"On hold: <reason>", naming the lot when the hold is on one', () => {
    expect(holdRefusalText({ reason: 'Customer complaint under review' })).toBe('On hold: Customer complaint under review');
    expect(holdRefusalText({ reason: 'Retest pending', lot_label: '1042 / 03' })).toBe('On hold (lot 1042 / 03): Retest pending');
    expect(holdRefusalText(null)).toBe('On hold.');
    expect(sharingRefusalMessage('held', { hold: { reason: 'Retest pending' } })).toBe('On hold: Retest pending');
    // Distinct from the other two refusals.
    expect(sharingRefusalMessage('locked')).toMatch(/^Locked/);
    expect(sharingRefusalMessage('needs_qa')).toMatch(/^Needs QA approval/);
  });

  it('the sentence a file that LEAVES carries never includes the reason', () => {
    expect(HOLD_OUTWARD_TEXT).toMatch(/^On hold/);
    expect(HOLD_OUTWARD_TEXT).not.toMatch(/result|spec|complaint/i);
  });

  it('describeRefusals names held documents under their own heading', () => {
    expect(
      describeRefusals([
        { title: 'Tax form', reason: 'locked' },
        { title: 'Guarantee letter', reason: 'needs_qa' },
        { title: 'Lot 1042 certificate', reason: 'held' },
      ]),
    ).toBe('3 documents were not included. Locked: Tax form. Needs QA approval: Guarantee letter. On hold: Lot 1042 certificate.');
  });

  it('the refused header round-trips `held`', () => {
    expect(parseRefusedHeader('d1:held,d2:locked,d3:nonsense')).toEqual([
      { document_id: 'd1', reason: 'held' },
      { document_id: 'd2', reason: 'locked' },
    ]);
  });

  it('labels and reasons are tidied the same way everywhere', () => {
    expect(holdLotLabel({ lot_number: '1042', sub_lot_code: '03' })).toBe('1042 / 03');
    expect(holdLotLabel({ lot_number: '1042', sub_lot_code: '' })).toBe('1042');
    expect(holdLotLabel(null)).toBeNull();
    expect(cleanHoldReason('  why  ')).toBe('why');
    expect(cleanHoldReason(42)).toBe('');
    expect(cleanHoldReason('x'.repeat(900))).toHaveLength(HOLD_REASON_MAX);
    expect(describeActiveHolds([])).toBe('');
    expect(describeActiveHolds([{ lot_label: '1042' }, { lot_label: null }])).toBe('2 holds: lot 1042, whole certificate');
  });
});

describe('the Critical explainer no longer says holds are not enforced', () => {
  it('says what a Critical out-of-spec result now does', () => {
    expect(SPEC_CRITICALITY_HELP[HOLDING_SPEC_CRITICALITY]).not.toMatch(/not enforced/i);
    expect(SPEC_CRITICALITY_HELP[HOLDING_SPEC_CRITICALITY]).toMatch(/on hold/);
    expect(SPEC_CRITICALITY_HELP[HOLDING_SPEC_CRITICALITY]).toMatch(/QA releases/);
  });
});

describe('a document line of an order whose document is on hold', () => {
  const facts = (over: Partial<OrderDocumentLineFacts> = {}): OrderDocumentLineFacts => ({
    has_document: true,
    document_status: 'active',
    has_file: true,
    expired: false,
    due_date: null,
    rule: 'free',
    release_status: 'none',
    decision_note: null,
    decided_at: null,
    is_coa_type: false,
    fresh_found: false,
    ...over,
  });
  const hold = { reason: 'Retest pending', lot_label: null };

  it('does not go, for anybody, and says why', () => {
    for (const actor of [{ method: 'jwt', canReleaseQa: false }, { method: 'jwt', canReleaseQa: true }] as ExitActor[]) {
      const j = judgeOrderDocumentLine(facts({ hold }), actor);
      expect(j).toMatchObject({ disposition: 'will_not_go', reason: 'held', behind: true, qa_cause: null });
      expect(j.text).toBe('On hold: Retest pending. It can go once QA or an administrator releases the hold.');
    }
  });

  it('a `qa` document on hold is NOT queued for QA', () => {
    const j = judgeOrderDocumentLine(facts({ rule: 'qa', hold }), { method: 'jwt', canReleaseQa: false });
    expect(j.disposition).toBe('will_not_go');
    expect(j.reason).toBe('held');
  });

  it('a line already waiting for QA stops being releasable while the document is held', () => {
    const j = judgeOrderDocumentLine(facts({ rule: 'qa', release_status: 'pending_qa', hold }), { method: 'jwt', canReleaseQa: true });
    expect(j).toMatchObject({ disposition: 'will_not_go', reason: 'held' });
  });

  it('with no hold the line is judged exactly as before', () => {
    expect(judgeOrderDocumentLine(facts(), { method: 'jwt', canReleaseQa: false }).disposition).toBe('goes_now');
    expect(judgeOrderDocumentLine(facts({ hold: null }), { method: 'jwt', canReleaseQa: false }).disposition).toBe('goes_now');
  });
});
