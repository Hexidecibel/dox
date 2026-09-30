/**
 * "You already have this" -- the pure half of the NEWER-REVISION match
 * (migration 0132). The D1 half is functions/lib/intake/already-have.ts.
 *
 * An arrival is the same document as one we hold, in a newer revision, when
 * ALL of these hold and the bytes differ:
 *   - same supplier (the queue item's resolved supplier_id), and
 *   - same document type, and
 *   - the paper's own document number matches, OR its certificate number
 *     matches, OR -- for a lot-scoped type such as a COA -- the SET of lots is
 *     exactly the same set.
 *
 * CONSERVATIVE ON PURPOSE. Only exact identity keys: a number on each side
 * that normalizes identically (case, spaces and punctuation fold; leading
 * zeros stay -- the search-key rule), or an identical lot set. Never a title,
 * never "looks similar". A missed match costs a person one ordinary approval;
 * a false match puts a wrong "Replace existing" in front of them as the
 * default, which is the expensive mistake.
 */

import { identifierKeys } from './searchKeys';
import type { DuplicateMatchBasis } from './types';

/** Numbers shorter than this are too weak to identify a document ("1", "A2"). */
export const MIN_IDENTITY_NUMBER_LENGTH = 3;

export interface IdentityNumbers {
  document_numbers: string[];
  certificate_numbers: string[];
}

/** The paper's own document / certificate numbers, normalized, from one or more field maps. */
export function identityNumbers(fieldMaps: Array<Record<string, unknown> | null | undefined>): IdentityNumbers {
  const doc = new Set<string>();
  const cert = new Set<string>();
  for (const m of fieldMaps) {
    if (!m) continue;
    for (const k of identifierKeys(m, ['document_number', 'certificate_number'])) {
      if (k.value_norm.length < MIN_IDENTITY_NUMBER_LENGTH) continue;
      (k.kind === 'document_number' ? doc : cert).add(k.value_norm);
    }
  }
  return { document_numbers: [...doc], certificate_numbers: [...cert] };
}

export interface ArrivalIdentity extends IdentityNumbers {
  /** Lot keys (the stored `lots.lot_key` shape, under the supplier's scheme). */
  lot_keys: string[];
}

/**
 * One document we hold, as a candidate. `origin` groups the documents one
 * approval produced (a records COA is one document per lot): the queue item
 * id it came from, else its own id.
 */
export interface RevisionCandidate extends IdentityNumbers {
  document_id: string;
  origin: string;
  lot_keys: string[];
  /** Sort key: the most recently approved origin wins. */
  approved_at: string | null;
}

export interface RevisionMatch {
  basis: Exclude<DuplicateMatchBasis, 'identical_bytes'>;
  matched_value: string;
  origin: string;
  document_ids: string[];
}

function newestFirst(a: { approved_at: string | null }, b: { approved_at: string | null }): number {
  return String(b.approved_at ?? '').localeCompare(String(a.approved_at ?? ''));
}

/**
 * The newest document (origin) the arrival is a newer revision of, or null.
 * Precedence: document number, then certificate number, then lot set. The
 * caller has already restricted candidates to the same supplier and type and
 * excluded anything byte-identical and anything from the arrival's own
 * approval.
 */
export function pickRevisionMatch(
  arrival: ArrivalIdentity,
  candidates: RevisionCandidate[],
  opts: { lotScoped: boolean },
): RevisionMatch | null {
  const byNumber = (
    kind: 'document_numbers' | 'certificate_numbers',
    basis: 'document_number' | 'certificate_number',
  ): RevisionMatch | null => {
    const wanted = new Set(arrival[kind]);
    if (wanted.size === 0) return null;
    const hits = candidates.filter((c) => c[kind].some((n) => wanted.has(n))).sort(newestFirst);
    if (hits.length === 0) return null;
    const origin = hits[0].origin;
    const inOrigin = hits.filter((h) => h.origin === origin);
    const value = inOrigin[0][kind].find((n) => wanted.has(n)) as string;
    return { basis, matched_value: value, origin, document_ids: inOrigin.map((h) => h.document_id) };
  };

  const dn = byNumber('document_numbers', 'document_number');
  if (dn) return dn;
  const cn = byNumber('certificate_numbers', 'certificate_number');
  if (cn) return cn;

  if (!opts.lotScoped || arrival.lot_keys.length === 0) return null;
  const want = [...new Set(arrival.lot_keys)].sort();
  const groups = new Map<string, { lots: Set<string>; docs: RevisionCandidate[]; approved_at: string | null }>();
  for (const c of candidates) {
    const g = groups.get(c.origin) ?? { lots: new Set<string>(), docs: [], approved_at: c.approved_at };
    for (const l of c.lot_keys) g.lots.add(l);
    g.docs.push(c);
    if (String(c.approved_at ?? '') > String(g.approved_at ?? '')) g.approved_at = c.approved_at;
    groups.set(c.origin, g);
  }
  const equal = [...groups.entries()]
    .filter(([, g]) => g.lots.size === want.length && want.every((l) => g.lots.has(l)))
    .map(([origin, g]) => ({ origin, ...g }))
    .sort(newestFirst);
  if (equal.length === 0) return null;
  const hit = equal[0];
  return {
    basis: 'lot_set',
    matched_value: want.join(', '),
    origin: hit.origin,
    document_ids: hit.docs.map((d) => d.document_id),
  };
}

/**
 * The owner's wording (2026-09-30), used by the card, the Import notice, the
 * toast and the audit row alike so all four say the same thing:
 *   primary button  "Replace existing (becomes v3)"
 *   helper          "v1–v2 stay in version history"
 */
export function replaceButtonLabel(nextVersion: number): string {
  return `Replace existing (becomes v${nextVersion})`;
}

export function keptVersionsLabel(currentVersion: number): string {
  return currentVersion <= 1 ? 'v1 stays in version history' : `v1–v${currentVersion} stay in version history`;
}

/** The card's "why", in plain words. */
export function duplicateReason(basis: DuplicateMatchBasis, value: string | null): string {
  switch (basis) {
    case 'identical_bytes':
      return 'It is the same file, byte for byte.';
    case 'document_number':
      return `Same supplier and document type, and the same document number (${value}), in a different file: a newer revision.`;
    case 'certificate_number':
      return `Same supplier and document type, and the same certificate number (${value}), in a different file: a newer revision.`;
    case 'lot_set':
      return `Same supplier and document type, and exactly the same lot${value && value.includes(',') ? 's' : ''} (${value}), in a different file: a newer revision.`;
  }
}

/**
 * Pair each approved record of a records-shaped COA with the matched document
 * that carries its lot, for "Replace existing". Returns null when the pairing
 * is not exact (a record with no counterpart, two records on one document), in
 * which case Replace is refused and the reviewer chooses Keep as new: a
 * guessed pairing would version the wrong certificate.
 *
 * One record against one document pairs regardless of lot (a flat match).
 */
export function pairRecordsToDocuments(
  records: Array<{ record_index: number; lot_key: string | null }>,
  documents: Array<{ id: string; lot_keys: string[] }>,
): Map<number, string> | null {
  if (records.length === 0) return null;
  if (records.length === 1 && documents.length === 1) {
    return new Map([[records[0].record_index, documents[0].id]]);
  }
  const out = new Map<number, string>();
  const used = new Set<string>();
  for (const r of records) {
    if (!r.lot_key) return null;
    const doc = documents.find((d) => d.lot_keys.includes(r.lot_key as string) && !used.has(d.id));
    if (!doc) return null;
    used.add(doc.id);
    out.set(r.record_index, doc.id);
  }
  return out;
}
