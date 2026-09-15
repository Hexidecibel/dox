/**
 * bin/lib/duplicateDocumentsAudit.js — the deciding half of
 * `bin/audit-duplicate-documents`.
 *
 * SQL strings out, rows in, report out. No D1, no network, no clock: the script
 * runs the statements, this file groups what came back, so the grouping rules
 * can be tested against a seeded database without shelling out to wrangler.
 *
 * WHAT COUNTS AS A DUPLICATE HERE
 *
 * Two or more live documents in ONE tenant that are the same bytes AND came
 * from DIFFERENT arrivals. "The same bytes" is read two ways, because neither
 * alone is complete:
 *   - the document version's own checksum (single-document approvals, manual
 *     uploads, the ingest API);
 *   - the checksum of the queue item a document was approved from
 *     (`external_ref` 'queue-<id>' / 'queue-<id>-<suffix>'). A records-shaped
 *     COA is page-scoped at approval, so its documents carry the checksum of
 *     their own pages, and only the queue item still knows the file's.
 *
 * "Different arrivals" is what separates a duplicate from a SPLIT: one file
 * approved into several sublot documents is several documents from ONE queue
 * item, often with one whole-file checksum between them, and that is correct.
 * Those groups are counted and reported separately, never as surplus.
 *
 * WHAT THIS NEVER DOES
 *
 * Decide. It marks the earliest-approved arrival as `first` and every later
 * arrival's documents as `later copy`, and lists what hangs off each one
 * (requirement links, spec register rows, lots, order lines, bundles, supplier
 * arrivals, request lines) so a PERSON can judge which copy to keep. There is
 * no apply path in this phase: the report is the deliverable.
 */

'use strict';

const IN_CHUNK = 80;

