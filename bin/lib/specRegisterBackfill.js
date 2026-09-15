/**
 * bin/lib/specRegisterBackfill.js — the decision half of
 * `bin/backfill-spec-register`.
 *
 * Everything here is PURE: rows in, plan out, no D1, no network, no clock of
 * its own (the run timestamp is passed in). The script does the talking; this
 * file does the deciding, so the rules below can be tested without a database.
 *
 * THE FOUR RULES THIS FILE EXISTS TO ENFORCE
 *
 *  1. NEVER OVERWRITE A ROW WRITTEN AT APPROVAL. An approval-time row is the
 *     record of a person looking at a result and going ahead. A script that
 *     recomputed it under today's limits would destroy the one thing the
 *     register is for. Such a document is SKIPPED WHOLE and reported.
 *  2. IDEMPOTENT BY DOCUMENT. A document that already has register rows — from
 *     an approval or from a previous pass — is skipped. So the second `--apply`
 *     writes nothing, which is the property that makes it safe to re-run after
 *     an interrupted pass.
 *  3. A DATE IS NOT A MEASUREMENT. A value that parses as a clock time or a
 *     calendar date came from a table that was never a results crosstab (an
 *     incubation log read as one). Those are refused on the way IN, and the
 *     ones already in the register are identified on the way out — but never
 *     deleted except under an explicit flag.
 *  4. THE SNAPSHOT IS THE PRODUCER'S OWN. `buildLimitSnapshot` is injected from
 *     the compiled shared/specSnapshot.ts, the same function the approval path
 *     calls, so a backfilled row freezes its limit — criticality (0095) and
 *     unit equivalence (0093) included — on identical terms.
 *
 * WHAT IS NOT HERE, DELIBERATELY: anything that sends. No email, no alert link,
 * no recipient resolution. `notifySpecFailures` lives in
 * functions/lib/spec-register.ts and is reachable only from the approval route;
 * nothing in bin/ can call it, and the SQL this file renders touches exactly one
 * table plus one audit row.
 */

// ---------------------------------------------------------------------------
// SQL literals
// ---------------------------------------------------------------------------

function sqlText(v) {
  if (v === null || v === undefined || v === '') return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function sqlNum(v) {
  if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return 'NULL';
  return String(Number(v));
}

// ---------------------------------------------------------------------------
// "That is not a measurement" — the artifact predicate
// ---------------------------------------------------------------------------

/**
 * A clock time.
 *
 * CONFIDENT when it carries an am/pm marker, seconds, or an hour that cannot be
 * anything else (00, or 13-23). AMBIGUOUS for a bare `1:10`, because a dilution
 * ratio looks exactly like that and this predicate can gate a DELETE from a
 * compliance register — the cost of a false positive here is a destroyed record,
 * so the tie goes to keeping the row and telling a human about it.
 */
function looksLikeClockTime(value) {
  const s = String(value == null ? '' : value).trim();
  const m = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)?$/i.exec(s);
  if (!m) return null;
  const hour = Number(m[1]);
  const hasSeconds = m[3] !== undefined;
  const meridiem = m[4] !== undefined;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    return 'confident';
  }
  if (hour > 23) return null;
  if (hasSeconds || hour === 0 || hour > 12) return 'confident';
  return 'ambiguous';
}

/** A calendar date, in the forms a lab report actually prints. */
function looksLikeDate(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return null;
  // ISO, with or without a time part.
  if (/^\d{4}-\d{2}-\d{2}([ T]\d{1,2}:\d{2}(:\d{2})?)?$/.test(s)) return 'confident';
  // M/D/YY, M/D/YYYY, and the apostrophe-year form Andersen prints ("04/12/'27").
  if (/^\d{1,2}[/-]\d{1,2}[/-]'?\d{2,4}$/.test(s)) return 'confident';
  // 12-Aug-2026 / 12 Aug 26
  if (/^\d{1,2}[- ](jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[- ]'?\d{2,4}$/i.test(s)) {
    return 'confident';
  }
  // Aug 12, 2026
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}$/i.test(s)) {
    return 'confident';
  }
  return null;
}

/**
 * A column header that names a moment rather than an analyte — the other
 * orientation of the same misread, where the incubation log's headers land in
 * `test_name_raw` instead of its clock times landing in `value_raw`.
 */
function looksLikeDateOrTimeName(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return false;
  if (/^(date|time)\b/i.test(s)) return true;
  if (/\b(date|time)\s*(in|out|read|start|end|stamp)\b/i.test(s)) return true;
  if (/\bincubat/i.test(s)) return true;
  return false;
}

/**
 * Classify one register row (or one about-to-be-written verdict) as an artifact
 * of the incubation-log misread, or not.
 *
 * Returns null for a real result, or { kind, confidence, why }.
 */
