/**
 * Getting documents OUT of search (migration 0115).
 *
 * What is worth pinning here is not "it zips". It is the five properties that
 * make handing a customer a link to compliance documents defensible:
 *
 *   1. TENANT ISOLATION IS IN THE SQL. Another tenant's id is *missing*, never
 *      a file in somebody's archive.
 *   2. THE EXPORT IS PROVABLE. One audit row per export, naming every
 *      document — the claim the help text has been making for a while and
 *      which the /reports CSV button never honoured.
 *   3. THE CAP IS STATED, NOT SILENT. An oversized selection is refused with
 *      the number in the message, never truncated to look complete.
 *   4. THE EMAIL SENDS A LINK, NOT ATTACHMENTS, from the portal's own sender
 *      with a reply-to of the human who pressed send. Nobody is impersonated.
 *   5. A LINK CANNOT WIDEN. It shows the documents its email named; expired,
 *      revoked and unknown tokens are indistinguishable 404s.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { unzipSync, strFromU8 } from 'fflate';
import { seedTestData, generateTestId } from '../helpers/db';
import { fnContext, readJson } from '../helpers/requests';
import type { TestUser } from '../helpers/requests';
import { onRequestPost as exportZip } from '../../functions/api/document-exports/zip';
import { onRequestPost as exportSend } from '../../functions/api/document-exports/send';
import { onRequestGet as exportLanding } from '../../functions/api/document-exports/public/[token]';
import { onRequestGet as exportLandingZip } from '../../functions/api/document-exports/public/[token]/download';
import { onRequestGet as exportLandingFile } from '../../functions/api/document-exports/public/[token]/file/[index]';
import { onRequestGet as listLinks } from '../../functions/api/document-exports/links/index';
import { onRequestPost as revokeLink } from '../../functions/api/document-exports/links/[id]/revoke';
import { EXPORT_LINK_TTL_DAYS, EXPORT_MAX_TOTAL_BYTES } from '../../functions/lib/document-export';
import type {
  DocumentExportLandingView,
  DocumentExportLinkListResponse,
  DocumentExportRevokeResponse,
  DocumentExportSendResponse,
} from '../../shared/types';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let supplierId = '';
let docTypeId = '';

/** Sits in the database next to everything the landing page reads. */
const INTERNAL_OWNER = 'INTERNAL-owner-Priya-in-QA-do-not-share';

const USER_FIXTURES: Record<string, { email: string; name: string }> = {
  reader: { email: 'reader@test.com', name: 'Reader User' },
  user: { email: 'user@test.com', name: 'Regular User' },
  org_admin: { email: 'orgadmin@test.com', name: 'Org Admin' },
};

function user(
  role: 'org_admin' | 'reader' | 'user',
  tenantId: string,
  id: string,
): TestUser {
  const f = USER_FIXTURES[role];
  return { id, email: f.email, name: f.name, role, tenant_id: tenantId };
}

interface MadeDoc {
  id: string;
  fileName: string;
  body: string;
}

async function makeDocument(
  opts: {
    tenantId?: string;
    title?: string;
    fileName?: string;
    size?: number;
    withFile?: boolean;
    supplier?: boolean;
    lot?: { number: string; sub?: string; production?: string; status?: string };
  } = {},
): Promise<MadeDoc> {
  const tenantId = opts.tenantId ?? seed.tenantId;
  const id = generateTestId();
  const fileName = opts.fileName ?? `${id.slice(0, 6)}-coa.pdf`;
  const body = 'PDF-BYTES-'.repeat(8) + id;

  await db
    .prepare(
      `INSERT INTO documents
         (id, tenant_id, title, tags, current_version, status, created_by,
          supplier_id, document_type_id, owner)
       VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, ?, ?)`,
    )
    .bind(
      id,
      tenantId,
      opts.title ?? `Doc ${id.slice(0, 5)}`,
      seed.orgAdminId,
      opts.supplier === false ? null : tenantId === seed.tenantId ? supplierId : null,
      tenantId === seed.tenantId ? docTypeId : null,
      INTERNAL_OWNER,
    )
    .run();

  const key = `docs/${id}/${fileName}`;
  await db
    .prepare(
      `INSERT INTO document_versions
         (id, document_id, version_number, file_name, file_size, mime_type, r2_key, uploaded_by)
       VALUES (?, ?, 1, ?, ?, 'application/pdf', ?, ?)`,
    )
    .bind(generateTestId(), id, fileName, opts.size ?? body.length, key, seed.orgAdminId)
    .run();

  if (opts.withFile !== false) {
    await env.FILES.put(key, new TextEncoder().encode(body));
  }

  if (opts.lot) {
    const lotId = generateTestId();
    await db
      .prepare(
        `INSERT INTO lots
           (id, tenant_id, supplier_id, lot_number, lot_key, sub_lot_code,
            production_date, production_date_status, production_date_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'extracted')`,
      )
      .bind(
        lotId,
        tenantId,
        supplierId,
        opts.lot.number,
        `${opts.lot.number}${opts.lot.sub ?? ''}`,
        opts.lot.sub ?? '',
        opts.lot.production ?? null,
        opts.lot.production ? (opts.lot.status ?? 'resolved') : null,
      )
      .run();
    await db
      .prepare('INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)')
      .bind(generateTestId(), id, lotId)
      .run();
  }

  return { id, fileName, body };
}

