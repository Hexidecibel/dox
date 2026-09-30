/**
 * bin/lib/duplicateArchivePlan.js — the deciding half of
 * `bin/archive-duplicate-documents`.
 *
 * `bin/audit-duplicate-documents` groups live documents that are the same file
 * approved from different arrivals and marks the earliest arrival `first` and
 * every later one `later copy`. This file decides, per later copy, whether it
 * can be ARCHIVED (documents.status = 'archived' -- never a delete, never a
 * byte touched) without anything a person relies on disappearing with it.
 *
 * THE RULE
 *
 * A later copy is archived only when everything hanging off it is either
 * already present on a kept (first-arrival) copy, or can be moved to the kept
 * copy by a re-point that asserts nothing new. Anything else SKIPS the copy
 * with the reason, and the copy stays exactly as it is:
 *
 *   covered (compared by CONTENT, not by count -- two extractions of one file
 *   can disagree, and that disagreement is the thing a person must see):
 *     confirmed requirement links, confirmed claims, lots, products, spec
 *     register results (source + test + value + unit -> the same verdict, and
 *     an acknowledgement on the copy must exist on the kept row too), spec
 *     gaps, a renewal decision
 *   re-pointed (safe: a ledger or an open proposal, no human decision moves):
 *     intake_duplicates.matched_document_id  ("received again" ledger)
 *     a PENDING lot-match suggestion the kept copy lacks for that order line,
 *       when its lot is linked to the kept copy
 *   always a skip (a person or a recipient is pointing at THIS copy):
 *     an order line's coa_document_id, an accepted suggestion, a bundle, a
 *     supplier-portal arrival / claim decision / accepted request line, a live
 *     alert link or export link, a note
 *
 * Left alone and reported, never a blocker: suggested (unconfirmed) links,
 * rejected suggestions, a pending suggestion the kept copy already has for the
 * same order line, and `lots.production_date_document_id` (provenance -- the
 * archived copy still exists and still said what it said).
 *
 * SQL strings out, rows in, plan out. No D1, no clock.
 */

'use strict';

const IN_CHUNK = 80;

function q(v) {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}
const inList = (ids) => ids.map(q).join(', ');

/** Evidence statements for a chunk of document ids. Each returns document_id-keyed rows. */
function evidenceSql(ids) {
  const l = inList(ids);
  return {
    docs: `SELECT id AS document_id, tenant_id, status, renewal_decision, renewal_due_date FROM documents WHERE id IN (${l})`,
    requirements: `SELECT document_id, requirement_id, status FROM document_requirements WHERE document_id IN (${l})`,
    claims: `SELECT document_id, claim_type_id, subject_type, COALESCE(subject_id, '') AS subject_id, status FROM document_claims WHERE document_id IN (${l})`,
    lots: `SELECT document_id, lot_id FROM document_lots WHERE document_id IN (${l})`,
    products: `SELECT document_id, product_id FROM document_products WHERE document_id IN (${l})`,
    spec: `SELECT document_id, source, lower(trim(test_name_raw)) AS test, COALESCE(value_raw, '') AS value, COALESCE(unit_raw, '') AS unit, verdict, acknowledged_at FROM document_spec_checks WHERE document_id IN (${l})`,
    gaps: `SELECT document_id, kind, lower(trim(test_name_raw)) AS test FROM document_spec_gaps WHERE document_id IN (${l})`,
    orderLines: `SELECT coa_document_id AS document_id, id FROM order_items WHERE coa_document_id IN (${l})`,
    suggestions: `SELECT document_id, id, order_item_id, lot_id, status FROM lot_match_suggestions WHERE document_id IN (${l})`,
    bundles: `SELECT document_id, bundle_id FROM document_bundle_items WHERE document_id IN (${l})`,
    arrivals: `SELECT document_id, id FROM request_uploads WHERE document_id IN (${l})`,
    claimDecisions: `SELECT decision_document_id AS document_id, id FROM request_upload_lines WHERE decision_document_id IN (${l})`,
    acceptedLines: `SELECT accepted_document_id AS document_id, id FROM request_lines WHERE accepted_document_id IN (${l})`,
    alertLinks: `SELECT document_id, id FROM alert_links WHERE document_id IN (${l}) AND revoked_at IS NULL AND expires_at > datetime('now')`,
    notes: `SELECT entity_id AS document_id, id FROM entity_notes WHERE entity_type = 'document' AND deleted_at IS NULL AND entity_id IN (${l})`,
    intakeDuplicates: `SELECT matched_document_id AS document_id, id FROM intake_duplicates WHERE matched_document_id IN (${l})`,
    productionDateSource: `SELECT production_date_document_id AS document_id, id FROM lots WHERE production_date_document_id IN (${l})`,
  };
}

