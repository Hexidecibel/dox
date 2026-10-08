/**
 * Document orders (migration 0138): the lines of an order that ask for a
 * supplier's documents rather than a lot's certificate.
 *
 * WHAT AJ ASKED FOR (2026-10-06), and where each part lives
 * ---------------------------------------------------------
 *   "Same order record you just agreed to for manual COA fulfillment, used by
 *    sales for documents that are already in the portal."
 *      -> `order_documents` hangs off the same `orders` row. COA lines stay in
 *         `order_items`, untouched.
 *   "Any user with a portal login can build the order, from the approved item
 *    list, and anyone but a read-only account can send it."
 *      -> `addDocumentLines` takes any login; the send endpoint keeps its bar.
 *   "The portal resolves each item to its supplier and plant and pulls the
 *    current approved documents."
 *      -> functions/lib/current-document.ts + shared/currentDocument.ts.
 *         A product with several approved suppliers gets ONE LINE PER PAIR
 *         (C-043): nothing picks a supplier, the person removes what they do
 *         not want.
 *   "Co-packer documents on private-label items carry an advisory to sales."
 *      -> `privateLabelAdvisory` (shared/orderDocuments.ts). Warns, never blocks.
 *
 * THE STORED RULE DECIDES NOTHING. `rule_at_resolve` is what the document's
 * sharing rule was when the line was resolved, kept so the page can show that
 * it has changed. Every decision -- the three groups on the order page, the
 * send, the release -- reads the LIVE rule through `loadSharingRules`.
 *
 * APPROVAL IS CHECKED WHEN THE LINE IS ADDED, not at send. The approved list
 * is where the line came from; an item that stops being approved afterwards
 * does not silently drop documents somebody already asked for. (Whether a
 * document may LEAVE is the sharing rule's question, and that one is asked
 * live.)
 *
 * A READ-ONLY ACCOUNT MAY BUILD. Adding, removing and refreshing a document
 * line is open to every login of the organization, on any order of it --
 * building an order moves nothing out of the portal. Sending, releasing and
 * everything about COA lines keep the bar they had.
 */

import { generateId, logAudit } from './db';
import { BadRequestError, ForbiddenError, NotFoundError } from './permissions';
import { loadSharingRules } from './sharing-rule';
import {
  currentDocumentKey,
  loadDocumentLiveFacts,
  loadTenantDocumentTypes,
  resolveCurrentDocuments,
  todayIso,
  type CurrentDocumentAsk,
  type ResolvedCurrentDocument,
} from './current-document';
import { isPastDue } from '../../shared/currentDocument';
import {
  ORDER_DOCUMENTS_MAX_PER_REQUEST,
  judgeOrderDocumentLine,
  privateLabelAdvisory,
  releaseIsStuck,
  type OrderDocumentJudgement,
} from '../../shared/orderDocuments';
import { isPrivateLabel } from '../../shared/itemApproval';
import { looksLikeCoaType } from '../../shared/renewalPeriod';
import { parseSharingRule, type ExitActor } from '../../shared/sharingRule';
import type { OrderWriteRow } from './order-items';
import type {
  ApiOrderDocument,
  OrderDocumentProposal,
  OrderDocumentReleaseStatus,
  OrderDocumentResolution,
  OrderDocumentsAddRequest,
  OrderDocumentsAddResponse,
  PendingOrderDocument,
} from '../../shared/types';

const IN_CHUNK = 80;