async function auditRows(action: string): Promise<{ details: string; user_id: string | null }[]> {
  const res = await db
    .prepare('SELECT user_id, details FROM audit_log WHERE action = ? ORDER BY id DESC')
    .bind(action)
    .all<{ user_id: string | null; details: string }>();
  return res.results ?? [];
}

function unzip(buf: ArrayBuffer): Record<string, string> {
  const files = unzipSync(new Uint8Array(buf));
  const out: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(files)) out[name] = strFromU8(bytes);
  return out;
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
}, 30_000);

afterEach(() => {
  vi.unstubAllGlobals();
});

// ===========================================================================
// ZIP
// ===========================================================================

describe('POST /api/document-exports/zip', () => {
  it('zips the selected documents with a manifest naming supplier, type and lot', async () => {
    const a = await makeDocument({
      title: 'Darigold Cream COA',
      lot: { number: '10426203', sub: '03', production: '2026-07-22' },
    });
    const b = await makeDocument({ title: 'Spec Sheet' });

    const res = await exportZip(
      fnContext('http://localhost/api/document-exports/zip', {
        method: 'POST',
        body: JSON.stringify({ document_ids: [a.id, b.id] }),
        user: user('org_admin', seed.tenantId, seed.orgAdminId),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    expect(res.headers.get('X-Export-Documents')).toBe('2');

    const files = unzip(await res.arrayBuffer());
    expect(Object.keys(files)).toContain('manifest.csv');
    expect(files[a.fileName]).toBe(a.body);
    expect(files[b.fileName]).toBe(b.body);

    const manifest = files['manifest.csv'];
    expect(manifest).toContain('Darigold Cream COA');
    expect(manifest).toContain('Darigold, Inc.');
    expect(manifest).toContain('Certificate of Analysis');
    expect(manifest).toContain('10426203 / 03');
    expect(manifest).toContain('2026-07-22');
    expect(manifest).toContain(a.fileName);
    // The manifest describes the export; it never carries an internal id.
    expect(manifest).not.toContain(a.id);
  });

  it('writes ONE audit row naming every document in the export', async () => {
    const a = await makeDocument({ title: 'Provable A' });
    const b = await makeDocument({ title: 'Provable B' });
    const before = (await auditRows('document_export.zip')).length;

    await exportZip(
      fnContext('http://localhost/api/document-exports/zip', {
        method: 'POST',
        body: JSON.stringify({ document_ids: [a.id, b.id] }),
        user: user('org_admin', seed.tenantId, seed.orgAdminId),
      }),
    );

    const rows = await auditRows('document_export.zip');
    expect(rows.length).toBe(before + 1);
    const details = JSON.parse(rows[0].details) as {
      document_ids: string[];
      document_count: number;
    };
    expect(rows[0].user_id).toBe(seed.orgAdminId);
    expect(details.document_ids.sort()).toEqual([a.id, b.id].sort());
    expect(details.document_count).toBe(2);
  });

  it('a reader may export — the same bar as downloading one document', async () => {
    const a = await makeDocument({ title: 'Reader may have this' });
    const res = await exportZip(
      fnContext('http://localhost/api/document-exports/zip', {
        method: 'POST',
        body: JSON.stringify({ document_ids: [a.id] }),
        user: user('reader', seed.tenantId, seed.readerId),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("another tenant's document is missing, not exported", async () => {
    const mine = await makeDocument({ title: 'Mine' });
    const theirs = await makeDocument({ tenantId: seed.tenantId2, title: 'Theirs' });

    const res = await exportZip(
      fnContext('http://localhost/api/document-exports/zip', {
        method: 'POST',
        body: JSON.stringify({ document_ids: [mine.id, theirs.id] }),
        user: user('org_admin', seed.tenantId, seed.orgAdminId),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Export-Documents')).toBe('1');
    const files = unzip(await res.arrayBuffer());
    expect(files[theirs.fileName]).toBeUndefined();
    expect(files['manifest.csv']).not.toContain('Theirs');

    const details = JSON.parse((await auditRows('document_export.zip'))[0].details) as {
      missing_ids: string[];
    };
    expect(details.missing_ids).toContain(theirs.id);
  });

  it("refuses a selection over the size cap, and says what the cap is", async () => {
    // file_size is what the guard reads, so one row can stand in for a
    // 90 MB certificate without putting 90 MB in R2.
    const big = await makeDocument({ title: 'Huge scan', size: EXPORT_MAX_TOTAL_BYTES + 1 });

    const res = await exportZip(
      fnContext('http://localhost/api/document-exports/zip', {
        method: 'POST',
        body: JSON.stringify({ document_ids: [big.id] }),
        user: user('org_admin', seed.tenantId, seed.orgAdminId),
      }),
    );

    expect(res.status).toBe(413);
    const body = (await readJson(res)) as { error: string; code: string };
    expect(body.code).toBe('export_too_large');
    expect(body.error).toContain('40 MB');
  });

  it('refuses an empty selection', async () => {
    const res = await exportZip(
      fnContext('http://localhost/api/document-exports/zip', {
        method: 'POST',
        body: JSON.stringify({ document_ids: [] }),
        user: user('org_admin', seed.tenantId, seed.orgAdminId),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('404s when nothing in the selection is available', async () => {
    const res = await exportZip(
      fnContext('http://localhost/api/document-exports/zip', {
        method: 'POST',
        body: JSON.stringify({ document_ids: ['does-not-exist'] }),
        user: user('org_admin', seed.tenantId, seed.orgAdminId),
      }),
    );
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// SEND
// ===========================================================================

interface CapturedMail {
  to: string[];
  subject: string;
  html: string;
  reply_to?: string;
}

function stubMail(ok = true): CapturedMail[] {
  const sent: CapturedMail[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('resend.com')) {
        sent.push(JSON.parse(String(init?.body)) as CapturedMail);
        return new Response('{}', { status: ok ? 200 : 500 });
      }
      return new Response('{}', { status: 200 });
    }),
  );
  return sent;
}

async function sendExport(
  ids: string[],
  over: { recipients?: unknown; on_behalf_of?: string; message?: string } = {},
): Promise<Response> {
  return exportSend(
    fnContext('http://localhost/api/document-exports/send', {
      method: 'POST',
      body: JSON.stringify({
        document_ids: ids,
        recipients: over.recipients ?? ['buyer@customer.example'],
        on_behalf_of: over.on_behalf_of,
        message: over.message,
      }),
      user: user('org_admin', seed.tenantId, seed.orgAdminId),
    }),
  );
}

describe('POST /api/document-exports/send', () => {
  it('refuses a reader: taking documents out is reading, mailing them is not', async () => {
    const sent = stubMail();
    const doc = await makeDocument({ title: 'Not a reader to mail out' });
    const res = await exportSend(
      fnContext('http://localhost/api/document-exports/send', {
        method: 'POST',
        body: JSON.stringify({
          document_ids: [doc.id],
          recipients: ['buyer@customer.example'],
        }),
        user: user('reader', seed.tenantId, seed.readerId),
      }),
    );
    expect(res.status).toBe(403);
    expect(sent.length).toBe(0);
    // And no link was minted for an email that never went.
    const link = await db
      .prepare(
        "SELECT id FROM document_export_links WHERE document_ids LIKE ?",
      )
      .bind(`%${doc.id}%`)
      .first();
    expect(link).toBeNull();
  });

  it('sends a link (never attachments) from the portal, reply-to the sender', async () => {
    const sent = stubMail();
    const doc = await makeDocument({ title: 'Cream COA for Marco' });

    const res = await sendExport([doc.id], {
      on_behalf_of: 'Marco Silva, Sales',
      message: 'The June lots you asked about.',
    });
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as DocumentExportSendResponse;
    expect(body.sent).toBe(true);
    expect(body.document_count).toBe(1);

    expect(sent.length).toBe(1);
    expect(sent[0].to).toEqual(['buyer@customer.example']);
    expect(sent[0].reply_to).toBe('orgadmin@test.com');
    expect(sent[0].html).toContain('on behalf of Marco Silva, Sales');
    expect(sent[0].html).toContain('The June lots you asked about.');

    const link = await db
      .prepare('SELECT token, expires_at, document_ids, recipients FROM document_export_links ORDER BY rowid DESC')
      .first<{ token: string; expires_at: string; document_ids: string; recipients: string }>();
    expect(link).not.toBeNull();
    expect(sent[0].html).toContain(`/export/${link!.token}`);
    expect(JSON.parse(link!.document_ids)).toEqual([doc.id]);
    expect(JSON.parse(link!.recipients)).toEqual(['buyer@customer.example']);
    // No attachment of any kind reaches the mail provider.
    expect(JSON.stringify(sent[0])).not.toContain('attachments');
  });

  it('defaults the link to a 30-day life', async () => {
    stubMail();
    const doc = await makeDocument({ title: 'Expiry default' });
    await sendExport([doc.id]);

    const link = await db
      .prepare('SELECT created_at, expires_at FROM document_export_links ORDER BY rowid DESC')
      .first<{ created_at: string; expires_at: string }>();
    const days =
      (Date.parse(link!.expires_at) - Date.now()) / (1000 * 60 * 60 * 24);
    expect(Math.round(days)).toBe(EXPORT_LINK_TTL_DAYS);
  });

  it('audits the send, naming the recipients and every document', async () => {
    stubMail();
    const doc = await makeDocument({ title: 'Audited send' });
    await sendExport([doc.id], { on_behalf_of: 'Dana in Sales' });

    const rows = await auditRows('document_export.sent');
    const details = JSON.parse(rows[0].details) as {
      recipients: string[];
      document_ids: string[];
      on_behalf_of: string | null;
    };
    expect(details.recipients).toEqual(['buyer@customer.example']);
    expect(details.document_ids).toEqual([doc.id]);
    expect(details.on_behalf_of).toBe('Dana in Sales');
  });

  it('rejects an address that is not one', async () => {
    stubMail();
    const doc = await makeDocument({ title: 'Bad address' });
    const res = await sendExport([doc.id], { recipients: ['not-an-address'] });
    expect(res.status).toBe(400);
  });

  it('revokes the link and reports failure when the mail does not go out', async () => {
    const sent = stubMail(false);
    const doc = await makeDocument({ title: 'Send fails' });
    const res = await sendExport([doc.id]);

    expect(res.status).toBe(502);
    expect(sent.length).toBe(1);
    const link = await db
      .prepare('SELECT revoked_at FROM document_export_links ORDER BY rowid DESC')
      .first<{ revoked_at: string | null }>();
    expect(link!.revoked_at).not.toBeNull();
  });

  it('rate limits sends per user', async () => {
    stubMail();
    const doc = await makeDocument({ title: 'Rate limited' });
    // The bucket is keyed on the user; prime it past the ceiling directly so
    // the test does not have to send thirty emails.
    await db
      .prepare(
        `INSERT INTO rate_limits (key, attempts, window_start)
         VALUES (?, 999, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET attempts = 999, window_start = datetime('now')`,
      )
      .bind(`document_export_send:${seed.orgAdminId}`)
      .run();

    const res = await sendExport([doc.id]);
    expect(res.status).toBe(429);

    await db
      .prepare('DELETE FROM rate_limits WHERE key = ?')
      .bind(`document_export_send:${seed.orgAdminId}`)
      .run();
  });

  it('says so rather than half-sending when email is not configured', async () => {
    stubMail();
    const doc = await makeDocument({ title: 'No resend key' });
    const res = await exportSend({
      request: new Request('http://localhost/api/document-exports/send', {
        method: 'POST',
        body: JSON.stringify({ document_ids: [doc.id], recipients: ['x@y.example'] }),
      }),
      env: { ...env, RESEND_API_KEY: undefined },
      data: { user: user('org_admin', seed.tenantId, seed.orgAdminId) },
      params: {},
      waitUntil: () => {},
      passThroughOnException: () => {},
      next: async () => new Response(null),
      functionPath: '/api/document-exports/send',
    } as never);
    expect(res.status).toBe(503);
  });
});

// ===========================================================================
// THE LANDING PAGE
// ===========================================================================

async function mintedTokenFor(ids: string[]): Promise<string> {
  stubMail();
  const res = await sendExport(ids);
  expect(res.status).toBe(200);
  const link = await db
    .prepare('SELECT token FROM document_export_links ORDER BY rowid DESC')
    .first<{ token: string }>();
  return link!.token;
}

function landingCtx(token: string, extra: Record<string, string> = {}) {
  return fnContext(`http://localhost/api/document-exports/public/${token}`, {
    params: { token, ...extra },
  });
}

describe('GET /api/document-exports/public/:token', () => {
  it('shows exactly the documents the email named, and no internal ids', async () => {
    const a = await makeDocument({
      title: 'Sent certificate',
      lot: { number: '55501', sub: '01', production: '2026-06-02' },
    });
    const notSent = await makeDocument({ title: 'Never sent to anyone' });
    const token = await mintedTokenFor([a.id]);

    const res = await exportLanding(landingCtx(token));
    expect(res.status).toBe(200);
    const view = (await readJson(res)) as DocumentExportLandingView;

    expect(view.documents.length).toBe(1);
    expect(view.documents[0].title).toBe('Sent certificate');
    expect(view.documents[0].index).toBe(0);
    expect(view.documents[0].lot_label).toBe('55501 / 01');
    expect(view.documents[0].production_date).toBe('2026-06-02');

    const raw = JSON.stringify(view);
    expect(raw).not.toContain(a.id);
    expect(raw).not.toContain(notSent.id);
    expect(raw).not.toContain(seed.tenantId);
    expect(raw).not.toContain(INTERNAL_OWNER);
    expect(raw).not.toContain('docs/');
  });

  it('audits every view', async () => {
    const a = await makeDocument({ title: 'Viewed' });
    const token = await mintedTokenFor([a.id]);
    const before = (await auditRows('document_export_link.view')).length;

    await exportLanding(landingCtx(token));

    const rows = await auditRows('document_export_link.view');
    expect(rows.length).toBe(before + 1);
    expect(rows[0].user_id).toBeNull();
  });

  it('404s an unknown, a revoked and an expired token alike', async () => {
    const a = await makeDocument({ title: 'Killable' });
    const token = await mintedTokenFor([a.id]);

    expect((await exportLanding(landingCtx('not-a-real-token-but-long-enough-xxxxx'))).status).toBe(404);

    await db
      .prepare("UPDATE document_export_links SET revoked_at = datetime('now') WHERE token = ?")
      .bind(token)
      .run();
    expect((await exportLanding(landingCtx(token))).status).toBe(404);

    await db
      .prepare("UPDATE document_export_links SET revoked_at = NULL, expires_at = '2020-01-01T00:00:00.000Z' WHERE token = ?")
      .bind(token)
      .run();
    expect((await exportLanding(landingCtx(token))).status).toBe(404);
  });

  it("cannot widen: a foreign document id stored on a link is not served", async () => {
    const mine = await makeDocument({ title: 'On the link' });
    const theirs = await makeDocument({ tenantId: seed.tenantId2, title: 'Other tenant' });
    const token = await mintedTokenFor([mine.id]);

    // Tamper with the stored set the way a widening bug would.
    await db
      .prepare('UPDATE document_export_links SET document_ids = ? WHERE token = ?')
      .bind(JSON.stringify([mine.id, theirs.id]), token)
      .run();

    const view = (await readJson(await exportLanding(landingCtx(token)))) as DocumentExportLandingView;
    expect(view.documents.map((d) => d.title)).toEqual(['On the link']);
  });
});

describe('the recipient download routes', () => {
  it('hands over the zip and audits the download', async () => {
    const a = await makeDocument({ title: 'Zipped for a customer' });
    const token = await mintedTokenFor([a.id]);

    const res = await exportLandingZip(landingCtx(token));
    expect(res.status).toBe(200);
    const files = unzip(await res.arrayBuffer());
    expect(files[a.fileName]).toBe(a.body);
    expect(files['manifest.csv']).toContain('Zipped for a customer');

    expect((await auditRows('document_export_link.download')).length).toBeGreaterThan(0);
  });

  it('serves one file by its POSITION, and 404s a position that is not in the export', async () => {
    const a = await makeDocument({ title: 'First' });
    const b = await makeDocument({ title: 'Second' });
    const token = await mintedTokenFor([a.id, b.id]);

    const first = await exportLandingFile(landingCtx(token, { index: '0' }));
    expect(first.status).toBe(200);
    expect(await first.text()).toBe(a.body);

    const second = await exportLandingFile(landingCtx(token, { index: '1' }));
    expect(await second.text()).toBe(b.body);

    expect((await exportLandingFile(landingCtx(token, { index: '2' }))).status).toBe(404);
    expect((await exportLandingFile(landingCtx(token, { index: 'abc' }))).status).toBe(404);
  });

  it('refuses every recipient route once the link is revoked', async () => {
    const a = await makeDocument({ title: 'Revoked mid-flight' });
    const token = await mintedTokenFor([a.id]);
    await db
      .prepare("UPDATE document_export_links SET revoked_at = datetime('now') WHERE token = ?")
      .bind(token)
      .run();

    expect((await exportLandingZip(landingCtx(token))).status).toBe(404);
    expect((await exportLandingFile(landingCtx(token, { index: '0' }))).status).toBe(404);
  });
});

// ===========================================================================
// "Documents you sent" — the register and the kill switch (migration 0116)
// ===========================================================================
//
// 0115 shipped `revoked_at` with no reachable revoker and no list of what had
// been sent. What is pinned here is what makes the pair defensible:
//
//   1. A REVOKE REACHES ALL THREE RECIPIENT ROUTES, through the one gate.
//   2. THE LIST NEVER CARRIES THE TOKEN — it is an accountability screen, not
//      a second way to open every export ever sent.
//   3. AN ADMIN SEES THE ORGANIZATION, EVERYBODY ELSE THEIR OWN, and the
//      response names the scope it actually answered in.
//   4. EVERY REVOKE WRITES AN AUDIT ROW, and a second press does not move the
//      first revocation's timestamp.

function linksCtx(
  as: TestUser,
  query = '',
): ReturnType<typeof fnContext> {
  return fnContext(`http://localhost/api/document-exports/links${query}`, { user: as });
}

function revokeCtx(id: string, as: TestUser): ReturnType<typeof fnContext> {
  return fnContext(`http://localhost/api/document-exports/links/${id}/revoke`, {
    method: 'POST',
    params: { id },
    user: as,
  });
}

async function newestLinkId(): Promise<string> {
  const row = await db
    .prepare('SELECT id FROM document_export_links ORDER BY rowid DESC')
    .first<{ id: string }>();
  return row!.id;
}

const orgAdmin = () => user('org_admin', seed.tenantId, seed.orgAdminId);
const plainUser = () => user('user', seed.tenantId, seed.userId);

describe('GET /api/document-exports/links', () => {
  it('lists a send with its recipients, counts and state — and never the token', async () => {
    const doc = await makeDocument({ title: 'Listed certificate' });
    const token = await mintedTokenFor([doc.id]);

    const res = await listLinks(linksCtx(orgAdmin()));
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as DocumentExportLinkListResponse;

    const row = body.links.find((l) => l.document_titles.includes('Listed certificate'));
    expect(row).toBeTruthy();
    expect(row!.state).toBe('active');
    expect(row!.document_count).toBe(1);
    expect(row!.recipients).toEqual(['buyer@customer.example']);
    expect(row!.view_count).toBe(0);
    expect(row!.can_revoke).toBe(true);
    // The register must not hand out the credential it exists to police.
    expect(JSON.stringify(body)).not.toContain(token);
  });

  it('counts opens as requests against the link, which is all it can honestly do', async () => {
    const doc = await makeDocument({ title: 'Opened twice' });
    const token = await mintedTokenFor([doc.id]);
    await exportLanding(landingCtx(token));
    await exportLanding(landingCtx(token));
    await exportLandingFile(landingCtx(token, { index: '0' }));

    const body = (await readJson(
      await listLinks(linksCtx(orgAdmin())),
    )) as DocumentExportLinkListResponse;
    const row = body.links.find((l) => l.document_titles.includes('Opened twice'))!;
    expect(row.view_count).toBe(2);
    expect(row.download_count).toBe(1);
    expect(row.last_viewed_at).toBeTruthy();
  });

  it('gives a non-admin only their own sends, whatever scope they ask for', async () => {
    const doc = await makeDocument({ title: 'Admin send' });
    await mintedTokenFor([doc.id]);

    const res = await listLinks(linksCtx(plainUser(), '?scope=tenant'));
    const body = (await readJson(res)) as DocumentExportLinkListResponse;
    expect(body.can_see_tenant).toBe(false);
    // Answered in the scope it was allowed to answer in, not the one asked for.
    expect(body.scope).toBe('mine');
    expect(body.links.every((l) => l.sent_by_id === seed.userId)).toBe(true);
    expect(body.links.some((l) => l.document_titles.includes('Admin send'))).toBe(false);
  });

  it('never reaches another tenant, and reports an expired link as expired', async () => {
    const doc = await makeDocument({ title: 'Expires on its own' });
    await mintedTokenFor([doc.id]);
    const id = await newestLinkId();
    await db
      .prepare("UPDATE document_export_links SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?")
      .bind(id)
      .run();

    const body = (await readJson(
      await listLinks(linksCtx(orgAdmin())),
    )) as DocumentExportLinkListResponse;
    expect(body.links.find((l) => l.id === id)!.state).toBe('expired');
    expect(body.links.every((l) => l.recipients.length > 0 || l.document_count >= 0)).toBe(true);

    const other = await listLinks(
      linksCtx(user('org_admin', 'test-tenant-002', 'user-org-admin-2')),
    );
    const otherBody = (await readJson(other)) as DocumentExportLinkListResponse;
    expect(otherBody.links.some((l) => l.id === id)).toBe(false);
  });
});

describe('POST /api/document-exports/links/:id/revoke', () => {
  it('shuts every recipient route at once and audits who did it', async () => {
    const doc = await makeDocument({ title: 'Mailed to the wrong address' });
    const token = await mintedTokenFor([doc.id]);
    const id = await newestLinkId();

    // Live before.
    expect((await exportLanding(landingCtx(token))).status).toBe(200);

    const res = await revokeLink(revokeCtx(id, orgAdmin()));
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as DocumentExportRevokeResponse;
    expect(body.link.state).toBe('revoked');
    expect(body.link.revoked_at).toBeTruthy();
    expect(body.link.revoked_by_name).toBe('Org Admin');

    // All three recipient routes, not just the landing page.
    expect((await exportLanding(landingCtx(token))).status).toBe(404);
    expect((await exportLandingZip(landingCtx(token))).status).toBe(404);
    expect((await exportLandingFile(landingCtx(token, { index: '0' }))).status).toBe(404);

    const rows = await auditRows('document_export.revoked');
    expect(rows.length).toBeGreaterThan(0);
    const details = JSON.parse(rows[0].details) as {
      recipients: string[];
      document_ids: string[];
      view_count: number;
    };
    expect(details.recipients).toEqual(['buyer@customer.example']);
    expect(details.document_ids).toEqual([doc.id]);
    expect(rows[0].user_id).toBe(seed.orgAdminId);
  });

  it('a second press does not move the first revocation timestamp', async () => {
    const doc = await makeDocument({ title: 'Revoked twice' });
    await mintedTokenFor([doc.id]);
    const id = await newestLinkId();

    const first = (await readJson(
      await revokeLink(revokeCtx(id, orgAdmin())),
    )) as DocumentExportRevokeResponse;
    const second = (await readJson(
      await revokeLink(revokeCtx(id, orgAdmin())),
    )) as DocumentExportRevokeResponse;

    expect(second.link.revoked_at).toBe(first.link.revoked_at);
    const audits = await auditRows('document_export.revoked');
    expect(audits.filter((a) => JSON.parse(a.details).sent_by === seed.orgAdminId).length)
      .toBeGreaterThan(0);
  });

  it("refuses a non-admin somebody else's link, and 404s another tenant's", async () => {
    const doc = await makeDocument({ title: 'Not theirs to revoke' });
    await mintedTokenFor([doc.id]);
    const id = await newestLinkId();

    const denied = await revokeLink(revokeCtx(id, plainUser()));
    expect(denied.status).toBe(403);

    const crossTenant = await revokeLink(
      revokeCtx(id, user('org_admin', 'test-tenant-002', 'user-org-admin-2')),
    );
    expect(crossTenant.status).toBe(404);

    const still = await db
      .prepare('SELECT revoked_at FROM document_export_links WHERE id = ?')
      .bind(id)
      .first<{ revoked_at: string | null }>();
    expect(still!.revoked_at).toBeNull();
  });
});
