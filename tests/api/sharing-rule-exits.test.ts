/**
 * The sharing rule on every exit (decision C-003; C-038..C-042; migration 0137).
 *
 * Four documents -- one "send freely", one "needs QA approval", one locked and
 * one with no type at all (which reads locked) -- taken through every way a
 * file leaves the portal, by every kind of caller:
 *
 *   reader      a read-only account
 *   user        an ordinary member, not on the QA route
 *   qa          an ordinary member who IS on the `QA` owner route
 *   org_admin   an administrator of the organization
 *   api key     a key belonging to that administrator
 *
 * What is pinned:
 *
 *   1. A logged-in person opening ONE file is not "leaving": all four, any role.
 *   2. Everything else that leaves: free for anyone, qa only for a QA releaser,
 *      locked for nobody -- and an untyped document is locked.
 *   3. An API key gets "send freely" only, on every exit, even an admin's key.
 *   4. A refusal is STATED: the response names the document and the reason,
 *      and the rest of the selection still goes.
 *   5. A QA releaser sending a qa document is the approval, and is audited.
 *   6. A public link stops serving a document locked after it was sent, and an
 *      order resend re-checks before it re-reads a byte.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { unzipSync, strFromU8 } from 'fflate';
import { seedTestData, generateTestId } from '../helpers/db';
import { fnContext, readJson } from '../helpers/requests';
import type { TestUser } from '../helpers/requests';
import { hashApiKey } from '../../functions/lib/auth';
import { canReleaseQa } from '../../functions/lib/sharing-rule';
import { onRequest as middleware } from '../../functions/api/_middleware';
import { onRequestGet as downloadDocument } from '../../functions/api/documents/[id]/download';
import { onRequestGet as getDocument, onRequestPut as putDocument } from '../../functions/api/documents/[id]';
import { onRequestPost as exportZip } from '../../functions/api/document-exports/zip';
import { onRequestPost as exportSend } from '../../functions/api/document-exports/send';
import { onRequestGet as exportLanding } from '../../functions/api/document-exports/public/[token]';
import { onRequestGet as exportLandingZip } from '../../functions/api/document-exports/public/[token]/download';
import { onRequestGet as exportLandingFile } from '../../functions/api/document-exports/public/[token]/file/[index]';
import { onRequestGet as bundleDownload } from '../../functions/api/bundles/[id]/download';
import { onRequestPost as createOrder } from '../../functions/api/orders/index';
import { onRequestGet as getOrder } from '../../functions/api/orders/[id]';
import { onRequestPost as addItems } from '../../functions/api/orders/[id]/items/index';
import { onRequestGet as sendPreview } from '../../functions/api/orders/[id]/send-preview';
import { onRequestPost as sendOrder } from '../../functions/api/orders/[id]/send';
import { onRequestPost as resendOrder } from '../../functions/api/orders/[id]/sends/[sendId]/resend';
import type {
  DocumentExportLandingView,
  DocumentExportSendResponse,
  DocumentSharingInfo,
  OrderSendPreview,
  OrderSendResponse,
  SharingRefusal,
  SharingRuleRefusedResponse,
} from '../../shared/types';

const db = env.DB;
const files = env.FILES;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let supplierId = '';
let customerId = '';
let qaUserId = '';
const types = { free: '', qa: '', locked: '' };

type ActorName = 'reader' | 'user' | 'qa' | 'org_admin' | 'api_key';
const PEOPLE: ActorName[] = ['reader', 'user', 'qa', 'org_admin'];
const EVERYONE: ActorName[] = [...PEOPLE, 'api_key'];

function person(name: Exclude<ActorName, 'api_key'>): TestUser {
  switch (name) {
    case 'reader':
      return { id: seed.readerId, email: 'reader@test.com', name: 'Reader User', role: 'reader', tenant_id: seed.tenantId };
    case 'user':
      return { id: seed.userId, email: 'user@test.com', name: 'Regular User', role: 'user', tenant_id: seed.tenantId };
    case 'qa':
      return { id: qaUserId, email: 'qa@test.com', name: 'Quality Lead', role: 'user', tenant_id: seed.tenantId };
    case 'org_admin':
      return { id: seed.orgAdminId, email: 'orgadmin@test.com', name: 'Org Admin', role: 'org_admin', tenant_id: seed.tenantId };
  }
}

/**
 * A handler context for one caller. The API key is the ORG ADMIN's key: the
 * point of C-041 is that a key reads "send freely" only whoever it belongs to.
 */
function as(
  actor: ActorName,
  url: string,
  init: RequestInit & { params?: Record<string, string> } = {},
): never {
  const ctx = fnContext(url, { ...init, user: actor === 'api_key' ? person('org_admin') : person(actor) }) as any;
  ctx.data.authMethod = actor === 'api_key' ? 'api_key' : 'jwt';
  if (actor === 'api_key') ctx.data.apiKeyId = 'key-under-test';
  return ctx as never;
}

interface MadeDoc {
  id: string;
  title: string;
  body: string;
}

interface DocSet {
  free: MadeDoc;
  qa: MadeDoc;
  locked: MadeDoc;
  untyped: MadeDoc;
  ids: string[];
}

async function makeDocument(typeId: string | null, title: string, opts: { lot?: string } = {}): Promise<MadeDoc> {
  const id = generateTestId();
  const body = `PDF-BYTES-${title}-${id}`;
  await db
    .prepare(
      `INSERT INTO documents
         (id, tenant_id, title, tags, current_version, status, created_by, supplier_id, document_type_id)
       VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, ?)`,
    )
    .bind(id, seed.tenantId, title, seed.orgAdminId, supplierId, typeId)
    .run();
  const key = `docs/${id}/v1.pdf`;
  await db
    .prepare(
      `INSERT INTO document_versions
         (id, document_id, version_number, file_name, file_size, mime_type, r2_key, uploaded_by)
       VALUES (?, ?, 1, ?, ?, 'application/pdf', ?, ?)`,
    )
    .bind(generateTestId(), id, `internal name ${id.slice(0, 6)}.pdf`, body.length, key, seed.orgAdminId)
    .run();
  await files.put(key, new TextEncoder().encode(body));
  if (opts.lot) {
    const lotId = generateTestId();
    await db
      .prepare(
        `INSERT INTO lots (id, tenant_id, supplier_id, lot_number, lot_key, sub_lot_code)
         VALUES (?, ?, ?, ?, ?, '')`,
      )
      .bind(lotId, seed.tenantId, supplierId, opts.lot, `${opts.lot}-${lotId.slice(0, 4)}`)
      .run();
    await db
      .prepare('INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)')
      .bind(generateTestId(), id, lotId)
      .run();
  }
  return { id, title, body };
}

