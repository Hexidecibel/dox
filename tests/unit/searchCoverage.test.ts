/**
 * Coverage-aware search — the pure judge (shared/searchCoverage.ts) and the
 * date reader under it (shared/searchDates.ts).
 *
 * The rule under test is AJ Conner's D6: "a confident wrong answer is worse
 * than a null". Every assertion here is a way the portal could otherwise hand
 * back a near miss as a match.
 */

import { describe, it, expect } from 'vitest';
import {
  findQueryDates,
  inferDocumentDateOrder,
  readStoredDates,
} from '../../shared/searchDates';
import {
  checkDate,
  checkLot,
  constraintsFromParsedQuery,
  coverageFor,
  coverageSummary,
  evaluateSubject,
  makeDateConstraint,
  makeLotConstraint,
  parseQueryText,
  residualText,
  type CoverageSubject,
} from '../../shared/searchCoverage';
import { buildMatchExpr, queryTokenVariants } from '../../functions/lib/search-fts';

function subject(over: Partial<CoverageSubject> = {}): CoverageSubject {
  return {
    id: 'd1',
    supplier_name: null,
    supplier_aliases: [],
    document_type_slug: null,
    document_type_name: null,
    product_names: [],
    metadata: {},
    lots: [],
    created_at: '2026-08-01T00:00:00Z',
    renewal_due_date: null,
    text_match: null,
    ...over,
  };
}

function dayOf(q: string) {
  const hits = findQueryDates(q);
  expect(hits).toHaveLength(1);
  const d = hits[0].date;
  return d.kind === 'day' ? d.iso : `${d.month}/${d.day}`;
}

describe('query dates', () => {
  it.each([
    ['7/31/2026', '2026-07-31'],
    ['7/31/26', '2026-07-31'],
    ['2026-07-31', '2026-07-31'],
    ['31-Jul-2026', '2026-07-31'],
    ['Jul 31 2026', '2026-07-31'],
    ['July 31, 2026', '2026-07-31'],
    ['31JUL2026', '2026-07-31'],
  ])('reads %s as %s', (raw, iso) => {
    expect(dayOf(raw)).toBe(iso);
  });

  it('reads an ambiguous typed date as month/day and says so', () => {
    const [h] = findQueryDates('9/2/2026');
    expect(h.date.kind).toBe('day');
    expect(h.date.kind === 'day' && h.date.iso).toBe('2026-09-02');
    expect(h.date.note).toMatch(/month\/day/);
  });

  it('only admits a year-less date when the phrase gives it a role', () => {
    expect(parseQueryText('5/8 inch tube').dates).toHaveLength(0);
    const p = parseQueryText('300 gal tote produced 9/2');
    expect(p.dates).toHaveLength(1);
    expect(p.dates[0].role).toBe('production');
    expect(p.dates[0].date.kind).toBe('month_day');
  });
});

describe('stored dates', () => {
  it('refuses to pick a reading for 02/07/2026', () => {
    const [r] = readStoredDates('02/07/2026');
    expect(r.kind).toBe('ambiguous');
  });

  it('reads the unambiguous prod shapes', () => {
    expect(readStoredDates('2/20/2026')[0]).toMatchObject({ kind: 'exact', iso: '2026-02-20' });
    expect(readStoredDates('18-03-2026')[0]).toMatchObject({ kind: 'exact', iso: '2026-03-18' });
    expect(readStoredDates('2026-25-04')[0]).toMatchObject({ kind: 'exact', iso: '2026-04-25' });
    expect(readStoredDates('16MAR2026')[0]).toMatchObject({ kind: 'exact', iso: '2026-03-16' });
    expect(readStoredDates('EXP 07/24/26LO')[0]).toMatchObject({ kind: 'exact', iso: '2026-07-24' });
  });

  it('04-05-2026 is ambiguous; a document that writes 03/17/26 elsewhere settles it', () => {
    expect(readStoredDates('04-05-2026')[0].kind).toBe('ambiguous');
    expect(inferDocumentDateOrder(['03/17/26', '04/05/26'])).toBe('mdy');
    expect(readStoredDates('04/05/26', 'mdy')[0]).toMatchObject({ kind: 'exact', iso: '2026-04-05' });
    expect(inferDocumentDateOrder(['18-03-2026'])).toBe('dmy');
  });

  it('finds every date in a collapsed multi-value field', () => {
    expect(readStoredDates('2026-03-17, 2026-02-20, 2026-02-20')).toHaveLength(3);
  });
});

