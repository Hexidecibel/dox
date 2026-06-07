// =============================================================================
// COA multi-record assembly — PAGE-FIRST, no cross-page merge.
//
// Domain fact (verified against real prod docs): a multi-page COA PDF is N
// independent single-page COAs bundled by a PO/EDI order number. Each page is
// literally "Page 1 of 1" — a self-sufficient COA with its own full header
// (supplier, item#, lot#, plant, date). So:
//
//   • Each page = exactly ONE product. We split per page, ALWAYS, and NEVER
//     merge records across pages (the v1 bug stuffed all pages into one LLM
//     call and dropped all-but-one product; the fix is per-page extraction +
//     this page-first assembly).
//   • Within a page, that one product may have multiple lots/sublots → the LLM
//     emits one record per lot/sublot for that page. We keep them as-is.
//
// The worker runs one LLM call per PAGE (see buildPerPageChunks in
// bin/process-worker), so each parsed chunk here corresponds to exactly one
// page (oversized pages are sub-chunked but all sub-chunks carry the SAME page
// number, so they recombine into that one page's product).
//
// This module deterministically assembles every page's records into one
// CoaRecordsPayload:
//
//   1. For each page chunk: take its records (or synthesize ONE record from
//      the page's flat fields when the model returned no records[]). Tag each
//      with source_pages = [thatPageNumber].
//   2. CONCATENATE records across all pages. NEVER merge records across
//      different pages — two pages with a coincidentally equal lot number are
//      still two separate records.
//   3. Hoist ONLY fields byte-identical across ALL records of the WHOLE doc
//      into page_metadata (e.g. manufacturer/supplier, the bundle PO/EDI order
//      number). Product/lot/sublot/plant/dates vary per page → stay per-record.
//   4. Derive record_cardinality / record_key_basis, per-record confidence,
//      reindex 1..N across the whole doc.
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
// schema prefers lot_code / sub_lot_code. We accept either when keying.
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
 * Normalize a single PAGE's parsed output into an array of record objects, each
 * tagged with this page's number as `source_pages`. A page that already carries
 * structured `records[]` (one per lot/sublot) contributes those directly; a
 * flat-only page synthesizes exactly ONE record from its fields/tables (a page
 * is one product → one or more lots, but if the model returned no records[] we
 * treat the whole page as a single record). We never synthesize multiple
 * records from a flat page's products[] — a page is one product.
 *
 * @param {object} parsed   one parseExtraction() result for ONE page
 * @param {number[]} pages  the 1-based page number(s) this page-chunk covered
 *                          (normally a single page; sub-chunked oversized pages
 *                          are pre-collapsed by the worker to one page number)
 * @returns {Array<{fields, groups, tables, source_pages, _confidence, flags}>}
 */
