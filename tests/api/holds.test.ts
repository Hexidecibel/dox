/**
 * Holds (decision C-005; C-071..C-082; migration 0139).
 *
 * What is pinned:
 *
 *   1. WHO. Any login but a read-only one places a hold, and so does an API
 *      key. Only a QA releaser or an administrator, signed in, releases one.
 *      A reason is required both ways. Another organization's ids are 404.
 *   2. APPEND-ONLY. No route edits or deletes a hold, and the database refuses
 *      an edit.
 *   3. EVERY EXIT. A held certificate does not leave by ZIP, emailed link, a
 *      link minted before the hold, bundle, order send or resend, document
 *      order line, QA release, or API key -- for anybody, a QA releaser and an
 *      administrator included. A logged-in person still opens it.
 *   4. AUTOMATIC HOLDS at approval, once per judged result, and QA told once.
 *   5. Replacing the file does not lift a hold.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { unzipSync, strFromU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { seedTestData, generateTestId } from '../helpers/db';
import { fnContext, queuePut, readJson } from '../helpers/requests';
import type { TestUser } from '../helpers/requests';
import * as documentHoldsRoute from '../../functions/api/documents/[id]/holds';
import * as holdsIndexRoute from '../../functions/api/holds/index';
import * as holdReleaseRoute from '../../functions/api/holds/[id]/release';
import { onRequestGet as getDocument } from '../../functions/api/documents/[id]';
import { onRequestGet as downloadDocument } from '../../functions/api/documents/[id]/download';
import { onRequestPost as uploadVersion } from '../../functions/api/documents/[id]/upload';
import { onRequestPost as exportZip } from '../../functions/api/document-exports/zip';
import { onRequestPost as exportSend } from '../../functions/api/document-exports/send';
import { onRequestGet as exportLanding } from '../../functions/api/document-exports/public/[token]';
import { onRequestGet as exportLandingZip } from '../../functions/api/document-exports/public/[token]/download';
import { onRequestGet as exportLandingFile } from '../../functions/api/document-exports/public/[token]/file/[index]';
import { onRequestGet as bundleDownload } from '../../functions/api/bundles/[id]/download';
import { onRequestGet as getQueueFile } from '../../functions/api/queue/[id]/file';
import { onRequestPost as processPost } from '../../functions/api/documents/process';
import { onRequestPost as createOrder } from '../../functions/api/orders/index';
import { onRequestGet as getOrder } from '../../functions/api/orders/[id]';
import { onRequestPost as addItems } from '../../functions/api/orders/[id]/items/index';
import { onRequestPost as addDocuments } from '../../functions/api/orders/[id]/documents/index';
import { onRequestPost as releaseBatch } from '../../functions/api/orders/[id]/documents/release';
import { onRequestGet as pendingList } from '../../functions/api/order-documents/pending';
import { onRequestGet as sendPreview } from '../../functions/api/orders/[id]/send-preview';
import { onRequestPost as sendOrder } from '../../functions/api/orders/[id]/send';
import { onRequestPost as resendOrder } from '../../functions/api/orders/[id]/sends/[sendId]/resend';
import { onRequestPost as searchQuery } from '../../functions/api/search/query';
import { produceCoaRecords } from '../../functions/lib/kinds/coa';
import { attachActiveHolds } from '../../functions/lib/hold-state';
import { registerAndNotifyForApproval } from '../../functions/lib/spec-register';
import { loadSpecConfig, specResultsWithConfig } from '../../functions/lib/spec-warnings';
import { HOLD_OUTWARD_TEXT } from '../../shared/holds';
import { HOLDING_SPEC_CRITICALITY } from '../../shared/specCriticality';
import type { CoaRecordsPayload } from '../../shared/coaRecords';
import type { QueueItem } from '../../functions/lib/queue-approve';
import type { SpecVerdict, ConfiguredLimit } from '../../shared/specCheck';
import type {
  ApiDocumentHold,
  DocumentExportLandingView,
  DocumentHoldsResponse,
  DocumentHoldState,
  HoldsListResponse,
  OrderDocumentsAddResponse,
  OrderDocumentsReleaseResponse,
  OrderGetResponse,
  OrderSendPreview,
  OrderSendResponse,
  PendingOrderDocumentsResponse,
  QueuedResponse,
  SharingRuleRefusedResponse,
} from '../../shared/types';

const db = env.DB;
const files = env.FILES;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let supplierId = '';
let customerId = '';
let qaUserId = '';
let qaEmail = '';
const types = { coa: '', qa: '', spec: '' };

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
      return { id: seed.orgAdmin2Id, email: 'orgadmin2@test.com', name: 'Other Admin', role: 'org_admin', tenant_id: seed.tenantId2 };
  }
}

/** The API key is the ORG ADMIN's: a key releases nothing whoever owns it. */
function as(who: Who, url: string, init: RequestInit & { params?: Record<string, string> } = {}): never {
  const ctx = fnContext(url, { ...init, user: who === 'api_key' ? person('org_admin') : person(who) }) as any;
  ctx.data.authMethod = who === 'api_key' ? 'api_key' : 'jwt';
  if (who === 'api_key') ctx.data.apiKeyId = 'key-under-test';
  return ctx as never;
}

async function call<T>(
  handler: (ctx: never) => Response | Promise<Response>,
  ctx: never,
): Promise<{ status: number; body: T & { error?: string; code?: string } }> {
  const res = await handler(ctx);
  return { status: res.status, body: (await readJson(res)) as T & { error?: string; code?: string } };
}

interface MadeDoc {
  id: string;
  title: string;
  body: string;
  lotIds: string[];
}

let lotCounter = 880000;

async function makeLot(documentId: string, lotNumber: string, productId: string | null = null): Promise<string> {
  const lotId = generateTestId();
  await db
    .prepare(
      `INSERT INTO lots (id, tenant_id, supplier_id, product_id, lot_number, lot_key, sub_lot_code)
       VALUES (?, ?, ?, ?, ?, ?, '')`,
    )
    .bind(lotId, seed.tenantId, supplierId, productId, lotNumber, `${lotNumber}-${lotId.slice(0, 4)}`)
    .run();
  await db.prepare('INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)').bind(generateTestId(), documentId, lotId).run();
  return lotId;
}

async function makeDocument(
  typeId: string | null,
  title: string,
  opts: { lots?: number; tenantId?: string; products?: string[] } = {},
): Promise<MadeDoc> {
  const id = generateTestId();
  const tenantId = opts.tenantId ?? seed.tenantId;
  const own = tenantId === seed.tenantId;
  const body = `PDF-BYTES-${title}-${id}`;
  await db
    .prepare(
      `INSERT INTO documents
         (id, tenant_id, title, tags, current_version, status, created_by, supplier_id, document_type_id,
          approved_at, created_at)
       VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, ?, '2026-06-01 09:00:00', '2026-06-01 09:00:00')`,
    )
    .bind(id, tenantId, title, own ? seed.orgAdminId : seed.orgAdmin2Id, own ? supplierId : null, own ? typeId : null)
    .run();
  const key = `docs/${id}/v1.pdf`;
  await db
    .prepare(
      `INSERT INTO document_versions
         (id, document_id, version_number, file_name, file_size, mime_type, r2_key, uploaded_by)
       VALUES (?, ?, 1, ?, ?, 'application/pdf', ?, ?)`,
    )
    .bind(generateTestId(), id, `internal name ${id.slice(0, 6)}.pdf`, body.length, key, own ? seed.orgAdminId : seed.orgAdmin2Id)
    .run();
  await files.put(key, new TextEncoder().encode(body));
  const lotIds: string[] = [];
  for (let i = 0; i < (opts.lots ?? 0); i++) lotIds.push(await makeLot(id, String(lotCounter++)));
  for (const productId of opts.products ?? []) {
    await db.prepare('INSERT INTO document_products (id, document_id, product_id) VALUES (?, ?, ?)').bind(generateTestId(), id, productId).run();
  }
  return { id, title, body, lotIds };
}

function unzip(buf: ArrayBuffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(unzipSync(new Uint8Array(buf)))) out[name] = strFromU8(bytes);
  return out;
}

async function audits(action: string, resourceId?: string): Promise<{ user_id: string | null; resource_id: string | null; details: any }[]> {
  const res = await db
    .prepare('SELECT user_id, resource_id, details FROM audit_log WHERE action = ? ORDER BY id DESC')
    .bind(action)
    .all<{ user_id: string | null; resource_id: string | null; details: string }>();
  return (res.results ?? [])
    .map((r) => ({ ...r, details: JSON.parse(r.details) }))
    .filter((r) => !resourceId || r.resource_id === resourceId);
}

interface CapturedMail {
  to: string[];
  subject: string;
  html: string;
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
      }
      return new Response('{}', { status: 200 });
    }),
  );
  return sent;
}

function tokenFrom(mails: CapturedMail[]): string {
  const m = /\/export\/([A-Za-z0-9_-]{20,})/.exec(mails.map((x) => x.html).join('\n'));
  if (!m) throw new Error('no export link in the captured mail');
  return m[1];
}

const holdMails = (mails: CapturedMail[]) => mails.filter((m) => /on hold|was put on hold/.test(m.subject));

// --- the hold routes -------------------------------------------------------

async function place(who: Who, documentId: string, body: unknown) {
  return call<{ hold: ApiDocumentHold }>(
    documentHoldsRoute.onRequestPost,
    as(who, `http://localhost/api/documents/${documentId}/holds`, {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      params: { id: documentId },
    }),
  );
}

async function holdsOf(who: Who, documentId: string) {
  return call<DocumentHoldsResponse>(
    documentHoldsRoute.onRequestGet,
    as(who, `http://localhost/api/documents/${documentId}/holds`, { params: { id: documentId } }),
  );
}

async function release(who: Who, holdId: string, body: unknown) {
  return call<{ hold: ApiDocumentHold }>(
    holdReleaseRoute.onRequestPost,
    as(who, `http://localhost/api/holds/${holdId}/release`, { method: 'POST', body: JSON.stringify(body), params: { id: holdId } }),
  );
}

async function listHolds(who: Who, qs = '') {
  return call<HoldsListResponse & { count?: number }>(holdsIndexRoute.onRequestGet, as(who, `http://localhost/api/holds${qs}`));
}

/** A hold placed by the QA lead (so no notice is mailed), returned by id. */
async function hold(documentId: string, reason = 'Retest pending', lotId?: string): Promise<string> {
  const { status, body } = await place('qa', documentId, { reason, ...(lotId ? { lot_id: lotId } : {}) });
  expect(status, JSON.stringify(body)).toBe(201);
  return body.hold.id;
}

