/**
 * Shared FTS5 helpers for the Document Search v2 plan (Phase 4).
 *
 * Plan: `/home/hexi/.claude/plans/peppy-coalescing-platypus.md` § 1.6.
 *
 * Two responsibilities:
 *
 *   1. **Sanitize user input into a safe FTS5 MATCH expression.**
 *      Multi-token AND is FTS5's default. We strip anything that has
 *      meaning inside an FTS5 expression (`-`, `*`, `:`, `(`, `)`, `"`,
 *      and the literal NEAR keyword), quote each surviving token so it
 *      can never be re-parsed as an operator, and append `*` to the
 *      LAST token only so users see results as they type a prefix.
 *
 *   2. **Ship the documents_fts column-index constants.** Migration 0054
 *      declares the indexed columns in this order; the API uses the
 *      indexes for `snippet(documents_fts, <col>, ...)` calls. Keeping
 *      them as named exports avoids magic numbers scattered across the
 *      handlers.
 *
 * Reused across:
 *   - `functions/api/documents/search/index.ts`
 *   - `functions/api/documents/search/natural.ts`
 *   - `functions/api/orders/index.ts`           (uses `buildMatchExpr` only)
 *   - `functions/api/search/index.ts`           (universal endpoint, Phase 4d)
 */

/**
 * Column indexes inside the `documents_fts` virtual table, as declared
 * in `migrations/0054_fts_search.sql` § 2.
 *
 * Used as the second argument to FTS5's `snippet()` to scope a snippet
 * to one column ("title" hits look different from "extracted_text"
 * hits). `-1` means "any column" — also valid in `snippet()`.
 */
export const DOCUMENTS_FTS_COLS = {
  title: 0,
  description: 1,
  tags_text: 2,
  file_name: 3,
  extracted_text: 4,
  primary_metadata_text: 5,
  extended_metadata_text: 6,
  supplier_text: 7,
  document_type_text: 8,
  product_text: 9,
  // Added in migration 0074 (COA sublot split / lot search). Flattens the
  // doc's linked lots: lot_number, norm(lot_number), sub_lot_code, lot_key.
  lot_text: 10,
} as const;

/**
 * Normalize a user-typed lot term for matching against `documents_fts.lot_text`.
 *
 * Mirrors functions/lib/entities/lots.ts#normalizeLotNumber so the term lines
 * up with the normalized forms indexed in lot_text (norm(lot_number) and
 * lot_key, both of which are uppercase + separator-free):
 *   - uppercase + trim
 *   - strip a leading "LOT"/"LOT#"/"LOT:"/"#" noise prefix
 *   - drop every non-alphanumeric char (dashes, spaces, dots, slashes)
 *
 * So "10426110-05", "10426110 05", "lot# 1042611005" all collapse to
 * "1042611005", and the bare main lot "10426110" collapses to "10426110".
 *
 * Returns "" when the input has no alphanumeric content.
 */
