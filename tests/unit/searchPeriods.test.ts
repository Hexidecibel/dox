/**
 * Months and ranges typed into search (the owner's "butter produced in april"
 * returned nothing: the month was never read as a date, so "produced", "in"
 * and "april" were all required as FTS words).
 *
 *   - Month and range phrases become ONE date clause with the same role logic
 *     as a day: produced/made -> production date, best by -> best-by, code
 *     date -> code date, expires -> expiration.
 *   - A month with no year is that month in ANY year; a span across the year
 *     end with no year (Dec 15 to Jan 15) wraps.
 *   - The role word and the filler ("produced in") are part of the clause,
 *     never left behind as required words.
 *   - "may" as a verb is not a month.
 *   - The epistemics are unchanged: a legacy code-date production date or a
 *     lot-decoded one inside the month is still only LIKELY; a miss outside a
 *     span is a mismatch, never "nearby".
 */

import { describe, it, expect } from 'vitest';
import { detectOptimistic, detectProduct } from '../../shared/searchInterpret';
import { describeClause, type Clause } from '../../shared/searchQuery';
import { clauseToConstraint, validateClause } from '../../shared/searchFields';
import { checkDate, parseQueryText, residualText, type CoverageSubject } from '../../shared/searchCoverage';
import { findQueryPeriods, inMonthDayRange } from '../../shared/searchDates';
import { prepareCatalog } from '../../shared/productIdentity';
import { chipParts, chipSentence } from '../../src/lib/searchChips';

const NOW = new Date('2026-09-29T12:00:00Z');

function read(text: string) {
  return detectOptimistic(text, { now: NOW });
}

function one(text: string): Clause {
  const d = read(text);
  const dates = d.clauses.filter((c) => c.field !== 'lot');
  expect(dates).toHaveLength(1);
  return dates[0];
}

function subject(over: Partial<CoverageSubject> = {}): CoverageSubject {
  return {
    id: 'd1', supplier_name: null, supplier_aliases: [], document_type_slug: null, document_type_name: null,
    product_names: [], metadata: {}, lots: [], created_at: '2026-08-01T00:00:00Z', renewal_due_date: null, text_match: null,
    ...over,
  };
}

function constraintOf(c: Clause) {
  const r = clauseToConstraint(c, 'c1');
  if (!('constraint' in r)) throw new Error('dropped');
  return r.constraint;
}

describe('the phrase -> chip table (the owner\'s phrasings)', () => {
  const table: Array<[string, Partial<Clause>, string, string]> = [
    ['butter produced in april', { field: 'production_date', op: 'between', values: ['--04-01', '--04-30'] }, 'Production date April (any year)', 'butter'],
    ['butter produced April 2026', { field: 'production_date', op: 'between', values: ['2026-04-01', '2026-04-30'] }, 'Production date April 2026', 'butter'],
    ['butter made in april', { field: 'production_date', op: 'between', values: ['--04-01', '--04-30'] }, 'Production date April (any year)', 'butter'],
    ['cream best by early may', { field: 'best_by_date', op: 'between', values: ['--05-01', '--05-10'] }, 'Best-by / expiration date May 1–10 (any year)', 'cream'],
    ['produced apr 1-15', { field: 'production_date', op: 'between', values: ['--04-01', '--04-15'] }, 'Production date Apr 1–15 (any year)', ''],
    ['produced between Apr 1 and Apr 15, 2026', { field: 'production_date', op: 'between', values: ['2026-04-01', '2026-04-15'] }, 'Production date Apr 1–15, 2026', ''],
    ['produced April 1 to April 15', { field: 'production_date', op: 'between', values: ['--04-01', '--04-15'] }, 'Production date Apr 1–15 (any year)', ''],
    ['produced Dec 15 to Jan 15', { field: 'production_date', op: 'between', values: ['--12-15', '--01-15'] }, 'Production date Dec 15 – Jan 15 (any year)', ''],
    ['produced 4/2026', { field: 'production_date', op: 'between', values: ['2026-04-01', '2026-04-30'] }, 'Production date April 2026', ''],
    ['produced mid-April 2026', { field: 'production_date', op: 'between', values: ['2026-04-11', '2026-04-20'] }, 'Production date Apr 11–20, 2026', ''],
    ['produced late February', { field: 'production_date', op: 'between', values: ['--02-21', '--02-29'] }, 'Production date Feb 21–29 (any year)', ''],
    ['produced since March', { field: 'production_date', op: 'after', values: ['2026-02-28'] }, 'Production date since Mar 1, 2026', ''],
    ['produced before May', { field: 'production_date', op: 'before', values: ['2026-05-01'] }, 'Production date before May 1, 2026', ''],
    ['produced last month', { field: 'production_date', op: 'between', values: ['2026-08-01', '2026-08-31'] }, 'Production date August 2026', ''],
    ['code date in may', { field: 'code_date', op: 'between', values: ['--05-01', '--05-31'] }, 'Code date May (any year)', ''],
    ['expires in june', { field: 'best_by_date', op: 'between', values: ['--06-01', '--06-30'] }, 'Best-by / expiration date June (any year)', ''],
    ['butter in april', { field: 'date', op: 'between', values: ['--04-01', '--04-30'], role: 'any' }, 'Date April (any year)', 'butter'],
  ];
  for (const [text, clause, words, residual] of table) {
    it(`"${text}"`, () => {
      const d = read(text);
      expect(d.clauses).toHaveLength(1);
      expect(d.clauses[0]).toMatchObject({ ...clause, source: 'detected' });
      expect(describeClause(d.clauses[0])).toBe(words);
      expect(d.residual).toBe(residual);
      expect(validateClause(d.clauses[0])).toBeNull();
    });
  }

  it('the day readings are unchanged', () => {
    expect(one('butter produced april 14')).toMatchObject({ field: 'production_date', op: 'on', values: ['--04-14'] });
    expect(one('butter produced 4/14')).toMatchObject({ field: 'production_date', op: 'on', values: ['--04-14'] });
    expect(one('produced 31 Jul 2026')).toMatchObject({ op: 'on', values: ['2026-07-31'] });
    expect(one('produced 7/31/2026')).toMatchObject({ op: 'on', values: ['2026-07-31'] });
  });

  it('the chip says it in words', () => {
    expect(chipSentence(chipParts(one('butter produced in april')))).toBe('production date · April · any year');
    expect(chipSentence(chipParts(one('produced between Apr 1 and Apr 15, 2026')))).toBe('production date · Apr 1–15, 2026');
    expect(chipSentence(chipParts(one('produced since March')))).toBe('production date · since Mar 1, 2026');
  });
});