async function lift(holdId: string): Promise<void> {
  const { status } = await release('qa', holdId, { reason: 'Retest came back clean' });
  expect(status).toBe(200);
}

beforeAll(async () => {
  seed = await seedTestData(db);

  supplierId = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(supplierId, seed.tenantId, 'Northfield Creamery', `northfield-${supplierId.slice(0, 5)}`)
    .run();

  types.coa = generateTestId();
  types.qa = generateTestId();
  types.spec = generateTestId();
  await db
    .prepare(`INSERT INTO document_types (id, tenant_id, name, slug, sharing_rule, renewal_policy) VALUES (?, ?, ?, ?, 'free', 'none')`)
    .bind(types.coa, seed.tenantId, 'Certificate of Analysis', `coa-${types.coa.slice(0, 5)}`)
    .run();
  await db
    .prepare(`INSERT INTO document_types (id, tenant_id, name, slug, sharing_rule) VALUES (?, ?, ?, ?, 'qa')`)
    .bind(types.qa, seed.tenantId, 'Letter of Guarantee', `log-${types.qa.slice(0, 5)}`)
    .run();
  await db
    .prepare(`INSERT INTO document_types (id, tenant_id, name, slug, sharing_rule) VALUES (?, ?, ?, ?, 'free')`)
    .bind(types.spec, seed.tenantId, 'Specification Sheet', `spec-${types.spec.slice(0, 5)}`)
    .run();

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
       VALUES (?, ?, ?, 'Harbor Bakery', 'buyer@harbor.example', datetime('now'), datetime('now'))`,
    )
    .bind(customerId, seed.tenantId, `C-${customerId.slice(0, 6)}`)
    .run();
}, 30_000);

afterEach(async () => {
  vi.unstubAllGlobals();
  await db.prepare(`DELETE FROM rate_limits`).run();
});

// ===========================================================================
// Who places, who releases
// ===========================================================================

describe('placing a hold', () => {
  it('a read-only account cannot; a user, the QA lead, an administrator and an API key can', async () => {
    const doc = await makeDocument(types.coa, 'Cream COA', { lots: 3 });
    stubMail();
    expect((await place('reader', doc.id, { reason: 'I think so' })).status).toBe(403);

    for (const [i, who] of (['user', 'qa', 'org_admin'] as Who[]).entries()) {
      const { status, body } = await place(who, doc.id, { reason: `Placed by ${who}`, lot_id: doc.lotIds[i] });
      expect(status, who).toBe(201);
      expect(body.hold).toMatchObject({ source: 'person', active: true, lot_id: doc.lotIds[i], reason: `Placed by ${who}`, placed_by: person(who as 'user').id });
    }
    // An API key places too (it only tightens), as the user it belongs to.
    const viaKey = await place('api_key', doc.id, { reason: 'Flagged by the lab system' });
    expect(viaKey.status).toBe(201);
    expect(viaKey.body.hold).toMatchObject({ lot_id: null, lot_label: null, placed_by: seed.orgAdminId });

    const rows = await audits('document.hold_placed', doc.id);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.details.via).sort()).toEqual(['api_key', 'portal', 'portal', 'portal']);
    expect(rows.find((r) => r.details.via === 'api_key')!.details.api_key_id).toBe('key-under-test');
  });

  it('a reason is required, and is trimmed', async () => {
    const doc = await makeDocument(types.coa, 'Reason COA');
    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 7 }]) {
      const r = await place('user', doc.id, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error).toMatch(/why/i);
    }
    expect((await place('user', doc.id, 'not json')).status).toBe(400);
    stubMail();
    expect((await place('user', doc.id, { reason: '  Complaint under review  ' })).body.hold.reason).toBe('Complaint under review');
  });

  it('the lot must be a lot row of THIS certificate, and one lot carries one person hold at a time', async () => {
    const doc = await makeDocument(types.coa, 'Two lot COA', { lots: 2 });
    const other = await makeDocument(types.coa, 'Other COA', { lots: 1 });
    expect((await place('qa', doc.id, { reason: 'x', lot_id: other.lotIds[0] })).status).toBe(400);
    expect((await place('qa', doc.id, { reason: 'x', lot_id: 'no-such-lot' })).status).toBe(400);
    expect((await place('qa', doc.id, { reason: 'x', lot_id: 42 })).status).toBe(400);

    const first = await place('qa', doc.id, { reason: 'First', lot_id: doc.lotIds[0] });
    expect(first.status).toBe(201);
    const again = await place('org_admin', doc.id, { reason: 'Second', lot_id: doc.lotIds[0] });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already on hold/);
    // The other lot, and the whole certificate, are separate things to hold.
    expect((await place('qa', doc.id, { reason: 'Other lot', lot_id: doc.lotIds[1] })).status).toBe(201);
    expect((await place('qa', doc.id, { reason: 'Whole' })).status).toBe(201);
    expect((await place('qa', doc.id, { reason: 'Whole again' })).status).toBe(409);
    // Once released, the lot can be held again.
    await lift(first.body.hold.id);
    expect((await place('qa', doc.id, { reason: 'Held again', lot_id: doc.lotIds[0] })).status).toBe(201);
  });

  it("another organization's document is a 404 on every verb, before anything else is checked", async () => {
    const theirs = await makeDocument(null, 'Their COA', { tenantId: seed.tenantId2 });
    expect((await holdsOf('org_admin', theirs.id)).status).toBe(404);
    expect((await place('org_admin', theirs.id, { reason: 'x' })).status).toBe(404);
    // Even a body that would be a 400 here.
    expect((await place('org_admin', theirs.id, {})).status).toBe(404);
    expect((await place('reader', theirs.id, { reason: 'x' })).status).toBe(404);
    expect((await holdsOf('user', 'no-such-document')).status).toBe(404);
    const n = await db.prepare('SELECT COUNT(*) AS n FROM document_holds WHERE document_id = ?').bind(theirs.id).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it('tells the QA route once, unless the person placing it is QA', async () => {
    const doc = await makeDocument(types.coa, 'Notice COA');
    let mails = stubMail();
    const byUser = await place('user', doc.id, { reason: 'Customer complaint under review' });
    expect(holdMails(mails)).toHaveLength(1);
    expect(mails[0].to).toEqual([qaEmail]);
    expect(mails[0].html).toContain('Customer complaint under review');
    expect(mails[0].html).toContain('Regular User put Notice COA');
    const stamped = await db.prepare('SELECT qa_notified_at FROM document_holds WHERE id = ?').bind(byUser.body.hold.id).first<{ qa_notified_at: string | null }>();
    expect(stamped!.qa_notified_at).toBeTruthy();
    await lift(byUser.body.hold.id);

    // QA and an administrator placing one tell nobody.
    for (const who of ['qa', 'org_admin'] as Who[]) {
      vi.unstubAllGlobals();
      mails = stubMail();
      const r = await place(who, doc.id, { reason: `By ${who}` });
      expect(mails).toHaveLength(0);
      await lift(r.body.hold.id);
    }
    // A key is never QA, even an administrator's.
    vi.unstubAllGlobals();
    mails = stubMail();
    await place('api_key', doc.id, { reason: 'From the lab system' });
    expect(holdMails(mails)).toHaveLength(1);
  });

  it('with nobody on the QA route it is a routing gap: audited, and the administrators are told so', async () => {
    const theirs = await makeDocument(null, 'Unrouted COA', { tenantId: seed.tenantId2 });
    const plainId = generateTestId();
    await db
      .prepare(
        `INSERT INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
         VALUES (?, ?, 'Plain Two', 'user', ?, 'x', 1, 0)`,
      )
      .bind(plainId, `${plainId.slice(0, 8)}@two.test`, seed.tenantId2)
      .run();
    const mails = stubMail();
    const ctx = fnContext(`http://localhost/api/documents/${theirs.id}/holds`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Odd smell reported' }),
      params: { id: theirs.id },
      user: { id: plainId, email: 'plain@two.test', name: 'Plain Two', role: 'user', tenant_id: seed.tenantId2 },
    }) as any;
    ctx.data.authMethod = 'jwt';
    const res = await documentHoldsRoute.onRequestPost(ctx as never);
    expect(res.status).toBe(201);
    const holdId = ((await readJson(res)) as { hold: ApiDocumentHold }).hold.id;

    const gap = await audits('document.hold_placed.routing_gap', theirs.id);
    expect(gap).toHaveLength(1);
    expect(gap[0].details).toMatchObject({ owner_label: 'QA', hold_ids: [holdId] });
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toMatch(/no QA owner is set\. Nobody was alerted/);
    // A notice to administrators is not "QA was told".
    const row = await db.prepare('SELECT qa_notified_at FROM document_holds WHERE id = ?').bind(holdId).first<{ qa_notified_at: string | null }>();
    expect(row!.qa_notified_at).toBeNull();
  });
});

describe('releasing a hold', () => {
  it('only a QA releaser or an administrator, signed in: not a reader, a user or an API key', async () => {
    const doc = await makeDocument(types.coa, 'Release COA', { lots: 2 });
    const a = await hold(doc.id, 'First', doc.lotIds[0]);
    const b = await hold(doc.id, 'Second', doc.lotIds[1]);

    for (const who of ['reader', 'user', 'api_key'] as Who[]) {
      const r = await release(who, a, { reason: 'Looks fine' });
      expect(r.status, who).toBe(403);
    }
    expect((await holdsOf('user', doc.id)).body.active).toHaveLength(2);

    const byQa = await release('qa', a, { reason: 'Retest clean' });
    expect(byQa.status).toBe(200);
    expect(byQa.body.hold).toMatchObject({ active: false, released_by: qaUserId, release_reason: 'Retest clean', released_by_name: 'Quality Lead' });
    expect(byQa.body.hold.released_at).toBeTruthy();
    expect((await release('org_admin', b, { reason: 'Supplier confirmed' })).status).toBe(200);

    const rows = await audits('document.hold_released', doc.id);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.details.hold_id === a)!).toMatchObject({
      user_id: qaUserId,
      details: { hold_reason: 'First', release_reason: 'Retest clean', source: 'person', lot_id: doc.lotIds[0] },
    });
  });

  it('a reason is required, and a hold is released once', async () => {
    const doc = await makeDocument(types.coa, 'Once COA');
    const id = await hold(doc.id);
    for (const body of [{}, { reason: '' }, { reason: '  ' }]) {
      expect((await release('qa', id, body)).status).toBe(400);
    }
    expect((await holdsOf('qa', doc.id)).body.active).toHaveLength(1);
    expect((await release('qa', id, { reason: 'Clean' })).status).toBe(200);
    const again = await release('org_admin', id, { reason: 'Again' });
    expect(again.status).toBe(409);
    const row = await db.prepare('SELECT released_by, release_reason FROM document_holds WHERE id = ?').bind(id).first<Record<string, string>>();
    expect(row).toEqual({ released_by: qaUserId, release_reason: 'Clean' });
  });

  it("another organization's hold is a 404, for its administrator and for anybody", async () => {
    const doc = await makeDocument(types.coa, 'Foreign release COA');
    const id = await hold(doc.id);
    expect((await release('other_tenant', id, { reason: 'x' })).status).toBe(404);
    expect((await release('org_admin', 'no-such-hold', { reason: 'x' })).status).toBe(404);
    expect((await holdsOf('other_tenant', doc.id)).status).toBe(404);
    expect((await place('other_tenant', doc.id, { reason: 'x' })).status).toBe(404);
    expect((await holdsOf('qa', doc.id)).body.active).toHaveLength(1);
  });
});