function classifyArtifact({ test_name_raw, value_raw }) {
  const clock = looksLikeClockTime(value_raw);
  if (clock) {
    return {
      kind: 'clock_time',
      confidence: clock,
      why:
        clock === 'confident'
          ? `"${String(value_raw).trim()}" is a clock time, not a measured value`
          : `"${String(value_raw).trim()}" reads as a clock time, but could be a ratio`,
    };
  }
  const date = looksLikeDate(value_raw);
  if (date) {
    return {
      kind: 'date',
      confidence: 'confident',
      why: `"${String(value_raw).trim()}" is a date, not a measured value`,
    };
  }
  if (looksLikeDateOrTimeName(test_name_raw)) {
    return {
      kind: 'date_time_column',
      confidence: 'ambiguous',
      why: `"${String(test_name_raw).trim()}" names a moment, not an analyte`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// What is already in the register
// ---------------------------------------------------------------------------

/**
 * Index the tenant's existing rows by document.
 *
 * `origins` is a Set of the distinct `judgement_origin` values seen for that
 * document, so the skip reason can say WHICH kind of row is being protected —
 * "a reviewer wrote this" and "a previous pass wrote this" are both reasons not
 * to write, and only one of them is interesting.
 */
function indexExistingRows(rows) {
  const byDocument = new Map();
  for (const r of rows || []) {
    const entry = byDocument.get(r.document_id) || {
      count: 0,
      origins: new Set(),
      runs: new Set(),
    };
    entry.count += 1;
    entry.origins.add(r.judgement_origin || 'unrecorded');
    if (r.bulk_run_at) entry.runs.add(r.bulk_run_at);
    byDocument.set(r.document_id, entry);
  }
  return byDocument;
}

/**
 * Every existing row that asserts something that was never a measurement.
 *
 * IDENTIFICATION ONLY. Nothing here decides to delete; the caller does, behind
 * its own flag, and prints every row first.
 */
function findArtifactRows(rows) {
  const out = [];
  for (const r of rows || []) {
    const a = classifyArtifact(r);
    if (!a) continue;
    out.push({
      id: r.id,
      document_id: r.document_id,
      document_title: r.document_title || null,
      test_name_raw: r.test_name_raw,
      value_raw: r.value_raw,
      verdict: r.verdict,
      source: r.source,
      judgement_origin: r.judgement_origin || null,
      created_at: r.created_at || null,
      kind: a.kind,
      confidence: a.confidence,
      why: a.why,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * Decide what the pass would write.
 *
 * @param {object} input
 * @param {string} input.tenantId
 * @param {string} input.runAt        ISO timestamp shared by every row this pass writes.
 * @param {Array}  input.judged       [{ document, verdicts }] — the engine's output per document.
 * @param {Array}  input.existingRows the tenant's current document_spec_checks rows.
 * @param {Array}  input.limits       the ConfiguredLimits the verdicts were produced from.
 * @param {Function} input.buildLimitSnapshot  injected from the shared bundle.
 * @param {Function} input.newId
 */
function buildPlan(input) {
  const {
    tenantId,
    runAt,
    judged = [],
    existingRows = [],
    limits = [],
    buildLimitSnapshot,
    registerIdentity,
    newId,
  } = input;

  const existing = indexExistingRows(existingRows);

  const rows = [];
  const skipped = [];
  const refused = [];
  const counts = {
    documents_examined: 0,
    documents_written: 0,
    rows_in_spec: 0,
    rows_out_of_spec: 0,
    rows_not_checked: 0,
    skipped_has_approval_rows: 0,
    skipped_already_backfilled: 0,
    skipped_no_verdicts: 0,
    refused_artifact_values: 0,
    dropped_repeated_identity: 0,
  };

  for (const item of judged) {
    const doc = item.document;
    counts.documents_examined += 1;

    const prior = existing.get(doc.id);
    if (prior) {
      // RULE 1 + 2. A document with rows already in the register is left alone
      // whole — not merged, not topped up. Merging would need a per-result
      // identity the table does not store (the engine's `specVerdictKey` is
      // never persisted), so a "top up" would guess, and guessing here writes
      // duplicate history.
      const approval = prior.origins.has('approval') || prior.origins.has('unrecorded');
      if (approval) counts.skipped_has_approval_rows += 1;
      else counts.skipped_already_backfilled += 1;
      skipped.push({
        document_id: doc.id,
        title: doc.title || null,
        reason: approval ? 'has_approval_rows' : 'already_backfilled',
        detail: approval
          ? `${prior.count} row(s) already written at approval — a real judgement, left untouched`
          : `${prior.count} row(s) from a previous pass (${[...prior.runs].join(', ') || 'unknown run'})`,
      });
      continue;
    }

    const verdicts = item.verdicts || [];
    if (verdicts.length === 0) {
      counts.skipped_no_verdicts += 1;
      skipped.push({
        document_id: doc.id,
        title: doc.title || null,
        reason: 'no_verdicts',
        detail:
          'nothing to judge — no extracted results, or no configured limit and no printed spec matched',
      });
      continue;
    }

    const docRows = [];
    // One row per place on the page per source (0105), the same rule the
    // approval writer applies. Identity, never value: two lots that print the
    // same number are two results and both are written.
    const seenIdentity = new Set();
    for (const v of verdicts) {
      const identity = registerIdentity ? registerIdentity(v) : null;
      if (identity) {
        const key = `${identity.result_key}::${v.source}`;
        if (seenIdentity.has(key)) {
          counts.dropped_repeated_identity += 1;
          continue;
        }
        seenIdentity.add(key);
      }
      // RULE 3, on the way in. A value that is a clock time or a date was never
      // a measurement, so a verdict about it — pass, fail or refusal — asserts
      // something that did not happen. It is counted and reported, never
      // written.
      const artifact = classifyArtifact(v);
      if (artifact && artifact.confidence === 'confident') {
        counts.refused_artifact_values += 1;
        refused.push({
          document_id: doc.id,
          title: doc.title || null,
          test: v.test_name_raw,
          value: v.value_raw,
          verdict: v.verdict,
          why: artifact.why,
        });
        continue;
      }
      docRows.push({
        id: newId(),
        tenant_id: tenantId,
        document_id: doc.id,
        // The version the metadata we judged belongs to. `documents` carries
        // one extended_metadata, which describes the CURRENT version, so that
        // is what the row names — not the 1 the approval path writes, which is
        // true only because approval happens at version 1.
        version_number: doc.current_version == null ? null : Number(doc.current_version),
        // NULL, and not resolvable honestly. The approval path knows its queue
        // item because it IS the approval; matching one back from a document
        // months later is the `external_ref = 'queue-' || id` join, which is a
        // different script's problem and would be a guess here.
        queue_item_id: null,
        spec_test_id: v.spec_test_id || null,
        test_name_raw: v.test_name_raw,
        value_raw: v.value_raw == null ? null : v.value_raw,
        value_num: v.value_num == null ? null : v.value_num,
        unit_raw: v.unit_raw == null ? null : v.unit_raw,
        verdict: v.verdict,
        reason: v.reason || null,
        source: v.source,
        limit_id: v.limit_id || null,
        limit_snapshot: buildLimitSnapshot(v, limits),
        judgement_origin: 'bulk_recheck',
        bulk_run_at: runAt,
        result_key: identity ? identity.result_key : null,
        result_location: identity ? identity.result_location : null,
      });
      if (v.verdict === 'in_spec') counts.rows_in_spec += 1;
      else if (v.verdict === 'out_of_spec') counts.rows_out_of_spec += 1;
      else counts.rows_not_checked += 1;
    }

    if (docRows.length === 0) {
      // Every verdict on this document was refused. Nothing is written, and the
      // document is not silently absent from the report.
      skipped.push({
        document_id: doc.id,
        title: doc.title || null,
        reason: 'all_values_refused',
        detail: 'every judged value on this document parses as a date or a clock time',
      });
      continue;
    }

    counts.documents_written += 1;
    rows.push(...docRows);
  }

  return { tenantId, runAt, rows, skipped, refused, counts };
}

/**
 * Render the plan as INSERT statements.
 *
 * ONE TABLE. Every statement this function can emit is an INSERT INTO
 * document_spec_checks; there is no UPDATE and no DELETE, so a plan cannot
 * modify a row that already exists even if the skip logic above were wrong.
 * `acknowledged_by`, `acknowledged_at`, `acknowledgement_note` and `notified_at`
 * are omitted entirely and therefore NULL: nobody approved this document with
 * this verdict in front of them, and nobody was told about it.
 */
function planToSql(plan, opts = {}) {
  // `withIdentity` is false only against a database that predates 0105; the
  // rows are then written exactly as they were before it, without a location.
  const withIdentity = opts.withIdentity !== false;
  const stmts = [];
  for (const r of plan.rows || []) {
    stmts.push(
      `INSERT INTO document_spec_checks\n` +
        `  (id, tenant_id, document_id, version_number, queue_item_id,\n` +
        `   spec_test_id, test_name_raw, value_raw, value_num, unit_raw,\n` +
        `   verdict, reason, source, limit_id, limit_snapshot,\n` +
        `   judgement_origin, bulk_run_at${withIdentity ? ', result_key, result_location' : ''})\n` +
        `VALUES (${sqlText(r.id)}, ${sqlText(r.tenant_id)}, ${sqlText(r.document_id)}, ` +
        `${sqlNum(r.version_number)}, NULL,\n` +
        `  ${sqlText(r.spec_test_id)}, ${sqlText(r.test_name_raw)}, ${sqlText(r.value_raw)}, ` +
        `${sqlNum(r.value_num)}, ${sqlText(r.unit_raw)},\n` +
        `  ${sqlText(r.verdict)}, ${sqlText(r.reason)}, ${sqlText(r.source)}, ` +
        `${sqlText(r.limit_id)}, ${sqlText(r.limit_snapshot)},\n` +
        `  ${sqlText(r.judgement_origin)}, ${sqlText(r.bulk_run_at)}` +
        (withIdentity ? `, ${sqlText(r.result_key)}, ${sqlText(r.result_location)}` : '') +
        `);`
    );
  }
  return stmts;
}

/**
 * The ONE audit row a pass writes, after the inserts.
 *
 * `user_id` is NULL on purpose: no person did this, and an audit trail that
 * named one would be the same falsehood migration 0103 exists to prevent. One
 * row for the whole pass, not one per document — a register that grew 4,000
 * audit rows would drown the log the auditors actually read.
 */
function auditSql(plan, extra = {}) {
  const details = JSON.stringify({
    run_at: plan.runAt,
    documents_written: plan.counts.documents_written,
    rows_written: plan.rows.length,
    in_spec: plan.counts.rows_in_spec,
    out_of_spec: plan.counts.rows_out_of_spec,
    not_checked: plan.counts.rows_not_checked,
    skipped: plan.skipped.length,
    refused_artifact_values: plan.counts.refused_artifact_values,
    ...extra,
  });
  return (
    `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details)\n` +
    `VALUES (NULL, ${sqlText(plan.tenantId)}, 'spec_register.backfill', 'document_spec_checks', ` +
    `${sqlText(plan.runAt)}, ${sqlText(details)});`
  );
}

/**
 * DELETE statements for artifact rows — only ever called from the explicit
 * prune flag, and only for rows the caller has already printed.
 *
 * Confident artifacts only. An ambiguous row is reported for a human and never
 * rendered here: `1:10` may be a dilution, and a register is not a place to
 * delete on a maybe.
 */
function pruneToSql(artifacts) {
  const ids = (artifacts || [])
    .filter((a) => a.confidence === 'confident')
    .map((a) => a.id);
  if (ids.length === 0) return [];
  const stmts = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    stmts.push(
      `DELETE FROM document_spec_checks WHERE id IN (${chunk.map(sqlText).join(', ')});`
    );
  }
  return stmts;
}

/** The audit row for a prune. Same shape, same NULL actor, different verb. */
function pruneAuditSql(tenantId, runAt, artifacts) {
  const removed = (artifacts || []).filter((a) => a.confidence === 'confident');
  const details = JSON.stringify({
    run_at: runAt,
    removed: removed.length,
    document_ids: [...new Set(removed.map((a) => a.document_id))].slice(0, 50),
    reason: 'values that parse as a date or clock time — not measurements',
  });
  return (
    `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details)\n` +
    `VALUES (NULL, ${sqlText(tenantId)}, 'spec_register.artifacts_pruned', 'document_spec_checks', ` +
    `${sqlText(runAt)}, ${sqlText(details)});`
  );
}

// ---------------------------------------------------------------------------
// Rows that LOOK like duplicates — and the few that are
// ---------------------------------------------------------------------------

/**
 * Everything a reader of the register can see about a result: two rows that
 * agree here are indistinguishable on the page. That makes them a duplicate
 * CANDIDATE and nothing more — five lots that each print "Coliform <10" agree
 * on every one of these columns and are five results.
 */
function visibleResultKey(r) {
  return JSON.stringify([
    r.test_name_raw == null ? null : String(r.test_name_raw),
    r.value_raw == null || r.value_raw === '' ? null : String(r.value_raw),
    r.unit_raw == null || r.unit_raw === '' ? null : String(r.unit_raw),
    r.source || null,
    r.limit_id || null,
    r.verdict || null,
  ]);
}

/**
 * Which row survives when a group has more rows than results. An ACKNOWLEDGED
 * row is kept ahead of an unacknowledged one whatever its age — deleting the
 * copy that carries a person's sign-off would destroy the one thing a duplicate
 * adds. Then the earliest, then the id, so the choice is deterministic.
 */
function keepOrder(a, b) {
  const ackA = a.acknowledged_at ? 0 : 1;
  const ackB = b.acknowledged_at ? 0 : 1;
  if (ackA !== ackB) return ackA - ackB;
  const ca = String(a.created_at || '');
  const cb = String(b.created_at || '');
  if (ca !== cb) return ca < cb ? -1 : 1;
  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
}

function countBy(items, keyOf) {
  const m = new Map();
  for (const it of items) {
    const k = keyOf(it);
    const list = m.get(k) || [];
    list.push(it);
    m.set(k, list);
  }
  return m;
}

/**
 * Decide which existing register rows are TRUE duplicates, and which rows can
 * be given the result identity 0105 introduced.
 *
 * THE PROBLEM IT HAS TO SOLVE HONESTLY. Before 0105 a row did not store where
 * on the page its result was printed, so "same test, value, unit, source,
 * limit and verdict on one document" is all a query can see — and on
 * production every one of the 53 groups that matched it was a multi-lot
 * crosstab or a two-batch COA, i.e. distinct results. A prune keyed on those
 * columns would have deleted 122 real lot results.
 *
 * So the identity is RECOVERED, never guessed:
 *
 *  - IDENTITY MODE. Every row of the document carries `result_key` (written
 *    after 0105). One (version, result_key, source) is one result; any more
 *    rows are surplus. No replay needed — the identity is the proof.
 *  - REPLAY MODE. The engine is re-run over the document's metadata (the
 *    caller does that and passes `replay`). A candidate group of N rows that
 *    the replay places at M distinct locations holds N − M surplus rows. The
 *    replay is trusted ONLY when it REPRODUCES the document: the same set of
 *    visible results, with every row count at least the replay's. A document
 *    whose metadata has been edited since, whose rows describe another
 *    version, or whose rows came from two separate writes is reported as
 *    unverifiable and nothing on it is touched.
 *
 * Stamping (the second output) assigns a replayed location to each row of a
 * reproduced document that has none. Only rows the BULK pass wrote: the replay
 * is literally the computation that produced them. An approval row was judged
 * from the values a reviewer submitted and in records mode under a
 * `record[N]` scope the document's own metadata does not carry, so a replayed
 * location would be a near-guess there, and it is left without one.
 *
 * @param {object} input
 * @param {Array}  input.existingRows  register rows (id, document_id, version_number,
 *   test_name_raw, value_raw, unit_raw, source, limit_id, verdict, judgement_origin,
 *   bulk_run_at, acknowledged_at, created_at, result_key?, document_title?)
 * @param {Map}    input.replay  document_id -> { current_version, verdicts }
 * @param {Function} input.registerIdentity  from the compiled shared/specSnapshot.ts
 */
function findDuplicateRows(input) {
  const { existingRows = [], replay = new Map(), registerIdentity } = input;
  const removals = [];
  const explained = [];
  const unverifiable = [];
  const stamps = [];
  const counts = {
    documents_with_candidates: 0,
    candidate_groups: 0,
    candidate_rows: 0,
    groups_distinct_results: 0,
    groups_with_surplus: 0,
    rows_to_remove: 0,
    documents_unverifiable: 0,
    rows_to_stamp: 0,
    stamp_skipped_approval_rows: 0,
  };

  for (const [documentId, rows] of countBy(existingRows, (r) => r.document_id)) {
    const title = rows[0].document_title || null;
    const candidates = [...countBy(rows, (r) => `${r.version_number ?? ''}|${visibleResultKey(r)}`)]
      .filter(([, g]) => g.length > 1);
    if (candidates.length > 0) {
      counts.documents_with_candidates += 1;
      counts.candidate_groups += candidates.length;
      counts.candidate_rows += candidates.reduce((n, [, g]) => n + g.length, 0);
    }

    // IDENTITY MODE.
    if (rows.every((r) => r.result_key)) {
      for (const [, g] of countBy(rows, (r) => `${r.version_number ?? ''}|${r.result_key}|${r.source}`)) {
        if (g.length < 2) continue;
        counts.groups_with_surplus += 1;
        const sorted = [...g].sort(keepOrder);
        for (const r of sorted.slice(1)) {
          removals.push(removalOf(r, title, sorted[0], 'identity', 1, g.length));
        }
      }
      for (const [, g] of candidates) {
        if (new Set(g.map((r) => r.result_key)).size === g.length) {
          counts.groups_distinct_results += 1;
          explained.push(explainedOf(documentId, title, g, g.map((r) => r.result_location || r.result_key)));
        }
      }
      continue;
    }

    // REPLAY MODE.
    const entry = replay.get(documentId);
    const notVerifiable = (reason) => {
      if (candidates.length === 0) return;
      counts.documents_unverifiable += 1;
      unverifiable.push({
        document_id: documentId,
        title,
        reason,
        groups: candidates.map(([, g]) => ({ ...visibleOf(g[0]), rows: g.length })),
      });
    };
    if (!entry) {
      notVerifiable('no_metadata');
      continue;
    }
    const writes = new Set(rows.map((r) => `${r.judgement_origin || ''}|${r.bulk_run_at || ''}`));
    if (writes.size > 1) {
      notVerifiable('mixed_writes');
      continue;
    }
    const current = entry.current_version == null ? null : Number(entry.current_version);
    if (rows.some((r) => r.version_number != null && current != null && Number(r.version_number) !== current)) {
      notVerifiable('other_version');
      continue;
    }

    const bulk = rows[0].judgement_origin === 'bulk_recheck';
    // What the producer would have WRITTEN, not merely what the engine said:
    // the bulk pass refuses date/clock values and drops a repeated identity, so
    // the replay does the same before it is compared.
    const seen = new Set();
    const replayed = [];
    for (const v of entry.verdicts || []) {
      if (bulk) {
        const artifact = classifyArtifact(v);
        if (artifact && artifact.confidence === 'confident') continue;
      }
      const id = registerIdentity(v);
      const k = `${id.result_key}::${v.source}`;
      if (seen.has(k)) continue;
      seen.add(k);
      replayed.push({ v, id });
    }

    const rowGroups = countBy(rows, (r) => visibleResultKey(r));
    const replayGroups = countBy(replayed, (x) => visibleResultKey(x.v));
    const sameKeys =
      rowGroups.size === replayGroups.size && [...rowGroups.keys()].every((k) => replayGroups.has(k));
    const reproduced =
      sameKeys && [...rowGroups].every(([k, g]) => g.length >= replayGroups.get(k).length);
    if (!reproduced) {
      notVerifiable('replay_differs');
      continue;
    }

    for (const [k, g] of rowGroups) {
      const locations = replayGroups.get(k);
      const sorted = [...g].sort(keepOrder);
      const kept = sorted.slice(0, locations.length);
      if (g.length > locations.length) {
        counts.groups_with_surplus += 1;
        for (const r of sorted.slice(locations.length)) {
          removals.push(removalOf(r, title, kept[0], 'replay', locations.length, g.length));
        }
      } else if (g.length > 1) {
        counts.groups_distinct_results += 1;
        explained.push(explainedOf(documentId, title, g, locations.map((x) => x.id.result_location)));
      }

      const unstamped = kept.filter((r) => !r.result_key);
      if (unstamped.length === 0) continue;
      if (!bulk) {
        counts.stamp_skipped_approval_rows += unstamped.length;
        continue;
      }
      const byId = [...kept].sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
      const byKey = [...locations].sort((a, b) => (a.id.result_key < b.id.result_key ? -1 : 1));
      byId.forEach((r, i) => {
        if (r.result_key) return;
        stamps.push({
          id: r.id,
          document_id: documentId,
          result_key: byKey[i].id.result_key,
          result_location: byKey[i].id.result_location,
        });
      });
    }
  }

  counts.rows_to_remove = removals.length;
  counts.rows_to_stamp = stamps.length;
  return { removals, explained, unverifiable, stamps, counts };
}

function visibleOf(r) {
  return {
    test_name_raw: r.test_name_raw,
    value_raw: r.value_raw,
    unit_raw: r.unit_raw || null,
    source: r.source,
    verdict: r.verdict,
  };
}

function removalOf(r, title, keeper, basis, results, rows) {
  return {
    id: r.id,
    document_id: r.document_id,
    title,
    ...visibleOf(r),
    judgement_origin: r.judgement_origin || null,
    created_at: r.created_at || null,
    acknowledged: !!r.acknowledged_at,
    kept_id: keeper.id,
    basis,
    results,
    rows,
  };
}

function explainedOf(documentId, title, g, locations) {
  return { document_id: documentId, title, ...visibleOf(g[0]), rows: g.length, locations };
}

/** DELETEs for the surplus rows — only ever rendered under the explicit flag. */
function duplicatesPruneToSql(removals) {
  const ids = (removals || []).map((r) => r.id);
  const stmts = [];
  for (let i = 0; i < ids.length; i += 50) {
    stmts.push(
      `DELETE FROM document_spec_checks WHERE id IN (${ids.slice(i, i + 50).map(sqlText).join(', ')});`
    );
  }
  return stmts;
}

function duplicatesAuditSql(tenantId, runAt, removals) {
  const details = JSON.stringify({
    run_at: runAt,
    removed: removals.length,
    kept_ids: [...new Set(removals.map((r) => r.kept_id))].slice(0, 50),
    document_ids: [...new Set(removals.map((r) => r.document_id))].slice(0, 50),
    reason: 'the same result registered more than once — identity recovered by result_key or engine replay',
  });
  return (
    `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details)\n` +
    `VALUES (NULL, ${sqlText(tenantId)}, 'spec_register.duplicates_pruned', 'document_spec_checks', ` +
    `${sqlText(runAt)}, ${sqlText(details)});`
  );
}

/**
 * UPDATEs that give a row its location. Guarded by `result_key IS NULL`, so a
 * row that already names its result is never renamed, and a re-run is a no-op.
 */
function stampToSql(stamps) {
  return (stamps || []).map(
    (s) =>
      `UPDATE document_spec_checks SET result_key = ${sqlText(s.result_key)}, ` +
      `result_location = ${sqlText(s.result_location)} ` +
      `WHERE id = ${sqlText(s.id)} AND result_key IS NULL;`
  );
}

function stampAuditSql(tenantId, runAt, stamps) {
  const details = JSON.stringify({
    run_at: runAt,
    stamped: stamps.length,
    document_ids: [...new Set(stamps.map((s) => s.document_id))].slice(0, 50),
    reason: 'result identity (0105) recovered by replaying the engine that wrote these rows',
  });
  return (
    `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details)\n` +
    `VALUES (NULL, ${sqlText(tenantId)}, 'spec_register.identity_stamped', 'document_spec_checks', ` +
    `${sqlText(runAt)}, ${sqlText(details)});`
  );
}

function formatDuplicates(report, opts = {}) {
  const c = report.counts;
  const out = [];
  const listLimit = opts.listLimit || 200;
  out.push('Rows that look like duplicates ........ ' + c.candidate_rows +
    ` in ${c.candidate_groups} group(s) on ${c.documents_with_candidates} document(s)`);
  out.push('-'.repeat(72));
  out.push('  Same document, test, value, unit, source, limit and verdict. That is all the');
  out.push('  page shows, and it is NOT proof of a duplicate: a multi-lot certificate prints');
  out.push('  the same "<10" once per lot. Each group was checked against where the engine');
  out.push('  actually finds its results.');
  out.push('');
  out.push(`  Distinct results (kept, nothing to do) ... ${c.groups_distinct_results} group(s)`);
  for (const e of report.explained.slice(0, opts.explainedLimit || 10)) {
    out.push(`    ${e.title || e.document_id} · ${e.test_name_raw} = ${JSON.stringify(e.value_raw)} ` +
      `[${e.verdict}] × ${e.rows}: ${e.locations.join('; ')}`);
  }
  if (report.explained.length > (opts.explainedLimit || 10)) {
    out.push(`    … and ${report.explained.length - (opts.explainedLimit || 10)} more.`);
  }
  out.push(`  Could not be verified (never touched) ... ${c.documents_unverifiable} document(s)`);
  const reasons = {
    no_metadata: 'no extracted metadata to replay',
    mixed_writes: 'rows from more than one write',
    other_version: 'rows describe a different version than the metadata',
    replay_differs: 'the engine no longer reproduces these rows (metadata or limits changed)',
  };
  for (const u of report.unverifiable.slice(0, 20)) {
    out.push(`    ${u.title || u.document_id} — ${reasons[u.reason] || u.reason}`);
  }
  out.push(`  TRUE duplicates to remove ............... ${c.rows_to_remove} row(s)`);
  for (const r of report.removals.slice(0, listLimit)) {
    out.push(`    ${r.title || r.document_id} · ${r.test_name_raw} = ${JSON.stringify(r.value_raw)} [${r.verdict}]` +
      ` — ${r.rows} rows for ${r.results} result(s), by ${r.basis}`);
    out.push(`        delete row ${r.id} (${r.judgement_origin || 'origin unrecorded'}, ${r.created_at || '?'}` +
      `${r.acknowledged ? ', acknowledged' : ''}); keep ${r.kept_id}`);
  }
  if (report.removals.length > listLimit) out.push(`    … and ${report.removals.length - listLimit} more.`);
  out.push('');
  return out;
}

/** Split statements into batches small enough for one `wrangler d1 execute`. */
function batchStatements(statements, opts = {}) {
  const maxCount = opts.maxCount || 200;
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

// ---------------------------------------------------------------------------
// Prose
// ---------------------------------------------------------------------------

function formatPlan(plan, opts = {}) {
  const c = plan.counts;
  const out = [];
  out.push('');
  out.push(`Spec register backfill — ${opts.targetLabel || plan.tenantId}`);
  out.push('='.repeat(72));
  out.push(`Run stamp ................ ${plan.runAt}`);
  out.push(`Documents examined ....... ${c.documents_examined}`);
  out.push(`Documents to write ....... ${c.documents_written}`);
  out.push(`Register rows to write ... ${plan.rows.length}`);
  out.push('');
  out.push(`  IN SPEC ................ ${c.rows_in_spec}`);
  out.push(`  OUT OF SPEC ............ ${c.rows_out_of_spec}`);
  out.push(`  COULD NOT BE JUDGED .... ${c.rows_not_checked}`);
  if (opts.capped) {
    out.push('');
    out.push(`NOTE: capped at --limit ${opts.capped}; more documents were not examined.`);
  }
  out.push('');

  const skippedBy = new Map();
  for (const s of plan.skipped) {
    const list = skippedBy.get(s.reason) || [];
    list.push(s);
    skippedBy.set(s.reason, list);
  }
  if (plan.skipped.length > 0) {
    out.push(`Skipped .................. ${plan.skipped.length} document(s)`);
    out.push('-'.repeat(72));
    const labels = {
      has_approval_rows:
        'already judged AT APPROVAL — a person saw these results. Never overwritten.',
      already_backfilled: 'already written by an earlier pass of this script.',
      no_verdicts: 'nothing to judge: no extracted results, or nothing matched a limit.',
      all_values_refused: 'every value on the document parses as a date or a clock time.',
    };
    for (const [reason, list] of skippedBy) {
      out.push(`  ${list.length} × ${labels[reason] || reason}`);
      for (const s of list.slice(0, 10)) {
        out.push(`      ${s.title || s.document_id} — ${s.detail}`);
      }
      if (list.length > 10) out.push(`      … and ${list.length - 10} more.`);
    }
    out.push('');
  }

  if (plan.refused.length > 0) {
    out.push(`Values refused ........... ${plan.refused.length}`);
    out.push('-'.repeat(72));
    out.push('  A date is not a measurement. These were judged by the engine and are NOT');
    out.push('  being written to the register.');
    for (const r of plan.refused.slice(0, 25)) {
      out.push(`    ${r.title || r.document_id} · ${r.test}: ${r.why}`);
    }
    if (plan.refused.length > 25) out.push(`    … and ${plan.refused.length - 25} more.`);
    out.push('');
  }

  return out;
}

/** The artifact report — printed on every run, acted on only under the flag. */
function formatArtifacts(artifacts, opts = {}) {
  const out = [];
  const confident = artifacts.filter((a) => a.confidence === 'confident');
  const ambiguous = artifacts.filter((a) => a.confidence !== 'confident');
  if (artifacts.length === 0) return out;

  out.push(`Artifact rows already in the register ... ${artifacts.length}`);
  out.push('-'.repeat(72));
  out.push('  Rows whose stored value is a date or a clock time. They came from a table');
  out.push('  that was read as a results crosstab and never was one (an incubation log:');
  out.push('  Date In / Time In / Date Out / Time Out). Each asserts a verdict about');
  out.push('  something that was never measured.');
  out.push('');
  for (const a of confident.slice(0, opts.listLimit || 60)) {
    out.push(
      `    ${a.document_title || a.document_id} · ${a.test_name_raw} = ` +
        `${JSON.stringify(a.value_raw)} [${a.verdict}] — ${a.why}`
    );
    out.push(`        row ${a.id}, written ${a.created_at || '?'} (${a.judgement_origin || 'origin unrecorded'})`);
  }
  if (confident.length > (opts.listLimit || 60)) {
    out.push(`    … and ${confident.length - (opts.listLimit || 60)} more.`);
  }
  if (ambiguous.length > 0) {
    out.push('');
    out.push(`  ${ambiguous.length} further row(s) look like a time but could be something else`);
    out.push('  (a dilution "1:10" reads the same). NEVER pruned by this script — a human');
    out.push('  decides those:');
    for (const a of ambiguous.slice(0, 20)) {
      out.push(`    ${a.document_title || a.document_id} · ${a.test_name_raw} = ${JSON.stringify(a.value_raw)} — ${a.why}`);
    }
    if (ambiguous.length > 20) out.push(`    … and ${ambiguous.length - 20} more.`);
  }
  out.push('');
  return out;
}

module.exports = {
  sqlText,
  sqlNum,
  looksLikeClockTime,
  looksLikeDate,
  looksLikeDateOrTimeName,
  classifyArtifact,
  indexExistingRows,
  findArtifactRows,
  buildPlan,
  planToSql,
  auditSql,
  pruneToSql,
  pruneAuditSql,
  visibleResultKey,
  findDuplicateRows,
  duplicatesPruneToSql,
  duplicatesAuditSql,
  stampToSql,
  stampAuditSql,
  formatDuplicates,
  batchStatements,
  formatPlan,
  formatArtifacts,
};
