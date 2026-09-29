/**
 * Search Phase 2 — the omnibox's pure half.
 *
 *   - Enter keeps what was read: detected clauses as chips, the leftover words
 *     as a `mentions` chip, and the box empties.
 *   - Rejecting a reading turns it back into the person's own words (source
 *     'typed'), with a note saying what it was not read as.
 *   - An AI reading replaces earlier readings and keeps deliberate picks, and
 *     every clause it adds says it is the AI's.
 *   - The AI adapter maps the parser's constraints onto clauses without
 *     widening anything: an ambiguous product lists every candidate, an unknown
 *     supplier stays words.
 *   - The browser's optimistic reading never guesses what only tenant data can
 *     say (a bare number).
 *   - `raw` and `ambiguous` survive the URL.
 */

import { describe, it, expect } from 'vitest';
import {
  clauseAsText,
  commitInterpretation,
  decodeClause,
  encodeClause,
  questionText,
  replaceClause,
  withAiReading,
  type Clause,
  type SearchQuery,
} from '../../shared/searchQuery';
import { detectOptimistic } from '../../shared/searchInterpret';
import { constraintsToAiClauses } from '../../functions/lib/search/naturalClauses';
import type { SearchConstraint } from '../../shared/types';

const empty: SearchQuery = { v: 1, text: '', clauses: [], view: { entity: 'documents' } };

describe('commitInterpretation (Enter)', () => {
  it('keeps each detection as a chip, the rest as a mentions chip, and empties the box', () => {
    const q = { ...empty, text: 'butter produced Sep 2', clauses: [{ id: 'c1', field: 'supplier', op: 'in', values: ['S1'], source: 'facet' } as Clause] };
    const det = detectOptimistic(q.text);
    const { query, ids } = commitInterpretation(q, det.clauses, det.residual);
    expect(query.text).toBe('');
    expect(query.clauses.map((c) => [c.id, c.field, c.source])).toEqual([
      ['c1', 'supplier', 'facet'],
      ['c2', 'production_date', 'detected'],
      ['c3', 'text', 'typed'],
    ]);
    expect(ids).toEqual(['c2', 'c3']);
    expect(query.clauses[2].values).toEqual(['butter']);
  });

  it('a rejected live chip (its ×) is committed as words instead', () => {
    const det = detectOptimistic('lot 10426203 produced Sep 2');
    const lotIdx = det.clauses.findIndex((c) => c.field === 'lot');
    const { query } = commitInterpretation(empty, det.clauses, det.residual, lotIdx);
    const words = query.clauses.find((c) => c.field === 'text')!;
    expect(words).toMatchObject({ source: 'typed', values: ['lot 10426203'] });
    expect(words.note).toMatch(/not read as lot/);
    expect(query.clauses.some((c) => c.field === 'lot')).toBe(false);
  });
});

describe('clauseAsText (reject a reading)', () => {
  it('turns the clause into the words it was read from, as typed text', () => {
    const q: SearchQuery = { ...empty, clauses: [{ id: 'c1', field: 'po', op: 'is', values: ['K555000'], raw: 'PO K555000', source: 'detected' }] };
    const next = clauseAsText(q, 'c1');
    expect(next.clauses).toEqual([
      expect.objectContaining({ id: 'c1', field: 'text', op: 'contains', values: ['PO K555000'], source: 'typed' }),
    ]);
  });

  it('falls back to the clause in words when nothing was typed', () => {
    const q: SearchQuery = { ...empty, clauses: [{ id: 'c1', field: 'lot', op: 'is', values: ['10426203'], sublot: '03', source: 'ai' }] };
    expect(clauseAsText(q, 'c1').clauses[0].values).toEqual(['Lot 10426203 · sublot 03']);
  });
});

describe('replaceClause (an edit from the chip editor)', () => {
  it('changes the role of a date in place; the others are untouched', () => {
    const q: SearchQuery = {
      ...empty,
      clauses: [
        { id: 'c1', field: 'production_date', op: 'on', values: ['2026-09-02'], source: 'detected' },
        { id: 'c2', field: 'supplier', op: 'in', values: ['S1'], source: 'facet' },
      ],
    };
    const next = replaceClause(q, 'c1', { ...q.clauses[0], field: 'code_date' });
    expect(next.clauses.map((c) => c.field)).toEqual(['code_date', 'supplier']);
  });
});

describe('withAiReading (Ask AI)', () => {
  it('replaces detected, typed and earlier AI chips, keeps deliberate picks, and marks every clause ai', () => {
    const q: SearchQuery = {
      ...empty,
      text: 'still typing',
      clauses: [
        { id: 'c1', field: 'supplier', op: 'in', values: ['S1'], source: 'facet' },
        { id: 'c2', field: 'production_date', op: 'on', values: ['2026-09-02'], source: 'detected' },
        { id: 'c3', field: 'text', op: 'contains', values: ['butter'], source: 'typed' },
        { id: 'c4', field: 'lot', op: 'is', values: ['1'], source: 'ai' },
      ],
    };
    expect(questionText(q)).toBe('still typing butter');
    const next = withAiReading(q, [{ id: 'a1', field: 'product', op: 'in', values: ['P1'], source: 'detected', note: 'why' }]);
    expect(next.text).toBe('');
    expect(next.clauses.map((c) => [c.field, c.source])).toEqual([
      ['supplier', 'facet'],
      ['product', 'ai'],
    ]);
    expect(next.clauses[1].note).toBe('why');
  });
});