function chunk<T>(items: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Reading the lines
// ---------------------------------------------------------------------------

export interface OrderDocumentRow {
  id: string;
  tenant_id: string;
  order_id: string;
  product_id: string;
  supplier_id: string;
  document_type_id: string;
  document_id: string | null;
  version_number: number | null;
  resolution: OrderDocumentResolution;
  resolution_note: string | null;
  document_due_date: string | null;
  resolved_at: string;
  rule_at_resolve: string | null;
  release_status: OrderDocumentReleaseStatus;
  pending_send_id: string | null;
  pending_at: string | null;
  pending_requested_by: string | null;
  releasing_at: string | null;
  release_send_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  qa_notified_at: string | null;
  qa_notified_cause: string | null;
  export_link_id: string | null;
  last_send_id: string | null;
  last_sent_at: string | null;
  added_by: string;
  created_at: string;
  updated_at: string;
}

interface JoinedRow extends OrderDocumentRow {
  product_name: string | null;
  brand_owner: string | null;
  producer: string | null;
  supplier_name: string | null;
  document_type_name: string | null;
  facility_id: string | null;
  facility_name: string | null;
  facility_plant_code: string | null;
  added_by_name: string | null;
  decided_by_name: string | null;
  pending_requested_by_name: string | null;
}

/** One line with everything a decision about it needs. */
export interface JudgedOrderDocument {
  row: JoinedRow;
  api: ApiOrderDocument;
  judgement: OrderDocumentJudgement;
}

const JOINED_SELECT = `
  SELECT od.*,
         p.name  AS product_name, p.brand_owner AS brand_owner, p.producer AS producer,
         s.name  AS supplier_name,
         dt.name AS document_type_name,
         f.id AS facility_id, f.name AS facility_name, f.plant_code AS facility_plant_code,
         ua.name AS added_by_name, ud.name AS decided_by_name, up.name AS pending_requested_by_name
    FROM order_documents od
    LEFT JOIN products p        ON p.id = od.product_id AND p.tenant_id = od.tenant_id
    LEFT JOIN suppliers s       ON s.id = od.supplier_id AND s.tenant_id = od.tenant_id
    LEFT JOIN document_types dt ON dt.id = od.document_type_id AND dt.tenant_id = od.tenant_id
    LEFT JOIN product_suppliers ps
           ON ps.product_id = od.product_id AND ps.supplier_id = od.supplier_id AND ps.tenant_id = od.tenant_id
    LEFT JOIN supplier_facilities f ON f.id = ps.facility_id
    LEFT JOIN users ua ON ua.id = od.added_by
    LEFT JOIN users ud ON ud.id = od.decided_by
    LEFT JOIN users up ON up.id = od.pending_requested_by`;

async function loadJoinedRows(
  db: D1Database,
  tenantId: string,
  where: string,
  binds: (string | number)[],
): Promise<JoinedRow[]> {
  const res = await db
    .prepare(`${JOINED_SELECT} WHERE od.tenant_id = ? AND ${where} ORDER BY od.created_at ASC, od.rowid ASC`)
    .bind(tenantId, ...binds)
    .all<JoinedRow>();
  return res.results ?? [];
}

/**
 * Judge rows against what is true NOW: the document's status and file, its
 * due date resolved today, its live sharing rule, and what a fresh resolve
 * would find. `actor` is the person asking; the three groups are theirs.
 */
async function judgeRows(
  db: D1Database,
  tenantId: string,
  rows: JoinedRow[],
  actor: ExitActor,
): Promise<JudgedOrderDocument[]> {
  if (rows.length === 0) return [];
  const today = todayIso();
  const docIds = rows.map((r) => r.document_id).filter((id): id is string => Boolean(id));
  const [live, rules, askingSends, fresh] = await Promise.all([
    loadDocumentLiveFacts(db, tenantId, docIds),
    loadSharingRules(db, tenantId, docIds),
    // Who a waiting line's release would mail: the send that asked, exactly.
    loadSendRecipients(
      db,
      tenantId,
      rows.filter((r) => r.release_status === 'pending_qa' || r.release_status === 'releasing').map((r) => r.pending_send_id ?? ''),
    ),
    resolveCurrentDocuments(
      db,
      tenantId,
      rows.map((r) => ({
        product_id: r.product_id,
        supplier_id: r.supplier_id,
        document_type_id: r.document_type_id,
      })),
      today,
    ),
  ]);

  return rows.map((row) => {
    const doc = row.document_id ? live.get(row.document_id) ?? null : null;
    const rule = row.document_id ? rules.get(row.document_id)?.rule ?? null : null;
    const now = fresh.get(currentDocumentKey(row)) ?? null;
    const expired = Boolean(doc && isPastDue(doc.due_date, today));
    const waiting = row.release_status === 'pending_qa' || row.release_status === 'releasing';
    const pendingRecipients = waiting ? askingSends.get(row.pending_send_id ?? '')?.recipients ?? [] : [];
    const releaseStuck = row.release_status === 'releasing' && releaseIsStuck(row.releasing_at);

    // "Stale" = a fresh resolve would put a different document on the line, or
    // would now find one where there was none.
    const freshFound = Boolean(now && now.resolution === 'found' && now.document_id !== row.document_id);
    const stale = Boolean(
      now && !now.not_applicable && (now.document_id ?? null) !== (row.document_id ?? null),
    );
    const staleNote = !stale
      ? null
      : now?.document_id
        ? row.document_id
          ? 'A different document is the current one now. Refresh this line to use it.'
          : 'A document is on file now. Refresh this line to use it.'
        : 'The document on this line is no longer the supplier\'s current one, and nothing replaces it. Refresh this line.';

    const judgement = judgeOrderDocumentLine(
      {
        has_document: Boolean(row.document_id),
        document_status: doc?.status ?? null,
        has_file: Boolean(doc?.has_file),
        expired,
        due_date: doc?.due_date ?? null,
        rule,
        release_status: row.release_status,
        decision_note: row.decision_note,
        decided_at: row.decided_at,
        is_coa_type: looksLikeCoaType(row.document_type_name ?? ''),
        fresh_found: freshFound,
        pending_at: row.pending_at,
        pending_recipients: pendingRecipients,
        release_stuck: releaseStuck,
      },
      actor,
    );

    const resolution: OrderDocumentResolution = !row.document_id ? 'missing' : expired ? 'expired' : 'found';
    const api: ApiOrderDocument = {
      id: row.id,
      order_id: row.order_id,
      product_id: row.product_id,
      product_name: row.product_name,
      supplier_id: row.supplier_id,
      supplier_name: row.supplier_name,
      facility: row.facility_id
        ? { id: row.facility_id, name: row.facility_name ?? '', plant_code: row.facility_plant_code ?? null }
        : null,
      document_type_id: row.document_type_id,
      document_type_name: row.document_type_name,
      document_id: row.document_id,
      document_title: doc?.title ?? null,
      document_status: doc?.status ?? null,
      version_number: doc?.current_version ?? row.version_number,
      resolution,
      resolution_note: row.resolution_note,
      document_due_date: doc?.due_date ?? null,
      resolved_at: row.resolved_at,
      rule_at_resolve: parseSharingRule(row.rule_at_resolve),
      sharing_rule: rule,
      release_status: row.release_status,
      pending_send_id: waiting ? row.pending_send_id : null,
      pending_at: row.pending_at,
      pending_requested_by_name: row.pending_requested_by_name,
      pending_recipients: pendingRecipients,
      document_approved_at: doc?.approved_at ?? null,
      release_stuck: releaseStuck,
      decided_by_name: row.decided_by_name,
      decided_at: row.decided_at,
      decision_note: row.decision_note,
      qa_notified_at: row.qa_notified_at,
      last_sent_at: row.last_sent_at,
      added_by: row.added_by,
      added_by_name: row.added_by_name,
      created_at: row.created_at,
      private_label: isPrivateLabel(row.brand_owner, row.producer),
      advisory: privateLabelAdvisory(row.brand_owner, row.producer),
      stale,
      stale_note: staleNote,
      disposition: judgement.disposition,
      disposition_reason: judgement.reason,
      disposition_text: judgement.text,
      delivery: judgement.delivery,
    };
    return { row, api, judgement };
  });
}

/** Every document line of one order, judged for `actor`. Tenant scoped in SQL. */
export async function loadJudgedOrderDocuments(
  db: D1Database,
  tenantId: string,
  orderId: string,
  actor: ExitActor,
): Promise<JudgedOrderDocument[]> {
  const rows = await loadJoinedRows(db, tenantId, 'od.order_id = ?', [orderId]);
  return judgeRows(db, tenantId, rows, actor);
}

/** The lines named, of one order. Ids that are not lines of that order are simply absent. */
export async function loadJudgedLinesById(
  db: D1Database,
  tenantId: string,
  orderId: string,
  lineIds: string[],
  actor: ExitActor,
): Promise<JudgedOrderDocument[]> {
  const rows: JoinedRow[] = [];
  for (const part of chunk([...new Set(lineIds)])) {
    rows.push(
      ...(await loadJoinedRows(
        db,
        tenantId,
        `od.order_id = ? AND od.id IN (${part.map(() => '?').join(', ')})`,
        [orderId, ...part],
      )),
    );
  }
  return judgeRows(db, tenantId, rows, actor);
}

export async function loadOrderDocuments(
  db: D1Database,
  tenantId: string,
  orderId: string,
  actor: ExitActor,
): Promise<ApiOrderDocument[]> {
  return (await loadJudgedOrderDocuments(db, tenantId, orderId, actor)).map((l) => l.api);
}

// ---------------------------------------------------------------------------
// Adding lines
// ---------------------------------------------------------------------------

export interface OrderDocumentContext {
  order: OrderWriteRow;
  userId: string;
  clientIp: string | null;
  /** The caller's role, for the one thing a read-only account may not do to a line. */
  role?: string;
}

/**
 * A READ-ONLY ACCOUNT BUILDS; IT DOES NOT UNDO WHAT QA IS LOOKING AT OR HAS
 * DECIDED. A reader may add lines, and remove or refresh a line nothing has
 * happened to. Once a line is waiting for QA, being released, or released, a
 * reader taking it off (or re-resolving it, which resets it) would pull a
 * document out from under QA's review or erase a release from the order.
 * Everybody who may send may still do both.
 */
function refuseReaderOnDecidedLine(ctx: OrderDocumentContext, row: OrderDocumentRow, verb: string): void {
  if (ctx.role !== 'reader') return;
  if (row.release_status === 'pending_qa' || row.release_status === 'releasing' || row.release_status === 'released') {
    throw new ForbiddenError(
      `A read-only account cannot ${verb} a document that is waiting for QA or that QA has released. Ask somebody who can send the order.`,
    );
  }
}

function cleanIds(raw: unknown): string[] {
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

function cleanPairs(raw: unknown): { product_id: string; supplier_id: string }[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: { product_id: string; supplier_id: string }[] = [];
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue;
    const product = (v as { product_id?: unknown }).product_id;
    const supplier = (v as { supplier_id?: unknown }).supplier_id;
    if (typeof product !== 'string' || typeof supplier !== 'string') continue;
    const pair = { product_id: product.trim(), supplier_id: supplier.trim() };
    if (!pair.product_id || !pair.supplier_id) continue;
    const key = `${pair.product_id}|${pair.supplier_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pair);
  }
  return out;
}

interface PairFacts {
  product_name: string | null;
  supplier_name: string | null;
  brand_owner: string | null;
  producer: string | null;
  /** NULL = the pair has no `product_suppliers` row: nothing recorded, so not approved. */
  approval_status: string | null;
}

/** What is on file about each pair, tenant scoped. A pair of another organization reads as unknown. */
async function loadPairFacts(
  db: D1Database,
  tenantId: string,
  pairs: { product_id: string; supplier_id: string }[],
): Promise<Map<string, PairFacts & { known: boolean }>> {
  const products = new Map<string, { name: string | null; brand_owner: string | null; producer: string | null }>();
  for (const part of chunk([...new Set(pairs.map((p) => p.product_id))])) {
    const res = await db
      .prepare(
        `SELECT id, name, brand_owner, producer FROM products
          WHERE tenant_id = ? AND id IN (${part.map(() => '?').join(', ')})`,
      )
      .bind(tenantId, ...part)
      .all<{ id: string; name: string | null; brand_owner: string | null; producer: string | null }>();
    for (const r of res.results ?? []) products.set(r.id, r);
  }
  const suppliers = new Map<string, string | null>();
  for (const part of chunk([...new Set(pairs.map((p) => p.supplier_id))])) {
    const res = await db
      .prepare(`SELECT id, name FROM suppliers WHERE tenant_id = ? AND id IN (${part.map(() => '?').join(', ')})`)
      .bind(tenantId, ...part)
      .all<{ id: string; name: string | null }>();
    for (const r of res.results ?? []) suppliers.set(r.id, r.name);
  }
  const approvals = new Map<string, string>();
  for (const part of chunk([...new Set(pairs.map((p) => p.product_id))])) {
    const res = await db
      .prepare(
        `SELECT product_id, supplier_id, approval_status FROM product_suppliers
          WHERE tenant_id = ? AND product_id IN (${part.map(() => '?').join(', ')})`,
      )
      .bind(tenantId, ...part)
      .all<{ product_id: string; supplier_id: string; approval_status: string }>();
    for (const r of res.results ?? []) approvals.set(`${r.product_id}|${r.supplier_id}`, r.approval_status);
  }

  const out = new Map<string, PairFacts & { known: boolean }>();
  for (const pair of pairs) {
    const key = `${pair.product_id}|${pair.supplier_id}`;
    const product = products.get(pair.product_id);
    out.set(key, {
      known: Boolean(product) && suppliers.has(pair.supplier_id),
      product_name: product?.name ?? null,
      supplier_name: suppliers.get(pair.supplier_id) ?? null,
      brand_owner: product?.brand_owner ?? null,
      producer: product?.producer ?? null,
      approval_status: approvals.get(key) ?? null,
    });
  }
  return out;
}

function approvalRefusal(status: string | null): string | null {
  if (status === 'approved') return null;
  if (status === 'not_approved') return 'This item is not approved from this supplier, so its documents cannot be ordered.';
  return 'This item is waiting for approval from this supplier. Documents can be ordered once it is approved.';
}

/**
 * Put document lines on an order: one per (item, supplier, type). With
 * `dry_run` nothing is written and the answer is what WOULD resolve -- the
 * "Add documents for items" dialog shows that before the person commits.
 *
 * NOTHING ASKED FOR IS DROPPED QUIETLY. A pair that is not approved, an id
 * that is not this organization's, a type that belongs to another supplier:
 * each is in `refused` with its reason, and the rest still land.
 */
export async function addDocumentLines(
  db: D1Database,
  ctx: OrderDocumentContext,
  body: OrderDocumentsAddRequest,
): Promise<OrderDocumentsAddResponse> {
  const { order } = ctx;
  const dryRun = body.dry_run === true;
  const pairs = cleanPairs(body.items);
  const typeIds = cleanIds(body.document_type_ids);
  if (pairs.length === 0) throw new BadRequestError('Choose at least one item from the approved list.');
  if (typeIds.length === 0) throw new BadRequestError('Choose at least one document type.');
  if (pairs.length * typeIds.length > ORDER_DOCUMENTS_MAX_PER_REQUEST) {
    throw new BadRequestError(
      `${pairs.length} items and ${typeIds.length} document types is ${pairs.length * typeIds.length} lines, ` +
        `and one request adds at most ${ORDER_DOCUMENTS_MAX_PER_REQUEST}. Add them in smaller batches.`,
    );
  }

  const [facts, types] = await Promise.all([
    loadPairFacts(db, order.tenant_id, pairs),
    loadTenantDocumentTypes(db, order.tenant_id),
  ]);

  const response: OrderDocumentsAddResponse = { lines: [], refused: [], dry_run: dryRun };
  const asks: CurrentDocumentAsk[] = [];
  for (const pair of pairs) {
    const f = facts.get(`${pair.product_id}|${pair.supplier_id}`)!;
    if (!f.known) {
      response.refused.push({ ...pair, reason: 'That item and supplier are not in this organization.' });
      continue;
    }
    const refusal = approvalRefusal(f.approval_status);
    if (refusal) {
      response.refused.push({ ...pair, product_name: f.product_name, supplier_name: f.supplier_name, reason: refusal });
      continue;
    }
    for (const typeId of typeIds) {
      if (!types.has(typeId)) {
        response.refused.push({
          ...pair,
          document_type_id: typeId,
          product_name: f.product_name,
          supplier_name: f.supplier_name,
          reason: 'That document type is not in this organization.',
        });
        continue;
      }
      asks.push({ ...pair, document_type_id: typeId });
    }
  }

  const resolved = await resolveCurrentDocuments(db, order.tenant_id, asks);

  const existing = new Map<string, string>();
  const existingRes = await db
    .prepare('SELECT id, product_id, supplier_id, document_type_id FROM order_documents WHERE order_id = ? AND tenant_id = ?')
    .bind(order.id, order.tenant_id)
    .all<{ id: string; product_id: string; supplier_id: string; document_type_id: string }>();
  for (const r of existingRes.results ?? []) existing.set(currentDocumentKey(r), r.id);

  const foundIds = [...resolved.values()].map((r) => r.document_id).filter((id): id is string => Boolean(id));
  const rules = await loadSharingRules(db, order.tenant_id, foundIds);

  const inserts: D1PreparedStatement[] = [];
  const added: { id: string; ask: CurrentDocumentAsk; resolved: ResolvedCurrentDocument }[] = [];
  for (const ask of asks) {
    const key = currentDocumentKey(ask);
    const r = resolved.get(key)!;
    const f = facts.get(`${ask.product_id}|${ask.supplier_id}`)!;
    const type = types.get(ask.document_type_id)!;
    if (r.not_applicable) {
      response.refused.push({
        ...ask,
        product_name: f.product_name,
        supplier_name: f.supplier_name,
        document_type_name: type.name,
        reason: r.not_applicable,
      });
      continue;
    }
    const rule = r.document_id ? rules.get(r.document_id)?.rule ?? null : null;
    const proposal: OrderDocumentProposal = {
      product_id: ask.product_id,
      product_name: f.product_name,
      supplier_id: ask.supplier_id,
      supplier_name: f.supplier_name,
      document_type_id: ask.document_type_id,
      document_type_name: type.name,
      resolution: r.resolution,
      resolution_note: r.note,
      document_id: r.document_id,
      document_title: r.title,
      document_due_date: r.due_date,
      sharing_rule: rule,
      private_label: isPrivateLabel(f.brand_owner, f.producer),
      advisory: privateLabelAdvisory(f.brand_owner, f.producer),
      outcome: dryRun ? 'would_add' : 'added',
    };
    const already = existing.get(key);
    if (already) {
      // The line is already on the order. It is not re-resolved here: Refresh
      // is the explicit way to do that, and it says what changed.
      response.lines.push({ ...proposal, outcome: 'already_on_order', order_document_id: already });
      continue;
    }
    if (!dryRun) {
      const id = generateId();
      proposal.order_document_id = id;
      inserts.push(
        db
          .prepare(
            `INSERT INTO order_documents
               (id, tenant_id, order_id, product_id, supplier_id, document_type_id,
                document_id, version_number, resolution, resolution_note, document_due_date,
                rule_at_resolve, added_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            id,
            order.tenant_id,
            order.id,
            ask.product_id,
            ask.supplier_id,
            ask.document_type_id,
            r.document_id,
            r.version_number,
            r.resolution,
            r.note,
            r.due_date,
            rule,
            ctx.userId,
          ),
      );
      added.push({ id, ask, resolved: r });
      existing.set(key, id);
    }
    response.lines.push(proposal);
  }

  if (inserts.length > 0) {
    for (const part of chunk(inserts, 50)) await db.batch(part);
    await db
      .prepare(`UPDATE orders SET updated_at = datetime('now') WHERE id = ? AND tenant_id = ?`)
      .bind(order.id, order.tenant_id)
      .run();
    await logAudit(
      db,
      ctx.userId,
      order.tenant_id,
      'order_document.added',
      'order',
      order.id,
      JSON.stringify({
        order_number: order.order_number,
        lines: added.map((a) => ({
          order_document_id: a.id,
          product_id: a.ask.product_id,
          supplier_id: a.ask.supplier_id,
          document_type_id: a.ask.document_type_id,
          resolution: a.resolved.resolution,
          document_id: a.resolved.document_id,
        })),
        refused: response.refused.length,
      }),
      ctx.clientIp,
    );
  }
  return response;
}

