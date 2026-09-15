/**
 * bin/lib/lotProductionBackfill.js — the decision half of
 * `bin/backfill-lot-production-dates`.
 *
 * PURE: rows in, plan out. No D1, no clock of its own (the run stamp is passed
 * in), and the reading rules are INJECTED from the compiled shared modules
 * (shared/lotProductionDate.ts, shared/rowScopedText.ts, shared/lotNormalize.ts)
 * — the same functions the approve path calls, so a backfilled lot row is read
 * on exactly the terms a newly approved one is.
 *
 * THE RULES THIS FILE EXISTS TO ENFORCE
 *
 *  1. A LOT THAT ALREADY HAS A PRODUCTION DATE STATE IS NEVER TOUCHED. Any
 *     non-NULL `production_date_status` — resolved, ambiguous, unparseable,
 *     conflict — was written by approval, a reviewer, or an earlier pass. The
 *     UPDATE also carries `AND production_date_status IS NULL`, so even a stale
 *     plan cannot overwrite one. That is what makes a second --apply write
 *     nothing.
 *  2. EXTRACTION FIRST. A linked document's own production-date field is the
 *     source ('extracted'). Only when a document has NONE does its code date get
 *     considered, and only when the page prints that value under a production
 *     label and never prints a code-date label ('extracted_code_date_legacy').
 *     Every refusal is reported with its reason.
 *  3. NEVER A GUESS. A value that reads two ways is stored raw with a NULL day
 *     ('ambiguous') and listed. Certificates that disagree are 'conflict' and
 *     listed. Nothing here picks a winner.
 *  4. A DOCUMENT'S DATE BELONGS TO ITS OWN LOT. A document linked to several
 *     lots gives its (single) metadata date only to the lot its metadata names.
 *
 * SIBLING TEXT. Split certificates (external_ref `queue-<id>-<suffix>`, two or
 * more on file from one queue item) get `document_versions.search_text` = the
 * shared text with the other rows' lots and dates blanked. The migration's
 * update trigger reindexes each such document as it is written — one document
 * at a time, no tenant-wide rebuild.
 */

const MAX_TEXT_BYTES = 90 * 1024; // under D1's 100 KB statement limit, with room for the UPDATE