describe('a hold is append-only', () => {
  it('no route edits or deletes one', () => {
    for (const mod of [documentHoldsRoute, holdsIndexRoute, holdReleaseRoute] as Record<string, unknown>[]) {
      for (const verb of ['onRequestPut', 'onRequestPatch', 'onRequestDelete', 'onRequest']) {
        expect(mod[verb], verb).toBeUndefined();
      }
    }
    expect(Object.keys(holdsIndexRoute)).toEqual(['onRequestGet']);
    expect(Object.keys(holdReleaseRoute)).toEqual(['onRequestPost']);
  });

  it('the database refuses an edit, and a second release', async () => {
    const doc = await makeDocument(types.coa, 'Immutable COA');
    const id = await hold(doc.id, 'The original reason');
    await expect(db.prepare(`UPDATE document_holds SET reason = 'rewritten' WHERE id = ?`).bind(id).run()).rejects.toThrow(/append-only/);
    await expect(db.prepare(`UPDATE document_holds SET source = 'spec_critical', source_key = 'k' WHERE id = ?`).bind(id).run()).rejects.toThrow();
    await expect(db.prepare(`UPDATE document_holds SET placed_at = '2020-01-01' WHERE id = ?`).bind(id).run()).rejects.toThrow(/append-only/);
    // A release with no reason, or with no person, is not a release.
    await expect(db.prepare(`UPDATE document_holds SET released_at = datetime('now') WHERE id = ?`).bind(id).run()).rejects.toThrow();
    await lift(id);
    await expect(db.prepare(`UPDATE document_holds SET release_reason = 'changed my mind' WHERE id = ?`).bind(id).run()).rejects.toThrow(/append-only/);
    await expect(
      db.prepare(`UPDATE document_holds SET released_at = NULL, released_by = NULL, release_reason = NULL WHERE id = ?`).bind(id).run(),
    ).rejects.toThrow(/append-only/);
    const row = await db.prepare('SELECT reason, release_reason FROM document_holds WHERE id = ?').bind(id).first();
    expect(row).toEqual({ reason: 'The original reason', release_reason: 'Retest came back clean' });
  });
});

describe('reading holds', () => {
  it('the document, its holds page and the organization list all say the same thing', async () => {
    const productId = generateTestId();
    await db
      .prepare(`INSERT INTO products (id, tenant_id, name, slug, created_at, updated_at) VALUES (?, ?, 'Sweet Cream Butter', ?, datetime('now'), datetime('now'))`)
      .bind(productId, seed.tenantId, `p-${productId.slice(0, 8)}`)
      .run();
    const doc = await makeDocument(types.coa, 'Listed COA', { lots: 2, products: [productId] });
    const released = await hold(doc.id, 'Earlier concern', doc.lotIds[0]);
    await lift(released);
    const active = await hold(doc.id, 'Open concern', doc.lotIds[1]);

    const page = (await holdsOf('reader', doc.id)).body;
    expect(page.active.map((h) => h.id)).toEqual([active]);
    expect(page.history.map((h) => h.id)).toEqual([released]);
    expect(page.lots.map((l) => [l.lot_id, l.hold?.id ?? null])).toEqual([
      [doc.lotIds[0], null],
      [doc.lotIds[1], active],
    ]);
    expect(page).toMatchObject({ can_place: false, can_release: false });
    expect((await holdsOf('user', doc.id)).body).toMatchObject({ can_place: true, can_release: false });
    expect((await holdsOf('qa', doc.id)).body).toMatchObject({ can_place: true, can_release: true });
    expect((await holdsOf('api_key', doc.id)).body).toMatchObject({ can_place: true, can_release: false });

    const got = await call<{ document: { holds: DocumentHoldState } }>(
      getDocument,
      as('org_admin', `http://localhost/api/documents/${doc.id}`, { params: { id: doc.id } }),
    );
    expect(got.body.document.holds.active.map((h) => h.id)).toEqual([active]);
    expect(got.body.document.holds).toMatchObject({ can_place: true, can_release: true });

    const list = (await listHolds('reader')).body;
    expect(list.can_release).toBe(false);
    const row = list.holds.find((h) => h.id === active)!;
    expect(row).toMatchObject({
      document_id: doc.id,
      document_title: 'Listed COA',
      document_type_name: 'Certificate of Analysis',
      supplier_name: 'Northfield Creamery',
      product_names: ['Sweet Cream Butter'],
      reason: 'Open concern',
      active: true,
    });
    expect(list.holds.every((h) => h.active)).toBe(true);
    expect((await listHolds('qa')).body.can_release).toBe(true);

    // Filters.
    const ids = async (qs: string) => (await listHolds('qa', qs)).body.holds.map((h) => h.id);
    expect(await ids('?state=released')).toContain(released);
    expect(await ids('?state=released')).not.toContain(active);
    expect(await ids('?state=all')).toEqual(expect.arrayContaining([active, released]));
    expect(await ids(`?product_id=${productId}`)).toEqual([active]);
    expect(await ids(`?supplier_id=${supplierId}`)).toContain(active);
    expect(await ids('?supplier_id=nobody')).toEqual([]);
    expect(await ids('?source=person')).toContain(active);
    expect(await ids('?source=spec_critical')).not.toContain(active);
    expect((await listHolds('qa', '?state=sometimes')).status).toBe(400);
    expect((await listHolds('qa', '?source=whim')).status).toBe(400);

    // The count is the number of ACTIVE holds, and is one cheap answer.
    const count = (await listHolds('user', '?count=1')).body;
    const n = await db.prepare('SELECT COUNT(*) AS n FROM document_holds WHERE tenant_id = ? AND released_at IS NULL').bind(seed.tenantId).first<{ n: number }>();
    expect(count).toEqual({ count: n!.n });

    // Another organization sees none of it.
    const theirs = (await listHolds('other_tenant', '?state=all')).body;
    expect(theirs.holds.map((h) => h.id)).not.toContain(active);
  });

  it('a search result row says the certificate is on hold, and search itself does not move', async () => {
    const doc = await makeDocument(types.coa, 'Zymurgy searchable hold COA');
    const run = async () =>
      call<{ documents: { id: string; active_hold?: { id: string; reason: string } }[]; total: number }>(
        searchQuery,
        as('user', 'http://localhost/api/search/query', {
          method: 'POST',
          body: JSON.stringify({ query: { text: 'Zymurgy searchable', clauses: [], view: {} } }),
        }),
      );
    // The marking itself, on a plain list: only the held row gains a key.
    const other = await makeDocument(types.coa, 'Unheld neighbour COA');
    const rows: { id: string; active_hold?: unknown }[] = [{ id: doc.id }, { id: other.id }, { id: 'not-a-document' }];
    await attachActiveHolds(db, seed.tenantId, rows);
    expect(rows).toEqual([{ id: doc.id }, { id: other.id }, { id: 'not-a-document' }]);

    const before = await run();
    expect(before.status).toBe(200);
    const id = await hold(doc.id, 'Shown on the row');
    await attachActiveHolds(db, seed.tenantId, rows);
    expect(rows[0].active_hold).toMatchObject({ id, reason: 'Shown on the row' });
    expect('active_hold' in rows[1]).toBe(false);
    // Another organization's caller marks nothing.
    const foreign: { id: string; active_hold?: unknown }[] = [{ id: doc.id }];
    await attachActiveHolds(db, seed.tenantId2, foreign);
    expect(foreign).toEqual([{ id: doc.id }]);

    const hit = before.body.documents.find((d) => d.id === doc.id);
    if (!hit) return; // The full-text index is not populated in this harness.
    expect('active_hold' in hit).toBe(false);
    const after = await run();
    expect(after.body.total).toBe(before.body.total);
    expect(after.body.documents.map((d) => d.id)).toEqual(before.body.documents.map((d) => d.id));
    expect(after.body.documents.find((d) => d.id === doc.id)!.active_hold).toMatchObject({ id, reason: 'Shown on the row' });
  });
});

// ===========================================================================
// Every exit
// ===========================================================================