// ---------------------------------------------------------------------------
// Removing and refreshing a line
// ---------------------------------------------------------------------------

/** The line, of this order. Another order's or another organization's is a 404. */
export async function loadOrderDocumentRow(
  db: D1Database,
  order: Pick<OrderWriteRow, 'id' | 'tenant_id'>,
  lineId: string,
): Promise<OrderDocumentRow> {
  const row = await db
    .prepare('SELECT * FROM order_documents WHERE id = ? AND order_id = ? AND tenant_id = ?')
    .bind(lineId, order.id, order.tenant_id)
    .first<OrderDocumentRow>();
  if (!row) throw new NotFoundError('Document line not found');
  return row;
}

export async function removeDocumentLine(db: D1Database, ctx: OrderDocumentContext, lineId: string): Promise<void> {
  const row = await loadOrderDocumentRow(db, ctx.order, lineId);
  refuseReaderOnDecidedLine(ctx, row, 'remove');
  await db
    .prepare('DELETE FROM order_documents WHERE id = ? AND order_id = ? AND tenant_id = ?')
    .bind(row.id, ctx.order.id, ctx.order.tenant_id)
    .run();
  await logAudit(
    db,
    ctx.userId,
    ctx.order.tenant_id,
    'order_document.removed',
    'order',
    ctx.order.id,
    JSON.stringify({
      order_number: ctx.order.order_number,
      order_document_id: row.id,
      product_id: row.product_id,
      supplier_id: row.supplier_id,
      document_type_id: row.document_type_id,
      document_id: row.document_id,
      release_status: row.release_status,
    }),
    ctx.clientIp,
  );
}

