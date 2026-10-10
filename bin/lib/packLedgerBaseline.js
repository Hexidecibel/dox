// The pure half of bin/baseline-pack-ledger: given a pack and the rows one
// organisation holds, what does its ledger say?
//
// AN ORGANISATION SEEDED BEFORE MIGRATION 0141 HAS THE PACK'S ROWS AND NO
// RECORD OF THEM. A roll-forward needs to know, for every row, what the pack
// wrote -- and that was never stored. It cannot be recovered; it can only be
// BOUNDED, by comparing each row with what the pack writes today:
//
//   the row equals today's pack      -> 'pack'   written by the pack, as far as
//                                       anyone can tell, and untouched. A later
//                                       version may update it.
//   the row differs in some column   -> 'differs', those columns marked
//                                       'unknown'. Maybe a person edited it;
//                                       maybe an older pack wrote it. NOBODY
//                                       KNOWS, so it is treated as a person's:
//                                       a later version reports the difference
//                                       and never overwrites it on a guess.
//   the row is switched off          -> 'inactive'. Stays off.
//   there is no row                  -> 'absent'. The organisation removed it,
//                                       or was seeded from a pack that did not
//                                       have it yet. Either way it is NOT
//                                       resurrected: a baseline must not turn
//                                       into a silent re-seed.
//
// The comparison is `packFieldDiff` from shared/packRollForward.ts -- the same
// function the roll-forward planner adopts a row with, reached through the
// compiled mirror, so the baseline and the planner cannot disagree about what
// "equal" means.
//
// WHICH PACK is the other thing nobody wrote down for an organisation created
// by bin/create-tenant (it leaves no setup run). `inferPack` scores every pack
// by how much of its vocabulary the organisation holds BY SLUG and returns the
// scores with its answer, so the caller prints the inference instead of
// assuming the default pack.

'use strict';

const { packItems, PACK_KIND_SPECS, PACK_ITEM_KINDS, sqlLiteral } = require('./shared/packItems.js');
const { packFieldDiff } = require('./shared/packRollForward.js');

/** The three vocabularies an organisation's pack is recognised by. */
const VOCABULARY_KINDS = ['document_type', 'requirement', 'claim_type'];

/** Below this share of a pack's vocabulary, the organisation is not on that pack. */
const MIN_PACK_OVERLAP = 0.5;

/**
 * @param {object} pack   a NORMALIZED pack (normalizePack output)
 * @param {Record<string, Array<object>>} rows   kind -> rows, as PACK_KIND_SPECS[kind].readSql returns them
 * @param {Array<{kind:string,item_key:string}>} existing   ledger entries already there
 */
function planBaseline(pack, rows, existing = []) {
  const have = new Set(existing.map((e) => `${e.kind}\u0000${e.item_key}`));
  const entries = [];
  const already = [];
  const counts = {};
  for (const kind of PACK_ITEM_KINDS) {
    counts[kind] = { pack: 0, differs: 0, absent: 0, inactive: 0, already: 0, total: 0, extra: 0 };
  }

  const byNatural = {};
  for (const kind of PACK_ITEM_KINDS) {
    byNatural[kind] = new Map((rows[kind] || []).map((r) => [String(r.natural_key), r]));
  }

  const claimed = {};
  for (const kind of PACK_ITEM_KINDS) claimed[kind] = new Set();

  for (const item of packItems(pack)) {
    const c = counts[item.kind];
    c.total += 1;
    claimed[item.kind].add(item.natural);
    if (have.has(`${item.kind}\u0000${item.key}`)) {
      c.already += 1;
      already.push({ kind: item.kind, key: item.key, label: item.label });
      continue;
    }
    const row = byNatural[item.kind].get(item.natural);
    if (!row) {
      c.absent += 1;
      entries.push({ kind: item.kind, key: item.key, label: item.label, row_id: null, state: 'absent', differing: {}, written: item.fields });
      continue;
    }
    const differing = packFieldDiff(item.fields, row);
    const spec = PACK_KIND_SPECS[item.kind];
    const inactive = spec.activeColumn !== null && Number(row.active) === 0;
    const state = inactive ? 'inactive' : Object.keys(differing).length === 0 ? 'pack' : 'differs';
    c[state] += 1;
    entries.push({
      kind: item.kind,
      key: item.key,
      label: item.label,
      row_id: String(row.row_id),
      state,
      differing,
      written: item.fields,
      // For the report only: what the row holds where it differs.
      current: Object.fromEntries(Object.keys(differing).map((f) => [f, row[f] === undefined ? null : row[f]])),
    });
  }

  // Rows the organisation holds that are no pack item at all: its own. Counted
  // so the report says so; never ledgered, because the ledger is about the pack.
  for (const kind of PACK_ITEM_KINDS) {
    counts[kind].extra = (rows[kind] || []).filter((r) => !claimed[kind].has(String(r.natural_key))).length;
  }

  return { pack: pack.pack, version: pack.version, entries, already, counts };
}

