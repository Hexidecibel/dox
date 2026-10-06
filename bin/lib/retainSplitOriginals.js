// The pure half of bin/retain-split-originals: turning rows already read from
// D1 into the per-organization report and the SQL --apply runs. No I/O here, so
// tests/unit/retainSplitOriginals.test.ts can pin what counts as "kept" and
// what is (and is not) cleared without a database.

/** The audit action --apply leaves, and the report reads back. */
const CLEARED_ACTION = 'queue_item.split_original_retention_cleared';

function sqlStr(v) {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** The queue item a queue-produced document was approved from (functions/lib/intake/duplicates.ts). */
function queueIdFromExternalRef(ref) {
  const m = /^queue-([A-Za-z0-9]+)(?:-|$)/.exec(ref || '');
  return m ? m[1] : null;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function buildReport(data) {
  const byTenant = new Map();
  const row = (tenantId) => {
    if (!byTenant.has(tenantId)) {
      byTenant.set(tenantId, {
        tenant_id: tenantId,
        tenant_name: data.tenantName.get(tenantId) || tenantId,
        split_documents: 0,
        no_traceable_source: 0,
        sources: new Map(),
      });
    }
    return byTenant.get(tenantId);
  };

  for (const d of data.docs) {
    const t = row(d.tenant_id);
    t.split_documents += 1;
    const queueId = data.sourceOf.get(d.id);
    const q = queueId ? data.queue.get(queueId) : null;
    // A queue item in another organization is not this document's source.
    if (!q || q.tenant_id !== d.tenant_id) {
      t.no_traceable_source += 1;
      continue;
    }
    t.sources.set(q.id, q);
  }

  const out = [];
  for (const t of byTenant.values()) {
    const sources = [...t.sources.values()];
    const approved = sources.filter((q) => q.status === 'approved');
    const stamped = approved.filter((q) => q.file_retain_until);
    const kept = approved.filter(
      (q) =>
        q.file_retain_until ||
        data.cleared.has(q.id) ||
        (data.retentionSince && q.reviewed_at && String(q.reviewed_at) >= String(data.retentionSince)),
    );
    // Still in review (a partial approval): its staging file is there for the
    // ordinary reason, and is counted on its own line rather than as "kept".
    const inReview = sources.filter((q) => q.status !== 'approved');
    const soonest = stamped.map((q) => String(q.file_retain_until)).sort()[0] || null;
    out.push({
      tenant_id: t.tenant_id,
      tenant_name: t.tenant_name,
      split_documents: t.split_documents,
      source_certificates: sources.length,
      original_kept: kept.length,
      original_kept_bytes: kept.reduce((sum, q) => sum + (Number(q.file_size) || 0), 0),
      original_not_kept: approved.length - kept.length,
      still_in_review: inReview.length,
      no_traceable_source: t.no_traceable_source,
      carrying_reclaim_date: stamped.length,
      soonest_reclaim_date: soonest,
      to_clear: stamped.map((q) => ({ id: q.id, file_name: q.file_name, file_retain_until: q.file_retain_until })),
    });
  }
  out.sort((a, b) => a.tenant_name.localeCompare(b.tenant_name));
  return out;
}

function applySql(row) {
  const ids = row.to_clear.map((q) => q.id);
  const statements = [];
  for (const part of chunk(ids, 100)) {
    statements.push(
      `UPDATE processing_queue SET file_retain_until = NULL` +
        ` WHERE tenant_id = ${sqlStr(row.tenant_id)} AND status = 'approved'` +
        ` AND file_retain_until IS NOT NULL AND id IN (${part.map(sqlStr).join(',')});`,
    );
  }
  // One audit row per organization naming every item and the date it carried:
  // once the column is NULL this is the only record that it was ever stamped.
  for (const part of chunk(row.to_clear, 200)) {
    const details = JSON.stringify({
      reason: 'A whole certificate a customer may be sent again carries no reclaim date (rules table H2).',
      queue_ids: part.map((q) => q.id),
      previous: part.map((q) => ({ id: q.id, file_retain_until: q.file_retain_until })),
      script: 'bin/retain-split-originals',
    });
    statements.push(
      `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details)` +
        ` VALUES (NULL, ${sqlStr(row.tenant_id)}, ${sqlStr(CLEARED_ACTION)}, 'processing_queue', NULL, ${sqlStr(details)});`,
    );
  }
  return statements;
}

module.exports = { CLEARED_ACTION, sqlStr, queueIdFromExternalRef, chunk, buildReport, applySql };
