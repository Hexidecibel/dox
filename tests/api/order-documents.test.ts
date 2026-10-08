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
    .bind(generateTestId(), id, fileName, 64, key, own ? seed.orgAdminId : seed.orgAdmin2Id)
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

async function release(order: string, lineIds: string[], who: Who = 'qa') {
  return call<OrderDocumentsReleaseResponse>(
    releaseBatch,
    as(who, `http://localhost/api/orders/${order}/documents/release`, {
      method: 'POST',
      body: JSON.stringify({ line_ids: lineIds }),
      params: { id: order },
    }),
  );
}

async function refuse(order: string, lineId: string, note: unknown, who: Who = 'qa') {
  return call<{ success?: boolean }>(
    refuseOne,
    as(who, `http://localhost/api/orders/${order}/documents/${lineId}/refuse`, {
      method: 'POST',
      body: JSON.stringify({ note }),
      params: { id: order, lineId },
    }),
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
  await db.prepare(`DELETE FROM rate_limits WHERE key LIKE 'order_send:%'`).run();
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

      const fresh = h.mails.slice(before);
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
      expect(h.mails.slice(before)).toHaveLength(1);
    } finally {
      await db.prepare(`UPDATE customers SET email = ? WHERE id = ?`).bind(CUSTOMER_EMAIL, customerId).run();
    }
  });

  it('the single-line route releases one and leaves the other waiting', async () => {
    const h = await heldOrder('Single Release Item');
    const before = h.mails.length;
    const res = await call<OrderDocumentsReleaseResponse>(
      releaseOne,
      as('org_admin', `http://localhost/api/orders/${h.order}/documents/${h.planLine.id}/release`, {
        method: 'POST', params: { id: h.order, lineId: h.planLine.id },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body.released).toEqual([h.planLine.id]);
    expect(h.mails.slice(before)).toHaveLength(1);
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
