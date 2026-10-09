/**
 * Manual COA fulfillment (migration 0134): an order a PERSON builds, and what
 * leaves on it.
 *
 * What is worth pinning is the set of rulings the feature exists to keep:
 *
 *   1. A PICK IS A PERSON'S ACCEPTED MATCH. It writes the columns an accepted
 *      suggestion writes plus an 'accepted' `manual_pick` suggestion row, so
 *      the fulfillment report reads the line `ok` and the matcher never argues
 *      with it.
 *   2. APPROVED DOCUMENTS ONLY, of this organization. Another tenant's, an
 *      archived or a deleted one is refused with the reason, never written.
 *   3. THE LINE SHOWS THE DATE WITH ITS DOUBT. An ambiguous or decoded
 *      production date is never printed as plain fact.
 *   4. THE CUSTOMER GETS ATTACHMENTS under GENERATED names, from
 *      "<Organization> via SupDox" with a reply-to of the sender. The uploaded
 *      file name never leaves.
 *   5. A MULTI-LOT CERTIFICATE GOES WHOLE, once, and falls back to the per-lot
 *      page -- saying so -- when the original is not on file.
 *   6. TOO BIG IS SPLIT, SHOWN AND RECORDED: numbered emails, a non-expiring
 *      link for a single oversize file, a refusal with the number past the
 *      cap, and a `partial` send whose failed parts can be sent again.
 *   7. A READ-ONLY ACCOUNT CANNOT PICK A CERTIFICATE OR SEND. (It may open an
 *      order since 0138, to build a document order: tests/api/order-documents.)
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { PDFDocument } from 'pdf-lib';
import { seedTestData, generateTestId } from '../helpers/db';
import { fnContext, readJson } from '../helpers/requests';
import type { TestUser } from '../helpers/requests';
import { onRequestPost as createOrder } from '../../functions/api/orders/index';
import {
  onRequestGet as getOrder,
  onRequestPut as updateOrder,
  onRequestDelete as deleteOrder,
} from '../../functions/api/orders/[id]';
import { onRequestPost as addItems } from '../../functions/api/orders/[id]/items/index';
import {
  onRequestPut as updateItem,
  onRequestDelete as deleteItem,
} from '../../functions/api/orders/[id]/items/[itemId]';
import { onRequestGet as sendPreview } from '../../functions/api/orders/[id]/send-preview';
import { onRequestPost as sendOrder } from '../../functions/api/orders/[id]/send';
import { onRequestPost as resendOrder } from '../../functions/api/orders/[id]/sends/[sendId]/resend';
import { onRequestGet as coaReport } from '../../functions/api/reports/coa-fulfillment';
import { onRequestGet as listSentLinks } from '../../functions/api/document-exports/links/index';
import { onRequestGet as exportLanding } from '../../functions/api/document-exports/public/[token]';
import { produceCoaRecords } from '../../functions/lib/kinds/coa';
import { linkCoaToOrders } from '../../functions/lib/entities/matching';
import { candidateQueueId, resolveWholeOriginals } from '../../functions/lib/coa-original';
import { exportLinkState } from '../../functions/lib/document-export';
import type {
  CoaRecordsPayload,
  DocumentExportLandingView,
  DocumentExportLinkListResponse,
  OrderGetResponse,
  OrderItemsAddResponse,
  OrderSendPreview,
  OrderSendResponse,
} from '../../shared/types';
import type { QueueItem } from '../../functions/lib/queue-approve';

const db = env.DB;
const files = env.FILES;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let supplierId = '';
let docTypeId = '';
let customerId = '';

const MB = 1024 * 1024;

function asUser(role: 'org_admin' | 'user' | 'reader' = 'user'): TestUser {
  if (role === 'org_admin') {
    return { id: seed.orgAdminId, email: 'orgadmin@test.com', name: 'Org Admin', role, tenant_id: seed.tenantId };
  }
  if (role === 'reader') {
    return { id: seed.readerId, email: 'reader@test.com', name: 'Reader User', role, tenant_id: seed.tenantId };
  }
  return { id: seed.userId, email: 'user@test.com', name: 'Regular User', role, tenant_id: seed.tenantId };
}

function otherTenantAdmin(): TestUser {
  return { id: seed.orgAdmin2Id, email: 'orgadmin2@test.com', name: 'Org Admin 2', role: 'org_admin', tenant_id: seed.tenantId2 };
}

interface LotOpts {
  number: string;
  sub?: string;
  production?: string | null;
  raw?: string | null;
  status?: string | null;
  source?: string | null;
  productId?: string | null;
}

interface MadeDoc {
  id: string;
  fileName: string;
  body: string;
  lotIds: string[];
}

async function makeProduct(name: string, tenantId = seed.tenantId): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(`INSERT INTO products (id, tenant_id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`)
    .bind(id, tenantId, name, `p-${id.slice(0, 8)}`)
    .run();
  return id;
}

async function makeDocument(
  opts: {
    tenantId?: string;
    title?: string;
    fileName?: string;
    size?: number;
    status?: string;
    withFile?: boolean;
    lots?: LotOpts[];
  } = {},
): Promise<MadeDoc> {
  const tenantId = opts.tenantId ?? seed.tenantId;
  const id = generateTestId();
  const fileName = opts.fileName ?? `INTERNAL do not send ${id.slice(0, 6)}.pdf`;
  const body = 'PDF-BYTES-'.repeat(6) + id;
  const own = tenantId === seed.tenantId;

  await db
    .prepare(
      `INSERT INTO documents
         (id, tenant_id, title, tags, current_version, status, created_by, supplier_id, document_type_id)
       VALUES (?, ?, ?, '[]', 1, ?, ?, ?, ?)`,
    )
    .bind(id, tenantId, opts.title ?? `Cream COA ${id.slice(0, 5)}`, opts.status ?? 'active', seed.orgAdminId, own ? supplierId : null, own ? docTypeId : null)
    .run();

  const key = `docs/${id}/v1.pdf`;
  await db
    .prepare(
      `INSERT INTO document_versions
         (id, document_id, version_number, file_name, file_size, mime_type, r2_key, uploaded_by)
       VALUES (?, ?, 1, ?, ?, 'application/pdf', ?, ?)`,
    )
    .bind(generateTestId(), id, fileName, opts.size ?? body.length, key, seed.orgAdminId)
    .run();
  if (opts.withFile !== false) await files.put(key, new TextEncoder().encode(body));

  const lotIds: string[] = [];
  for (const lot of opts.lots ?? []) {
    const lotId = generateTestId();
    await db
      .prepare(
        `INSERT INTO lots
           (id, tenant_id, supplier_id, product_id, lot_number, lot_key, sub_lot_code,
            production_date, production_date_raw, production_date_status, production_date_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        lotId,
        tenantId,
        own ? supplierId : null,
        lot.productId ?? null,
        lot.number,
        `${lot.number}${lot.sub ?? ''}-${lotId.slice(0, 4)}`,
        lot.sub ?? '',
        lot.production ?? null,
        lot.raw ?? null,
        lot.status === undefined ? (lot.production ? 'resolved' : null) : lot.status,
        lot.source === undefined ? (lot.production ? 'extracted' : null) : lot.source,
      )
      .run();
    await db
      .prepare('INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)')
      .bind(generateTestId(), id, lotId)
      .run();
    lotIds.push(lotId);
  }
  return { id, fileName, body, lotIds };
}

async function newOrder(over: Record<string, unknown> = {}, user: TestUser = asUser()): Promise<{ status: number; body: any }> {
  const res = await createOrder(
    fnContext('http://localhost/api/orders', {
      method: 'POST',
      body: JSON.stringify({ order_number: `SO-${generateTestId().slice(0, 8)}`, customer_id: customerId, ...over }),
      user,
    }),
  );
  return { status: res.status, body: await readJson(res) };
}

async function orderId(over: Record<string, unknown> = {}): Promise<string> {
  const { status, body } = await newOrder(over);
  expect(status).toBe(201);
  return body.order.id as string;
}

async function pick(order: string, ids: string[], user: TestUser = asUser()): Promise<{ status: number; body: OrderItemsAddResponse & { error?: string } }> {
  const res = await addItems(
    fnContext(`http://localhost/api/orders/${order}/items`, {
      method: 'POST',
      body: JSON.stringify({ document_ids: ids }),
      user,
      params: { id: order },
    }),
  );
  return { status: res.status, body: (await readJson(res)) as OrderItemsAddResponse & { error?: string } };
}

async function readOrder(order: string, user: TestUser = asUser()): Promise<OrderGetResponse> {
  const res = await getOrder(fnContext(`http://localhost/api/orders/${order}`, { user, params: { id: order } }));
  expect(res.status).toBe(200);
  return (await readJson(res)) as OrderGetResponse;
}

async function preview(order: string, user: TestUser = asUser()): Promise<OrderSendPreview> {
  const res = await sendPreview(
    fnContext(`http://localhost/api/orders/${order}/send-preview`, { user, params: { id: order } }),
  );
  expect(res.status).toBe(200);
  return (await readJson(res)) as OrderSendPreview;
}

async function send(
  order: string,
  body: Record<string, unknown> = {},
  user: TestUser = asUser(),
  envOverride?: Record<string, unknown>,
): Promise<{ status: number; body: OrderSendResponse & { error?: string; code?: string } }> {
  const ctx = fnContext(`http://localhost/api/orders/${order}/send`, {
    method: 'POST',
    body: JSON.stringify(body),
    user,
    params: { id: order },
  }) as any;
  if (envOverride) ctx.env = { ...env, ...envOverride };
  const res = await sendOrder(ctx);
  return { status: res.status, body: (await readJson(res)) as OrderSendResponse & { error?: string; code?: string } };
}

interface CapturedMail {
  from: string;
  to: string[];
  subject: string;
  html: string;
  reply_to?: string;
  attachments?: { filename: string; content: string }[];
}

/** Stub the mail provider. `fail` decides, per message, whether it is refused. */
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