/**
 * Resolve the line again. When the answer is a DIFFERENT document (or none
 * where there was one), everything decided about the old one is cleared: a
 * release, a refusal and a notice were all about that document.
 */
export async function refreshDocumentLine(
  db: D1Database,
  ctx: OrderDocumentContext,
  lineId: string,
): Promise<{ changed: boolean }> {
  const row = await loadOrderDocumentRow(db, ctx.order, lineId);
  refuseReaderOnDecidedLine(ctx, row, 'refresh');
  const ask: CurrentDocumentAsk = {
    product_id: row.product_id,
    supplier_id: row.supplier_id,
    document_type_id: row.document_type_id,
  };
  const r = (await resolveCurrentDocuments(db, ctx.order.tenant_id, [ask])).get(currentDocumentKey(ask))!;
  if (r.not_applicable) {
    throw new BadRequestError(r.not_applicable);
  }
  const rule = r.document_id
    ? (await loadSharingRules(db, ctx.order.tenant_id, [r.document_id])).get(r.document_id)?.rule ?? null
    : null;
  const documentChanged = (r.document_id ?? null) !== (row.document_id ?? null);
  const changed = documentChanged || r.resolution !== row.resolution;

  if (documentChanged) {
    await db
      .prepare(
        `UPDATE order_documents
            SET document_id = ?, version_number = ?, resolution = ?, resolution_note = ?,
                document_due_date = ?, rule_at_resolve = ?, resolved_at = datetime('now'),
                release_status = 'none', pending_send_id = NULL, pending_at = NULL, pending_requested_by = NULL,
                releasing_at = NULL, release_send_id = NULL,
                decided_by = NULL, decided_at = NULL, decision_note = NULL,
                qa_notified_at = NULL, qa_notified_cause = NULL,
                export_link_id = NULL, last_send_id = NULL, last_sent_at = NULL,
                updated_at = datetime('now')
          WHERE id = ? AND order_id = ? AND tenant_id = ?`,
      )
      .bind(r.document_id, r.version_number, r.resolution, r.note, r.due_date, rule, row.id, ctx.order.id, ctx.order.tenant_id)
      .run();
  } else {
    await db
      .prepare(
        `UPDATE order_documents
            SET version_number = ?, resolution = ?, resolution_note = ?, document_due_date = ?,
                rule_at_resolve = ?, resolved_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND order_id = ? AND tenant_id = ?`,
      )
      .bind(r.version_number, r.resolution, r.note, r.due_date, rule, row.id, ctx.order.id, ctx.order.tenant_id)
      .run();
  }

  if (changed) {
    await logAudit(
      db,
      ctx.userId,
      ctx.order.tenant_id,
      'order_document.refreshed',
      'order',
      ctx.order.id,
      JSON.stringify({
        order_number: ctx.order.order_number,
        order_document_id: row.id,
        previous: { document_id: row.document_id, resolution: row.resolution, release_status: row.release_status },
        now: { document_id: r.document_id, resolution: r.resolution },
      }),
      ctx.clientIp,
    );
  }
  return { changed };
}

