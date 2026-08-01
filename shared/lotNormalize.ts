/**
 * Pure lot / sublot / product-name normalization.
 *
 * WHY THIS FILE EXISTS: these three functions used to live in
 * `functions/lib/entities/lots.ts` (which pulls in D1 + `generateId`) and were
 * hand-mirrored into `bin/check-extraction-invariants` as CommonJS, because
 * bin/ scripts are plain Node with no TS compile step. Two copies of a matching
 * rule is exactly the kind of drift that silently changes what "the same lot"
 * means on one side of the system.
 *
 * So the rules now live HERE, with zero imports:
 *   - `functions/lib/entities/lots.ts` re-exports them (its public API is
 *     unchanged; every existing importer keeps working).
 *   - `shared/extractionInvariants.ts` imports them.
 *   - `bin/` gets them through the esbuild bundle of extractionInvariants
 *     (`npm run build:worker-shared`), so there is no hand-maintained mirror
 *     left to drift.
 *
 * Keep this file dependency-free — it is bundled for plain Node.
 */

/**
 * Normalize a raw lot number into a stable matching key.
 *
 * Rules (applied in order):
 *   1. Uppercase + trim.
 *   2. Strip a leading "LOT", "LOT#", "LOT #", "LOT:" or bare "#" token (with
 *      any surrounding whitespace/colon/hash) — these are noise prefixes that
 *      reviewers and suppliers add inconsistently.
 *   3. Strip ALL non-alphanumeric characters (dashes, spaces, dots, slashes).
 *      Internal whitespace therefore collapses too.
 *
 * Examples (all → "061926LC3"):
 *   "Lot# 061926LC3"
 *   "  061926lc3 "
 *   "LOT 061926-LC3"
 *   "#061926 LC3"
 *
 * Returns "" when the input is empty/whitespace or normalizes to nothing.
 */
export function normalizeLotNumber(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = String(raw).toUpperCase().trim();
  if (!s) return '';

  // Strip a leading LOT / LOT# / LOT: / # token plus surrounding separators.
  s = s.replace(/^(?:LOT\b|#)\s*[#:]?\s*/i, '').trim();

  // Drop every non-alphanumeric char (this also collapses internal whitespace,
  // dashes, dots, slashes, etc.).
  s = s.replace(/[^A-Z0-9]/g, '');

  return s;
}

/**
 * Normalize a sublot code into the 2-digit string stored on `lots.sub_lot_code`
 * and concatenated into `lot_key`.
 *
 * Sublots are ALWAYS 2 digits (user, 2026-06-11), so the value is taken
 * verbatim after stripping separators/whitespace and uppercasing — the same
 * cleaning the main lot gets. A 1-digit value is left-padded to 2 digits
 * defensively (a source should never emit one, but a stray "5" must not collide
 * with "50"). Empty/whitespace → '' (the main-lot-only sentinel; NEVER null).
 */
export function normalizeSubLotCode(raw: string | null | undefined): string {
  if (!raw) return '';
  const s = String(raw).toUpperCase().trim().replace(/[^A-Z0-9]/g, '');
  if (!s) return '';
  // Defensive pad only — real sources always emit exactly 2 digits.
  return /^[0-9]$/.test(s) ? `0${s}` : s;
}

/**
 * Normalize a product name into a stable map key for `supplier_product_map`
 * (migration 0075). Uppercase, trim, collapse every run of non-alphanumeric
 * characters to a single space, then trim again. Durable across re-extraction
 * (punctuation/spacing drift does not change the key).
 *
 * "Cream - Heavy Whipping 40%" → "CREAM HEAVY WHIPPING 40"
 */
export function normalizeProductNameKey(
  name: string | null | undefined
): string {
  if (!name) return '';
  return String(name)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}