describe('lot checks', () => {
  const doc = subject({ lots: [{ lot_number: '10426203', sub_lot_code: '03', lot_key: '1042620303', provenance: 'linked_record' }] });

  it('A1/A2: composite and hyphenated forms verify', () => {
    for (const raw of ['1042620303', '10426203-03']) {
      const t = parseQueryText(raw).lotTokens[0];
      expect(checkLot(makeLotConstraint('c1', t, 'query_text'), doc).outcome).toBe('match');
    }
  });

  it('A3: base and sublot typed apart compose', () => {
    const t = parseQueryText('lot 10426203 sublot 03').lotTokens[0];
    expect(t.norm).toBe('1042620303');
    expect(checkLot(makeLotConstraint('c1', t, 'query_text'), doc).outcome).toBe('match');
  });

  it('a prefix is a partial lot match, never a match', () => {
    const c = makeLotConstraint('c1', { raw: '1042620', norm: '1042620' }, 'query_text');
    const ch = checkLot(c, doc);
    expect(ch.outcome).toBe('partial_lot');
    expect(ch.message).toMatch(/Partial lot match/);
  });

  it('a sibling sublot is near, not a match', () => {
    const c = makeLotConstraint('c1', { raw: '1042620304', norm: '1042620304' }, 'query_text');
    expect(checkLot(c, doc).outcome).toBe('near');
  });

  it('reads a sublot recorded only in extracted metadata (prod Darigold rows)', () => {
    const d = subject({
      lots: [{ lot_number: '10426060', sub_lot_code: '', lot_key: '10426060', provenance: 'linked_record' }],
      metadata: { lot_number: '10426060', sub_lot_number: '07' },
    });
    const c = makeLotConstraint('c1', { raw: '1042606007', norm: '1042606007' }, 'query_text');
    expect(checkLot(c, d).outcome).toBe('match');
    const other = makeLotConstraint('c1', { raw: '1042606004', norm: '1042606004' }, 'query_text');
    expect(checkLot(other, d).outcome).toBe('near');
  });
});

