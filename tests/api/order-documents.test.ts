/**
 * Document orders (migration 0138, decisions C-043 / C-044).
 *
 * What is worth pinning is what the feature must never get wrong:
 *
 *   1. THE CURRENT DOCUMENT is resolved by a stated rule: the item's own
 *      before the supplier's, newest, an expired newest is reported expired
 *      (never swapped for an older one), nothing on file is missing.
 *   2. ONE LINE PER APPROVED PAIR. Several approved suppliers are several
 *      lines; a pair that is not approved is refused and named.
 *   3. A READ-ONLY ACCOUNT BUILDS AND CANNOT SEND.
 *   4. THE LIVE RULE DECIDES, at the send and at the release. The rule stored
 *      on the line when it was added decides nothing.
 *   5. A `qa` DOCUMENT A PLAIN USER SENDS IS HELD: it is on no link and in no
 *      mail, and QA is told once.
 *   6. A RELEASE mints the link in the RELEASER's name, mails the recipients
 *      of the send that asked, once, and is on the order's record.
 *   7. LOCKED NEVER LEAVES, by send or by release.
 *   8. MISSING / EXPIRED tell QA once, and draft nothing to a supplier.
 *   9. Another organization's order or line is a 404, everywhere.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { fnContext, readJson } from '../helpers/requests';
import type { TestUser } from '../helpers/requests';
import { onRequestPost as createOrder } from '../../functions/api/orders/index';
import { onRequestGet as getOrder, onRequestPut as updateOrder } from '../../functions/api/orders/[id]';
import { onRequestPost as addItems } from '../../functions/api/orders/[id]/items/index';
import { onRequestGet as listDocuments, onRequestPost as addDocuments } from '../../functions/api/orders/[id]/documents/index';
import { onRequestDelete as removeDocument } from '../../functions/api/orders/[id]/documents/[lineId]';
import { onRequestPost as refreshDocument } from '../../functions/api/orders/[id]/documents/[lineId]/refresh';
import { onRequestPost as releaseBatch } from '../../functions/api/orders/[id]/documents/release';
import { onRequestPost as releaseOne } from '../../functions/api/orders/[id]/documents/[lineId]/release';
import { onRequestPost as refuseOne } from '../../functions/api/orders/[id]/documents/[lineId]/refuse';
import { onRequestPost as giveBackOne } from '../../functions/api/orders/[id]/documents/[lineId]/give-back';
import { ingestOrders } from '../../functions/lib/kinds/order';
import { mintExportLink } from '../../functions/lib/document-export';
import { RELEASE_OUTCOME_UNRECORDED } from '../../functions/lib/order-document-release';
import { READER_ORDER_CREATE_LIMIT_PER_HOUR } from '../../functions/api/orders/index';
import type { ConnectorOutput } from '../../functions/lib/connectors/types';
import { onRequestGet as pendingList } from '../../functions/api/order-documents/pending';
import { onRequestGet as sendPreview } from '../../functions/api/orders/[id]/send-preview';
import { onRequestPost as sendOrder } from '../../functions/api/orders/[id]/send';
import { onRequestPost as resendOrder } from '../../functions/api/orders/[id]/sends/[sendId]/resend';
import { onRequestGet as exportLanding } from '../../functions/api/document-exports/public/[token]';
import { mergeSuppliers } from '../../functions/lib/suppliers';
import type {
  ApiOrderDocument,
  DocumentExportLandingView,
  OrderDocumentsAddResponse,
  OrderDocumentsReleaseResponse,
  OrderGetResponse,
  OrderSendPreview,
  OrderSendResponse,
  PendingOrderDocumentsResponse,
} from '../../shared/types';

const db = env.DB;
const files = env.FILES;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let supplierA = '';
let supplierB = '';
let customerId = '';
let qaUserId = '';
let qaEmail = '';
const types = { spec: '', haccp: '', guarantee: '', w9: '', coa: '', kosher: '' };

const CUSTOMER_EMAIL = 'buyer@harborbakery.example';

type Who = 'reader' | 'user' | 'qa' | 'org_admin' | 'api_key' | 'other_tenant';

function person(who: Exclude<Who, 'api_key'>): TestUser {
  switch (who) {
    case 'reader':
      return { id: seed.readerId, email: 'reader@test.com', name: 'Reader User', role: 'reader', tenant_id: seed.tenantId };
    case 'user':
      return { id: seed.userId, email: 'user@test.com', name: 'Regular User', role: 'user', tenant_id: seed.tenantId };
    case 'qa':
      return { id: qaUserId, email: qaEmail, name: 'Quality Lead', role: 'user', tenant_id: seed.tenantId };
    case 'org_admin':
      return { id: seed.orgAdminId, email: 'orgadmin@test.com', name: 'Org Admin', role: 'org_admin', tenant_id: seed.tenantId };
    case 'other_tenant':
      return { id: seed.orgAdmin2Id, email: 'orgadmin2@test.com', name: 'Org Admin 2', role: 'org_admin', tenant_id: seed.tenantId2 };
  }
}

/** A handler context for one caller. The API key is the ORG ADMIN's key. */
function as(who: Who, url: string, init: RequestInit & { params?: Record<string, string> } = {}): never {
  const ctx = fnContext(url, { ...init, user: who === 'api_key' ? person('org_admin') : person(who) }) as any;
  ctx.data.authMethod = who === 'api_key' ? 'api_key' : 'jwt';
  if (who === 'api_key') ctx.data.apiKeyId = 'key-under-test';
  return ctx as never;
}