function recordsFromPage(parsed, pages) {
  if (!parsed) return [];
  const chunkConf =
    typeof parsed.confidenceNum === 'number' && isFinite(parsed.confidenceNum)
      ? parsed.confidenceNum
      : null;

  // Structured path: the LLM emitted records for this page (one per lot/sublot).
  if (Array.isArray(parsed.records) && parsed.records.length > 0) {
    // The page may also carry page_metadata constant across its own records
    // (e.g. the page's product). Fold it back onto each record so the doc-wide
    // hoist later sees the full per-record field set (a page's product is NOT
    // doc-wide, so it must live on the record, not be lost in page_metadata).
    const pageMeta = parsed.page_metadata && typeof parsed.page_metadata === 'object'
      ? parsed.page_metadata
      : {};
    return parsed.records.map((r) => {
      const fields = {};
      for (const [k, v] of Object.entries(pageMeta)) {
        if (!isEmpty(v)) fields[k] = asString(v);
      }
      for (const [k, v] of Object.entries(r.fields || {})) {
        if (!isEmpty(v)) fields[k] = asString(v);
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

  // Flat path: the page is one product with (implicitly) one record. Synthesize
  // a single record from the page's fields + tables. We attach the product name
  // if products[] carried one (single-product page).
  const flatFields = {};
  for (const [k, v] of Object.entries(parsed.fields || {})) {
    if (!isEmpty(v)) flatFields[k] = asString(v);
  }
  const tables = Array.isArray(parsed.tables) ? parsed.tables : [];
  const products = Array.isArray(parsed.products) ? parsed.products.filter(Boolean) : [];

  // If the flat fields lack a product name but products[] named exactly one,
  // stamp it (each page is one product).
  if (isEmpty(firstNonEmpty(flatFields, PRODUCT_NAME_KEYS)) && products.length >= 1) {
    const p0 = products[0];
    flatFields.product_name = typeof p0 === 'string' ? p0 : asString(p0 && p0.product_name);
  }

  // A flat page with no fields, no products and no tables contributes nothing
  // (garbage / empty page).
  const hasAnyField = Object.values(flatFields).some((v) => !isEmpty(v));
  if (!hasAnyField && tables.length === 0) {
    return [];
  }

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

/**
 * Decide the key basis from the whole record set. This is descriptive only —
 * records are NEVER merged by key (page-first, no cross-page merge). It reports
 * what distinguishes records:
 *   - multiple distinct products → 'product'
 *   - one product, sublots present → 'lot+sublot'
 *   - one product, lots present → 'lot'
 *   - otherwise → 'product'
 */
function decideKeyBasis(records) {
  const distinctProducts = new Set(
    records
      .map((r) => firstNonEmpty(r.fields, PRODUCT_NAME_KEYS) || firstNonEmpty(r.fields, PRODUCT_CODE_KEYS) || '')
      .filter((p) => p !== '')
  );
  if (distinctProducts.size > 1) return 'product';

  const anyLot = records.some((r) => !isEmpty(firstNonEmpty(r.fields, LOT_KEYS)));
  const anySublot = records.some((r) => !isEmpty(firstNonEmpty(r.fields, SUBLOT_KEYS)));
  if (anySublot && anyLot) return 'lot+sublot';
  if (anyLot) return 'lot';
  return 'product';
}

/**
 * Hoist fields whose value is byte-identical AND non-empty across ALL records
 * of the WHOLE doc into page_metadata, deleting them from each record. With
 * correct per-page records, product/lot/etc. vary across pages and naturally
 * will NOT hoist; only genuinely doc-wide fields (manufacturer/supplier, the
 * bundle PO/EDI order number) do.
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
 * Assemble parsed PAGE chunks into a single CoaRecordsPayload — page-first,
 * with NO cross-page merge.
 *
 * @param {object[]} parsedChunks      array of parseExtraction() results, one per page, in page order.
 * @param {number[][]} chunkPageRanges array parallel to parsedChunks; each entry
 *                                     is the 1-based page number(s) that chunk covered
 *                                     (normally a single page).
 * @param {object} [opts]
 * @param {boolean} [opts.truncated]   true when a truncated single-call fallback
 *                                     fired → one record flagged 'truncated_multipage'.
 * @returns {import('../../shared/types').CoaRecordsPayload}
 */
function mergeCoaRecords(parsedChunks, chunkPageRanges, opts = {}) {
  const chunks = Array.isArray(parsedChunks) ? parsedChunks : [];
  const ranges = Array.isArray(chunkPageRanges) ? chunkPageRanges : [];

  // 1. Normalize each page to its records, tagged with that page's number.
  //    CONCATENATE across pages — never merge across pages.
  let records = [];
  for (let i = 0; i < chunks.length; i++) {
    const pages = Array.isArray(ranges[i]) ? ranges[i] : [];
    const recs = recordsFromPage(chunks[i], pages);
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

  // 2. Records are already concatenated (no merge). Flag any record with no
  //    explicit lot label so a reviewer fills it before approve.
  for (const rec of records) {
    const hasLot = !isEmpty(firstNonEmpty(rec.fields, LOT_KEYS));
    if (!hasLot) {
      rec.flags = [...new Set([...(rec.flags || []), 'lot_not_explicitly_labeled'])];
    }
  }

  // 3. Decide key basis (descriptive) from the full set.
  const keyBasis = decideKeyBasis(records);

  // 4. Hoist fields identical across ALL records (whole doc) into page_metadata.
  const pageMetadata = hoistSharedFields(records);

  // 5. Reindex + clean transient empties.
  records.forEach((r, i) => {
    r.record_index = i + 1;
    if (Array.isArray(r.flags) && r.flags.length === 0) delete r.flags;
    if (r.groups && Object.keys(r.groups).length === 0) delete r.groups;
  });

  // 6. Cardinality:
  //    single        → exactly one record total.
  //    multi_product → >1 distinct product across records.
  //    multi_lot     → one product, multiple lots/sublots (incl. single-page
  //                    multi-sublot).
  let cardinality;
  if (records.length <= 1) {
    cardinality = 'single';
  } else {
    const productHoisted =
      PRODUCT_NAME_KEYS.some((k) => !isEmpty(pageMetadata[k])) ||
      PRODUCT_CODE_KEYS.some((k) => !isEmpty(pageMetadata[k]));
    const distinctProducts = new Set(
      records
        .map((r) => firstNonEmpty(r.fields, PRODUCT_NAME_KEYS) || firstNonEmpty(r.fields, PRODUCT_CODE_KEYS) || '')
        .filter((p) => p !== '')
    );
    const multiProduct = !productHoisted && distinctProducts.size > 1;
    cardinality = multiProduct ? 'multi_product' : 'multi_lot';
  }

  return {
    record_cardinality: cardinality,
    record_key_basis: keyBasis,
    page_metadata: pageMetadata,
    records,
  };
}

module.exports = {
  mergeCoaRecords,
  // Exported for unit tests / reuse.
  recordsFromPage,
  decideKeyBasis,
  hoistSharedFields,
};