// ---------------------------------------------------------------------------
// Bookkeeping the send does
// ---------------------------------------------------------------------------

/**
 * Hold lines for QA. The send that asked is recorded on the line, because the
 * release mails THAT send's recipients -- not whoever the customer's contacts
 * are by the time QA gets to it.
 *
 * ONLY A LINE NOBODY IS WAITING ON (`none`) IS TAKEN. A line already
 * `pending_qa` is NOT re-pointed at this send: its asking send and its
 * recipients are fixed until it is released, refused, removed or refreshed.
 * The first cut accepted `pending_qa` here too, so a second send to a
 * different address -- which mailed nobody -- silently moved where QA's
 * release would go.
 */
export async function markLinesPendingQa(
  db: D1Database,
  args: { tenantId: string; orderId: string; lineIds: string[]; sendId: string; requestedBy: string },
): Promise<void> {
  if (args.lineIds.length === 0) return;
  const stmt = db.prepare(
    `UPDATE order_documents
        SET release_status = 'pending_qa', pending_send_id = ?, pending_at = datetime('now'),
            pending_requested_by = ?, updated_at = datetime('now')
      WHERE id = ? AND order_id = ? AND tenant_id = ? AND release_status = 'none'`,
  );
  for (const part of chunk(args.lineIds, 50)) {
    await db.batch(part.map((id) => stmt.bind(args.sendId, args.requestedBy, id, args.orderId, args.tenantId)));
  }
}