/**
 * Which pack is this organisation on? Scores every pack by the share of its
 * vocabulary (document types, requirements, claim types) the organisation
 * holds by slug.
 *
 * @returns {{ pack: string|null, reason: string, scores: Array<{pack:string, held:number, of:number, share:number}> }}
 */
function inferPack(packs, rows) {
  const slugs = {};
  for (const kind of VOCABULARY_KINDS) slugs[kind] = new Set((rows[kind] || []).map((r) => String(r.natural_key)));

  const scores = packs
    .map((pack) => {
      let held = 0;
      let of = 0;
      for (const item of packItems(pack)) {
        if (!VOCABULARY_KINDS.includes(item.kind)) continue;
        of += 1;
        if (slugs[item.kind].has(item.natural)) held += 1;
      }
      return { pack: pack.pack, held, of, share: of === 0 ? 0 : held / of };
    })
    .sort((a, b) => b.share - a.share || a.pack.localeCompare(b.pack));

  const best = scores[0];
  if (!best || best.held === 0) {
    return { pack: null, reason: 'holds no item of any pack', scores };
  }
  if (best.share < MIN_PACK_OVERLAP) {
    return {
      pack: null,
      reason: `holds only ${best.held} of ${best.of} items of its closest pack ("${best.pack}"), under the ${Math.round(MIN_PACK_OVERLAP * 100)}% needed to call it that pack`,
      scores,
    };
  }
  const second = scores[1];
  if (second && second.share >= MIN_PACK_OVERLAP) {
    return {
      pack: null,
      reason: `could be "${best.pack}" (${best.held}/${best.of}) or "${second.pack}" (${second.held}/${second.of})`,
      scores,
    };
  }
  return { pack: best.pack, reason: `holds ${best.held} of ${best.of} of its document types, requirements and claims by slug`, scores };
}

/** The statements a baseline writes. INSERT OR IGNORE throughout: an entry already there is kept. */
function baselineToSql(plan, tenantId) {
  const statements = [];
  for (const e of plan.entries) {
    statements.push(
      'INSERT OR IGNORE INTO pack_applied_items ' +
        '(tenant_id, pack, kind, item_key, row_id, pack_version, written, differing, state, source, applied_by) VALUES (' +
        [
          sqlLiteral(tenantId),
          sqlLiteral(plan.pack),
          sqlLiteral(e.kind),
          sqlLiteral(e.key),
          sqlLiteral(e.row_id),
          sqlLiteral(plan.version),
          sqlLiteral(JSON.stringify(e.written)),
          sqlLiteral(JSON.stringify(e.differing)),
          sqlLiteral(e.state),
          "'baseline'",
          'NULL',
        ].join(', ') +
        ');',
    );
  }
  const summary = {};
  for (const kind of Object.keys(plan.counts)) {
    const c = plan.counts[kind];
    if (c.total > 0) summary[kind] = { pack: c.pack, differs: c.differs, absent: c.absent, inactive: c.inactive };
  }
  statements.push(
    'INSERT INTO tenant_packs (id, tenant_id, pack, version, from_version, source, applied_by, summary) ' +
      `SELECT lower(hex(randomblob(16))), ${sqlLiteral(tenantId)}, ${sqlLiteral(plan.pack)}, ${sqlLiteral(plan.version)}, NULL, 'baseline', NULL, ${sqlLiteral(JSON.stringify(summary))} ` +
      `WHERE NOT EXISTS (SELECT 1 FROM tenant_packs WHERE tenant_id = ${sqlLiteral(tenantId)} AND pack = ${sqlLiteral(plan.pack)});`,
  );
  statements.push(
    'INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details, ip_address) VALUES (' +
      `NULL, ${sqlLiteral(tenantId)}, 'starter_pack.baseline', 'tenant', ${sqlLiteral(tenantId)}, ` +
      `${sqlLiteral(JSON.stringify({ pack: plan.pack, version: plan.version, by: 'bin/baseline-pack-ledger', counts: summary }))}, NULL);`,
  );
  return statements;
}

module.exports = { planBaseline, inferPack, baselineToSql, MIN_PACK_OVERLAP, VOCABULARY_KINDS };