function decode(b64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

async function suggestionRows(itemId: string) {
  const res = await db
    .prepare('SELECT document_id, status, match_basis, match_confidence FROM lot_match_suggestions WHERE order_item_id = ?')
    .bind(itemId)
    .all<{ document_id: string; status: string; match_basis: string; match_confidence: number | null }>();
  return res.results ?? [];
}

async function clearRateLimit(): Promise<void> {
  await db.prepare(`DELETE FROM rate_limits WHERE key LIKE 'order_send:%'`).run();
}

beforeAll(async () => {
  seed = await seedTestData(db);
  supplierId = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(supplierId, seed.tenantId, 'Darigold, Inc.', `darigold-${supplierId.slice(0, 5)}`)
    .run();
  docTypeId = generateTestId();
  await db
    .prepare('INSERT INTO document_types (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(docTypeId, seed.tenantId, 'Certificate of Analysis', `coa-${docTypeId.slice(0, 5)}`)
    .run();
  customerId = generateTestId();
  await db
    .prepare(
      `INSERT INTO customers (id, tenant_id, customer_number, name, email, created_at, updated_at)
       VALUES (?, ?, ?, 'Blue Heron Bakery', 'qa@blueheron.example', datetime('now'), datetime('now'))`,
    )
    .bind(customerId, seed.tenantId, `C-${customerId.slice(0, 6)}`)
    .run();
}, 30_000);

afterEach(async () => {
  vi.unstubAllGlobals();
  await clearRateLimit();
});

// ===========================================================================
// Building the order
// ===========================================================================

describe('POST /api/orders -- an order a person builds', () => {
  it('stores the customer, PO, ship date and who built it', async () => {
    const { status, body } = await newOrder({ po_number: 'PO-7781', ship_date: '2026-10-09' });
    expect(status).toBe(201);
    expect(body.order.customer_id).toBe(customerId);
    // The chosen customer's own name and number are what the order prints.
    expect(body.order.customer_name).toBe('Blue Heron Bakery');
    expect(body.order.po_number).toBe('PO-7781');
    expect(body.order.ship_date).toBe('2026-10-09');
    expect(body.order.created_by).toBe(seed.userId);
  });

  it('refuses a customer from another organization', async () => {
    const foreign = generateTestId();
    await db
      .prepare(`INSERT INTO customers (id, tenant_id, customer_number, name) VALUES (?, ?, ?, 'Elsewhere Foods')`)
      .bind(foreign, seed.tenantId2, `X-${foreign.slice(0, 6)}`)
      .run();
    const { status, body } = await newOrder({ customer_id: foreign });
    expect(status).toBe(400);
    expect(body.error).toMatch(/not in this organization/);
  });

  it('answers 409 with words for an order number already in use', async () => {
    const number = `DUP-${generateTestId().slice(0, 6)}`;
    expect((await newOrder({ order_number: number })).status).toBe(201);
    const again = await newOrder({ order_number: number });
    expect(again.status).toBe(409);
    expect(again.body.error).toContain(number);
  });

  it('refuses a ship date that is not a real day', async () => {
    expect((await newOrder({ ship_date: '2026-02-30' })).status).toBe(400);
    expect((await newOrder({ ship_date: 'next friday' })).status).toBe(400);
  });

  // CHANGED WITH MIGRATION 0138. This used to assert 403: until document
  // orders a read-only account could not open an order at all. AJ's ruling for
  // document orders is "any user with a portal login can build the order", so
  // a reader may now OPEN one -- and still may not put COA lines on it, here
  // or through POST ./:id/items (pinned further down).
  it('a read-only account may open an order, and may not put COA lines on it', async () => {
    const opened = await newOrder({}, asUser('reader'));
    expect(opened.status).toBe(201);
    expect(opened.body.order.created_by).toBe(seed.readerId);
    const withLines = await newOrder({ items: [{ product_name: 'Cream', lot_number: '10426203' }] }, asUser('reader'));
    expect(withLines.status).toBe(403);
  });
});

// ===========================================================================
// Picking
// ===========================================================================

describe('POST /api/orders/:id/items -- picking approved documents', () => {
  it('writes the line the way an accepted match is written, and the report reads it ok', async () => {
    const productId = await makeProduct('Heavy Cream 40%');
    const doc = await makeDocument({
      title: 'Heavy cream certificate',
      lots: [{ number: '10426203', sub: '03', production: '2026-07-22', productId }],
    });
    const order = await orderId();

    const { status, body } = await pick(order, [doc.id]);
    expect(status).toBe(201);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].outcome).toBe('added');

    const got = await readOrder(order);
    expect(got.items).toHaveLength(1);
    const line = got.items[0];
    expect(line.coa_document_id).toBe(doc.id);
    expect(line.lot_id).toBe(doc.lotIds[0]);
    expect(line.lot_matched).toBe(1);
    expect(line.coa_match_status).toBe('matched');
    expect(line.coa_matched_at).toBeTruthy();
    expect(line.picked_by).toBe(seed.userId);
    expect(line.picked_by_name).toBe('Regular User');
    // What the person checks before it goes: product, lot, production date.
    expect(line.product_name).toBe('Heavy Cream 40%');
    expect(line.lot_row_number).toBe('10426203');
    expect(line.sub_lot_code).toBe('03');
    expect(line.production_date_state).toBe('stated');
    expect(line.production_date_label).toBe('Jul 22, 2026');
    expect(line.coa_original).toBe('not_split');
    expect(line.coa_file_size).toBeGreaterThan(0);

    // A person's decision, recorded as one: search coverage reads `accepted`.
    const rows = await suggestionRows(line.id);
    expect(rows).toEqual([
      { document_id: doc.id, status: 'accepted', match_basis: 'manual_pick', match_confidence: null },
    ]);

    const audit = await db
      .prepare(`SELECT details FROM audit_log WHERE action = 'order_item.coa_picked' AND resource_id = ?`)
      .bind(line.id)
      .first<{ details: string }>();
    expect(JSON.parse(audit!.details).document_id).toBe(doc.id);

    // The fulfillment report cannot tell this line from an engine-fed one.
    const report = await coaReport(
      fnContext('http://localhost/api/reports/coa-fulfillment?as_of=2026-10-06', { user: asUser() }),
    );
    const rowsOut = ((await readJson(report)) as { rows: { order_id: string; gap: string }[] }).rows;
    expect(rowsOut.find((r) => r.order_id === order)?.gap).toBe('ok');
  });

  it('makes one line per lot row, each with its own date and doubt', async () => {
    const doc = await makeDocument({
      lots: [
        { number: '500', sub: '01', production: '2026-08-01' },
        { number: '500', sub: '02', production: null, raw: '03/04/2026', status: 'ambiguous', source: 'extracted' },
        { number: '500', sub: '03', production: '2026-08-03', status: 'resolved', source: 'lot_decode' },
        { number: '500', sub: '04', production: '2026-08-04', status: 'resolved', source: 'extracted_code_date_legacy' },
        { number: '500', sub: '05', production: null, raw: '2026-08-05 | 2026-08-09', status: 'conflict', source: 'extracted' },
      ],
    });
    const order = await orderId();
    const { body } = await pick(order, [doc.id]);
    expect(body.results).toHaveLength(5);

    const { items } = await readOrder(order);
    const bySub = new Map(items.map((i) => [i.sub_lot_code, i]));
    expect(bySub.get('01')!.production_date_state).toBe('stated');
    expect(bySub.get('01')!.production_date_note).toBeNull();

    // Never a bare date for anything the portal holds with doubt.
    const ambiguous = bySub.get('02')!;
    expect(ambiguous.production_date_state).toBe('ambiguous');
    expect(ambiguous.production_date_label).toBe('03/04/2026');
    expect(ambiguous.production_date_note).toMatch(/more than one way/);

    const decoded = bySub.get('03')!;
    expect(decoded.production_date_state).toBe('decoded');
    expect(decoded.production_date_label).toContain('from the lot code');
    expect(decoded.production_date_note).toMatch(/does not state it/);

    expect(bySub.get('04')!.production_date_state).toBe('legacy');
    expect(bySub.get('04')!.production_date_label).toContain('confirm');
    expect(bySub.get('05')!.production_date_state).toBe('conflict');
    expect(bySub.get('05')!.production_date_note).toMatch(/different production dates/);
  });

  it('fills an existing line for that lot instead of adding a second one', async () => {
    const doc = await makeDocument({ lots: [{ number: '77001', production: '2026-06-01' }] });
    const order = await orderId();
    const lineId = generateTestId();
    await db
      .prepare(`INSERT INTO order_items (id, order_id, product_name, lot_number, lot_id) VALUES (?, ?, 'WMS line', '77001', ?)`)
      .bind(lineId, order, doc.lotIds[0])
      .run();

    const { body } = await pick(order, [doc.id]);
    expect(body.results).toEqual([
      expect.objectContaining({ order_item_id: lineId, outcome: 'filled' }),
    ]);
    const { items } = await readOrder(order);
    expect(items).toHaveLength(1);
    expect(items[0].coa_document_id).toBe(doc.id);
    // The line keeps what the WMS said the product was.
    expect(items[0].product_name).toBe('WMS line');
  });

  it('is idempotent: the same pick twice writes nothing the second time', async () => {
    const doc = await makeDocument({ lots: [{ number: '88001' }] });
    const order = await orderId();
    await pick(order, [doc.id]);
    const second = await pick(order, [doc.id]);
    expect(second.body.results[0].outcome).toBe('already_on_order');
    expect((await readOrder(order)).items).toHaveLength(1);
  });

  it('a document with no lot row becomes one line with no lot', async () => {
    const doc = await makeDocument({ title: 'Allergen statement' });
    const order = await orderId();
    const { status } = await pick(order, [doc.id]);
    expect(status).toBe(201);
    const { items } = await readOrder(order);
    expect(items[0].coa_document_id).toBe(doc.id);
    expect(items[0].lot_id).toBeNull();
    expect(items[0].production_date_state).toBe('none');
  });

  it('refuses another organization\'s document, an archived one and a deleted one -- and says why', async () => {
    const foreign = await makeDocument({ tenantId: seed.tenantId2 });
    const archived = await makeDocument({ status: 'archived' });
    const deleted = await makeDocument({ status: 'deleted' });
    const good = await makeDocument({ lots: [{ number: '99001' }] });
    const order = await orderId();

    const { status, body } = await pick(order, [foreign.id, archived.id, deleted.id, good.id]);
    // One bad id does not lose the good one, and is not silent either.
    expect(status).toBe(201);
    expect(body.results.map((r) => r.document_id)).toEqual([good.id]);
    const reasons = new Map(body.refused.map((r) => [r.document_id, r.reason]));
    expect(reasons.get(foreign.id)).toMatch(/Not a document in this organization/);
    expect(reasons.get(archived.id)).toMatch(/archived/);
    expect(reasons.get(deleted.id)).toMatch(/deleted/);

    const onlyBad = await pick(order, [foreign.id]);
    expect(onlyBad.status).toBe(400);
    expect((await readOrder(order)).items).toHaveLength(1);
  });

  it('a read-only account cannot pick, and another organization cannot see the order', async () => {
    const doc = await makeDocument({ lots: [{ number: '99100' }] });
    const order = await orderId();
    expect((await pick(order, [doc.id], asUser('reader'))).status).toBe(403);
    expect((await pick(order, [doc.id], otherTenantAdmin())).status).toBe(404);
    expect((await readOrder(order)).items).toHaveLength(0);
  });

  it('adds a typed line and asks the matcher for certificates -- as suggestions only', async () => {
    const doc = await makeDocument({ lots: [] });
    // A certificate for lot 42100, attached the way approval attaches one.
    const lotId = generateTestId();
    await db
      .prepare(`INSERT INTO lots (id, tenant_id, lot_number, lot_key, sub_lot_code) VALUES (?, ?, '42100', '42100', '')`)
      .bind(lotId, seed.tenantId)
      .run();
    await db.prepare('INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)').bind(generateTestId(), doc.id, lotId).run();

    const order = await orderId();
    const res = await addItems(
      fnContext(`http://localhost/api/orders/${order}/items`, {
        method: 'POST',
        body: JSON.stringify({ item: { product_name: 'Butter 25kg', lot_number: '42100', quantity: 4 } }),
        user: asUser(),
        params: { id: order },
      }),
    );
    expect(res.status).toBe(201);
    const got = await readOrder(order);
    expect(got.items[0].product_name).toBe('Butter 25kg');
    expect(got.items[0].lot_id).toBe(lotId);
    // Found, and OFFERED: nothing is linked until a person says so.
    expect(got.items[0].coa_document_id).toBeNull();
    expect((got.suggestions as { document_id: string }[]).map((s) => s.document_id)).toContain(doc.id);
  });
});

