/**
 * bin/lib/lotKeySchemeReport.js — the decision half of bin/report-lot-key-scheme
 * (migration 0110). Pure; the lot-format engine is passed in.
 *
 * A declared lot format changes how a NEW lot is keyed. It never rewrites a
 * stored key — so this lists the lots on file whose stored identity
 * (`lot_key`, `sub_lot_code`) disagrees with what the format would store, and
 * says what a repair WOULD be. It has no apply mode: a key change re-points
 * matching and can merge two lot rows, and that is a person's call.
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

module.exports = { reportLots, formatReport };