describe('a held certificate through every exit', () => {
  it('a logged-in person still opens it; an API key does not', async () => {
    const doc = await makeDocument(types.coa, 'Download COA');
    const get = (who: Who) =>
      downloadDocument(as(who, `http://localhost/api/documents/${doc.id}/download`, { params: { id: doc.id } }));
    expect((await get('api_key')).status).toBe(200);
    const id = await hold(doc.id, 'Retest pending');

    for (const who of ['reader', 'user', 'qa', 'org_admin'] as Who[]) {
      const res = await get(who);
      expect(res.status, who).toBe(200);
      expect(await res.text()).toBe(doc.body);
    }
    const refused = await get('api_key');
    expect(refused.status).toBe(403);
    expect(await readJson(refused)).toMatchObject({ code: 'sharing_rule_refused', reason: 'held', error: 'On hold: Retest pending' });
    expect((await audits('document.sharing_rule_refused', doc.id))[0].details).toMatchObject({ via: 'api_key', reason: 'held', hold_id: id });

    await lift(id);
    expect((await get('api_key')).status).toBe(200);
  });

  it('the queue file route: an API key is refused the approved original of a held certificate', async () => {
    const queueId = generateTestId();
    const r2Key = `pending/${queueId}.pdf`;
    await files.put(r2Key, new TextEncoder().encode('%PDF-1.4 the whole original'));
    await db
      .prepare(
        `INSERT INTO processing_queue
           (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type,
            processing_status, output_kind, status, created_by, created_at)
         VALUES (?, ?, ?, ?, 'orig.pdf', 20, 'application/pdf', 'ready', 'coa', 'approved', ?, datetime('now'))`,
      )
      .bind(queueId, seed.tenantId, types.coa, r2Key, seed.userId)
      .run();
    const doc = await makeDocument(types.coa, 'Queue file COA');
    await db.prepare(`UPDATE documents SET external_ref = ?, origin_queue_id = ? WHERE id = ?`).bind(`queue-${queueId}`, queueId, doc.id).run();
    const get = (who: Who) => getQueueFile(as(who, `http://localhost/api/queue/${queueId}/file`, { params: { id: queueId } }));

    const ok = await get('api_key');
    expect(ok.status).toBe(200);
    await ok.text();
    const id = await hold(doc.id);
    const refused = await get('api_key');
    expect(refused.status).toBe(403);
    expect(await readJson(refused)).toMatchObject({ code: 'sharing_rule_refused', reason: 'held' });
    const reviewer = await get('user');
    expect(reviewer.status).toBe(200);
    await reviewer.text();
    await lift(id);
    const again = await get('api_key');
    expect(again.status).toBe(200);
    await again.text();
  });

  it.each(['user', 'qa', 'org_admin', 'api_key'] as Who[])(
    '%s: a ZIP leaves the held one out and says so; the archive never carries the reason',
    async (who) => {
      const held = await makeDocument(types.coa, 'Held COA');
      const free = await makeDocument(types.coa, 'Clean COA');
      const id = await hold(held.id, 'Critical coliform result under review');
      const res = await exportZip(
        as(who, 'http://localhost/api/document-exports/zip', { method: 'POST', body: JSON.stringify({ document_ids: [held.id, free.id] }) }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('X-Export-Refused-Ids')).toBe(`${held.id}:held`);
      const zip = unzip(await res.arrayBuffer());
      const bodies = Object.entries(zip).filter(([n]) => n !== 'manifest.csv').map(([, b]) => b);
      expect(bodies).toEqual([free.body]);
      expect(zip['manifest.csv']).toContain('"Not included"');
      expect(zip['manifest.csv']).toContain(HOLD_OUTWARD_TEXT);
      // The reason is an internal note. It stays in the portal.
      expect(zip['manifest.csv']).not.toContain('coliform');

      // Nothing but the held one: a 403 that names it and says why.
      const only = await exportZip(
        as(who, 'http://localhost/api/document-exports/zip', { method: 'POST', body: JSON.stringify({ document_ids: [held.id] }) }),
      );
      expect(only.status).toBe(403);
      const body = (await readJson(only)) as SharingRuleRefusedResponse;
      expect(body.code).toBe('sharing_rule_refused');
      expect(body.error).toContain('On hold: Held COA');
      expect(body.refused[0]).toMatchObject({ reason: 'held', message: 'On hold: Critical coliform result under review', hold: { id } });
      // Sending it was NOT a release, for anybody.
      expect((await holdsOf('qa', held.id)).body.active).toHaveLength(1);
      expect((await audits('document.qa_release_approved')).filter((r) => (r.details.document_ids as string[]).includes(held.id))).toEqual([]);
    },
  );

  it('an emailed link carries only what may go; with nothing left, nothing is minted or mailed', async () => {
    const held = await makeDocument(types.qa, 'Held guarantee');
    const free = await makeDocument(types.coa, 'Clean COA two');
    await hold(held.id, 'Supplier dispute');
    const send = (who: Who, ids: string[]) =>
      call<{ document_count: number; refused: { document_id: string; reason: string }[] } & SharingRuleRefusedResponse>(
        exportSend,
        as(who, 'http://localhost/api/document-exports/send', { method: 'POST', body: JSON.stringify({ document_ids: ids, recipients: ['buyer@harbor.example'] }) }),
      );
    const mails = stubMail();
    // An administrator could release a `qa` document by sending it. Not a held one.
    const mixed = await send('org_admin', [held.id, free.id]);
    expect(mixed.status).toBe(200);
    expect(mixed.body.document_count).toBe(1);
    expect(mixed.body.refused.map((r) => [r.document_id, r.reason])).toEqual([[held.id, 'held']]);
    const link = await db.prepare('SELECT document_ids FROM document_export_links WHERE token = ?').bind(tokenFrom(mails)).first<{ document_ids: string }>();
    expect(JSON.parse(link!.document_ids)).toEqual([free.id]);

    const before = await db.prepare('SELECT COUNT(*) AS n FROM document_export_links').first<{ n: number }>();
    const sentBefore = mails.length;
    const nothing = await send('qa', [held.id]);
    expect(nothing.status).toBe(403);
    expect(nothing.body.refused[0].reason).toBe('held');
    expect(mails).toHaveLength(sentBefore);
    const after = await db.prepare('SELECT COUNT(*) AS n FROM document_export_links').first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });

  it('a link minted BEFORE the hold stops serving the certificate, and serves it again once released', async () => {
    const a = await makeDocument(types.coa, 'Linked COA A');
    const b = await makeDocument(types.coa, 'Linked COA B');
    const mails = stubMail();
    const sent = await exportSend(
      as('user', 'http://localhost/api/document-exports/send', { method: 'POST', body: JSON.stringify({ document_ids: [a.id, b.id], recipients: ['buyer@harbor.example'] }) }),
    );
    expect(sent.status).toBe(200);
    const token = tokenFrom(mails);
    vi.unstubAllGlobals();

    const landing = async () => {
      const res = await exportLanding(fnContext(`http://localhost/api/document-exports/public/${token}`, { params: { token } }));
      expect(res.status).toBe(200);
      return (await readJson(res)) as DocumentExportLandingView;
    };
    const zipBodies = async () => {
      const res = await exportLandingZip(fnContext(`http://localhost/api/document-exports/public/${token}/download`, { params: { token } }));
      if (res.status !== 200) return { status: res.status, bodies: [] as string[], manifest: '' };
      const zip = unzip(await res.arrayBuffer());
      return { status: 200, bodies: Object.entries(zip).filter(([n]) => n !== 'manifest.csv').map(([, x]) => x), manifest: zip['manifest.csv'] };
    };
    const file = (index: string) =>
      exportLandingFile(fnContext(`http://localhost/api/document-exports/public/${token}/file/${index}`, { params: { token, index } }));

    expect((await landing()).documents).toHaveLength(2);

    const id = await hold(a.id, 'Recall under investigation');
    const during = await landing();
    expect(during.documents).toHaveLength(1);
    expect(during.unavailable_count).toBe(1);
    // A count, and nothing about which or why.
    expect(JSON.stringify(during)).not.toMatch(/hold|Recall|investigation/i);
    expect(JSON.stringify(during)).not.toContain(a.id);
    const zip = await zipBodies();
    expect(zip.bodies).toEqual([b.body]);
    expect(zip.manifest).not.toMatch(/hold|Recall/i);
    expect(await (await file('0')).text()).toBe(b.body);
    expect((await file('1')).status).toBe(404);

    // Both held: the link serves nothing at all.
    const id2 = await hold(b.id);
    expect((await landing()).documents).toEqual([]);
    expect((await zipBodies()).status).toBe(404);
    expect((await file('0')).status).toBe(404);

    await lift(id);
    await lift(id2);
    const afterRelease = await landing();
    expect(afterRelease.documents).toHaveLength(2);
    expect(afterRelease.unavailable_count).toBe(0);
    expect((await zipBodies()).bodies.sort()).toEqual([a.body, b.body].sort());
  });

  it('a bundle leaves it out and says so inside the archive, without the reason', async () => {
    const held = await makeDocument(types.coa, 'Bundled held COA');
    const free = await makeDocument(types.coa, 'Bundled clean COA');
    await hold(held.id, 'Listeria retest outstanding');
    const makeBundle = async (ids: string[]) => {
      const bundleId = generateTestId();
      await db.prepare(`INSERT INTO document_bundles (id, tenant_id, name, status, created_by) VALUES (?, ?, 'Customer package', 'finalized', ?)`).bind(bundleId, seed.tenantId, seed.orgAdminId).run();
      for (const [i, id] of ids.entries()) {
        await db.prepare('INSERT INTO document_bundle_items (id, bundle_id, document_id, sort_order) VALUES (?, ?, ?, ?)').bind(generateTestId(), bundleId, id, i).run();
      }
      return bundleId;
    };
    const both = await makeBundle([held.id, free.id]);
    for (const who of ['reader', 'org_admin', 'api_key'] as Who[]) {
      const res = await bundleDownload(as(who, `http://localhost/api/bundles/${both}/download`, { params: { id: both } }));
      expect(res.status, who).toBe(200);
      expect(res.headers.get('X-Bundle-Refused-Ids')).toBe(`${held.id}:held`);
      const zip = unzip(await res.arrayBuffer());
      expect(Object.entries(zip).filter(([n]) => n !== 'NOT-INCLUDED.txt').map(([, x]) => x)).toEqual([free.body]);
      expect(zip['NOT-INCLUDED.txt']).toContain('Bundled held COA');
      expect(zip['NOT-INCLUDED.txt']).toContain(HOLD_OUTWARD_TEXT);
      expect(zip['NOT-INCLUDED.txt']).not.toContain('Listeria');
    }
    const only = await makeBundle([held.id]);
    const refused = await bundleDownload(as('org_admin', `http://localhost/api/bundles/${only}/download`, { params: { id: only } }));
    expect(refused.status).toBe(403);
    expect(((await readJson(refused)) as SharingRuleRefusedResponse).refused[0]).toMatchObject({ reason: 'held', message: 'On hold: Listeria retest outstanding' });
    expect((await audits('bundle.download_refused', only))).toHaveLength(1);
  });
});

// ===========================================================================
// Orders
// ===========================================================================

async function newOrder(): Promise<string> {
  const { status, body } = await call<{ order: { id: string } }>(
    createOrder,
    as('user', 'http://localhost/api/orders', { method: 'POST', body: JSON.stringify({ order_number: `HO-${generateTestId().slice(0, 8)}`, customer_id: customerId }) }),
  );
  expect(status).toBe(201);
  return body.order.id;
}

async function pick(order: string, documentIds: string[]): Promise<void> {
  const res = await addItems(as('user', `http://localhost/api/orders/${order}/items`, { method: 'POST', body: JSON.stringify({ document_ids: documentIds }), params: { id: order } }));
  expect(res.status).toBe(201);
}

async function readOrder(order: string, who: Who = 'user'): Promise<OrderGetResponse> {
  const { status, body } = await call<OrderGetResponse>(getOrder, as(who, `http://localhost/api/orders/${order}`, { params: { id: order } }));
  expect(status).toBe(200);
  return body;
}

async function preview(order: string, who: Who = 'user'): Promise<OrderSendPreview> {
  const { status, body } = await call<OrderSendPreview>(sendPreview, as(who, `http://localhost/api/orders/${order}/send-preview`, { params: { id: order } }));
  expect(status).toBe(200);
  return body;
}

async function send(order: string, who: Who = 'user', body: Record<string, unknown> = {}) {
  return call<OrderSendResponse>(sendOrder, as(who, `http://localhost/api/orders/${order}/send`, { method: 'POST', body: JSON.stringify(body), params: { id: order } }));
}

async function resend(order: string, sendId: string, who: Who = 'org_admin') {
  return call<OrderSendResponse>(resendOrder, as(who, `http://localhost/api/orders/${order}/sends/${sendId}/resend`, { method: 'POST', body: '{}', params: { id: order, sendId } }));
}

async function orderStatus(order: string): Promise<string> {
  return (await db.prepare('SELECT status FROM orders WHERE id = ?').bind(order).first<{ status: string }>())!.status;
}

const attachedBodies = (mails: CapturedMail[]) => mails.flatMap((m) => m.attachments ?? []).map((a) => atob(a.content));

describe('a COA order with a held certificate', () => {
  it('the held line is listed as not sent with its reason, for an administrator too, and goes once released', async () => {
    const held = await makeDocument(types.coa, 'Order held COA', { lots: 1 });
    const free = await makeDocument(types.coa, 'Order clean COA', { lots: 1 });
    const order = await newOrder();
    await pick(order, [held.id, free.id]);
    const id = await hold(held.id, 'Out of spec, awaiting retest', held.lotIds[0]);

    // The order page shows it on the line.
    const items = (await readOrder(order)).items;
    expect(items.find((i) => i.coa_document_id === held.id)!.coa_hold).toMatchObject({ id, reason: 'Out of spec, awaiting retest', lot_id: held.lotIds[0] });
    expect(items.find((i) => i.coa_document_id === free.id)!.coa_hold).toBeNull();

    for (const who of ['user', 'qa', 'org_admin'] as Who[]) {
      const plan = await preview(order, who);
      expect(plan.files.flatMap((f) => f.document_ids)).toEqual([free.id]);
      const line = plan.lines_not_sent.find((l) => l.document_id === held.id)!;
      expect(line.sharing_refusal).toBe('held');
      expect(line.reason).toMatch(/^On hold \(lot \d+\): Out of spec, awaiting retest$/);
      expect(line.hold).toMatchObject({ id });
    }

    const mails = stubMail();
    const plan = await preview(order, 'org_admin');
    const first = await send(order, 'org_admin', { fingerprint: plan.fingerprint });
    expect(first.status).toBe(200);
    expect(attachedBodies(mails)).toEqual([free.body]);
    // A line left behind: the order is not delivered.
    expect(await orderStatus(order)).not.toBe('delivered');

    await lift(id);
    const again = await preview(order, 'user');
    expect(again.lines_not_sent).toEqual([]);
    const second = await send(order, 'user', { fingerprint: again.fingerprint });
    expect(second.status).toBe(200);
    expect(attachedBodies(mails)).toContain(held.body);
    expect(await orderStatus(order)).toBe('delivered');
  });

  it('with every certificate held there is nothing to send, and it says holds are why', async () => {
    const held = await makeDocument(types.coa, 'Only held COA', { lots: 1 });
    const order = await newOrder();
    await pick(order, [held.id]);
    await hold(held.id);
    const plan = await preview(order, 'org_admin');
    expect(plan.blocked).toMatchObject({ code: 'nothing_to_send' });
    expect(plan.blocked!.message).toMatch(/on hold/);
    const mails = stubMail();
    expect((await send(order, 'org_admin', { fingerprint: plan.fingerprint })).status).not.toBe(200);
    expect(mails).toHaveLength(0);
  });

  it('a hold on ANOTHER lot of the same file holds the file: the line names the lot that is held', async () => {
    // One unsplit certificate printing two lots. The order takes it for both.
    const doc = await makeDocument(types.coa, 'Unsplit two lot COA', { lots: 2 });
    const order = await newOrder();
    await pick(order, [doc.id]);
    await hold(doc.id, 'Lot under review', doc.lotIds[1]);
    const plan = await preview(order, 'org_admin');
    expect(plan.files).toEqual([]);
    expect(plan.lines_not_sent).toHaveLength(2);
    expect(plan.lines_not_sent.every((l) => l.sharing_refusal === 'held')).toBe(true);
    const { items } = await readOrder(order);
    // Each line names a hold; the line FOR the held lot names its own.
    expect(items.every((i) => i.coa_hold)).toBe(true);
    expect(items.find((i) => i.lot_id === doc.lotIds[1])!.coa_hold!.lot_id).toBe(doc.lotIds[1]);
  });

  it('a resend re-asks: a hold placed after the failed send stops the retry, and releasing it lets it go', async () => {
    const doc = await makeDocument(types.coa, 'Resend COA', { lots: 1 });
    const order = await newOrder();
    await pick(order, [doc.id]);
    const plan = await preview(order, 'org_admin');
    let mails = stubMail(() => true);
    const failed = await send(order, 'org_admin', { fingerprint: plan.fingerprint });
    expect(failed.body.send.status).toBe('failed');
    vi.unstubAllGlobals();

    const id = await hold(doc.id, 'Placed after the failed send');
    mails = stubMail();
    const retry = await resend(order, failed.body.send.id, 'org_admin');
    expect(mails).toHaveLength(0);
    expect(retry.body.send.status).toBe('failed');
    expect(JSON.stringify(retry.body.send.parts)).toContain('On hold: Placed after the failed send');
    expect(await orderStatus(order)).not.toBe('delivered');

    await lift(id);
    const ok = await resend(order, failed.body.send.id, 'org_admin');
    expect(ok.body.send.status).toBe('sent');
    expect(attachedBodies(mails)).toEqual([doc.body]);
    expect(await orderStatus(order)).toBe('delivered');
  });
});

// --- the whole original of a multi-lot certificate -------------------------

async function pdfWithPages(n: number): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) {
    const page = doc.addPage([300, 400]);
    page.drawText(`Certificate page ${i + 1}`, { x: 20, y: 350, size: 18 });
  }
  const bytes = await doc.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Approve a real three-lot certificate through the records path. By default it
 * has three pages, one lot on each; `pages` says which page each lot is on
 * (`[1, 1, 2]` = the first two lots share a page).
 */
