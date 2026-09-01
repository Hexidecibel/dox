/* eslint-disable no-console */
/**
 * bin/lib/coaBackfill.js — the pure half of `bin/backfill-coa-extended-metadata`.
 *
 * Rows in, a plan out. No database, no filesystem. The driver reads D1 and
 * writes; this module decides what each row MEANS, which is the part that has
 * to be right and the part worth testing (tests/unit/coaBackfill.test.ts).
 *
 * WHY THIS EXISTS
 * ---------------
 * `produceCoa` (the single-record COA path) did not persist
 * `documents.extended_metadata`; the multi-product and records producers always
 * did. The fix is forward-only, so every COA approved before it landed still
 * has a NULL column — and `bin/recheck-spec-limits` filters on
 * `extended_metadata IS NOT NULL`, so those documents are invisible to the spec
 * register entirely. Their test results were never lost: they are still sitting
 * in `processing_queue.tables` for the queue item that produced them.
 *
 * THE MATCHING RULE IS EXACT, AND THAT IS THE WHOLE SAFETY ARGUMENT
 * ----------------------------------------------------------------
 * Three producers mint an external_ref from a queue id:
 *
 *   flat / single-record   `queue-<id>`                (functions/lib/kinds/coa.ts:320)
 *   multi-product          `queue-<id>-p<N>`           (coa.ts:660)
 *   records / sublot       `queue-<id>-<lotKey>`       (coa.ts:1051)
 *
 * Only the FIRST is missing metadata. The other two already wrote a RICHER
 * payload — the records path stores `{tables, groups, source_pages, ...}` and a
 * per-record slice of the tables, not the whole queue item's. A `LIKE 'queue-%'`
 * prefix match would sweep those in and, for any that happened to be NULL,
 * overwrite a per-record document with the whole file's tables. So the join is
 * `documents.external_ref = 'queue-' || pq.id`, an equality — and since queue
 * ids are 32 hex characters with no dash (generateId, functions/lib/db.ts:4),
 * a suffixed ref can never collide with a bare one.
 *
 * WHAT IS NEVER TOUCHED
 * ---------------------
 *   - A document whose extended_metadata is already non-NULL. Not "merged into",
 *     not "refreshed" — skipped. Whatever is there was written by a producer
 *     that knew more about the document than this script does.
 *   - A queue item that is not `approved`. A document with a pending or rejected
 *     queue row is a state nobody planned for; it gets counted and reported
 *     rather than quietly repaired.
 *   - A document whose queue item is gone. The tables went with it. That is
 *     unrecoverable without re-extraction and is reported as such, because a
 *     backfill that silently leaves gaps is indistinguishable from one that
 *     worked.
 */

// The escaping helpers are the importer's, deliberately: the wrangler CLI takes
// a statement string rather than bound parameters, so quoting lives in exactly
// one place in bin/ and both writers use it.
const { sqlText } = require('./specLimitsImport');

/**
 * The external_ref the FLAT producer writes for a queue item.
 * Kept as a function so the test can assert the format rather than trust prose.
 */
function flatExternalRef(queueId) {
  return `queue-${queueId}`;
}

/**
 * Is this external_ref one the flat producer could have written?
 *
 * A queue id contains no dash, so anything with a second dash is a suffixed ref
 * from the multi-product (`-p<N>`) or records (`-<lotKey>`) path. Those already
 * have their own, richer metadata and are not this script's business.
 */
function isFlatQueueRef(externalRef) {
  return /^queue-[^-]+$/.test(String(externalRef || ''));
}

/** Outcome buckets, in the order the report prints them. */
const OUTCOMES = [
  'write',
  'already_populated',
  'not_flat_ref',
  'queue_item_gone',
  'queue_item_not_approved',
  'no_tables',
];

/**
 * Decide what to do with one joined row.
 *
 * @param {object} row
 *   {id, title, external_ref, extended_metadata, queue_id, queue_status, queue_tables}
 *   `queue_id` is NULL when the LEFT JOIN found nothing.
 * @param {(raw: unknown) => string|null} buildFlatExtendedMetadata
 *   THE producer's own function (bin/lib/shared/coaExtendedMetadata.js), so the
 *   backfill cannot emit a shape an approval would not have written.
 * @returns {{outcome: string, reason: string, extended: string|null}}
 */
function decideRow(row, buildFlatExtendedMetadata) {
  if (row.extended_metadata !== null && row.extended_metadata !== undefined) {
    return {
      outcome: 'already_populated',
      reason: 'extended_metadata is already set — left exactly as it is',
      extended: null,
    };
  }
  if (!isFlatQueueRef(row.external_ref)) {
    return {
      outcome: 'not_flat_ref',
      reason: `external_ref "${row.external_ref}" is a multi-product or records ref, not the single-record path`,
      extended: null,
    };
  }
  if (!row.queue_id) {
    return {
      outcome: 'queue_item_gone',
      reason: 'the queue item that produced this document no longer exists — its tables went with it',
      extended: null,
    };
  }
  if (row.queue_status !== 'approved') {
    return {
      outcome: 'queue_item_not_approved',
      reason: `queue item status is "${row.queue_status}", not approved`,
      extended: null,
    };
  }
  const extended = buildFlatExtendedMetadata(row.queue_tables);
  if (extended === null) {
    return {
      outcome: 'no_tables',
      reason: 'the queue item holds no parseable, non-empty table list — there is nothing to write',
      extended: null,
    };
  }
  return { outcome: 'write', reason: 'queue item has tables and the column is empty', extended };
}