/** What a document line is NOW, for a file that claims to stand for it. */
export interface DocumentLineState {
  id: string;
  order_id: string;
  document_id: string | null;
  release_status: OrderDocumentReleaseStatus;
}

/** The current state of the lines named. A line that was removed is absent. */
export async function loadDocumentLineStates(
  db: D1Database,
  tenantId: string,
  orderId: string,
  lineIds: string[],
): Promise<Map<string, DocumentLineState>> {
  const out = new Map<string, DocumentLineState>();
  for (const part of chunk([...new Set(lineIds.filter(Boolean))])) {
    const res = await db
      .prepare(
        `SELECT id, order_id, document_id, release_status FROM order_documents
          WHERE tenant_id = ? AND order_id = ? AND id IN (${part.map(() => '?').join(', ')})`,
      )
      .bind(tenantId, orderId, ...part)
      .all<DocumentLineState>();
    for (const r of res.results ?? []) out.set(r.id, r);
  }
  return out;
}

/**
 * Record that lines left with a send.
 *
 * A LINE IS TOUCHED ONLY FOR THE DOCUMENT IT HOLDS NOW. Each entry names the
 * line and the document that actually travelled; the UPDATE carries
 * `document_id = ?`, so a resend of an old send that carried document A cannot
 * mark a line that has since been refreshed to document B (which may be
 * waiting for QA) as gone. And a line QA REFUSED, or one in the middle of a
 * release, is never overwritten: the guard is in the WHERE.
 *
 * A line whose document needed QA approval and went because the sender may
 * give it is `released` in that person's name -- the send was the approval.
 * A line that was waiting and whose own document went on a looser rule is no
 * longer waiting.
 */
