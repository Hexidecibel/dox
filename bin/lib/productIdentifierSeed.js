// The known product identities, and the pure plan that turns them into
// product_identifiers rows for one tenant (bin/seed-product-identifiers).
//
// EVERY ROW NAMES ITS EVIDENCE in `note`. "confirmed" here means the evidence
// is a document or AJ's own statement, not an inference:
//   - Darigold 2235 <-> 810004: AJ Conner, IDP request 2026-09-08, D5 and §2.
//   - Country Morning "CUSTOMER ITEM #": printed by CMF on its certificates next
//     to its own "CMF ITEM #" (prod, counted 2026-09-15).
//
// DELIBERATELY NOT HERE:
//   - 08012 = 0801. "08012" appears only in old Andersen filenames; whether it
//     is the same SKU is an open question to AJ. No row asserts it.
//   - 30417 = 0417. The WMS has order lines under both codes for MS WHOLE 5 GL
//     BAG; CMF prints 0417. Only 0417 is seeded.
//   - 310348. In the filename of AJ's Darigold fixture; AJ (§9) says it is not
//     the PO, the EDI number, the shipment or the item number, and wants it
//     identified "before it gets indexed as anything". Seeded ONLY with
//     --include-pending, and then as an UNCONFIRMED former Darigold item, so every
//     search result reached through it says "confirm".
//
// Pure: no I/O. The script reads the tenant and applies the SQL.

const DARIGOLD = /darigold/i;
const CMF = /country morning|\bcmf\b/i;

const AJ_D5 = 'AJ Conner, IDP request 2026-09-08 (D5, §2): WMS product 2235 "DG BTR BULK U/S 55.115#" is Darigold item 810004 "SWEET CREAM BUTTER - Btr NS Gr AA 25kg".';
const cmfPrinted = (sku, item, n) => `Printed by Country Morning Farms as "CUSTOMER ITEM #: ${sku}" beside "CMF ITEM #: ${item}" (${n} certificates on prod, 2026-09-15).`;

/** @type {Array<{key: string, supplier: RegExp, anchor: {orderCode?: string, name: string, nameIsInvented?: boolean}, identifiers: Array<object>}>} */
const IDENTITIES = [
  {
    key: 'darigold-bulk-unsalted-butter-2235',
    supplier: DARIGOLD,
    anchor: { orderCode: '2235', name: 'DG BTR BULK U/S 55.115#' },
    identifiers: [
      { kind: 'our_sku', value: '2235', confirmed: true, note: AJ_D5 },
      { kind: 'supplier_item', value: '810004', supplier: true, confirmed: true, note: AJ_D5 },
      { kind: 'supplier_name', value: 'SWEET CREAM BUTTER - Btr NS Gr AA 25kg', supplier: true, confirmed: true, note: AJ_D5 },
      {
        kind: 'supplier_item', value: '310348', supplier: true, confirmed: false, superseded: true, pending: true,
        note: 'UNCONFIRMED. In the filename "2235 310348 1042620413 US BULK BUTTER MFG 072326.pdf"; possibly an older Darigold item number for this product. AJ (§9) has not identified it — confirm before relying on it.',
      },
    ],
  },
  {
    key: 'cmf-heavy-cream-300-tote-10286',
    supplier: CMF,
    anchor: { orderCode: '10286', name: '40% CREAM 300GL' },
    identifiers: [
      { kind: 'our_sku', value: '10286', confirmed: true, note: cmfPrinted('10286', '30904', 7) },
      { kind: 'supplier_item', value: '30904', supplier: true, confirmed: true, note: cmfPrinted('10286', '30904', 7) },
      { kind: 'supplier_name', value: 'Cream - Heavy Whipping 40%', supplier: true, confirmed: true, note: 'CMF PRODUCT NAME on item 30904 certificates.' },
      { kind: 'pack', value: '300 Gallon Tote', confirmed: true, note: 'CMF PACKAGE SIZE on item 30904 certificates.' },
    ],
  },
  {
    key: 'cmf-whole-milk-300-tote-10284',
    supplier: CMF,
    // No WMS description for 10284 is known; the name is the supplier's, said so.
    anchor: { orderCode: '10284', name: 'Whole Milk 300 Gallon Tote', nameIsInvented: true },
    identifiers: [
      { kind: 'our_sku', value: '10284', confirmed: true, note: cmfPrinted('10284', '30906', 7) },
      { kind: 'supplier_item', value: '30906', supplier: true, confirmed: true, note: cmfPrinted('10284', '30906', 7) },
      { kind: 'supplier_name', value: 'Milk - Whole', supplier: true, confirmed: true, note: 'CMF PRODUCT NAME on item 30906 certificates.' },
      { kind: 'pack', value: '300 Gallon Tote', confirmed: true, note: 'CMF PACKAGE SIZE on item 30906 certificates.' },
    ],
  },
  {
    key: 'cmf-heavy-cream-5-bag-0801',
    supplier: CMF,
    anchor: { orderCode: '0801', name: 'WHIP 5 GL BAG' },
    identifiers: [
      { kind: 'our_sku', value: '0801', confirmed: true, note: `${cmfPrinted('0801', '50903', 31)} Whether the Andersen-era "08012" is this SKU is an open question to AJ and is not recorded.` },
      { kind: 'supplier_item', value: '50903', supplier: true, confirmed: true, note: cmfPrinted('0801', '50903', 31) },
      { kind: 'supplier_name', value: 'Cream - Heavy Whipping 40%', supplier: true, confirmed: true, note: 'CMF PRODUCT NAME on item 50903 certificates.' },
      { kind: 'pack', value: '5 Gallon Bag', confirmed: true, note: 'CMF PACKAGE SIZE on item 50903 certificates.' },
    ],
  },
  {
    key: 'cmf-whole-milk-5-bag-0417',
    supplier: CMF,
    anchor: { orderCode: '0417', name: 'MS WHOLE 5 GL BAG' },
    identifiers: [
      { kind: 'our_sku', value: '0417', confirmed: true, note: `${cmfPrinted('0417', '50900', 22)} WMS order lines also use 30417 for this product; that is not recorded.` },
      { kind: 'supplier_item', value: '50900', supplier: true, confirmed: true, note: cmfPrinted('0417', '50900', 22) },
      { kind: 'supplier_name', value: 'Milk - Whole', supplier: true, confirmed: true, note: 'CMF PRODUCT NAME on item 50900 certificates.' },
      { kind: 'pack', value: '5 Gallon Bag', confirmed: true, note: 'CMF PACKAGE SIZE on item 50900 certificates.' },
    ],
  },
];