async function approveMultiLot(lot: string, pages: number[] = [1, 2, 3]): Promise<{ queueId: string; original: ArrayBuffer; docIds: string[] }> {
  const id = generateTestId();
  const r2Key = `pending/${id}.pdf`;
  const original = await pdfWithPages(Math.max(...pages));
  await files.put(r2Key, original, { httpMetadata: { contentType: 'application/pdf' } });
  const record = (idx: number, sub: string) => ({
    record_index: idx,
    fields: { lot_code: lot, sub_lot_code: sub, product_name: 'Sweet Cream Butter' },
    source_pages: [pages[idx]],
  });
  const payload = {
    record_cardinality: 'multi_lot',
    record_key_basis: 'lot+sublot',
    page_metadata: { manufacturer: 'Northfield' },
    records: [record(0, '01'), record(1, '02'), record(2, '03')],
  } as CoaRecordsPayload;
  const fileName = `supplier upload ${id.slice(0, 6)}.pdf`;
  await db
    .prepare(
      `INSERT INTO processing_queue
         (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type,
          ai_records, processing_status, output_kind, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'application/pdf', ?, 'ready', 'coa', 'pending', ?, datetime('now'))`,
    )
    .bind(id, seed.tenantId, types.coa, r2Key, fileName, original.byteLength, JSON.stringify(payload), seed.userId)
    .run();
  const item = {
    id,
    tenant_id: seed.tenantId,
    document_type_id: types.coa,
    file_r2_key: r2Key,
    file_name: fileName,
    file_size: original.byteLength,
    mime_type: 'application/pdf',
    extracted_text: null,
    ai_fields: null,
    ai_confidence: null,
    confidence_score: null,
    product_names: null,
    supplier: 'Northfield Creamery',
    status: 'pending',
    created_by: seed.userId,
    tenant_slug: 'test-corp',
  } as unknown as QueueItem;
  const result = await produceCoaRecords(db, files, item, { payload, userId: seed.userId });
  return { queueId: id, original, docIds: result.documents.map((d) => d.documentId) };
}

async function lotOf(documentId: string): Promise<string> {
  return (await db.prepare('SELECT lot_id FROM document_lots WHERE document_id = ?').bind(documentId).first<{ lot_id: string }>())!.lot_id;
}