describe('PUT / DELETE /api/orders/:id/items/:itemId', () => {
  it('taking a certificate off a line clears the match and the matcher does not offer it back', async () => {
    const doc = await makeDocument({ lots: [{ number: '31001' }] });
    const order = await orderId();
    const { body } = await pick(order, [doc.id]);
    const itemId = body.results[0].order_item_id;

    const res = await updateItem(
      fnContext(`http://localhost/api/orders/${order}/items/${itemId}`, {
        method: 'PUT',
        body: JSON.stringify({ coa_document_id: null }),
        user: asUser(),
        params: { id: order, itemId },
      }),
    );
    expect(res.status).toBe(200);
    const line = (await readOrder(order)).items[0];
    expect(line.coa_document_id).toBeNull();
    expect(line.lot_matched).toBe(0);
    expect(line.coa_match_status).toBe('unmatched');
    expect(line.picked_by).toBeNull();
    // The lot stays: the line is still for that lot.
    expect(line.lot_id).toBe(doc.lotIds[0]);

    // The engine runs again for this certificate. A person removed the pair,
    // so it stays removed.
    await linkCoaToOrders(db, seed.tenantId, { documentId: doc.id, lotId: doc.lotIds[0], productId: null, supplierId });
    expect(await suggestionRows(itemId)).toEqual([
      expect.objectContaining({ document_id: doc.id, status: 'rejected' }),
    ]);
  });

  it('the matcher never reopens or re-ranks a hand pick', async () => {
    const doc = await makeDocument({ lots: [{ number: '31002' }] });
    const order = await orderId();
    const { body } = await pick(order, [doc.id]);
    const itemId = body.results[0].order_item_id;
    await linkCoaToOrders(db, seed.tenantId, { documentId: doc.id, lotId: doc.lotIds[0], productId: null, supplierId });
    expect(await suggestionRows(itemId)).toEqual([
      { document_id: doc.id, status: 'accepted', match_basis: 'manual_pick', match_confidence: null },
    ]);
    expect((await readOrder(order)).items[0].coa_document_id).toBe(doc.id);
  });

  it('putting a document on a line asks which lot when it certifies several', async () => {
    const doc = await makeDocument({ lots: [{ number: '600', sub: '01' }, { number: '600', sub: '02' }] });
    const order = await orderId();
    const typed = await addItems(
      fnContext(`http://localhost/api/orders/${order}/items`, {
        method: 'POST',
        body: JSON.stringify({ item: { product_name: 'Cream' } }),
        user: asUser(),
        params: { id: order },
      }),
    );
    const itemId = ((await readJson(typed)) as OrderItemsAddResponse).item_id!;
    const put = (payload: unknown) =>
      updateItem(
        fnContext(`http://localhost/api/orders/${order}/items/${itemId}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
          user: asUser(),
          params: { id: order, itemId },
        }),
      );

    const vague = await put({ coa_document_id: doc.id });
    expect(vague.status).toBe(400);
    expect(((await readJson(vague)) as { error: string }).error).toMatch(/certifies 2 lots/);

    expect((await put({ coa_document_id: doc.id, lot_id: doc.lotIds[1] })).status).toBe(200);
    const line = (await readOrder(order)).items[0];
    expect(line.lot_id).toBe(doc.lotIds[1]);
    expect(line.sub_lot_code).toBe('02');
  });

  it('removes a line, and an order with picks can still be deleted', async () => {
    const a = await makeDocument({ lots: [{ number: '31010' }] });
    const b = await makeDocument({ lots: [{ number: '31011' }] });
    const order = await orderId();
    const { body } = await pick(order, [a.id, b.id]);

    const del = await deleteItem(
      fnContext(`http://localhost/api/orders/${order}/items/${body.results[0].order_item_id}`, {
        method: 'DELETE',
        user: asUser(),
        params: { id: order, itemId: body.results[0].order_item_id },
      }),
    );
    expect(del.status).toBe(200);
    expect((await readOrder(order)).items).toHaveLength(1);

    // Suggestion rows reference the lines with no ON DELETE action; the order
    // delete has to clear them or it could never run on a hand-built order.
    const gone = await deleteOrder(
      fnContext(`http://localhost/api/orders/${order}`, { method: 'DELETE', user: asUser('org_admin'), params: { id: order } }),
    );
    expect(gone.status).toBe(200);
  });

  it('PUT /api/orders/:id takes a ship date and refuses a foreign customer', async () => {
    const order = await orderId();
    const ok = await updateOrder(
      fnContext(`http://localhost/api/orders/${order}`, {
        method: 'PUT',
        body: JSON.stringify({ ship_date: '2026-11-01' }),
        user: asUser(),
        params: { id: order },
      }),
    );
    expect(ok.status).toBe(200);
    expect(((await readJson(ok)) as any).order.ship_date).toBe('2026-11-01');

    const foreign = generateTestId();
    await db
      .prepare(`INSERT INTO customers (id, tenant_id, customer_number, name) VALUES (?, ?, ?, 'Elsewhere')`)
      .bind(foreign, seed.tenantId2, `Y-${foreign.slice(0, 6)}`)
      .run();
    const bad = await updateOrder(
      fnContext(`http://localhost/api/orders/${order}`, {
        method: 'PUT',
        body: JSON.stringify({ customer_id: foreign }),
        user: asUser(),
        params: { id: order },
      }),
    );
    expect(bad.status).toBe(400);
  });
});

