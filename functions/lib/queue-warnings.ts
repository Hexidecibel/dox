/**
 * Review-time invariant warnings for processing_queue rows.
 *
 * WHY: the 2026-08-01 corpus study found that **37% of all extraction error in
 * the corpus sits inside documents a human APPROVED** — more than in the
 * rejected set (24%) — and a hand-check of 12 approved documents found 5 (42%)
 * carrying a material defect. Two of those were COAs approved with 3M lab
 * REAGENT lot numbers in `plant_number`. The product is deliberately
 * no-auto-ingest and the plan is for a non-technical partner to one-click
 * approve, so a leaking review gate undermines the entire design.
 *
 * `shared/extractionInvariants.ts` already detects a machine-checkable slice of
 * this from the document's own text — no model, no answer key. It was only ever
 * run as a corpus-scale report AFTER the fact. This module runs the SAME code
 * per queue item so the warning lands on the specific field at the moment a
 * reviewer is looking at it.
 *
 * WARN, NEVER BLOCK. Nothing here can refuse an approval. The checks have known
 * false positives, and a reviewer who cannot overrule the tool learns to fight
 * it instead of reading it.
 */

import { checkExtraction } from '../../shared/extractionInvariants';
import type { InvariantFailure } from '../../shared/extractionInvariants';

/**
 * Above this, skip the text-grounded checks rather than burn worker CPU on a
 * pathological row. A missing warning is a survivable outcome; a queue that
 * times out is not.
 */
const MAX_TEXT_CHARS = 400_000;

export interface WarnableRow {
  ai_fields?: unknown;
  ai_records?: unknown;
  extracted_text?: unknown;
  /** Tenant name, when the caller's query joined it. Powers supplier_not_self. */
  tenant_name?: unknown;
  /** Callers pass whole `SELECT pq.*` rows; everything else is carried through. */
  [key: string]: unknown;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : v == null ? null : String(v);
}

/**
 * Compute the per-field warnings for one queue row. Never throws — a checker
 * bug must not take down the review queue, so a failure degrades to "no
 * warnings" and logs.
 */
export function invariantWarningsFor(row: WarnableRow): InvariantFailure[] {
  try {
    const text = str(row.extracted_text);
    return checkExtraction(
      {
        ai_fields: str(row.ai_fields),
        ai_records: str(row.ai_records),
        extracted_text: text && text.length > MAX_TEXT_CHARS ? null : text,
      },
      { selfNames: [str(row.tenant_name)] }
    ).failures;
  } catch (err) {
    console.error(
      '[queue-warnings] invariant check failed:',
      err instanceof Error ? err.message : String(err)
    );
    return [];
  }
}

/**
 * Attach `invariant_warnings` to a queue row for the API response. Returns a new
 * object; the input is not mutated.
 */
export function withInvariantWarnings<T extends WarnableRow>(
  row: T
): T & { invariant_warnings: InvariantFailure[] } {
  return { ...row, invariant_warnings: invariantWarningsFor(row) };
}
