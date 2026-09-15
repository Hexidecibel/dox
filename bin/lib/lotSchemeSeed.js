/* eslint-disable no-console */
/**
 * bin/lib/lotSchemeSeed.js — the plan half of bin/seed-supplier-lot-schemes
 * (migration 0110). Pure: no D1, no fs. The lot-format engine is passed in
 * (`opts.lotScheme`, the compiled bin/lib/shared/lotScheme.js) so the plan runs
 * exactly the rules the portal runs.
 *
 * WHAT IS SEEDED, AND THE EVIDENCE:
 *   - Darigold: plant(3) | YY | Julian day(3), a 2-digit sublot, WMS composite =
 *     base + sublot, encoding the PRODUCTION date. AJ §6 verified it on the four
 *     rows of the attached COA; on prod every Darigold lot that states a
 *     production date decodes to it (2026-09-15). Plant prefixes seen: 103, 104,
 *     121, 220 — deliberately NOT declared as allowed values, so a new plant is
 *     decoded rather than refused; a lot that does not fit is still flagged.
 *   - Country Morning Farms: best-by MMDDYY + product suffix (WHO, HCR, HAH, BUO,
 *     LC3, ICR); the lot's date equals the certificate's expiration. Encodes the
 *     BEST-BY date, so it validates and never writes a production date.
 *   - Andersen Dairy: prints no product lot at all — only "Production Date" and
 *     "Code Date (Expiration)". Declared NONE, so nothing is ever decoded.
 *
 * NEVER OVERWRITES A PERSON. A supplier that already has any declaration is left
 * alone and reported (identical, or different). An ambiguous or missing supplier
 * is skipped with the reason, never guessed.
 */

const DECLARATIONS = [
  {
    key: 'darigold',
    match: /^darigold\b/i,
    template: 'plant_yy_julian',
    note:
      'plant(3) | YY | Julian day(3) + 2-digit sublot; WMS composite = base + sublot; encodes the production date. '
      + 'AJ Conner §6 (4 rows) and every Darigold lot on prod with a stated production date (2026-09-15). '
      + 'Plants seen: 103, 104, 121, 220 (not restricted). Seeded by bin/seed-supplier-lot-schemes.',
  },
  {
    key: 'country_morning',
    match: /^country morning farms?\b/i,
    template: 'best_by_mmddyy_suffix',
    note:
      'best-by MMDDYY + product suffix (WHO, HCR, HAH, BUO, LC3, ICR); the lot date equals the certificate expiration. '
      + 'Encodes the best-by date, so it validates only and never writes a production date. Seeded by bin/seed-supplier-lot-schemes.',
  },
  {
    key: 'andersen',
    match: /^andersen dairy\b/i,
    template: 'none',
    note:
      'Andersen prints no product lot — only Production Date and Code Date (Expiration). Declared none so nothing is decoded. '
      + 'Seeded by bin/seed-supplier-lot-schemes.',
  },
];

