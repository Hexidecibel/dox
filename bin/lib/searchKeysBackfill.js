// Pure planning half of bin/backfill-search-keys (migration 0122).
//
// The keys come from the SAME function the portal writes them with —
// shared/searchKeys.ts#deriveSearchKeys, through its generated mirror
// (bin/lib/shared/searchKeys.js, `npm run build:worker-shared`) — so the
// backfill cannot derive a key the live writer would not.

const { deriveSearchKeys } = require('./shared/searchKeys');

function parseObject(raw) {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/**
 * @param {Array<{id:string, tenant_id:string, primary_metadata:string|null, extended_lite:string|null}>} docs
 * @param {Array<{document_id:string, lot_id:string, lot_number:string|null, sub_lot_code:string|null, code_date:string|null, expiration_date:string|null}>} lots
 */
function buildKeyPlan(docs, lots) {
  const byDoc = new Map();
  for (const l of lots || []) byDoc.set(l.document_id, [...(byDoc.get(l.document_id) || []), l]);
  const keys = [];
  const byKind = {};
  let ambiguous = 0;
  let documentsWithKeys = 0;
  for (const d of docs || []) {
    const metadata = { ...parseObject(d.extended_lite), ...parseObject(d.primary_metadata) };
    const derived = deriveSearchKeys(metadata, (byDoc.get(d.id) || []).map((l) => ({
      lot_id: l.lot_id, lot_number: l.lot_number, sub_lot_code: l.sub_lot_code, code_date: l.code_date, expiration_date: l.expiration_date,
    })));
    if (derived.length) documentsWithKeys++;
    for (const k of derived) {
      keys.push({ tenant_id: d.tenant_id, document_id: d.id, ...k });
      byKind[k.kind] = (byKind[k.kind] || 0) + 1;
      if (k.provenance === 'ambiguous') ambiguous++;
    }
  }
  return { documentIds: (docs || []).map((d) => d.id), keys, byKind, ambiguous, documentsWithKeys };
}

function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Batches of SQL statements: per 50 documents, delete + insert + complete their jobs. */
function planToSql(plan, opts = {}) {
  const perBatch = opts.documentsPerBatch || 50;
  const byDoc = new Map();
  for (const k of plan.keys) byDoc.set(k.document_id, [...(byDoc.get(k.document_id) || []), k]);
  const batches = [];
  for (let i = 0; i < plan.documentIds.length; i += perBatch) {
    const ids = plan.documentIds.slice(i, i + perBatch);
    const inList = ids.map(lit).join(', ');
    const stmts = [`DELETE FROM document_search_keys WHERE document_id IN (${inList});`];
    const rows = ids.flatMap((id) => byDoc.get(id) || []);
    for (let j = 0; j < rows.length; j += 100) {
      const values = rows.slice(j, j + 100).map((k) => `(${[
        k.tenant_id, k.document_id, k.lot_id, k.kind, String(k.value_raw).slice(0, 500), String(k.value_norm).slice(0, 200),
        k.value_date, k.provenance, k.source_field,
      ].map(lit).join(', ')})`);
      stmts.push(
        `INSERT INTO document_search_keys (tenant_id, document_id, lot_id, kind, value_raw, value_norm, value_date, provenance, source_field) VALUES ${values.join(', ')};`
      );
    }
    stmts.push(
      `UPDATE search_reindex_jobs SET status = 'completed', processed_at = datetime('now') WHERE entity_kind = 'document_keys' AND status = 'pending' AND entity_id IN (${inList});`
    );
    batches.push(stmts);
  }
  return batches;
}

module.exports = { buildKeyPlan, planToSql };
