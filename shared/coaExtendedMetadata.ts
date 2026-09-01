/**
 * shared/coaExtendedMetadata.ts — the `documents.extended_metadata` payload for
 * the FLAT (single-record) COA path.
 *
 * This lives in shared/ rather than beside its only worker caller for one
 * reason: `bin/backfill-coa-extended-metadata` has to produce BYTE-IDENTICAL
 * output to what an approval writes, and a backfill that drifts from the
 * producer is worse than no backfill — it would fill the column with a shape
 * the spec engine reads differently from the rows around it. So the function
 * has exactly one definition, compiled to CJS for bin/ by
 * `npm run build:worker-shared` (bin/lib/shared/coaExtendedMetadata.js) and
 * imported directly by the worker.
 */

/**
 * Shape is deliberately identical to what produceMultiProductCoa writes —
 * `{ tables }`, JSON-stringified — and a strict subset of what
 * produceCoaRecords writes (`{ tables, groups, source_pages, page_scoped, ... }`).
 * The flat path has no per-record `groups` and no `source_pages` (both are
 * properties of the records payload, which this path does not have), so it
 * stores `tables` alone rather than padding with nulls.
 *
 * Returns null for an absent, unparseable, or empty table list — matching the
 * other two paths, which store NULL rather than an empty object when there is
 * nothing to record.
 *
 * Why this matters: without it an approved one-product COA persists NO test
 * results, so `bin/recheck-spec-limits` — which reads
 * documents.extended_metadata — cannot see the document at all. Review-time
 * warnings were never affected (spec-warnings reads the queue row).
 */
export function buildFlatExtendedMetadata(rawTables: unknown): string | null {
  let parsed: unknown = rawTables;
  if (typeof rawTables === 'string') {
    if (!rawTables.trim()) return null;
    try {
      parsed = JSON.parse(rawTables);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  return JSON.stringify({ tables: parsed });
}
