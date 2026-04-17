/**
 * Unit tests for the pure aggregation helpers that power the A/B evaluation
 * report. No database — we feed raw rows in and inspect the shape that comes
 * out, which is exactly what the API handler will produce.
 */

import { describe, it, expect } from 'vitest';
import {
  aggregateEvaluations,
  resolveWinningSide,
  type RawEvaluationRow,
} from '../../functions/lib/evalAggregate';
import type { ExtractionEvalSide, ExtractionEvalWinner } from '../../shared/types';

function row(
  overrides: Partial<RawEvaluationRow> & { winner: ExtractionEvalWinner; a_side: ExtractionEvalSide }
): RawEvaluationRow {
  return {
    queue_item_id: overrides.queue_item_id ?? `q-${Math.random().toString(36).slice(2, 8)}`,
    file_name: overrides.file_name ?? 'doc.pdf',
    supplier: overrides.supplier ?? null,
    document_type_name: overrides.document_type_name ?? null,
    winner: overrides.winner,
    a_side: overrides.a_side,
    comment: overrides.comment ?? null,
    evaluated_at: overrides.evaluated_at ?? 1_700_000_000_000,
    evaluator_name: overrides.evaluator_name ?? null,
  };
}

describe('resolveWinningSide', () => {
  it('returns the A side when winner is "a" and a_side is text', () => {
    expect(resolveWinningSide('a', 'text')).toBe('text');
  });
  it('returns the A side when winner is "a" and a_side is vlm', () => {
    expect(resolveWinningSide('a', 'vlm')).toBe('vlm');
  });
  it('returns the B side (flipped) when winner is "b" and a_side is text', () => {
    expect(resolveWinningSide('b', 'text')).toBe('vlm');
  });
  it('returns the B side (flipped) when winner is "b" and a_side is vlm', () => {
    expect(resolveWinningSide('b', 'vlm')).toBe('text');
  });
  it('returns null on a tie regardless of a_side', () => {
    expect(resolveWinningSide('tie', 'text')).toBeNull();
    expect(resolveWinningSide('tie', 'vlm')).toBeNull();
  });
});

describe('aggregateEvaluations — totals', () => {
  it('counts text/vlm/ties correctly with mixed a_side labeling', () => {
    const rows: RawEvaluationRow[] = [
      // text wins when "a" won and A was text — 2 occurrences
      row({ winner: 'a', a_side: 'text' }),
      row({ winner: 'a', a_side: 'text' }),
      // text wins when "b" won and A was vlm
      row({ winner: 'b', a_side: 'vlm' }),
      // vlm wins when "a" won and A was vlm
      row({ winner: 'a', a_side: 'vlm' }),
      // vlm wins when "b" won and A was text
      row({ winner: 'b', a_side: 'text' }),
      row({ winner: 'b', a_side: 'text' }),
      // tie
      row({ winner: 'tie', a_side: 'text' }),
    ];
    const report = aggregateEvaluations(rows, { remaining: 3, total: 10 });
    expect(report.totals.evaluated).toBe(7);
    expect(report.totals.text_wins).toBe(3);
    expect(report.totals.vlm_wins).toBe(3);
    expect(report.totals.ties).toBe(1);
    expect(report.totals.remaining).toBe(3);
    expect(report.totals.total).toBe(10);
  });

  it('produces zero-filled totals for an empty input', () => {
    const report = aggregateEvaluations([], { remaining: 0, total: 0 });
    expect(report.totals).toEqual({
      evaluated: 0,
      text_wins: 0,
      vlm_wins: 0,
      ties: 0,
      remaining: 0,
      total: 0,
    });
    expect(report.by_supplier).toEqual([]);
    expect(report.by_doctype).toEqual([]);
    expect(report.comments).toEqual([]);
    expect(report.evaluations).toEqual([]);
  });
});

