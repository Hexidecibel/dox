/**
 * bin/lib/lotKeySchemeReport.js — the decision half of bin/report-lot-key-scheme
 * (migration 0110). Pure; the lot-format engine is passed in.
 *
 * A declared lot format changes how a NEW lot is keyed. It never rewrites a
 * stored key — so this lists the lots on file whose stored identity
 * (`lot_key`, `sub_lot_code`) disagrees with what the format would store, and
 * says what a repair WOULD be. A key change re-points matching and can merge
 * two lot rows, and that is a person's call: the repair (planRepairs /
 * repairToSql below) runs only under an explicit --apply after the dry run.
 *
 * Classes:
 *   split_composite       fits; the stored row kept a composite whole with no
 *                         sublot ('1032603623' | '') where the format reads
 *                         lot 10326036 + sublot 23
 *   key_differs           fits; stored identity differs any other way
 *   sublot_not_a_sublot   does NOT fit because the sublot field holds something
 *                         that is not a sublot (the 1032610210326102 class: the
 *                         base read into the sublot field); read alone, the lot
 *                         fits, and that is the suggested identity
 *   does_not_fit          does not fit, no repair derivable (a PO in the lot
 *                         field, three lots merged) — an extraction error to fix
 *                         on the certificate, listed for completeness
 */

function identityKey(tenantProduct, key, sub) {
  return `${tenantProduct}|${key}|${sub}`;
}

/**
 * @param lots [{ lot_id, product_id, lot_number, sub_lot_code, lot_key }]
 */
function reportLots(spec, lots, lotScheme) {
  const { decodeLot } = lotScheme;
  const byIdentity = new Map();
  for (const l of lots) byIdentity.set(identityKey(l.product_id || '', l.lot_key, l.sub_lot_code || ''), l.lot_id);
  const rows = [];
  const counts = { total: lots.length, ok: 0, split_composite: 0, key_differs: 0, sublot_not_a_sublot: 0, does_not_fit: 0 };
  if (!spec || spec.kind !== 'structured') {
    counts.ok = lots.length;
    return { counts, rows };
  }
  for (const l of lots) {
    const stored = { key: l.lot_key, sub: l.sub_lot_code || '' };
    const d = decodeLot(spec, l.lot_number, l.sub_lot_code);
    let cls = null;
    let suggested = null;
    let reason = d.reason;
    if (d.fits) {
      if (d.key === stored.key && d.key_sublot === stored.sub) {
        counts.ok++;
        continue;
      }
      suggested = { key: d.key, sub: d.key_sublot };
      cls = !stored.sub && d.key_sublot ? 'split_composite' : 'key_differs';
      reason = `the format reads lot ${d.base}${d.sublot ? ` + sublot ${d.sublot}` : ''}`;
    } else if (stored.sub) {
      const alone = decodeLot(spec, l.lot_number, null);
      if (alone.fits) {
        cls = 'sublot_not_a_sublot';
        suggested = { key: alone.key, sub: alone.key_sublot };
        reason = `${d.reason} Read alone, lot ${l.lot_number} fits as ${alone.base}${alone.sublot ? ` + sublot ${alone.sublot}` : ''}.`;
      } else {
        cls = 'does_not_fit';
      }
    } else {
      cls = 'does_not_fit';
    }
    counts[cls]++;
    const mergeWith = suggested
      ? byIdentity.get(identityKey(l.product_id || '', suggested.key, suggested.sub))
      : undefined;
    rows.push({
      class: cls,
      lot_id: l.lot_id,
      lot_number: l.lot_number,
      stored,
      suggested,
      would_merge_into: mergeWith && mergeWith !== l.lot_id ? mergeWith : null,
      reason,
    });
  }
  return { counts, rows };
}

function formatReport(label, formatLabel, source, report) {
  const c = report.counts;
  const lines = [
    `  ${label} — ${formatLabel} (${source})`,
    `    lots: ${c.total}; identity matches the format: ${c.ok}; split_composite: ${c.split_composite}; key_differs: ${c.key_differs}; sublot_not_a_sublot: ${c.sublot_not_a_sublot}; does_not_fit: ${c.does_not_fit}`,
  ];
  for (const r of report.rows) {
    const stored = `${r.stored.key}${r.stored.sub ? ` | sub ${r.stored.sub}` : ' | no sub'}`;
    const sugg = r.suggested ? ` -> ${r.suggested.key}${r.suggested.sub ? ` | sub ${r.suggested.sub}` : ' | no sub'}` : '';
    const merge = r.would_merge_into ? ` (would MERGE into lot ${r.would_merge_into})` : '';
    lines.push(`    [${r.class}] lot ${r.lot_number} (${r.lot_id}): ${stored}${sugg}${merge} — ${r.reason}`);
  }
  return lines;
}