describe('consumed words never stay as text', () => {
  it('"produced" and "in" are part of the clause', () => {
    const d = read('butter produced in april');
    expect(d.clauses[0].raw).toBe('produced in april');
    expect(d.residual).toBe('butter');
  });

  it('left-over filler words are not required terms', () => {
    expect(residualText('any butter that is good', [])).toBe('butter is good');
    expect(read('the butter produced in april for that order').residual).toBe('butter order');
  });
});

describe('"may" as a verb is not a month', () => {
  it('what may cover lot 104', () => {
    const d = read('what may cover lot 104');
    expect(d.clauses.map((c) => c.field)).toEqual(['lot']);
    expect(d.residual).toBe('what may cover');
  });

  it('I may need butter; butter april (no role, no preposition) stays words', () => {
    expect(read('I may need butter').clauses).toEqual([]);
    expect(read('butter april').clauses).toEqual([]);
  });

  it('but "produced may", "in may", "may 2026" and "late may" are May', () => {
    expect(one('produced may').values).toEqual(['--05-01', '--05-31']);
    expect(one('cream in may').values).toEqual(['--05-01', '--05-31']);
    expect(one('cream may 2026').values).toEqual(['2026-05-01', '2026-05-31']);
    expect(one('cream best by late may').values).toEqual(['--05-21', '--05-31']);
  });
});

describe('the any-year span is judged correctly', () => {
  const april = constraintOf(one('butter produced in april'));
  const winter = constraintOf(one('produced Dec 15 to Jan 15'));
  const on = (iso: string) => subject({ metadata: { production_date: iso } });

  it('matches April of any year, and nothing outside it is "nearby"', () => {
    expect(april.month_day_range).toEqual({ from: { month: 4, day: 1 }, to: { month: 4, day: 30 } });
    expect(checkDate(april, on('2026-04-17'), null).outcome).toBe('match');
    expect(checkDate(april, on('2023-04-30'), null).outcome).toBe('match');
    expect(checkDate(april, on('2026-05-01'), null).outcome).toBe('mismatch');
    expect(checkDate(april, on('2026-03-31'), null).outcome).toBe('mismatch');
  });

  it('a span across the year end wraps (Dec 15 – Jan 15, any year)', () => {
    expect(winter.month_day_range).toEqual({ from: { month: 12, day: 15 }, to: { month: 1, day: 15 } });
    expect(checkDate(winter, on('2025-12-20'), null).outcome).toBe('match');
    expect(checkDate(winter, on('2026-01-10'), null).outcome).toBe('match');
    expect(checkDate(winter, on('2026-01-16'), null).outcome).toBe('mismatch');
    expect(checkDate(winter, on('2026-12-14'), null).outcome).toBe('mismatch');
    expect(inMonthDayRange('12-31', { month: 12, day: 15 }, { month: 1, day: 15 })).toBe(true);
    expect(inMonthDayRange('06-01', { month: 12, day: 15 }, { month: 1, day: 15 })).toBe(false);
  });

  it('a production date read from a legacy code date stays likely', () => {
    const s = subject({
      row_scoped: true,
      lots: [{ lot_number: '1', sub_lot_code: '', lot_key: '1', provenance: 'extracted', production_date: '2026-04-17', production_date_source: 'extracted_code_date_legacy', production_date_status: 'resolved' }],
    });
    expect(checkDate(april, s, null).outcome).toBe('likely');
  });

  it('a code date in April is not a production date in April', () => {
    expect(checkDate(april, subject({ metadata: { code_date: '2026-04-17' } }), null).outcome).toBe('role_mismatch');
  });

  it('the clause survives validation both ways, and a date-less wrap is refused only where it is not yearless', () => {
    expect(validateClause({ id: 'x', field: 'production_date', op: 'between', values: ['--12-15', '--01-15'], source: 'builder' })).toBeNull();
    expect(validateClause({ id: 'x', field: 'production_date', op: 'between', values: ['2026-12-15', '2026-01-15'], source: 'builder' })).toMatch(/after the second/);
    expect(validateClause({ id: 'x', field: 'uploaded', op: 'between', values: ['--04-01', '--04-30'], source: 'builder' })).toMatch(/YYYY-MM-DD/);
    expect(validateClause({ id: 'x', field: 'production_date', op: 'between', values: ['--02-30', '--03-01'], source: 'builder' })).toMatch(/YYYY-MM-DD/);
  });
});