describe('aggregateEvaluations — breakdowns', () => {
  it('groups by supplier and by doctype independently, tracking winning side post-unblind', () => {
    const rows: RawEvaluationRow[] = [
      // ACME COA: 2 text wins, 1 vlm win, 1 tie
      row({ supplier: 'ACME', document_type_name: 'COA', winner: 'a', a_side: 'text' }),
      row({ supplier: 'ACME', document_type_name: 'COA', winner: 'b', a_side: 'vlm' }),
      row({ supplier: 'ACME', document_type_name: 'COA', winner: 'b', a_side: 'text' }),
      row({ supplier: 'ACME', document_type_name: 'COA', winner: 'tie', a_side: 'text' }),
      // GLOBEX SDS: 1 vlm win
      row({ supplier: 'GLOBEX', document_type_name: 'SDS', winner: 'a', a_side: 'vlm' }),
    ];
    const report = aggregateEvaluations(rows, { remaining: 0, total: 5 });

    // By supplier, sorted volume desc → ACME first
    expect(report.by_supplier).toEqual([
      { key: 'ACME', text_wins: 2, vlm_wins: 1, ties: 1 },
      { key: 'GLOBEX', text_wins: 0, vlm_wins: 1, ties: 0 },
    ]);

    // By doctype
    expect(report.by_doctype).toEqual([
      { key: 'COA', text_wins: 2, vlm_wins: 1, ties: 1 },
      { key: 'SDS', text_wins: 0, vlm_wins: 1, ties: 0 },
    ]);
  });

  it('uses empty-string key for null supplier/doctype (so the report still renders)', () => {
    const rows: RawEvaluationRow[] = [
      row({ winner: 'a', a_side: 'text' }),
      row({ winner: 'tie', a_side: 'vlm' }),
    ];
    const report = aggregateEvaluations(rows, { remaining: 0, total: 2 });
    expect(report.by_supplier).toEqual([
      { key: '', text_wins: 1, vlm_wins: 0, ties: 1 },
    ]);
    expect(report.by_doctype).toEqual([
      { key: '', text_wins: 1, vlm_wins: 0, ties: 1 },
    ]);
  });
});

describe('aggregateEvaluations — comments', () => {
  it('collects only non-empty comments and sorts them newest first', () => {
    const rows: RawEvaluationRow[] = [
      row({ winner: 'a', a_side: 'text', comment: 'old one', evaluated_at: 1000, file_name: 'old.pdf' }),
      row({ winner: 'a', a_side: 'text', comment: '   ', evaluated_at: 2000 }), // whitespace-only → filtered
      row({ winner: 'b', a_side: 'text', comment: 'newer', evaluated_at: 3000, file_name: 'new.pdf' }),
      row({ winner: 'tie', a_side: 'vlm', comment: null, evaluated_at: 4000 }), // null → filtered
    ];
    const report = aggregateEvaluations(rows, { remaining: 0, total: 4 });
    expect(report.comments).toHaveLength(2);
    expect(report.comments[0].comment).toBe('newer');
    expect(report.comments[0].winning_side).toBe('vlm');
    expect(report.comments[0].file_name).toBe('new.pdf');
    expect(report.comments[1].comment).toBe('old one');
    expect(report.comments[1].winning_side).toBe('text');
  });
});

describe('aggregateEvaluations — evaluations list', () => {
  it('carries all raw fields plus winning_side, sorted newest first', () => {
    const rows: RawEvaluationRow[] = [
      row({ winner: 'a', a_side: 'vlm', evaluated_at: 100 }),
      row({ winner: 'b', a_side: 'vlm', evaluated_at: 300 }),
      row({ winner: 'tie', a_side: 'text', evaluated_at: 200 }),
    ];
    const report = aggregateEvaluations(rows, { remaining: 0, total: 3 });
    expect(report.evaluations.map((e) => e.evaluated_at)).toEqual([300, 200, 100]);
    expect(report.evaluations[0].winning_side).toBe('text'); // a_side=vlm, winner=b → text wins
    expect(report.evaluations[1].winning_side).toBeNull(); // tie
    expect(report.evaluations[2].winning_side).toBe('vlm'); // a_side=vlm, winner=a → vlm wins
  });
});
