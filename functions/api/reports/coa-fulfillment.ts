import { requireTenantAccess, BadRequestError, errorToResponse } from '../../lib/permissions';
import type { Env, User } from '../../lib/types';

/**
 * GET /api/reports/coa-fulfillment
 *
 * The daily COA-fulfillment view: one row per shipped order line, joined
 * across the entity graph (customer ▸ order ▸ lot ▸ COA), with each line
 * flagged for whether a COA is on file.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DEFINITION-SHAPED — first instance of a future generic report generator.
 *
 * This handler deliberately separates the four concerns a report definition
 * is made of, so a later generator can lift each into config:
 *
 *   1. selector  — `buildSelector()`     WHERE / date-range / customer filters
 *                                          + the bind params + tenant scope.
 *   2. shape     — `SHAPE_SQL` + the row    the SELECT / JOIN graph + ordering
 *                  type `FulfillmentRow`.    (what columns each row carries).
 *   3. gap_rules — `computeGap()`         per-row classification into one of
 *                                          ok | missing_lot | missing_coa |
 *                                          expired, computed server-side
 *                                          against an `as_of` date.
 *   4. format    — `formatJson()`         projection of rows + summary into
 *                                          the JSON response body (CSV/other
 *                                          formats would be sibling formatters).
 *
 * Keep these four blocks distinct. Don't fold them together; the whole point
 * is that a generator can later read a config object whose keys map 1:1 onto
 * { selector, shape, gap_rules, format }.
 * ───────────────────────────────────────────────────────────────────────────
 */

// ── shape: the row carried out of the join graph ────────────────────────────
interface FulfillmentRow {
  order_id: string;
  order_number: string;
  po_number: string | null;
  customer_name: string | null;
  product_id: string | null;
  product_name: string | null;
  product_code: string | null;
  quantity: number | null;
  lot_id: string | null;
  lot_number: string | null;
  // supplier_id is COA-side-first (matched COA's supplier), falling back to the
  // order-side lot's supplier — consistent with supplier_name's COALESCE.
  supplier_id: string | null;
  // Supplier + expiration are COA-side-first. The order-side lot carries
  // neither supplier (supplier_id is NULL on order-derived lots) nor a
  // reliable expiration, so a matched line takes both from the COA:
  //   supplier  ← documents.supplier_id → suppliers.name
  //   expiration← the COA's lot (document_lots → lots.expiration_date), or the
  //               COA doc's primary_metadata.expiration_date.
  // When no COA is matched, we fall back to the order-side lot.
  supplier_name: string | null;
  expiration_date: string | null;
  coa_document_id: string | null;
  coa_file_name: string | null;
  coa_match_status: string | null;
  order_created_at: string;
}

export type GapStatus = 'ok' | 'missing_lot' | 'missing_coa' | 'expired';

// For a `missing_coa` line, is the product even known to us?
//   have_other_lot — a COA for this distributor code exists (for a different
//                    lot). Actionable: collect THIS lot's COA; it'll auto-link.
//   none_on_file   — no COA on file for this product code at all.
export type CoaAvailability = 'have_other_lot' | 'none_on_file' | null;

/** Normalize a distributor code for comparison (trim + upper). Empty → null. */
function normCode(c: string | null | undefined): string | null {
  const s = (c ?? '').trim().toUpperCase();
  return s === '' ? null : s;
}
/** Leading-zero-stripped variant, so "0708" and "708" compare equal. */
function stripZeros(c: string): string {
  return c.replace(/^0+/, '') || c;
}

/**
 * The set of distributor codes that appear as a leading "(NNNN)" prefix on any
 * active COA title in this tenant — both normalized and zero-stripped forms,
 * so membership matches the matcher's code-agreement rule.
 */
async function loadCoaCodeSet(
  db: import('@cloudflare/workers-types').D1Database,
  tenantId: string
): Promise<Set<string>> {
  const rows = await db
    .prepare(
      `SELECT DISTINCT UPPER(TRIM(substr(title, 2, instr(title, ')') - 2))) AS code
       FROM documents
       WHERE tenant_id = ? AND status = 'active' AND title LIKE '(%)%'`
    )
    .bind(tenantId)
    .all<{ code: string | null }>();
  const set = new Set<string>();
  for (const r of rows.results ?? []) {
    const c = normCode(r.code);
    if (c) {
      set.add(c);
      set.add(stripZeros(c));
    }
  }
  return set;
}