export function normalizeLotTerm(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = String(raw).toUpperCase().trim();
  if (!s) return '';
  s = s.replace(/^(?:LOT\b|#)\s*[#:]?\s*/i, '').trim();
  s = s.replace(/[^A-Z0-9]/g, '');
  return s;
}

/**
 * Build a `documents_fts MATCH` expression that ANDs the standard
 * free-text expression with a column-scoped, normalized lot prefix term.
 *
 * Rationale: a lot term like "10426110-05" must (a) survive separator
 * differences and (b) prefix-match `lot_key` so the MAIN lot returns ALL
 * its sublots ("10426110" prefixes "1042611005", "1042611006", ...) while
 * the combined term returns the exact sublot. The standard buildMatchExpr
 * already quotes + prefixes the raw token, but it does NOT normalize away
 * separators — so the punctuated form would miss the separator-free
 * indexed `lot_key`/`norm(lot_number)`. This helper adds the normalized
 * form as an explicit `lot_text :` column filter ORed onto the base.
 *
 * The two parts are combined as `(<base>) OR (lot_text : "<norm>"*)` so a
 * lot query still matches docs that mention the lot in title/extracted
 * text etc. AND docs that only carry it in the linked-lot column.
 *
 * Returns the same value as buildMatchExpr when the term has no
 * normalizable lot content (so non-lot searches are unaffected), or null
 * when the input sanitizes to nothing.
 */
export function buildMatchExprWithLot(input: string | null | undefined): string | null {
  const base = buildMatchExpr(input);
  if (base === null) return null;

  const norm = normalizeLotTerm(input);
  // Only augment when the normalized term is a single contiguous
  // alphanumeric run of reasonable length — i.e. it actually looks like a
  // lot/identifier rather than a multi-word phrase. (normalizeLotTerm
  // already stripped whitespace, so any normalized value is contiguous;
  // we still guard on length to avoid degenerate single-char prefixes.)
  if (norm.length < 2) return base;

  // Column-scoped prefix term. The lot_text column carries the normalized
  // lot_key + norm(lot_number), both separator-free + uppercase; FTS5
  // case-folds, so a lowercase phrase matches.
  const lotTerm = `lot_text : "${norm.toLowerCase()}"*`;
  return `(${base}) OR (${lotTerm})`;
}

/**
 * Build a safe FTS5 MATCH expression from user input.
 *
 * Behavior:
 *   - Returns `null` when the cleaned input has zero tokens. The caller
 *     should NOT issue `... MATCH ?` in that case — pass through the
 *     non-search filter branch instead. Returning `null` (rather than
 *     `'""'` or similar) keeps the call sites explicit.
 *   - Strips characters with FTS5 *expression* meaning: `"`, `*`, `:`,
 *     `(`, `)`. Whitespace splits tokens.
 *   - Hyphens, underscores, slashes, and dots are KEPT inside tokens —
 *     migration 0054 declares `tokenize = "unicode61 ... tokenchars
 *     '-_/.'"` so SKUs and lot numbers like `LOT-SRCH-002` survive as
 *     a single token. Quoting each token below also defangs `-` from
 *     being parsed as the NOT operator at the FTS5 expression layer.
 *   - Replaces a literal `NEAR` token (in any case) with empty space —
 *     FTS5 reserves it as an operator and we don't want to risk a
 *     "syntax error: missing argument" surfacing to users.
 *   - Each surviving token is wrapped in `"..."` so it cannot be
 *     re-parsed; the last token gets a trailing `*` for prefix search.
 *
 * Examples:
 *   buildMatchExpr('darigold cheese')   → '"darigold" "cheese"*'
 *   buildMatchExpr('LOT-SRCH-002')      → '"lot-srch-002"*'
 *   buildMatchExpr('NEAR hello')        → '"hello"*'
 *   buildMatchExpr('*"():')             → null
 *   buildMatchExpr('  ')                → null
 */
export function buildMatchExpr(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;

  // Replace FTS5 expression operators / quotes with whitespace so the
  // split logic below treats them as token separators. Note we do NOT
  // strip `-` here — see header comment. With each token wrapped in
  // `"..."` below, `-` cannot trigger the FTS5 NOT operator.
  let cleaned = input.replace(/["*:()]/g, ' ');

  // Drop the FTS5 reserved word NEAR (case-insensitive, word-boundaried)
  // before tokenizing. It's whitespace-padded so we don't merge two
  // unrelated tokens together.
  cleaned = cleaned.replace(/\bNEAR\b/gi, ' ');

  // Split on whitespace AND on lone-hyphen separators — a single `-`
  // surrounded by whitespace is plainly a NOT operator that survived
  // the strip above. We only treat `-` as a separator when it's NOT
  // adjacent to a tokenchar on both sides (i.e. inside a SKU like
  // `LOT-SRCH-002` it stays glued).
  const tokens = cleaned
    .split(/\s+/)
    .map((t) => t.replace(/^-+|-+$/g, ''))     // strip leading/trailing `-` (NOT-operator position)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return null;

  return tokens
    .map((tok, i) => {
      // Lowercase for parity with the unicode61 tokenizer's case folding.
      // Strip stray `"` defensively — the regex above already handles
      // them but tokens that contain backslash-escaped quotes etc. are
      // never safe inside an FTS5 phrase literal.
      const quoted = `"${tok.toLowerCase().replace(/"/g, '')}"`;
      return i === tokens.length - 1 ? `${quoted}*` : quoted;
    })
    .join(' ');
}