/**
 * The REPAIR half (bin/report-lot-key-scheme --apply). Each reported row
 * becomes one of:
 *
 *   rekey   split_composite / key_differs / sublot_not_a_sublot with no lot
 *           already holding the suggested identity: UPDATE lot_key +
 *           sub_lot_code in place. lot_number (the page's verbatim text) is
 *           never touched.
 *   merge   the suggested identity already belongs to another lot of the SAME
 *           product and supplier: every document_lots / order_items /
 *           lot_match_suggestions pointer moves to that lot (a document already
 *           linked to it keeps its one link), then the emptied row is deleted
 *           with its whole content in the audit row. Refused when the two rows
 *           state different production dates -- picking one would be a guess.
 *   skip    does_not_fit (no repair derivable: an extraction to fix on the
 *           certificate), or a merge the rule above refuses.
 *
 * `lotsById` holds full lots rows (plus document_lots / order_items /
 * suggestions counts) for every lot named, source and target. Every statement
 * is guarded by the stored identity the plan read, so a row that changed since
 * the dry run is not touched.
 */
function planRepairs(report, lotsById) {
  const repairs = [];
  const skipped = [];
  for (const r of report.rows) {
    const src = lotsById.get(r.lot_id);
    if (!r.suggested || !src) {
      skipped.push({ row: r, reason: 'no repair derivable (does not fit the declared format; fix the certificate)' });
      continue;
    }
    if (!r.would_merge_into) {
      repairs.push({ kind: 'rekey', row: r, before: src, after: { ...src, lot_key: r.suggested.key, sub_lot_code: r.suggested.sub } });
      continue;
    }
    const dst = lotsById.get(r.would_merge_into);
    if (!dst) {
      skipped.push({ row: r, reason: `merge target ${r.would_merge_into} not found` });
      continue;
    }
    if ((src.supplier_id || null) !== (dst.supplier_id || null) || (src.product_id || null) !== (dst.product_id || null)) {
      skipped.push({ row: r, reason: 'merge target has a different supplier or product' });
      continue;
    }
    if (src.production_date && dst.production_date && src.production_date !== dst.production_date) {
      skipped.push({ row: r, reason: `the two rows state different production dates (${src.production_date} vs ${dst.production_date})` });
      continue;
    }
    repairs.push({ kind: 'merge', row: r, before: src, into: dst });
  }
  return { repairs, skipped };
}

const LOT_COLUMNS = [
  'id', 'tenant_id', 'supplier_id', 'product_id', 'lot_number', 'lot_key', 'sub_lot_code', 'code_date',
  'expiration_date', 'mfg_date', 'primary_metadata', 'first_seen_source', 'created_at', 'updated_at',
  'production_date', 'production_date_raw', 'production_date_source', 'production_date_status',
  'production_date_document_id', 'production_date_scheme_id',
];