function computeAvailability(productCode: string | null, codeSet: Set<string>): CoaAvailability {
  const c = normCode(productCode);
  if (!c) return 'none_on_file';
  if (codeSet.has(c) || codeSet.has(stripZeros(c))) return 'have_other_lot';
  return 'none_on_file';
}

// ── shape: the SELECT + JOIN graph ──────────────────────────────────────────
//
// One row per order line. Customer name prefers the resolved customers.name
// but falls back to the denormalized orders.customer_name (older rows / rows
// created before a customer entity existed). The COA file name comes from the
// current version of the linked document.
//
// Supplier + expiration are COA-side-first (COALESCE the COA source ahead of
// the order-side lot):
//   supplier   = COA doc's supplier  → fall back to order-lot's supplier
//   expiration = COA's lot expiration → COA doc primary_metadata.expiration_date
//                → fall back to the order-side lot's expiration
// The COA's lot is reached via document_lots; we pick the most recently linked
// lot that actually carries an expiration so a stale link can't blank it out.
const SHAPE_SQL = `
  SELECT
    o.id                  AS order_id,
    o.order_number        AS order_number,
    o.po_number           AS po_number,
    COALESCE(cust.name, o.customer_name) AS customer_name,
    oi.product_id         AS product_id,
    oi.product_name       AS product_name,
    oi.product_code       AS product_code,
    oi.quantity           AS quantity,
    oi.lot_id             AS lot_id,
    l.lot_number          AS lot_number,
    COALESCE(coa_sup.id, sup.id)     AS supplier_id,
    COALESCE(coa_sup.name, sup.name) AS supplier_name,
    COALESCE(
      coa_lot.expiration_date,
      json_extract(d.primary_metadata, '$.expiration_date'),
      l.expiration_date
    )                     AS expiration_date,
    oi.coa_document_id    AS coa_document_id,
    dv.file_name          AS coa_file_name,
    oi.coa_match_status   AS coa_match_status,
    o.created_at          AS order_created_at
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  LEFT JOIN customers cust ON cust.id = o.customer_id
  LEFT JOIN lots l ON l.id = oi.lot_id
  LEFT JOIN suppliers sup ON sup.id = l.supplier_id
  LEFT JOIN documents d ON d.id = oi.coa_document_id
  LEFT JOIN suppliers coa_sup ON coa_sup.id = d.supplier_id
  LEFT JOIN document_versions dv
    ON dv.document_id = d.id AND dv.version_number = d.current_version
  LEFT JOIN lots coa_lot ON coa_lot.id = (
    SELECT dl.lot_id
    FROM document_lots dl
    JOIN lots ll ON ll.id = dl.lot_id
    WHERE dl.document_id = d.id
    ORDER BY (ll.expiration_date IS NULL), dl.created_at DESC
    LIMIT 1
  )
`;

interface Selector {
  where: string;
  params: (string | number)[];
}

// ── selector: WHERE / date-range / customer filters + tenant scope ──────────
function buildSelector(opts: {
  tenantId: string;
  from: string | null;
  to: string | null;
  customerId: string | null;
}): Selector {
  // Staged (not-yet-approved) orders are excluded — they aren't "real"
  // shipped lines yet. Mirrors the orders list default.
  const conditions: string[] = ['o.tenant_id = ?', 'o.staged_at IS NULL'];
  const params: (string | number)[] = [opts.tenantId];

  if (opts.from) {
    conditions.push('o.created_at >= ?');
    params.push(opts.from);
  }
  if (opts.to) {
    // Inclusive end-of-day for a bare date.
    conditions.push('o.created_at <= ?');
    params.push(opts.to.length === 10 ? `${opts.to}T23:59:59` : opts.to);
  }
  if (opts.customerId) {
    conditions.push('o.customer_id = ?');
    params.push(opts.customerId);
  }

  return { where: `WHERE ${conditions.join(' AND ')}`, params };
}

