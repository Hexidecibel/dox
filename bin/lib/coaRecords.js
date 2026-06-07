// =============================================================================
// COA multi-record assembly — deterministic cross-chunk merge.
//
// This is the load-bearing "P1" assembly for first-class multi-product /
// multi-lot / multi-page COAs (see coa-multi-record.md). The LLM extracts
// per-chunk (one chunk = one or more page banners), but it is BLIND across
// chunk boundaries — page 4 is its own Qwen call and cannot see page 1's
// cardinality. So the worker runs each chunk independently and then this
// module deterministically assembles every chunk's records into ONE
// CoaRecordsPayload:
//
//   1. Normalize each chunk's output to records (flat chunk with no `records[]`
//      → one record per `products[]` entry, or a single record).
//   2. Tag each record with its chunk's page numbers (source_pages).
//   3. Decide record_key_basis (lot+sublot > lot > product).
//   4. Key + merge records that share a non-empty key across chunk boundaries.
//   5. Hoist fields identical+non-empty across ALL records into page_metadata
//      (the over-split guard).
//   6. Derive record_cardinality, per-record confidence, reindex.
//
// CommonJS so the plain-Node `bin/process-worker` can `require()` it (the
// worker has no TS build step). Mirror of the types in shared/types.ts —
// keep field naming in sync. Unit-tested directly in
// tests/unit/coa-merge-records.test.ts.
// =============================================================================

const isEmpty = (v) => v == null || (typeof v === 'string' && v.trim() === '');

const asString = (v) => (v == null ? null : String(v));

// Field keys that identify a lot / sublot / product. The flat extraction uses
// canonical names (lot_number, product_name, product_code) but the record
// schema prefers lot_code / sub_lot_code. We accept either when keying so a
// chunk's flat `fields` and a chunk's structured `records[]` key consistently.
const LOT_KEYS = ['lot_code', 'lot_number'];
const SUBLOT_KEYS = ['sub_lot_code', 'sub_lot_number', 'sublot_code', 'sublot'];
const PRODUCT_NAME_KEYS = ['product_name', 'product'];
const PRODUCT_CODE_KEYS = ['product_code', 'item_code', 'item_number', 'sku'];

function firstNonEmpty(fields, keys) {
  for (const k of keys) {
    if (!isEmpty(fields[k])) return asString(fields[k]);
  }
  return null;
}

/**
 * Normalize a single parsed chunk into an array of record objects, each tagged
 * with `source_pages`. A chunk that already carries structured `records[]`
 * contributes those directly; a flat-only chunk synthesizes one record per
 * `products[]` entry (or a single record carrying the chunk's fields/tables
 * when 0 or 1 products).
 *
 * @param {object} parsed   one parseExtraction() result
 * @param {number[]} pages  the 1-based page numbers this chunk covered
 * @returns {Array<{fields, groups, tables, source_pages, _confidence, flags}>}
 */
function recordsFromChunk(parsed, pages) {
  if (!parsed) return [];
  const chunkConf =
    typeof parsed.confidenceNum === 'number' && isFinite(parsed.confidenceNum)
      ? parsed.confidenceNum
      : null;

  // Structured path: the LLM emitted records for this chunk.
  if (Array.isArray(parsed.records) && parsed.records.length > 0) {
    return parsed.records.map((r) => {
      const fields = {};
      for (const [k, v] of Object.entries(r.fields || {})) {
        fields[k] = asString(v);
      }
      const recConf =
        typeof r._confidence === 'number' && isFinite(r._confidence)
          ? r._confidence
          : chunkConf;
      return {
        fields,
        groups: r.groups && typeof r.groups === 'object' ? r.groups : undefined,
        tables: Array.isArray(r.tables) ? r.tables : [],
        source_pages: pages.slice(),
        _confidence: recConf,
        flags: Array.isArray(r.flags) ? r.flags.slice() : [],
      };
    });
  }

  // Flat path: synthesize records from products[]. The chunk's flat `fields`
  // describe the cover/header; when there are multiple products we attach the
  // product name onto each synthesized record so product-basis keying works.
  const flatFields = {};
  for (const [k, v] of Object.entries(parsed.fields || {})) {
    flatFields[k] = asString(v);
  }
  const tables = Array.isArray(parsed.tables) ? parsed.tables : [];
  const products = Array.isArray(parsed.products) ? parsed.products.filter(Boolean) : [];

  // A flat chunk with no fields and no products contributes nothing (garbage
  // / empty page).
  const hasAnyField = Object.values(flatFields).some((v) => !isEmpty(v));
  if (!hasAnyField && products.length === 0 && tables.length === 0) {
    return [];
  }

  if (products.length <= 1) {
    return [
      {
        fields: flatFields,
        groups: undefined,
        tables,
        source_pages: pages.slice(),
        _confidence: chunkConf,
        flags: [],
      },
    ];
  }

  // Multiple products on a flat chunk → one record per product. Each carries
  // the chunk's shared fields plus its own product_name. Tables are attached
  // to the first record only (we can't reliably split a flat table per product
  // without structure); the hoist guard later moves shared fields up.
  return products.map((prod, idx) => {
    const fields = { ...flatFields };
    // Only stamp product_name when the flat fields didn't already carry a
    // single product name (avoid clobbering an explicit single value).
    fields.product_name = typeof prod === 'string' ? prod : asString(prod && prod.product_name);
    return {
      fields,
      groups: undefined,
      tables: idx === 0 ? tables : [],
      source_pages: pages.slice(),
      _confidence: chunkConf,
      flags: [],
    };
  });
}

