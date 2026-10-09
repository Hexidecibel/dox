// The plan behind bin/propose-spec-holds: which EXISTING documents would have
// been put on hold at approval, had holds existed then (migration 0139).
// Pure -- no D1, no clock -- so tests/unit/specHoldsPlan.test.ts can pin it.
//
// The rule is NOT repeated here. It is the compiled mirror of shared/holds.ts
// (rebuild with `npm run build:worker-shared`), the same function the approval
// path calls. This file only decides which stored register rows are honest
// evidence for it:
//
//   - APPROVAL-TIME ROWS ONLY. A row the bulk recheck wrote
//     (`judgement_origin = 'bulk_recheck'`) is a script's arithmetic over old
//     certificates and never places a hold. A row with no origin recorded
//     (written before migration 0103) cannot be told apart from one, so it is
//     reported and skipped.
//   - THE DOCUMENT'S CURRENT VERSION ONLY. A hold is on the document. A failing
//     result on version 1 says nothing about the file that replaced it.
//   - ACTIVE DOCUMENTS ONLY.
//   - A ROW WITH A RESULT IDENTITY (`result_key`, migration 0105). Without one
//     the hold could not be keyed to its result, and a second run could not
//     tell that it had already placed it.
//
// WHAT IS FROZEN AND WHAT IS NOT. The limit's criticality and the
// could-not-check category are read from the row's own `limit_snapshot`: what
// they were when the result was judged. The analyte's category is NOT in the
// snapshot, so it is read from `spec_tests` as it stands today; a zero-tolerance
// proposal says so.

const { automaticHoldsForResults, holdSourceKey, holdLotLabel } = require('./shared/holds.js');