/**
 * Fold the decisions for a page of rows into a plan.
 *
 * @param {Array<object>} rows
 * @param {Function} buildFlatExtendedMetadata
 * @returns {{writes: Array, counts: object, examples: object, scanned: number}}
 */
function buildPlan(rows, buildFlatExtendedMetadata) {
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  const examples = Object.fromEntries(OUTCOMES.map((o) => [o, []]));
  const writes = [];

  for (const row of rows || []) {
    const d = decideRow(row, buildFlatExtendedMetadata);
    counts[d.outcome] += 1;
    if (examples[d.outcome].length < 5) {
      examples[d.outcome].push({ id: row.id, title: row.title, reason: d.reason });
    }
    if (d.outcome === 'write') {
      writes.push({ id: row.id, title: row.title, extended: d.extended });
    }
  }

  return { scanned: (rows || []).length, counts, examples, writes };
}

/**
 * Render the writes as UPDATE statements.
 *
 * Two things every statement carries, on purpose:
 *   - `AND extended_metadata IS NULL`. The plan was built from a read that
 *     finished minutes ago; if an approval populated the column in between, the
 *     UPDATE must lose that race rather than clobber a fresher value.
 *   - No `updated_at` bump. Filling a derived column is not an edit anyone made
 *     to the document, and moving updated_at would reshuffle every
 *     "recently updated" list a user looks at for a change they cannot see.
 *     (documents' FTS update trigger still reindexes the row, which is the
 *     point — the tables become searchable too.)
 */
function planToSql(writes) {
  return (writes || []).map(
    (w) =>
      `UPDATE documents SET extended_metadata = ${sqlText(w.extended)} ` +
      `WHERE id = ${sqlText(w.id)} AND extended_metadata IS NULL;`
  );
}

/**
 * Split statements into batches. D1 caps how much one execute can carry, and
 * these statements each hold a whole COA's tables, so the batch is sized by
 * BYTES as well as by count — a hundred small ones and a hundred large ones are
 * not the same request.
 */
function batchStatements(statements, opts = {}) {
  const maxCount = opts.maxCount || 50;
  const maxBytes = opts.maxBytes || 512 * 1024;
  const batches = [];
  let current = [];
  let bytes = 0;
  for (const s of statements || []) {
    const size = Buffer.byteLength(s, 'utf8');
    if (current.length > 0 && (current.length >= maxCount || bytes + size > maxBytes)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(s);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Render the plan as the lines the script prints. Returns an array of lines. */
function formatPlan(plan, opts = {}) {
  const c = plan.counts;
  const out = [];

  out.push('');
  out.push(
    `COA extended_metadata backfill — tenant ${opts.tenantId}${opts.targetLabel ? ` (${opts.targetLabel})` : ''}`
  );
  out.push('='.repeat(72));
  out.push(`Documents scanned ................... ${plan.scanned}`);
  out.push(`  eligible (will be filled) ......... ${c.write}`);
  out.push(`  skipped, already populated ........ ${c.already_populated}`);
  out.push(`  skipped, not the flat path ........ ${c.not_flat_ref}`);
  out.push(`  skipped, queue item gone .......... ${c.queue_item_gone}`);
  out.push(`  skipped, queue item not approved .. ${c.queue_item_not_approved}`);
  out.push(`  skipped, queue item has no tables . ${c.no_tables}`);
  if (opts.capped) {
    out.push(`NOTE: capped at --limit ${opts.capped}; more documents were not scanned.`);
  }

  const section = (outcome, heading) => {
    if (c[outcome] === 0) return;
    out.push('');
    out.push(heading);
    out.push('-'.repeat(72));
    for (const e of plan.examples[outcome]) {
      out.push(`  ${e.title}`);
    }
    if (c[outcome] > plan.examples[outcome].length) {
      out.push(`  … and ${c[outcome] - plan.examples[outcome].length} more.`);
    }
  };

  section('write', 'Would be filled in (examples)');
  section(
    'queue_item_gone',
    'Queue item gone — NOT recoverable here; these need re-extraction to be judged'
  );
  section('no_tables', 'Queue item carried no tables — nothing to write (examples)');
  section('queue_item_not_approved', 'Queue item is not approved — left alone (examples)');

  out.push('');
  return out;
}

module.exports = {
  OUTCOMES,
  flatExternalRef,
  isFlatQueueRef,
  decideRow,
  buildPlan,
  planToSql,
  batchStatements,
  formatPlan,
};
