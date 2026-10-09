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
import { fileCarriesLot, filePagesOf, heldLotOf, holdForLot, lotHoldCovers, type LotLink } from '../../functions/lib/hold-state';

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

describe('which files a hold stops: a file is what leaves (C-084)', () => {
  const page = (queue: string | null, pages: number[] | null, scoped = true) => ({ queue_id: queue, page_scoped: scoped, pages });

  it('lots of one certificate on SEPARATE pages: each file is its own', () => {
    expect(fileCarriesLot(page('q1', [2]), page('q1', [1]))).toBe(false);
    expect(fileCarriesLot(page('q1', [2, 3]), page('q1', [1, 4]))).toBe(false);
  });

  it('two lots on the SAME page: sending one sends the other', () => {
    expect(fileCarriesLot(page('q1', [1]), page('q1', [1]))).toBe(true);
    expect(fileCarriesLot(page('q1', [1, 2]), page('q1', [2, 3]))).toBe(true);
  });

  it('a file that could not be cut holds the whole certificate, so it carries every lot', () => {
    expect(fileCarriesLot(page('q1', null, false), page('q1', [3]))).toBe(true);
    expect(fileCarriesLot(page('q1', [9], false), page('q1', [3]))).toBe(true);
  });

  it('cannot tell tightens: pages not recorded on either side is "yes"', () => {
    expect(fileCarriesLot(page('q1', null), page('q1', [1]))).toBe(true);
    expect(fileCarriesLot(page('q1', [1]), page('q1', null))).toBe(true);
  });

  it('a certificate REISSUED since: the file a hold was placed under is found by its versions (C-085)', () => {
    const reissued = { queue_id: 'q2', queue_ids: ['q1', 'q2'], page_scoped: true, pages: [1] };
    // A neighbour cut from the reissue, on the same page: carried by the page rule.
    expect(fileCarriesLot(page('q2', [1]), reissued)).toBe(true);
    expect(fileCarriesLot(page('q2', [2]), reissued)).toBe(false);
    // A file still cut from the FIRST issue printed this lot as it stood then;
    // which page is no longer recorded, so it is carried.
    expect(fileCarriesLot(page('q1', [2]), reissued)).toBe(true);
    // And a file from an unrelated queue item is not.
    expect(fileCarriesLot(page('q3', [1]), reissued)).toBe(false);
  });

  it('a different certificate, or a document not cut from a queue item, carries nothing', () => {
    expect(fileCarriesLot(page('q1', [1]), page('q2', [1]))).toBe(false);
    expect(fileCarriesLot(page(null, [1]), page('q1', [1]))).toBe(false);
    expect(fileCarriesLot(page('q1', [1]), page(null, [1]))).toBe(false);
    expect(fileCarriesLot(page(null, null, false), page(null, null, false))).toBe(false);
  });

  it('reads what a document row records about its file', () => {
    expect(filePagesOf({ origin_queue_id: 'q1', external_ref: 'queue-zzz-1', page_scoped: 1, scoped_pages: '[2,3]', source_pages: '[9]' })).toEqual({
      queue_id: 'q1',
      queue_ids: ['q1'],
      page_scoped: true,
      pages: [2, 3],
    });
    // No origin column: the queue id inside external_ref. No scoped pages: the source pages.
    expect(filePagesOf({ origin_queue_id: null, external_ref: 'queue-abc123-5501', page_scoped: null, source_pages: '[1]' })).toEqual({
      queue_id: 'abc123',
      queue_ids: ['abc123'],
      page_scoped: false,
      pages: [1],
    });
    expect(filePagesOf({ external_ref: 'manual-upload', scoped_pages: 'not json' })).toEqual({ queue_id: null, queue_ids: [], page_scoped: false, pages: null });

    // THE FILE IS THE CURRENT VERSION (C-085). A certificate reissued through
    // "Replace existing" keeps the origin of version 1; its file is the one
    // version 2 was cut from.
    expect(
      filePagesOf({ current_version: 2, version_queue_id: 'q2', version_queue_ids: 'q1,q2', origin_queue_id: 'q1', external_ref: 'queue-q1-5501', page_scoped: 1, scoped_pages: '[1]' }),
    ).toEqual({ queue_id: 'q2', queue_ids: ['q1', 'q2'], page_scoped: true, pages: [1] });
    // A later version nothing recorded a queue item for was uploaded by hand:
    // its file was cut from no queue item, whatever the document was born from.
    expect(filePagesOf({ current_version: 2, version_queue_id: null, version_queue_ids: 'q1', origin_queue_id: 'q1' }).queue_id).toBeNull();
    expect(filePagesOf({ origin_queue_id: 'q1', scoped_pages: '[]', source_pages: '["x", 0, -1]' }).pages).toBeNull();
  });

  it('a line names the hold on its own lot when there is one, else the first that stops the file', () => {
    const a = { id: 'a', document_id: 'd1', lot_id: 'l1', lot_label: '1', reason: 'r', source: 'person' as const, placed_at: '1' };
    const b = { id: 'b', document_id: 'd1', lot_id: 'l2', lot_label: '2', reason: 'r', source: 'person' as const, placed_at: '2' };
    expect(holdForLot([a, b], 'l2')).toBe(b);
    expect(holdForLot([a, b], 'l9')).toBe(a);
    expect(holdForLot([a, b], null)).toBe(a);
    expect(holdForLot([], 'l1')).toBeNull();
    expect(holdForLot(undefined, 'l1')).toBeNull();
  });
});