function parseSnapshot(raw) {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/**
 * @param {Array<object>} checks  document_spec_checks rows joined to their document and analyte
 * @param {Array<{document_id: string, source: string, source_key: string, released_at: string|null}>} existingHolds
 * @param {Array<{document_id: string, lot_id: string, lot_number: string, sub_lot_code: string|null}>} documentLots
 */
function planSpecHolds(checks, existingHolds, documentLots) {
  const skipped = { bulk_recheck: 0, origin_not_recorded: 0, superseded_version: 0, document_not_active: 0, no_result_identity: 0 };
  const already = new Set(existingHolds.filter((h) => h.source_key).map((h) => `${h.document_id}|${h.source}|${h.source_key}`));
  const lotsByDoc = new Map();
  for (const l of documentLots) {
    const list = lotsByDoc.get(l.document_id) || [];
    list.push(l);
    lotsByDoc.set(l.document_id, list);
  }

  const byDoc = new Map();
  let considered = 0;
  for (const c of checks) {
    if (c.judgement_origin === 'bulk_recheck') { skipped.bulk_recheck++; continue; }
    if (c.judgement_origin !== 'approval') { skipped.origin_not_recorded++; continue; }
    if (c.document_status !== 'active') { skipped.document_not_active++; continue; }
    const version = Number(c.version_number) || 1;
    if (version !== (Number(c.current_version) || 1)) { skipped.superseded_version++; continue; }
    if (!c.result_key) { skipped.no_result_identity++; continue; }
    considered++;
    const snap = parseSnapshot(c.limit_snapshot);
    const entry = byDoc.get(c.document_id) || { document_id: c.document_id, title: c.document_title, supplier_name: c.supplier_name || null, version, results: [] };
    entry.results.push({
      verdict: c.verdict,
      source: c.source,
      criticality: typeof snap.criticality === 'string' ? snap.criticality : null,
      not_checked_category: typeof snap.not_checked_category === 'string' ? snap.not_checked_category : null,
      analyte_category: c.analyte_category || null,
      result_key: c.result_key,
      result_location: c.result_location || null,
      test_name_raw: c.test_name_raw || '',
      value_raw: c.value_raw,
      unit_raw: c.unit_raw,
      limit_text: typeof snap.text === 'string' ? snap.text : typeof snap.printed === 'string' ? snap.printed : null,
      reason: c.reason,
      spec_check_id: c.id,
    });
    byDoc.set(c.document_id, entry);
  }

  const proposals = [];
  let alreadyPlaced = 0;
  for (const doc of byDoc.values()) {
    // The hold goes on the document's ONE lot row; with none, or several, it
    // is on the whole certificate. The approval path's own rule.
    const lots = lotsByDoc.get(doc.document_id) || [];
    const lot = lots.length === 1 ? lots[0] : null;
    for (const p of automaticHoldsForResults(doc.results, { origin: 'approval', version: doc.version })) {
      if (already.has(`${doc.document_id}|${p.source}|${p.source_key}`)) { alreadyPlaced++; continue; }
      const from = doc.results.find((r) => holdSourceKey(doc.version, r.source, r.result_key) === p.source_key);
      proposals.push({
        document_id: doc.document_id,
        title: doc.title,
        supplier_name: doc.supplier_name,
        version: doc.version,
        lot_id: lot ? lot.lot_id : null,
        lot_label: lot ? holdLotLabel(lot) : null,
        source: p.source,
        source_key: p.source_key,
        reason: p.reason,
        detail: p.detail,
        spec_check_id: from ? from.spec_check_id : null,
      });
    }
  }
  proposals.sort((a, b) => String(a.title).localeCompare(String(b.title)) || a.source_key.localeCompare(b.source_key));
  return {
    rows_read: checks.length,
    rows_considered: considered,
    skipped,
    already_placed: alreadyPlaced,
    proposals,
    documents: [...new Set(proposals.map((p) => p.document_id))].length,
  };
}

/**
 * One proposal as SQL: the hold, and its audit row only if the hold was really
 * inserted. `INSERT OR IGNORE` against 0139's once-per-result index, so a
 * result held between the read and the write is not held twice.
 */
function proposalToSql(tenantId, p, holdId, sqlStr) {
  const audit = JSON.stringify({
    hold_id: holdId,
    source: p.source,
    source_key: p.source_key,
    lot_id: p.lot_id,
    lot_label: p.lot_label,
    reason: p.reason,
    document_version: p.version,
    via: 'propose-spec-holds',
    result: p.detail,
  });
  return [
    `INSERT OR IGNORE INTO document_holds (id, tenant_id, document_id, lot_id, reason, source, source_key, spec_check_id, document_version, detail, placed_by) ` +
      `SELECT ${sqlStr(holdId)}, ${sqlStr(tenantId)}, d.id, ${sqlStr(p.lot_id)}, ${sqlStr(p.reason)}, ${sqlStr(p.source)}, ${sqlStr(p.source_key)}, ${sqlStr(p.spec_check_id)}, ${Number(p.version) || 1}, ${sqlStr(JSON.stringify(p.detail))}, NULL ` +
      `FROM documents d WHERE d.id = ${sqlStr(p.document_id)} AND d.tenant_id = ${sqlStr(tenantId)} AND d.status = 'active' AND d.current_version = ${Number(p.version) || 1};`,
    `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details) ` +
      `SELECT NULL, ${sqlStr(tenantId)}, 'document.hold_placed', 'document', ${sqlStr(p.document_id)}, ${sqlStr(audit)} ` +
      `WHERE EXISTS (SELECT 1 FROM document_holds WHERE id = ${sqlStr(holdId)});`,
  ];
}

/**
 * Product documents split out of one flat extraction that have no register
 * rows: approved before that path registered anything (it dropped every
 * result, because nothing said which product document one belonged to). They
 * cannot be proposed -- there is no stored verdict to read -- so they are
 * counted and named for a person. `examples` is capped; `ids` is everything.
 */
function unregisteredMultiProduct(rows, cap = 25) {
  const list = (rows || []).map((r) => ({ id: r.id, title: r.title || 'Untitled document', created_at: r.created_at || null }));
  return { count: list.length, examples: list.slice(0, cap), ids: list.map((r) => r.id) };
}

module.exports = { planSpecHolds, proposalToSql, unregisteredMultiProduct };