function sqlText(v) {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function tenantClause(alias, tenantId) {
  return tenantId ? ` AND ${alias}.tenant_id = ${sqlText(tenantId)}` : '';
}

/** Documents whose own version checksum is shared by another live document. */
function versionGroupsSql(tenantId) {
  return `SELECT d.id AS document_id, d.tenant_id, d.title, d.created_at, d.created_by,
                 d.external_ref, d.current_version, d.supplier_id, dv.checksum,
                 dv.version_number, dv.file_name
            FROM document_versions dv
            JOIN documents d ON d.id = dv.document_id
           WHERE d.status <> 'deleted'${tenantClause('d', tenantId)}
             AND dv.checksum IS NOT NULL AND dv.checksum <> ''
             AND EXISTS (
               SELECT 1 FROM document_versions dv2
                 JOIN documents d2 ON d2.id = dv2.document_id
                WHERE d2.tenant_id = d.tenant_id AND d2.status <> 'deleted'
                  AND dv2.checksum = dv.checksum AND d2.id <> d.id)
           ORDER BY d.tenant_id, dv.checksum, d.created_at, d.id`;
}

/** Documents approved from queue items whose file checksum another approved item shares. */
function queueGroupsSql(tenantId) {
  return `SELECT d.id AS document_id, d.tenant_id, d.title, d.created_at, d.created_by,
                 d.external_ref, d.current_version, d.supplier_id, pq.checksum,
                 pq.id AS queue_id, pq.reviewed_at, pq.source, pq.source_detail, pq.file_name
            FROM processing_queue pq
            JOIN documents d
              ON d.tenant_id = pq.tenant_id
             AND (d.external_ref = 'queue-' || pq.id OR d.external_ref LIKE 'queue-' || pq.id || '-%')
           WHERE pq.status = 'approved' AND d.status <> 'deleted'${tenantClause('pq', tenantId)}
             AND pq.checksum IS NOT NULL AND pq.checksum <> ''
             AND EXISTS (
               SELECT 1 FROM processing_queue pq2
                WHERE pq2.tenant_id = pq.tenant_id AND pq2.status = 'approved'
                  AND pq2.checksum = pq.checksum AND pq2.id <> pq.id)
           ORDER BY d.tenant_id, pq.checksum, pq.reviewed_at, d.id`;
}

/** Queue provenance for a set of queue ids (who approved, when, via which door). */
function queueItemsSql(queueIds) {
  return `SELECT pq.id AS queue_id, pq.reviewed_at, pq.source, pq.source_detail, pq.file_name,
                 u.name AS reviewed_by_name
            FROM processing_queue pq
            LEFT JOIN users u ON u.id = pq.reviewed_by
           WHERE pq.id IN (${queueIds.map(sqlText).join(', ')})`;
}

/**
 * Everything that hangs off a document, one row per document. Each column is a
 * count, so "surplus copy with nothing attached" is a row of zeros.
 */
function linksSql(documentIds) {
  const ids = documentIds.map(sqlText).join(', ');
  return `SELECT d.id AS document_id,
                 (SELECT COUNT(*) FROM document_versions x WHERE x.document_id = d.id) AS versions,
                 (SELECT COUNT(*) FROM document_requirements x WHERE x.document_id = d.id) AS requirement_links,
                 (SELECT COUNT(*) FROM document_spec_checks x WHERE x.document_id = d.id) AS spec_checks,
                 (SELECT COUNT(*) FROM document_lots x WHERE x.document_id = d.id) AS lots,
                 (SELECT COUNT(*) FROM order_items x WHERE x.coa_document_id = d.id) AS order_lines,
                 (SELECT COUNT(*) FROM lot_match_suggestions x WHERE x.document_id = d.id) AS lot_match_suggestions,
                 (SELECT COUNT(*) FROM document_bundle_items x WHERE x.document_id = d.id) AS bundles,
                 (SELECT COUNT(*) FROM request_uploads x WHERE x.document_id = d.id) AS supplier_arrivals,
                 (SELECT COUNT(*) FROM request_lines x WHERE x.accepted_document_id = d.id) AS accepted_request_lines,
                 (SELECT COUNT(*) FROM document_products x WHERE x.document_id = d.id) AS products
            FROM documents d
           WHERE d.id IN (${ids})`;
}

/** Link columns that matter for "is it safe to archive this copy". Versions is not a link. */
const LINK_KEYS = [
  'requirement_links',
  'spec_checks',
  'lots',
  'order_lines',
  'lot_match_suggestions',
  'bundles',
  'supplier_arrivals',
  'accepted_request_lines',
  'products',
];

function chunk(items, size = IN_CHUNK) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function queueIdFromExternalRef(ref) {
  if (!ref) return null;
  const m = /^queue-([A-Za-z0-9]+)(?:-|$)/.exec(ref);
  return m ? m[1] : null;
}

function normTitle(t) {
  return String(t || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Group documents into same-file sets.
 *
 * @param {object} input
 * @param {Array} input.versionRows  rows of versionGroupsSql
 * @param {Array} input.queueRows    rows of queueGroupsSql
 * @param {Array} input.queueItems   rows of queueItemsSql (provenance)
 * @param {Array} input.linkRows     rows of linksSql
 * @returns {{ groups: Array, splits: Array, summary: object }}
 */
function buildReport({ versionRows, queueRows, queueItems, linkRows }) {
  const provenance = new Map((queueItems || []).map((q) => [q.queue_id, q]));
  const links = new Map((linkRows || []).map((l) => [l.document_id, l]));

  // Union-find over documents: two documents are one set when they share a
  // version checksum or an arrival checksum. A document can reach a set both
  // ways, and the sets must merge rather than double-count it.
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const add = (x) => {
    if (!parent.has(x)) parent.set(x, x);
  };
  const union = (a, b) => {
    add(a);
    add(b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  const docs = new Map();
  const touch = (r) => {
    if (!docs.has(r.document_id)) {
      docs.set(r.document_id, {
        document_id: r.document_id,
        tenant_id: r.tenant_id,
        title: r.title,
        created_at: r.created_at,
        external_ref: r.external_ref,
        current_version: r.current_version,
        supplier_id: r.supplier_id,
        checksums: new Set(),
      });
    }
    return docs.get(r.document_id);
  };

  const byKey = new Map();
  const link = (key, docId) => {
    if (!byKey.has(key)) byKey.set(key, docId);
    else union(byKey.get(key), docId);
    add(docId);
  };
  for (const r of versionRows || []) {
    touch(r).checksums.add(r.checksum);
    link(`${r.tenant_id}::${r.checksum}`, r.document_id);
  }
  for (const r of queueRows || []) {
    touch(r).checksums.add(r.checksum);
    link(`${r.tenant_id}::${r.checksum}`, r.document_id);
  }

  const sets = new Map();
  for (const id of docs.keys()) {
    const root = find(id);
    if (!sets.has(root)) sets.set(root, []);
    sets.get(root).push(docs.get(id));
  }

  const groups = [];
  const splits = [];
  for (const members of sets.values()) {
    if (members.length < 2) continue;
    const enriched = members.map((m) => {
      const queueId = queueIdFromExternalRef(m.external_ref);
      const prov = queueId ? provenance.get(queueId) : null;
      const l = links.get(m.document_id) || {};
      const linkCounts = {};
      for (const k of LINK_KEYS) linkCounts[k] = Number(l[k] || 0);
      return {
        document_id: m.document_id,
        tenant_id: m.tenant_id,
        title: m.title,
        arrival: queueId ? `queue:${queueId}` : `document:${m.document_id}`,
        queue_id: queueId,
        approved_at: (prov && prov.reviewed_at) || m.created_at,
        approved_by: (prov && prov.reviewed_by_name) || null,
        source: (prov && prov.source) || (queueId ? null : 'direct'),
        source_detail: (prov && prov.source_detail) || null,
        versions: Number(l.versions || m.current_version || 1),
        links: linkCounts,
        link_total: LINK_KEYS.reduce((n, k) => n + linkCounts[k], 0),
        checksums: [...m.checksums],
      };
    });
    enriched.sort((a, b) =>
      String(a.approved_at).localeCompare(String(b.approved_at)) || a.document_id.localeCompare(b.document_id),
    );
    const arrivals = [...new Set(enriched.map((e) => e.arrival))];
    if (arrivals.length < 2) {
      splits.push({ tenant_id: enriched[0].tenant_id, arrival: arrivals[0], documents: enriched });
      continue;
    }
    const firstArrival = enriched[0].arrival;
    for (const e of enriched) e.role = e.arrival === firstArrival ? 'first' : 'later_copy';
    const titles = new Set(enriched.map((e) => normTitle(e.title)));
    groups.push({
      tenant_id: enriched[0].tenant_id,
      checksums: [...new Set(enriched.flatMap((e) => e.checksums))],
      same_title: titles.size === 1,
      arrivals: arrivals.length,
      documents: enriched,
    });
  }
  groups.sort((a, b) =>
    a.tenant_id.localeCompare(b.tenant_id) ||
    String(a.documents[0].approved_at).localeCompare(String(b.documents[0].approved_at)),
  );

  const surplus = groups.flatMap((g) => g.documents.filter((d) => d.role === 'later_copy'));
  const surplusWithLinks = surplus.filter((d) => d.link_total > 0);
  const linkBreakdown = {};
  for (const k of LINK_KEYS) linkBreakdown[k] = surplus.filter((d) => d.links[k] > 0).length;

  return {
    groups,
    splits,
    summary: {
      groups: groups.length,
      same_title_groups: groups.filter((g) => g.same_title).length,
      documents_in_groups: groups.reduce((n, g) => n + g.documents.length, 0),
      surplus_documents: surplus.length,
      surplus_same_title: groups.filter((g) => g.same_title).reduce((n, g) => n + g.documents.filter((d) => d.role === 'later_copy').length, 0),
      surplus_with_links: surplusWithLinks.length,
      surplus_links_by_kind: linkBreakdown,
      record_split_sets_not_counted: splits.length,
    },
  };
}

const LINK_LABELS = {
  requirement_links: 'requirements',
  spec_checks: 'spec results',
  lots: 'lots',
  order_lines: 'order lines',
  lot_match_suggestions: 'lot suggestions',
  bundles: 'bundles',
  supplier_arrivals: 'supplier arrivals',
  accepted_request_lines: 'accepted request lines',
  products: 'products',
};

function describeLinks(l) {
  const parts = LINK_KEYS.filter((k) => l[k] > 0).map((k) => `${l[k]} ${LINK_LABELS[k]}`);
  return parts.length ? parts.join(', ') : 'nothing attached';
}

/** Human-readable report. */
function renderText(report) {
  const out = [];
  const { groups, summary } = report;
  if (groups.length === 0) {
    out.push('No duplicate documents: no two live documents from different arrivals share a file.');
  }
  groups.forEach((g, i) => {
    out.push(
      `Group ${i + 1}  [tenant ${g.tenant_id}]  ${g.documents.length} documents from ${g.arrivals} arrivals` +
        `  ${g.same_title ? 'same title' : 'DIFFERENT titles'}  sha256 ${g.checksums.map((c) => String(c).slice(0, 12)).join('/')}`,
    );
    for (const d of g.documents) {
      const mark = d.role === 'first' ? 'first     ' : 'later copy';
      out.push(
        `   ${mark}  ${d.title}  (${d.document_id})`,
      );
      out.push(
        `              approved ${d.approved_at || '?'}${d.approved_by ? ` by ${d.approved_by}` : ''}` +
          `  via ${d.source || '?'}${d.source_detail ? ` ${String(d.source_detail).slice(0, 80)}` : ''}` +
          `  v${d.versions}  ${describeLinks(d.links)}`,
      );
    }
    out.push('');
  });
  out.push('Summary');
  out.push(`  duplicate groups              ${summary.groups} (${summary.same_title_groups} with the same title)`);
  out.push(`  documents in those groups     ${summary.documents_in_groups}`);
  out.push(`  later copies (surplus)        ${summary.surplus_documents} (${summary.surplus_same_title} in same-title groups)`);
  out.push(`  later copies with links       ${summary.surplus_with_links}`);
  for (const k of LINK_KEYS) {
    if (summary.surplus_links_by_kind[k] > 0) {
      out.push(`      with ${LINK_LABELS[k].padEnd(24)} ${summary.surplus_links_by_kind[k]}`);
    }
  }
  out.push(`  one-file record splits        ${summary.record_split_sets_not_counted} (one arrival approved into several documents; not duplicates)`);
  return out.join('\n');
}

module.exports = {
  versionGroupsSql,
  queueGroupsSql,
  queueItemsSql,
  linksSql,
  buildReport,
  renderText,
  chunk,
  queueIdFromExternalRef,
  LINK_KEYS,
};