async function call<T>(handler: (ctx: never) => Response | Promise<Response>, ctx: never): Promise<{ status: number; body: T & { error?: string; code?: string } }> {
  const res = await handler(ctx);
  return { status: res.status, body: (await readJson(res)) as T & { error?: string; code?: string } };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function makeSupplier(name: string): Promise<string> {
  const id = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(id, seed.tenantId, name, `s-${id.slice(0, 8)}`)
    .run();
  return id;
}

async function makeType(name: string, rule: string | null, supplierId: string | null = null): Promise<string> {
  const id = generateTestId();
  await db
    .prepare('INSERT INTO document_types (id, tenant_id, name, slug, sharing_rule, supplier_id) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, seed.tenantId, name, `t-${id.slice(0, 8)}`, rule, supplierId)
    .run();
  return id;
}

interface PairOpts {
  supplier?: string;
  approval?: 'approved' | 'pending' | 'not_approved' | null;
  brandOwner?: string | null;
  producer?: string | null;
  product?: string;
}

/** An item and its link to a supplier. `approval: null` = no link row at all. */
async function makePair(name: string, opts: PairOpts = {}): Promise<{ product_id: string; supplier_id: string }> {
  const supplier = opts.supplier ?? supplierA;
  let productId = opts.product;
  if (!productId) {
    productId = generateTestId();
    await db
      .prepare(
        `INSERT INTO products (id, tenant_id, name, slug, brand_owner, producer, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      )
      .bind(productId, seed.tenantId, name, `p-${productId.slice(0, 8)}`, opts.brandOwner ?? null, opts.producer ?? null)
      .run();
  }
  const approval = opts.approval === undefined ? 'approved' : opts.approval;
  if (approval !== null) {
    await db
      .prepare(
        `INSERT INTO product_suppliers (id, tenant_id, product_id, supplier_id, approval_status, approval_source)
         VALUES (?, ?, ?, ?, ?, 'initial')`,
      )
      .bind(generateTestId(), seed.tenantId, productId, supplier, approval)
      .run();
  }
  return { product_id: productId, supplier_id: supplier };
}

interface DocOpts {
  supplier?: string;
  title?: string;
  products?: string[];
  approvedAt?: string | null;
  createdAt?: string;
  /** `documents.renewal_due_date`: the document's own due date. */
  due?: string | null;
  status?: string;
  tenantId?: string;
  withFile?: boolean;
  /** The file size ON RECORD (what the send packs by). The stored bytes stay small. */
  size?: number;
}

async function makeDoc(typeId: string | null, opts: DocOpts = {}): Promise<{ id: string; title: string; fileName: string }> {
  const id = generateTestId();
  const tenantId = opts.tenantId ?? seed.tenantId;
  const own = tenantId === seed.tenantId;
  const title = opts.title ?? `Document ${id.slice(0, 6)}`;
  const createdAt = opts.createdAt ?? '2026-06-01 09:00:00';
  await db
    .prepare(
      `INSERT INTO documents
         (id, tenant_id, title, tags, current_version, status, created_by, supplier_id, document_type_id,
          approved_at, created_at, renewal_due_date)
       VALUES (?, ?, ?, '[]', 1, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      tenantId,
      title,
      opts.status ?? 'active',
      own ? seed.orgAdminId : seed.orgAdmin2Id,
      own ? opts.supplier ?? supplierA : null,
      own ? typeId : null,
      opts.approvedAt === undefined ? createdAt : opts.approvedAt,
      createdAt,
      opts.due ?? null,
    )
    .run();
  const key = `docs/${id}/v1.pdf`;
  const fileName = `INTERNAL do not send ${id.slice(0, 6)}.pdf`;
  await db
    .prepare(
      `INSERT INTO document_versions
         (id, document_id, version_number, file_name, file_size, mime_type, r2_key, uploaded_by)
       VALUES (?, ?, 1, ?, ?, 'application/pdf', ?, ?)`,
    )
    .bind(generateTestId(), id, fileName, opts.size ?? 64, key, own ? seed.orgAdminId : seed.orgAdmin2Id)
    .run();
  if (opts.withFile !== false) await files.put(key, new TextEncoder().encode(`PDF-BYTES-${id}`.padEnd(64, '.')));
  for (const productId of opts.products ?? []) {
    await db
      .prepare('INSERT INTO document_products (id, document_id, product_id) VALUES (?, ?, ?)')
      .bind(generateTestId(), id, productId)
      .run();
  }
  return { id, title, fileName };
}

async function newOrder(who: Who = 'user', over: Record<string, unknown> = {}): Promise<string> {
  const { status, body } = await call<{ order: { id: string } }>(
    createOrder,
    as(who, 'http://localhost/api/orders', {
      method: 'POST',
      body: JSON.stringify({ order_number: `DO-${generateTestId().slice(0, 8)}`, customer_id: customerId, ...over }),
    }),
  );
  expect(status).toBe(201);
  return body.order.id;
}

async function addDocs(
  order: string,
  items: { product_id: string; supplier_id: string }[],
  typeIds: string[],
  who: Who = 'user',
  extra: Record<string, unknown> = {},
) {
  return call<OrderDocumentsAddResponse>(
    addDocuments,
    as(who, `http://localhost/api/orders/${order}/documents`, {
      method: 'POST',
      body: JSON.stringify({ items, document_type_ids: typeIds, ...extra }),
      params: { id: order },
    }),
  );
}

async function readOrder(order: string, who: Who = 'user'): Promise<OrderGetResponse> {
  const { status, body } = await call<OrderGetResponse>(getOrder, as(who, `http://localhost/api/orders/${order}`, { params: { id: order } }));
  expect(status).toBe(200);
  return body;
}

async function lines(order: string, who: Who = 'user'): Promise<ApiOrderDocument[]> {
  return (await readOrder(order, who)).documents ?? [];
}

async function preview(order: string, who: Who = 'user'): Promise<OrderSendPreview> {
  const { status, body } = await call<OrderSendPreview>(
    sendPreview,
    as(who, `http://localhost/api/orders/${order}/send-preview`, { params: { id: order } }),
  );
  expect(status).toBe(200);
  return body;
}

async function send(order: string, who: Who = 'user', body: Record<string, unknown> = {}) {
  return call<OrderSendResponse>(
    sendOrder,
    as(who, `http://localhost/api/orders/${order}/send`, { method: 'POST', body: JSON.stringify(body), params: { id: order } }),
  );
}

interface Target {
  id: string;
  document_id: string;
  version_number: number;
  pending_send_id: string;
}

/**
 * What QA would be looking at for these lines RIGHT NOW: the document on each,
 * its current version, and the send that asked. A release echoes these back.
 */
async function targetsFor(lineIds: string[]): Promise<Target[]> {
  const out: Target[] = [];
  for (const id of lineIds) {
    const row = await db
      .prepare(
        `SELECT od.document_id, od.pending_send_id, d.current_version
           FROM order_documents od LEFT JOIN documents d ON d.id = od.document_id WHERE od.id = ?`,
      )
      .bind(id)
      .first<{ document_id: string | null; pending_send_id: string | null; current_version: number | null }>();
    out.push({
      id,
      document_id: row?.document_id ?? 'no-document',
      version_number: Number(row?.current_version ?? 1),
      pending_send_id: row?.pending_send_id ?? 'no-send',
    });
  }
  return out;
}

async function release(order: string, lineIds: string[], who: Who = 'qa', targets?: Target[]) {
  return call<OrderDocumentsReleaseResponse>(
    releaseBatch,
    as(who, `http://localhost/api/orders/${order}/documents/release`, {
      method: 'POST',
      body: JSON.stringify({ lines: targets ?? (await targetsFor(lineIds)) }),
      params: { id: order },
    }),
  );
}

async function refuse(order: string, lineId: string, note: unknown, who: Who = 'qa', target?: Partial<Target>) {
  const [seen] = await targetsFor([lineId]);
  return call<{ success?: boolean }>(
    refuseOne,
    as(who, `http://localhost/api/orders/${order}/documents/${lineId}/refuse`, {
      method: 'POST',
      body: JSON.stringify({ note, document_id: seen.document_id, pending_send_id: seen.pending_send_id, ...target }),
      params: { id: order, lineId },
    }),
  );
}

async function resend(order: string, sendId: string, who: Who = 'org_admin') {
  return call<OrderSendResponse>(
    resendOrder,
    as(who, `http://localhost/api/orders/${order}/sends/${sendId}/resend`, { method: 'POST', body: '{}', params: { id: order, sendId } }),
  );
}

async function orderStatus(order: string): Promise<string> {
  return (await db.prepare('SELECT status FROM orders WHERE id = ?').bind(order).first<{ status: string }>())!.status;
}

async function refresh(order: string, lineId: string, who: Who = 'user') {
  return call<{ changed: boolean; document: ApiOrderDocument }>(
    refreshDocument,
    as(who, `http://localhost/api/orders/${order}/documents/${lineId}/refresh`, { method: 'POST', params: { id: order, lineId } }),
  );
}

async function pending(who: Who = 'qa'): Promise<PendingOrderDocumentsResponse> {
  const { status, body } = await call<PendingOrderDocumentsResponse>(pendingList, as(who, 'http://localhost/api/order-documents/pending'));
  expect(status).toBe(200);
  return body;
}

interface CapturedMail {
  from: string;
  to: string[];
  subject: string;
  html: string;
  reply_to?: string;
  attachments?: { filename: string; content: string }[];
}

function stubMail(fail: (mail: CapturedMail) => boolean = () => false): CapturedMail[] {
  const sent: CapturedMail[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('resend.com')) {
        const mail = JSON.parse(String(init?.body)) as CapturedMail;
        if (fail(mail)) return new Response('{"message":"provider said no"}', { status: 500 });
        sent.push(mail);
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }),
  );
  return sent;
}

const toCustomer = (mails: CapturedMail[]) => mails.filter((m) => m.to.includes(CUSTOMER_EMAIL));
const toQa = (mails: CapturedMail[]) => mails.filter((m) => m.to.includes(qaEmail));

interface LinkRow {
  id: string;
  token: string;
  created_by: string;
  document_ids: string;
  expires_at: string;
  never_expires: number;
  revoked_at: string | null;
}

async function linkById(id: string | null): Promise<LinkRow | null> {
  if (!id) return null;
  return db.prepare('SELECT * FROM document_export_links WHERE id = ?').bind(id).first<LinkRow>();
}

async function linksHolding(documentId: string): Promise<LinkRow[]> {
  const res = await db.prepare('SELECT * FROM document_export_links WHERE tenant_id = ?').bind(seed.tenantId).all<LinkRow>();
  return (res.results ?? []).filter((l) => (JSON.parse(l.document_ids) as string[]).includes(documentId));
}

async function landing(token: string): Promise<DocumentExportLandingView> {
  const res = await exportLanding(fnContext(`http://localhost/api/document-exports/public/${token}`, { params: { token } }));
  expect(res.status).toBe(200);
  return (await readJson(res)) as DocumentExportLandingView;
}

async function lineRow(id: string): Promise<Record<string, any>> {
  return (await db.prepare('SELECT * FROM order_documents WHERE id = ?').bind(id).first<Record<string, any>>())!;
}

async function audits(action: string, resourceId?: string): Promise<{ user_id: string | null; resource_id: string | null; details: any }[]> {
  const res = await db
    .prepare('SELECT user_id, resource_id, details FROM audit_log WHERE action = ? AND tenant_id = ? ORDER BY id ASC')
    .bind(action, seed.tenantId)
    .all<{ user_id: string | null; resource_id: string | null; details: string | null }>();
  return (res.results ?? [])
    .filter((r) => !resourceId || r.resource_id === resourceId)
    .map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
}

async function setOverride(documentId: string, rule: string | null): Promise<void> {
  await db.prepare('UPDATE documents SET sharing_rule_override = ? WHERE id = ?').bind(rule, documentId).run();
}

beforeAll(async () => {
  seed = await seedTestData(db);
  supplierA = await makeSupplier('Northfield Creamery');
  supplierB = await makeSupplier('Lakeshore Dairy Cooperative');
  types.spec = await makeType('Spec Sheet', 'free');
  types.haccp = await makeType('HACCP Plan', 'qa');
  types.guarantee = await makeType('Letter of Guarantee', 'qa');
  types.w9 = await makeType('W-9', 'locked');
  types.coa = await makeType('Certificate of Analysis', 'free');
  types.kosher = await makeType('Kosher Certificate', 'free');

  qaUserId = generateTestId();
  qaEmail = `qa-${qaUserId.slice(0, 6)}@test.com`;
  await db
    .prepare(
      `INSERT INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
       VALUES (?, ?, 'Quality Lead', 'user', ?, 'x', 1, 0)`,
    )
    .bind(qaUserId, qaEmail, seed.tenantId)
    .run();
  await db
    .prepare(`INSERT INTO owner_routes (id, tenant_id, owner_key, owner_label, user_id, active) VALUES (?, ?, 'qa', 'QA', ?, 1)`)
    .bind(generateTestId(), seed.tenantId, qaUserId)
    .run();

  customerId = generateTestId();
  await db
    .prepare(
      `INSERT INTO customers (id, tenant_id, customer_number, name, email, created_at, updated_at)
       VALUES (?, ?, ?, 'Harbor Bakery', ?, datetime('now'), datetime('now'))`,
    )
    .bind(customerId, seed.tenantId, `C-${customerId.slice(0, 6)}`, CUSTOMER_EMAIL)
    .run();
}, 30_000);

afterEach(async () => {
  vi.unstubAllGlobals();
  await db.prepare(`DELETE FROM rate_limits WHERE key LIKE 'order_send:%' OR key LIKE 'order_create:%'`).run();
});

// ===========================================================================
// Resolving the current document
// ===========================================================================

describe('resolving an item to its supplier\'s current document', () => {
  it('finds the supplier-level document, and says missing when there is none', async () => {
    const supplier = await makeSupplier('Resolve One Dairy');
    const pair = await makePair('Cream Cheese R1', { supplier });
    const spec = await makeDoc(types.spec, { supplier, title: 'Cream cheese spec R1' });
    const order = await newOrder();

    const { status, body } = await addDocs(order, [pair], [types.spec, types.haccp]);
    expect(status).toBe(201);
    expect(body.refused).toEqual([]);
    const bySlug = Object.fromEntries(body.lines.map((l) => [l.document_type_name, l]));
    expect(bySlug['Spec Sheet']).toMatchObject({ resolution: 'found', document_id: spec.id, sharing_rule: 'free', outcome: 'added' });
    expect(bySlug['HACCP Plan']).toMatchObject({ resolution: 'missing', document_id: null, sharing_rule: null, outcome: 'added' });

    const onOrder = await lines(order);
    expect(onOrder).toHaveLength(2);
    const specLine = onOrder.find((l) => l.document_type_id === types.spec)!;
    expect(specLine).toMatchObject({
      product_name: 'Cream Cheese R1',
      supplier_name: 'Resolve One Dairy',
      document_title: 'Cream cheese spec R1',
      resolution: 'found',
      rule_at_resolve: 'free',
      sharing_rule: 'free',
      disposition: 'goes_now',
      delivery: 'link',
    });
    expect(onOrder.find((l) => l.document_type_id === types.haccp)).toMatchObject({
      resolution: 'missing',
      disposition: 'will_not_go',
      disposition_reason: 'missing',
    });
  });

  it('prefers the document linked to the item over a newer supplier-level one, and never offers another item\'s', async () => {
    const supplier = await makeSupplier('Resolve Two Dairy');
    const cheese = await makePair('Cream Cheese R2', { supplier });
    const cream = await makePair('Heavy Cream R2', { supplier });
    const forCheese = await makeDoc(types.spec, { supplier, products: [cheese.product_id], createdAt: '2025-01-10 09:00:00' });
    await makeDoc(types.spec, { supplier, createdAt: '2026-08-01 09:00:00', title: 'Supplier-wide spec' });
    const forCream = await makeDoc(types.kosher, { supplier, products: [cream.product_id] });
    const order = await newOrder();

    const { body } = await addDocs(order, [cheese], [types.spec, types.kosher]);
    expect(body.lines.find((l) => l.document_type_id === types.spec)).toMatchObject({ resolution: 'found', document_id: forCheese.id });
    // The only kosher certificate on file is the heavy cream's: not this item's.
    const kosher = body.lines.find((l) => l.document_type_id === types.kosher)!;
    expect(kosher.resolution).toBe('missing');
    expect(kosher.document_id).not.toBe(forCream.id);
  });

  it('reports EXPIRED for an expired newest document instead of falling back to an older one in date', async () => {
    const supplier = await makeSupplier('Resolve Three Dairy');
    const pair = await makePair('Butter R3', { supplier });
    await makeDoc(types.kosher, { supplier, createdAt: '2025-01-01 09:00:00', due: '2030-01-01', title: 'Older, in date' });
    const lapsed = await makeDoc(types.kosher, { supplier, createdAt: '2026-01-01 09:00:00', due: '2026-03-01', title: 'Newest, lapsed' });
    const order = await newOrder();

    const { body } = await addDocs(order, [pair], [types.kosher]);
    expect(body.lines[0]).toMatchObject({ resolution: 'expired', document_id: lapsed.id, document_due_date: '2026-03-01' });
    expect(body.lines[0].resolution_note).toContain('still in date');
    const [line] = await lines(order);
    expect(line).toMatchObject({ resolution: 'expired', disposition: 'will_not_go', disposition_reason: 'expired' });
  });

  it('breaks a tie the same way every time, and says there was one', async () => {
    const supplier = await makeSupplier('Resolve Four Dairy');
    const pair = await makePair('Yogurt R4', { supplier });
    const same = '2026-04-04 10:00:00';
    const a = await makeDoc(types.spec, { supplier, createdAt: same });
    const b = await makeDoc(types.spec, { supplier, createdAt: same });
    const expected = a.id > b.id ? a.id : b.id;
    const order = await newOrder();

    const first = await addDocs(order, [pair], [types.spec], 'user', { dry_run: true });
    const second = await addDocs(order, [pair], [types.spec], 'user', { dry_run: true });
    expect(first.body.lines[0].document_id).toBe(expected);
    expect(second.body.lines[0].document_id).toBe(expected);
    expect(first.body.lines[0].resolution_note).toContain('share the same date');
  });

  it('a dry run writes nothing', async () => {
    const pair = await makePair('Sour Cream DR');
    const order = await newOrder();
    const { status, body } = await addDocs(order, [pair], [types.spec], 'user', { dry_run: true });
    expect(status).toBe(200);
    expect(body.dry_run).toBe(true);
    expect(body.lines[0].outcome).toBe('would_add');
    expect(await lines(order)).toEqual([]);
  });

  it('reads a supplier\'s own type of the same name, and refuses a type that belongs to another supplier', async () => {
    const supplier = await makeSupplier('Resolve Five Dairy');
    const pair = await makePair('Kefir R5', { supplier });
    const own = await makeType('Spec Sheet', 'free', supplier);
    const filedUnderOwn = await makeDoc(own, { supplier, title: 'Filed under the supplier\'s own type' });
    const foreign = await makeType('Process Flow', 'free', supplierB);
    const order = await newOrder();

    const { body } = await addDocs(order, [pair], [types.spec, foreign]);
    expect(body.lines.find((l) => l.document_type_id === types.spec)).toMatchObject({ resolution: 'found', document_id: filedUnderOwn.id });
    expect(body.refused).toHaveLength(1);
    expect(body.refused[0]).toMatchObject({ document_type_id: foreign });
    expect(body.refused[0].reason).toContain("another supplier's own document type");
  });

  it('refresh takes a newer document, and clears what was decided about the old one', async () => {
    const supplier = await makeSupplier('Resolve Six Dairy');
    const pair = await makePair('Ricotta R6', { supplier });
    const order = await newOrder();
    await addDocs(order, [pair], [types.spec]);
    const [before] = await lines(order);
    expect(before.resolution).toBe('missing');
    expect(before.stale).toBe(false);

    const arrived = await makeDoc(types.spec, { supplier });
    const [stale] = await lines(order);
    expect(stale.stale).toBe(true);
    expect(stale.disposition_reason).toBe('stale');
    expect(stale.document_id).toBeNull(); // nothing re-resolved behind the person's back

    await db.prepare(`UPDATE order_documents SET qa_notified_at = datetime('now'), qa_notified_cause = 'missing' WHERE id = ?`).bind(before.id).run();
    const res = await call<{ changed: boolean; document: ApiOrderDocument }>(
      refreshDocument,
      as('reader', `http://localhost/api/orders/${order}/documents/${before.id}/refresh`, { method: 'POST', params: { id: order, lineId: before.id } }),
    );
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.document).toMatchObject({ document_id: arrived.id, resolution: 'found', stale: false });
    expect((await lineRow(before.id)).qa_notified_at).toBeNull();
  });
});

// ===========================================================================
// Building the order
// ===========================================================================

describe('building a document order', () => {
  it('several approved suppliers give several lines; nothing picks one', async () => {
    const first = await makePair('Heavy Cream MS', { supplier: supplierA });
    const second = await makePair('Heavy Cream MS', { supplier: supplierB, product: first.product_id });
    const docA = await makeDoc(types.spec, { supplier: supplierA, products: [first.product_id] });
    const docB = await makeDoc(types.spec, { supplier: supplierB, products: [first.product_id] });
    const order = await newOrder();

    const { status, body } = await addDocs(order, [first, second], [types.spec]);
    expect(status).toBe(201);
    expect(body.lines.map((l) => [l.supplier_id, l.document_id]).sort()).toEqual(
      [[supplierA, docA.id], [supplierB, docB.id]].sort(),
    );
    expect(await lines(order)).toHaveLength(2);

    // Adding the same thing again adds nothing and says so.
    const again = await addDocs(order, [first], [types.spec]);
    expect(again.status).toBe(200);
    expect(again.body.lines[0].outcome).toBe('already_on_order');
    expect(await lines(order)).toHaveLength(2);
  });

  it('refuses a pair that is not approved, names it, and still adds the rest', async () => {
    const good = await makePair('Approved Item');
    const waiting = await makePair('Pending Item', { approval: 'pending' });
    const no = await makePair('Rejected Item', { approval: 'not_approved' });
    const unlinked = await makePair('Legacy Item', { approval: null });
    const order = await newOrder();

    const { status, body } = await addDocs(order, [good, waiting, no, unlinked], [types.spec]);
    expect(status).toBe(201);
    expect(body.lines.map((l) => l.product_id)).toEqual([good.product_id]);
    const reasons = Object.fromEntries(body.refused.map((r) => [r.product_id, r.reason]));
    expect(reasons[waiting.product_id]).toContain('waiting for approval');
    expect(reasons[no.product_id]).toContain('not approved');
    expect(reasons[unlinked.product_id]).toContain('waiting for approval');
    expect(body.refused.find((r) => r.product_id === no.product_id)?.product_name).toBe('Rejected Item');

    // Every pair refused: nothing written, and an error rather than a 201.
    const none = await addDocs(order, [waiting], [types.spec]);
    expect(none.status).toBe(400);
    expect(none.body.error).toContain('waiting for approval');
  });

  it('a read-only account opens an order and builds it, and can do nothing else', async () => {
    const pair = await makePair('Reader Item');
    const spec = await makeDoc(types.spec, { products: [pair.product_id] });
    const order = await newOrder('reader');

    const added = await addDocs(order, [pair], [types.spec], 'reader');
    expect(added.status).toBe(201);
    const [line] = await lines(order, 'reader');
    expect(line.document_id).toBe(spec.id);
    expect((await lineRow(line.id)).added_by).toBe(seed.readerId);

    // Not COA lines, at create or after.
    const withItems = await call(createOrder, as('reader', 'http://localhost/api/orders', {
      method: 'POST',
      body: JSON.stringify({ order_number: `DO-${generateTestId().slice(0, 8)}`, items: [{ product_name: 'x' }] }),
    }));
    expect(withItems.status).toBe(403);
    const pick = await call(addItems, as('reader', `http://localhost/api/orders/${order}/items`, {
      method: 'POST', body: JSON.stringify({ document_ids: [spec.id] }), params: { id: order },
    }));
    expect(pick.status).toBe(403);
    // Not the order's own fields.
    const edit = await call(updateOrder, as('reader', `http://localhost/api/orders/${order}`, {
      method: 'PUT', body: JSON.stringify({ po_number: 'PO-1' }), params: { id: order },
    }));
    expect(edit.status).toBe(403);
    // Not the review, and not the send.
    const review = await call(sendPreview, as('reader', `http://localhost/api/orders/${order}/send-preview`, { params: { id: order } }));
    expect(review.status).toBe(403);
    const mails = stubMail();
    expect((await send(order, 'reader')).status).toBe(403);
    expect(mails).toHaveLength(0);

    // And they can take a line back off.
    const removed = await call(removeDocument, as('reader', `http://localhost/api/orders/${order}/documents/${line.id}`, {
      method: 'DELETE', params: { id: order, lineId: line.id },
    }));
    expect(removed.status).toBe(200);
    expect(await lines(order)).toEqual([]);
  });

  it('another organization\'s order and line ids are a 404 on every route', async () => {
    const pair = await makePair('Tenant Wall Item');
    await makeDoc(types.haccp, { products: [pair.product_id] });
    const order = await newOrder();
    await addDocs(order, [pair], [types.haccp]);
    const [line] = await lines(order);
    stubMail();
    await send(order, 'user');
    expect((await lineRow(line.id)).release_status).toBe('pending_qa');

    const o = 'other_tenant';
    const url = `http://localhost/api/orders/${order}/documents`;
    expect((await addDocs(order, [pair], [types.spec], o)).status).toBe(404);
    expect((await call(listDocuments, as(o, url, { params: { id: order } }))).status).toBe(404);
    expect((await call(removeDocument, as(o, `${url}/${line.id}`, { method: 'DELETE', params: { id: order, lineId: line.id } }))).status).toBe(404);
    expect((await call(refreshDocument, as(o, `${url}/${line.id}/refresh`, { method: 'POST', params: { id: order, lineId: line.id } }))).status).toBe(404);
    expect((await release(order, [line.id], o)).status).toBe(404);
    expect((await call(releaseOne, as(o, `${url}/${line.id}/release`, { method: 'POST', params: { id: order, lineId: line.id } }))).status).toBe(404);
    expect((await refuse(order, line.id, 'no', o)).status).toBe(404);
    expect((await pending(o)).lines).toEqual([]);

    // A line id of THIS organization, named on the wrong order, is a 404 too.
    const otherOrder = await newOrder();
    expect((await release(otherOrder, [line.id])).status).toBe(404);
    expect((await refuse(otherOrder, line.id, 'no')).status).toBe(404);
    expect((await call(removeDocument, as('user', `http://localhost/api/orders/${otherOrder}/documents/${line.id}`, {
      method: 'DELETE', params: { id: otherOrder, lineId: line.id },
    }))).status).toBe(404);
    expect((await lineRow(line.id)).release_status).toBe('pending_qa');

    // Another organization's items cannot be put on our order.
    const foreignProduct = generateTestId();
    await db.prepare(`INSERT INTO products (id, tenant_id, name, slug) VALUES (?, ?, 'Foreign', ?)`).bind(foreignProduct, seed.tenantId2, `fp-${foreignProduct.slice(0, 6)}`).run();
    const foreign = await addDocs(order, [{ product_id: foreignProduct, supplier_id: supplierA }], [types.spec]);
    expect(foreign.status).toBe(400);
    expect(foreign.body.refused[0].reason).toContain('not in this organization');
  });
});

// ===========================================================================
// Sending
// ===========================================================================

describe('sending a document order', () => {
  it('a free document leaves on a 30-day link, and the link serves it; an order of documents alone sends', async () => {
    const pair = await makePair('Free Send Item', { brandOwner: 'Harbor Pantry', producer: 'Northfield Creamery' });
    const spec = await makeDoc(types.spec, { products: [pair.product_id], title: 'Free send spec' });
    const order = await newOrder();
    await addDocs(order, [pair], [types.spec]);

    const plan = await preview(order);
    expect(plan.blocked).toBeNull();
    expect(plan.documents?.goes_now).toHaveLength(1);
    expect(plan.documents?.waits_for_qa).toEqual([]);
    expect(plan.documents?.will_not_go).toEqual([]);
    expect(plan.documents?.link_days).toBe(30);
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]).toMatchObject({ delivery: 'link', link_days: 30, part_number: 1 });
    // The private-label advisory is in the review, for the sender.
    expect(plan.documents?.goes_now[0].advisory).toContain("the producer's own and names Northfield Creamery");

    const mails = stubMail();
    const { status, body } = await send(order, 'user', { fingerprint: plan.fingerprint });
    expect(status).toBe(200);
    expect(body.send.kind).toBe('send');
    expect(body.sent).toBe(true);
    expect(body.order_status).toBe('delivered');
    expect(body.documents).toMatchObject({ sent: 1, pending_qa: 0, not_sent: 0, qa_notice: null });
    expect(body.send.files[0]).toMatchObject({ delivery: 'link', link_days: 30, sent_ok: true });

    const customerMails = toCustomer(mails);
    expect(customerMails).toHaveLength(1);
    expect(customerMails[0].attachments ?? []).toEqual([]);
    expect(customerMails[0].html).toContain('This link works for 30 days.');
    // The advisory is the sender's, never the customer's; nor is the uploaded name.
    expect(customerMails[0].html).not.toContain("producer's own");
    expect(customerMails[0].html).not.toContain(spec.fileName);

    const row = await lineRow((await lines(order))[0].id);
    expect(row.last_send_id).toBe(body.send.id);
    const link = (await linkById(row.export_link_id))!;
    expect(link.created_by).toBe(seed.userId);
    expect(Number(link.never_expires)).toBe(0);
    const days = (new Date(link.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
    expect(customerMails[0].html).toContain(`/export/${link.token}`);

    const view = await landing(link.token);
    expect(view.documents).toHaveLength(1);
    expect(view.unavailable_count).toBe(0);
  });

  it('a certificate of analysis on a document line goes attached, like a COA pick', async () => {
    const pair = await makePair('COA Line Item');
    const coa = await makeDoc(types.coa, { products: [pair.product_id], title: 'COA for the line' });
    const order = await newOrder();
    await addDocs(order, [pair], [types.coa]);

    const plan = await preview(order);
    expect(plan.documents?.goes_now[0].delivery).toBe('attachment');
    expect(plan.files[0]).toMatchObject({ delivery: 'attachment' });
    expect(plan.files[0].link_days ?? null).toBeNull();

    const mails = stubMail();
    const { status, body } = await send(order);
    expect(status).toBe(200);
    expect(toCustomer(mails)[0].attachments).toHaveLength(1);
    expect(toCustomer(mails)[0].attachments![0].filename).not.toBe(coa.fileName);
    expect(await linksHolding(coa.id)).toEqual([]);
    expect(body.order_status).toBe('delivered');
  });

  it('a qa document sent by a plain user is HELD: on no link, in no mail, and QA is told exactly once across two sends', async () => {
    const pair = await makePair('Held Item');
    const spec = await makeDoc(types.spec, { products: [pair.product_id], title: 'Held order spec' });
    const plan = await makeDoc(types.haccp, { products: [pair.product_id], title: 'Held hazard plan' });
    const order = await newOrder();
    await addDocs(order, [pair], [types.spec, types.haccp]);

    const review = await preview(order);
    expect(review.documents?.goes_now.map((l) => l.document_id)).toEqual([spec.id]);
    expect(review.documents?.waits_for_qa.map((l) => l.document_id)).toEqual([plan.id]);
    expect(review.documents?.waits_for_qa[0].notifies_qa).toBe(true);
    expect(review.files.flatMap((f) => f.document_ids)).toEqual([spec.id]);

    const mails = stubMail();
    const first = await send(order);
    expect(first.status).toBe(200);
    expect(first.body.documents).toMatchObject({ sent: 1, pending_qa: 1 });
    expect(first.body.documents?.qa_notice).toMatchObject({ sent: true, via: 'owner_route', line_count: 1 });
    // The order is NOT delivered while a document waits.
    expect(first.body.order_status).not.toBe('delivered');

    // On no link, in no mail to the customer.
    expect(await linksHolding(plan.id)).toEqual([]);
    expect(toCustomer(mails)).toHaveLength(1);
    expect(toCustomer(mails)[0].html).not.toContain('Held hazard plan');
    expect(first.body.send.files.flatMap((f) => f.document_ids)).toEqual([spec.id]);

    const held = (await lines(order)).find((l) => l.document_id === plan.id)!;
    expect(held.release_status).toBe('pending_qa');
    expect((await lineRow(held.id)).pending_send_id).toBe(first.body.send.id);

    // QA was told, with what was asked for and by whom, and a way in.
    expect(toQa(mails)).toHaveLength(1);
    const notice = toQa(mails)[0].html;
    expect(notice).toContain('HACCP Plan');
    expect(notice).toContain('Northfield Creamery');
    expect(notice).toContain('Held Item');
    expect(notice).toContain('Regular User');
    expect(notice).toContain(`/orders/${order}`);
    expect(notice).toContain('Nothing has been sent or drafted to a supplier.');

    // A second send does not tell QA again.
    const second = await send(order);
    expect(second.status).toBe(200);
    expect(toQa(mails)).toHaveLength(1);
    expect(second.body.documents?.qa_notice).toBeNull();
    expect(await linksHolding(plan.id)).toEqual([]);

    // It is on QA's list, and on nobody else's.
    const mine = await pending('qa');
    expect(mine.can_release).toBe(true);
    expect(mine.lines.find((l) => l.id === held.id)).toMatchObject({
      document_id: plan.id,
      sharing_rule: 'qa',
      recipients: [CUSTOMER_EMAIL],
      requested_by_name: 'Regular User',
      releasable: true,
    });
    expect(await pending('user')).toEqual({ can_release: false, count: 0, lines: [] });
    expect(await pending('reader')).toEqual({ can_release: false, count: 0, lines: [] });
    const viaKey = await call<PendingOrderDocumentsResponse>(pendingList, as('api_key', 'http://localhost/api/order-documents/pending'));
    expect(viaKey.body).toEqual({ can_release: false, count: 0, lines: [] });
  });

  it('a qa document sent by a QA releaser goes now, in their name, and is audited as the approval', async () => {
    const pair = await makePair('Releaser Send Item');
    const plan = await makeDoc(types.haccp, { products: [pair.product_id] });
    const order = await newOrder();
    await addDocs(order, [pair], [types.haccp]);

    const review = await preview(order, 'qa');
    expect(review.documents?.goes_now.map((l) => l.document_id)).toEqual([plan.id]);
    expect(review.documents?.waits_for_qa).toEqual([]);
    // The same order, reviewed by a plain user, would hold it.
    expect((await preview(order, 'user')).documents?.waits_for_qa).toHaveLength(1);

    const mails = stubMail();
    const { status, body } = await send(order, 'qa');
    expect(status).toBe(200);
    expect(body.documents).toMatchObject({ sent: 1, pending_qa: 0, qa_notice: null });
    expect(toQa(mails)).toHaveLength(0);

    const [line] = await lines(order);
    expect(line.release_status).toBe('released');
    expect(line.decided_by_name).toBe('Quality Lead');
    const link = (await linkById((await lineRow(line.id)).export_link_id))!;
    expect(link.created_by).toBe(qaUserId);
    expect((await landing(link.token)).documents).toHaveLength(1);

    const approval = await audits('document.qa_release_approved', body.send.id);
    expect(approval).toHaveLength(1);
    expect(approval[0].user_id).toBe(qaUserId);
    expect(approval[0].details).toMatchObject({ exit: 'order_send', document_ids: [plan.id] });
  });

  it('a rule loosened after the line was added is honoured at send; the stored rule decides nothing', async () => {
    const pair = await makePair('Loosened Item');
    const plan = await makeDoc(types.haccp, { products: [pair.product_id] });
    const order = await newOrder();
    await addDocs(order, [pair], [types.haccp]);
    const [line] = await lines(order);
    expect(line.rule_at_resolve).toBe('qa');
    expect(line.disposition).toBe('waits_for_qa');

    await setOverride(plan.id, 'free');
    const [now] = await lines(order);
    expect(now).toMatchObject({ rule_at_resolve: 'qa', sharing_rule: 'free', disposition: 'goes_now' });

    const mails = stubMail();
    const { status, body } = await send(order, 'user');
    expect(status).toBe(200);
    expect(body.documents).toMatchObject({ sent: 1, pending_qa: 0 });
    expect(toCustomer(mails)).toHaveLength(1);
    expect(await linksHolding(plan.id)).toHaveLength(1);
    expect((await lineRow(line.id)).rule_at_resolve).toBe('qa');
  });

  it('locked never leaves by send: a locked type, and a document locked after the line was added', async () => {
    const pair = await makePair('Locked Item');
    const w9 = await makeDoc(types.w9, { products: [pair.product_id] });
    const spec = await makeDoc(types.spec, { products: [pair.product_id] });
    const order = await newOrder();
    await addDocs(order, [pair], [types.w9, types.spec]);
    const added = await lines(order);
    expect(added.find((l) => l.document_id === spec.id)?.rule_at_resolve).toBe('free');

    // Lock the spec sheet AFTER it was added as free.
    await setOverride(spec.id, 'locked');
    for (const who of ['user', 'qa', 'org_admin'] as const) {
      const review = await preview(order, who);
      expect(review.documents?.goes_now).toEqual([]);
      expect(review.documents?.will_not_go.map((l) => l.reason)).toEqual(['locked', 'locked']);
      expect(review.blocked?.code).toBe('nothing_to_send');
      expect(review.lines_not_sent.filter((l) => l.order_document_id).map((l) => l.sharing_refusal)).toEqual(['locked', 'locked']);
    }
    const mails = stubMail();
    expect((await send(order, 'org_admin')).status).toBe(400);
    expect(mails).toHaveLength(0);
    expect(await linksHolding(w9.id)).toEqual([]);
    expect(await linksHolding(spec.id)).toEqual([]);
  });

  it('missing and expired tell QA once, name what was asked for, and draft nothing to a supplier', async () => {
    const supplier = await makeSupplier('Gap Notice Dairy');
    const pair = await makePair('Gap Notice Item', { supplier });
    await makeDoc(types.kosher, { supplier, due: '2026-02-02', title: 'Lapsed kosher certificate' });
    const order = await newOrder();
    await addDocs(order, [pair], [types.haccp, types.kosher]);
    const requestsBefore = (await db.prepare('SELECT COUNT(*) AS n FROM document_requests').first<{ n: number }>())!.n;
    const renewalsBefore = (await db.prepare('SELECT COUNT(*) AS n FROM renewal_request_sends').first<{ n: number }>())!.n;

    const review = await preview(order);
    expect(review.blocked).toBeNull();
    expect(review.documents?.only_asks_qa).toBe(true);
    expect(review.documents?.will_not_go.map((l) => l.reason).sort()).toEqual(['expired', 'missing']);
    expect(review.documents?.will_not_go.every((l) => l.notifies_qa)).toBe(true);
    expect(review.files).toEqual([]);
    expect(review.part_count).toBe(0);

    const mails = stubMail();
    const first = await send(order);
    expect(first.status).toBe(200);
    expect(first.body.send.kind).toBe('qa_request');
    expect(first.body.send.files).toEqual([]);
    expect(first.body.documents).toMatchObject({ sent: 0, pending_qa: 0, not_sent: 2 });
    expect(first.body.documents?.qa_notice).toMatchObject({ sent: true, via: 'owner_route', line_count: 2 });
    expect(first.body.order_status).not.toBe('delivered');

    // Nothing to the customer, nothing to any supplier, nothing drafted.
    expect(toCustomer(mails)).toHaveLength(0);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual([qaEmail]);
    expect(mails[0].html).toContain('Ordered, and not on file');
    expect(mails[0].html).toContain('Ordered, and expired');
    expect(mails[0].html).toContain('Gap Notice Dairy');
    expect(mails[0].html).toContain('Gap Notice Item');
    expect((await db.prepare('SELECT COUNT(*) AS n FROM document_requests').first<{ n: number }>())!.n).toBe(requestsBefore);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM renewal_request_sends').first<{ n: number }>())!.n).toBe(renewalsBefore);

    // Told once: with nothing new to say, a second send has nothing to do.
    const again = await preview(order);
    expect(again.documents?.will_not_go.every((l) => !l.notifies_qa)).toBe(true);
    expect(again.blocked?.code).toBe('nothing_to_send');
    expect((await send(order)).status).toBe(400);
    expect(mails).toHaveLength(1);
  });

  it('with no QA route, the gap is audited and the administrators are told instead', async () => {
    const supplier = await makeSupplier('No Route Dairy');
    const pair = await makePair('No Route Item', { supplier });
    const order = await newOrder();
    await addDocs(order, [pair], [types.haccp]);

    await db.prepare(`UPDATE owner_routes SET active = 0 WHERE tenant_id = ? AND user_id = ?`).bind(seed.tenantId, qaUserId).run();
    try {
      const mails = stubMail();
      const { status, body } = await send(order);
      expect(status).toBe(200);
      expect(body.documents?.qa_notice).toMatchObject({ sent: true, via: 'routing_gap' });
      expect(toQa(mails)).toHaveLength(0);
      expect(mails).toHaveLength(1);
      expect(mails[0].to).toContain('orgadmin@test.com');
      expect(mails[0].html).toContain('Nobody is on the QA owner route');

      const gap = await audits('order.documents_qa_notice.routing_gap', order);
      expect(gap).toHaveLength(1);
      expect(gap[0].details).toMatchObject({ owner_label: 'QA', order_id: order });
      expect(gap[0].details.lines[0].cause).toBe('missing');
    } finally {
      await db.prepare(`UPDATE owner_routes SET active = 1 WHERE tenant_id = ? AND user_id = ?`).bind(seed.tenantId, qaUserId).run();
    }
  });

  it('a resend of a failed part with document lines asks the rule again', async () => {
    const pair = await makePair('Resend Item');
    const spec = await makeDoc(types.spec, { products: [pair.product_id] });
    const order = await newOrder('org_admin');
    await addDocs(order, [pair], [types.spec], 'org_admin');

    let refuseMail = true;
    const mails = stubMail(() => refuseMail);
    const failed = await send(order, 'org_admin');
    expect(failed.status).toBe(502);
    const sendId = failed.body.send.id;
    // The link minted for the failed mail was taken back.
    expect((await linksHolding(spec.id)).every((l) => l.revoked_at !== null)).toBe(true);
    expect((await lineRow((await lines(order))[0].id)).last_send_id).toBeNull();

    const resend = () =>
      call<OrderSendResponse>(
        resendOrder,
        as('org_admin', `http://localhost/api/orders/${order}/sends/${sendId}/resend`, { method: 'POST', body: '{}', params: { id: order, sendId } }),
      );

    // Locked since the first attempt: the retry does not carry it out.
    refuseMail = false;
    await setOverride(spec.id, 'locked');
    const blocked = await resend();
    expect(blocked.status).toBe(200);
    expect(blocked.body.send.status).toBe('failed');
    expect(blocked.body.send.parts[0].error).toContain('was not sent');
    expect(mails).toHaveLength(0);
    expect((await linksHolding(spec.id)).every((l) => l.revoked_at !== null)).toBe(true);

    // Unlocked again: it goes, on a fresh link.
    await setOverride(spec.id, null);
    const ok = await resend();
    expect(ok.body.send.status).toBe('sent');
    expect(toCustomer(mails)).toHaveLength(1);
    const live = (await linksHolding(spec.id)).filter((l) => l.revoked_at === null);
    expect(live).toHaveLength(1);
    expect(live[0].created_by).toBe(seed.orgAdminId);
    expect((await lineRow((await lines(order))[0].id)).last_send_id).toBe(sendId);
  });
});

// ===========================================================================
// QA: release and refuse
// ===========================================================================

describe('QA releasing and refusing held documents', () => {
  /** An order with two `qa` lines, sent by a plain user so both are waiting. */
  async function heldOrder(name: string) {
    const pair = await makePair(name);
    const plan = await makeDoc(types.haccp, { products: [pair.product_id], title: `${name} hazard plan` });
    const letter = await makeDoc(types.guarantee, { products: [pair.product_id], title: `${name} guarantee` });
    const order = await newOrder();
    await addDocs(order, [pair], [types.haccp, types.guarantee]);
    const mails = stubMail();
    const sent = await send(order, 'user', { recipients: [CUSTOMER_EMAIL, 'second@harborbakery.example'] });
    expect(sent.status).toBe(200);
    expect(sent.body.send.kind).toBe('qa_request');
    expect(toCustomer(mails)).toHaveLength(0);
    const all = await lines(order);
    return {
      order,
      plan,
      letter,
      mails,
      requestSendId: sent.body.send.id,
      planLine: all.find((l) => l.document_id === plan.id)!,
      letterLine: all.find((l) => l.document_id === letter.id)!,
    };
  }

  it('a batch release mints ONE link in the releaser\'s name, mails the asking send\'s recipients once, and is on the order\'s record', async () => {
    const h = await heldOrder('Batch Release Item');
    // An edit to the customer after the send does not redirect the release.
    await db.prepare(`UPDATE customers SET email = 'someone-else@elsewhere.example' WHERE id = ?`).bind(customerId).run();
    try {
      const before = h.mails.length;
      const { status, body } = await release(h.order, [h.planLine.id, h.letterLine.id]);
      expect(status).toBe(200);
      expect(body.released.sort()).toEqual([h.planLine.id, h.letterLine.id].sort());
      expect(body.refused).toEqual([]);
      expect(body.sends).toHaveLength(1);

      const fresh = toCustomer(h.mails.slice(before));
      expect(fresh).toHaveLength(1);
      expect(fresh[0].to).toEqual([CUSTOMER_EMAIL, 'second@harborbakery.example']);
      // Replies go to the salesperson who sent the order.
      expect(fresh[0].reply_to).toBe('user@test.com');
      expect(fresh[0].html).toContain('This link works for 30 days.');
      expect(fresh[0].attachments ?? []).toEqual([]);

      const rowA = await lineRow(h.planLine.id);
      const rowB = await lineRow(h.letterLine.id);
      expect(rowA.release_status).toBe('released');
      expect(rowA.decided_by).toBe(qaUserId);
      expect(rowA.export_link_id).toBe(rowB.export_link_id);
      const link = (await linkById(rowA.export_link_id))!;
      expect(link.created_by).toBe(qaUserId);
      expect((JSON.parse(link.document_ids) as string[]).sort()).toEqual([h.plan.id, h.letter.id].sort());
      expect(Number(link.never_expires)).toBe(0);
      expect(fresh[0].html).toContain(`/export/${link.token}`);

      // The order's own history shows what left and who released it.
      const record = (await readOrder(h.order)).sends!.find((s) => s.id === body.sends[0].id)!;
      expect(record).toMatchObject({ kind: 'qa_release', status: 'sent', sent_by_id: qaUserId, can_resend: false });
      expect(record.files).toHaveLength(2);
      expect(record.files.every((f) => f.delivery === 'link' && f.link_days === 30 && f.sent_ok)).toBe(true);
      // Everything asked for has now gone.
      expect(body.order_status).toBe('delivered');

      expect((await audits('order.documents_released', body.sends[0].id))[0].user_id).toBe(qaUserId);
      const approval = await audits('document.qa_release_approved', body.sends[0].id);
      expect(approval[0].details.document_ids.sort()).toEqual([h.plan.id, h.letter.id].sort());

      // C-045: served on the releaser's authority...
      expect((await landing(link.token)).documents).toHaveLength(2);
      // ...and a document locked afterwards stops being served.
      await setOverride(h.plan.id, 'locked');
      const after = await landing(link.token);
      expect(after.documents).toHaveLength(1);
      expect(after.unavailable_count).toBe(1);

      // Released twice is refused, not mailed twice.
      const twice = await release(h.order, [h.letterLine.id]);
      expect(twice.status).toBe(409);
      expect(twice.body.refused[0].reason).toContain('already been released');
      expect(toCustomer(h.mails.slice(before))).toHaveLength(1);
    } finally {
      await db.prepare(`UPDATE customers SET email = ? WHERE id = ?`).bind(CUSTOMER_EMAIL, customerId).run();
    }
  });

  it('the single-line route releases one and leaves the other waiting', async () => {
    const h = await heldOrder('Single Release Item');
    const before = h.mails.length;
    const [seen] = await targetsFor([h.planLine.id]);
    const res = await call<OrderDocumentsReleaseResponse>(
      releaseOne,
      as('org_admin', `http://localhost/api/orders/${h.order}/documents/${h.planLine.id}/release`, {
        method: 'POST', body: JSON.stringify(seen), params: { id: h.order, lineId: h.planLine.id },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body.released).toEqual([h.planLine.id]);
    expect(toCustomer(h.mails.slice(before))).toHaveLength(1);
    expect((await lineRow(h.letterLine.id)).release_status).toBe('pending_qa');
    // One document still waits, so the order is not delivered.
    expect(res.body.order_status).not.toBe('delivered');
    const link = (await linkById((await lineRow(h.planLine.id)).export_link_id))!;
    expect(link.created_by).toBe(seed.orgAdminId);
    expect(JSON.parse(link.document_ids)).toEqual([h.plan.id]);
  });

  it('only a QA releaser signed in may release or refuse: not a plain user, a reader, or an API key', async () => {
    const h = await heldOrder('Authority Item');
    const before = h.mails.length;
    for (const who of ['user', 'reader', 'api_key'] as const) {
      const rel = await release(h.order, [h.planLine.id], who);
      expect(rel.status).toBe(403);
      const ref = await refuse(h.order, h.planLine.id, 'no', who);
      expect(ref.status).toBe(403);
    }
    expect(h.mails.slice(before)).toHaveLength(0);
    expect((await lineRow(h.planLine.id)).release_status).toBe('pending_qa');
    expect(await linksHolding(h.plan.id)).toEqual([]);
  });

  it('refusing needs a note; the refusal is kept, shown and final for this order', async () => {
    const h = await heldOrder('Refuse Item');
    expect((await refuse(h.order, h.planLine.id, '')).status).toBe(400);
    expect((await refuse(h.order, h.planLine.id, '   ')).status).toBe(400);
    expect((await refuse(h.order, h.planLine.id, undefined)).status).toBe(400);
    expect((await lineRow(h.planLine.id)).release_status).toBe('pending_qa');

    const ok = await refuse(h.order, h.planLine.id, 'This revision is superseded. Ask us for the 2026 plan.');
    expect(ok.status).toBe(200);
    const line = (await lines(h.order)).find((l) => l.id === h.planLine.id)!;
    expect(line).toMatchObject({ release_status: 'refused', decided_by_name: 'Quality Lead', disposition: 'will_not_go', disposition_reason: 'refused' });
    expect(line.disposition_text).toContain('This revision is superseded.');
    expect((await audits('order.document_release_refused', h.order))[0].details.note).toContain('superseded');

    // Not releasable afterwards, not refusable twice, and not sent by a releaser's own send.
    expect((await release(h.order, [h.planLine.id])).status).toBe(409);
    expect((await refuse(h.order, h.planLine.id, 'again')).status).toBe(409);
    const review = await preview(h.order, 'qa');
    expect(review.documents?.will_not_go.find((l) => l.order_document_id === h.planLine.id)?.reason).toBe('refused');
    expect(await linksHolding(h.plan.id)).toEqual([]);
  });

  it('locked never leaves by release: a document locked while it waited is refused, and nothing is minted or mailed', async () => {
    const h = await heldOrder('Locked While Waiting Item');
    expect(h.planLine.rule_at_resolve).toBe('qa');
    await setOverride(h.plan.id, 'locked');

    const listed = (await pending('qa')).lines.find((l) => l.id === h.planLine.id)!;
    expect(listed).toMatchObject({ sharing_rule: 'locked', releasable: false });
    expect(listed.blocked_reason).toContain('locked');

    const before = h.mails.length;
    for (const who of ['qa', 'org_admin'] as const) {
      const res = await release(h.order, [h.planLine.id], who);
      expect(res.status).toBe(409);
      expect(res.body.released).toEqual([]);
      expect(res.body.refused[0].reason).toContain('locked');
    }
    expect(h.mails.slice(before)).toHaveLength(0);
    expect(await linksHolding(h.plan.id)).toEqual([]);
    expect((await lineRow(h.planLine.id)).release_status).toBe('pending_qa');

    // Nor does a releaser's own SEND of the order carry it: the line was `qa`
    // when it was added, and the rule that decides is the one in force now.
    const review = await preview(h.order, 'qa');
    expect(review.documents?.will_not_go.find((l) => l.order_document_id === h.planLine.id)?.reason).toBe('locked');
    expect(review.files.flatMap((f) => f.document_ids)).not.toContain(h.plan.id);

    // In a batch, the locked one is named and the other still goes.
    const mixed = await release(h.order, [h.planLine.id, h.letterLine.id]);
    expect(mixed.status).toBe(200);
    expect(mixed.body.released).toEqual([h.letterLine.id]);
    expect(mixed.body.refused.map((r) => r.order_document_id)).toEqual([h.planLine.id]);
    expect(await linksHolding(h.plan.id)).toEqual([]);
    const link = (await linkById((await lineRow(h.letterLine.id)).export_link_id))!;
    expect(JSON.parse(link.document_ids)).toEqual([h.letter.id]);
  });

  it('a document archived or expired while it waited is not released', async () => {
    const h = await heldOrder('Gone While Waiting Item');
    await db.prepare(`UPDATE documents SET status = 'archived' WHERE id = ?`).bind(h.plan.id).run();
    await db.prepare(`UPDATE documents SET renewal_due_date = '2026-01-01' WHERE id = ?`).bind(h.letter.id).run();
    const res = await release(h.order, [h.planLine.id, h.letterLine.id]);
    expect(res.status).toBe(409);
    const reasons = Object.fromEntries(res.body.refused.map((r) => [r.order_document_id, r.reason]));
    expect(reasons[h.planLine.id]).toContain('archived');
    expect(reasons[h.letterLine.id]).toContain('expired');
    expect(await linksHolding(h.plan.id)).toEqual([]);
    expect(await linksHolding(h.letter.id)).toEqual([]);
  });

  it('a release whose mail fails takes the link back and leaves the document waiting', async () => {
    const pair = await makePair('Failed Release Item');
    const plan = await makeDoc(types.haccp, { products: [pair.product_id] });
    const order = await newOrder();
    await addDocs(order, [pair], [types.haccp]);
    stubMail();
    await send(order);
    const [line] = await lines(order);
    vi.unstubAllGlobals();

    const mails = stubMail((m) => m.to.includes(CUSTOMER_EMAIL));
    const res = await release(order, [line.id]);
    expect(res.status).toBe(409);
    expect(res.body.refused[0].reason).toContain('still waiting');
    expect(mails).toHaveLength(0);
    expect((await lineRow(line.id)).release_status).toBe('pending_qa');
    expect((await lineRow(line.id)).decided_by).toBeNull();
    expect((await linksHolding(plan.id)).every((l) => l.revoked_at !== null)).toBe(true);

    // The failed release is on record, and is not resent from there.
    const record = (await readOrder(order, 'qa')).sends!.find((s) => s.kind === 'qa_release')!;
    expect(record).toMatchObject({ status: 'failed', can_resend: false });
    const resend = await call(resendOrder, as('qa', `http://localhost/api/orders/${order}/sends/${record.id}/resend`, {
      method: 'POST', body: '{}', params: { id: order, sendId: record.id },
    }));
    expect(resend.status).toBe(409);
  });
});

// ===========================================================================
// A supplier merge
// ===========================================================================

describe('mergeSuppliers and document order lines', () => {
  it('moves the loser\'s lines to the winner and keeps one where both had the same line', async () => {
    const winner = await makeSupplier('Merge Winner Dairy');
    const loser = await makeSupplier('Merge Loser Dairy');
    const shared = await makePair('Merged Item One', { supplier: winner });
    await makePair('Merged Item One', { supplier: loser, product: shared.product_id });
    const onlyLoser = await makePair('Merged Item Two', { supplier: loser });
    const order = await newOrder();
    await addDocs(
      order,
      [shared, { product_id: shared.product_id, supplier_id: loser }, onlyLoser],
      [types.spec],
    );
    expect(await lines(order)).toHaveLength(3);

    const result = await mergeSuppliers(db, seed.tenantId, {
      winnerId: winner,
      loserIds: [loser],
      actor: { userId: seed.orgAdminId, ip: null },
    });
    expect(result.reassigned.order_documents).toBe(1);
    const after = await lines(order);
    expect(after).toHaveLength(2);
    expect(after.every((l) => l.supplier_id === winner)).toBe(true);
    expect(await db.prepare('SELECT id FROM suppliers WHERE id = ?').bind(loser).first()).toBeNull();
  });
});

// ===========================================================================
// What an independent review broke, kept closed (decisions C-059..C-066)
// ===========================================================================

describe('a release is pinned to what QA saw (C-059, C-060)', () => {
  it('a second send to a different address does NOT re-point a waiting line: it is refused, and the release mails the first address', async () => {
    const pair = await makePair('Repoint Item');
    const plan = await makeDoc(types.haccp, { products: [pair.product_id] });
    const order = await newOrder();
    await addDocs(order, [pair], [types.haccp]);
    const mails = stubMail();
    const first = await send(order, 'user', { recipients: [CUSTOMER_EMAIL] });
    expect(first.status).toBe(200);
    const [line] = await lines(order);
    expect((await lineRow(line.id)).pending_send_id).toBe(first.body.send.id);

    // The review says it is already waiting, since when and for whom.
    const review = await preview(order, 'org_admin');
    expect(review.documents?.waits_for_qa).toEqual([]); // an admin can release it themselves
    const asUserSees = await preview(order, 'user');
    expect(asUserSees.documents?.waits_for_qa[0].text).toMatch(/^Already waiting for QA since .*, for buyer@harborbakery\.example\./);
    expect(asUserSees.documents?.waits_for_qa[0].notifies_qa).toBe(false);
    expect(asUserSees.blocked?.code).toBe('nothing_to_send');

    // Any non-reader sends again, to somebody else. Nothing new to send and
    // nothing new to ask: refused, and nothing about the line moves.
    const sendsBefore = (await db.prepare('SELECT COUNT(*) AS n FROM order_sends WHERE order_id = ?').bind(order).first<{ n: number }>())!.n;
    const second = await send(order, 'user', { recipients: ['attacker@elsewhere.example'] });
    expect(second.status).toBe(400);
    expect(second.body.code).toBe('nothing_to_send');
    expect((await db.prepare('SELECT COUNT(*) AS n FROM order_sends WHERE order_id = ?').bind(order).first<{ n: number }>())!.n).toBe(sendsBefore);
    expect((await lineRow(line.id)).pending_send_id).toBe(first.body.send.id);
    expect((await pending('qa')).lines.find((l) => l.id === line.id)?.recipients).toEqual([CUSTOMER_EMAIL]);

    const before = mails.length;
    const released = await release(order, [line.id]);
    expect(released.status).toBe(200);
    const fresh = toCustomer(mails.slice(before));
    expect(fresh).toHaveLength(1);
    expect(fresh[0].to).toEqual([CUSTOMER_EMAIL]);
    expect(await linksHolding(plan.id)).toHaveLength(1);
  });

  it('a later send that DOES go (a free line beside it) still does not re-point the waiting line', async () => {
    const pair = await makePair('Repoint Two Item');
    await makeDoc(types.spec, { products: [pair.product_id] });
    await makeDoc(types.haccp, { products: [pair.product_id] });
    const order = await newOrder();
    await addDocs(order, [pair], [types.spec, types.haccp]);
    const mails = stubMail();
    const first = await send(order, 'user', { recipients: [CUSTOMER_EMAIL] });
    const held = (await lines(order)).find((l) => l.release_status === 'pending_qa')!;

    const second = await send(order, 'user', { recipients: ['other@elsewhere.example'] });
    expect(second.status).toBe(200);
    expect(second.body.documents).toMatchObject({ sent: 1, pending_qa: 0 });
    expect((await lineRow(held.id)).pending_send_id).toBe(first.body.send.id);

    const before = mails.length;
    expect((await release(order, [held.id])).status).toBe(200);
    expect(toCustomer(mails.slice(before))[0].to).toEqual([CUSTOMER_EMAIL]);
  });

  it('a line refreshed to a newer document and sent again is NOT released on what QA saw before', async () => {
    const supplier = await makeSupplier('Stale Review Dairy');
    const pair = await makePair('Stale Review Item', { supplier });
    const old = await makeDoc(types.haccp, { supplier, createdAt: '2026-01-01 09:00:00', title: 'Plan QA looked at' });
    const order = await newOrder();
    await addDocs(order, [pair], [types.haccp]);
    const mails = stubMail();
    await send(order, 'user');
    const [line] = await lines(order);
    // QA opens the list: this is what is on their screen.
    const seen = await targetsFor([line.id]);
    expect(seen[0].document_id).toBe(old.id);

    // A newer document arrives, the line is refreshed and sent again.
    const newer = await makeDoc(types.haccp, { supplier, createdAt: '2026-09-01 09:00:00', title: 'Plan nobody reviewed' });
    expect((await refresh(order, line.id, 'user')).body.changed).toBe(true);
    expect((await lineRow(line.id)).release_status).toBe('none');
    expect((await send(order, 'user')).status).toBe(200);
    const row = await lineRow(line.id);
    expect(row).toMatchObject({ release_status: 'pending_qa', document_id: newer.id });
    expect(row.pending_send_id).not.toBe(seen[0].pending_send_id);

    // QA presses Release on the list they loaded earlier.
    const before = mails.length;
    const stale = await release(order, [line.id], 'qa', seen);
    expect(stale.status).toBe(409);
    expect(stale.body.released).toEqual([]);
    expect(stale.body.refused[0]).toMatchObject({ order_document_id: line.id, code: 'changed' });
    expect(stale.body.refused[0].reason).toContain('changed since you opened it');
    expect(mails.slice(before)).toHaveLength(0);
    expect(await linksHolding(newer.id)).toEqual([]);
    expect(await linksHolding(old.id)).toEqual([]);
    expect((await lineRow(line.id)).release_status).toBe('pending_qa');

    // Half-right is still wrong: the new document with the old asking send.
    const mixed = await release(order, [line.id], 'qa', [{ ...seen[0], document_id: newer.id }]);
    expect(mixed.status).toBe(409);
    expect(mixed.body.refused[0].code).toBe('changed');
    // A stale refusal is not applied either.
    expect((await refuse(order, line.id, 'no', 'qa', { document_id: old.id })).status).toBe(409);
    expect((await lineRow(line.id)).release_status).toBe('pending_qa');

    // With what is on the screen NOW, it goes.
    const ok = await release(order, [line.id]);
    expect(ok.status).toBe(200);
    expect(JSON.parse((await linksHolding(newer.id))[0].document_ids)).toEqual([newer.id]);
  });

  it('a new VERSION of the same document since QA looked is a change too', async () => {
    const pair = await makePair('New Version Item');
    const plan = await makeDoc(types.haccp, { products: [pair.product_id] });
    const order = await newOrder();
    await addDocs(order, [pair], [types.haccp]);
    stubMail();
    await send(order, 'user');
    const [line] = await lines(order);
    const seen = await targetsFor([line.id]);
    expect(seen[0].version_number).toBe(1);

    await db
      .prepare(
        `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, uploaded_by)
         VALUES (?, ?, 2, 'v2.pdf', 64, 'application/pdf', ?, ?)`,
      )
      .bind(generateTestId(), plan.id, `docs/${plan.id}/v2.pdf`, seed.orgAdminId)
      .run();
    await db.prepare('UPDATE documents SET current_version = 2 WHERE id = ?').bind(plan.id).run();

    const stale = await release(order, [line.id], 'qa', seen);
    expect(stale.status).toBe(409);
    expect(stale.body.refused[0].code).toBe('changed');
    expect(await linksHolding(plan.id)).toEqual([]);
    expect((await pending('qa')).lines.find((l) => l.id === line.id)?.version_number).toBe(2);
  });

  it('the waiting list shows what a release is pinned to, and a release must say it', async () => {
    const pair = await makePair('Pinned Item');
    const plan = await makeDoc(types.haccp, { products: [pair.product_id], title: 'Pinned plan', createdAt: '2026-05-05 09:00:00' });
    const order = await newOrder();
    await addDocs(order, [pair], [types.haccp]);
    stubMail();
    const sent = await send(order, 'user');
    const listed = (await pending('qa')).lines.find((l) => l.document_id === plan.id)!;
    expect(listed).toMatchObject({
      document_title: 'Pinned plan',
      document_type_name: 'HACCP Plan',
      version_number: 1,
      document_approved_at: '2026-05-05 09:00:00',
      product_name: 'Pinned Item',
      supplier_name: 'Northfield Creamery',
      requested_by_name: 'Regular User',
      recipients: [CUSTOMER_EMAIL],
      pending_send_id: sent.body.send.id,
      release_status: 'pending_qa',
      stuck: false,
    });
    expect(listed.requested_at).toBeTruthy();

    // A release that names only the line id is not a release.
    const bare = await call(releaseBatch, as('qa', `http://localhost/api/orders/${order}/documents/release`, {
      method: 'POST', body: JSON.stringify({ lines: [{ id: listed.id }] }), params: { id: order },
    }));
    expect(bare.status).toBe(400);
    const legacy = await call(releaseBatch, as('qa', `http://localhost/api/orders/${order}/documents/release`, {
      method: 'POST', body: JSON.stringify({ line_ids: [listed.id] }), params: { id: order },
    }));
    expect(legacy.status).toBe(400);
    expect((await lineRow(listed.id)).release_status).toBe('pending_qa');
  });
});

describe('a resend of an old failed send does not override later decisions (C-061)', () => {
  /** A send by a QA releaser whose mail fails: the stored record holds a `qa` document's file. */
  async function failedReleaserSend(name: string) {
    const pair = await makePair(name);
    const plan = await makeDoc(types.haccp, { products: [pair.product_id], title: `${name} plan` });
    const order = await newOrder();
    await addDocs(order, [pair], [types.haccp]);
    stubMail(() => true);
    const failed = await send(order, 'qa');
    expect(failed.status).toBe(502);
    vi.unstubAllGlobals();
    const [line] = await lines(order);
    expect((await lineRow(line.id)).release_status).toBe('none');
    return { order, plan, line, sendId: failed.body.send.id };
  }

  it('does not carry a document QA has since REFUSED, and leaves the line refused', async () => {
    const f = await failedReleaserSend('Refused Later Item');
    const mails = stubMail();
    // The salesperson sends; QA is asked and says no.
    expect((await send(f.order, 'user')).status).toBe(200);
    expect((await refuse(f.order, f.line.id, 'Not for this customer.')).status).toBe(200);
    expect((await lineRow(f.line.id)).release_status).toBe('refused');

    const before = mails.length;
    const again = await resend(f.order, f.sendId, 'org_admin');
    expect(again.status).toBe(200);
    // Said, per file; nothing mailed; nothing minted.
    expect(again.body.not_resent).toHaveLength(1);
    expect(again.body.not_resent![0].reason).toContain('QA has since refused it for this order');
    expect(mails.slice(before)).toHaveLength(0);
    expect((await linksHolding(f.plan.id)).filter((l) => l.revoked_at === null)).toEqual([]);
    expect(again.body.send.files[0]).toMatchObject({ sent_ok: false });
    expect(again.body.send.files[0].not_sent_reason).toContain('refused');
    expect(again.body.send.parts[0]).toMatchObject({ ok: false, withdrawn: true, sent_at: null });
    expect(again.body.send.parts[0].note).toContain('no email was sent');

    const row = await lineRow(f.line.id);
    expect(row.release_status).toBe('refused');
    expect(row.decision_note).toBe('Not for this customer.');
    expect(row.last_send_id).toBeNull();
    expect(await orderStatus(f.order)).not.toBe('delivered');
    expect(again.body.order_status).not.toBe('delivered');
    // It is over: the record offers no further resend.
    expect((await readOrder(f.order, 'org_admin')).sends!.find((s) => s.id === f.sendId)?.can_resend).toBe(false);
  });

  it('does not carry a line that was taken off the order', async () => {
    const f = await failedReleaserSend('Removed Later Item');
    await call(removeDocument, as('user', `http://localhost/api/orders/${f.order}/documents/${f.line.id}`, {
      method: 'DELETE', params: { id: f.order, lineId: f.line.id },
    }));
    const mails = stubMail();
    const again = await resend(f.order, f.sendId, 'org_admin');
    expect(again.body.not_resent![0].reason).toContain('taken off the order');
    expect(mails).toHaveLength(0);
    expect(await orderStatus(f.order)).not.toBe('delivered');
  });

  it('does not take a DIFFERENT pending document off QA\'s list, or mark the order delivered', async () => {
    const supplier = await makeSupplier('Different Pending Dairy');
    const pair = await makePair('Different Pending Item', { supplier });
    const docA = await makeDoc(types.kosher, { supplier, createdAt: '2026-01-01 09:00:00', title: 'Certificate A' });
    const order = await newOrder('org_admin');
    await addDocs(order, [pair], [types.kosher], 'org_admin');
    stubMail(() => true);
    const failed = await send(order, 'org_admin');
    expect(failed.status).toBe(502);
    vi.unstubAllGlobals();
    const [line] = await lines(order);

    // The line moves on to a newer document that needs QA, and is sent again.
    const docB = await makeDoc(types.kosher, { supplier, createdAt: '2026-09-01 09:00:00', title: 'Certificate B' });
    await setOverride(docB.id, 'qa');
    await refresh(order, line.id, 'user');
    const mails = stubMail();
    expect((await send(order, 'user')).status).toBe(200);
    expect(await lineRow(line.id)).toMatchObject({ release_status: 'pending_qa', document_id: docB.id });

    // An administrator resends the OLD failed send, which carried document A.
    const before = mails.length;
    const again = await resend(order, failed.body.send.id, 'org_admin');
    expect(again.body.not_resent![0].reason).toContain('now holds a different document');
    expect(mails.slice(before)).toHaveLength(0);
    expect((await linksHolding(docA.id)).filter((l) => l.revoked_at === null)).toEqual([]);

    const row = await lineRow(line.id);
    expect(row).toMatchObject({ release_status: 'pending_qa', document_id: docB.id });
    expect(row.last_send_id).toBeNull();
    expect((await pending('qa')).lines.some((l) => l.id === line.id)).toBe(true);
    expect(await orderStatus(order)).not.toBe('delivered');
  });

  it('when one file stands for two lines and one has moved on, only the line that still holds it is marked', async () => {
    const supplier = await makeSupplier('Two Lines One File Dairy');
    const one = await makePair('Shared Doc Item One', { supplier });
    const two = await makePair('Shared Doc Item Two', { supplier });
    const shared = await makeDoc(types.kosher, { supplier, createdAt: '2026-01-01 09:00:00' });
    const order = await newOrder('org_admin');
    await addDocs(order, [one, two], [types.kosher], 'org_admin');
    stubMail(() => true);
    const failed = await send(order, 'org_admin');
    expect(failed.body.send.files).toHaveLength(1);
    vi.unstubAllGlobals();
    const all = await lines(order);
    const first = all.find((l) => l.product_id === one.product_id)!;
    const second = all.find((l) => l.product_id === two.product_id)!;

    // Item two gets its own, newer certificate that needs QA; its line moves.
    const own = await makeDoc(types.kosher, { supplier, products: [two.product_id], createdAt: '2026-09-01 09:00:00' });
    await setOverride(own.id, 'qa');
    await refresh(order, second.id, 'user');
    const mails = stubMail();
    await send(order, 'user', { recipients: ['later@harborbakery.example'] });
    expect((await lineRow(second.id)).release_status).toBe('pending_qa');
    const firstAfterSecondSend = await lineRow(first.id);

    const before = mails.length;
    const again = await resend(order, failed.body.send.id, 'org_admin');
    expect(again.body.send.status).toBe('sent');
    expect(again.body.not_resent).toBeUndefined();
    expect(mails.slice(before)).toHaveLength(1);
    // The line that still holds the shared certificate went with the resend...
    expect((await lineRow(first.id)).last_send_id).toBe(failed.body.send.id);
    expect(firstAfterSecondSend.last_send_id).not.toBe(failed.body.send.id);
    // ...and the one that moved on is exactly as it was.
    expect(await lineRow(second.id)).toMatchObject({ release_status: 'pending_qa', document_id: own.id, last_send_id: null });
    expect(await orderStatus(order)).not.toBe('delivered');
  });

  it('does not carry a document that has EXPIRED since the failed send', async () => {
    const pair = await makePair('Expired Later Item');
    const spec = await makeDoc(types.spec, { products: [pair.product_id] });
    const order = await newOrder('org_admin');
    await addDocs(order, [pair], [types.spec], 'org_admin');
    stubMail(() => true);
    const failed = await send(order, 'org_admin');
    vi.unstubAllGlobals();

    await db.prepare(`UPDATE documents SET renewal_due_date = '2026-01-01' WHERE id = ?`).bind(spec.id).run();
    const mails = stubMail();
    const again = await resend(order, failed.body.send.id, 'org_admin');
    expect(again.body.not_resent![0].reason).toContain('has expired since this send was reviewed');
    expect(mails).toHaveLength(0);
    expect((await linksHolding(spec.id)).filter((l) => l.revoked_at === null)).toEqual([]);
    expect(await orderStatus(order)).not.toBe('delivered');
  });

  it('a COA pick keeps its behaviour: the same document on a COA line is still resent', async () => {
    const pair = await makePair('COA Kept Item');
    const coa = await makeDoc(types.coa, { products: [pair.product_id] });
    const order = await newOrder('org_admin');
    await addDocs(order, [pair], [types.coa], 'org_admin');
    await call(addItems, as('org_admin', `http://localhost/api/orders/${order}/items`, {
      method: 'POST', body: JSON.stringify({ document_ids: [coa.id] }), params: { id: order },
    }));
    stubMail(() => true);
    const failed = await send(order, 'org_admin');
    expect(failed.body.send.files).toHaveLength(1);
    vi.unstubAllGlobals();
    const [line] = await lines(order);
    await call(removeDocument, as('org_admin', `http://localhost/api/orders/${order}/documents/${line.id}`, {
      method: 'DELETE', params: { id: order, lineId: line.id },
    }));

    const mails = stubMail();
    const again = await resend(order, failed.body.send.id, 'org_admin');
    expect(again.body.send.status).toBe('sent');
    expect(again.body.not_resent).toBeUndefined();
    expect(toCustomer(mails)[0].attachments).toHaveLength(1);
  });
});

describe('a release that does not finish (C-063)', () => {
  /** A line left `releasing` by a release that died: claimed, link minted, record written, nothing after. */
  async function strandedRelease(name: string, minutesAgo: number) {
    const pair = await makePair(name);
    const plan = await makeDoc(types.haccp, { products: [pair.product_id], title: `${name} plan` });
    const order = await newOrder();
    await addDocs(order, [pair], [types.haccp]);
    const mails = stubMail();
    await send(order, 'user');
    const [line] = await lines(order);
    const link = await mintExportLink(db, {
      tenantId: seed.tenantId, documentIds: [plan.id], createdBy: qaUserId, recipients: [CUSTOMER_EMAIL], ttlDays: 30,
    });
    const sendId = generateTestId();
    await db
      .prepare(
        `INSERT INTO order_sends (id, tenant_id, order_id, order_number, sent_by, recipients, subject, part_count, parts, status, kind)
         VALUES (?, ?, ?, 'DO-stranded', ?, ?, 'Documents', 1, ?, 'partial', 'qa_release')`,
      )
      .bind(
        sendId, seed.tenantId, order, qaUserId, JSON.stringify([CUSTOMER_EMAIL]),
        JSON.stringify([{ part_number: 1, ok: false, status: 0, error: RELEASE_OUTCOME_UNRECORDED, sent_at: null, attempts: 1 }]),
      )
      .run();
    await db
      .prepare(
        `INSERT INTO order_send_files (id, send_id, tenant_id, position, document_id, version_number, document_ids, file_name, bytes, part_number, delivery, source, order_document_ids, link_days, export_link_id)
         VALUES (?, ?, ?, 0, ?, 1, ?, 'plan.pdf', 64, 1, 'link', 'document', ?, 30, ?)`,
      )
      .bind(generateTestId(), sendId, seed.tenantId, plan.id, JSON.stringify([plan.id]), JSON.stringify([line.id]), link.id)
      .run();
    await db
      .prepare(
        `UPDATE order_documents SET release_status = 'releasing', releasing_at = datetime('now', ?), release_send_id = ?, decided_by = ? WHERE id = ?`,
      )
      .bind(`-${minutesAgo} minutes`, sendId, qaUserId, line.id)
      .run();
    return { order, plan, line, link, sendId, mails };
  }

  const giveBack = (order: string, lineId: string, who: Who = 'qa') =>
    call(giveBackOne, as(who, `http://localhost/api/orders/${order}/documents/${lineId}/give-back`, { method: 'POST', params: { id: order, lineId } }));

  it('is never shown as sent, and nobody\'s send carries the document meanwhile', async () => {
    const s = await strandedRelease('Stranded Shown Item', 30);
    const [line] = await lines(s.order, 'qa');
    expect(line).toMatchObject({ release_status: 'releasing', release_stuck: true, disposition: 'waits_for_qa' });
    expect(line.disposition_text).toContain('did not finish');
    expect(line.disposition_text).toContain('has not been sent');
    expect(line.last_sent_at).toBeNull();

    const record = (await readOrder(s.order, 'qa')).sends!.find((x) => x.id === s.sendId)!;
    expect(record.status).not.toBe('sent');
    expect(record.status).not.toBe('failed');
    expect(record.parts[0].error).toBe(RELEASE_OUTCOME_UNRECORDED);

    // Not even a releaser's own send of the order takes it.
    for (const who of ['qa', 'user'] as const) {
      const review = await preview(s.order, who);
      expect(review.documents?.goes_now).toEqual([]);
      expect(review.files).toEqual([]);
      expect(review.blocked?.code).toBe('nothing_to_send');
    }
    expect(await orderStatus(s.order)).not.toBe('delivered');

    const listed = (await pending('qa')).lines.find((l) => l.id === s.line.id)!;
    expect(listed).toMatchObject({ release_status: 'releasing', stuck: true, releasable: true });
  });

  it('can be put back: its link is withdrawn, its record says so, and it waits again', async () => {
    const s = await strandedRelease('Stranded Give Back Item', 30);
    for (const who of ['user', 'reader', 'api_key'] as const) expect((await giveBack(s.order, s.line.id, who)).status).toBe(403);
    expect((await giveBack(s.order, s.line.id, 'other_tenant')).status).toBe(404);

    expect((await giveBack(s.order, s.line.id)).status).toBe(200);
    expect(await lineRow(s.line.id)).toMatchObject({ release_status: 'pending_qa', releasing_at: null, release_send_id: null, decided_by: null });
    expect((await linkById(s.link.id))!.revoked_at).not.toBeNull();
    const record = (await readOrder(s.order, 'qa')).sends!.find((x) => x.id === s.sendId)!;
    expect(record.status).toBe('failed');
    expect(record.parts[0].error).toContain('did not finish');
    // Now it is an ordinary waiting line; putting it back twice is a 409.
    expect((await giveBack(s.order, s.line.id)).status).toBe(409);
  });

  it('can be released again: the unfinished link is withdrawn and a new one is sent', async () => {
    const s = await strandedRelease('Stranded Release Again Item', 30);
    const before = s.mails.length;
    const res = await release(s.order, [s.line.id]);
    expect(res.status).toBe(200);
    expect(res.body.released).toEqual([s.line.id]);
    expect(toCustomer(s.mails.slice(before))).toHaveLength(1);
    expect((await linkById(s.link.id))!.revoked_at).not.toBeNull();
    const live = (await linksHolding(s.plan.id)).filter((l) => l.revoked_at === null);
    expect(live).toHaveLength(1);
    expect(await lineRow(s.line.id)).toMatchObject({ release_status: 'released', export_link_id: live[0].id, releasing_at: null });
    expect(res.body.sends[0]).toMatchObject({ kind: 'qa_release', status: 'sent' });
  });

  it('a release in progress is left alone: not released twice, not put back', async () => {
    const s = await strandedRelease('In Progress Item', 0);
    const before = s.mails.length;
    const res = await release(s.order, [s.line.id]);
    expect(res.status).toBe(409);
    expect(res.body.refused[0].code).toBe('in_progress');
    expect((await giveBack(s.order, s.line.id)).status).toBe(409);
    expect(s.mails.slice(before)).toHaveLength(0);
    expect((await linkById(s.link.id))!.revoked_at).toBeNull();
    expect((await lineRow(s.line.id)).release_status).toBe('releasing');
    expect((await pending('qa')).lines.find((l) => l.id === s.line.id)).toMatchObject({ stuck: false, releasable: false });
  });

  it('when the mail goes and the record cannot be written, nothing says "failed" and nothing says "sent"', async () => {
    const pair = await makePair('Record Lost Item');
    const plan = await makeDoc(types.haccp, { products: [pair.product_id] });
    const order = await newOrder();
    await addDocs(order, [pair], [types.haccp]);
    const mails = stubMail();
    await send(order, 'user');
    const [line] = await lines(order);

    // The database refuses the one write that would say "released".
    await db
      .prepare(
        `CREATE TRIGGER test_block_release BEFORE UPDATE OF release_status ON order_documents
         WHEN NEW.release_status = 'released' AND NEW.id = '${line.id}'
         BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`,
      )
      .run();
    let res: Awaited<ReturnType<typeof release>>;
    const before = mails.length;
    try {
      res = await release(order, [line.id]);
    } finally {
      await db.prepare('DROP TRIGGER test_block_release').run();
    }
    // The customer HAS the mail.
    expect(toCustomer(mails.slice(before))).toHaveLength(1);
    expect(res.status).toBe(409);
    expect(res.body.released).toEqual([]);
    expect(res.body.refused[0].code).toBe('unfinished');
    expect(res.body.refused[0].reason).toContain('The email was sent, but the record of it could not be written');

    const row = await lineRow(line.id);
    expect(row.release_status).toBe('releasing');
    const record = (await readOrder(order, 'qa')).sends!.find((x) => x.id === row.release_send_id)!;
    // Not "failed" while a customer holds the link; not "sent" either.
    expect(record.status).toBe('partial');
    expect(record.parts[0].error).toBe(RELEASE_OUTCOME_UNRECORDED);
    expect(record.files[0].sent_ok).toBe(false);
    // And the link it minted is findable from the record, so it can be withdrawn.
    const minted = (await linksHolding(plan.id)).filter((l) => l.revoked_at === null);
    expect(minted).toHaveLength(1);
    expect(await orderStatus(order)).not.toBe('delivered');

    // Recoverable: once the claim is old enough, releasing again withdraws that link and sends a new one.
    await db.prepare(`UPDATE order_documents SET releasing_at = datetime('now', '-30 minutes') WHERE id = ?`).bind(line.id).run();
    const again = await release(order, [line.id]);
    expect(again.status).toBe(200);
    expect((await linkById(minted[0].id))!.revoked_at).not.toBeNull();
    expect((await lineRow(line.id)).release_status).toBe('released');
  });
});

describe('a release at scale (C-062)', () => {
  it('more than one link carries is refused with both numbers, and releases nothing', async () => {
    const order = await newOrder();
    const targets = Array.from({ length: 51 }, (_, i) => ({ id: `line-${i}`, document_id: 'd', version_number: 1, pending_send_id: 's' }));
    const res = await release(order, [], 'qa', targets);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('at most 50 documents');
    expect(res.body.error).toContain('this is 51');
    expect(res.body.error).toContain('Nothing was released');
  });

  it('fifty lines release in one act, on one link, in one email', async () => {
    const supplier = await makeSupplier('Fifty Lines Dairy');
    const plan = await makeDoc(types.haccp, { supplier, title: 'One plan for fifty items' });
    const pairs = [];
    for (let i = 0; i < 50; i++) pairs.push(await makePair(`Fifty Item ${i}`, { supplier }));
    const order = await newOrder();
    expect((await addDocs(order, pairs, [types.haccp])).status).toBe(201);
    const mails = stubMail();
    expect((await send(order, 'user')).status).toBe(200);
    const all = await lines(order);
    expect(all).toHaveLength(50);
    expect(all.every((l) => l.release_status === 'pending_qa')).toBe(true);

    const before = mails.length;
    const res = await release(order, all.map((l) => l.id));
    expect(res.status).toBe(200);
    expect(res.body.released).toHaveLength(50);
    expect(toCustomer(mails.slice(before))).toHaveLength(1);
    expect(await linksHolding(plan.id)).toHaveLength(1);
    const left = await db.prepare(`SELECT COUNT(*) AS n FROM order_documents WHERE order_id = ? AND release_status != 'released'`).bind(order).first<{ n: number }>();
    expect(left!.n).toBe(0);
    expect(res.body.order_status).toBe('delivered');
  }, 60_000);

  it('a release whose mail fails gives all fifty back', async () => {
    const supplier = await makeSupplier('Fifty Back Dairy');
    await makeDoc(types.haccp, { supplier });
    const pairs = [];
    for (let i = 0; i < 50; i++) pairs.push(await makePair(`Fifty Back Item ${i}`, { supplier }));
    const order = await newOrder();
    await addDocs(order, pairs, [types.haccp]);
    stubMail();
    await send(order, 'user');
    vi.unstubAllGlobals();
    stubMail((m) => m.to.includes(CUSTOMER_EMAIL));
    const all = await lines(order);
    const res = await release(order, all.map((l) => l.id));
    expect(res.status).toBe(409);
    const waiting = await db.prepare(`SELECT COUNT(*) AS n FROM order_documents WHERE order_id = ? AND release_status = 'pending_qa'`).bind(order).first<{ n: number }>();
    expect(waiting!.n).toBe(50);
  }, 60_000);
});

describe('what a read-only account may not undo (C-064)', () => {
  it('a reader cannot remove or refresh a line that is waiting for QA or released; a sender can', async () => {
    const pair = await makePair('Reader Guard Item');
    await makeDoc(types.haccp, { products: [pair.product_id] });
    await makeDoc(types.guarantee, { products: [pair.product_id] });
    await makeDoc(types.spec, { products: [pair.product_id] });
    const order = await newOrder('reader');
    await addDocs(order, [pair], [types.haccp, types.guarantee, types.spec], 'reader');
    stubMail();
    await send(order, 'user');
    const all = await lines(order);
    const waiting = all.find((l) => l.document_type_id === types.haccp)!;
    const toRelease = all.find((l) => l.document_type_id === types.guarantee)!;
    const plain = all.find((l) => l.document_type_id === types.spec)!;
    await release(order, [toRelease.id]);

    const remove = (lineId: string, who: Who) =>
      call<{ error?: string }>(removeDocument, as(who, `http://localhost/api/orders/${order}/documents/${lineId}`, { method: 'DELETE', params: { id: order, lineId } }));

    for (const lineId of [waiting.id, toRelease.id]) {
      const gone = await remove(lineId, 'reader');
      expect(gone.status).toBe(403);
      expect(gone.body.error).toContain('read-only account cannot remove');
      expect((await refresh(order, lineId, 'reader')).status).toBe(403);
    }
    expect((await lineRow(waiting.id)).release_status).toBe('pending_qa');
    expect((await lineRow(toRelease.id)).release_status).toBe('released');

    // A line nothing has happened to is still theirs to take back.
    expect((await refresh(order, plain.id, 'reader')).status).toBe(200);
    expect((await remove(plain.id, 'reader')).status).toBe(200);
    // And somebody who may send may do both to the others.
    expect((await refresh(order, waiting.id, 'user')).status).toBe(200);
    expect((await remove(waiting.id, 'user')).status).toBe(200);
  });

  it('a reader opens at most twenty orders an hour; other roles are not counted', async () => {
    const open = (who: Who) =>
      call<{ order?: { id: string }; code?: string }>(createOrder, as(who, 'http://localhost/api/orders', {
        method: 'POST', body: JSON.stringify({ order_number: `RL-${generateTestId().slice(0, 10)}` }),
      }));
    expect(READER_ORDER_CREATE_LIMIT_PER_HOUR).toBe(20);
    for (let i = 0; i < READER_ORDER_CREATE_LIMIT_PER_HOUR; i++) expect((await open('reader')).status).toBe(201);
    const over = await open('reader');
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('rate_limited');
    expect(over.body.error).toContain('20 orders opened in an hour');
    expect((await open('user')).status).toBe(201);
  });

  it('a connector file for an order number a reader pre-created keeps the document lines and takes the connector\'s data', async () => {
    const pair = await makePair('Connector Later Item');
    const spec = await makeDoc(types.spec, { products: [pair.product_id] });
    const number = `RC-${generateTestId().slice(0, 8)}`;
    const order = await newOrder('reader', { order_number: number, customer_id: undefined, customer_name: 'Typed By Reader' });
    await addDocs(order, [pair], [types.spec], 'reader');
    const before = await lineRow((await lines(order))[0].id);

    const result = await ingestOrders(
      db,
      {
        orders: [{ order_number: number, po_number: 'PO-55019', customer_number: 'K00912', customer_name: 'Kestrel Foods', items: [{ product_name: 'Heavy Cream', product_code: '30417', quantity: 4, lot_number: '10426203' }], source_data: {} }],
        customers: [{ customer_number: 'K00912', name: 'Kestrel Foods' }],
        errors: [],
        info: [],
      } as unknown as ConnectorOutput,
      { tenantId: seed.tenantId, connectorId: null, connectorRunId: null },
    );
    expect(JSON.stringify(result)).not.toContain('FOREIGN KEY');

    // One order, not two; the connector's header and line are on it...
    const rows = await db.prepare('SELECT id, po_number, customer_number, created_by FROM orders WHERE tenant_id = ? AND order_number = ?').bind(seed.tenantId, number).all<Record<string, any>>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results![0]).toMatchObject({ id: order, po_number: 'PO-55019', customer_number: 'K00912', created_by: seed.readerId });
    const items = await db.prepare('SELECT product_code, lot_number, quantity FROM order_items WHERE order_id = ?').bind(order).all<Record<string, any>>();
    expect(items.results).toEqual([{ product_code: '30417', lot_number: '10426203', quantity: 4 }]);
    // ...and the person's document line is exactly as it was.
    const after = await lineRow(before.id);
    expect(after).toEqual(before);
    expect(after.document_id).toBe(spec.id);
  });
});

describe('a supplier merge keeps the line that carries a decision (C-065)', () => {
  async function auditOfMerge(winner: string) {
    return (await audits('supplier.merged', winner)).at(-1)!.details;
  }

  it('the loser\'s waiting line survives over the winner\'s bare one, and the removed row is in the audit', async () => {
    const winner = await makeSupplier('Merge Keep Winner Dairy');
    const loser = await makeSupplier('Merge Keep Loser Dairy');
    const onWinner = await makePair('Merge Keep Item', { supplier: winner });
    const onLoser = await makePair('Merge Keep Item', { supplier: loser, product: onWinner.product_id });
    await makeDoc(types.haccp, { supplier: loser, title: 'Loser hazard plan' });
    const order = await newOrder();
    await addDocs(order, [onWinner, onLoser], [types.haccp]);
    stubMail();
    await send(order, 'user');
    const all = await lines(order);
    const bare = all.find((l) => l.supplier_id === winner)!;
    const waiting = all.find((l) => l.supplier_id === loser)!;
    expect(bare.release_status).toBe('none');
    expect(waiting.release_status).toBe('pending_qa');

    await mergeSuppliers(db, seed.tenantId, { winnerId: winner, loserIds: [loser], actor: { userId: seed.orgAdminId, ip: null } });

    const after = await lines(order);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: waiting.id, supplier_id: winner, release_status: 'pending_qa' });
    expect((await pending('qa')).lines.some((l) => l.id === waiting.id)).toBe(true);
    const details = await auditOfMerge(winner);
    expect(details.dropped_order_documents).toHaveLength(1);
    expect(details.dropped_order_documents[0]).toMatchObject({ id: bare.id, release_status: 'none', kept_order_document_id: waiting.id });
  });

  it('when both carry one the winner\'s is kept and the loser\'s whole row is recorded', async () => {
    const winner = await makeSupplier('Merge Both Winner Dairy');
    const loser = await makeSupplier('Merge Both Loser Dairy');
    const onWinner = await makePair('Merge Both Item', { supplier: winner });
    const onLoser = await makePair('Merge Both Item', { supplier: loser, product: onWinner.product_id });
    await makeDoc(types.haccp, { supplier: winner });
    const loserDoc = await makeDoc(types.haccp, { supplier: loser });
    const order = await newOrder();
    await addDocs(order, [onWinner, onLoser], [types.haccp]);
    stubMail();
    await send(order, 'user');
    const all = await lines(order);
    const winnerLine = all.find((l) => l.supplier_id === winner)!;
    const loserLine = all.find((l) => l.supplier_id === loser)!;
    await refuse(order, loserLine.id, 'Use the other plant.');

    await mergeSuppliers(db, seed.tenantId, { winnerId: winner, loserIds: [loser], actor: { userId: seed.orgAdminId, ip: null } });
    const after = await lines(order);
    expect(after.map((l) => l.id)).toEqual([winnerLine.id]);
    expect(after[0].release_status).toBe('pending_qa');
    const dropped = (await auditOfMerge(winner)).dropped_order_documents;
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({
      id: loserLine.id,
      release_status: 'refused',
      decision_note: 'Use the other plant.',
      document_id: loserDoc.id,
      kept_order_document_id: winnerLine.id,
    });
  });
});

