/**
 * The one query model (shared/searchQuery.ts): URL codec round trip, legacy
 * URLs and saved searches, the editing helpers facets use, and clause words.
 */

import { describe, it, expect } from 'vitest';
import {
  decodeClause,
  decodeQuery,
  describeClause,
  encodeClause,
  encodeQuery,
  legacyStateToQuery,
  queryKey,
  savedPayloadToQuery,
  selectedValues,
  withFieldValues,
  withoutClause,
  withoutValue,
  type Clause,
  type SearchQuery,
} from '../../shared/searchQuery';
import { UPLOADED_BUCKETS, validateClause } from '../../shared/searchFields';

const Q: SearchQuery = {
  v: 1,
  text: 'butter',
  clauses: [
    { id: 'c1', field: 'supplier', op: 'in', values: ['S1', 'S2'], source: 'facet' },
    { id: 'c2', field: 'production_date', op: 'on', values: ['2026-09-02'], source: 'builder' },
    { id: 'c3', field: 'lot', op: 'is', values: ['10426203'], sublot: '03', source: 'detected' },
    { id: 'c4', field: 'document_type', op: 'in', values: ['T,with,commas', 'back\\slash'], exclude: true, source: 'builder' },
    { id: 'c5', field: 'date', op: 'on', values: ['--09-02'], role: 'ship', source: 'ai' },
    { id: 'c6', field: 'uploaded', op: 'within', values: ['30'], source: 'facet' },
    { id: 'c7', field: 'lot', op: 'starts', values: ['104'], source: 'builder' },
  ],
  view: { entity: 'documents', sort: 'newest', mode: 'advanced', page: 3, columns: ['title', 'lot'] },
};

describe('URL codec', () => {
  it('round-trips a query exactly (ids are positional)', () => {
    const url = encodeQuery(Q);
    expect(decodeQuery(url)).toEqual(Q);
    expect(decodeQuery(url.toString())).toEqual(Q);
    expect(encodeQuery(decodeQuery(url)).toString()).toBe(url.toString());
  });

  it('is compact and readable', () => {
    const url = encodeQuery({ v: 1, text: 'butter', clauses: [Q.clauses[0], Q.clauses[1]], view: { entity: 'documents' } });
    expect(decodeURIComponent(url.toString())).toBe('q=butter&f=supplier.in;src=facet:S1,S2&f=production_date.on:2026-09-02');
  });

  it('drops malformed or unknown clauses instead of trusting a URL', () => {
    expect(decodeClause('nope.in:x', 'c1')).toBeNull();
    expect(decodeClause('supplier.on:x', 'c1')).toBeNull();
    expect(decodeClause('supplier.in:', 'c1')).toBeNull();
    expect(decodeClause('supplier', 'c1')).toBeNull();
    expect(decodeQuery('f=bogus&f=supplier.in:S1').clauses).toEqual([{ id: 'c1', field: 'supplier', op: 'in', values: ['S1'], source: 'builder' }]);
  });

  it('escapes commas and backslashes inside a value', () => {
    const c: Clause = { id: 'c1', field: 'text', op: 'contains', values: ['a,b\\c'], source: 'builder' };
    expect(decodeClause(encodeClause(c), 'c1')).toEqual(c);
  });

  it('queryKey is equality', () => {
    expect(queryKey(Q)).toBe(queryKey(decodeQuery(encodeQuery(Q))));
    expect(queryKey(Q)).not.toBe(queryKey({ ...Q, text: 'cream' }));
  });
});

describe('legacy URLs and saved searches still open the same search', () => {
  it('decodes every old filter — including product, status and the date bucket the old server ignored', () => {
    const q = decodeQuery('q=darigold&supplier=acme,beta&doc_type=coa&product=p1&status=archived&date=last_30d&sort=newest&page=2');
    expect(q.text).toBe('darigold');
    expect(q.clauses.map((c) => [c.field, c.op, c.values])).toEqual([
      ['supplier', 'in', ['acme', 'beta']],
      ['document_type', 'in', ['coa']],
      ['product', 'in', ['p1']],
      ['status', 'in', ['archived']],
      ['uploaded', 'within', ['30']],
    ]);
    expect(q.view).toEqual({ entity: 'documents', sort: 'newest', page: 2 });
  });

  it('maps the old server buckets that the old URL codec dropped (24h, older)', () => {
    expect(decodeQuery('date=last_24h').clauses[0]).toMatchObject({ field: 'uploaded', op: 'within', values: ['1'] });
    expect(decodeQuery('date=older').clauses[0]).toMatchObject({ field: 'uploaded', op: 'older_than', values: ['90'] });
    expect(decodeQuery('date=last_365d').clauses[0]).toMatchObject({ values: ['365'] });
  });

  it('legacy state from a saved search', () => {
    const q = legacyStateToQuery({ q: 'x', supplier: ['s1'], date: 'last_7d' });
    expect(q.clauses).toMatchObject([{ field: 'supplier', values: ['s1'], source: 'saved' }, { field: 'uploaded', op: 'within', values: ['7'] }]);
    expect(savedPayloadToQuery({ q: 'x', doc_type: ['t1'] }).clauses).toMatchObject([{ field: 'document_type', values: ['t1'] }]);
  });

  it('a saved v1 AST loads as itself', () => {
    const saved = savedPayloadToQuery(Q as unknown as Record<string, unknown>);
    expect(saved.text).toBe('butter');
    expect(saved.clauses.map((c) => c.field)).toEqual(Q.clauses.map((c) => c.field));
    expect(saved.clauses.every((c) => c.source === 'saved')).toBe(true);
  });

  it('an unknown status value in an old URL is dropped, not guessed', () => {
    expect(decodeQuery('status=deleted').clauses).toEqual([]);
  });
});