/** Decide the key basis from the whole record set. */
function decideKeyBasis(records) {
  const anyLot = records.some((r) => !isEmpty(firstNonEmpty(r.fields, LOT_KEYS)));
  const anySublot = records.some((r) => !isEmpty(firstNonEmpty(r.fields, SUBLOT_KEYS)));
  if (anySublot && anyLot) return 'lot+sublot';
  if (anyLot) return 'lot';
  return 'product';
}

/**
 * Compute a record's merge key for a given basis. Returns null when the
 * record has no usable key value (those are kept distinct, never merged).
 */
function recordKey(record, basis) {
  const f = record.fields;
  if (basis === 'lot' || basis === 'lot+sublot') {
    const lot = firstNonEmpty(f, LOT_KEYS);
    if (isEmpty(lot)) return null;
    if (basis === 'lot+sublot') {
      const sub = firstNonEmpty(f, SUBLOT_KEYS);
      return isEmpty(sub) ? `lot:${lot}` : `lot:${lot}|sub:${sub}`;
    }
    return `lot:${lot}`;
  }
  // product basis
  const name = firstNonEmpty(f, PRODUCT_NAME_KEYS);
  const code = firstNonEmpty(f, PRODUCT_CODE_KEYS);
  if (isEmpty(name) && isEmpty(code)) return null;
  return `prod:${name || ''}|code:${code || ''}`;
}

/** Merge record `b` into record `a` (same key) in place. */
function mergeInto(a, b) {
  // fields: first non-empty wins (a is the incumbent).
  for (const [k, v] of Object.entries(b.fields || {})) {
    if (!isEmpty(v) && isEmpty(a.fields[k])) a.fields[k] = v;
  }
  // tables: concat.
  if (Array.isArray(b.tables) && b.tables.length > 0) {
    a.tables = (a.tables || []).concat(b.tables);
  }
  // groups: shallow-merge group-by-group (first non-empty cell wins).
  if (b.groups) {
    a.groups = a.groups || {};
    for (const [g, cells] of Object.entries(b.groups)) {
      a.groups[g] = a.groups[g] || {};
      for (const [cellKey, cell] of Object.entries(cells || {})) {
        if (a.groups[g][cellKey] === undefined) a.groups[g][cellKey] = cell;
      }
    }
  }
  // source_pages: union, sorted.
  const pages = new Set([...(a.source_pages || []), ...(b.source_pages || [])]);
  a.source_pages = [...pages].sort((x, y) => x - y);
  // confidence: min (null-safe — a present number always beats null).
  if (typeof b._confidence === 'number') {
    a._confidence =
      typeof a._confidence === 'number' ? Math.min(a._confidence, b._confidence) : b._confidence;
  }
  // flags: union.
  const flags = new Set([...(a.flags || []), ...(b.flags || [])]);
  a.flags = [...flags];
}

/**
 * Hoist fields whose value is identical AND non-empty across ALL records into
 * page_metadata, deleting them from each record. This is the over-split guard:
 * a field the LLM repeated on every record (e.g. manufacturer, coa_number)
 * is document-level metadata, not a per-record distinguisher.
 *
 * Mutates `records` in place; returns the page_metadata object.
 */