describe('the rail count (C-066)', () => {
  it('?count=1 answers with one number and no lines, and nothing to a person who cannot release', async () => {
    const pair = await makePair('Count Item');
    await makeDoc(types.haccp, { products: [pair.product_id] });
    const order = await newOrder();
    await addDocs(order, [pair], [types.haccp]);
    stubMail();
    await send(order, 'user');

    const count = (who: Who) => call<Record<string, unknown>>(pendingList, as(who, 'http://localhost/api/order-documents/pending?count=1'));
    const qa = await count('qa');
    expect(qa.status).toBe(200);
    expect(Object.keys(qa.body).sort()).toEqual(['can_release', 'count']);
    expect(qa.body.can_release).toBe(true);
    expect(qa.body.count).toBe((await pending('qa')).count);
    expect(Number(qa.body.count)).toBeGreaterThan(0);
    for (const who of ['user', 'reader', 'api_key'] as const) {
      expect((await count(who)).body).toEqual({ can_release: false, count: 0 });
    }
    expect((await count('other_tenant')).body).toEqual({ can_release: true, count: 0 });
  });
});

// ===========================================================================
// What the record says must be true (decisions C-067..C-070)
// ===========================================================================

const USER_EMAIL = 'user@test.com';
const toAsker = (mails: CapturedMail[]) => mails.filter((m) => m.to.includes(USER_EMAIL));

