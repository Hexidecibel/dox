/**
 * An order's lines, filled by a PERSON (migration 0134).
 *
 * WHY THIS EXISTS
 * ---------------
 * The basic tier of COA fulfillment has no WMS feed. A person does what the
 * matching engine does on the automatic tier: names the product and lot on
 * each line and puts the approved certificate on it. Until this module the
 * only writer of a line's certificate was accepting an engine suggestion
 * (functions/api/lot-matches/[id].ts), and no endpoint added a line at all.
 *
 * ONE ORDER RECORD FOR BOTH TIERS. A pick writes EXACTLY the columns an
 * accepted suggestion writes -- coa_document_id, lot_id, lot_matched = 1,
 * coa_match_status = 'matched', coa_matched_at -- so the fulfillment report,
 * the lot register's counts and search coverage all read a hand-built line the
 * way they read an engine-fed one. It also writes an 'accepted'
 * `lot_match_suggestions` row (`match_basis = 'manual_pick'`): that row is how
 * every reader tells "a person accepted this" from "linked before matches
 * became suggestions", and it is what stops the matcher arguing with the pick
 * -- `recordSuggestion` (entities/matching.ts) never reopens an accepted or
 * rejected pair, and never re-suggests the document a line already carries.
 *
 * APPROVED DOCUMENTS ONLY. A pick is an active document of the order's own
 * organization with a file behind it: never an archived or deleted one, never
 * another organization's, never a Review Queue item. Nothing here asks what
 * TYPE the document is -- the same order will carry non-COA documents when
 * document orders for sales arrive, and the line shape already allows it.
 *
 * ONE LINE PER LOT ROW. A certificate that certifies three lots becomes three
 * lines, each naming its own lot, so the product, lot and production date a
 * person checks before sending are that row's and nobody else's.
 */

import { generateId, logAudit } from './db';
import { BadRequestError, ConflictError, NotFoundError } from './permissions';
import { sanitizeString } from './validation';
import { findOrCreateLot, normalizeLotNumber } from './entities/lots';
import { linkOrderToCoas, parseDistributorCode } from './entities/matching';
import { orderSideSchemeResolver } from './lot-schemes';
import { holdForLot, loadActiveHolds } from './hold-state';
import { resolveWholeOriginals } from './coa-original';
import { describeLotDate } from '../../shared/orderSend';
import type { User } from './types';
import type {
  ApiOrderItem,
  OrderItemUpdateRequest,
  OrderItemsAddRequest,
  OrderItemsAddResponse,
  OrderPickResult,
} from '../../shared/types';

/** Documents one pick request may name. A select-all on a broad search is not an order. */
export const ORDER_PICK_MAX_DOCUMENTS = 50;

/** The words stored beside a hand pick, shown wherever a suggestion's basis is. */
export const MANUAL_PICK_NOTE = 'Picked by hand on the order.';

export interface OrderWriteRow {
  id: string;
  tenant_id: string;
  order_number: string;
  po_number: string | null;
  customer_id: string | null;
  customer_name: string | null;
  status: string;
  staged_at: string | null;
  ship_date: string | null;
}

/**
 * The order a line write is about. A STAGED order (a low-confidence connector
 * extraction still waiting for approve-staged) is refused: that flow edits its
 * own lines, and a hand pick on a record nobody has approved yet would be
 * approved along with it unseen.
 */
export async function loadOrderForLineWrite(db: D1Database, orderId: string): Promise<OrderWriteRow> {
  const order = await db
    .prepare(
      `SELECT id, tenant_id, order_number, po_number, customer_id, customer_name, status, staged_at, ship_date
         FROM orders WHERE id = ?`,
    )
    .bind(orderId)
    .first<OrderWriteRow>();
  if (!order) throw new NotFoundError('Order not found');
  return order;
}

/**
 * Another organization's order answers 404, never 403: the id must not be
 * usable to learn that an order exists somewhere else.
 */