const CODE_KINDS = new Set(['our_sku', 'supplier_item', 'gtin']);

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'product';
}

/**
 * @param {object} input
 * @param {string} input.tenantId
 * @param {Array<{id: string, name: string}>} input.suppliers  active suppliers
 * @param {Array<{id: string, name: string, slug: string}>} input.products
 * @param {Array<{product_code: string, product_id: string}>} input.orderProducts  order_items with a product_id
 * @param {Array<{product_id: string, kind: string, supplier_id: string|null, value_norm: string}>} input.existing
 * @param {object} opts
 * @param {boolean} opts.includePending
 * @param {(v: string) => string} opts.normalizeCode
 * @param {(v: string) => string} opts.normalizeName
 * @param {() => string} opts.newId
 */
function buildSeedPlan(input, opts) {
  const plan = { tenantId: input.tenantId, createProducts: [], inserts: [], alreadyPresent: 0, skipped: [], pendingLeftOut: [] };
  const slugs = new Set(input.products.map((p) => p.slug));
  const existingKey = new Set(input.existing.map((e) => `${e.product_id}|${e.kind}|${e.supplier_id ?? ''}|${e.value_norm}`));

  for (const identity of IDENTITIES) {
    const sups = input.suppliers.filter((s) => identity.supplier.test(s.name));
    if (sups.length === 0) {
      plan.skipped.push({ key: identity.key, reason: 'no matching supplier in this workspace' });
      continue;
    }
    if (sups.length > 1) {
      plan.skipped.push({ key: identity.key, reason: `several suppliers match (${sups.map((s) => s.name).join(', ')}) — not guessing which` });
      continue;
    }
    const supplier = sups[0];

    // Anchor: the product our order lines already use for this SKU; else one
    // with exactly this name; else a new product.
    const byOrder = [...new Set(input.orderProducts.filter((o) => o.product_code === identity.anchor.orderCode).map((o) => o.product_id))];
    let productId = null;
    let productName = identity.anchor.name;
    let anchorHow;
    if (byOrder.length === 1) {
      productId = byOrder[0];
      productName = input.products.find((p) => p.id === productId)?.name ?? productName;
      anchorHow = `product used by WMS order lines for ${identity.anchor.orderCode}`;
    } else {
      const byName = input.products.filter((p) => p.name.trim().toUpperCase() === identity.anchor.name.toUpperCase());
      if (byName.length === 1) {
        productId = byName[0].id;
        anchorHow = 'existing product with this exact name';
      } else if (byName.length > 1 || byOrder.length > 1) {
        plan.skipped.push({ key: identity.key, reason: 'several products could be the anchor — not guessing which' });
        continue;
      }
    }
    if (!productId) {
      productId = opts.newId();
      let slug = slugify(productName);
      for (let i = 2; slugs.has(slug); i++) slug = `${slugify(productName)}-${i}`;
      slugs.add(slug);
      plan.createProducts.push({
        id: productId, name: productName, slug, key: identity.key,
        note: identity.anchor.nameIsInvented ? 'name taken from the supplier certificate; no WMS description is known' : null,
      });
      anchorHow = 'new product';
    }

    for (const def of identity.identifiers) {
      if (def.pending && !opts.includePending) {
        plan.pendingLeftOut.push({ key: identity.key, kind: def.kind, value: def.value, note: def.note });
        continue;
      }
      const supplierId = def.supplier ? supplier.id : null;
      const valueNorm = CODE_KINDS.has(def.kind) ? opts.normalizeCode(def.value) : opts.normalizeName(def.value);
      const k = `${productId}|${def.kind}|${supplierId ?? ''}|${valueNorm}`;
      if (existingKey.has(k)) {
        plan.alreadyPresent += 1;
        continue;
      }
      existingKey.add(k);
      plan.inserts.push({
        id: opts.newId(), tenant_id: input.tenantId, product_id: productId, product_name: productName, anchor: anchorHow,
        kind: def.kind, value: def.value, value_norm: valueNorm, supplier_id: supplierId, supplier_name: def.supplier ? supplier.name : null,
        superseded: def.superseded ? 1 : 0, confirmed: def.confirmed ? 1 : 0, note: def.note,
      });
    }
  }
  return plan;
}