// ── gap_rules: classify a single row, server-side, against `asOf` ───────────
//
// Order of precedence (first match wins):
//   missing_lot  — the line has no lot linked.
//   missing_coa  — has a lot, but no COA document and no 'matched' COA status.
//   expired      — has a lot + COA, but the lot's expiration_date < asOf.
//   ok           — otherwise.
function computeGap(row: FulfillmentRow, asOf: string): GapStatus {
  if (!row.lot_id) return 'missing_lot';

  const hasCoa = !!row.coa_document_id || row.coa_match_status === 'matched';
  if (!hasCoa) return 'missing_coa';

  // Compare dates lexicographically — ISO 'YYYY-MM-DD' (or with time) sorts
  // chronologically, so a plain string compare is correct and deterministic.
  if (row.expiration_date && row.expiration_date < asOf) return 'expired';

  return 'ok';
}

interface Summary {
  total: number;
  ok: number;
  missing_lot: number;
  missing_coa: number;
  expired: number;
  coverage_pct: number;
  // Within missing_coa: product is known (a COA exists for the code) → collect
  // this lot's COA; vs no COA on file for the product at all.
  collectible: number;
  no_product_coa: number;
}

// ── format: project rows + summary into the JSON body ───────────────────────
function formatJson(rows: FulfillmentRow[], asOf: string, codeSet: Set<string>) {
  const summary: Summary = {
    total: rows.length,
    ok: 0,
    missing_lot: 0,
    missing_coa: 0,
    expired: 0,
    coverage_pct: 0,
    collectible: 0,
    no_product_coa: 0,
  };

  const out = rows.map((r) => {
    const gap = computeGap(r, asOf);
    summary[gap] += 1;
    // Only meaningful for a line that has a lot but no COA.
    const availability: CoaAvailability =
      gap === 'missing_coa' ? computeAvailability(r.product_code, codeSet) : null;
    if (availability === 'have_other_lot') summary.collectible += 1;
    if (availability === 'none_on_file') summary.no_product_coa += 1;
    return {
      order_id: r.order_id,
      order_number: r.order_number,
      po_number: r.po_number,
      customer_name: r.customer_name,
      product_id: r.product_id,
      product_name: r.product_name,
      product_code: r.product_code,
      quantity: r.quantity,
      lot_id: r.lot_id,
      lot_number: r.lot_number,
      supplier_id: r.supplier_id,
      supplier_name: r.supplier_name,
      expiration_date: r.expiration_date,
      coa_document_id: r.coa_document_id,
      coa_file_name: r.coa_file_name,
      coa_match_status: r.coa_match_status,
      gap,
      coa_availability: availability,
    };
  });

  // Coverage = share of lines that are fully OK (lot + COA + not expired).
  summary.coverage_pct = summary.total === 0
    ? 0
    : Math.round((summary.ok / summary.total) * 1000) / 10;

  return { rows: out, summary };
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);

    // ── tenant scope ──────────────────────────────────────────────────────
    let tenantId = url.searchParams.get('tenant_id');
    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }
    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }
    requireTenantAccess(user, tenantId);

    // ── params for selector + gap_rules ───────────────────────────────────
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const customerId = url.searchParams.get('customer_id');
    // `as_of` keeps expiry deterministic/testable — callers (and tests) can
    // pin "today". Default to the server's current UTC date when absent.
    const asOf = url.searchParams.get('as_of') || new Date().toISOString().slice(0, 10);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 1000);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    // 1. selector
    const selector = buildSelector({ tenantId, from, to, customerId });

    // 2. shape — assemble the full statement
    const sql = `${SHAPE_SQL} ${selector.where}
      ORDER BY o.created_at DESC, o.id, oi.created_at
      LIMIT ? OFFSET ?`;

    const result = await context.env.DB.prepare(sql)
      .bind(...selector.params, limit, offset)
      .all<FulfillmentRow>();

    // Distributor codes we hold ANY COA for — drives the collect-vs-absent hint.
    const codeSet = await loadCoaCodeSet(context.env.DB, tenantId);

    // 3. gap_rules + 4. format
    const body = formatJson(result.results || [], asOf, codeSet);

    return new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('COA fulfillment report error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
