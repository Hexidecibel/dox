/**
 * shared/searchProbes.ts — the question generator and scorer shared by
 * GET /api/search/examples, bin/eval-search and the golden eval test.
 */

import { describe, it, expect } from 'vitest';
import {
  formatScorecard, numericDate, overallRate, plainProductName, probesForDocument, sampleProbes, scoreProbe, scorecard,
  seededRandom, seededShuffle, shiftDay, spokenDay, spokenMonth, supplierWord, type EvalSample, type Probe, type SampleDoc,
} from '../../shared/searchProbes';

const DOC: SampleDoc = {
  id: 'd1',
  title: 'COA Darigold',
  supplier_id: 's1',
  supplier_name: 'Darigold, Inc.',
  document_type_name: 'Certificate of Analysis',
  document_type_slug: 'coa',
  printed_product: 'SWEET CREAM BUTTER - Btr NS Gr AA 25kg',
  lots: [
    { lot_number: '10426203', sub_lot_code: '03', lot_key: '1042620303', production_date: '2026-07-22', production_date_source: 'extracted' },
  ],
  keys: [{ kind: 'supplier_po', value_raw: 'K 134273' }, { kind: 'invoice_number', value_raw: '261149' }, { kind: 'certificate_number', value_raw: 'SQF-1' }],
  products: [{ id: 'p1', name: 'DG BTR BULK U/S 55.115#', names: ['bulk unsalted butter'] }],
};

describe('plainProductName', () => {
  it('prefers words a person says over catalog code-names', () => {
    expect(plainProductName(['DG BTR BULK U/S 55.115#'])).toBeNull();
    expect(plainProductName(['Cream 5G'])).toBe('cream');
    expect(plainProductName(['SWEET CREAM BUTTER - Unsalted 25kg', 'unsalted butter'])).toBe('unsalted butter');
    expect(plainProductName(['Cream - Heavy Whipping 40%'])).toBe('cream heavy whipping');
    expect(plainProductName(['Milk - Whole', '300 Gallon Tote'])).toBe('milk whole');
    expect(plainProductName([null, undefined, ''])).toBeNull();
  });
});