let lotCounter = 70000;

/** One of each. `lots` gives each a lot row, so each is one order line. */
async function makeSet(opts: { lots?: boolean } = {}): Promise<DocSet> {
  const lot = () => (opts.lots ? { lot: String(lotCounter++) } : {});
  const free = await makeDocument(types.free, 'Cream COA', lot());
  const qa = await makeDocument(types.qa, 'Guarantee letter', lot());
  const locked = await makeDocument(types.locked, 'Tax form', lot());
  const untyped = await makeDocument(null, 'Unsorted scan', lot());
  return { free, qa, locked, untyped, ids: [free.id, qa.id, locked.id, untyped.id] };
}

function unzip(buf: ArrayBuffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(unzipSync(new Uint8Array(buf)))) out[name] = strFromU8(bytes);
  return out;
}

function reasons(refused: SharingRefusal[]): Record<string, string> {
  return Object.fromEntries(refused.map((r) => [r.document_id, r.reason]));
}

async function auditRows(action: string): Promise<{ user_id: string | null; resource_id: string | null; details: any }[]> {
  const res = await db
    .prepare('SELECT user_id, resource_id, details FROM audit_log WHERE action = ? ORDER BY id DESC')
    .bind(action)
    .all<{ user_id: string | null; resource_id: string | null; details: string }>();
  return (res.results ?? []).map((r) => ({ ...r, details: JSON.parse(r.details) }));
}

