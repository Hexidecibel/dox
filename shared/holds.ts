/**
 * HOLDS -- a certificate that must not leave until QA says so (decision C-005;
 * C-071..C-082; migration 0139).
 *
 * A hold is a portal-only status on ONE LOT ROW of a certificate, or on the
 * whole certificate. While it is active the certificate does not leave by any
 * exit (shared/sharingRule.ts `judgeExit`, verdict `held`). A QA releaser or an
 * administrator releases it with a written reason. Nothing is pushed to a
 * warehouse system.
 *
 * THREE WAYS A HOLD IS PLACED
 *
 *   person          somebody pressed "Place hold" and said why.
 *   spec_critical   rules table B1: a result judged OUT OF SPEC against a
 *                   configured limit whose criticality is Critical.
 *   zero_tolerance  rules table E2: a presence / absence test on a
 *                   ZERO-TOLERANCE analyte, run on a smaller sample than the
 *                   limit requires. The result is not judged (it never was);
 *                   the ambiguity is itself the risk, so the lot holds.
 *
 * WHAT DOES NOT PLACE A HOLD, each on purpose:
 *
 *   - `not_checked` on its own. "We could not check" is not "it failed".
 *   - An MPN-against-CFU method mismatch, on ANY analyte. Rule E1: "notify,
 *     always, never held ... no category dependency".
 *   - A sample-size mismatch on an analyte that is NOT zero-tolerance. E2:
 *     "everything else is notify-and-release".
 *   - A bare "Negative" with no stated sample size. The engine reads it as
 *     absent and passes it; decision C-016 makes it a NOTICE once built, never
 *     a hold. Holding it would hold nearly every pathogen-negative certificate
 *     a supplier prints.
 *   - A result judged against the certificate's OWN printed limit. Criticality
 *     is a property of a limit the organization configured; a printed limit
 *     has none.
 *   - The bulk recheck (`judgement_origin = 'bulk_recheck'`). A hold is a
 *     consequence of a person approving a certificate, never of a script
 *     re-reading old ones. bin/propose-spec-holds lists what the stored
 *     approval-time checks would have held, and places them only when told to.
 *
 * A HOLD IS A CONSEQUENCE, NEVER AN INPUT. This file reads verdicts the spec
 * engine has already produced. It changes no verdict, no criticality, no band
 * and no snapshot.
 *
 * PURE. No D1, no clock. The D1 half is functions/lib/holds.ts.
 */

import { HOLDING_SPEC_CRITICALITY, SPEC_CRITICALITY_LABELS } from './specCriticality';

export const HOLD_SOURCES = ['person', 'spec_critical', 'zero_tolerance'] as const;
export type HoldSource = (typeof HOLD_SOURCES)[number];

export function isHoldSource(v: unknown): v is HoldSource {
  return typeof v === 'string' && (HOLD_SOURCES as readonly string[]).includes(v);
}

/** The words a person reads for where a hold came from. */
export const HOLD_SOURCE_LABELS: Record<HoldSource, string> = {
  person: 'Placed by a person',
  spec_critical: 'Critical result out of spec',
  zero_tolerance: 'Zero-tolerance sample too small',
};

/** One sentence under the label. */
export const HOLD_SOURCE_HELP: Record<HoldSource, string> = {
  person: 'Somebody put this certificate on hold and said why.',
  spec_critical:
    'Placed automatically when the certificate was approved: a result was out of spec against a limit marked Critical.',
  zero_tolerance:
    'Placed automatically when the certificate was approved: a presence test on a zero-tolerance analyte was run on a smaller sample than the limit requires.',
};

/** A reason longer than this is a document, not a reason. */
export const HOLD_REASON_MAX = 500;

/** Trim and cap a reason. Returns '' when there is nothing to say. */
export function cleanHoldReason(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().slice(0, HOLD_REASON_MAX) : '';
}

/** "Lot 1042 / 03", or null for a hold on the whole certificate. */
export function holdLotLabel(lot: { lot_number?: string | null; sub_lot_code?: string | null } | null | undefined): string | null {
  const n = (lot?.lot_number ?? '').trim();
  if (!n) return null;
  const sub = (lot?.sub_lot_code ?? '').trim();
  return sub ? `${n} / ${sub}` : n;
}

/**
 * The one sentence every refusal, screen and email uses for a held
 * certificate: "On hold: <reason>", naming the lot when the hold is on one.
 */
export function holdRefusalText(hold: { reason?: string | null; lot_label?: string | null } | null | undefined): string {
  const reason = (hold?.reason ?? '').trim();
  const lot = (hold?.lot_label ?? '').trim();
  const head = lot ? `On hold (lot ${lot})` : 'On hold';
  return reason ? `${head}: ${reason}` : `${head}.`;
}

/**
 * What a file that LEAVES says about a held certificate it left out (the ZIP's
 * manifest.csv, a bundle's NOT-INCLUDED.txt). A hold's reason is an internal
 * note ("Critical result out of spec: ...") and a manifest travels with the
 * archive to whoever it is forwarded to, so the reason stays in the portal:
 * the response, the headers and the audit row carry it, the archive does not.
 */
export const HOLD_OUTWARD_TEXT = 'On hold: this certificate is not sent until QA releases the hold.';

// ---------------------------------------------------------------------------
// Which judged results place a hold
// ---------------------------------------------------------------------------

/** Where a set of verdicts came from. Only an approval places a hold. */
export type HoldJudgementOrigin = 'approval' | 'bulk_recheck';