function sqlText(v) {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function safeJson(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** `queue-<id>-<suffix>` → `<id>`, else null. Queue ids carry no dashes. */
function splitGroupOf(externalRef) {
  const m = /^queue-([A-Za-z0-9_]+)-(.+)$/.exec(String(externalRef || ''));
  return m ? m[1] : null;
}

const REFUSAL_LABELS = {
  no_linked_document: 'no certificate is linked to this lot (an order- or shipment-side lot)',
  document_links_several_lots: 'the certificate is linked to several lots and its metadata names a different one',
};

/**
 * @param {object} input
 * @param {string} input.tenantId
 * @param {string} input.runAt
 * @param {Array} input.lots   {id, lot_number, sub_lot_code, lot_key, production_date_status, first_seen_source}
 * @param {Array} input.links  {lot_id, document_id}
 * @param {Array} input.docs   {id, title, external_ref, primary_metadata, supplier_name, version_id, extracted_text, search_text}
 * @param {object} rules       injected shared functions (see header)
 */
function buildPlan(input, rules) {
  const {
    resolveProductionDate,
    legacyCodeDateAsProduction,
    combineProductionDates,
    rowScopedSearchText,
    normalizeLotNumber,
    normalizeSubLotCode,
    LEGACY_REFUSAL_WORDS,
  } = rules;

  const docsById = new Map(input.docs.map((d) => [d.id, { ...d, fields: safeJson(d.primary_metadata) }]));
  const lotsByDoc = new Map();
  const docsByLot = new Map();
  for (const l of input.links) {
    if (!docsById.has(l.document_id)) continue; // inactive or other-tenant document
    lotsByDoc.set(l.document_id, [...(lotsByDoc.get(l.document_id) || []), l.lot_id]);
    docsByLot.set(l.lot_id, [...(docsByLot.get(l.lot_id) || []), l.document_id]);
  }

  const updates = [];
  const skipped = [];
  const refusals = [];
  const counts = {
    lots_examined: input.lots.length,
    already_set: 0,
    by_source: { extracted: 0, extracted_code_date_legacy: 0 },
    by_status: { resolved: 0, ambiguous: 0, unparseable: 0, conflict: 0 },
    nothing_to_read: 0,
    legacy_disambiguated_by_page: 0,
  };

  for (const lot of input.lots) {
    const lotLabel = `${lot.lot_number}${lot.sub_lot_code ? `-${lot.sub_lot_code}` : ''}`;
    if (lot.production_date_status) {
      counts.already_set += 1;
      continue;
    }
    const docIds = docsByLot.get(lot.id) || [];
    if (docIds.length === 0) {
      skipped.push({ lot_id: lot.id, lot: lotLabel, reason: 'no_linked_document', detail: lot.first_seen_source || '' });
      continue;
    }
    const items = [];
    const reasons = [];
    for (const docId of docIds) {
      const doc = docsById.get(docId);
      const fields = doc.fields;
      const several = (lotsByDoc.get(docId) || []).length > 1;
      if (several) {
        const metaBase = normalizeLotNumber(fields.lot_number || fields.lot_code || '');
        const metaSub = normalizeSubLotCode(fields.sub_lot_code || fields.sub_lot_number || '');
        const key = lot.lot_key;
        if (!metaBase || (metaBase + metaSub !== key && metaBase !== key)) {
          reasons.push({ document_id: docId, title: doc.title, reason: 'document_links_several_lots' });
          continue;
        }
      }
      const extracted = resolveProductionDate(fields, 'extracted');
      if (extracted) {
        items.push({ ...extracted, document_id: docId });
        continue;
      }
      const legacy = legacyCodeDateAsProduction(fields, doc.extracted_text);
      if (legacy.ok) {
        items.push({ ...legacy.resolution, document_id: docId, supplier_name: doc.supplier_name });
      } else if (legacy.refusal !== 'no_code_date') {
        reasons.push({ document_id: docId, title: doc.title, reason: legacy.refusal, code_date: fields.code_date || null, supplier_name: doc.supplier_name });
      } else {
        reasons.push({ document_id: docId, title: doc.title, reason: 'no_code_date' });
      }
    }

    // Extraction beats inference: legacy values are used only when no linked
    // certificate states the production date itself — but a legacy value that
    // DISAGREES with an extracted one is kept in, so the conflict is seen.
    const extractedItems = items.filter((i) => i.source === 'extracted');
    const legacyItems = items.filter((i) => i.source !== 'extracted');
    let pool = items;
    if (extractedItems.length > 0 && legacyItems.length > 0) {
      const days = new Set(extractedItems.filter((i) => i.iso).map((i) => i.iso));
      const agreeing = legacyItems.every((i) => i.iso && days.has(i.iso));
      pool = agreeing ? extractedItems : items;
    }
    const combined = combineProductionDates(pool);
    if (!combined) {
      counts.nothing_to_read += 1;
      for (const r of reasons) refusals.push({ lot_id: lot.id, lot: lotLabel, ...r });
      continue;
    }
    if (combined.source === 'extracted_code_date_legacy' && combined.note && /reads two ways/.test(combined.note)) {
      counts.legacy_disambiguated_by_page += 1;
    }
    counts.by_source[combined.source] = (counts.by_source[combined.source] || 0) + 1;
    counts.by_status[combined.status] = (counts.by_status[combined.status] || 0) + 1;
    const sourceDoc = docsById.get(combined.document_id);
    updates.push({
      lot_id: lot.id,
      lot: lotLabel,
      production_date: combined.iso,
      production_date_raw: combined.raw,
      production_date_source: combined.source,
      production_date_status: combined.status,
      production_date_document_id: combined.document_id,
      note: combined.note,
      document_title: sourceDoc ? sourceDoc.title : null,
      supplier_name: sourceDoc ? sourceDoc.supplier_name : null,
    });
  }

  // ---- sibling text ------------------------------------------------------
  const groups = new Map();
  for (const d of docsById.values()) {
    const g = splitGroupOf(d.external_ref);
    if (!g) continue;
    groups.set(g, [...(groups.get(g) || []), d]);
  }
  const searchText = [];
  const tooLarge = [];
  let splitDocs = 0;
  let unchanged = 0;
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    for (const d of members) {
      splitDocs += 1;
      if (!d.version_id) continue;
      const siblings = members.filter((o) => o !== d).map((o) => o.fields);
      const scoped = rowScopedSearchText(d.extracted_text, d.fields, siblings);
      if (!scoped) {
        unchanged += 1;
        continue;
      }
      if (scoped.text === d.search_text) {
        unchanged += 1;
        continue;
      }
      if (Buffer.byteLength(scoped.text, 'utf8') > MAX_TEXT_BYTES) {
        tooLarge.push({ document_id: d.id, title: d.title });
        continue;
      }
      searchText.push({ document_id: d.id, version_id: d.version_id, title: d.title, search_text: scoped.text, blanked: scoped.blanked });
    }
  }

  return {
    tenantId: input.tenantId,
    runAt: input.runAt,
    updates,
    skipped,
    refusals,
    counts: { ...counts, lots_to_write: updates.length, split_documents: splitDocs, search_text_to_write: searchText.length, search_text_unchanged: unchanged },
    searchText,
    tooLarge,
    legacyRefusalWords: { ...REFUSAL_LABELS, ...LEGACY_REFUSAL_WORDS, no_code_date: 'no production date and no code date on the certificate' },
  };
}

function planToSql(plan) {
  const out = [];
  for (const u of plan.updates) {
    out.push(
      `UPDATE lots SET production_date = ${sqlText(u.production_date)}, production_date_raw = ${sqlText(u.production_date_raw)}, ` +
        `production_date_source = ${sqlText(u.production_date_source)}, production_date_status = ${sqlText(u.production_date_status)}, ` +
        `production_date_document_id = ${sqlText(u.production_date_document_id)}, updated_at = datetime('now') ` +
        `WHERE id = ${sqlText(u.lot_id)} AND production_date_status IS NULL;`
    );
  }
  return out;
}

function searchTextToSql(plan) {
  return plan.searchText.map(
    (s) => `UPDATE document_versions SET search_text = ${sqlText(s.search_text)} WHERE id = ${sqlText(s.version_id)};`
  );
}

function auditSql(plan) {
  const details = JSON.stringify({
    run_at: plan.runAt,
    lots_written: plan.updates.length,
    by_source: plan.counts.by_source,
    by_status: plan.counts.by_status,
    search_text_written: plan.searchText.length,
  });
  return (
    `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details)\n` +
    `VALUES (NULL, ${sqlText(plan.tenantId)}, 'lots.production_date_backfill', 'lots', ${sqlText(plan.runAt)}, ${sqlText(details)});`
  );
}

function batchStatements(statements, opts = {}) {
  const maxCount = opts.maxCount || 100;
  const maxBytes = opts.maxBytes || 400 * 1024;
  const batches = [];
  let current = [];
  let bytes = 0;
  for (const s of statements || []) {
    const size = Buffer.byteLength(s, 'utf8');
    if (current.length > 0 && (current.length >= maxCount || bytes + size > maxBytes)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(s);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function groupBy(list, key) {
  const m = new Map();
  for (const x of list) m.set(x[key], [...(m.get(x[key]) || []), x]);
  return m;
}

function formatPlan(plan, opts = {}) {
  const c = plan.counts;
  const out = [];
  const words = plan.legacyRefusalWords;
  out.push('');
  out.push(`Lot production date backfill — ${opts.targetLabel || plan.tenantId}`);
  out.push('='.repeat(72));
  out.push(`Run stamp ........................ ${plan.runAt}`);
  out.push(`Lots examined .................... ${c.lots_examined}`);
  out.push(`Already have a production date ... ${c.already_set} (never touched)`);
  out.push(`Lots to write .................... ${c.lots_to_write}`);
  out.push('');
  out.push('  By source');
  out.push(`    extracted (own production date field) ............ ${c.by_source.extracted || 0}`);
  out.push(`    extracted_code_date_legacy (code date, page-labelled) ${c.by_source.extracted_code_date_legacy || 0}`);
  out.push('  By status');
  out.push(`    resolved ......................................... ${c.by_status.resolved || 0}`);
  out.push(`    ambiguous (raw kept, no day) ..................... ${c.by_status.ambiguous || 0}`);
  out.push(`    unparseable (raw kept, no day) ................... ${c.by_status.unparseable || 0}`);
  out.push(`    conflict (certificates disagree, no day) ......... ${c.by_status.conflict || 0}`);
  if (c.legacy_disambiguated_by_page) {
    out.push(`  Legacy values that read two ways, settled by the day the page prints: ${c.legacy_disambiguated_by_page}`);
  }
  out.push(`  Lots with a certificate but nothing to read ...... ${c.nothing_to_read}`);
  out.push(`  Lots with no certificate linked .................. ${plan.skipped.length}`);
  out.push('');

  const unresolved = plan.updates.filter((u) => u.production_date_status !== 'resolved');
  if (unresolved.length > 0) {
    out.push(`Not resolved to a day — every one listed (${unresolved.length})`);
    out.push('-'.repeat(72));
    for (const u of unresolved) {
      out.push(`  [${u.production_date_status}] lot ${u.lot} · "${u.production_date_raw}" · ${u.production_date_source} · ${u.supplier_name || '?'} · ${u.document_title || u.production_date_document_id}`);
      if (u.note) out.push(`      ${u.note}`);
    }
    out.push('');
  }

  const legacy = plan.updates.filter((u) => u.production_date_source === 'extracted_code_date_legacy');
  if (legacy.length > 0) {
    out.push(`Legacy (code date read as production date) by supplier — ${legacy.length}`);
    out.push('-'.repeat(72));
    for (const [sup, list] of groupBy(legacy, 'supplier_name')) {
      out.push(`  ${list.length} × ${sup || '(no supplier)'}`);
      for (const u of list.slice(0, opts.listLimit || 5)) {
        out.push(`      lot ${u.lot} → ${u.production_date || '(no day)'} from "${u.production_date_raw}"${u.note ? ` — ${u.note}` : ''}`);
      }
      if (list.length > (opts.listLimit || 5)) out.push(`      … and ${list.length - (opts.listLimit || 5)} more.`);
    }
    out.push('');
  }

  if (plan.refusals.length > 0) {
    out.push(`Certificates not read as a production date — by reason (${plan.refusals.length})`);
    out.push('-'.repeat(72));
    for (const [reason, list] of groupBy(plan.refusals, 'reason')) {
      out.push(`  ${list.length} × ${words[reason] || reason}`);
      for (const [sup, bySup] of groupBy(list, 'supplier_name')) {
        if (sup) out.push(`      ${bySup.length} × ${sup}`);
      }
    }
    out.push('');
  }

  out.push('Sibling text (split certificates)');
  out.push('-'.repeat(72));
  out.push(`  Split documents on file .......... ${c.split_documents}`);
  out.push(`  search_text to write ............. ${c.search_text_to_write}`);
  out.push(`  already correct / nothing to blank ${c.search_text_unchanged}`);
  if (plan.tooLarge.length > 0) out.push(`  too large for one statement (left) ${plan.tooLarge.length}`);
  out.push('');
  return out;
}

module.exports = {
  buildPlan,
  planToSql,
  searchTextToSql,
  auditSql,
  batchStatements,
  formatPlan,
  splitGroupOf,
};