describe('date checks', () => {
  const prod = (raw: string) => {
    const p = parseQueryText(raw).dates[0];
    return makeDateConstraint('c1', p.role, p.date, 'query_text');
  };

  it('A11: a code date is never a production date', () => {
    const westPoint = subject({ metadata: { code_date: '2026-07-31' } });
    const ch = checkDate(prod('production date 7/31/2026'), westPoint, null);
    expect(ch.outcome).toBe('role_mismatch');
    expect(ch.message).toMatch(/code date/);
    expect(evaluateSubject(westPoint, [prod('production date 7/31/2026')], []).status).toBe('candidate_not_matching');
  });

  it('a production date nine days off is near, with both dates in the reason', () => {
    const d = subject({ metadata: { production_date: '2026-07-22' } });
    const ch = checkDate(prod('production date 7/31/2026'), d, null);
    expect(ch.outcome).toBe('near');
    expect(ch.message).toContain('Jul 22, 2026');
    expect(ch.message).toContain('Jul 31, 2026');
  });

  it('an ambiguous stored date that could be the asked day is not verified', () => {
    const d = subject({ metadata: { production_date: '02/07/2026' } });
    const ch = checkDate(prod('production date 2/7/2026'), d, null);
    expect(ch.outcome).toBe('ambiguous');
    expect(ch.message).toMatch(/can't be verified/);
  });

  it('a date with no role matches any document date and names which', () => {
    const d = subject({ metadata: { code_date: '2026-07-31' } });
    const c = prod('2026-07-31');
    expect(c.role).toBe('any');
    const ch = checkDate(c, d, null);
    expect(ch.outcome).toBe('match');
    expect(ch.field).toBe('code_date');
  });

  it('several dates in one field, one matching, asks for confirmation', () => {
    const d = subject({ metadata: { production_date: '2026-07-22, 2026-07-23' } });
    expect(checkDate(prod('production date 22-Jul-2026'), d, null).outcome).toBe('multiple_values');
  });
});

describe('coverage verdict', () => {
  it('unconstrained / none / covered, and a dropped constraint forbids covered', () => {
    expect(coverageFor([], [], 0)).toBe('unconstrained');
    const c = makeLotConstraint('c1', { raw: '1', norm: '1' }, 'query_text');
    expect(coverageFor([c], [], 0)).toBe('none');
    expect(coverageFor([c], [], 2)).toBe('covered');
    expect(coverageFor([c], [{ kind: 'metadata', label: 'x', raw: 'x', reason: 'y' }], 2)).toBe('none');
  });

  it('writes the summary from the reader side', () => {
    const p = parseQueryText('production date 7/31/2026').dates[0];
    const c = makeDateConstraint('c1', p.role, p.date, 'query_text');
    expect(coverageSummary([c], [], 0)).toBe('No document on file covers production date Jul 31, 2026.');
  });

  it('residual text drops the constraint phrase and stop words', () => {
    const q = '300 gal tote produced 9/2';
    const p = parseQueryText(q).dates[0];
    expect(residualText(q, [[p.start, p.end], p.roleSpan!])).toBe('300 gal tote');
  });
});

describe('natural-language parse → constraints', () => {
  const ctx = { documentTypes: [{ slug: 'coa', name: 'COA' }], today: '2026-09-14' };
  const base = {
    document_type_slug: null, product_names: [], supplier_name: null, date_from: null, date_to: null,
    metadata_filters: [], expiration_filter: null,
  };

  it('production date + supplier from the model are constraints', () => {
    const { constraints, dropped } = constraintsFromParsedQuery({
      ...base, supplier_name: 'Darigold', metadata_filters: [{ field: 'production_date', operator: 'equals', value: '2026-07-22' }],
    }, 'Darigold bulk unsalted butter produced 7/22/26', ctx);
    expect(dropped).toEqual([]);
    expect(constraints.find((c) => c.kind === 'supplier')?.value).toBe('Darigold');
    const d = constraints.find((c) => c.kind === 'date')!;
    expect(d.role).toBe('production');
    expect(d.date_from).toBe('2026-07-22');
    expect(constraints.filter((c) => c.kind === 'date')).toHaveLength(1);
  });

  it('the typed words win when the model files a production date as a code date', () => {
    const { constraints } = constraintsFromParsedQuery({
      ...base, metadata_filters: [{ field: 'code_date', operator: 'equals', value: '2026-07-22' }],
    }, 'butter produced 7/22/26', ctx);
    const dates = constraints.filter((c) => c.kind === 'date');
    expect(dates).toHaveLength(1);
    expect(dates[0].role).toBe('production');
    expect(dates[0].note).toMatch(/AI read this as/);
  });

  it('the model omitting the date entirely does not lose it', () => {
    const { constraints } = constraintsFromParsedQuery({ ...base, supplier_name: 'Darigold' }, 'darigold butter produced 7/22/26', ctx);
    expect(constraints.find((c) => c.kind === 'date')?.date_from).toBe('2026-07-22');
  });

  it('an upload-date range without a role keeps its old meaning; with a role it is a document date', () => {
    const a = constraintsFromParsedQuery({ ...base, date_from: '2026-03-01', date_to: '2026-03-31' }, 'docs from march', ctx);
    expect(a.constraints[0].role).toBe('uploaded');
    const b = constraintsFromParsedQuery({ ...base, date_from: '2026-03-01', date_to: '2026-03-31', date_role: 'production' }, 'made in march', ctx);
    expect(b.constraints[0].role).toBe('production');
  });

  it('what cannot be applied is dropped out loud', () => {
    const { dropped } = constraintsFromParsedQuery({
      ...base,
      document_type_slug: 'no-such-type',
      metadata_filters: [{ field: 'net_weight', operator: 'gt', value: '500' }],
    }, 'x', ctx);
    expect(dropped.map((d) => d.kind).sort()).toEqual(['document_type', 'metadata']);
  });
});

describe('forgiving FTS terms', () => {
  it('folds plurals and unit spellings', () => {
    expect(queryTokenVariants('bags')).toEqual(expect.arrayContaining(['bags', 'bag']));
    expect(queryTokenVariants('gal')).toEqual(expect.arrayContaining(['gallon', 'gallons']));
    expect(queryTokenVariants('lbs')).toEqual(expect.arrayContaining(['lb', 'pounds']));
    expect(queryTokenVariants('10426203-03')).toEqual(['10426203-03']);
  });

  it('keeps a single-word search byte-identical', () => {
    expect(buildMatchExpr('darigold')).toBe('"darigold"*');
    expect(buildMatchExpr('LOT-SRCH-002')).toBe('"lot-srch-002"*');
  });

  it('ORs spellings for the words that need it', () => {
    expect(buildMatchExpr('300 gal tote')).toBe('"300" AND ("gal" OR "gals" OR "gallon" OR "gallons") AND "tote"*');
  });
});