/** One `qa` line, sent by a plain user: waiting for QA. */
async function oneWaiting(name: string) {
  const pair = await makePair(name);
  const plan = await makeDoc(types.haccp, { products: [pair.product_id], title: `${name} plan` });
  const order = await newOrder();
  await addDocs(order, [pair], [types.haccp]);
  stubMail();
  const sent = await send(order, 'user');
  expect(sent.status).toBe(200);
  vi.unstubAllGlobals();
  const [line] = await lines(order);
  return { order, plan, pair, line, askingSendId: sent.body.send.id };
}

describe('a release somebody else undoes while its mail is going out (C-067)', () => {
  it('is not recorded as sent and is not answered "released"', async () => {
    const w = await oneWaiting('Undone Mid Flight Item');
    const sent: CapturedMail[] = [];
    // The provider is slow. While it is, an administrator sees a release that
    // has been "in progress" too long and puts it back.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (!String(url).includes('resend.com')) return new Response('{}', { status: 200 });
        const mail = JSON.parse(String(init?.body)) as CapturedMail;
        if (mail.to.includes(CUSTOMER_EMAIL) && sent.filter((m) => m.to.includes(CUSTOMER_EMAIL)).length === 0) {
          await db.prepare(`UPDATE order_documents SET releasing_at = datetime('now', '-10 minutes') WHERE id = ?`).bind(w.line.id).run();
          const back = await giveBackOne(
            as('org_admin', `http://localhost/api/orders/${w.order}/documents/${w.line.id}/give-back`, {
              method: 'POST', params: { id: w.order, lineId: w.line.id },
            }),
          );
          expect(back.status).toBe(200);
        }
        sent.push(mail);
        return new Response('{}', { status: 200 });
      }),
    );

    const res = await release(w.order, [w.line.id]);
    // The mail went. The release did not hold.
    expect(toCustomer(sent)).toHaveLength(1);
    expect(res.status).toBe(409);
    expect(res.body.released).toEqual([]);
    expect(res.body.refused[0].code).toBe('undone');
    expect(res.body.refused[0].reason).toContain('Org Admin put this release back');
    expect(res.body.refused[0].reason).toContain('The customer holds a link that no longer opens');

    const record = (await readOrder(w.order, 'qa')).sends!.find((s) => s.kind === 'qa_release')!;
    expect(record.status).not.toBe('sent');
    expect(record.files.every((f) => !f.sent_ok)).toBe(true);
    expect(record.parts[0]).toMatchObject({ ok: false, code: 'undone', undone_by_name: 'Org Admin' });
    expect(record.parts[0].error).toContain('The email was sent, but Org Admin put this release back');

    // The line is waiting, the link is dead, and nobody was told it was released.
    expect(await lineRow(w.line.id)).toMatchObject({ release_status: 'pending_qa', release_send_id: null, decided_by: null });
    expect((await linksHolding(w.plan.id)).every((l) => l.revoked_at !== null)).toBe(true);
    expect(toAsker(sent)).toHaveLength(0);
    expect(await orderStatus(w.order)).not.toBe('delivered');
    expect((await audits('order.documents_release_undone', record.id))[0].details).toMatchObject({ mail_sent: true });

    // Releasing it now is an honest second release: one more mail, one live link.
    const again = await release(w.order, [w.line.id]);
    expect(again.status).toBe(200);
    expect((await linksHolding(w.plan.id)).filter((l) => l.revoked_at === null)).toHaveLength(1);
  });

  it('a mail call that TIMES OUT is "outcome not recorded", not "failed": nothing is undone', async () => {
    const w = await oneWaiting('Timed Out Item');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (!String(url).includes('resend.com')) return new Response('{}', { status: 200 });
        // The release sets a deadline on its mail call; other callers set none.
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        throw new DOMException('The operation timed out.', 'TimeoutError');
      }),
    );
    const res = await release(w.order, [w.line.id]);
    expect(res.status).toBe(409);
    expect(res.body.refused[0].code).toBe('unfinished');
    expect(res.body.refused[0].reason).toContain('not known whether the email went');

    const row = await lineRow(w.line.id);
    expect(row.release_status).toBe('releasing');
    const record = (await readOrder(w.order, 'qa')).sends!.find((s) => s.id === row.release_send_id)!;
    expect(record.status).toBe('partial');
    expect(record.parts[0]).toMatchObject({ ok: false, code: 'unrecorded', error: RELEASE_OUTCOME_UNRECORDED });
    // The link is still live: the mail may have gone, and it can be found and withdrawn.
    expect((await linksHolding(w.plan.id)).filter((l) => l.revoked_at === null)).toHaveLength(1);
  });

  it('a mail call that THROWS does not say "nothing was sent": it says it may not have been, and withdraws the link', async () => {
    const w = await oneWaiting('Threw Item');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        if (!String(url).includes('resend.com')) return new Response('{}', { status: 200 });
        throw new Error('socket hang up');
      }),
    );
    const res = await release(w.order, [w.line.id]);
    expect(res.status).toBe(409);
    expect(res.body.refused[0].reason).toContain('The mail may not have been sent; the link was withdrawn.');
    expect(res.body.refused[0].reason).not.toContain('Nothing was sent');
    const record = (await readOrder(w.order, 'qa')).sends!.find((s) => s.kind === 'qa_release')!;
    expect(record.status).toBe('failed');
    expect(record.parts[0].error).toContain('The mail may not have been sent; the link was withdrawn.');
    expect(record.parts[0].error).toContain('socket hang up');
    expect((await linksHolding(w.plan.id)).every((l) => l.revoked_at !== null)).toBe(true);
    expect((await lineRow(w.line.id)).release_status).toBe('pending_qa');
  });
});