// ===========================================================================
// Sending
// ===========================================================================

describe('GET /api/orders/:id/send-preview + POST /api/orders/:id/send', () => {
  it('attaches each certificate under a generated name, from the organization, reply-to the sender', async () => {
    const a = await makeDocument({ title: 'Cream cert', lots: [{ number: '10426203', sub: '03', production: '2026-07-22' }] });
    const b = await makeDocument({ title: 'Butter cert', lots: [{ number: '20000001' }] });
    const order = await orderId({ po_number: 'PO-55', ship_date: '2026-10-12' });
    await pick(order, [a.id, b.id]);

    const plan = await preview(order);
    expect(plan.blocked).toBeNull();
    expect(plan.recipient).toBe('qa@blueheron.example');
    expect(plan.from_name).toBe('Test Corp via SupDox');
    expect(plan.reply_to).toBe('user@test.com');
    expect(plan.part_count).toBe(1);
    expect(plan.files.map((f) => f.delivery)).toEqual(['attachment', 'attachment']);
    expect(plan.files[0].file_name).toBe('Darigold-Inc_Certificate-of-Analysis_10426203-03_1.pdf');
    expect(plan.files[0].lines[0].production_date_label).toBe('Jul 22, 2026');
    // Storage addresses stay on the server.
    expect(JSON.stringify(plan)).not.toContain('docs/');

    const mail = stubMail();
    const { status, body } = await send(order, { message: 'Certificates for your delivery.', fingerprint: plan.fingerprint });
    expect(status).toBe(200);
    expect(body.sent).toBe(true);
    expect(body.order_status).toBe('delivered');

    expect(mail).toHaveLength(1);
    const m = mail[0];
    expect(m.from).toBe('Test Corp via SupDox <noreply@supdox.com>');
    expect(m.reply_to).toBe('user@test.com');
    expect(m.to).toEqual(['qa@blueheron.example']);
    expect(m.subject).toContain('PO-55');
    expect(m.subject).not.toMatch(/of \d+\)/);
    expect(m.attachments!.map((x) => x.filename)).toEqual(plan.files.map((f) => f.file_name));
    // An exact copy of each file.
    expect(decode(m.attachments![0].content)).toBe(a.body);
    expect(decode(m.attachments![1].content)).toBe(b.body);
    // The uploaded name never leaves -- not as a file name, not in the body.
    const wire = JSON.stringify(m);
    expect(wire).not.toContain('INTERNAL do not send');
    expect(wire).not.toContain(a.id);
    expect(m.html).toContain('Certificates for your delivery.');

    // What left, to whom, and how.
    expect(body.send.status).toBe('sent');
    expect(body.send.recipients).toEqual(['qa@blueheron.example']);
    expect(body.send.files).toHaveLength(2);
    expect(body.send.files.every((f) => f.sent_ok && f.delivery === 'attachment' && f.source === 'document')).toBe(true);
    const audit = await db
      .prepare(`SELECT details FROM audit_log WHERE action = 'order.coas_sent' AND resource_id = ?`)
      .bind(body.send.id)
      .first<{ details: string }>();
    const details = JSON.parse(audit!.details);
    expect(details.recipients).toEqual(['qa@blueheron.example']);
    expect(details.files.flatMap((f: { document_ids: string[] }) => f.document_ids).sort()).toEqual([a.id, b.id].sort());

    expect((await readOrder(order)).sends![0].id).toBe(body.send.id);
    expect((await readOrder(order)).order.status).toBe('delivered');
  });

  it('several lines from one document travel as ONE attachment', async () => {
    const doc = await makeDocument({ lots: [{ number: '700', sub: '01' }, { number: '700', sub: '02' }] });
    const order = await orderId();
    await pick(order, [doc.id]);
    const plan = await preview(order);
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0].lines).toHaveLength(2);
  });

  it('says which lines will not be sent, and refuses an order with nothing to send', async () => {
    const order = await orderId();
    await addItems(
      fnContext(`http://localhost/api/orders/${order}/items`, {
        method: 'POST',
        body: JSON.stringify({ item: { product_name: 'No certificate yet' } }),
        user: asUser(),
        params: { id: order },
      }),
    );
    const empty = await preview(order);
    expect(empty.blocked?.code).toBe('nothing_to_send');
    expect(empty.lines_not_sent).toHaveLength(1);
    stubMail();
    expect((await send(order)).status).toBe(400);

    // A certificate archived AFTER it was picked is named, not silently dropped.
    const doc = await makeDocument({ lots: [{ number: '71000' }] });
    const kept = await makeDocument({ lots: [{ number: '71001' }] });
    await pick(order, [doc.id, kept.id]);
    await db.prepare(`UPDATE documents SET status = 'archived' WHERE id = ?`).bind(doc.id).run();
    const plan = await preview(order);
    expect(plan.blocked).toBeNull();
    expect(plan.files).toHaveLength(1);
    expect(plan.lines_not_sent.map((l) => l.reason).join(' ')).toMatch(/archived/);

    // What can go, goes -- but an order with a line left behind is not
    // `delivered`, however well the rest went.
    vi.unstubAllGlobals();
    stubMail();
    const sent = await send(order, { fingerprint: plan.fingerprint });
    expect(sent.status).toBe(200);
    expect(sent.body.send.status).toBe('sent');
    expect(sent.body.order_status).toBe('pending');
    expect((await readOrder(order)).order.status).toBe('pending');
  });

  it('splits what does not fit into numbered emails, and shows the split before sending', async () => {
    const docs = [];
    for (let i = 0; i < 3; i++) docs.push(await makeDocument({ size: 7 * MB, lots: [{ number: `8000${i}` }] }));
    const order = await orderId();
    await pick(order, docs.map((d) => d.id));

    const plan = await preview(order);
    expect(plan.part_count).toBe(2);
    expect(plan.files.map((f) => f.part_number)).toEqual([1, 1, 2]);
    expect(plan.parts.map((p) => p.subject)).toEqual([
      expect.stringMatching(/\(1 of 2\)$/),
      expect.stringMatching(/\(2 of 2\)$/),
    ]);
    expect(plan.warnings.join(' ')).toMatch(/2 emails/);

    const mail = stubMail();
    const { body } = await send(order, { fingerprint: plan.fingerprint });
    expect(mail.map((m) => m.subject)).toEqual(plan.parts.map((p) => p.subject));
    expect(mail.map((m) => m.attachments!.length)).toEqual([2, 1]);
    expect(mail[1].html).toContain('email 2 of 2');
    expect(body.send.part_count).toBe(2);
    expect(body.send.files.map((f) => f.part_number)).toEqual([1, 1, 2]);
  });

  it('a single file too large to attach goes as a link that does not expire', async () => {
    const big = await makeDocument({ size: 16 * MB, lots: [{ number: '90001' }] });
    const small = await makeDocument({ lots: [{ number: '90002' }] });
    const order = await orderId();
    await pick(order, [big.id, small.id]);

    const plan = await preview(order);
    expect(plan.part_count).toBe(1);
    expect(plan.files[0].delivery).toBe('link');
    expect(plan.files[0].notes.join(' ')).toMatch(/does not expire/);
    expect(plan.files[1].delivery).toBe('attachment');

    const mail = stubMail();
    const { status, body } = await send(order, { fingerprint: plan.fingerprint });
    expect(status).toBe(200);
    expect(mail[0].attachments).toHaveLength(1);
    const token = /\/export\/([A-Za-z0-9_-]+)/.exec(mail[0].html)![1];
    expect(mail[0].html).toContain('This link does not expire');

    const link = await db
      .prepare('SELECT id, never_expires, expires_at, revoked_at, document_ids FROM document_export_links WHERE token = ?')
      .bind(token)
      .first<{ id: string; never_expires: number; expires_at: string; revoked_at: string | null; document_ids: string }>();
    expect(link!.never_expires).toBe(1);
    expect(JSON.parse(link!.document_ids)).toEqual([big.id]);
    // Time does not end it...
    expect(exportLinkState(link!, new Date('2090-01-01T00:00:00Z'))).toBe('active');
    // ...and the recipient page opens, saying so rather than printing a date.
    const landing = await exportLanding(
      fnContext(`http://localhost/api/document-exports/public/${token}`, { params: { token } }),
    );
    expect(landing.status).toBe(200);
    expect(((await readJson(landing)) as DocumentExportLandingView).never_expires).toBe(true);
    // ...but a person still can.
    expect(exportLinkState({ ...link!, revoked_at: '2026-10-07 00:00:00' })).toBe('revoked');

    const record = body.send.files.find((f) => f.document_id === big.id)!;
    expect(record.delivery).toBe('link');
    expect(record.sent_ok).toBe(true);
  });

  it('refuses, with the number, an order that would need more emails than the cap', async () => {
    const docs = [];
    for (let i = 0; i < 11; i++) docs.push(await makeDocument({ size: 14 * MB, lots: [{ number: `9100${i}` }] }));
    const order = await orderId();
    await pick(order, docs.map((d) => d.id));

    const plan = await preview(order);
    expect(plan.blocked?.code).toBe('too_many_parts');
    expect(plan.blocked?.message).toContain('11 emails');
    expect(plan.blocked?.message).toContain('at most 10');

    const mail = stubMail();
    const { status, body } = await send(order);
    expect(status).toBe(413);
    expect(body.error).toContain('11 emails');
    expect(mail).toHaveLength(0);
  });

  it('a failed part leaves the send partial; resending sends only what failed', async () => {
    const docs = [];
    for (let i = 0; i < 3; i++) docs.push(await makeDocument({ size: 7 * MB, lots: [{ number: `9200${i}` }] }));
    const order = await orderId();
    await pick(order, docs.map((d) => d.id));
    const plan = await preview(order);

    const firstRun = stubMail((m) => m.subject.includes('(2 of 2)'));
    const { status, body } = await send(order, { fingerprint: plan.fingerprint });
    // Something reached the customer, so this is a state to show, not an error.
    expect(status).toBe(200);
    expect(body.sent).toBe(false);
    expect(body.send.status).toBe('partial');
    expect(body.send.parts.map((p) => p.ok)).toEqual([true, false]);
    expect(body.send.parts[1].error).toContain('provider said no');
    expect(body.send.files.map((f) => f.sent_ok)).toEqual([true, true, false]);
    expect(body.send.can_resend).toBe(true);
    expect(firstRun).toHaveLength(1);
    // Not delivered until every part went.
    expect((await readOrder(order)).order.status).toBe('pending');

    vi.unstubAllGlobals();
    const secondRun = stubMail();
    const res = await resendOrder(
      fnContext(`http://localhost/api/orders/${order}/sends/${body.send.id}/resend`, {
        method: 'POST',
        user: asUser(),
        params: { id: order, sendId: body.send.id },
      }),
    );
    expect(res.status).toBe(200);
    const after = (await readJson(res)) as OrderSendResponse;
    // Only the part that failed, with the same subject and the same file.
    expect(secondRun.map((m) => m.subject)).toEqual([plan.parts[1].subject]);
    expect(secondRun[0].attachments!.map((a) => a.filename)).toEqual([plan.files[2].file_name]);
    expect(after.send.status).toBe('sent');
    expect(after.send.parts[1].attempts).toBe(2);
    expect(after.order_status).toBe('delivered');

    // Nothing left to resend.
    const again = await resendOrder(
      fnContext(`http://localhost/api/orders/${order}/sends/${body.send.id}/resend`, {
        method: 'POST',
        user: asUser(),
        params: { id: order, sendId: body.send.id },
      }),
    );
    expect(again.status).toBe(409);
  });

  it('answers 502 and records the failure when no email went', async () => {
    const doc = await makeDocument({ lots: [{ number: '93000' }] });
    const order = await orderId();
    await pick(order, [doc.id]);
    stubMail(() => true);
    const { status, body } = await send(order);
    expect(status).toBe(502);
    expect(body.send.status).toBe('failed');
    expect((await readOrder(order)).order.status).toBe('pending');
    const audit = await db
      .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'order.coas_send_failed' AND resource_id = ?`)
      .bind(body.send.id)
      .first<{ n: number }>();
    expect(audit!.n).toBe(1);
  });

  it('does not send short: a file missing from storage fails its email with the reason', async () => {
    const doc = await makeDocument({ withFile: false, lots: [{ number: '93100' }] });
    const order = await orderId();
    await pick(order, [doc.id]);
    const mail = stubMail();
    const { status, body } = await send(order);
    expect(status).toBe(502);
    expect(mail).toHaveLength(0);
    expect(body.send.parts[0].error).toMatch(/not in storage/);
  });

  it('refuses a plan that changed since it was reviewed', async () => {
    const a = await makeDocument({ lots: [{ number: '94000' }] });
    const b = await makeDocument({ lots: [{ number: '94001' }] });
    const order = await orderId();
    await pick(order, [a.id]);
    const plan = await preview(order);
    await pick(order, [b.id]);
    const mail = stubMail();
    const { status } = await send(order, { fingerprint: plan.fingerprint });
    expect(status).toBe(409);
    expect(mail).toHaveLength(0);
  });

  it('needs an address, takes an edited one, and refuses a malformed one', async () => {
    const doc = await makeDocument({ lots: [{ number: '95000' }] });
    const { body: created } = await newOrder({ customer_id: null, customer_name: 'Walk-in' });
    const order = created.order.id as string;
    await pick(order, [doc.id]);
    const mail = stubMail();
    expect((await preview(order)).recipient).toBeNull();
    expect((await send(order)).status).toBe(400);
    expect((await send(order, { recipients: ['not-an-address'] })).status).toBe(400);
    const ok = await send(order, { recipients: 'buyer@walkin.example' });
    expect(ok.status).toBe(200);
    expect(mail[0].to).toEqual(['buyer@walkin.example']);
  });

  it('a read-only account cannot preview or send; another organization gets 404', async () => {
    const doc = await makeDocument({ lots: [{ number: '96000' }] });
    const order = await orderId();
    await pick(order, [doc.id]);
    const mail = stubMail();
    expect((await send(order, {}, asUser('reader'))).status).toBe(403);
    const readerPreview = await sendPreview(
      fnContext(`http://localhost/api/orders/${order}/send-preview`, { user: asUser('reader'), params: { id: order } }),
    );
    expect(readerPreview.status).toBe(403);
    expect((await send(order, {}, otherTenantAdmin())).status).toBe(404);
    expect(mail).toHaveLength(0);
  });

  it('says so, and sends nothing, when email is not configured', async () => {
    const doc = await makeDocument({ lots: [{ number: '97000' }] });
    const order = await orderId();
    await pick(order, [doc.id]);
    const mail = stubMail();
    const { status, body } = await send(order, {}, asUser(), { RESEND_API_KEY: undefined });
    expect(status).toBe(503);
    expect(body.code).toBe('email_not_configured');
    expect(mail).toHaveLength(0);
    const rows = await db.prepare('SELECT COUNT(*) AS n FROM order_sends WHERE order_id = ?').bind(order).first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });

  it('order sends are listed on "Sent documents", in the caller\'s scope', async () => {
    const doc = await makeDocument({ lots: [{ number: '98000' }] });
    const order = await orderId();
    await pick(order, [doc.id]);
    stubMail();
    const { body } = await send(order);

    const mine = await listSentLinks(fnContext('http://localhost/api/document-exports/links', { user: asUser() }));
    const mineBody = (await readJson(mine)) as DocumentExportLinkListResponse;
    expect(mineBody.scope).toBe('mine');
    expect(mineBody.order_sends.map((s) => s.id)).toContain(body.send.id);

    // A reader sent nothing, so sees none of it.
    const reader = await listSentLinks(fnContext('http://localhost/api/document-exports/links', { user: asUser('reader') }));
    expect(((await readJson(reader)) as DocumentExportLinkListResponse).order_sends).toEqual([]);

    const admin = await listSentLinks(fnContext('http://localhost/api/document-exports/links', { user: asUser('org_admin') }));
    expect(((await readJson(admin)) as DocumentExportLinkListResponse).order_sends.map((s) => s.id)).toContain(body.send.id);

    const other = await listSentLinks(fnContext('http://localhost/api/document-exports/links', { user: otherTenantAdmin() }));
    expect(((await readJson(other)) as DocumentExportLinkListResponse).order_sends.map((s) => s.id)).not.toContain(body.send.id);
  });
});