export function requireOrderAccess(user: Pick<User, 'role' | 'tenant_id'>, order: OrderWriteRow): void {
  if (user.role !== 'super_admin' && order.tenant_id !== user.tenant_id) {
    throw new NotFoundError('Order not found');
  }
}

/** YYYY-MM-DD that is a real calendar day, or null for empty. Throws on anything else. */
export function parseShipDate(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const v = typeof raw === 'string' ? raw.trim() : '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!m || !d || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    throw new BadRequestError('ship_date must be a date in the form YYYY-MM-DD.');
  }
  return v;
}

/** The customer an order names, when it is this organization's. Throws otherwise. */
export async function requireTenantCustomer(
  db: D1Database,
  tenantId: string,
  customerId: string,
): Promise<{ id: string; name: string; customer_number: string; email: string | null }> {
  const c = await db
    .prepare('SELECT id, name, customer_number, email FROM customers WHERE id = ? AND tenant_id = ?')
    .bind(customerId, tenantId)
    .first<{ id: string; name: string; customer_number: string; email: string | null }>();
  if (!c) throw new BadRequestError('That customer is not in this organization.');
  return c;
}

export function refuseStaged(order: OrderWriteRow): void {
  if (order.staged_at) {
    throw new ConflictError(
      'This order is still waiting for review of what the connector read. Approve it first, then change its lines.',
    );
  }
}

// ---------------------------------------------------------------------------
// Reading the lines
// ---------------------------------------------------------------------------

/**
 * Every line of an order with what a person needs to see before sending:
 * the product, the linked lot row and its production date WITH its doubt, the
 * certificate on the line, who put it there, how big its file is, and whether
 * the whole original of a per-lot page is on file.
 */