describe('which certificates a LOT hold covers: supplier + lot key + sublot, whatever the product (C-091)', () => {
  const held = heldLotOf({ lot_id: 'row-1', lot_key: '10426203', sub_lot_code: '03', lot_supplier_id: 'sup-a', document_supplier_id: 'sup-a' });
  const link = (over: Partial<LotLink> = {}): LotLink => ({
    lot_id: 'row-2',
    lot_key: '10426203',
    sub_lot_code: '03',
    lot_supplier_id: 'sup-a',
    document_id: 'd2',
    document_supplier_id: 'sup-a',
    ...over,
  });

  it('another row of the same lot (the product resolved differently) is covered', () => {
    expect(lotHoldCovers(held, link())).toBe(true);
    // The no-product row, whose own supplier is whoever printed the number first.
    expect(lotHoldCovers(held, link({ lot_supplier_id: null }))).toBe(true);
    expect(lotHoldCovers(held, link({ lot_supplier_id: 'sup-b' }))).toBe(true);
  });

  it("another supplier's lot with the same number is NOT covered, even on the very same row", () => {
    expect(lotHoldCovers(held, link({ document_supplier_id: 'sup-b', lot_supplier_id: 'sup-b' }))).toBe(false);
    expect(lotHoldCovers(held, link({ document_supplier_id: 'sup-b', lot_supplier_id: 'sup-a' }))).toBe(false);
    expect(lotHoldCovers(held, link({ lot_id: 'row-1', document_supplier_id: 'sup-b' }))).toBe(false);
  });

  it('a different sublot, or a different key, is a different lot', () => {
    expect(lotHoldCovers(held, link({ sub_lot_code: '04' }))).toBe(false);
    expect(lotHoldCovers(held, link({ sub_lot_code: '' }))).toBe(false);
    expect(lotHoldCovers(held, link({ sub_lot_code: null }))).toBe(false);
    expect(lotHoldCovers(held, link({ lot_key: '10426204' }))).toBe(false);
    // No fuzzing: the stored key, as stored.
    expect(lotHoldCovers(held, link({ lot_key: '10426203 ' }))).toBe(true);
    expect(lotHoldCovers(held, link({ lot_key: '1042-6203' }))).toBe(false);
  });

  it('a certificate with no supplier falls back to its lot row; with neither it is covered only on the held row', () => {
    expect(lotHoldCovers(held, link({ document_supplier_id: null, lot_supplier_id: 'sup-a' }))).toBe(true);
    expect(lotHoldCovers(held, link({ document_supplier_id: null, lot_supplier_id: 'sup-b' }))).toBe(false);
    expect(lotHoldCovers(held, link({ document_supplier_id: null, lot_supplier_id: null }))).toBe(false);
    expect(lotHoldCovers(held, link({ lot_id: 'row-1', document_supplier_id: null, lot_supplier_id: null }))).toBe(true);
  });

  it('a row with an empty lot key matches nothing but itself', () => {
    const blank = heldLotOf({ lot_id: 'row-9', lot_key: '', sub_lot_code: '', lot_supplier_id: 'sup-a', document_supplier_id: 'sup-a' });
    expect(lotHoldCovers(blank, link({ lot_key: '', sub_lot_code: '' }))).toBe(false);
    expect(lotHoldCovers(blank, link({ lot_key: null, sub_lot_code: '' }))).toBe(false);
    expect(lotHoldCovers(blank, link({ lot_id: 'row-9', lot_key: '', sub_lot_code: '' }))).toBe(true);
  });

  it('a hold whose supplier nobody recorded covers only the row it is on', () => {
    const unknown = heldLotOf({ lot_id: 'row-1', lot_key: '10426203', sub_lot_code: '03', lot_supplier_id: null, document_supplier_id: null });
    expect(unknown.supplier_id).toBeNull();
    expect(lotHoldCovers(unknown, link())).toBe(false);
    expect(lotHoldCovers(unknown, link({ lot_id: 'row-1' }))).toBe(true);
    expect(lotHoldCovers(unknown, link({ lot_id: 'row-1', document_supplier_id: null }))).toBe(true);
  });

  it("whose lot it is: the placing certificate's supplier, else the row's", () => {
    expect(heldLotOf({ lot_id: 'r', lot_key: 'k', sub_lot_code: null, lot_supplier_id: 'sup-row', document_supplier_id: 'sup-doc' })).toEqual({ lot_id: 'r', lot_key: 'k', sub_lot_code: '', supplier_id: 'sup-doc' });
    expect(heldLotOf({ lot_id: 'r', lot_key: ' k ', lot_supplier_id: 'sup-row', document_supplier_id: null }).supplier_id).toBe('sup-row');
    expect(heldLotOf({ lot_id: 'r', lot_key: ' k ' }).lot_key).toBe('k');
  });
});