/**
 * One judged result, reduced to what the hold rule reads. Built from a live
 * `SpecVerdict` at approval (`holdResultFromVerdict`) or from a stored
 * `document_spec_checks` row by bin/propose-spec-holds.
 */
export interface HoldJudgedResult {
  verdict: 'in_spec' | 'out_of_spec' | 'not_checked';
  /** `limit` = judged against a configured limit; `printed` = the paper's own. */
  source: 'printed' | 'limit';
  /** The limit's stored criticality, when it was a configured limit. */
  criticality?: string | null;
  /** Why it could not be judged, when that reason notifies (E1 / E2). */
  not_checked_category?: string | null;
  /** The analyte's D3 category (`spec_tests.category`). */
  analyte_category?: string | null;
  /** The register's location identity (`registerIdentity().result_key`). */
  result_key: string;
  result_location?: string | null;
  test_name_raw: string;
  value_raw?: string | null;
  unit_raw?: string | null;
  limit_text?: string | null;
  /** The engine's own explanation of the verdict. */
  reason?: string | null;
}

export interface AutomaticHoldProposal {
  source: Exclude<HoldSource, 'person'>;
  /** Identity of the judged result on this document version. */
  source_key: string;
  reason: string;
  /** Frozen onto the hold: what a reader needs without the register row. */
  detail: {
    test: string;
    value: string | null;
    unit: string | null;
    limit: string | null;
    location: string | null;
    result_key: string;
    version: number;
    why: string | null;
  };
}

/**
 * The identity of a judged result for a hold. The VERSION is part of it: a
 * hold QA released on version 1 says nothing about a replacement file, so a
 * still-failing version 2 is a new result and is held again.
 */
export function holdSourceKey(version: number, source: 'printed' | 'limit', resultKey: string): string {
  return `v${Number.isFinite(version) && version > 0 ? Math.floor(version) : 1}:${source}:${resultKey}`;
}

function valueWithUnit(r: Pick<HoldJudgedResult, 'value_raw' | 'unit_raw'>): string {
  const v = (r.value_raw ?? '').trim();
  const u = (r.unit_raw ?? '').trim();
  if (!v) return 'no value';
  return u && !v.toLowerCase().includes(u.toLowerCase()) ? `${v} ${u}` : v;
}

/** Which hold, if any, one judged result places. Null for almost everything. */
export function holdSourceForResult(r: HoldJudgedResult): Exclude<HoldSource, 'person'> | null {
  // Only a limit the organization configured carries a criticality or an
  // analyte category. The paper's own printed limit carries neither.
  if (r.source !== 'limit') return null;
  if (r.verdict === 'out_of_spec') {
    return r.criticality === HOLDING_SPEC_CRITICALITY ? 'spec_critical' : null;
  }
  if (r.verdict === 'not_checked') {
    // E2, exactly: a SAMPLE-SIZE mismatch on a ZERO-TOLERANCE analyte. A method
    // mismatch never holds (E1), whatever the analyte.
    return r.not_checked_category === 'sample_basis_mismatch' && r.analyte_category === 'zero_tolerance'
      ? 'zero_tolerance'
      : null;
  }
  return null;
}

/**
 * The holds a set of judged results places on ONE document version.
 *
 * `origin` is required so a caller has to say where the verdicts came from:
 * anything but an approval places nothing.
 */
export function automaticHoldsForResults(
  results: readonly HoldJudgedResult[],
  opts: { origin: HoldJudgementOrigin; version: number },
): AutomaticHoldProposal[] {
  if (opts.origin !== 'approval') return [];
  const out: AutomaticHoldProposal[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    const source = holdSourceForResult(r);
    if (!source) continue;
    const key = holdSourceKey(opts.version, r.source, r.result_key);
    if (seen.has(`${source}|${key}`)) continue;
    seen.add(`${source}|${key}`);
    const test = r.test_name_raw.trim() || 'A result';
    const limit = (r.limit_text ?? '').trim();
    const reason =
      source === 'spec_critical'
        ? `${SPEC_CRITICALITY_LABELS[HOLDING_SPEC_CRITICALITY]} result out of spec: ${test} ${valueWithUnit(r)}${limit ? ` (limit ${limit})` : ''}.`
        : `${test}: the sample tested is smaller than the limit requires, and this is a zero-tolerance analyte. It holds until QA resolves it with the supplier's lab.`;
    out.push({
      source,
      source_key: key,
      reason: reason.slice(0, HOLD_REASON_MAX),
      detail: {
        test,
        value: (r.value_raw ?? '').trim() || null,
        unit: (r.unit_raw ?? '').trim() || null,
        limit: limit || null,
        location: (r.result_location ?? '').trim() || null,
        result_key: r.result_key,
        version: opts.version,
        why: (r.reason ?? '').trim() || null,
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// What a screen needs to say about a document's holds
// ---------------------------------------------------------------------------

/** "2 holds: lot 1042, whole certificate". Returns '' for none. */
export function describeActiveHolds(holds: readonly { lot_label?: string | null }[]): string {
  if (holds.length === 0) return '';
  const where = holds.map((h) => ((h.lot_label ?? '').trim() ? `lot ${(h.lot_label ?? '').trim()}` : 'whole certificate'));
  const unique = [...new Set(where)];
  return `${holds.length} hold${holds.length === 1 ? '' : 's'}: ${unique.join(', ')}`;
}