describe('a send in which nothing left never reads "sent" (C-068)', () => {
  it('every file withdrawn: stored failed, called withdrawn, and nothing is left to resend', async () => {
    const pair = await makePair('All Withdrawn Item');
    await makeDoc(types.spec, { products: [pair.product_id] });
    const order = await newOrder('org_admin');
    await addDocs(order, [pair], [types.spec], 'org_admin');
    stubMail(() => true);
    const failed = await send(order, 'org_admin');
    expect(failed.status).toBe(502);
    vi.unstubAllGlobals();
    const [line] = await lines(order);
    await call(removeDocument, as('org_admin', `http://localhost/api/orders/${order}/documents/${line.id}`, {
      method: 'DELETE', params: { id: order, lineId: line.id },
    }));

    const mails = stubMail();
    const again = await resend(order, failed.body.send.id, 'org_admin');
    expect(mails).toHaveLength(0);
    expect(again.body.sent).toBe(false);
    expect(again.body.send.status).toBe('failed');
    expect(again.body.send.outcome).toBe('withdrawn');
    expect(again.body.send.parts[0]).toMatchObject({ ok: false, withdrawn: true, sent_at: null });
    expect(again.body.send.can_resend).toBe(false);
    expect(again.body.order_status).not.toBe('delivered');

    const more = await resend(order, failed.body.send.id, 'org_admin');
    expect(more.status).toBe(409);
    expect(more.body.error).toContain('Nothing is left to resend');
    expect(mails).toHaveLength(0);
  });

  it('some emails went and the rest were withdrawn: partial, called so, nothing left to resend, not delivered', async () => {
    const supplier = await makeSupplier('Two Emails Dairy');
    const one = await makePair('Two Emails Item One', { supplier });
    const two = await makePair('Two Emails Item Two', { supplier });
    // Two certificates of analysis of 8 MB each do not fit one 15 MB email.
    await makeDoc(types.coa, { supplier, products: [one.product_id], size: 8 * 1024 * 1024 });
    await makeDoc(types.coa, { supplier, products: [two.product_id], size: 8 * 1024 * 1024 });
    const order = await newOrder('org_admin');
    await addDocs(order, [one, two], [types.coa], 'org_admin');
    const mails = stubMail((m) => m.subject.includes('(2 of 2)'));
    const first = await send(order, 'org_admin');
    expect(first.status).toBe(200);
    expect(first.body.send).toMatchObject({ status: 'partial', outcome: 'partial', can_resend: true, part_count: 2 });
    vi.unstubAllGlobals();

    // The line whose certificate was in the email that failed is taken off.
    const second = (await lines(order)).find((l) => l.product_id === two.product_id)!;
    await call(removeDocument, as('org_admin', `http://localhost/api/orders/${order}/documents/${second.id}`, {
      method: 'DELETE', params: { id: order, lineId: second.id },
    }));
    const later = stubMail();
    const again = await resend(order, first.body.send.id, 'org_admin');
    expect(later).toHaveLength(0);
    expect(mails).toHaveLength(1);
    expect(again.body.send.status).toBe('partial');
    expect(again.body.send.outcome).toBe('sent_rest_withdrawn');
    expect(again.body.send.can_resend).toBe(false);
    expect(again.body.sent).toBe(false);
    expect(again.body.send.parts.map((p) => [p.ok, Boolean(p.withdrawn)])).toEqual([[true, false], [false, true]]);
    expect((await resend(order, first.body.send.id, 'org_admin')).status).toBe(409);
  });
});