describe('editing helpers (the I1 rule: one facet never touches another)', () => {
  const base: SearchQuery = { v: 1, text: '', clauses: [], view: { entity: 'documents', page: 4 } };

  it('ticking values adds or replaces only that field, and resets the page', () => {
    let q = withFieldValues(base, 'supplier', ['A']);
    q = withFieldValues(q, 'product', ['butter']);
    q = withFieldValues(q, 'document_type', ['coa']);
    q = withFieldValues(q, 'supplier', ['A', 'B']);
    expect(q.clauses.map((c) => [c.field, c.values])).toEqual([['supplier', ['A', 'B']], ['product', ['butter']], ['document_type', ['coa']]]);
    expect(q.view.page).toBeUndefined();
    expect(selectedValues(q, 'supplier')).toEqual(['A', 'B']);
  });

  it('clearing one keeps the rest', () => {
    let q = withFieldValues(base, 'supplier', ['A']);
    q = withFieldValues(q, 'product', ['butter']);
    q = withFieldValues(q, 'supplier', []);
    expect(q.clauses.map((c) => c.field)).toEqual(['product']);
    q = withFieldValues(q, 'document_type', ['coa', 'sds']);
    q = withoutValue(q, q.clauses[1].id, 'coa');
    expect(q.clauses[1].values).toEqual(['sds']);
    q = withoutClause(q, q.clauses[0].id);
    expect(q.clauses.map((c) => c.field)).toEqual(['document_type']);
  });
});

describe('validation and words', () => {
  it('refuses what cannot mean one thing', () => {
    expect(validateClause({ id: 'c', field: 'lot', op: 'is', values: ['1042620303'], exclude: true, source: 'builder' })).toMatch(/cannot be excluded/);
    expect(validateClause({ id: 'c', field: 'po', op: 'is', values: ['A', 'B'], source: 'builder' })).toMatch(/one value per clause/);
    expect(validateClause({ id: 'c', field: 'production_date', op: 'on', values: ['9/2/2026'], source: 'builder' })).toMatch(/not a date/);
    expect(validateClause({ id: 'c', field: 'uploaded', op: 'on', values: ['--09-02'], source: 'builder' })).toMatch(/not a date/);
    expect(validateClause({ id: 'c', field: 'production_date', op: 'on', values: ['--09-02'], source: 'builder' })).toBeNull();
    expect(validateClause({ id: 'c', field: 'status', op: 'in', values: ['deleted'], source: 'builder' })).toMatch(/Status is one of/);
    expect(validateClause({ id: 'c', field: 'uploaded', op: 'between', values: ['2026-09-30', '2026-09-01'], source: 'builder' })).toMatch(/first date is after/);
  });

  it('every uploaded facet bucket is literally the clause it selects', () => {
    for (const b of UPLOADED_BUCKETS) {
      const [op, days] = b.value.split(':');
      expect(validateClause({ id: 'c', field: 'uploaded', op: op as Clause['op'], values: [days], source: 'facet' })).toBeNull();
    }
  });

  it('describes a clause the way its chip reads', () => {
    expect(describeClause(Q.clauses[0], { S1: 'Darigold', S2: 'West Point' })).toBe('Supplier: Darigold or West Point');
    expect(describeClause(Q.clauses[1])).toBe('Production date Sep 2, 2026');
    expect(describeClause(Q.clauses[2])).toBe('Lot 10426203 · sublot 03');
    expect(describeClause(Q.clauses[3])).toBe('Document type: not T,with,commas or back\\slash');
    expect(describeClause(Q.clauses[4])).toBe('Ship date September 2 (any year)');
    expect(describeClause(Q.clauses[5])).toBe('Uploaded: last 30 days');
    expect(describeClause({ id: 'c', field: 'lot', op: 'starts', values: ['104'], source: 'detected', note: '104 = Darigold plant' })).toBe('Lot starts with 104 · 104 = Darigold plant');
    expect(describeClause({ id: 'c', field: 'po', op: 'is', values: ['K134273'], source: 'detected' })).toBe('PO K134273');
  });
});