const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

function planToSql(plan, runAt) {
  const out = [];
  for (const p of plan.createProducts) {
    out.push(
      `INSERT INTO products (id, tenant_id, name, slug, description, active) VALUES (${q(p.id)}, ${q(plan.tenantId)}, ${q(p.name)}, ${q(p.slug)}, ${q(p.note)}, 1);`,
    );
  }
  for (const r of plan.inserts) {
    out.push(
      `INSERT OR IGNORE INTO product_identifiers (id, tenant_id, product_id, kind, value, value_norm, supplier_id, superseded, confirmed, source, note, confirmed_at) ` +
      `VALUES (${q(r.id)}, ${q(r.tenant_id)}, ${q(r.product_id)}, ${q(r.kind)}, ${q(r.value)}, ${q(r.value_norm)}, ${q(r.supplier_id)}, ${r.superseded}, ${r.confirmed}, 'seed', ${q(r.note)}, ${r.confirmed ? q(runAt) : 'NULL'});`,
    );
  }
  if (out.length > 0) {
    out.push(
      `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details) VALUES (NULL, ${q(plan.tenantId)}, 'product_identifier.seeded', 'tenant', ${q(plan.tenantId)}, ${q(JSON.stringify({
        run_at: runAt, products_created: plan.createProducts.map((p) => ({ id: p.id, name: p.name })),
        identifiers: plan.inserts.map((r) => ({ id: r.id, product_id: r.product_id, kind: r.kind, value: r.value, confirmed: r.confirmed, superseded: r.superseded })),
      }))});`,
    );
  }
  return out;
}

function formatPlan(plan, label) {
  const lines = [`Product identifiers — ${label}`, ''];
  for (const p of plan.createProducts) lines.push(`  + product  ${p.name}${p.note ? `  (${p.note})` : ''}`);
  const byProduct = new Map();
  for (const r of plan.inserts) byProduct.set(r.product_name, [...(byProduct.get(r.product_name) ?? []), r]);
  for (const [name, rows] of byProduct) {
    lines.push(`  ${name}  [${rows[0].anchor}]`);
    for (const r of rows) {
      lines.push(`      + ${r.kind.padEnd(13)} ${r.value}${r.supplier_name ? `  (${r.supplier_name})` : ''}${r.confirmed ? '' : '  UNCONFIRMED'}${r.superseded ? '  FORMER' : ''}`);
    }
  }
  if (plan.alreadyPresent) lines.push(`  ${plan.alreadyPresent} identifier(s) already present — left untouched.`);
  for (const s of plan.skipped) lines.push(`  skipped ${s.key}: ${s.reason}`);
  for (const p of plan.pendingLeftOut) lines.push(`  NOT seeded (pending, pass --include-pending): ${p.kind} ${p.value} — ${p.note}`);
  lines.push('');
  return lines;
}

module.exports = { IDENTITIES, buildSeedPlan, planToSql, formatPlan };