function hoistSharedFields(records) {
  const pageMetadata = {};
  if (records.length === 0) return pageMetadata;

  // Collect the union of all field keys.
  const allKeys = new Set();
  for (const r of records) {
    for (const k of Object.keys(r.fields)) allKeys.add(k);
  }

  for (const key of allKeys) {
    const first = records[0].fields[key];
    if (isEmpty(first)) continue;
    let identical = true;
    for (const r of records) {
      if (asString(r.fields[key]) !== asString(first)) {
        identical = false;
        break;
      }
    }
    if (identical) {
      pageMetadata[key] = asString(first);
      for (const r of records) delete r.fields[key];
    }
  }
  return pageMetadata;
}

/**
 * Assemble parsed chunks into a single CoaRecordsPayload.
 *
 * @param {object[]} parsedChunks      array of parseExtraction() results, in chunk order.
 * @param {number[][]} chunkPageRanges array parallel to parsedChunks; each entry
 *                                     is the 1-based page numbers that chunk covered.
 * @param {object} [opts]
 * @param {boolean} [opts.truncated]   true when the >TEXT_MAX_CHUNKS fallback fired
 *                                     (single truncated extraction) → one record
 *                                     flagged 'truncated_multipage'.
 * @returns {import('../../shared/types').CoaRecordsPayload}
 */
function mergeCoaRecords(parsedChunks, chunkPageRanges, opts = {}) {
  const chunks = Array.isArray(parsedChunks) ? parsedChunks : [];
  const ranges = Array.isArray(chunkPageRanges) ? chunkPageRanges : [];

  // 1+2. Normalize each chunk to records tagged with its pages.
  let records = [];
  for (let i = 0; i < chunks.length; i++) {
    const pages = Array.isArray(ranges[i]) ? ranges[i] : [];
    const recs = recordsFromChunk(chunks[i], pages);
    records.push(...recs);
  }

  // Truncation fallback: a single truncated extraction → one flagged record.
  if (opts.truncated) {
    if (records.length === 0) {
      records = [{ fields: {}, tables: [], source_pages: [], _confidence: null, flags: [] }];
    }
    // Collapse to a single record (the fallback only ever ran one call) and flag.
    const head = records[0];
    head.flags = [...new Set([...(head.flags || []), 'truncated_multipage'])];
    records = [head];
  }

  // No records at all (all garbage/empty) → return an empty single payload.
  if (records.length === 0) {
    return {
      record_cardinality: 'single',
      record_key_basis: 'product',
      page_metadata: {},
      records: [],
    };
  }

  // 3. Decide key basis from the full set.
  const keyBasis = decideKeyBasis(records);

  // 4. Key + merge records sharing a non-empty key. Null-key records are kept
  //    distinct and flagged.
  const byKey = new Map();
  const merged = [];
  for (const rec of records) {
    const key = recordKey(rec, keyBasis);
    if (key == null) {
      if (keyBasis !== 'product') {
        rec.flags = [...new Set([...(rec.flags || []), 'lot_not_explicitly_labeled'])];
      }
      merged.push(rec);
      continue;
    }
    if (byKey.has(key)) {
      mergeInto(byKey.get(key), rec);
    } else {
      byKey.set(key, rec);
      merged.push(rec);
    }
  }

  // 5. Hoist fields identical across ALL surviving records into page_metadata.
  const pageMetadata = hoistSharedFields(merged);

  // 6. Reindex + decide cardinality.
  merged.forEach((r, i) => {
    r.record_index = i + 1;
    // Drop the transient empty-flags array to keep the payload clean, but keep
    // non-empty flags.
    if (Array.isArray(r.flags) && r.flags.length === 0) delete r.flags;
    if (r.groups && Object.keys(r.groups).length === 0) delete r.groups;
  });

  let cardinality;
  if (merged.length <= 1) {
    cardinality = 'single';
  } else {
    // Multi-lot when product is shared across all records (i.e. product got
    // hoisted into page_metadata, or every record carries the same product),
    // and they differ by lot/sublot. Otherwise multi_product.
    const productHoisted = PRODUCT_NAME_KEYS.some((k) => !isEmpty(pageMetadata[k]));
    const distinctProducts = new Set(
      merged.map((r) => firstNonEmpty(r.fields, PRODUCT_NAME_KEYS) || '')
    );
    const productShared = productHoisted || distinctProducts.size <= 1;
    cardinality = productShared ? 'multi_lot' : 'multi_product';
  }

  return {
    record_cardinality: cardinality,
    record_key_basis: keyBasis,
    page_metadata: pageMetadata,
    records: merged,
  };
}

module.exports = {
  mergeCoaRecords,
  // Exported for unit tests / reuse.
  recordsFromChunk,
  decideKeyBasis,
  recordKey,
  hoistSharedFields,
};