/** Live export links: the document list is JSON, so it is matched in code. */
const LIVE_EXPORT_LINKS_SQL =
  "SELECT id, document_ids FROM document_export_links WHERE revoked_at IS NULL AND expires_at > datetime('now')";

function chunk(items, size = IN_CHUNK) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Fold raw evidence rows into one record per document. */
function buildEvidence(rowsByKind, exportLinks) {
  const ev = new Map();
  const get = (id) => {
    if (!ev.has(id)) {
      ev.set(id, {
        status: null,
        renewal_decision: null,
        requirements: new Set(),
        claims: new Set(),
        lots: new Set(),
        products: new Set(),
        spec: new Map(),
        gaps: new Set(),
        orderLines: [],
        suggestions: [],
        bundles: [],
        arrivals: [],
        claimDecisions: [],
        acceptedLines: [],
        alertLinks: [],
        exportLinks: [],
        notes: [],
        intakeDuplicates: [],
        productionDateSource: [],
      });
    }
    return ev.get(id);
  };
  for (const r of rowsByKind.docs || []) {
    const e = get(r.document_id);
    e.status = r.status;
    e.renewal_decision = r.renewal_decision || null;
  }
  for (const r of rowsByKind.requirements || []) if (r.status === 'confirmed') get(r.document_id).requirements.add(r.requirement_id);
  for (const r of rowsByKind.claims || []) {
    if (r.status === 'confirmed') get(r.document_id).claims.add(`${r.claim_type_id}|${r.subject_type}|${r.subject_id}`);
  }
  for (const r of rowsByKind.lots || []) get(r.document_id).lots.add(r.lot_id);
  for (const r of rowsByKind.products || []) get(r.document_id).products.add(r.product_id);
  for (const r of rowsByKind.spec || []) {
    const key = `${r.source}|${r.test}|${r.value}|${r.unit}`;
    const e = get(r.document_id);
    const prev = e.spec.get(key);
    // A repeated key (a crosstab printing the same result twice) keeps the
    // strongest facts: any acknowledgement, and every verdict seen.
    const verdicts = new Set(prev ? prev.verdicts : []);
    verdicts.add(r.verdict);
    e.spec.set(key, { verdicts, acknowledged: Boolean((prev && prev.acknowledged) || r.acknowledged_at) });
  }
  for (const r of rowsByKind.gaps || []) get(r.document_id).gaps.add(`${r.kind}|${r.test}`);
  for (const k of ['orderLines', 'bundles', 'arrivals', 'claimDecisions', 'acceptedLines', 'alertLinks', 'notes', 'intakeDuplicates', 'productionDateSource']) {
    for (const r of rowsByKind[k] || []) get(r.document_id)[k].push(r.id || r.bundle_id);
  }
  for (const r of rowsByKind.suggestions || []) {
    get(r.document_id).suggestions.push({ id: r.id, order_item_id: r.order_item_id, lot_id: r.lot_id, status: r.status });
  }
  for (const link of exportLinks || []) {
    let ids = [];
    try {
      ids = JSON.parse(link.document_ids);
    } catch {
      ids = [];
    }
    for (const id of Array.isArray(ids) ? ids : []) if (ev.has(id)) ev.get(id).exportLinks.push(link.id);
  }
  return ev;
}

const BLOCKERS = {
  not_active: 'the copy is not active (already archived or deleted)',
  requirement: 'a confirmed requirement link the kept copy does not have',
  claim: 'a confirmed claim the kept copy does not have',
  lot: 'a lot the kept copy is not linked to',
  product: 'a product the kept copy is not linked to',
  spec_missing: 'a spec register result the kept copy does not have',
  spec_verdict: 'a spec result the kept copy judged differently',
  spec_ack: 'an acknowledged spec result whose kept-copy row is not acknowledged',
  gap: 'a spec gap the kept copy does not have',
  renewal: 'a renewal decision recorded on this copy only',
  order_line: 'an order line names this copy as its COA',
  suggestion_decided: 'an accepted lot-match suggestion on this copy',
  suggestion_lot: 'a pending lot-match suggestion whose lot the kept copy lacks',
  bundle: 'it is in a bundle',
  arrival: 'a supplier-portal arrival resolved to this copy',
  claim_decision: 'a supplier-portal claim decision names this copy',
  accepted_line: 'a request line stands accepted on this copy',
  alert_link: 'a live alert link points at this copy',
  export_link: 'a live export link sent this copy',
  note: 'a note was written on this copy',
};

