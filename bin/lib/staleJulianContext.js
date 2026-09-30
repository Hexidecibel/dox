/**
 * bin/lib/staleJulianContext.js — the deciding half of
 * bin/fix-stale-julian-context. Pure: text in, plan out.
 *
 * A tenant's stored `extraction_context` (0072) REPLACES the code default
 * wholesale, so a tenant that saved the dairy template before v2.16.0 still
 * carries its old line
 *
 *   - Code dates may use Julian format (YDDD where Y=last digit of year, DDD=day)
 *
 * which invites the model to decode a code, when every prompt now says a lot
 * or code date is copied as printed and decoding is the declared lot format's
 * job (Declared Lot Formats, tests/unit/lotCodeNotDecodedByModel.test.ts).
 *
 * Only that EXACT line (after trimming) is touched -- a person who reworded it
 * wrote something else, and that is reported, not rewritten. Default is to
 * remove it; `replace` swaps in the line the code default carries today.
 */

'use strict';

const STALE_LINE = '- Code dates may use Julian format (YDDD where Y=last digit of year, DDD=day)';
const CURRENT_DEFAULT_LINE =
  '- Code dates may be printed in Julian format (YDDD where Y=last digit of year, DDD=day) — copy them exactly as printed; never convert one to a calendar date';

/**
 * @param {string|null} context  the stored extraction_context
 * @param {'remove'|'replace'} mode
 * @returns {{ action: 'change'|'none'|'reworded'|'default', after?: string, removed: number[], similar: string[] }}
 */
function planContextFix(context, mode = 'remove') {
  if (context === null || context === undefined) return { action: 'default', removed: [], similar: [] };
  const lines = String(context).split('\n');
  const removed = [];
  const out = [];
  lines.forEach((line, i) => {
    if (line.trim() === STALE_LINE) {
      removed.push(i + 1);
      if (mode === 'replace') out.push(line.replace(STALE_LINE, CURRENT_DEFAULT_LINE));
    } else {
      out.push(line);
    }
  });
  const similar = lines.filter((l) => /julian/i.test(l) && l.trim() !== STALE_LINE && l.trim() !== CURRENT_DEFAULT_LINE);
  if (removed.length === 0) return { action: similar.length ? 'reworded' : 'none', removed, similar };
  return { action: 'change', after: out.join('\n'), removed, similar };
}

/** A unified-style diff of the changed lines with one line of context. */
function lineDiff(before, after) {
  const a = String(before).split('\n');
  const b = String(after).split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const out = [`@@ line ${start + 1} @@`];
  if (start > 0) out.push(`  ${a[start - 1]}`);
  for (let i = start; i <= endA; i++) out.push(`- ${a[i]}`);
  for (let i = start; i <= endB; i++) out.push(`+ ${b[i]}`);
  if (endA + 1 < a.length) out.push(`  ${a[endA + 1]}`);
  return out.join('\n');
}

module.exports = { STALE_LINE, CURRENT_DEFAULT_LINE, planContextFix, lineDiff };