export async function markLinesSent(
  db: D1Database,
  args: {
    tenantId: string;
    orderId: string;
    lines: { lineId: string; documentId: string }[];
    sendId: string;
    exportLinkId: string | null;
    actorUserId: string;
    /** Documents that passed only because the actor is a QA releaser. */
    qaReleasedDocumentIds: string[];
  },
): Promise<void> {
  if (args.lines.length === 0) return;
  const qa = new Set(args.qaReleasedDocumentIds);
  const guard = `id = ? AND tenant_id = ? AND order_id = ? AND document_id = ?
                 AND release_status NOT IN ('refused', 'releasing')`;
  const stmts = args.lines.map((l) =>
    qa.has(l.documentId)
      ? db
          .prepare(
            `UPDATE order_documents
                SET last_send_id = ?, last_sent_at = datetime('now'),
                    export_link_id = COALESCE(?, export_link_id),
                    release_status = 'released', decided_by = ?, decided_at = datetime('now'),
                    decision_note = 'Sent by a QA releaser; the send is the approval.',
                    updated_at = datetime('now')
              WHERE ${guard}`,
          )
          .bind(args.sendId, args.exportLinkId, args.actorUserId, l.lineId, args.tenantId, args.orderId, l.documentId)
      : db
          .prepare(
            `UPDATE order_documents
                SET last_send_id = ?, last_sent_at = datetime('now'),
                    export_link_id = COALESCE(?, export_link_id),
                    release_status = CASE WHEN release_status = 'pending_qa' THEN 'none' ELSE release_status END,
                    updated_at = datetime('now')
              WHERE ${guard}`,
          )
          .bind(args.sendId, args.exportLinkId, l.lineId, args.tenantId, args.orderId, l.documentId),
  );
  for (const part of chunk(stmts, 50)) await db.batch(part);
}

/**
 * How many document lines of an order are LEFT BEHIND as of this send. An
 * order with one of those is not delivered (C-056).
 *
 * A line is done in exactly two ways: QA released it, or it went with THIS
 * send and nothing is outstanding on it. Everything else is behind -- waiting
 * for QA, in the middle of a release, refused, missing, expired, locked, or
 * sent only by some other send.
 */
