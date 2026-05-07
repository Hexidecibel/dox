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
} as const;

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