describe('lines nobody may pull out from under a decision (C-069)', () => {
  it('nobody removes or refreshes a line in the middle of a release', async () => {
    const w = await oneWaiting('Mid Release Guard Item');
    await db.prepare(`UPDATE order_documents SET release_status = 'releasing', releasing_at = datetime('now', '-30 minutes') WHERE id = ?`).bind(w.line.id).run();
    for (const who of ['user', 'qa', 'org_admin', 'reader'] as const) {
      const gone = await call<{ error?: string }>(removeDocument, as(who, `http://localhost/api/orders/${w.order}/documents/${w.line.id}`, {
        method: 'DELETE', params: { id: w.order, lineId: w.line.id },
      }));
      expect(gone.status).toBe(409);
      expect(gone.body.error).toContain('in the middle of a release');
      expect((await refresh(w.order, w.line.id, who)).status).toBe(409);
    }
    expect((await lineRow(w.line.id)).release_status).toBe('releasing');
    // Put back, it is an ordinary waiting line again and a sender may remove it.
    await call(giveBackOne, as('qa', `http://localhost/api/orders/${w.order}/documents/${w.line.id}/give-back`, { method: 'POST', params: { id: w.order, lineId: w.line.id } }));
    const after = await call(removeDocument, as('user', `http://localhost/api/orders/${w.order}/documents/${w.line.id}`, {
      method: 'DELETE', params: { id: w.order, lineId: w.line.id },
    }));
    expect(after.status).toBe(200);
  });

  it('a reader cannot remove or refresh a REFUSED line; a sender who re-adds it asks QA with the earlier refusal in view', async () => {
    const w = await oneWaiting('Refused History Item');
    stubMail();
    expect((await refuse(w.order, w.line.id, 'Superseded. Use the 2026 plan.')).status).toBe(200);

    const removeAs = (who: Who) =>
      call<{ error?: string }>(removeDocument, as(who, `http://localhost/api/orders/${w.order}/documents/${w.line.id}`, {
        method: 'DELETE', params: { id: w.order, lineId: w.line.id },
      }));
    const asReader = await removeAs('reader');
    expect(asReader.status).toBe(403);
    expect(asReader.body.error).toContain('released or refused');
    expect((await refresh(w.order, w.line.id, 'reader')).status).toBe(403);
    expect((await lineRow(w.line.id)).release_status).toBe('refused');

    // Somebody who may send takes it off, adds it again and sends.
    expect((await removeAs('user')).status).toBe(200);
    await addDocs(w.order, [w.pair], [types.haccp]);
    expect((await send(w.order, 'user')).status).toBe(200);
    const [fresh] = await lines(w.order);
    expect(fresh.id).not.toBe(w.line.id);
    expect(fresh.release_status).toBe('pending_qa');

    const listed = (await pending('qa')).lines.find((l) => l.id === fresh.id)!;
    expect(listed.earlier_refusals).toHaveLength(1);
    expect(listed.earlier_refusals[0]).toMatchObject({
      by_name: 'Quality Lead',
      note: 'Superseded. Use the 2026 plan.',
      document_id: w.plan.id,
    });
    expect(listed.earlier_refusals[0].at).toBeTruthy();
    // A line with no such history carries none.
    const other = await oneWaiting('No History Item');
    expect((await pending('qa')).lines.find((l) => l.id === other.line.id)?.earlier_refusals).toEqual([]);
  });
});