describe('a multi-lot certificate with one lot on hold', () => {
  it('a held lot that is NOT on the order keeps the whole original in; each lot\'s own page goes, with a note', async () => {
    const cert = await approveMultiLot('7701000');
    const order = await newOrder();
    await pick(order, [cert.docIds[0], cert.docIds[1]]);
    expect((await preview(order)).files[0].source).toBe('original');

    await hold(cert.docIds[2], 'Third lot under review', await lotOf(cert.docIds[2]));
    const plan = await preview(order);
    expect(plan.files).toHaveLength(2);
    expect(plan.files.every((f) => f.source === 'document')).toBe(true);
    expect(plan.files[0].notes.join(' ')).toMatch(/also covers lot 7701000 \/ 03, which is on hold, so only this lot's page is sent/);
    expect(plan.lines_not_sent).toEqual([]);

    const mails = stubMail();
    const { body } = await send(order, 'user', { fingerprint: plan.fingerprint });
    expect(body.send.status).toBe('sent');
    const sizes = mails.flatMap((m) => m.attachments ?? []).map((a) => atob(a.content).length);
    expect(sizes).toHaveLength(2);
    expect(sizes.every((n) => n !== cert.original.byteLength)).toBe(true);
  });

  it('a held lot that IS on the order: its line does not go, the unheld lot\'s own page does, the whole original does not', async () => {
    const cert = await approveMultiLot('7702000');
    const order = await newOrder();
    await pick(order, [cert.docIds[0], cert.docIds[1]]);
    const id = await hold(cert.docIds[0], 'First lot failed', await lotOf(cert.docIds[0]));

    const plan = await preview(order, 'org_admin');
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]).toMatchObject({ source: 'document', document_ids: [cert.docIds[1]] });
    expect(plan.files[0].notes.join(' ')).toMatch(/which is on hold, so only this lot's page is sent/);
    expect(plan.lines_not_sent.map((l) => [l.document_id, l.sharing_refusal])).toEqual([[cert.docIds[0], 'held']]);

    const mails = stubMail();
    const sent = await send(order, 'org_admin', { fingerprint: plan.fingerprint });
    expect(sent.body.send.status).toBe('sent');
    const sizes = mails.flatMap((m) => m.attachments ?? []).map((a) => atob(a.content).length);
    expect(sizes).toHaveLength(1);
    expect(sizes[0]).not.toBe(cert.original.byteLength);
    expect(await orderStatus(order)).not.toBe('delivered');

    // Released: the whole original goes again, once, for both lines.
    await lift(id);
    const after = await preview(order, 'org_admin');
    expect(after.files).toHaveLength(1);
    expect(after.files[0].source).toBe('original');
  });

  it('a whole original already recorded on a failed send is re-checked on resend', async () => {
    const cert = await approveMultiLot('7703000');
    const order = await newOrder();
    await pick(order, [cert.docIds[0], cert.docIds[1]]);
    const plan = await preview(order, 'org_admin');
    expect(plan.files[0].source).toBe('original');
    stubMail(() => true);
    const failed = await send(order, 'org_admin', { fingerprint: plan.fingerprint });
    expect(failed.body.send.status).toBe('failed');
    vi.unstubAllGlobals();

    // The lot that is NOT on the order is held afterwards. The stored file is
    // the whole original, which prints that lot too.
    await hold(cert.docIds[2], 'Held after the send was reviewed');
    const mails = stubMail();
    const retry = await resend(order, failed.body.send.id, 'org_admin');
    expect(mails).toHaveLength(0);
    expect(retry.body.send.status).toBe('failed');
    expect(JSON.stringify(retry.body.send.parts)).toContain('On hold');
  });
});

describe('two lots of one certificate on the SAME page: a file is what leaves (C-084)', () => {
  // Three lots; the first two are rows on page 1, the third is on page 2.
  // Each lot's "own page" is a cut of the page it is on, so lots 1 and 2 are
  // the same page of paper under two documents.
  it('a hold on one lot stops every file that prints that lot, and no other', async () => {
    const cert = await approveMultiLot('7710000', [1, 1, 2]);
    const [d1, d2, d3] = cert.docIds;
    const scoped = await db
      .prepare(`SELECT id, json_extract(extended_metadata, '$.page_scoped') AS scoped, json_extract(extended_metadata, '$.scoped_pages') AS pages FROM documents WHERE id IN (?, ?, ?)`)
      .bind(d1, d2, d3)
      .all<{ id: string; scoped: number; pages: string }>();
    // The fixture really is what the comment says, or the test proves nothing.
    expect(Object.fromEntries((scoped.results ?? []).map((r) => [r.id, [r.scoped, r.pages]]))).toEqual({
      [d1]: [1, '[1]'],
      [d2]: [1, '[1]'],
      [d3]: [1, '[2]'],
    });

    const id = await hold(d1, 'First lot failed coliform', await lotOf(d1));
    const download = (who: Who, doc: string) =>
      downloadDocument(as(who, `http://localhost/api/documents/${doc}/download`, { params: { id: doc } }));

    // Lot 2's file is page 1, which prints lot 1's failing row: it does not leave.
    const refused = await download('api_key', d2);
    expect(refused.status).toBe(403);
    expect(await readJson(refused)).toMatchObject({ reason: 'held', error: 'On hold (lot 7710000 / 01): First lot failed coliform' });
    // Lot 3 is on its own page and is untouched.
    const ok = await download('api_key', d3);
    expect(ok.status).toBe(200);
    await ok.arrayBuffer();
    // A signed-in person still opens either.
    const person = await download('reader', d2);
    expect(person.status).toBe(200);
    await person.arrayBuffer();

    const zip = await exportZip(as('org_admin', 'http://localhost/api/document-exports/zip', { method: 'POST', body: JSON.stringify({ document_ids: [d1, d2, d3] }) }));
    expect(zip.status).toBe(200);
    expect((zip.headers.get('X-Export-Refused-Ids') ?? '').split(',').sort()).toEqual([`${d1}:held`, `${d2}:held`].sort());
    await zip.arrayBuffer();

    // The document page of lot 2 says why, and points at the certificate the hold is on.
    const page = (await holdsOf('qa', d2)).body;
    expect(page.active).toEqual([]);
    expect(page.also_held_by).toHaveLength(1);
    expect(page.also_held_by[0]).toMatchObject({ id, document_id: d1, lot_label: '7710000 / 01', reason: 'First lot failed coliform' });
    expect((await holdsOf('qa', d3)).body.also_held_by).toEqual([]);
    const state = await call<{ document: { holds: DocumentHoldState } }>(getDocument, as('user', `http://localhost/api/documents/${d2}`, { params: { id: d2 } }));
    expect(state.body.document.holds.active.map((h) => [h.id, h.document_id])).toEqual([[id, d1]]);

    // On an order: lots 2 and 3. Lot 2's line does not go; lot 3's own page does.
    const order = await newOrder();
    await pick(order, [d2, d3]);
    const items = (await readOrder(order)).items;
    expect(items.find((i) => i.coa_document_id === d2)!.coa_hold).toMatchObject({ id, document_id: d1 });
    expect(items.find((i) => i.coa_document_id === d3)!.coa_hold).toBeNull();
    const plan = await preview(order, 'org_admin');
    expect(plan.lines_not_sent.map((l) => [l.document_id, l.sharing_refusal])).toEqual([[d2, 'held']]);
    expect(plan.lines_not_sent[0].reason).toBe('On hold (lot 7710000 / 01): First lot failed coliform');
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]).toMatchObject({ source: 'document', document_ids: [d3] });
    const mails = stubMail();
    const sent = await send(order, 'org_admin', { fingerprint: plan.fingerprint });
    expect(sent.body.send.status).toBe('sent');
    const sizes = mails.flatMap((m) => m.attachments ?? []).map((a) => atob(a.content).length);
    expect(sizes).toHaveLength(1);
    expect(sizes[0]).not.toBe(cert.original.byteLength);
    vi.unstubAllGlobals();

    // Released: everything goes again.
    await lift(id);
    const after = await download('api_key', d2);
    expect(after.status).toBe(200);
    await after.arrayBuffer();
    expect((await holdsOf('qa', d2)).body.also_held_by).toEqual([]);
    expect((await preview(order, 'org_admin')).lines_not_sent).toEqual([]);
  });

  it('a hold on the WHOLE certificate of one lot still stops the file that shares its page, and names the lot', async () => {
    const cert = await approveMultiLot('7711000', [1, 1, 2]);
    const [d1, d2, d3] = cert.docIds;
    await hold(d2, 'Whole certificate withdrawn');
    const res = await downloadDocument(as('api_key', `http://localhost/api/documents/${d1}/download`, { params: { id: d1 } }));
    expect(res.status).toBe(403);
    expect(await readJson(res)).toMatchObject({ reason: 'held', error: 'On hold (lot 7711000 / 02): Whole certificate withdrawn' });
    const ok = await downloadDocument(as('api_key', `http://localhost/api/documents/${d3}/download`, { params: { id: d3 } }));
    expect(ok.status).toBe(200);
    await ok.arrayBuffer();
  });

  it('a file that could not be cut holds the whole certificate: a hold on ANY lot of it stops that file', async () => {
    const cert = await approveMultiLot('7712000');
    const [d1, , d3] = cert.docIds;
    // Lot 3's file stands in for a cut that failed: it is the whole binary.
    await db.prepare(`UPDATE documents SET extended_metadata = json_remove(extended_metadata, '$.page_scoped', '$.scoped_pages') WHERE id = ?`).bind(d3).run();
    const get = (doc: string) => downloadDocument(as('api_key', `http://localhost/api/documents/${doc}/download`, { params: { id: doc } }));
    const before = await get(d3);
    expect(before.status).toBe(200);
    await before.arrayBuffer();
    const id = await hold(d1, 'Lot one under review', await lotOf(d1));
    const refused = await get(d3);
    expect(refused.status).toBe(403);
    expect(await readJson(refused)).toMatchObject({ reason: 'held' });
    await lift(id);
    const after = await get(d3);
    expect(after.status).toBe(200);
    await after.arrayBuffer();
  });

  it('another certificate entirely is never touched by a hold', async () => {
    const a = await approveMultiLot('7713000', [1, 1, 2]);
    const b = await approveMultiLot('7714000', [1, 1, 2]);
    await hold(a.docIds[0], 'Only this certificate');
    for (const doc of b.docIds) {
      const res = await downloadDocument(as('api_key', `http://localhost/api/documents/${doc}/download`, { params: { id: doc } }));
      expect(res.status).toBe(200);
      await res.arrayBuffer();
    }
  });
});

// --- document order lines --------------------------------------------------

async function makePair(name: string): Promise<{ product_id: string; supplier_id: string }> {
  const productId = generateTestId();
  await db
    .prepare(`INSERT INTO products (id, tenant_id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`)
    .bind(productId, seed.tenantId, name, `p-${productId.slice(0, 8)}`)
    .run();
  await db
    .prepare(
      `INSERT INTO product_suppliers (id, tenant_id, product_id, supplier_id, approval_status, approval_source)
       VALUES (?, ?, ?, ?, 'approved', 'initial')`,
    )
    .bind(generateTestId(), seed.tenantId, productId, supplierId)
    .run();
  return { product_id: productId, supplier_id: supplierId };
}

async function documentOrder(typeId: string, name: string) {
  const pair = await makePair(name);
  const doc = await makeDocument(typeId, `${name} document`, { products: [pair.product_id] });
  const order = await newOrder();
  const added = await call<OrderDocumentsAddResponse>(
    addDocuments,
    as('user', `http://localhost/api/orders/${order}/documents`, { method: 'POST', body: JSON.stringify({ items: [pair], document_type_ids: [typeId] }), params: { id: order } }),
  );
  expect(added.status).toBe(201);
  const lineId = added.body.lines[0].order_document_id!;
  expect(added.body.lines[0].document_id).toBe(doc.id);
  return { order, doc, lineId };
}