describe('dates', () => {
  it('speaks days and months, and shifts across a month end', () => {
    expect(spokenDay('2026-04-07')).toBe('Apr 7');
    expect(spokenMonth('2026-03-31')).toBe('March');
    expect(numericDate('2026-04-17')).toBe('4/17/2026');
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('probesForDocument', () => {
  it('asks every spelling of the lot, the PO, the invoice, the number, product + day / month, supplier + type', () => {
    const texts = Object.fromEntries(probesForDocument(DOC).map((p) => [p.kind, p]));
    expect(texts.lot_composite.text).toBe('lot 1042620303');
    expect(texts.lot_dash.text).toBe('10426203-03');
    expect(texts.lot_space.text).toBe('10426203 03');
    expect(texts.lot_exact).toBeUndefined();
    expect(texts.supplier_po.text).toBe('PO K 134273');
    expect(texts.invoice.text).toBe('invoice 261149');
    expect(texts.document_number.text).toBe('SQF-1');
    expect(texts.product_day).toMatchObject({ text: 'unsalted butter produced Jul 22', expect: 'covering' });
    expect(texts.product_month).toMatchObject({ text: 'unsalted butter produced in July', needs: 'month_phrases' });
    expect(texts.supplier_type).toMatchObject({ text: 'darigold coa', expect: 'listed' });
  });

  it('a legacy or decoded production date is expected LIKELY, never covering', () => {
    for (const source of ['extracted_code_date_legacy', 'lot_decode'] as const) {
      const d = { ...DOC, lots: [{ ...DOC.lots[0], production_date_source: source }] };
      const p = probesForDocument(d).find((x) => x.kind === 'product_day');
      expect(p?.expect).toBe('likely');
      expect(p?.basis).toBeTruthy();
    }
  });

  it('a lot with no sublot is asked as printed', () => {
    const d = { ...DOC, lots: [{ ...DOC.lots[0], lot_number: 'K349', sub_lot_code: '', lot_key: 'K349' }] };
    expect(probesForDocument(d).filter((p) => p.kind.startsWith('lot')).map((p) => p.text)).toEqual(['lot K349']);
  });

  it('supplierWord skips legal suffixes', () => {
    expect(supplierWord('The Andersen Dairy, Inc.')).toBe('andersen');
    expect(supplierWord(null)).toBeNull();
  });
});

describe('sampleProbes', () => {
  it('turns verified negatives into none-probes, the wrong supplier as a chip', () => {
    const sample: EvalSample = {
      tenant_id: 't', seed: 's', n: 1, docs: [DOC],
      negatives: {
        days: [{ doc_id: 'd1', day: '2026-07-21' }],
        lots: [{ doc_id: 'd1', lot: '10426203-98' }],
        wrong_supplier: [{ doc_id: 'd1', lot: '10426203-03', supplier_id: 's2', supplier_name: 'Other' }],
      },
      lot_prefixes: [{ doc_id: 'd1', prefix: '104', supplier_name: 'Darigold, Inc.', segment: 'plant' }],
    };
    const ps = sampleProbes(sample);
    const neg = ps.filter((p) => p.expect === 'none');
    expect(neg.map((p) => p.text)).toEqual(['unsalted butter produced 7/21/2026', 'lot 10426203-98', 'lot 10426203-03']);
    expect(neg[2].clauses?.[0]).toMatchObject({ field: 'supplier', values: ['s2'] });
    expect(ps.find((p) => p.kind === 'lot_prefix')?.text).toBe('lot 104');
  });
});

describe('scoreProbe / scorecard', () => {
  const pos: Probe = { kind: 'lot_dash', text: '10426203-03', doc_id: 'd1', expect: 'covering' };
  const likely: Probe = { kind: 'product_day', text: 'x produced Jul 22', doc_id: 'd1', expect: 'likely', basis: 'decoded from the lot code' };
  const neg: Probe = { kind: 'neg_adjacent_day', text: 'x produced 7/21/2026', doc_id: 'd1', expect: 'none' };

  it('a positive passes only in its band', () => {
    expect(scoreProbe(pos, { coverage: 'covered', documents: [{ id: 'd1', match_status: 'covering' }] }).outcome).toBe('pass');
    const nearby = scoreProbe(pos, { coverage: 'none', documents: [{ id: 'd1', match_status: 'candidate_not_matching' }] });
    expect(nearby).toMatchObject({ outcome: 'fail', landed: 'nearby' });
    // A likely-expected probe that comes back COVERING is a regression, not a bonus.
    expect(scoreProbe(likely, { coverage: 'covered', documents: [{ id: 'd1', match_status: 'covering' }] }).outcome).toBe('fail');
    expect(scoreProbe(likely, { coverage: 'likely', documents: [{ id: 'd1', match_status: 'likely_covering' }] }).outcome).toBe('pass');
  });

  it('a negative passes only with nothing presented as covering or likely; nearby is fine', () => {
    expect(scoreProbe(neg, { coverage: 'none', documents: [{ id: 'd1', match_status: 'candidate_not_matching' }] }).outcome).toBe('pass');
    const bad = scoreProbe(neg, { coverage: 'covered', documents: [{ id: 'd9', match_status: 'covering' }] });
    expect(bad).toMatchObject({ outcome: 'fail', wrongly_covering: ['d9'] });
  });

  it('an unsupported probe is reported, never failed', () => {
    const r = scoreProbe({ ...pos, kind: 'product_month', needs: 'month_phrases' }, { coverage: 'unconstrained', documents: [] }, false);
    expect(r.outcome).toBe('unsupported');
  });

  it('scorecard: per-kind rates, negatives apart, failures listed with what came back', () => {
    const results = [
      scoreProbe(pos, { coverage: 'covered', documents: [{ id: 'd1', match_status: 'covering' }] }),
      scoreProbe(pos, { coverage: 'none', documents: [], coverage_summary: 'No document on file covers lot 10426203-03.' }),
      scoreProbe(likely, { coverage: 'likely', documents: [{ id: 'd1', match_status: 'likely_covering' }] }),
      scoreProbe(neg, { coverage: 'none', documents: [] }),
      scoreProbe({ ...pos, kind: 'product_month', needs: 'month_phrases' }, { documents: [] }, false),
    ];
    const card = scorecard(results);
    expect(card.kinds.find((k) => k.kind === 'lot_dash')).toMatchObject({ total: 2, pass: 1, rate: 0.5 });
    expect(card.positives).toMatchObject({ total: 3, pass: 2 });
    expect(card.negatives).toMatchObject({ total: 1, pass: 1 });
    expect(card.unsupported).toBe(1);
    expect(card.likely_by_basis['decoded from the lot code']).toEqual({ total: 1, pass: 1 });
    expect(overallRate(card)).toBe(0.75);
    const text = formatScorecard(card);
    expect(text).toContain('lot-sublot (20726114-02)');
    expect(text).toContain('[lot_dash] "10426203-03" (doc d1): expected covering, document landed absent (coverage=none)');
    expect(text).toContain('No document on file covers lot 10426203-03.');
    expect(text).toContain('1 unsupported by the reader');
  });
});

describe('seeded sampling', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const xs = Array.from({ length: 30 }, (_, i) => i);
    expect(seededShuffle(xs, 'a')).toEqual(seededShuffle(xs, 'a'));
    expect(seededShuffle(xs, 'a')).not.toEqual(seededShuffle(xs, 'b'));
    expect([...seededShuffle(xs, 'a')].sort((p, q) => p - q)).toEqual(xs);
    const r = seededRandom('x');
    const v = r();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });
});