/** Compare one later copy against the union of the kept copies. */
function judgeCopy(copyId, keptIds, ev) {
  const c = ev.get(copyId);
  const kept = keptIds.map((id) => ev.get(id)).filter(Boolean);
  const reasons = [];
  const add = (key, detail) => reasons.push({ key, detail });
  if (!c || c.status !== 'active') {
    add('not_active', c ? c.status : 'missing');
    return { reasons, repoints: null };
  }
  const union = (field) => new Set(kept.flatMap((k) => [...k[field]]));
  const missing = (field) => [...c[field]].filter((x) => !union(field).has(x));

  for (const x of missing('requirements')) add('requirement', x);
  for (const x of missing('claims')) add('claim', x);
  for (const x of missing('lots')) add('lot', x);
  for (const x of missing('products')) add('product', x);
  for (const x of missing('gaps')) add('gap', x);

  const keptSpec = new Map();
  for (const k of kept) {
    for (const [key, v] of k.spec) {
      const prev = keptSpec.get(key);
      keptSpec.set(key, {
        verdicts: new Set([...(prev ? prev.verdicts : []), ...v.verdicts]),
        acknowledged: Boolean((prev && prev.acknowledged) || v.acknowledged),
      });
    }
  }
  for (const [key, v] of c.spec) {
    const k = keptSpec.get(key);
    if (!k) add('spec_missing', key);
    else if ([...v.verdicts].some((x) => !k.verdicts.has(x))) add('spec_verdict', key);
    else if (v.acknowledged && !k.acknowledged) add('spec_ack', key);
  }

  if (c.renewal_decision && !kept.some((k) => k.renewal_decision)) add('renewal', c.renewal_decision);

  const listBlockers = [
    ['orderLines', 'order_line'],
    ['bundles', 'bundle'],
    ['arrivals', 'arrival'],
    ['claimDecisions', 'claim_decision'],
    ['acceptedLines', 'accepted_line'],
    ['alertLinks', 'alert_link'],
    ['exportLinks', 'export_link'],
    ['notes', 'note'],
  ];
  for (const [field, key] of listBlockers) for (const x of c[field]) add(key, x);

  // Choose the kept copy to point things at: the one holding every lot this
  // copy has (so a moved suggestion's lot is linked to it), else the first.
  const target =
    keptIds.find((id) => {
      const k = ev.get(id);
      return k && [...c.lots].every((l) => k.lots.has(l));
    }) || keptIds[0];
  const targetEv = ev.get(target);

  const repointSuggestions = [];
  const leftSuggestions = [];
  const keptSuggestionItems = new Set(kept.flatMap((k) => k.suggestions.map((s) => s.order_item_id)));
  for (const s of c.suggestions) {
    if (s.status === 'accepted') {
      add('suggestion_decided', s.id);
    } else if (s.status !== 'pending' || keptSuggestionItems.has(s.order_item_id)) {
      leftSuggestions.push(s.id);
    } else if (s.lot_id && !(targetEv && targetEv.lots.has(s.lot_id))) {
      add('suggestion_lot', s.id);
    } else {
      repointSuggestions.push(s.id);
    }
  }

  return {
    reasons,
    target,
    repoints: {
      intake_duplicates: [...c.intakeDuplicates],
      lot_match_suggestions: repointSuggestions,
    },
    left_alone: {
      suggestions: leftSuggestions,
      production_date_source_lots: [...c.productionDateSource],
    },
  };
}

/**
 * @param report   the object bin/lib/duplicateDocumentsAudit.buildReport returns
 * @param ev       buildEvidence(...) over every document in report.groups
 */
function planArchive(report, ev) {
  const archive = [];
  const skip = [];
  report.groups.forEach((g, gi) => {
    const keptIds = g.documents.filter((d) => d.role === 'first').map((d) => d.document_id);
    for (const d of g.documents.filter((x) => x.role === 'later_copy')) {
      const j = judgeCopy(d.document_id, keptIds, ev);
      const entry = {
        group: gi + 1,
        tenant_id: g.tenant_id,
        document_id: d.document_id,
        title: d.title,
        approved_at: d.approved_at,
        kept_document_ids: keptIds,
        kept_document_id: j.target || keptIds[0],
        checksums: g.checksums,
        same_title: g.same_title,
      };
      if (j.reasons.length) skip.push({ ...entry, reasons: j.reasons });
      else archive.push({ ...entry, repoints: j.repoints, left_alone: j.left_alone });
    }
  });
  const reasonCounts = {};
  for (const s of skip) for (const k of new Set(s.reasons.map((r) => r.key))) reasonCounts[k] = (reasonCounts[k] || 0) + 1;
  return {
    archive,
    skip,
    summary: {
      later_copies: archive.length + skip.length,
      archive: archive.length,
      archive_with_repoint: archive.filter((a) => a.repoints.intake_duplicates.length + a.repoints.lot_match_suggestions.length > 0).length,
      repoint_intake_duplicates: archive.reduce((n, a) => n + a.repoints.intake_duplicates.length, 0),
      repoint_lot_match_suggestions: archive.reduce((n, a) => n + a.repoints.lot_match_suggestions.length, 0),
      skip: skip.length,
      skip_reasons: reasonCounts,
    },
  };
}