describe('a document order line whose document is on hold', () => {
  it('does not go, even when a QA releaser sends it; nothing is minted; it goes once the hold is released', async () => {
    const { order, doc, lineId } = await documentOrder(types.spec, 'Held spec item');
    const id = await hold(doc.id, 'Superseded spec, do not send');

    const line = (await readOrder(order, 'qa')).documents!.find((l) => l.id === lineId)!;
    expect(line).toMatchObject({ disposition: 'will_not_go', disposition_reason: 'held', hold: { id } });
    expect(line.disposition_text).toBe('On hold: Superseded spec, do not send. It can go once QA or an administrator releases the hold.');

    const plan = await preview(order, 'qa');
    expect(plan.documents!.will_not_go.map((l) => [l.order_document_id, l.reason])).toEqual([[lineId, 'held']]);
    expect(plan.lines_not_sent.find((l) => l.order_document_id === lineId)).toMatchObject({ sharing_refusal: 'held', hold: { id } });
    expect(plan.blocked).toMatchObject({ code: 'nothing_to_send' });

    const before = await db.prepare('SELECT COUNT(*) AS n FROM document_export_links').first<{ n: number }>();
    const mails = stubMail();
    expect((await send(order, 'qa', { fingerprint: plan.fingerprint })).status).not.toBe(200);
    expect(mails).toHaveLength(0);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM document_export_links').first<{ n: number }>())!.n).toBe(before!.n);

    await lift(id);
    const after = await preview(order, 'user');
    expect(after.documents!.goes_now.map((l) => l.order_document_id)).toEqual([lineId]);
    const sent = await send(order, 'user', { fingerprint: after.fingerprint });
    expect(sent.status).toBe(200);
    expect(sent.body.send.status).toBe('sent');
  });

  it('a `qa` document on hold is not queued for QA and QA is not asked', async () => {
    const { order, doc, lineId } = await documentOrder(types.qa, 'Held guarantee item');
    await hold(doc.id);
    const plan = await preview(order, 'user');
    expect(plan.documents!.waits_for_qa).toEqual([]);
    expect(plan.documents!.will_not_go.map((l) => [l.order_document_id, l.reason, l.notifies_qa])).toEqual([[lineId, 'held', false]]);
    const mails = stubMail();
    expect((await send(order, 'user', { fingerprint: plan.fingerprint })).status).not.toBe(200);
    expect(mails).toHaveLength(0);
    const row = await db.prepare('SELECT release_status FROM order_documents WHERE id = ?').bind(lineId).first<{ release_status: string }>();
    expect(row!.release_status).toBe('none');
  });

  it('a line already waiting for QA is NOT released while its document is held: nothing is minted or mailed', async () => {
    const { order, doc, lineId } = await documentOrder(types.qa, 'Pending guarantee item');
    let mails = stubMail();
    const plan = await preview(order, 'user');
    expect(plan.documents!.waits_for_qa.map((l) => l.order_document_id)).toEqual([lineId]);
    const asked = await send(order, 'user', { fingerprint: plan.fingerprint, recipients: ['buyer@harbor.example'] });
    expect(asked.status).toBe(200);
    const row = async () => (await db.prepare('SELECT release_status, pending_send_id, document_id FROM order_documents WHERE id = ?').bind(lineId).first<Record<string, string>>())!;
    expect((await row()).release_status).toBe('pending_qa');
    vi.unstubAllGlobals();

    const id = await hold(doc.id, 'Held while it waited');
    // The waiting list shows it, and says it cannot be released.
    const waiting = await call<PendingOrderDocumentsResponse>(pendingList, as('qa', 'http://localhost/api/order-documents/pending'));
    const shown = waiting.body.lines.find((l) => l.id === lineId)!;
    expect(shown.hold).toMatchObject({ id });
    expect(shown.releasable).toBe(false);
    expect(shown.blocked_reason).toContain('Release the hold first');

    const doRelease = async () => {
      const r = await row();
      return call<OrderDocumentsReleaseResponse>(
        releaseBatch,
        as('qa', `http://localhost/api/orders/${order}/documents/release`, {
          method: 'POST',
          body: JSON.stringify({ lines: [{ id: lineId, document_id: r.document_id, version_number: 1, pending_send_id: r.pending_send_id }] }),
          params: { id: order },
        }),
      );
    };
    const before = await db.prepare('SELECT COUNT(*) AS n FROM document_export_links').first<{ n: number }>();
    mails = stubMail();
    const refused = await doRelease();
    expect(refused.body.released).toEqual([]);
    expect(refused.body.refused).toHaveLength(1);
    expect(refused.body.refused[0].reason).toMatch(/^On hold: Held while it waited\. Release the hold first/);
    expect(mails).toHaveLength(0);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM document_export_links').first<{ n: number }>())!.n).toBe(before!.n);
    // Still waiting; the QA release did not lift the hold either.
    expect((await row()).release_status).toBe('pending_qa');
    expect((await holdsOf('qa', doc.id)).body.active).toHaveLength(1);

    await lift(id);
    const ok = await doRelease();
    expect(ok.body.released).toHaveLength(1);
    expect((await row()).release_status).toBe('released');
  });
});

// ===========================================================================
// Automatic holds
// ===========================================================================

const LIMIT: ConfiguredLimit = {
  id: 'limit-coliform-hold',
  spec_test_id: 'st-coliform-hold',
  operator: '<=',
  value_min: null,
  value_max: 10,
  unit: 'CFU/g',
  severity: 'alert',
  criticality: HOLDING_SPEC_CRITICALITY,
  active: true,
  supplier_id: null,
  document_type_id: null,
  product_id: null,
};

function verdict(over: Partial<SpecVerdict> = {}): SpecVerdict {
  return {
    scope: 'ai_fields',
    target: { kind: 'table', table_index: 0, row_index: 0, table_name: 'micro' },
    test_name_raw: 'Coliform',
    value_raw: '40',
    unit_raw: 'CFU/g',
    verdict: 'out_of_spec',
    source: 'limit',
    limit_text: '<=10 CFU/g',
    reason: '40 exceeds the 10 limit',
    message: 'Coliform is 40, outside our limit.',
    limit_id: LIMIT.id,
    spec_test_id: LIMIT.spec_test_id,
    value_num: 40,
    criticality: HOLDING_SPEC_CRITICALITY,
    ...over,
  };
}

async function approveWith(doc: MadeDoc, verdicts: SpecVerdict[], opts: { version?: number; tenantId?: string; supplier?: string | null } = {}) {
  await registerAndNotifyForApproval(
    db,
    'test-resend-key',
    {
      tenantId: opts.tenantId ?? seed.tenantId,
      tenantName: 'Test Corp',
      queueItemId: 'queue-item-x',
      supplierId: opts.supplier === undefined ? supplierId : opts.supplier,
      supplierName: 'Northfield Creamery',
      documentTypeId: null,
      approvedBy: seed.userId,
      appUrl: 'http://localhost',
    },
    verdicts,
    [LIMIT],
    [{ documentId: doc.id, title: doc.title, recordIndex: null, versionNumber: opts.version ?? 1 }],
  );
}

const holdRows = async (documentId: string) =>
  (await db.prepare('SELECT * FROM document_holds WHERE document_id = ? ORDER BY rowid').bind(documentId).all<Record<string, any>>()).results ?? [];