function sqlString(v) {
  return v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * @param input {{ tenantId, suppliers: [{id,name,active}], current: {[supplierId]: spec|null}, lotsBySupplier: {[supplierId]: LotFitRow[]} }}
 * @param opts  {{ lotScheme, newId: () => string }}
 */
function buildSeedPlan(input, opts) {
  const { LOT_SCHEME_TEMPLATES, previewLotFit, validateLotSchemeSpec } = opts.lotScheme;
  const plan = { tenantId: input.tenantId, entries: [] };
  for (const d of DECLARATIONS) {
    const spec = LOT_SCHEME_TEMPLATES[d.template].spec;
    const v = validateLotSchemeSpec(spec);
    if (!v.ok) throw new Error(`Seed declaration ${d.key} does not validate: ${v.errors.join(' ')}`);
    const matches = (input.suppliers || []).filter((s) => s.active !== 0 && d.match.test(String(s.name || '').trim()));
    if (matches.length !== 1) {
      plan.entries.push({
        key: d.key, action: 'skip', supplier: null, spec: v.spec,
        reason: matches.length === 0 ? 'no active supplier by that name' : `${matches.length} active suppliers match (${matches.map((m) => m.name).join(', ')}) — not guessed`,
      });
      continue;
    }
    const supplier = matches[0];
    const lots = (input.lotsBySupplier || {})[supplier.id] || [];
    const preview = previewLotFit(v.spec, lots);
    const existing = (input.current || {})[supplier.id] || null;
    let action = 'insert';
    let reason = null;
    if (existing) {
      const same = JSON.stringify(existing) === JSON.stringify(v.spec);
      action = same ? 'unchanged' : 'keep_existing';
      reason = same ? 'already declared exactly so' : 'a different format is already declared — a seed never overwrites it';
    }
    plan.entries.push({
      key: d.key,
      action,
      reason,
      supplier: { id: supplier.id, name: supplier.name },
      spec: v.spec,
      note: d.note,
      id: action === 'insert' ? opts.newId() : null,
      preview,
    });
  }
  return plan;
}

/**
 * One INSERT per new declaration — guarded so a declaration that appeared since
 * the plan was read is never duplicated — and the same audit row the admin page
 * writes (`supplier.lot_scheme_declared`, no user: a seed), written only when the
 * declaration row actually went in.
 */
function planToSql(plan) {
  const out = [];
  for (const e of plan.entries.filter((x) => x.action === 'insert')) {
    out.push(
      `INSERT INTO supplier_lot_schemes (id, tenant_id, supplier_id, version, spec, source, note, created_by)
SELECT ${sqlString(e.id)}, ${sqlString(plan.tenantId)}, ${sqlString(e.supplier.id)}, 1, ${sqlString(JSON.stringify(e.spec))}, 'seed', ${sqlString(e.note)}, NULL
WHERE NOT EXISTS (SELECT 1 FROM supplier_lot_schemes WHERE supplier_id = ${sqlString(e.supplier.id)});`,
    );
    const details = {
      supplier_name: e.supplier.name,
      version: 1,
      scheme_id: e.id,
      spec: e.spec,
      previous_version: null,
      previous_spec: null,
      note: e.note,
      via: 'bin/seed-supplier-lot-schemes',
      fit: {
        total: e.preview.total,
        fits: e.preview.fits,
        not_fitting: e.preview.not_fitting.length,
        date_disagreements: e.preview.date_disagreements.length,
        key_differs: e.preview.key_differs,
      },
    };
    out.push(
      `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details)
SELECT NULL, ${sqlString(plan.tenantId)}, 'supplier.lot_scheme_declared', 'supplier', ${sqlString(e.supplier.id)}, ${sqlString(JSON.stringify(details))}
WHERE EXISTS (SELECT 1 FROM supplier_lot_schemes WHERE id = ${sqlString(e.id)});`,
    );
  }
  return out;
}

function formatPlan(plan, label, lotScheme) {
  const lines = [`== ${label}`];
  for (const e of plan.entries) {
    const format = lotScheme.lotSchemeLabel(e.spec);
    if (e.action === 'skip') {
      lines.push(`  ${e.key}: SKIPPED — ${e.reason}`);
      continue;
    }
    lines.push(`  ${e.supplier.name} (${e.supplier.id}): ${e.action.toUpperCase()} — ${format}${e.reason ? ` (${e.reason})` : ''}`);
    const p = e.preview;
    if (e.spec.kind === 'structured') {
      lines.push(`    lots on file: ${p.total}; fit: ${p.fits}; do not fit: ${p.not_fitting.length}; decoded production date differs from the one on file: ${p.date_disagreements.length}; stored key differs from what the format stores: ${p.key_differs}`);
      for (const l of p.not_fitting) lines.push(`      does not fit: ${l.lot_number}${l.sub_lot_code ? ` / sublot ${l.sub_lot_code}` : ''} — ${l.reason}`);
      for (const l of p.date_disagreements) lines.push(`      date differs: ${l.lot_number}${l.sub_lot_code ? `-${l.sub_lot_code}` : ''} on file ${l.on_file}, lot code ${l.decoded}`);
    } else {
      lines.push(`    lots on file: ${p.total}; nothing is checked or decoded`);
    }
  }
  return lines;
}

module.exports = { DECLARATIONS, buildSeedPlan, planToSql, formatPlan };