/**
 * The SQL for one archived copy. Every statement is guarded by the state the
 * plan read, so a copy that changed since the dry run is simply not touched.
 */
function archiveToSql(a, runAt) {
  const s = [];
  for (const id of a.repoints.lot_match_suggestions) {
    s.push(
      `UPDATE lot_match_suggestions SET document_id = ${q(a.kept_document_id)}
        WHERE id = ${q(id)} AND document_id = ${q(a.document_id)} AND status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM lot_match_suggestions x
                           WHERE x.order_item_id = lot_match_suggestions.order_item_id
                             AND x.document_id = ${q(a.kept_document_id)});`,
    );
  }
  if (a.repoints.intake_duplicates.length) {
    s.push(
      `UPDATE intake_duplicates SET matched_document_id = ${q(a.kept_document_id)}
        WHERE matched_document_id = ${q(a.document_id)} AND id IN (${inList(a.repoints.intake_duplicates)});`,
    );
  }
  const details = {
    reason: 'duplicate_file',
    kept_document_id: a.kept_document_id,
    kept_document_ids: a.kept_document_ids,
    checksums: a.checksums,
    repointed: a.repoints,
    left_pointing_at_archived_copy: a.left_alone,
    tool: 'bin/archive-duplicate-documents',
    run_at: runAt,
  };
  // Audit BEFORE the status change, guarded by the same condition the update
  // uses: a copy archived (or deleted) by anyone else since the dry run gets
  // neither the audit row nor the update.
  s.push(
    `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details)
     SELECT NULL, ${q(a.tenant_id)}, 'document.archived_as_duplicate', 'document', ${q(a.document_id)}, ${q(JSON.stringify(details))}
      WHERE EXISTS (SELECT 1 FROM documents WHERE id = ${q(a.document_id)} AND tenant_id = ${q(a.tenant_id)} AND status = 'active');`,
  );
  s.push(
    `UPDATE documents SET status = 'archived', updated_at = datetime('now')
      WHERE id = ${q(a.document_id)} AND tenant_id = ${q(a.tenant_id)} AND status = 'active';`,
  );
  return s;
}

function renderPlan(plan) {
  const out = [];
  if (plan.archive.length) {
    out.push('ARCHIVE (everything on the copy is on the kept copy, or moves to it)');
    for (const a of plan.archive) {
      const rp = [];
      if (a.repoints.lot_match_suggestions.length) rp.push(`re-point ${a.repoints.lot_match_suggestions.length} pending suggestion(s)`);
      if (a.repoints.intake_duplicates.length) rp.push(`re-point ${a.repoints.intake_duplicates.length} received-again row(s)`);
      if (a.left_alone.suggestions.length) rp.push(`${a.left_alone.suggestions.length} suggestion(s) left (kept copy has its own / rejected)`);
      if (a.left_alone.production_date_source_lots.length) rp.push(`${a.left_alone.production_date_source_lots.length} lot date(s) keep this copy as provenance`);
      out.push(`  g${a.group}  ${a.title}  (${a.document_id})  -> keep ${a.kept_document_id}${rp.length ? `  [${rp.join('; ')}]` : ''}`);
    }
    out.push('');
  }
  if (plan.skip.length) {
    out.push('SKIP (left active; a person decides)');
    for (const s of plan.skip) {
      const why = [...new Set(s.reasons.map((r) => r.key))]
        .map((k) => `${BLOCKERS[k]} (${s.reasons.filter((r) => r.key === k).length})`)
        .join('; ');
      out.push(`  g${s.group}  ${s.title}  (${s.document_id})  first ${s.kept_document_ids.join(',')}`);
      out.push(`        ${why}`);
    }
    out.push('');
  }
  const m = plan.summary;
  out.push('Summary');
  out.push(`  later copies                  ${m.later_copies}`);
  out.push(`  archive                       ${m.archive}  (${m.archive_with_repoint} with a re-point: ${m.repoint_lot_match_suggestions} suggestion(s), ${m.repoint_intake_duplicates} received-again row(s))`);
  out.push(`  skip                          ${m.skip}`);
  for (const [k, n] of Object.entries(m.skip_reasons).sort((x, y) => y[1] - x[1])) {
    out.push(`      ${String(n).padStart(3)}  ${BLOCKERS[k]}`);
  }
  return out.join('\n');
}

module.exports = {
  evidenceSql,
  LIVE_EXPORT_LINKS_SQL,
  chunk,
  buildEvidence,
  judgeCopy,
  planArchive,
  archiveToSql,
  renderPlan,
  BLOCKERS,
};