function repairToSql(tenantId, rep, q, runAt) {
  const s = [];
  const src = rep.before;
  const guard = `id = ${q(src.id)} AND tenant_id = ${q(tenantId)} AND lot_key = ${q(src.lot_key)} AND sub_lot_code = ${q(src.sub_lot_code || '')}`;
  const detailsBase = { class: rep.row.class, lot_number: src.lot_number, reason: rep.row.reason, tool: 'bin/report-lot-key-scheme --apply', run_at: runAt };
  if (rep.kind === 'rekey') {
    // Audit first, guarded by the identity the plan read: a re-run (the row
    // already repaired) writes neither the audit row nor the update.
    s.push(
      `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details) SELECT NULL, ${q(tenantId)}, 'lot.identity_repaired', 'lot', ${q(src.id)}, ${q(JSON.stringify({
        ...detailsBase,
        before: { lot_key: src.lot_key, sub_lot_code: src.sub_lot_code || '' },
        after: { lot_key: rep.after.lot_key, sub_lot_code: rep.after.sub_lot_code },
      }))} WHERE EXISTS (SELECT 1 FROM lots WHERE ${guard});`,
    );
    s.push(`UPDATE lots SET lot_key = ${q(rep.after.lot_key)}, sub_lot_code = ${q(rep.after.sub_lot_code)}, updated_at = datetime('now') WHERE ${guard};`);
    return s;
  }
  const dst = rep.into;
  const exists = `EXISTS (SELECT 1 FROM lots WHERE ${guard})`;
  const removedRow = {};
  for (const c of LOT_COLUMNS) removedRow[c] = src[c] === undefined ? null : src[c];
  // Audit FIRST, while the row still exists to be described.
  s.push(
    `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details) SELECT NULL, ${q(tenantId)}, 'lot.merged_on_identity_repair', 'lot', ${q(src.id)}, ${q(JSON.stringify({
      ...detailsBase,
      merged_into: dst.id,
      merged_into_identity: { lot_key: dst.lot_key, sub_lot_code: dst.sub_lot_code || '' },
      removed_row: removedRow,
    }))} WHERE ${exists};`,
  );
  s.push(
    `UPDATE document_lots SET lot_id = ${q(dst.id)} WHERE lot_id = ${q(src.id)} AND ${exists} AND NOT EXISTS (SELECT 1 FROM document_lots x WHERE x.lot_id = ${q(dst.id)} AND x.document_id = document_lots.document_id);`,
  );
  s.push(`DELETE FROM document_lots WHERE lot_id = ${q(src.id)} AND ${exists} AND document_id IN (SELECT document_id FROM document_lots WHERE lot_id = ${q(dst.id)});`);
  s.push(`UPDATE order_items SET lot_id = ${q(dst.id)} WHERE lot_id = ${q(src.id)} AND ${exists};`);
  s.push(`UPDATE lot_match_suggestions SET lot_id = ${q(dst.id)} WHERE lot_id = ${q(src.id)} AND ${exists};`);
  if (!dst.production_date && src.production_date) {
    s.push(
      `UPDATE lots SET production_date = ${q(src.production_date)}, production_date_raw = ${q(src.production_date_raw)}, production_date_source = ${q(src.production_date_source)}, production_date_status = ${q(src.production_date_status)}, production_date_document_id = ${q(src.production_date_document_id)}, production_date_scheme_id = ${q(src.production_date_scheme_id)}, updated_at = datetime('now') WHERE id = ${q(dst.id)} AND production_date IS NULL AND ${exists};`,
    );
  }
  s.push(
    `DELETE FROM lots WHERE ${guard} AND NOT EXISTS (SELECT 1 FROM document_lots WHERE lot_id = ${q(src.id)}) AND NOT EXISTS (SELECT 1 FROM order_items WHERE lot_id = ${q(src.id)}) AND NOT EXISTS (SELECT 1 FROM lot_match_suggestions WHERE lot_id = ${q(src.id)});`,
  );
  return s;
}

function formatRepairs(plan) {
  const out = [];
  const ident = (l) => `lot_key ${l.lot_key} | ${l.sub_lot_code ? `sub_lot_code ${l.sub_lot_code}` : "sub_lot_code ''"}`;
  const links = (l) => `${l.document_lots} document link(s), ${l.order_items} order line(s), ${l.suggestions} suggestion(s), production ${l.production_date || '-'}`;
  for (const r of plan.repairs) {
    if (r.kind === 'rekey') {
      out.push(`    REKEY  lot ${r.before.lot_number} (${r.before.id})`);
      out.push(`      before  ${ident(r.before)}  (${links(r.before)})`);
      out.push(`      after   ${ident(r.after)}  (links unchanged)`);
    } else {
      out.push(`    MERGE  lot ${r.before.lot_number} (${r.before.id}) into ${r.into.id}`);
      out.push(`      before  ${ident(r.before)}  (${links(r.before)})`);
      out.push(`      target  ${ident(r.into)}  (${links(r.into)})`);
      out.push(`      after   ${r.before.id} deleted (whole row in the audit row); its links move to ${r.into.id}`);
    }
  }
  for (const s of plan.skipped) out.push(`    SKIP   lot ${s.row.lot_number} (${s.row.lot_id}) — ${s.reason}`);
  return out;
}

module.exports = { reportLots, formatReport, planRepairs, repairToSql, formatRepairs };
