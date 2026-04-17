/**
 * Pure aggregation helpers for the A/B extraction evaluation report.
 *
 * Kept deliberately side-effect-free so the aggregator can be unit-tested
 * without a database. The API layer fetches the raw evaluation rows (joined
 * with queue-item metadata) then passes them through here to produce the
 * totals / by-supplier / by-doctype / comments shape that the frontend
 * expects.
 */

import type {
  EvalReportResponse,
  EvalReportTotals,
  EvalReportBreakdownRow,
  EvalReportCommentRow,
  EvalReportEvaluationRow,
  ExtractionEvalSide,
  ExtractionEvalWinner,
} from '../../shared/types';

export interface RawEvaluationRow {
  queue_item_id: string;
  file_name: string;
  supplier: string | null;
  document_type_name: string | null;
  winner: ExtractionEvalWinner;
  a_side: ExtractionEvalSide;
  comment: string | null;
  evaluated_at: number;
  evaluator_name: string | null;
}

/**
 * Unblind a single evaluation: given which real side was labeled A and the
 * reviewer's pick, return whether text or vlm actually won (null for a tie).
 */
export function resolveWinningSide(
  winner: ExtractionEvalWinner,
  aSide: ExtractionEvalSide
): ExtractionEvalSide | null {
  if (winner === 'tie') return null;
  const bSide: ExtractionEvalSide = aSide === 'text' ? 'vlm' : 'text';
  return winner === 'a' ? aSide : bSide;
}

function emptyBreakdown(key: string): EvalReportBreakdownRow {
  return { key, text_wins: 0, vlm_wins: 0, ties: 0 };
}

function incrementBreakdown(
  row: EvalReportBreakdownRow,
  winningSide: ExtractionEvalSide | null
): void {
  if (winningSide === 'text') row.text_wins += 1;
  else if (winningSide === 'vlm') row.vlm_wins += 1;
  else row.ties += 1;
}

/**
 * Aggregate a batch of raw evaluation rows into the shape the report page
 * renders. `remaining` and `total` come from the caller because they depend
 * on a fresh count against the queue (evaluations may be in flight).
 */
export function aggregateEvaluations(
  rows: RawEvaluationRow[],
  counts: { remaining: number; total: number }
): EvalReportResponse {
  const totals: EvalReportTotals = {
    evaluated: rows.length,
    text_wins: 0,
    vlm_wins: 0,
    ties: 0,
    remaining: counts.remaining,
    total: counts.total,
  };

  const supplierMap = new Map<string, EvalReportBreakdownRow>();
  const doctypeMap = new Map<string, EvalReportBreakdownRow>();
  const comments: EvalReportCommentRow[] = [];
  const evaluations: EvalReportEvaluationRow[] = [];

  for (const r of rows) {
    const winningSide = resolveWinningSide(r.winner, r.a_side);
    if (winningSide === 'text') totals.text_wins += 1;
    else if (winningSide === 'vlm') totals.vlm_wins += 1;
    else totals.ties += 1;

    const supplierKey = r.supplier ?? '';
    if (!supplierMap.has(supplierKey)) supplierMap.set(supplierKey, emptyBreakdown(supplierKey));
    incrementBreakdown(supplierMap.get(supplierKey)!, winningSide);

    const doctypeKey = r.document_type_name ?? '';
    if (!doctypeMap.has(doctypeKey)) doctypeMap.set(doctypeKey, emptyBreakdown(doctypeKey));
    incrementBreakdown(doctypeMap.get(doctypeKey)!, winningSide);

    if (r.comment && r.comment.trim() !== '') {
      comments.push({
        queue_item_id: r.queue_item_id,
        file_name: r.file_name,
        winner: r.winner,
        winning_side: winningSide,
        comment: r.comment,
        evaluated_at: r.evaluated_at,
        evaluator_name: r.evaluator_name,
      });
    }

    evaluations.push({
      queue_item_id: r.queue_item_id,
      file_name: r.file_name,
      supplier: r.supplier,
      document_type_name: r.document_type_name,
      winner: r.winner,
      a_side: r.a_side,
      winning_side: winningSide,
      comment: r.comment,
      evaluated_at: r.evaluated_at,
      evaluator_name: r.evaluator_name,
    });
  }

  // Stable, readable ordering: total volume desc, then key asc.
  const byVolumeThenKey = (a: EvalReportBreakdownRow, b: EvalReportBreakdownRow): number => {
    const aTotal = a.text_wins + a.vlm_wins + a.ties;
    const bTotal = b.text_wins + b.vlm_wins + b.ties;
    if (bTotal !== aTotal) return bTotal - aTotal;
    return a.key.localeCompare(b.key);
  };
  const by_supplier = Array.from(supplierMap.values()).sort(byVolumeThenKey);
  const by_doctype = Array.from(doctypeMap.values()).sort(byVolumeThenKey);

  // Comments newest-first — most recent feedback is likely most relevant.
  comments.sort((a, b) => b.evaluated_at - a.evaluated_at);
  evaluations.sort((a, b) => b.evaluated_at - a.evaluated_at);

  return { totals, by_supplier, by_doctype, comments, evaluations };
}