export async function loadOrderLines(
  db: D1Database,
  files: R2Bucket,
  tenantId: string,
  orderId: string,
): Promise<ApiOrderItem[]> {
  const res = await db
    .prepare(
      `SELECT oi.*,
              p.name  AS product_name_resolved,
              d.title AS coa_document_title,
              d.status AS coa_document_status,
              dt.name AS coa_document_type_name,
              s.name  AS coa_supplier_name,
              dv.file_size AS coa_file_size,
              l.lot_number AS lot_row_number,
              l.sub_lot_code AS sub_lot_code,
              l.production_date AS production_date,
              l.production_date_raw AS production_date_raw,
              l.production_date_status AS production_date_status,
              l.production_date_source AS production_date_source,
              u.name  AS picked_by_name
         FROM order_items oi
         LEFT JOIN products p        ON p.id  = oi.product_id
         LEFT JOIN documents d       ON d.id  = oi.coa_document_id AND d.tenant_id = ?
         LEFT JOIN document_types dt ON dt.id = d.document_type_id
         LEFT JOIN suppliers s       ON s.id  = d.supplier_id
         LEFT JOIN document_versions dv
                ON dv.document_id = d.id AND dv.version_number = d.current_version
         LEFT JOIN lots l            ON l.id  = oi.lot_id AND l.tenant_id = ?
         LEFT JOIN users u           ON u.id  = oi.picked_by
        WHERE oi.order_id = ?
        ORDER BY oi.created_at ASC, oi.rowid ASC`,
    )
    .bind(tenantId, tenantId, orderId)
    .all<ApiOrderItem>();
  const rows = res.results ?? [];

  const docIds = [...new Set(rows.map((r) => r.coa_document_id).filter((v): v is string => Boolean(v)))];
  const originals = await resolveWholeOriginals(db, files, tenantId, docIds);
  // Holds (0139), read live: the line shows that its certificate is on hold
  // and why. The hold on the line's own lot row is named when there is one;
  // a hold on another lot of the same file stops the file just the same.
  const holds = await loadActiveHolds(db, tenantId, docIds);

  return rows.map((r) => {
    const date = describeLotDate(r.lot_id ? r : null);
    const original = r.coa_document_id ? originals.get(r.coa_document_id) : null;
    return {
      ...r,
      production_date_state: date.state,
      production_date_label: date.label,
      production_date_note: date.note,
      coa_original: original ? original.state : null,
      coa_hold: r.coa_document_id ? holdForLot(holds.get(r.coa_document_id), r.lot_id) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Picking documents
// ---------------------------------------------------------------------------

interface PickDocument {
  id: string;
  title: string;
  status: string;
  current_version: number;
  has_file: number;
  product_name_meta: string | null;
}

interface PickLot {
  document_id: string;
  lot_id: string;
  lot_number: string;
  sub_lot_code: string | null;
  lot_key: string;
  product_id: string | null;
  product_name: string | null;
}

interface ExistingLine {
  id: string;
  lot_id: string | null;
  lot_number: string | null;
  coa_document_id: string | null;
}

function normalizeIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const id = v.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Why a document may not go on an order, or null when it may. The tenant
 * filter is in the SQL that loaded `doc`; an id from elsewhere never reaches
 * here and is reported with the same words as one that never existed.
 */
function pickRefusal(doc: PickDocument | undefined): string | null {
  if (!doc) return 'Not a document in this organization.';
  if (doc.status !== 'active') {
    return `This document is ${doc.status}. Only approved, active documents can go on an order.`;
  }
  if (!doc.has_file) return 'This document has no file on record, so there is nothing to send.';
  return null;
}

async function loadPickDocuments(db: D1Database, tenantId: string, ids: string[]): Promise<Map<string, PickDocument>> {
  const out = new Map<string, PickDocument>();
  if (ids.length === 0) return out;
  const res = await db
    .prepare(
      `SELECT d.id, d.title, d.status, d.current_version,
              EXISTS (SELECT 1 FROM document_versions dv
                       WHERE dv.document_id = d.id AND dv.version_number = d.current_version) AS has_file,
              CASE WHEN json_valid(d.primary_metadata)
                   THEN json_extract(d.primary_metadata, '$.product_name') END AS product_name_meta
         FROM documents d
        WHERE d.tenant_id = ? AND d.id IN (${ids.map(() => '?').join(', ')})`,
    )
    .bind(tenantId, ...ids)
    .all<PickDocument>();
  for (const r of res.results ?? []) out.set(r.id, r);
  return out;
}

async function loadPickLots(db: D1Database, tenantId: string, ids: string[]): Promise<Map<string, PickLot[]>> {
  const out = new Map<string, PickLot[]>();
  if (ids.length === 0) return out;
  const res = await db
    .prepare(
      `SELECT dl.document_id, l.id AS lot_id, l.lot_number, l.sub_lot_code, l.lot_key,
              l.product_id, p.name AS product_name
         FROM document_lots dl
         INNER JOIN lots l ON l.id = dl.lot_id
         LEFT JOIN products p ON p.id = l.product_id
        WHERE l.tenant_id = ? AND dl.document_id IN (${ids.map(() => '?').join(', ')})
        ORDER BY l.lot_number ASC, l.sub_lot_code ASC`,
    )
    .bind(tenantId, ...ids)
    .all<PickLot>();
  for (const r of res.results ?? []) out.set(r.document_id, [...(out.get(r.document_id) ?? []), r]);
  return out;
}

/** The single product a document is linked to, when it is linked to exactly one. */
async function loadSoleProducts(
  db: D1Database,
  ids: string[],
): Promise<Map<string, { id: string; name: string }>> {
  const out = new Map<string, { id: string; name: string }>();
  if (ids.length === 0) return out;
  const res = await db
    .prepare(
      `SELECT dp.document_id, p.id, p.name
         FROM document_products dp
         INNER JOIN products p ON p.id = dp.product_id
        WHERE dp.document_id IN (${ids.map(() => '?').join(', ')})`,
    )
    .bind(...ids)
    .all<{ document_id: string; id: string; name: string }>();
  const many = new Set<string>();
  for (const r of res.results ?? []) {
    if (many.has(r.document_id)) continue;
    if (out.has(r.document_id)) {
      // Two products: nothing is picked for the line. The person types it.
      out.delete(r.document_id);
      many.add(r.document_id);
      continue;
    }
    out.set(r.document_id, { id: r.id, name: r.name });
  }
  return out;
}

/**
 * Stand a person's decision behind (line, document): the 'accepted' suggestion
 * row. A pending engine suggestion for the same pair keeps the engine's basis
 * (the person accepted that evidence); anything else is a `manual_pick`.
 */
async function recordPickDecision(
  db: D1Database,
  args: { tenantId: string; orderItemId: string; documentId: string; lotId: string | null },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO lot_match_suggestions
         (id, tenant_id, order_item_id, document_id, lot_id, match_confidence, match_basis, match_note, status)
       VALUES (?, ?, ?, ?, ?, NULL, 'manual_pick', ?, 'accepted')
       ON CONFLICT(order_item_id, document_id) DO UPDATE SET
         status = 'accepted',
         lot_id = COALESCE(excluded.lot_id, lot_match_suggestions.lot_id),
         match_basis = CASE WHEN lot_match_suggestions.status = 'pending'
                            THEN lot_match_suggestions.match_basis ELSE 'manual_pick' END,
         match_confidence = CASE WHEN lot_match_suggestions.status = 'pending'
                                 THEN lot_match_suggestions.match_confidence ELSE NULL END,
         match_note = CASE WHEN lot_match_suggestions.status = 'pending'
                           THEN lot_match_suggestions.match_note ELSE excluded.match_note END`,
    )
    .bind(generateId(), args.tenantId, args.orderItemId, args.documentId, args.lotId, MANUAL_PICK_NOTE)
    .run();
}

/**
 * A person took (line, document) apart. The pair is marked REJECTED rather
 * than deleted, for the reason a rejected suggestion is kept: the matcher never
 * reopens it, so it cannot offer back the certificate somebody just removed.
 */
async function recordPickWithdrawn(db: D1Database, orderItemId: string, documentId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE lot_match_suggestions SET status = 'rejected'
        WHERE order_item_id = ? AND document_id = ? AND status = 'accepted'`,
    )
    .bind(orderItemId, documentId)
    .run();
}

const PICK_COLUMNS_SQL = `coa_document_id = ?,
             lot_id = COALESCE(?, lot_id),
             lot_matched = 1,
             match_confidence = NULL,
             coa_match_status = 'matched',
             coa_matched_at = datetime('now'),
             picked_by = ?,
             picked_at = datetime('now')`;

export interface PickContext {
  order: OrderWriteRow;
  userId: string;
  clientIp: string | null;
}

/**
 * Put approved documents on an order: one line per lot row of each.
 *
 * A line the order ALREADY has for that lot, with no certificate on it, is
 * FILLED rather than duplicated -- that is the connector-fed order whose lines
 * arrived without certificates, and it is the same act as accepting a
 * suggestion. A document with no lot row becomes one line with no lot, which
 * the fulfillment report will (correctly) read as missing its lot.
 */
export async function pickDocumentsOntoOrder(
  db: D1Database,
  ctx: PickContext,
  rawIds: unknown,
): Promise<OrderItemsAddResponse> {
  const { order } = ctx;
  const ids = normalizeIds(rawIds);
  if (ids.length === 0) throw new BadRequestError('Choose at least one document to add.');
  if (ids.length > ORDER_PICK_MAX_DOCUMENTS) {
    throw new BadRequestError(
      `One pick adds at most ${ORDER_PICK_MAX_DOCUMENTS} documents, and this selection has ${ids.length}. Add them in smaller batches.`,
    );
  }

  const docs = await loadPickDocuments(db, order.tenant_id, ids);
  const refused: OrderItemsAddResponse['refused'] = [];
  const allowed: string[] = [];
  for (const id of ids) {
    const reason = pickRefusal(docs.get(id));
    if (reason) refused.push({ document_id: id, reason });
    else allowed.push(id);
  }

  const lotsByDoc = await loadPickLots(db, order.tenant_id, allowed);
  const soleProduct = await loadSoleProducts(db, allowed);

  const existingRes = await db
    .prepare('SELECT id, lot_id, lot_number, coa_document_id FROM order_items WHERE order_id = ?')
    .bind(order.id)
    .all<ExistingLine>();
  const existing = existingRes.results ?? [];

  const results: OrderPickResult[] = [];
  for (const docId of allowed) {
    const doc = docs.get(docId)!;
    const lots: (PickLot | null)[] = lotsByDoc.get(docId) ?? [];
    if (lots.length === 0) lots.push(null);

    for (const lot of lots) {
      const lotId = lot?.lot_id ?? null;
      const same = existing.find((e) => e.coa_document_id === docId && (e.lot_id ?? null) === lotId);
      if (same) {
        results.push({ document_id: docId, order_item_id: same.id, outcome: 'already_on_order', lot_id: lotId, lot_number: lot?.lot_number ?? null });
        continue;
      }

      // An unfilled line for exactly this lot -- already resolved to the lot
      // row, or carrying a raw lot number that normalizes to its key (the same
      // two candidate shapes linkCoaToOrders reads).
      const open = lot
        ? existing.find(
            (e) =>
              !e.coa_document_id &&
              (e.lot_id === lot.lot_id || (!e.lot_id && !!e.lot_number && normalizeLotNumber(e.lot_number) === lot.lot_key)),
          )
        : undefined;

      let itemId: string;
      let outcome: OrderPickResult['outcome'];
      if (open) {
        itemId = open.id;
        outcome = 'filled';
        await db
          .prepare(`UPDATE order_items SET ${PICK_COLUMNS_SQL} WHERE id = ? AND order_id = ?`)
          .bind(docId, lotId, ctx.userId, itemId, order.id)
          .run();
        open.coa_document_id = docId;
        open.lot_id = lotId ?? open.lot_id;
      } else {
        itemId = generateId();
        outcome = 'added';
        const product = lot?.product_id
          ? { id: lot.product_id, name: lot.product_name }
          : soleProduct.get(docId) ?? null;
        const productName = product?.name ?? (doc.product_name_meta ? String(doc.product_name_meta) : null);
        await db
          .prepare(
            `INSERT INTO order_items
               (id, order_id, product_id, product_name, product_code, quantity, lot_number,
                lot_matched, coa_document_id, match_confidence, lot_id, coa_match_status,
                coa_matched_at, picked_by, picked_at, created_at)
             VALUES (?, ?, ?, ?, ?, NULL, ?, 1, ?, NULL, ?, 'matched',
                     datetime('now'), ?, datetime('now'), datetime('now'))`,
          )
          .bind(
            itemId,
            order.id,
            product?.id ?? null,
            productName ? sanitizeString(productName) : null,
            parseDistributorCode(doc.title),
            lot ? (lot.sub_lot_code ? `${lot.lot_number}-${lot.sub_lot_code}` : lot.lot_number) : null,
            docId,
            lotId,
            ctx.userId,
          )
          .run();
        existing.push({ id: itemId, lot_id: lotId, lot_number: lot?.lot_number ?? null, coa_document_id: docId });
      }

      await recordPickDecision(db, { tenantId: order.tenant_id, orderItemId: itemId, documentId: docId, lotId });
      await auditPick(db, ctx, 'order_item.coa_picked', itemId, {
        order_number: order.order_number,
        document_id: docId,
        document_title: doc.title,
        lot_id: lotId,
        lot_number: lot?.lot_number ?? null,
        sub_lot_code: lot?.sub_lot_code ?? null,
        outcome,
        via: 'manual_pick',
      });
      results.push({ document_id: docId, order_item_id: itemId, outcome, lot_id: lotId, lot_number: lot?.lot_number ?? null });
    }
  }

  if (results.some((r) => r.outcome !== 'already_on_order')) await touchOrder(db, order.id);
  return { results, refused };
}

async function touchOrder(db: D1Database, orderId: string): Promise<void> {
  await db.prepare(`UPDATE orders SET updated_at = datetime('now') WHERE id = ?`).bind(orderId).run();
}

async function auditPick(
  db: D1Database,
  ctx: PickContext,
  action: string,
  itemId: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await logAudit(
      db,
      ctx.userId,
      ctx.order.tenant_id,
      action,
      'order_item',
      itemId,
      JSON.stringify({ order_id: ctx.order.id, ...details }),
      ctx.clientIp,
    );
  } catch {
    // The line is written; an audit hiccup must not undo a person's pick.
  }
}

// ---------------------------------------------------------------------------
// A hand-typed line
// ---------------------------------------------------------------------------

function cleanText(v: unknown, max = 200): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? sanitizeString(t).slice(0, max) : null;
}

function cleanQuantity(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new BadRequestError('quantity must be a number, zero or more.');
  return n;
}

async function requireTenantProduct(db: D1Database, tenantId: string, productId: string): Promise<{ id: string; name: string }> {
  const p = await db
    .prepare('SELECT id, name FROM products WHERE id = ? AND tenant_id = ?')
    .bind(productId, tenantId)
    .first<{ id: string; name: string }>();
  if (!p) throw new BadRequestError('That product is not in this organization.');
  return p;
}

/**
 * Resolve a typed lot number to a lot row and ask the matcher for certificates,
 * exactly as the connector does for a line it reads (kinds/order.ts). Whatever
 * it finds arrives as SUGGESTIONS; nothing is linked. Best-effort.
 */
async function resolveTypedLot(
  db: D1Database,
  tenantId: string,
  itemId: string,
  lotNumber: string,
  productId: string | null,
): Promise<string | null> {
  try {
    const scheme = await orderSideSchemeResolver(db, tenantId)(productId);
    const lot = await findOrCreateLot(db, tenantId, { lotNumber, productId, source: 'order', lotScheme: scheme });
    if (!lot) return null;
    await db.prepare('UPDATE order_items SET lot_id = ? WHERE id = ?').bind(lot.id, itemId).run();
    await linkOrderToCoas(db, tenantId, { orderItemId: itemId, lotId: lot.id, productId });
    return lot.id;
  } catch (err) {
    console.warn('[order-items] typed lot could not be resolved:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** One line with no document yet: a product and/or a lot, typed by a person. */
export async function addTypedLine(
  db: D1Database,
  ctx: PickContext,
  raw: NonNullable<OrderItemsAddRequest['item']>,
): Promise<string> {
  const { order } = ctx;
  const productId = typeof raw.product_id === 'string' && raw.product_id ? raw.product_id : null;
  const product = productId ? await requireTenantProduct(db, order.tenant_id, productId) : null;
  const productName = cleanText(raw.product_name) ?? product?.name ?? null;
  const productCode = cleanText(raw.product_code, 80);
  const lotNumber = cleanText(raw.lot_number, 80);
  const quantity = cleanQuantity(raw.quantity);
  if (!productName && !productCode && !lotNumber) {
    throw new BadRequestError('A line needs at least a product or a lot number.');
  }

  const itemId = generateId();
  await db
    .prepare(
      `INSERT INTO order_items (id, order_id, product_id, product_name, product_code, quantity, lot_number, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .bind(itemId, order.id, product?.id ?? null, productName, productCode, quantity, lotNumber)
    .run();
  if (lotNumber) await resolveTypedLot(db, order.tenant_id, itemId, lotNumber, product?.id ?? null);

  await auditPick(db, ctx, 'order_item.added', itemId, {
    order_number: order.order_number,
    product_name: productName,
    product_code: productCode,
    lot_number: lotNumber,
    quantity,
  });
  await touchOrder(db, order.id);
  return itemId;
}

// ---------------------------------------------------------------------------
// Changing and removing a line
// ---------------------------------------------------------------------------

interface LineRow {
  id: string;
  order_id: string;
  product_id: string | null;
  product_name: string | null;
  product_code: string | null;
  quantity: number | null;
  lot_number: string | null;
  lot_id: string | null;
  coa_document_id: string | null;
  staged_at: string | null;
}

export async function loadLine(db: D1Database, orderId: string, itemId: string): Promise<LineRow> {
  const line = await db
    .prepare(
      `SELECT id, order_id, product_id, product_name, product_code, quantity, lot_number, lot_id,
              coa_document_id, staged_at
         FROM order_items WHERE id = ? AND order_id = ?`,
    )
    .bind(itemId, orderId)
    .first<LineRow>();
  if (!line) throw new NotFoundError('Order line not found');
  return line;
}

/**
 * Edit one line. `coa_document_id` is the pick: a document id puts it on the
 * line, null takes it off. Everything else is the plain facts of the line.
 */
export async function updateLine(
  db: D1Database,
  ctx: PickContext,
  itemId: string,
  body: OrderItemUpdateRequest,
): Promise<void> {
  const { order } = ctx;
  const line = await loadLine(db, order.id, itemId);

  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  const changed: Record<string, unknown> = {};

  let productId = line.product_id;
  if (body.product_id !== undefined) {
    productId = body.product_id ? (await requireTenantProduct(db, order.tenant_id, body.product_id)).id : null;
    sets.push('product_id = ?');
    binds.push(productId);
    changed.product_id = productId;
  }
  if (body.product_name !== undefined) {
    const v = cleanText(body.product_name);
    sets.push('product_name = ?');
    binds.push(v);
    changed.product_name = v;
  }
  if (body.product_code !== undefined) {
    const v = cleanText(body.product_code, 80);
    sets.push('product_code = ?');
    binds.push(v);
    changed.product_code = v;
  }
  if (body.quantity !== undefined) {
    const v = cleanQuantity(body.quantity);
    sets.push('quantity = ?');
    binds.push(v);
    changed.quantity = v;
  }
  let retypedLot: string | null = null;
  if (body.lot_number !== undefined) {
    const v = cleanText(body.lot_number, 80);
    if (v !== line.lot_number) {
      sets.push('lot_number = ?');
      binds.push(v);
      changed.lot_number = v;
      // A retyped lot on a line with no certificate drops the old lot row; the
      // new number is resolved below. A line WITH a certificate keeps the lot
      // row its certificate is for -- the pick, not the label, is the fact.
      if (!line.coa_document_id && body.coa_document_id === undefined) {
        sets.push('lot_id = NULL');
        retypedLot = v;
      }
    }
  }

  if (sets.length > 0) {
    await db
      .prepare(`UPDATE order_items SET ${sets.join(', ')} WHERE id = ? AND order_id = ?`)
      .bind(...binds, itemId, order.id)
      .run();
    await auditPick(db, ctx, 'order_item.updated', itemId, { order_number: order.order_number, changes: changed });
  }
  if (retypedLot) await resolveTypedLot(db, order.tenant_id, itemId, retypedLot, productId);

  if (body.coa_document_id !== undefined) {
    if (body.coa_document_id === null || body.coa_document_id === '') {
      await removeLineDocument(db, ctx, line);
    } else {
      await putDocumentOnLine(db, ctx, line, body.coa_document_id, body.lot_id ?? null);
    }
  }
  if (sets.length > 0 || body.coa_document_id !== undefined) await touchOrder(db, order.id);
}

async function putDocumentOnLine(
  db: D1Database,
  ctx: PickContext,
  line: LineRow,
  documentId: string,
  askedLotId: string | null,
): Promise<void> {
  const { order } = ctx;
  const docs = await loadPickDocuments(db, order.tenant_id, [documentId]);
  const doc = docs.get(documentId);
  const refusal = pickRefusal(doc);
  if (refusal) throw new BadRequestError(refusal);

  const lots = (await loadPickLots(db, order.tenant_id, [documentId])).get(documentId) ?? [];
  let lot: PickLot | null = null;
  if (askedLotId) {
    lot = lots.find((l) => l.lot_id === askedLotId) ?? null;
    if (!lot) throw new BadRequestError('That lot is not one this document certifies.');
  } else if (line.lot_id && lots.some((l) => l.lot_id === line.lot_id)) {
    lot = lots.find((l) => l.lot_id === line.lot_id)!;
  } else if (lots.length === 1) {
    lot = lots[0];
  } else if (lots.length > 1) {
    // Nothing is picked for the person: which of several lots this line is for
    // is exactly the mistake the screen exists to make visible.
    throw new BadRequestError(
      `This document certifies ${lots.length} lots. Say which one this line is for.`,
    );
  }

  if (line.coa_document_id && line.coa_document_id !== documentId) {
    await recordPickWithdrawn(db, line.id, line.coa_document_id);
  }
  await db
    .prepare(`UPDATE order_items SET ${PICK_COLUMNS_SQL} WHERE id = ? AND order_id = ?`)
    .bind(documentId, lot?.lot_id ?? null, ctx.userId, line.id, order.id)
    .run();
  await recordPickDecision(db, {
    tenantId: order.tenant_id,
    orderItemId: line.id,
    documentId,
    lotId: lot?.lot_id ?? null,
  });
  await auditPick(db, ctx, 'order_item.coa_picked', line.id, {
    order_number: order.order_number,
    document_id: documentId,
    document_title: doc!.title,
    lot_id: lot?.lot_id ?? null,
    lot_number: lot?.lot_number ?? null,
    sub_lot_code: lot?.sub_lot_code ?? null,
    replaced_document_id: line.coa_document_id && line.coa_document_id !== documentId ? line.coa_document_id : null,
    outcome: 'filled',
    via: 'manual_pick',
  });
}

async function removeLineDocument(db: D1Database, ctx: PickContext, line: LineRow): Promise<void> {
  if (!line.coa_document_id) return;
  // The lot row stays: the line is still for that lot, it simply has no
  // certificate again, which is what the fulfillment report should now say.
  await db
    .prepare(
      `UPDATE order_items
          SET coa_document_id = NULL, lot_matched = 0, match_confidence = NULL,
              coa_match_status = 'unmatched', coa_matched_at = NULL,
              picked_by = NULL, picked_at = NULL
        WHERE id = ? AND order_id = ?`,
    )
    .bind(line.id, ctx.order.id)
    .run();
  await recordPickWithdrawn(db, line.id, line.coa_document_id);
  await auditPick(db, ctx, 'order_item.coa_removed', line.id, {
    order_number: ctx.order.order_number,
    document_id: line.coa_document_id,
    lot_id: line.lot_id,
  });
}

/**
 * Remove a line. Its suggestion rows go first: they reference the line with no
 * ON DELETE action, so the line cannot be deleted while they exist. The whole
 * row is in the audit record, because that is then the only copy.
 */
export async function removeLine(db: D1Database, ctx: PickContext, itemId: string): Promise<void> {
  const line = await loadLine(db, ctx.order.id, itemId);
  await db.prepare('DELETE FROM lot_match_suggestions WHERE order_item_id = ?').bind(itemId).run();
  await db.prepare('DELETE FROM order_items WHERE id = ? AND order_id = ?').bind(itemId, ctx.order.id).run();
  await auditPick(db, ctx, 'order_item.removed', itemId, { order_number: ctx.order.order_number, line });
  await touchOrder(db, ctx.order.id);
}