describe('the person who asked is told (C-070)', () => {
  it('a release mails the asker once, internally, with the order, the documents and who they went to', async () => {
    const w = await oneWaiting('Tell Asker Item');
    const mails = stubMail();
    const res = await release(w.order, [w.line.id]);
    expect(res.status).toBe(200);
    expect(res.body.requester_notice).toEqual({ sent: true, recipients: [USER_EMAIL] });

    expect(toCustomer(mails)).toHaveLength(1);
    const told = toAsker(mails);
    expect(told).toHaveLength(1);
    expect(told[0].to).toEqual([USER_EMAIL]);
    expect(told[0].subject).toContain('QA released 1 document');
    expect(told[0].html).toContain('Quality Lead released this document');
    expect(told[0].html).toContain(CUSTOMER_EMAIL);
    expect(told[0].html).toContain('HACCP Plan');
    expect(told[0].html).toContain('Tell Asker Item');
    expect(told[0].html).toContain(`/orders/${w.order}`);
    // The customer's link is not in the internal note.
    expect(told[0].html).not.toContain('/export/');
    // Exactly two mails left: the customer's and the asker's.
    expect(mails).toHaveLength(2);

    const audit = (await audits('order.documents_requester_notified', w.order)).at(-1)!;
    expect(audit.user_id).toBe(qaUserId);
    expect(audit.details).toMatchObject({ decision: 'released', told_user_id: seed.userId, sent: true });
  });

  it('a refusal mails the asker the note; nothing goes to the customer', async () => {
    const w = await oneWaiting('Tell Asker Refused Item');
    const mails = stubMail();
    expect((await refuse(w.order, w.line.id, 'Wrong plant. Ask for the Northfield one.')).status).toBe(200);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual([USER_EMAIL]);
    expect(mails[0].subject).toContain('QA refused a document');
    expect(mails[0].html).toContain('Wrong plant. Ask for the Northfield one.');
    expect(mails[0].html).toContain('Nothing was sent to the customer');
    expect((await audits('order.documents_requester_notified', w.order)).at(-1)!.details).toMatchObject({ decision: 'refused' });
  });

  it('never the releaser themselves, never an inactive account, never somebody outside the organization', async () => {
    // The asker is the person releasing.
    const mine = await oneWaiting('Own Ask Item');
    await db.prepare('UPDATE order_documents SET pending_requested_by = ? WHERE id = ?').bind(qaUserId, mine.line.id).run();
    let mails = stubMail();
    const own = await release(mine.order, [mine.line.id]);
    expect(own.status).toBe(200);
    expect(own.body.requester_notice).toBeUndefined();
    expect(mails).toHaveLength(1);
    expect(toCustomer(mails)).toHaveLength(1);
    vi.unstubAllGlobals();

    // The asker's account has been switched off.
    const gone = await oneWaiting('Inactive Asker Item');
    await db.prepare('UPDATE users SET active = 0 WHERE id = ?').bind(seed.userId).run();
    try {
      mails = stubMail();
      expect((await release(gone.order, [gone.line.id])).status).toBe(200);
      expect(toAsker(mails)).toHaveLength(0);
      expect(mails).toHaveLength(1);
    } finally {
      await db.prepare('UPDATE users SET active = 1 WHERE id = ?').bind(seed.userId).run();
    }
    vi.unstubAllGlobals();

    // The asker is an account of ANOTHER organization (a stale or forged id).
    const foreign = await oneWaiting('Foreign Asker Item');
    await db.prepare('UPDATE order_documents SET pending_requested_by = ? WHERE id = ?').bind(seed.orgAdmin2Id, foreign.line.id).run();
    mails = stubMail();
    expect((await refuse(foreign.order, foreign.line.id, 'No.')).status).toBe(200);
    expect(mails).toHaveLength(0);
  });
});