// ===========================================================================
// The whole certificate (H2)
// ===========================================================================

async function pdfWithPages(n: number): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) {
    const page = doc.addPage([300, 400]);
    page.drawText(`Certificate page ${i + 1}`, { x: 20, y: 350, size: 18 });
  }
  const bytes = await doc.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function multiLotPayload(lot: string): CoaRecordsPayload {
  const record = (idx: number, sub: string) => ({
    record_index: idx,
    fields: { lot_code: lot, sub_lot_code: sub, product_name: 'Sweet Cream Butter' },
    source_pages: [idx + 1],
  });
  return {
    record_cardinality: 'multi_lot',
    record_key_basis: 'lot+sublot',
    page_metadata: { manufacturer: 'Darigold' },
    records: [record(0, '01'), record(1, '02'), record(2, '03')],
  } as CoaRecordsPayload;
}

/** Approve a real three-page, three-lot certificate through the records path. */
async function approveMultiLot(lot: string): Promise<{ queueId: string; original: ArrayBuffer; docIds: string[]; r2Key: string }> {
  const id = generateTestId();
  const r2Key = `pending/${id}.pdf`;
  const original = await pdfWithPages(3);
  await files.put(r2Key, original, { httpMetadata: { contentType: 'application/pdf' } });
  const payload = multiLotPayload(lot);
  const fileName = `supplier upload ${id.slice(0, 6)}.pdf`;
  await db
    .prepare(
      `INSERT INTO processing_queue
         (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type,
          ai_records, processing_status, output_kind, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'application/pdf', ?, 'ready', 'coa', 'pending', ?, datetime('now'))`,
    )
    .bind(id, seed.tenantId, docTypeId, r2Key, fileName, original.byteLength, JSON.stringify(payload), seed.userId)
    .run();
  const item = {
    id,
    tenant_id: seed.tenantId,
    document_type_id: docTypeId,
    file_r2_key: r2Key,
    file_name: fileName,
    file_size: original.byteLength,
    mime_type: 'application/pdf',
    extracted_text: null,
    ai_fields: null,
    ai_confidence: null,
    confidence_score: null,
    product_names: null,
    supplier: 'Darigold, Inc.',
    status: 'pending',
    created_by: seed.userId,
    tenant_slug: 'test-corp',
  } as unknown as QueueItem;
  const result = await produceCoaRecords(db, files, item, { payload, userId: seed.userId });
  return { queueId: id, original, docIds: result.documents.map((d) => d.documentId), r2Key };
}

