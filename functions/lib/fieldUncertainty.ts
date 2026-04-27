/**
 * Phase 3.5 per-field uncertainty heuristic. Pure function so the same logic
 * can be exercised by unit tests AND ported into the process-worker (JS) by
 * mirror — the worker can't `require` a .ts file at runtime, so the JS copy
 * lives in bin/process-worker but MUST stay byte-equivalent in semantics.
 *
 * Heuristic intent: dumb-but-useful first pass. Empty / suspicious /
 * format-failing values get bumped to "needs your eyes". Dual-mode
 * disagreement (text vs VLM) gets layered on top in
 * computeUncertaintyPayload — disagreement IS uncertainty.
 */

const DATE_PATTERNS = [/\d{4}-\d{2}-\d{2}/, /\d{1,2}\/\d{1,2}\/\d{2,4}/];

export function computeFieldUncertainty(fieldKey: string, value: unknown): number {
  if (value == null) return 1.0;
  const s = String(value).trim();
  if (s === '') return 1.0;
  if (s.includes('(?)') || s === '?') return 0.7;
  if (/lot/i.test(fieldKey) && s.length < 3) return 0.6;
  if (/date/i.test(fieldKey)) {
    const looksLikeDate = DATE_PATTERNS.some(re => re.test(s));
    if (!looksLikeDate) return 0.7;
  }
  if (/number|code|qty|count|weight/i.test(fieldKey) && /^[A-Za-z]+$/.test(s)) return 0.7;
  return 0.2;
}

/**
 * Build a Record<field_key, 0..1> uncertainty payload over the union of keys
 * from the text and VLM extractions. When BOTH sides have a non-empty value
 * for a key and they differ, the score is forced to >= 0.7. Single-side
 * mode just runs the per-field heuristic over whichever side ran.
 */
export function computeUncertaintyPayload(
  textFields: Record<string, unknown> | null | undefined,
  vlmFields: Record<string, unknown> | null | undefined
): Record<string, number> {
  const text = textFields ?? {};
  const vlm = vlmFields ?? {};
  const allKeys = new Set<string>([...Object.keys(text), ...Object.keys(vlm)]);
  const out: Record<string, number> = {};
  for (const key of allKeys) {
    const tVal = text[key];
    const vVal = vlm[key];
    const seedValue = tVal != null ? tVal : vVal;
    let score = computeFieldUncertainty(key, seedValue);
    const tStr = tVal == null ? '' : String(tVal).trim();
    const vStr = vVal == null ? '' : String(vVal).trim();
    if (tStr !== '' && vStr !== '' && tStr !== vStr) {
      score = Math.max(score, 0.7);
    }
    out[key] = score;
  }
  return out;
}