describe('the period reader on its own', () => {
  it('reads "last month" across a January', () => {
    const [h] = findQueryPeriods('last month', { now: new Date('2027-01-05T00:00:00Z') });
    expect(h.date).toMatchObject({ kind: 'range', from: '2026-12-01', to: '2026-12-31' });
  });

  it('a year-less "since" is the most recent such month, never a future one', () => {
    const [h] = findQueryPeriods('since November', { now: NOW });
    expect(h.date).toMatchObject({ kind: 'range', from: '2025-11-01', to: null });
    expect(h.date.note).toMatch(/November 2025, the most recent one/);
  });

  it('a range whose single year is on its end borrows it for the start', () => {
    const [h] = findQueryPeriods('produced Dec 15 to Jan 15, 2027', { now: NOW, roleBefore: () => true });
    expect(h.date).toMatchObject({ kind: 'range', from: '2026-12-15', to: '2027-01-15' });
  });

  it('the NL override keeps the typed any-year month', () => {
    expect(parseQueryText('produced in april', { now: NOW }).dates[0]).toMatchObject({ role: 'production', date: { kind: 'month_range' } });
  });
});

describe('product words next to a date (server half, pure)', () => {
  const catalog = prepareCatalog([
    { product_id: 'P-BUTTER', product_name: 'Bulk Unsalted Butter', identifiers: [{ id: 'i1', kind: 'our_sku', value: '2235', supplier_id: null, supplier_name: null, superseded: false, confirmed: true, note: null }] },
    { product_id: 'P-CREAM', product_name: 'Heavy Cream 40%', identifiers: [{ id: 'i2', kind: 'our_sku', value: '10286', supplier_id: null, supplier_name: null, superseded: false, confirmed: true, note: null }] },
    { product_id: 'P-CREAM2', product_name: 'Light Cream', identifiers: [{ id: 'i3', kind: 'our_sku', value: '0801', supplier_id: null, supplier_name: null, superseded: false, confirmed: true, note: null }] },
  ])!;

  it('"butter" beside a date becomes a product chip; nothing is left as text', () => {
    const det = read('butter produced in april');
    const r = detectProduct(det, catalog, { otherConstraints: det.clauses.length > 0 });
    expect(r.detection.clauses.map((c) => c.field)).toEqual(['production_date', 'product']);
    expect(r.detection.clauses[1]).toMatchObject({ op: 'in', values: ['P-BUTTER'], raw: 'butter', source: 'detected' });
    expect(r.detection.residual).toBe('');
    expect(r.labels['P-BUTTER']).toBe('Bulk Unsalted Butter');
  });

  it('a phrase fitting several products lists them all and picks nothing', () => {
    const det = read('cream best by early may');
    const r = detectProduct(det, catalog, { otherConstraints: true });
    expect(r.detection.clauses[1]).toMatchObject({ field: 'product', ambiguous: true });
    expect([...r.detection.clauses[1].values].sort()).toEqual(['P-CREAM', 'P-CREAM2']);
    expect(r.detection.clauses[1].note).toMatch(/could mean 2 products/);
  });

  it('alone, or when the words fit nothing, it stays text', () => {
    const alone = read('butter');
    expect(detectProduct(alone, catalog, { otherConstraints: false }).detection).toEqual(alone);
    const det = read('yogurt produced in april');
    expect(detectProduct(det, catalog, { otherConstraints: true }).detection.residual).toBe('yogurt');
  });
});