async function qaReleaseRows(documentId: string) {
  return (await auditRows('document.qa_release_approved')).filter((r) =>
    (r.details.document_ids as string[]).includes(documentId),
  );
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

/** What each caller may take out of [free, qa, locked, untyped] when it LEAVES. */
const LEAVES: Record<ActorName, { goes: ('free' | 'qa')[]; refused: Record<string, string> }> = {
  reader: { goes: ['free'], refused: { qa: 'needs_qa', locked: 'locked', untyped: 'locked' } },
  user: { goes: ['free'], refused: { qa: 'needs_qa', locked: 'locked', untyped: 'locked' } },
  qa: { goes: ['free', 'qa'], refused: { locked: 'locked', untyped: 'locked' } },
  org_admin: { goes: ['free', 'qa'], refused: { locked: 'locked', untyped: 'locked' } },
  api_key: { goes: ['free'], refused: { qa: 'needs_qa', locked: 'locked', untyped: 'locked' } },
};

function expectedRefusals(set: DocSet, actor: ActorName): Record<string, string> {
  return Object.fromEntries(
    Object.entries(LEAVES[actor].refused).map(([k, reason]) => [set[k as 'qa' | 'locked' | 'untyped'].id, reason]),
  );
}

beforeAll(async () => {
  seed = await seedTestData(db);

  supplierId = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(supplierId, seed.tenantId, 'Northfield Creamery', `northfield-${supplierId.slice(0, 5)}`)
    .run();

  // free: NOT stored -- resolved from the type's name, the way every existing
  // type reads until the backfill runs. qa and locked: stored.
  types.free = generateTestId();
  types.qa = generateTestId();
  types.locked = generateTestId();
  await db
    .prepare('INSERT INTO document_types (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(types.free, seed.tenantId, 'Certificate of Analysis', `coa-${types.free.slice(0, 5)}`)
    .run();
  await db
    .prepare('INSERT INTO document_types (id, tenant_id, name, slug, sharing_rule) VALUES (?, ?, ?, ?, ?)')
    .bind(types.qa, seed.tenantId, 'Letter of Guarantee', `log-${types.qa.slice(0, 5)}`, 'qa')
    .run();
  await db
    .prepare('INSERT INTO document_types (id, tenant_id, name, slug, sharing_rule) VALUES (?, ?, ?, ?, ?)')
    .bind(types.locked, seed.tenantId, 'W-9', `w9-${types.locked.slice(0, 5)}`, 'locked')
    .run();

  // The QA route: an ordinary user, named on the `QA` owner label.
  qaUserId = generateTestId();
  await db
    .prepare(
      `INSERT INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
       VALUES (?, ?, 'Quality Lead', 'user', ?, 'x', 1, 0)`,
    )
    .bind(qaUserId, `qa-${qaUserId.slice(0, 6)}@test.com`, seed.tenantId)
    .run();
  await db
    .prepare(
      `INSERT INTO owner_routes (id, tenant_id, owner_key, owner_label, user_id, active)
       VALUES (?, ?, 'qa', 'QA', ?, 1)`,
    )
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
// Who may release
// ===========================================================================

describe('canReleaseQa -- who "QA" is (C-040)', () => {
  it('admins always; a person on the QA route; never a reader, never somebody else', async () => {
    expect(await canReleaseQa(db, person('org_admin'), seed.tenantId)).toBe(true);
    expect(await canReleaseQa(db, { id: seed.superAdminId, role: 'super_admin', tenant_id: null }, seed.tenantId)).toBe(true);
    expect(await canReleaseQa(db, person('qa'), seed.tenantId)).toBe(true);
    expect(await canReleaseQa(db, person('user'), seed.tenantId)).toBe(false);
    expect(await canReleaseQa(db, person('reader'), seed.tenantId)).toBe(false);
    // Another organization's admin is nobody here.
    expect(
      await canReleaseQa(db, { id: seed.orgAdmin2Id, role: 'org_admin', tenant_id: seed.tenantId2 }, seed.tenantId),
    ).toBe(false);
  });

  it('a reader on the QA route still cannot release', async () => {
    const routeId = generateTestId();
    await db
      .prepare(`INSERT INTO owner_routes (id, tenant_id, owner_key, owner_label, user_id, active) VALUES (?, ?, 'qa', 'QA', ?, 1)`)
      .bind(routeId, seed.tenantId, seed.readerId)
      .run();
    expect(await canReleaseQa(db, person('reader'), seed.tenantId)).toBe(false);
    await db.prepare('DELETE FROM owner_routes WHERE id = ?').bind(routeId).run();
  });

  it('with no QA route, the master user; with one, the master user is not asked', async () => {
    // The second organization has no QA route at all.
    const masterId = generateTestId();
    const otherId = generateTestId();
    for (const [id, name] of [[masterId, 'Master'], [otherId, 'Other']] as const) {
      await db
        .prepare(
          `INSERT INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
           VALUES (?, ?, ?, 'user', ?, 'x', 1, 0)`,
        )
        .bind(id, `${id.slice(0, 8)}@other.test`, name, seed.tenantId2)
        .run();
    }
    const master = { id: masterId, role: 'user' as const, tenant_id: seed.tenantId2 };
    const other = { id: otherId, role: 'user' as const, tenant_id: seed.tenantId2 };

    expect(await canReleaseQa(db, master, seed.tenantId2)).toBe(false);
    await db.prepare('UPDATE tenants SET default_owner_user_id = ? WHERE id = ?').bind(masterId, seed.tenantId2).run();
    expect(await canReleaseQa(db, master, seed.tenantId2)).toBe(true);
    expect(await canReleaseQa(db, other, seed.tenantId2)).toBe(false);

    // Once a QA route names somebody, that route is the answer.
    const routeId = generateTestId();
    await db
      .prepare(`INSERT INTO owner_routes (id, tenant_id, owner_key, owner_label, user_id, active) VALUES (?, ?, 'qa', 'QA', ?, 1)`)
      .bind(routeId, seed.tenantId2, otherId)
      .run();
    expect(await canReleaseQa(db, other, seed.tenantId2)).toBe(true);
    expect(await canReleaseQa(db, master, seed.tenantId2)).toBe(false);

    await db.prepare('DELETE FROM owner_routes WHERE id = ?').bind(routeId).run();
    await db.prepare('UPDATE tenants SET default_owner_user_id = NULL WHERE id = ?').bind(seed.tenantId2).run();
  });
});

// ===========================================================================
// One file in the portal
// ===========================================================================

describe('GET /api/documents/:id/download', () => {
  it.each(PEOPLE)('%s opens all four: one file in the portal is not leaving (C-039)', async (actor) => {
    const set = await makeSet();
    for (const doc of [set.free, set.qa, set.locked, set.untyped]) {
      const res = await downloadDocument(
        as(actor, `http://localhost/api/documents/${doc.id}/download`, { params: { id: doc.id } }),
      );
      expect(res.status, `${actor} / ${doc.title}`).toBe(200);
      expect(await res.text()).toBe(doc.body);
    }
  });

  it('an API key reads the free one only, and the refusal says why (C-041)', async () => {
    const set = await makeSet();
    const ok = await downloadDocument(
      as('api_key', `http://localhost/api/documents/${set.free.id}/download`, { params: { id: set.free.id } }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe(set.free.body);

    for (const [doc, reason] of [
      [set.qa, 'needs_qa'],
      [set.locked, 'locked'],
      [set.untyped, 'locked'],
    ] as const) {
      const res = await downloadDocument(
        as('api_key', `http://localhost/api/documents/${doc.id}/download`, { params: { id: doc.id } }),
      );
      expect(res.status, doc.title).toBe(403);
      const body = (await readJson(res)) as { code: string; reason: string; error: string };
      expect(body.code).toBe('sharing_rule_refused');
      expect(body.reason).toBe(reason);
      expect(body.error.length).toBeGreaterThan(10);
    }

    const refusedAudit = (await auditRows('document.sharing_rule_refused')).filter(
      (r) => r.resource_id === set.locked.id,
    );
    expect(refusedAudit).toHaveLength(1);
    expect(refusedAudit[0].details).toMatchObject({ via: 'api_key', api_key_id: 'key-under-test', rule: 'locked' });
  });

  it('a real key through the real middleware is recognised as a key', async () => {
    const set = await makeSet();
    const raw = `dox_sk_${generateTestId().replace(/[^a-z0-9]/gi, '')}${Math.random().toString(16).slice(2)}`;
    await db
      .prepare(
        `INSERT INTO api_keys (id, name, key_hash, key_prefix, user_id, tenant_id, permissions, revoked)
         VALUES (?, 'exit test key', ?, ?, ?, ?, '["*"]', 0)`,
      )
      .bind(generateTestId(), await hashApiKey(raw), raw.slice(0, 12), seed.orgAdminId, seed.tenantId)
      .run();

    const through = async (docId: string, headers: Record<string, string>) => {
      const [, authFn] = middleware;
      const request = new Request(`http://localhost/api/documents/${docId}/download`, { headers });
      const data: Record<string, unknown> = {};
      const base = { request, env, data, params: { id: docId }, waitUntil: () => {}, passThroughOnException: () => {}, functionPath: '' };
      return authFn({ ...base, next: async () => downloadDocument({ ...base, next: async () => new Response(null) } as any) } as any);
    };

    expect((await through(set.free.id, { 'X-API-Key': raw })).status).toBe(200);
    expect((await through(set.locked.id, { 'X-API-Key': raw })).status).toBe(403);
    expect((await through(set.qa.id, { 'X-API-Key': raw })).status).toBe(403);
  });

  it('the packet original takes the strictest rule of every document citing it (C-042)', async () => {
    // One packet, two parts split from it: a COA (free) and a letter (qa).
    const packetId = generateTestId();
    const packetKey = `pending/${packetId}.pdf`;
    await files.put(packetKey, new TextEncoder().encode('THE-WHOLE-PACKET'));
    await db
      .prepare(
        `INSERT INTO processing_queue
           (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type,
            processing_status, output_kind, status, created_by, created_at)
         VALUES (?, ?, NULL, ?, 'packet.pdf', 16, 'application/pdf', 'ready', 'coa', 'approved', ?, datetime('now'))`,
      )
      .bind(packetId, seed.tenantId, packetKey, seed.userId)
      .run();
    const partA = await makeDocument(types.free, 'Packet part A');
    const partB = await makeDocument(types.free, 'Packet part B');
    for (const part of [partA, partB]) {
      await db
        .prepare('UPDATE document_versions SET source_packet_queue_id = ? WHERE document_id = ?')
        .bind(packetId, part.id)
        .run();
    }
    const url = `http://localhost/api/documents/${partA.id}/download?source=packet`;

    // Both parts free: a key may read the packet.
    const open = await downloadDocument(as('api_key', url, { params: { id: partA.id } }));
    expect(open.status).toBe(200);
    expect(await open.text()).toBe('THE-WHOLE-PACKET');

    // Part B becomes a qa document. Part A is still free -- but the packet
    // holds B's pages too.
    await db.prepare('UPDATE documents SET document_type_id = ? WHERE id = ?').bind(types.qa, partB.id).run();
    const shut = await downloadDocument(as('api_key', url, { params: { id: partA.id } }));
    expect(shut.status).toBe(403);
    expect(((await readJson(shut)) as { reason: string }).reason).toBe('needs_qa');
    // Part A's own file is still its own rule.
    const own = await downloadDocument(
      as('api_key', `http://localhost/api/documents/${partA.id}/download`, { params: { id: partA.id } }),
    );
    expect(own.status).toBe(200);
    await own.text();

    // A logged-in reader is unchanged.
    const person = await downloadDocument(as('reader', url, { params: { id: partA.id } }));
    expect(person.status).toBe(200);
    await person.text();
  });
});

// ===========================================================================
// ZIP
// ===========================================================================

describe('POST /api/document-exports/zip', () => {
  it.each(EVERYONE)('%s: what may go goes, and what may not is named', async (actor) => {
    const set = await makeSet();
    const res = await exportZip(
      as(actor, 'http://localhost/api/document-exports/zip', {
        method: 'POST',
        body: JSON.stringify({ document_ids: set.ids }),
      }),
    );
    expect(res.status).toBe(200);
    const want = LEAVES[actor];

    expect(res.headers.get('X-Export-Documents')).toBe(String(want.goes.length));
    expect(res.headers.get('X-Export-Refused')).toBe(String(Object.keys(want.refused).length));
    const header = Object.fromEntries(
      (res.headers.get('X-Export-Refused-Ids') ?? '').split(',').map((p) => p.split(':') as [string, string]),
    );
    expect(header).toEqual(expectedRefusals(set, actor));

    const zip = unzip(await res.arrayBuffer());
    const bodies = Object.entries(zip).filter(([n]) => n !== 'manifest.csv').map(([, b]) => b);
    expect(bodies.sort()).toEqual(want.goes.map((k) => set[k].body).sort());
    // Nothing held back is in the archive, under any name.
    for (const k of Object.keys(want.refused) as ('qa' | 'locked' | 'untyped')[]) {
      expect(bodies).not.toContain(set[k].body);
    }

    // The manifest says what was left out and why.
    const manifest = zip['manifest.csv'];
    expect(manifest).toContain('"Not included"');
    expect(manifest).toContain('Tax form');
    expect(manifest).toContain('Locked');
    if (want.refused.qa) expect(manifest).toContain('Needs QA approval');

    // The audit row names what was refused, with the reason.
    const audit = (await auditRows('document_export.zip')).find((r) =>
      (r.details.requested_ids as string[]).includes(set.free.id),
    )!;
    expect(audit.details.document_ids.sort()).toEqual(want.goes.map((k) => set[k].id).sort());
    expect(
      Object.fromEntries((audit.details.refused as { document_id: string; reason: string }[]).map((r) => [r.document_id, r.reason])),
    ).toEqual(expectedRefusals(set, actor));
    expect(audit.details.via).toBe(actor === 'api_key' ? 'api_key' : 'jwt');

    // A QA releaser zipping a qa document IS the approval, and only then.
    const released = await qaReleaseRows(set.qa.id);
    if (actor === 'qa' || actor === 'org_admin') {
      expect(released).toHaveLength(1);
      expect(released[0].user_id).toBe(person(actor).id);
      expect(released[0].details).toMatchObject({ exit: 'zip', document_ids: [set.qa.id] });
    } else {
      expect(released).toHaveLength(0);
    }
  });

  it('answers 403 naming every document when nothing may go', async () => {
    const set = await makeSet();
    const res = await exportZip(
      as('reader', 'http://localhost/api/document-exports/zip', {
        method: 'POST',
        body: JSON.stringify({ document_ids: [set.qa.id, set.locked.id, set.untyped.id] }),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await readJson(res)) as SharingRuleRefusedResponse;
    expect(body.code).toBe('sharing_rule_refused');
    expect(reasons(body.refused)).toEqual({
      [set.qa.id]: 'needs_qa',
      [set.locked.id]: 'locked',
      [set.untyped.id]: 'locked',
    });
    expect(body.refused.map((r) => r.title).sort()).toEqual(['Guarantee letter', 'Tax form', 'Unsorted scan']);
    expect(body.refused.every((r) => r.message.length > 10)).toBe(true);
    expect(body.error).toContain('3 documents were not included');

    const audit = (await auditRows('document_export.refused'))[0];
    expect(audit.details.exit).toBe('zip');
  });

  it("another organization's id stays plain missing, never a refusal", async () => {
    const set = await makeSet();
    const foreign = generateTestId();
    await db
      .prepare(
        `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by)
         VALUES (?, ?, 'Foreign', '[]', 1, 'active', ?)`,
      )
      .bind(foreign, seed.tenantId2, seed.orgAdmin2Id)
      .run();
    const res = await exportZip(
      as('org_admin', 'http://localhost/api/document-exports/zip', {
        method: 'POST',
        body: JSON.stringify({ document_ids: [set.free.id, foreign] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Export-Missing')).toBe('1');
    expect(res.headers.get('X-Export-Refused')).toBe('0');
    expect(res.headers.get('X-Export-Refused-Ids')).toBeNull();
    await res.arrayBuffer();
  });
});

// ===========================================================================
// The emailed link
// ===========================================================================

describe('POST /api/document-exports/send', () => {
  async function send(actor: ActorName, ids: string[]) {
    const res = await exportSend(
      as(actor, 'http://localhost/api/document-exports/send', {
        method: 'POST',
        body: JSON.stringify({ document_ids: ids, recipients: ['buyer@harbor.example'] }),
      }),
    );
    return { status: res.status, body: (await readJson(res)) as DocumentExportSendResponse & SharingRuleRefusedResponse };
  }

  it('a reader still cannot send at all', async () => {
    const set = await makeSet();
    stubMail();
    expect((await send('reader', set.ids)).status).toBe(403);
  });

  it.each(['user', 'qa', 'org_admin', 'api_key'] as ActorName[])(
    '%s: the link carries only what may go, and the response names the rest',
    async (actor) => {
      const set = await makeSet();
      const mails = stubMail();
      const { status, body } = await send(actor, set.ids);
      expect(status).toBe(200);
      const want = LEAVES[actor];
      expect(body.document_count).toBe(want.goes.length);
      expect(reasons(body.refused)).toEqual(expectedRefusals(set, actor));
      expect(body.refused.find((r) => r.document_id === set.locked.id)!.title).toBe('Tax form');
      expect(body.qa_released_ids).toEqual(actor === 'qa' || actor === 'org_admin' ? [set.qa.id] : []);

      // The link's frozen list is exactly what went.
      const link = await db
        .prepare('SELECT id, document_ids FROM document_export_links WHERE token = ?')
        .bind(tokenFrom(mails))
        .first<{ id: string; document_ids: string }>();
      expect(JSON.parse(link!.document_ids).sort()).toEqual(want.goes.map((k) => set[k].id).sort());

      const released = await qaReleaseRows(set.qa.id);
      if (actor === 'qa' || actor === 'org_admin') {
        expect(released).toHaveLength(1);
        expect(released[0].resource_id).toBe(link!.id);
        expect(released[0].details.exit).toBe('send');
      } else {
        expect(released).toHaveLength(0);
      }
    },
  );

  it('mints nothing and mails nothing when nothing may go', async () => {
    const set = await makeSet();
    const mails = stubMail();
    const before = await db.prepare('SELECT COUNT(*) AS n FROM document_export_links').first<{ n: number }>();
    const { status, body } = await send('user', [set.qa.id, set.locked.id]);
    expect(status).toBe(403);
    expect(body.code).toBe('sharing_rule_refused');
    expect(reasons(body.refused)).toEqual({ [set.qa.id]: 'needs_qa', [set.locked.id]: 'locked' });
    expect(mails).toHaveLength(0);
    const after = await db.prepare('SELECT COUNT(*) AS n FROM document_export_links').first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });
});

// ===========================================================================
// The public link, read later
// ===========================================================================

describe('a public export link is re-checked on every read', () => {
  async function landing(token: string): Promise<DocumentExportLandingView> {
    const res = await exportLanding(fnContext(`http://localhost/api/document-exports/public/${token}`, { params: { token } }));
    expect(res.status).toBe(200);
    return (await readJson(res)) as DocumentExportLandingView;
  }

  it('a qa document minted onto a link by a QA releaser stays served; one locked since is not', async () => {
    const set = await makeSet();
    const mails = stubMail();
    const res = await exportSend(
      as('qa', 'http://localhost/api/document-exports/send', {
        method: 'POST',
        body: JSON.stringify({ document_ids: [set.free.id, set.qa.id], recipients: ['buyer@harbor.example'] }),
      }),
    );
    expect(res.status).toBe(200);
    const token = tokenFrom(mails);
    vi.unstubAllGlobals();

    // As sent: both, including the qa one, to a recipient with no account.
    const first = await landing(token);
    expect(first.documents).toHaveLength(2);
    expect(first.unavailable_count).toBe(0);
    const qaFile = await exportLandingFile(
      fnContext(`http://localhost/api/document-exports/public/${token}/file/1`, { params: { token, index: '1' } }),
    );
    expect(qaFile.status).toBe(200);
    expect(await qaFile.text()).toBe(set.qa.body);

    // The free document is locked after the fact.
    await db.prepare(`UPDATE documents SET sharing_rule_override = 'locked' WHERE id = ?`).bind(set.free.id).run();

    const second = await landing(token);
    expect(second.documents).toHaveLength(1);
    // Told how many are gone, and nothing about which or why.
    expect(second.unavailable_count).toBe(1);
    expect(JSON.stringify(second)).not.toContain('locked');
    expect(JSON.stringify(second)).not.toContain(set.free.id);

    const zipRes = await exportLandingZip(
      fnContext(`http://localhost/api/document-exports/public/${token}/download`, { params: { token } }),
    );
    expect(zipRes.status).toBe(200);
    const zip = unzip(await zipRes.arrayBuffer());
    const bodies = Object.entries(zip).filter(([n]) => n !== 'manifest.csv').map(([, b]) => b);
    expect(bodies).toEqual([set.qa.body]);
    expect(zip['manifest.csv']).not.toContain('Not included');

    // No position reaches the locked file any more.
    const zero = await exportLandingFile(
      fnContext(`http://localhost/api/document-exports/public/${token}/file/0`, { params: { token, index: '0' } }),
    );
    expect(await zero.text()).toBe(set.qa.body);
    const one = await exportLandingFile(
      fnContext(`http://localhost/api/document-exports/public/${token}/file/1`, { params: { token, index: '1' } }),
    );
    expect(one.status).toBe(404);

    const audit = (await auditRows('document_export_link.download'))[0];
    expect(audit.details.withheld_ids).toEqual([set.free.id]);
  });

  it('a link whose every document is now locked serves nothing', async () => {
    const set = await makeSet();
    const mails = stubMail();
    await exportSend(
      as('org_admin', 'http://localhost/api/document-exports/send', {
        method: 'POST',
        body: JSON.stringify({ document_ids: [set.free.id], recipients: ['buyer@harbor.example'] }),
      }),
    );
    const token = tokenFrom(mails);
    vi.unstubAllGlobals();
    await db.prepare(`UPDATE documents SET sharing_rule_override = 'locked' WHERE id = ?`).bind(set.free.id).run();

    const view = await landing(token);
    expect(view.documents).toEqual([]);
    expect(view.unavailable_count).toBe(1);
    const zipRes = await exportLandingZip(
      fnContext(`http://localhost/api/document-exports/public/${token}/download`, { params: { token } }),
    );
    expect(zipRes.status).toBe(404);
  });
});

// ===========================================================================
// Bundle ZIP
// ===========================================================================

describe('GET /api/bundles/:id/download', () => {
  async function makeBundle(ids: string[], name = 'Customer package'): Promise<string> {
    const bundleId = generateTestId();
    await db
      .prepare(`INSERT INTO document_bundles (id, tenant_id, name, status, created_by) VALUES (?, ?, ?, 'finalized', ?)`)
      .bind(bundleId, seed.tenantId, name, seed.orgAdminId)
      .run();
    for (const [i, id] of ids.entries()) {
      await db
        .prepare('INSERT INTO document_bundle_items (id, bundle_id, document_id, sort_order) VALUES (?, ?, ?, ?)')
        .bind(generateTestId(), bundleId, id, i)
        .run();
    }
    return bundleId;
  }

  it.each(EVERYONE)('%s: the same rule as the search ZIP, and now an audit row', async (actor) => {
    const set = await makeSet();
    const bundleId = await makeBundle(set.ids);
    const res = await bundleDownload(
      as(actor, `http://localhost/api/bundles/${bundleId}/download`, { params: { id: bundleId } }),
    );
    expect(res.status).toBe(200);
    const want = LEAVES[actor];
    expect(res.headers.get('X-Bundle-Documents')).toBe(String(want.goes.length));
    expect(res.headers.get('X-Bundle-Refused')).toBe(String(Object.keys(want.refused).length));
    const header = Object.fromEntries(
      (res.headers.get('X-Bundle-Refused-Ids') ?? '').split(',').map((p) => p.split(':') as [string, string]),
    );
    expect(header).toEqual(expectedRefusals(set, actor));

    const zip = unzip(await res.arrayBuffer());
    const note = zip['NOT-INCLUDED.txt'];
    const bodies = Object.entries(zip).filter(([n]) => n !== 'NOT-INCLUDED.txt').map(([, b]) => b);
    expect(bodies.sort()).toEqual(want.goes.map((k) => set[k].body).sort());
    // A package missing a document must not look complete.
    expect(note).toContain('Tax form');
    expect(note).toContain('Unsorted scan');
    expect(note).toContain('Locked');
    expect(note.includes('Guarantee letter')).toBe(Boolean(want.refused.qa));

    // The route used to write nothing at all.
    const audit = (await auditRows('bundle.downloaded')).find((r) => r.resource_id === bundleId)!;
    expect(audit.user_id).toBe(actor === 'api_key' ? seed.orgAdminId : person(actor as Exclude<ActorName, 'api_key'>).id);
    expect((audit.details.documents as { document_id: string }[]).map((d) => d.document_id).sort()).toEqual(
      want.goes.map((k) => set[k].id).sort(),
    );
    expect(audit.details.refused).toHaveLength(Object.keys(want.refused).length);

    const released = (await qaReleaseRows(set.qa.id)).filter((r) => r.resource_id === bundleId);
    expect(released).toHaveLength(actor === 'qa' || actor === 'org_admin' ? 1 : 0);
  });

  it('a bundle of only free documents carries no note and refuses nothing', async () => {
    const a = await makeDocument(types.free, 'COA one');
    const b = await makeDocument(types.free, 'COA two');
    const bundleId = await makeBundle([a.id, b.id]);
    const res = await bundleDownload(
      as('reader', `http://localhost/api/bundles/${bundleId}/download`, { params: { id: bundleId } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Bundle-Refused')).toBe('0');
    const zip = unzip(await res.arrayBuffer());
    expect(Object.keys(zip)).toHaveLength(2);
    expect(zip['NOT-INCLUDED.txt']).toBeUndefined();
  });

  it('answers 403 naming every document when nothing may go, and audits the refusal', async () => {
    const set = await makeSet();
    const bundleId = await makeBundle([set.locked.id, set.untyped.id]);
    const res = await bundleDownload(
      as('org_admin', `http://localhost/api/bundles/${bundleId}/download`, { params: { id: bundleId } }),
    );
    expect(res.status).toBe(403);
    const body = (await readJson(res)) as SharingRuleRefusedResponse;
    expect(body.code).toBe('sharing_rule_refused');
    expect(reasons(body.refused)).toEqual({ [set.locked.id]: 'locked', [set.untyped.id]: 'locked' });
    expect((await auditRows('bundle.download_refused')).some((r) => r.resource_id === bundleId)).toBe(true);
    expect((await auditRows('bundle.downloaded')).some((r) => r.resource_id === bundleId)).toBe(false);
  });
});

// ===========================================================================
// Order send and resend
// ===========================================================================

describe('an order send', () => {
  async function orderWith(set: DocSet, picks: string[]): Promise<string> {
    const res = await createOrder(
      fnContext('http://localhost/api/orders', {
        method: 'POST',
        body: JSON.stringify({ order_number: `SO-${generateTestId().slice(0, 8)}`, customer_id: customerId }),
        user: person('user'),
      }),
    );
    expect(res.status).toBe(201);
    const order = ((await readJson(res)) as { order: { id: string } }).order.id;
    const add = await addItems(
      fnContext(`http://localhost/api/orders/${order}/items`, {
        method: 'POST',
        body: JSON.stringify({ document_ids: picks }),
        user: person('user'),
        params: { id: order },
      }),
    );
    expect(add.status).toBe(201);
    void set;
    return order;
  }

  async function preview(actor: ActorName, order: string): Promise<{ status: number; body: OrderSendPreview }> {
    const res = await sendPreview(as(actor, `http://localhost/api/orders/${order}/send-preview`, { params: { id: order } }));
    return { status: res.status, body: (await readJson(res)) as OrderSendPreview };
  }

  async function send(actor: ActorName, order: string, body: Record<string, unknown> = {}) {
    const res = await sendOrder(
      as(actor, `http://localhost/api/orders/${order}/send`, {
        method: 'POST',
        body: JSON.stringify(body),
        params: { id: order },
      }),
    );
    return { status: res.status, body: (await readJson(res)) as OrderSendResponse & { error?: string; code?: string } };
  }

  async function orderStatus(order: string): Promise<string> {
    const res = await getOrder(fnContext(`http://localhost/api/orders/${order}`, { user: person('user'), params: { id: order } }));
    return ((await readJson(res)) as { order: { status: string } }).order.status;
  }

  it('a reader cannot preview or send', async () => {
    const set = await makeSet({ lots: true });
    const order = await orderWith(set, set.ids);
    expect((await preview('reader', order)).status).toBe(403);
    stubMail();
    expect((await send('reader', order)).status).toBe(403);
  });

  it.each(['user', 'qa', 'org_admin', 'api_key'] as ActorName[])(
    '%s: the review screen lists every held line with its reason, and the send attaches the rest',
    async (actor) => {
      const set = await makeSet({ lots: true });
      const order = await orderWith(set, set.ids);
      const want = LEAVES[actor];

      const plan = (await preview(actor, order)).body;
      expect(plan.files.flatMap((f) => f.document_ids).sort()).toEqual(want.goes.map((k) => set[k].id).sort());
      const held = plan.lines_not_sent.filter((l) => l.sharing_refusal);
      expect(Object.fromEntries(held.map((l) => [l.document_id, l.sharing_refusal]))).toEqual(
        expectedRefusals(set, actor),
      );
      expect(held.every((l) => l.reason.length > 10)).toBe(true);
      expect(plan.warnings.join(' ')).toContain('will not be sent');

      const mails = stubMail();
      const { status, body } = await send(actor, order, { fingerprint: plan.fingerprint });
      expect(status).toBe(200);
      expect(body.send.status).toBe('sent');
      const attached = mails.flatMap((m) => m.attachments ?? []).map((a) => atob(a.content));
      expect(attached.sort()).toEqual(want.goes.map((k) => set[k].body).sort());
      for (const k of Object.keys(want.refused) as ('qa' | 'locked' | 'untyped')[]) {
        expect(attached).not.toContain(set[k].body);
      }
      // Lines were left behind, so the order is not delivered.
      expect(await orderStatus(order)).not.toBe('delivered');

      const released = (await qaReleaseRows(set.qa.id)).filter((r) => r.resource_id === body.send.id);
      expect(released).toHaveLength(actor === 'qa' || actor === 'org_admin' ? 1 : 0);
    },
  );

  it('an order of only free documents is still delivered', async () => {
    const a = await makeDocument(types.free, 'COA a', { lot: String(lotCounter++) });
    const set = { ids: [a.id] } as DocSet;
    const order = await orderWith(set, [a.id]);
    stubMail();
    const { status, body } = await send('user', order);
    expect(status).toBe(200);
    expect(body.order_status).toBe('delivered');
  });

  it('says so when the rule holds back every line', async () => {
    const set = await makeSet({ lots: true });
    const order = await orderWith(set, [set.locked.id, set.qa.id]);
    const plan = (await preview('user', order)).body;
    expect(plan.files).toEqual([]);
    expect(plan.blocked?.code).toBe('nothing_to_send');
    expect(plan.blocked?.message).toContain('sharing rule');
    stubMail();
    expect((await send('user', order)).status).toBe(400);
  });

  it('a plan reviewed before a document was locked is refused, not sent', async () => {
    const set = await makeSet({ lots: true });
    const order = await orderWith(set, [set.free.id]);
    const plan = (await preview('user', order)).body;
    expect(plan.files).toHaveLength(1);

    await db.prepare(`UPDATE documents SET sharing_rule_override = 'locked' WHERE id = ?`).bind(set.free.id).run();
    const mails = stubMail();
    const { status } = await send('user', order, { fingerprint: plan.fingerprint });
    // Nothing is left to send, which the send says before it compares plans.
    expect(status).toBe(400);
    expect(mails).toHaveLength(0);
  });

  it('a resend re-checks the rule before it re-reads a byte', async () => {
    const a = await makeDocument(types.free, 'COA first', { lot: String(lotCounter++) });
    const order = await orderWith({ ids: [a.id] } as DocSet, [a.id]);

    // The first attempt fails at the mail provider: nothing went.
    stubMail(() => true);
    const first = await send('user', order);
    expect(first.status).toBe(502);
    expect(first.body.send.status).toBe('failed');
    vi.unstubAllGlobals();

    // The document is locked before anybody presses resend.
    await db.prepare(`UPDATE documents SET sharing_rule_override = 'locked' WHERE id = ?`).bind(a.id).run();

    const mails = stubMail();
    const resend = async (actor: ActorName) => {
      const res = await resendOrder(
        as(actor, `http://localhost/api/orders/${order}/sends/${first.body.send.id}/resend`, {
          method: 'POST',
          params: { id: order, sendId: first.body.send.id },
        }),
      );
      return { status: res.status, body: (await readJson(res)) as OrderSendResponse };
    };

    // Not for the sender, and not for an administrator either: locked is locked.
    for (const actor of ['user', 'org_admin'] as ActorName[]) {
      const again = await resend(actor);
      expect(again.status).toBe(200);
      expect(again.body.sent).toBe(false);
      expect(again.body.send.status).toBe('failed');
      expect(again.body.send.parts[0].ok).toBe(false);
      expect(again.body.send.parts[0].error).toContain('was not sent');
      expect(again.body.send.parts[0].error).toContain('Locked');
    }
    expect(mails).toHaveLength(0);

    // Unlocked again, the same resend goes.
    await db.prepare(`UPDATE documents SET sharing_rule_override = NULL WHERE id = ?`).bind(a.id).run();
    const ok = await resend('user');
    expect(ok.body.send.status).toBe('sent');
    expect(mails).toHaveLength(1);
    expect(atob(mails[0].attachments![0].content)).toBe(a.body);
  });

  it('a resend of a qa document asks who is pressing resend now', async () => {
    const set = await makeSet({ lots: true });
    const order = await orderWith(set, [set.qa.id]);

    // The QA user sends; the provider fails.
    stubMail(() => true);
    const first = await send('qa', order);
    expect(first.status).toBe(502);
    vi.unstubAllGlobals();

    // The QA user leaves the QA route. They are still the sender of record.
    await db.prepare(`UPDATE owner_routes SET active = 0 WHERE tenant_id = ? AND user_id = ?`).bind(seed.tenantId, qaUserId).run();
    try {
      const mails = stubMail();
      const res = await resendOrder(
        as('qa', `http://localhost/api/orders/${order}/sends/${first.body.send.id}/resend`, {
          method: 'POST',
          params: { id: order, sendId: first.body.send.id },
        }),
      );
      const body = (await readJson(res)) as OrderSendResponse;
      expect(body.send.status).toBe('failed');
      expect(body.send.parts[0].error).toContain('Needs QA approval');
      expect(mails).toHaveLength(0);

      // An administrator pressing resend is a releaser, and is audited as one.
      const adminRes = await resendOrder(
        as('org_admin', `http://localhost/api/orders/${order}/sends/${first.body.send.id}/resend`, {
          method: 'POST',
          params: { id: order, sendId: first.body.send.id },
        }),
      );
      expect(((await readJson(adminRes)) as OrderSendResponse).send.status).toBe('sent');
      expect(mails).toHaveLength(1);
      const released = (await qaReleaseRows(set.qa.id)).filter((r) => r.resource_id === first.body.send.id);
      expect(released).toHaveLength(1);
      expect(released[0].user_id).toBe(seed.orgAdminId);
    } finally {
      await db.prepare(`UPDATE owner_routes SET active = 1 WHERE tenant_id = ? AND user_id = ?`).bind(seed.tenantId, qaUserId).run();
    }
  });
});

// ===========================================================================
// Setting the rule on one document
// ===========================================================================

describe('the override on one document (PUT /api/documents/:id)', () => {
  async function put(actor: ActorName, id: string, body: Record<string, unknown>) {
    const res = await putDocument(
      as(actor, `http://localhost/api/documents/${id}`, { method: 'PUT', body: JSON.stringify(body), params: { id } }),
    );
    return { status: res.status, body: (await readJson(res)) as { error?: string; document?: { sharing: DocumentSharingInfo } } };
  }

  async function sharing(actor: ActorName, id: string): Promise<DocumentSharingInfo> {
    const res = await getDocument(as(actor, `http://localhost/api/documents/${id}`, { params: { id } }));
    expect(res.status).toBe(200);
    return ((await readJson(res)) as { document: { sharing: DocumentSharingInfo } }).document.sharing;
  }

  it('the document page says the rule, where it comes from, and what the caller may do', async () => {
    const set = await makeSet();
    expect(await sharing('reader', set.free.id)).toMatchObject({
      rule: 'free',
      source: 'type_name',
      override: null,
      can_edit: false,
      can_unlock: false,
    });
    expect(await sharing('qa', set.qa.id)).toMatchObject({ rule: 'qa', source: 'type', can_edit: true, can_unlock: false });
    expect(await sharing('org_admin', set.locked.id)).toMatchObject({ rule: 'locked', source: 'type', can_edit: true, can_unlock: true });
    expect(await sharing('user', set.untyped.id)).toMatchObject({ rule: 'locked', source: 'no_type', can_edit: false });
  });

  it('only QA or an admin may set it, and a reason is required', async () => {
    const set = await makeSet();
    const denied = await put('user', set.qa.id, { sharing_rule_override: 'free', sharing_rule_reason: 'customer asked' });
    expect(denied.status).toBe(403);
    expect((await sharing('user', set.qa.id)).rule).toBe('qa');

    const noReason = await put('qa', set.qa.id, { sharing_rule_override: 'free' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error).toContain('why');

    const bad = await put('qa', set.qa.id, { sharing_rule_override: 'public', sharing_rule_reason: 'x' });
    expect(bad.status).toBe(400);

    const ok = await put('qa', set.qa.id, { sharing_rule_override: 'free', sharing_rule_reason: 'Customer contract requires it' });
    expect(ok.status).toBe(200);
    expect(ok.body.document!.sharing).toMatchObject({
      rule: 'free',
      source: 'override',
      type_rule: 'qa',
      override: 'free',
      override_by_name: 'Quality Lead',
      override_reason: 'Customer contract requires it',
    });

    const audit = (await auditRows('document.sharing_rule_overridden')).find((r) => r.resource_id === set.qa.id)!;
    expect(audit.user_id).toBe(qaUserId);
    expect(audit.details).toMatchObject({
      override: 'free',
      previous_override: null,
      rule: 'free',
      previous_rule: 'qa',
      reason: 'Customer contract requires it',
    });

    // And it now leaves for an ordinary user.
    const zip = await exportZip(
      as('user', 'http://localhost/api/document-exports/zip', { method: 'POST', body: JSON.stringify({ document_ids: [set.qa.id] }) }),
    );
    expect(zip.status).toBe(200);
    await zip.arrayBuffer();
  });

  it('QA may lock a document, but only an administrator may unlock one', async () => {
    const set = await makeSet();
    const lock = await put('qa', set.free.id, { sharing_rule_override: 'locked', sharing_rule_reason: 'Wrong lot on it' });
    expect(lock.status).toBe(200);

    // Not by picking another rule, and not by clearing the override.
    for (const next of ['qa', 'free', null]) {
      const res = await put('qa', set.free.id, { sharing_rule_override: next, sharing_rule_reason: 'changed my mind' });
      expect(res.status, String(next)).toBe(403);
      expect(res.body.error).toContain('administrator');
    }
    // Nor a document locked by its type, or by having no type.
    expect((await put('qa', set.locked.id, { sharing_rule_override: 'qa', sharing_rule_reason: 'r' })).status).toBe(403);
    expect((await put('qa', set.untyped.id, { sharing_rule_override: 'free', sharing_rule_reason: 'r' })).status).toBe(403);

    const cleared = await put('org_admin', set.free.id, { sharing_rule_override: null, sharing_rule_reason: 'Corrected certificate filed' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.document!.sharing).toMatchObject({
      rule: 'free',
      source: 'type_name',
      override: null,
      override_by_name: null,
      override_reason: null,
    });
    const row = await db
      .prepare('SELECT sharing_rule_override AS o, sharing_rule_override_by AS b, sharing_rule_override_reason AS r FROM documents WHERE id = ?')
      .bind(set.free.id)
      .first<{ o: string | null; b: string | null; r: string | null }>();
    expect(row).toEqual({ o: null, b: null, r: null });
  });

  it('sending the value already in force is not a change, and an ordinary edit is untouched', async () => {
    const set = await makeSet();
    const before = (await auditRows('document.sharing_rule_overridden')).length;
    // An editor that posts the field on every save, as a user who may not change it.
    const noop = await put('user', set.free.id, { title: 'Cream COA (renamed)', sharing_rule_override: null });
    expect(noop.status).toBe(200);
    expect((await auditRows('document.sharing_rule_overridden')).length).toBe(before);
    const plain = await put('user', set.free.id, { title: 'Cream COA' });
    expect(plain.status).toBe(200);
  });
});
