/**
 * "The current document of type T for supplier S and item P" (migration 0138).
 *
 * A document order asks the portal for a supplier's spec sheet, its hazard
 * plan, its kosher certificate. Nothing answered that question before: the
 * library knows which documents exist, not which ONE a salesperson should be
 * handed. This is the pure half of the answer -- no database, no clock -- so
 * the order page, the send and the tests rank the same way.
 *
 * THE RULE, in the order it is applied:
 *
 *   1. WHO IT IS ABOUT. A candidate is a document of the supplier and of the
 *      type asked for. One linked to THIS item (`document_products`) is about
 *      this item. One linked to NO item is the supplier's own (a hazard plan,
 *      an insurance certificate) and stands for every item of the supplier.
 *      ONE LINKED ONLY TO OTHER ITEMS IS NEVER OFFERED: a spec sheet for heavy
 *      cream is not a spec sheet for cream cheese, however recent it is.
 *   2. AN ITEM'S OWN DOCUMENT BEATS THE SUPPLIER'S. All of tier one ranks
 *      ahead of all of tier two, whatever the dates.
 *   3. NEWEST WINS within a tier, by the day it was approved (else created).
 *   4. THE NEWEST IS THE ANSWER EVEN WHEN IT HAS EXPIRED. The line is then
 *      `expired`. An older document that happens to be in date is NOT
 *      quietly used in its place -- the newer one superseded it, and handing a
 *      customer the superseded copy because the current one lapsed is exactly
 *      the mistake QA exists to catch. Its existence is SAID in the note.
 *   5. A TIE IS BROKEN THE SAME WAY EVERY TIME, AND SAID. Two candidates in
 *      the same tier with the same date: the one created later, then the
 *      higher id. Deterministic, so a refresh cannot flip the answer; and the
 *      note names the tie, because the portal has no real reason to prefer one.
 *   6. NOTHING ELIGIBLE IS `missing`.
 */

export type CurrentDocumentResolution = 'found' | 'missing' | 'expired';

/** `product` = linked to the item asked for; `supplier` = linked to no item. */
export type CurrentDocumentBasis = 'product' | 'supplier';

export interface CurrentDocumentCandidate {
  document_id: string;
  title: string | null;
  version_number: number | null;
  /** COALESCE(approved_at, created_at): when it became the supplier's document here. */
  effective_at: string | null;
  created_at: string | null;
  /** Every item the document is linked to. Empty = the supplier's own. */
  product_ids: readonly string[];
  /** The document's own due date (`resolveRenewalExpiry`), or null when it does not renew. */
  due_date: string | null;
}

export interface CurrentDocumentResult {
  resolution: CurrentDocumentResolution;
  document_id: string | null;
  title: string | null;
  version_number: number | null;
  due_date: string | null;
  basis: CurrentDocumentBasis | null;
  /** Other candidates that tied with the one taken (rule 5). */
  tied_with: string[];
  /** When the answer is `expired`: a lower-ranked candidate that is still in date. */
  in_date_alternative: string | null;
  /** Plain words, when the answer needs them. */
  note: string | null;
}

/** Milliseconds for either timestamp shape the database holds; NaN sorts last. */
function stamp(raw: string | null | undefined): number {
  if (!raw) return Number.NaN;
  const s = raw.trim();
  if (!s) return Number.NaN;
  // SQLite's datetime('now') is "YYYY-MM-DD HH:MM:SS" in UTC with no zone.
  const iso = s.includes('T') ? s : `${s.replace(' ', 'T')}Z`;
  return Date.parse(iso);
}

function cmpDesc(a: number, b: number): number {
  const an = Number.isNaN(a);
  const bn = Number.isNaN(b);
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  return b - a;
}

/** YYYY-MM-DD from a date or a timestamp. Null when it is neither. */
function dayOf(raw: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec((raw ?? '').trim());
  return m ? m[1] : null;
}

/** True when the document's own due date is before `today` (both YYYY-MM-DD). */
export function isPastDue(dueDate: string | null | undefined, today: string): boolean {
  const due = dayOf(dueDate);
  const now = dayOf(today);
  return Boolean(due && now && due < now);
}

function tierOf(c: CurrentDocumentCandidate, productId: string): 0 | 1 | null {
  if (c.product_ids.includes(productId)) return 0;
  if (c.product_ids.length === 0) return 1;
  return null;
}

/**
 * Rank the candidates for one (supplier, type, item) and say which one is the
 * current document. `candidates` must already be the supplier's active
 * documents of the type asked for; this function does not check either.
 */
export function resolveCurrentDocument(
  candidates: readonly CurrentDocumentCandidate[],
  productId: string,
  today: string,
): CurrentDocumentResult {
  const ranked = candidates
    .map((c) => ({ c, tier: tierOf(c, productId) }))
    .filter((x): x is { c: CurrentDocumentCandidate; tier: 0 | 1 } => x.tier !== null)
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        cmpDesc(stamp(a.c.effective_at), stamp(b.c.effective_at)) ||
        cmpDesc(stamp(a.c.created_at), stamp(b.c.created_at)) ||
        (a.c.document_id < b.c.document_id ? 1 : a.c.document_id > b.c.document_id ? -1 : 0),
    );

  if (ranked.length === 0) {
    return {
      resolution: 'missing',
      document_id: null,
      title: null,
      version_number: null,
      due_date: null,
      basis: null,
      tied_with: [],
      in_date_alternative: null,
      note: null,
    };
  }

  const top = ranked[0];
  const topStamp = stamp(top.c.effective_at);
  const tied = ranked
    .slice(1)
    .filter((x) => x.tier === top.tier && cmpDesc(stamp(x.c.effective_at), topStamp) === 0)
    .map((x) => x.c.document_id);

  const expired = isPastDue(top.c.due_date, today);
  const alternative = expired
    ? ranked.slice(1).find((x) => !isPastDue(x.c.due_date, today))?.c ?? null
    : null;

  const notes: string[] = [];
  if (tied.length > 0) {
    notes.push(
      `${tied.length + 1} documents of this type share the same date. The one added last was taken. Check it is the one you mean.`,
    );
  }
  if (expired && alternative) {
    notes.push(
      `Another document of this type on file is still in date${alternative.title ? ` ("${alternative.title}")` : ''}. ` +
        'It was not used in place of the current one: it is older, or it is not this item\'s own.',
    );
  }

  return {
    resolution: expired ? 'expired' : 'found',
    document_id: top.c.document_id,
    title: top.c.title,
    version_number: top.c.version_number,
    due_date: dayOf(top.c.due_date),
    basis: top.tier === 0 ? 'product' : 'supplier',
    tied_with: tied,
    in_date_alternative: alternative ? alternative.document_id : null,
    note: notes.length > 0 ? notes.join(' ') : null,
  };
}