export async function countDocumentLinesBehind(
  db: D1Database,
  tenantId: string,
  orderId: string,
  sendId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM order_documents
        WHERE tenant_id = ? AND order_id = ?
          AND NOT (release_status = 'released'
                   OR (release_status = 'none' AND last_send_id IS NOT NULL AND last_send_id = ?))`,
    )
    .bind(tenantId, orderId, sendId)
    .first<{ n: number }>();
  return Number(row?.n) || 0;
}

// ---------------------------------------------------------------------------
// Waiting for QA, across orders
// ---------------------------------------------------------------------------

/** The recipients each pending line's release will mail, by the send that asked. */
export async function loadSendRecipients(
  db: D1Database,
  tenantId: string,
  sendIds: string[],
): Promise<Map<string, { recipients: string[]; sent_by: string; subject: string }>> {
  const out = new Map<string, { recipients: string[]; sent_by: string; subject: string }>();
  for (const part of chunk([...new Set(sendIds.filter(Boolean))])) {
    const res = await db
      .prepare(
        `SELECT id, recipients, sent_by, subject FROM order_sends
          WHERE tenant_id = ? AND id IN (${part.map(() => '?').join(', ')})`,
      )
      .bind(tenantId, ...part)
      .all<{ id: string; recipients: string; sent_by: string; subject: string }>();
    for (const r of res.results ?? []) {
      let list: string[] = [];
      try {
        const v = JSON.parse(r.recipients);
        if (Array.isArray(v)) list = v.filter((x): x is string => typeof x === 'string');
      } catch {
        list = [];
      }
      out.set(r.id, { recipients: list, sent_by: r.sent_by, subject: r.subject });
    }
  }
  return out;
}

/** Why a waiting line could not be released as things stand, or null. */
export function releaseBlockedReason(line: JudgedOrderDocument, recipients: string[]): string | null {
  const { api } = line;
  if (!api.document_id) return 'There is no document on this line any more.';
  if (api.document_status !== 'active') {
    return `The document is ${api.document_status ?? 'no longer in the portal'}. Only active documents are released.`;
  }
  if (line.judgement.reason === 'no_file') return 'The document has no file on record.';
  if (api.resolution === 'expired') return 'The document has expired. Refuse it, or refresh the line on the order.';
  if (api.sharing_rule === 'locked' || api.sharing_rule === null) {
    return 'The document is locked now. Nobody releases a locked document.';
  }
  if (recipients.length === 0) return 'The send that asked for this document has no recipients on record.';
  return null;
}

/**
 * How many lines are in front of QA. ONE COUNT, no judgement: this is what the
 * rail asks, on a timer, for every releaser with the portal open.
 */
export async function countPendingOrderDocuments(db: D1Database, tenantId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM order_documents
        WHERE tenant_id = ? AND release_status IN ('pending_qa', 'releasing')`,
    )
    .bind(tenantId)
    .first<{ n: number }>();
  return Number(row?.n) || 0;
}

/**
 * Every line in front of QA in the organization, oldest first: waiting, and
 * any whose release was claimed and has not finished. `actor` must be a QA
 * releaser's: the "releasable" answer is theirs.
 *
 * EACH ROW CARRIES WHAT A RELEASE IS PINNED TO -- the document, its version
 * and the asking send -- and the screen sends those three back with the line
 * id, so QA releases what QA was shown or nothing.
 */
export async function listPendingOrderDocuments(
  db: D1Database,
  tenantId: string,
  actor: ExitActor,
): Promise<PendingOrderDocument[]> {
  const rows = await loadJoinedRows(db, tenantId, `od.release_status IN ('pending_qa', 'releasing')`, []);
  if (rows.length === 0) return [];
  const judged = await judgeRows(db, tenantId, rows, actor);

  const orders = new Map<string, { order_number: string; customer_name: string | null }>();
  for (const part of chunk([...new Set(rows.map((r) => r.order_id))])) {
    const res = await db
      .prepare(
        `SELECT o.id, o.order_number, COALESCE(c.name, o.customer_name) AS customer_name
           FROM orders o LEFT JOIN customers c ON c.id = o.customer_id AND c.tenant_id = o.tenant_id
          WHERE o.tenant_id = ? AND o.id IN (${part.map(() => '?').join(', ')})`,
      )
      .bind(tenantId, ...part)
      .all<{ id: string; order_number: string; customer_name: string | null }>();
    for (const r of res.results ?? []) orders.set(r.id, r);
  }

  return judged
    .sort((a, b) => (a.row.pending_at ?? '').localeCompare(b.row.pending_at ?? ''))
    .map((line) => {
      const recipients = line.api.pending_recipients;
      const releasing = line.row.release_status === 'releasing';
      const stuck = line.api.release_stuck;
      const blocked =
        releasing && !stuck
          ? 'This document is being released right now.'
          : releaseBlockedReason(line, recipients);
      const order = orders.get(line.row.order_id);
      return {
        id: line.row.id,
        order_id: line.row.order_id,
        order_number: order?.order_number ?? '',
        customer_name: order?.customer_name ?? null,
        product_name: line.api.product_name,
        supplier_name: line.api.supplier_name,
        facility_name: line.api.facility?.name ?? null,
        document_type_name: line.api.document_type_name,
        document_id: line.api.document_id,
        document_title: line.api.document_title,
        document_status: line.api.document_status,
        version_number: line.api.version_number,
        document_approved_at: line.api.document_approved_at,
        pending_send_id: line.row.pending_send_id,
        release_status: line.row.release_status,
        stuck,
        sharing_rule: line.api.sharing_rule,
        requested_by_name: line.api.pending_requested_by_name,
        requested_at: line.api.pending_at,
        recipients,
        private_label: line.api.private_label,
        advisory: line.api.advisory,
        releasable: blocked === null,
        blocked_reason: blocked,
      };
    });
}