describe('the whole original of a multi-lot certificate', () => {
  it('goes whole, once, for every line cut from it -- under a generated name', async () => {
    const cert = await approveMultiLot('5551000');
    expect(cert.docIds).toHaveLength(3);
    const order = await orderId();
    await pick(order, [cert.docIds[0], cert.docIds[2]]);

    const { items } = await readOrder(order);
    expect(items.map((i) => i.coa_original)).toEqual(['on_file', 'on_file']);

    const plan = await preview(order);
    expect(plan.files).toHaveLength(1);
    const file = plan.files[0];
    expect(file.source).toBe('original');
    expect(file.lines).toHaveLength(2);
    expect(file.bytes).toBe(cert.original.byteLength);
    expect(file.document_ids.sort()).toEqual([cert.docIds[0], cert.docIds[2]].sort());
    expect(file.notes.join(' ')).toMatch(/attached once, whole/);
    expect(file.file_name).toMatch(/^Darigold-Inc_Certificate-of-Analysis_5551000-01-plus1_1\.pdf$/);

    const mail = stubMail();
    const { body } = await send(order, { fingerprint: plan.fingerprint });
    expect(mail[0].attachments).toHaveLength(1);
    // Byte for byte the file the supplier sent, not a per-lot page.
    const sentBytes = Uint8Array.from(atob(mail[0].attachments![0].content), (c) => c.charCodeAt(0));
    expect(sentBytes.length).toBe(cert.original.byteLength);
    expect([...sentBytes.slice(0, 64)]).toEqual([...new Uint8Array(cert.original).slice(0, 64)]);
    expect(JSON.stringify(mail[0])).not.toContain('supplier upload');
    expect(body.send.files[0].source).toBe('original');
    expect(body.send.files[0].document_ids).toHaveLength(2);
  });

  it('does not go whole when another lot on the same certificate may not leave (C-042)', async () => {
    // Three lots on one certificate. The order takes the first two; the THIRD,
    // which is not on the order at all, is locked. The whole original carries
    // that lot's page too, so it takes the strictest rule of all three.
    const cert = await approveMultiLot('5556000');
    await db.prepare(`UPDATE documents SET sharing_rule_override = 'locked' WHERE id = ?`).bind(cert.docIds[2]).run();
    const order = await orderId();
    await pick(order, [cert.docIds[0], cert.docIds[1]]);

    const plan = await preview(order);
    expect(plan.files).toHaveLength(2);
    expect(plan.files.every((f) => f.source === 'document')).toBe(true);
    expect(plan.files[0].notes.join(' ')).toMatch(/also covers a document that is locked, so only this lot's page is sent/);
    // The two lines themselves are free, so nothing is listed as not sent.
    expect(plan.lines_not_sent).toEqual([]);

    const mail = stubMail();
    const { body } = await send(order, { fingerprint: plan.fingerprint });
    expect(body.send.status).toBe('sent');
    const sizes = mail.flatMap((m) => m.attachments ?? []).map((a) => atob(a.content).length);
    // Two per-lot pages, neither of them the three-page original.
    expect(sizes).toHaveLength(2);
    expect(sizes.every((n) => n !== cert.original.byteLength)).toBe(true);
  });

  it('a whole original already recorded on a send is re-checked on resend (C-042)', async () => {
    const cert = await approveMultiLot('5557000');
    const order = await orderId();
    await pick(order, [cert.docIds[0], cert.docIds[1]]);
    stubMail(() => true);
    const first = await send(order);
    expect(first.status).toBe(502);
    expect(first.body.send.files[0].source).toBe('original');
    vi.unstubAllGlobals();

    // A lot that is on the certificate but not on the order is locked.
    await db.prepare(`UPDATE documents SET sharing_rule_override = 'locked' WHERE id = ?`).bind(cert.docIds[2]).run();
    const mail = stubMail();
    const res = await resendOrder(
      fnContext(`http://localhost/api/orders/${order}/sends/${first.body.send.id}/resend`, {
        method: 'POST',
        user: asUser(),
        params: { id: order, sendId: first.body.send.id },
      }),
    );
    const after = (await readJson(res)) as OrderSendResponse;
    expect(after.send.status).toBe('failed');
    expect(after.send.parts[0].error).toMatch(/was not sent\. Locked/);
    expect(mail).toHaveLength(0);
  });

  it('falls back to the per-lot page, and says so, when the original is not on file', async () => {
    const cert = await approveMultiLot('5552000');
    await files.delete(cert.r2Key);
    const order = await orderId();
    await pick(order, [cert.docIds[0], cert.docIds[1]]);

    expect((await readOrder(order)).items.map((i) => i.coa_original)).toEqual(['missing', 'missing']);
    const plan = await preview(order);
    expect(plan.files).toHaveLength(2);
    expect(plan.files.every((f) => f.source === 'document')).toBe(true);
    expect(plan.files[0].notes.join(' ')).toMatch(/original is not on file\. The per-lot page will be sent/);
  });

  it('never returns the wrong original for a version written by "Replace existing"', async () => {
    const first = await approveMultiLot('5553000');
    const docId = first.docIds[0];
    // The document's current version is now v2, written from a LATER queue
    // item. Its origin_queue_id and external_ref still name the first.
    const later = await approveMultiLot('5553900');
    const laterName = (await db.prepare('SELECT file_name FROM processing_queue WHERE id = ?').bind(later.queueId).first<{ file_name: string }>())!.file_name;
    await db
      .prepare(
        `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, uploaded_by)
         VALUES (?, ?, 2, ?, 10, 'application/pdf', ?, ?)`,
      )
      .bind(generateTestId(), docId, laterName, `docs/${docId}/v2.pdf`, seed.userId)
      .run();
    await db.prepare('UPDATE documents SET current_version = 2 WHERE id = ?').bind(docId).run();

    // No record of which queue item wrote v2: nothing is guessed.
    let res = await resolveWholeOriginals(db, files, seed.tenantId, [docId]);
    expect(res.get(docId)).toEqual(expect.objectContaining({ state: 'missing', reason: 'no_trace' }));

    // The replace audit row names it: the LATER original, never the first.
    await db
      .prepare(
        `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details)
         VALUES (?, ?, 'document.version_replaced', 'document', ?, ?)`,
      )
      .bind(seed.userId, seed.tenantId, docId, JSON.stringify({ queue_item_id: later.queueId, new_version: 2 }))
      .run();
    res = await resolveWholeOriginals(db, files, seed.tenantId, [docId]);
    const got = res.get(docId)!;
    expect(got.state).toBe('on_file');
    expect(got.state === 'on_file' && got.original.queue_id).toBe(later.queueId);

    // A candidate whose file name is not the one the version was written under
    // did not produce it.
    await db.prepare(`UPDATE document_versions SET file_name = 'something else.pdf' WHERE document_id = ? AND version_number = 2`).bind(docId).run();
    res = await resolveWholeOriginals(db, files, seed.tenantId, [docId]);
    expect(res.get(docId)).toEqual(expect.objectContaining({ state: 'missing', reason: 'not_confirmed' }));
  });

  it('candidateQueueId: version 1 needs origin and external_ref to agree', () => {
    expect(candidateQueueId({ current_version: 1, external_ref: 'queue-abc123-10426110', origin_queue_id: 'abc123' }, null))
      .toEqual({ queue_id: 'abc123', reason: null });
    expect(candidateQueueId({ current_version: 1, external_ref: 'queue-abc123-10426110', origin_queue_id: null }, null))
      .toEqual({ queue_id: 'abc123', reason: null });
    expect(candidateQueueId({ current_version: 1, external_ref: 'queue-abc123-1', origin_queue_id: 'zzz999' }, null))
      .toEqual({ queue_id: null, reason: 'not_confirmed' });
    expect(candidateQueueId({ current_version: 1, external_ref: 'manual-upload', origin_queue_id: null }, null))
      .toEqual({ queue_id: null, reason: 'no_trace' });
    // Version 2+ ignores both and trusts only the replace record.
    expect(candidateQueueId({ current_version: 3, external_ref: 'queue-abc123-1', origin_queue_id: 'abc123' }, null))
      .toEqual({ queue_id: null, reason: 'no_trace' });
    expect(candidateQueueId({ current_version: 3, external_ref: 'queue-abc123-1', origin_queue_id: 'abc123' }, 'new777'))
      .toEqual({ queue_id: 'new777', reason: null });
  });

  it('a document from another organization resolves nothing', async () => {
    const cert = await approveMultiLot('5554000');
    const res = await resolveWholeOriginals(db, files, seed.tenantId2, [cert.docIds[0]]);
    expect(res.get(cert.docIds[0])).toEqual({ state: 'not_split' });
  });
});

// ===========================================================================
// The tenant brand on an order send (migration 0140)
// ===========================================================================

describe('the tenant brand on an order send (migration 0140)', () => {
  async function setBrand(tenantId: string, cols: Record<string, string | null>): Promise<void> {
    const keys = Object.keys(cols);
    await db
      .prepare(`INSERT INTO tenant_brands (tenant_id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`)
      .bind(tenantId, ...keys.map((k) => cols[k]))
      .run();
  }
  const clearBrands = () => db.prepare('DELETE FROM tenant_brands').run();

  it('no brand record, while ANOTHER tenant has one: the order mail is the unbranded one', async () => {
    await clearBrands();
    await setBrand(seed.tenantId2, { display_name: 'OTHER-TENANT-BRAND', primary_color: '#7A1F5C', support_text: 'OTHER-TENANT-LINE' });
    const doc = await makeDocument({ lots: [{ number: '99100' }] });
    const order = await orderId();
    await pick(order, [doc.id]);
    const plan = await preview(order);
    expect(plan.from_name).toBe('Test Corp via SupDox');
    const mail = stubMail();
    await send(order, { fingerprint: plan.fingerprint });
    expect(mail[0].from).toBe('Test Corp via SupDox <noreply@supdox.com>');
    expect(mail[0].html).toContain(
      '<td style="background:#1A365D;padding:24px 32px;">\n        <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">Test Corp</h1>',
    );
    for (const leak of ['OTHER-TENANT-BRAND', 'OTHER-TENANT-LINE', '#7A1F5C', '<strong>', 'brand-logo']) {
      expect(mail[0].html).not.toContain(leak);
    }
    await clearBrands();
  });

  it('carries the display name, the colours and the ORDER support line -- in the mail and on the oversize-file page', async () => {
    await clearBrands();
    await setBrand(seed.tenantId, {
      display_name: 'Northfield Foods',
      primary_color: '#0B6E4F',
      accent_color: '#F2A900',
      support_text: 'DEFAULT-LINE',
      support_overrides: JSON.stringify({
        order_send: { text: 'Order desk', email: 'orders@northfield.example', phone: '555 0142' },
        document_export: { text: 'EXPORT-ONLY-LINE', email: null, phone: null },
      }),
    });
    await setBrand(seed.tenantId2, { display_name: 'OTHER-TENANT-BRAND', support_text: 'OTHER-TENANT-LINE' });

    const big = await makeDocument({ size: 16 * MB, lots: [{ number: '99201' }] });
    const small = await makeDocument({ lots: [{ number: '99202' }] });
    const order = await orderId({ po_number: 'PO-77' });
    await pick(order, [big.id, small.id]);

    // The review screen shows what will really be sent.
    const plan = await preview(order);
    expect(plan.from_name).toBe('Northfield Foods via SupDox');
    expect(plan.default_subject.startsWith('Northfield Foods: documents for order')).toBe(true);
    expect(plan.reply_to).toBe('user@test.com');

    const mail = stubMail();
    const { status } = await send(order, { fingerprint: plan.fingerprint, message: 'For your delivery.' });
    expect(status).toBe(200);
    const m = mail[0];
    // The address and the reply-to never move; only the name in front does.
    expect(m.from).toBe('Northfield Foods via SupDox <noreply@supdox.com>');
    expect(m.reply_to).toBe('user@test.com');
    expect(m.subject.startsWith('Northfield Foods: documents for order')).toBe(true);
    expect(m.html).toContain('<td style="background:#0B6E4F;padding:24px 32px;border-bottom:4px solid #F2A900;">');
    expect(m.html).toContain('font-weight:600;">Northfield Foods</h1>');
    expect(m.html).toContain('background:#0B6E4F;color:#ffffff;');
    expect(m.html).toContain('border-left:3px solid #F2A900;');
    expect(m.html).toContain(
      '<strong>Northfield Foods</strong> &middot; Order desk &middot; <a href="mailto:orders@northfield.example" style="color:#666666;">orders@northfield.example</a> &middot; 555 0142',
    );
    for (const leak of ['DEFAULT-LINE', 'EXPORT-ONLY-LINE', 'OTHER-TENANT-BRAND', 'OTHER-TENANT-LINE', 'Test Corp', '#1A365D']) {
      expect(m.html).not.toContain(leak);
    }
    // Nothing internal rides along with the brand.
    expect(JSON.stringify(m)).not.toContain('INTERNAL do not send');

    // The page behind the "too large to attach" link is an order page: the
    // order line, not the document-export one.
    const token = /\/export\/([A-Za-z0-9_-]+)/.exec(m.html)![1];
    const landing = await exportLanding(
      fnContext(`http://localhost/api/document-exports/public/${token}`, { params: { token } }),
    );
    const view = (await readJson(landing)) as DocumentExportLandingView;
    expect(view.brand).toEqual({
      display_name: 'Northfield Foods',
      logo_url: null,
      primary_color: '#0B6E4F',
      accent_color: '#F2A900',
      support: { text: 'Order desk', email: 'orders@northfield.example', phone: '555 0142' },
    });
    expect(JSON.stringify(view)).not.toContain('EXPORT-ONLY-LINE');
    expect(JSON.stringify(view)).not.toContain('OTHER-TENANT');
    await clearBrands();
  });
});