describe('the URL keeps raw words and ambiguity', () => {
  it('round-trips raw (with separators in it) and the ambiguous flag', () => {
    const c: Clause = { id: 'c1', field: 'product', op: 'in', values: ['P1', 'P2'], raw: '5 gal: bag; tote,x', ambiguous: true, source: 'ai' };
    const back = decodeClause(encodeClause(c), 'c1');
    expect(back).toMatchObject({ raw: '5 gal: bag; tote,x', ambiguous: true, source: 'ai', values: ['P1', 'P2'] });
  });
});

describe('detectOptimistic (the browser, before the server answers)', () => {
  it('reads what needs no tenant data', () => {
    const r = detectOptimistic('PO K555000 produced Sep 2');
    expect(r.clauses.map((c) => c.field).sort()).toEqual(['po', 'production_date']);
  });

  it('does not guess what a bare short number is', () => {
    const r = detectOptimistic('4500123');
    expect(r.clauses).toEqual([]);
    expect(r.residual).toBe('4500123');
  });
});

describe('constraintsToAiClauses (the natural-language adapter)', () => {
  const ctx = {
    suppliers: [{ id: 'S_DG', name: 'Darigold, Inc.' }, { id: 'S_CMF', name: 'Country Morning Farms' }],
    documentTypes: [{ id: 'T_COA', slug: 'coa', name: 'Certificate of Analysis' }],
  };
  const k = (over: Partial<SearchConstraint>): SearchConstraint => ({ id: 'x', kind: 'text', label: '', raw: '', value: '', fields: [], source: 'ai_parse', ...over });

  it('maps supplier, type, dates and a lot, each marked ai with its note', () => {
    const { clauses, dropped } = constraintsToAiClauses([
      k({ kind: 'supplier', raw: 'Darigold', value: 'Darigold, Inc.' }),
      k({ kind: 'document_type', raw: 'COA', value: 'coa' }),
      k({ kind: 'date', role: 'production', raw: 'early September', date_from: '2026-09-01', date_to: '2026-09-10', note: 'The question says "early September".' }),
      k({ kind: 'date', role: 'uploaded', raw: 'last month', date_from: '2026-08-01', date_to: '2026-08-31' }),
      k({ kind: 'lot', raw: '10426203-03', value: '1042620303', lot_parts: { base: '10426203', sub: '03' } }),
    ], [], ctx);
    expect(dropped).toEqual([]);
    expect(clauses.map((c) => [c.field, c.op, c.values, c.source])).toEqual([
      ['supplier', 'in', ['S_DG'], 'ai'],
      ['document_type', 'in', ['T_COA'], 'ai'],
      ['production_date', 'between', ['2026-09-01', '2026-09-10'], 'ai'],
      ['uploaded', 'between', ['2026-08-01', '2026-08-31'], 'ai'],
      ['lot', 'is', ['10426203'], 'ai'],
    ]);
    expect(clauses[2].note).toMatch(/early September/);
    expect(clauses[4].sublot).toBe('03');
  });

  it('an ambiguous product lists every candidate and picks nothing', () => {
    const { clauses } = constraintsToAiClauses([
      k({
        kind: 'product', raw: '5 gal bag', value: '5 gal bag',
        product_resolution: {
          phrase: '5 gal bag', ambiguous: true, message: '',
          candidates: [
            { product_id: 'P_CREAM', product_name: 'Cream', label: 'Cream', our_skus: [], supplier_items: [], supplier_names: [], pack: null, matched_via: [], confirmed: true, conversion_note: null, explanation: '' },
            { product_id: 'P_HH', product_name: 'H&H', label: 'H&H', our_skus: [], supplier_items: [], supplier_names: [], pack: null, matched_via: [], confirmed: true, conversion_note: null, explanation: '' },
          ],
        },
      }),
    ], [], ctx);
    expect(clauses[0]).toMatchObject({ field: 'product', values: ['P_CREAM', 'P_HH'], ambiguous: true, raw: '5 gal bag', source: 'ai' });
    expect(clauses[0].note).toMatch(/Nothing was picked/);
  });

  it('an unknown supplier stays the person\'s words, and an unknown type is dropped with the reason', () => {
    const { clauses, dropped } = constraintsToAiClauses([
      k({ kind: 'supplier', raw: 'Acme', value: 'Acme' }),
      k({ kind: 'document_type', raw: 'Halal', value: 'halal', label: 'document type halal' }),
    ], [], ctx);
    expect(clauses).toEqual([expect.objectContaining({ field: 'text', values: ['Acme'], source: 'ai' })]);
    expect(clauses[0].note).toMatch(/no supplier by that name/);
    expect(dropped).toEqual([expect.objectContaining({ label: 'document type halal', reason: expect.stringMatching(/no document type/) })]);
  });

  it('a printed PO read by the model becomes a PO clause', () => {
    const { clauses } = constraintsToAiClauses([
      k({ kind: 'metadata', fields: ['po_number'], raw: 'K134273', value: 'K134273', match: 'equals', label: 'PO number K134273' }),
    ], [], ctx);
    expect(clauses[0]).toMatchObject({ field: 'po', values: ['K134273'], source: 'ai' });
  });
});