describe('automatic holds at approval', () => {
  it('a Critical result out of spec holds that lot, once, and QA is told once', async () => {
    const doc = await makeDocument(types.coa, 'Critical COA', { lots: 1 });
    const mails = stubMail();
    await approveWith(doc, [verdict()]);

    const rows = await holdRows(doc.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'spec_critical',
      lot_id: doc.lotIds[0],
      placed_by: null,
      document_version: 1,
      source_key: 'v1:limit:ai_fields::t0r0',
      released_at: null,
    });
    expect(rows[0].reason).toBe('Critical result out of spec: Coliform 40 CFU/g (limit <=10 CFU/g).');
    expect(JSON.parse(rows[0].detail)).toMatchObject({ test: 'Coliform', value: '40', limit: '<=10 CFU/g', version: 1 });
    // The pointer names the register row that was just written.
    const check = await db.prepare('SELECT id FROM document_spec_checks WHERE document_id = ? AND verdict = ?').bind(doc.id, 'out_of_spec').first<{ id: string }>();
    expect(rows[0].spec_check_id).toBe(check!.id);
    expect(rows[0].qa_notified_at).toBeTruthy();

    const told = holdMails(mails);
    expect(told).toHaveLength(1);
    expect(told[0].to).toEqual([qaEmail]);
    expect(told[0].html).toContain('The portal put Critical COA');
    const audit = await audits('document.hold_placed', doc.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ user_id: null, details: { via: 'approval', source: 'spec_critical', approved_by: seed.userId } });

    // It really is held.
    const refused = await downloadDocument(as('api_key', `http://localhost/api/documents/${doc.id}/download`, { params: { id: doc.id } }));
    expect(refused.status).toBe(403);

    // Re-approval of the same result: exactly one hold, and no second notice.
    await approveWith(doc, [verdict()]);
    expect(await holdRows(doc.id)).toHaveLength(1);
    expect(holdMails(mails)).toHaveLength(1);

    // QA releases it. Re-judging the SAME version does not put it back.
    await lift(rows[0].id);
    await approveWith(doc, [verdict()]);
    const after = await holdRows(doc.id);
    expect(after).toHaveLength(1);
    expect(after[0].released_at).toBeTruthy();
    expect(holdMails(mails)).toHaveLength(1);

    // A NEW version that still fails is a new result, and is held.
    await approveWith(doc, [verdict()], { version: 2 });
    const v2 = await holdRows(doc.id);
    expect(v2).toHaveLength(2);
    expect(v2[1]).toMatchObject({ source_key: 'v2:limit:ai_fields::t0r0', released_at: null, document_version: 2 });
    expect(holdMails(mails)).toHaveLength(2);
  });

  it('one notice for several holds on one certificate; a certificate with several lot rows is held whole', async () => {
    const doc = await makeDocument(types.coa, 'Two failures COA', { lots: 2 });
    const mails = stubMail();
    await approveWith(doc, [
      verdict(),
      verdict({ target: { kind: 'table', table_index: 0, row_index: 1, table_name: 'micro' }, test_name_raw: 'E. coli' }),
    ]);
    const rows = await holdRows(doc.id);
    expect(rows).toHaveLength(2);
    // Nothing guesses which row of an unsplit file a result belongs to.
    expect(rows.map((r) => r.lot_id)).toEqual([null, null]);
    expect(holdMails(mails)).toHaveLength(1);
    expect(holdMails(mails)[0].html).toContain('E. coli');
  });

  it('nothing else holds: a Major failure, a pass, a could-not-check, a method mismatch, a printed-limit failure', async () => {
    const doc = await makeDocument(types.coa, 'Unheld COA', { lots: 1 });
    const mails = stubMail();
    const at = (row_index: number): SpecVerdict['target'] => ({ kind: 'table', table_index: 0, row_index, table_name: 'micro' });
    await approveWith(doc, [
      verdict({ target: at(0), criticality: 'medium' }),
      verdict({ target: at(1), criticality: undefined }),
      verdict({ target: at(2), verdict: 'in_spec' }),
      verdict({ target: at(3), verdict: 'not_checked' }),
      verdict({ target: at(4), verdict: 'not_checked', not_checked_category: 'method_mismatch', band: { band: 'top_priority', category: 'zero_tolerance', reason: 'x' } }),
      verdict({ target: at(5), verdict: 'not_checked', not_checked_category: 'sample_basis_mismatch' }),
      verdict({ target: at(6), source: 'printed', limit_id: null }),
    ]);
    expect(await holdRows(doc.id)).toEqual([]);
    expect(holdMails(mails)).toEqual([]);
    expect(await audits('document.hold_placed', doc.id)).toEqual([]);
  });

  it('E2: a zero-tolerance presence test on too small a sample holds the lot', async () => {
    const doc = await makeDocument(types.coa, 'Salmonella COA', { lots: 1 });
    stubMail();
    await approveWith(doc, [
      verdict({
        test_name_raw: 'Salmonella',
        value_raw: 'Negative/10g',
        unit_raw: null,
        verdict: 'not_checked',
        criticality: 'medium',
        not_checked_category: 'sample_basis_mismatch',
        reason: 'tested absent in 10 g but the limit requires absence in 25 g',
        band: { band: 'top_priority', category: 'zero_tolerance', reason: 'a zero-tolerance analyte could not be confirmed clean' },
      }),
    ]);
    const rows = await holdRows(doc.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'zero_tolerance', lot_id: doc.lotIds[0] });
    expect(rows[0].reason).toContain('Salmonella');
  });

  it('with nobody on the QA route: the hold stands, the gap is audited, the administrators are told', async () => {
    const theirs = await makeDocument(null, 'Unrouted critical COA', { tenantId: seed.tenantId2 });
    const mails = stubMail();
    await approveWith(theirs, [verdict()], { tenantId: seed.tenantId2, supplier: null });
    const rows = await holdRows(theirs.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].qa_notified_at).toBeNull();
    expect(await audits('document.hold_placed.routing_gap', theirs.id)).toHaveLength(1);
    expect(holdMails(mails)).toHaveLength(1);
    expect(holdMails(mails)[0].subject).toMatch(/Nobody was alerted/);
  });

  it('a row written by the bulk recheck never becomes a hold', async () => {
    const doc = await makeDocument(types.coa, 'Bulk recheck COA', { lots: 1 });
    await db
      .prepare(
        `INSERT INTO document_spec_checks
           (id, tenant_id, document_id, version_number, test_name_raw, value_raw, verdict, source, limit_id,
            limit_snapshot, judgement_origin, bulk_run_at, result_key)
         VALUES (?, ?, ?, 1, 'Coliform', '40', 'out_of_spec', 'limit', 'l1', ?, 'bulk_recheck', datetime('now'), 'ai_fields::t0r0')`,
      )
      .bind(generateTestId(), seed.tenantId, doc.id, JSON.stringify({ criticality: HOLDING_SPEC_CRITICALITY }))
      .run();
    expect(await holdRows(doc.id)).toEqual([]);
    const ok = await downloadDocument(as('api_key', `http://localhost/api/documents/${doc.id}/download`, { params: { id: doc.id } }));
    expect(ok.status).toBe(200);
  });

  it('end to end: the Review Queue approve route judges against the limits on file and holds the document', async () => {
    const testId = generateTestId();
    await db.prepare(`INSERT INTO spec_tests (id, tenant_id, name, aliases, default_unit) VALUES (?, ?, 'Holdable Coliform', '[]', 'CFU/g')`).bind(testId, seed.tenantId).run();
    await db
      .prepare(
        `INSERT INTO spec_limits (id, tenant_id, spec_test_id, operator, value_max, unit, severity, criticality, active)
         VALUES (?, ?, ?, '<=', 10, 'CFU/g', 'alert', ?, 1)`,
      )
      .bind(generateTestId(), seed.tenantId, testId, HOLDING_SPEC_CRITICALITY)
      .run();
    const tables = JSON.stringify([{ name: 'Micro', headers: ['Test', 'Result'], rows: [['Holdable Coliform', '40 CFU/g']] }]);
    // The same judgement the route runs, so a fixture that judges nothing fails here and not silently below.
    const config = await loadSpecConfig(db, seed.tenantId);
    const judged = specResultsWithConfig({ tables }, config, { supplier_id: supplierId, document_type_id: types.coa, product_ids: [] }, { includePasses: true });
    expect(judged.results.some((v) => v.verdict === 'out_of_spec' && v.criticality === HOLDING_SPEC_CRITICALITY)).toBe(true);

    const queueId = generateTestId();
    const key = `pending/test/${queueId}/arrival.pdf`;
    await files.put(key, new TextEncoder().encode(`%PDF-1.4 ${queueId}`));
    await db
      .prepare(
        `INSERT INTO processing_queue (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type,
           status, processing_status, supplier_id, ai_fields, tables, extracted_text, source, created_by)
         VALUES (?, ?, ?, ?, 'arrival.pdf', 20, 'application/pdf', 'pending', 'ready', ?, '{}', ?, 'text', 'import', ?)`,
      )
      .bind(queueId, seed.tenantId, types.coa, key, supplierId, tables, seed.orgAdminId)
      .run();
    const mails = stubMail();
    const res = (await queuePut(queueId, { status: 'approved', fields: { title: 'Route approved COA' }, supplier_id: supplierId }, person('org_admin'))) as { status: number; body: any };
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const documentId = res.body.document.id as string;

    const rows = await holdRows(documentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'spec_critical', placed_by: null });
    expect(rows[0].reason).toContain('Holdable Coliform');
    expect(holdMails(mails)).toHaveLength(1);
    const state = await call<{ document: { holds: DocumentHoldState } }>(getDocument, as('user', `http://localhost/api/documents/${documentId}`, { params: { id: documentId } }));
    expect(state.body.document.holds.active).toHaveLength(1);
    expect(state.body.document.holds.active[0].source).toBe('spec_critical');
  });
});

// ===========================================================================
// Replacing the file
// ===========================================================================

describe('replacing a held certificate does not lift the hold', () => {
  it('a new version uploaded on the document page: still held, still refused', async () => {
    const doc = await makeDocument(types.coa, 'Versioned held COA', { lots: 1 });
    const id = await hold(doc.id, 'Held before the new file', doc.lotIds[0]);
    const form = new FormData();
    form.append('file', new Blob([new TextEncoder().encode('%PDF-1.4 a corrected file')], { type: 'application/pdf' }), 'corrected.pdf');
    const up = await uploadVersion(as('user', `http://localhost/api/documents/${doc.id}/upload`, { method: 'POST', body: form, params: { id: doc.id } }));
    expect([200, 201]).toContain(up.status);
    const version = await db.prepare('SELECT current_version FROM documents WHERE id = ?').bind(doc.id).first<{ current_version: number }>();
    expect(version!.current_version).toBe(2);

    const page = (await holdsOf('qa', doc.id)).body;
    expect(page.active.map((h) => h.id)).toEqual([id]);
    expect(page.active[0].document_version).toBe(1);
    const refused = await downloadDocument(as('api_key', `http://localhost/api/documents/${doc.id}/download`, { params: { id: doc.id } }));
    expect(refused.status).toBe(403);
    expect(await readJson(refused)).toMatchObject({ reason: 'held' });
  });

  it('the Review Queue\'s "Replace existing": the hold stays on the document, and QA releases it', async () => {
    const admin = person('org_admin');
    const upload = async (bytes: Uint8Array, name: string) => {
      const form = new FormData();
      form.append('tenant_id', seed.tenantId);
      form.append('files', new Blob([bytes], { type: 'application/pdf' }), name);
      const resp = await processPost(fnContext('/api/documents/process', { method: 'POST', body: form, user: admin }));
      return (await readJson(resp)) as QueuedResponse;
    };
    const bytes = new TextEncoder().encode(`%PDF-1.4\n%held-replace ${crypto.randomUUID()}\n`);
    const first = await upload(bytes, 'held-replace.pdf');
    const made = (await queuePut(first.items[0].id, { status: 'approved', fields: { title: 'Held replace original', lot_number: 'LOT-HR-1' }, supplier_id: supplierId }, admin)) as { status: number; body: any };
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const docId = made.body.document.id as string;
    const id = await hold(docId, 'Held before it was replaced');

    const again = await upload(bytes, 'held-replace-again.pdf');
    const replaced = (await queuePut(
      again.items[0].id,
      { status: 'approved', fields: { title: 'Held replace reissued', lot_number: 'LOT-HR-1' }, supplier_id: supplierId, duplicate_decision: 'replace' },
      admin,
    )) as { status: number; body: any };
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    expect(replaced.body.duplicate_decision.version_number).toBe(2);

    const page = (await holdsOf('qa', docId)).body;
    expect(page.active.map((h) => h.id)).toEqual([id]);
    const zip = await exportZip(as('org_admin', 'http://localhost/api/document-exports/zip', { method: 'POST', body: JSON.stringify({ document_ids: [docId] }) }));
    expect(zip.status).toBe(403);
    expect(((await readJson(zip)) as SharingRuleRefusedResponse).refused[0].reason).toBe('held');

    await lift(id);
    const after = await exportZip(as('org_admin', 'http://localhost/api/document-exports/zip', { method: 'POST', body: JSON.stringify({ document_ids: [docId] }) }));
    // Whatever its sharing rule now says, it is no longer refused as held.
    if (after.status === 403) {
      expect(((await readJson(after)) as SharingRuleRefusedResponse).refused[0].reason).not.toBe('held');
    } else {
      expect(after.status).toBe(200);
      await after.arrayBuffer();
    }
  });
});
