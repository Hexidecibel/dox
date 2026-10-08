/**
 * The ways around the sharing rule that a review found, each one closed and
 * each one kept closed by a test here (migration 0137; decisions C-045, C-046).
 *
 *   1. RE-TYPING. The rule comes from the document's type, so changing the
 *      type changed the rule with no check: a W-9 re-typed as a certificate of
 *      analysis walked out. Every write to a document's type now asks first.
 *   2. ANOTHER ORGANIZATION'S TYPE. A document could be pointed at a foreign
 *      type and take that type's rule.
 *   3. (queue and arrival file routes: tests/api/queue-file-fallback.test.ts
 *      and tests/api/request-arrivals.test.ts)
 *   4. AN ADMIN'S API KEY could loosen a rule and then read.
 *   6. THE BUNDLE ZIP served deleted documents, and said nothing about a file
 *      missing from storage.
 *   7. A PUBLIC LINK served a `qa` document whoever had minted the link.
 *   8. An order with more than 100 documents overflowed one SQL statement.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { unzipSync, strFromU8 } from 'fflate';
import { seedTestData, generateTestId } from '../helpers/db';
import { fnContext, readJson } from '../helpers/requests';
import type { TestUser } from '../helpers/requests';
import { loadExportDocuments } from '../../functions/lib/document-export';
import { loadSharingRules } from '../../functions/lib/sharing-rule';
import { onRequestGet as downloadDocument } from '../../functions/api/documents/[id]/download';
import { onRequestGet as getDocument, onRequestPut as putDocument } from '../../functions/api/documents/[id]';
import { onRequestPost as createDocument } from '../../functions/api/documents/index';
import { onRequestPost as ingestDocument } from '../../functions/api/documents/ingest';
import { onRequestPost as ingestUrl } from '../../functions/api/documents/ingest-url';
import { onRequestPut as updateDocumentType } from '../../functions/api/document-types/[id]';
import { onRequestPost as exportZip } from '../../functions/api/document-exports/zip';
import { onRequestPost as exportSend } from '../../functions/api/document-exports/send';
import { onRequestGet as exportLanding } from '../../functions/api/document-exports/public/[token]';
import { onRequestGet as exportLandingZip } from '../../functions/api/document-exports/public/[token]/download';
import { onRequestGet as exportLandingFile } from '../../functions/api/document-exports/public/[token]/file/[index]';
import { onRequestGet as bundleDownload } from '../../functions/api/bundles/[id]/download';
import type { DocumentExportLandingView, DocumentSharingInfo } from '../../shared/types';

const db = env.DB;
const files = env.FILES;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let supplierId = '';
let qaUserId = '';
const types = { free: '', qa: '', locked: '', foreignFree: '' };

type Person = 'reader' | 'user' | 'qa' | 'org_admin';

function person(name: Person): TestUser {
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

/** A handler context. `key: true` = the same person's API key. */
function as(who: Person, url: string, init: RequestInit & { params?: Record<string, string>; key?: boolean } = {}): never {
  const { key, ...rest } = init;
  const ctx = fnContext(url, { ...rest, user: person(who) }) as any;
  ctx.data.authMethod = key ? 'api_key' : 'jwt';
  if (key) ctx.data.apiKeyId = `key-of-${who}`;
  return ctx as never;
}

interface MadeDoc {
  id: string;
  title: string;
  body: string;
  r2Key: string;
}

async function makeDocument(
  typeId: string | null,
  title: string,
  opts: { externalRef?: string; status?: string; withFile?: boolean } = {},
): Promise<MadeDoc> {
  const id = generateTestId();
  const body = `PDF-BYTES-${title}-${id}`;
  await db
    .prepare(
      `INSERT INTO documents
         (id, tenant_id, title, tags, current_version, status, created_by, supplier_id, document_type_id, external_ref)
       VALUES (?, ?, ?, '[]', 1, ?, ?, ?, ?, ?)`,
    )
    .bind(id, seed.tenantId, title, opts.status ?? 'active', seed.orgAdminId, supplierId, typeId, opts.externalRef ?? null)
    .run();
  const r2Key = `docs/${id}/v1.pdf`;
  await db
    .prepare(
      `INSERT INTO document_versions
         (id, document_id, version_number, file_name, file_size, mime_type, r2_key, uploaded_by)
       VALUES (?, ?, 1, ?, ?, 'application/pdf', ?, ?)`,
    )
    .bind(generateTestId(), id, `${title}.pdf`, body.length, r2Key, seed.orgAdminId)
    .run();
  if (opts.withFile !== false) await files.put(r2Key, new TextEncoder().encode(body));
  return { id, title, body, r2Key };
}

async function put(who: Person, id: string, body: Record<string, unknown>, key = false) {
  const res = await putDocument(
    as(who, `http://localhost/api/documents/${id}`, { method: 'PUT', body: JSON.stringify(body), params: { id }, key }),
  );
  return { status: res.status, body: (await readJson(res)) as { error?: string; code?: string; document?: any } };
}

async function typeOf(id: string): Promise<string | null> {
  return (await db.prepare('SELECT document_type_id AS t FROM documents WHERE id = ?').bind(id).first<{ t: string | null }>())!.t;
}

async function ruleOf(id: string): Promise<string> {
  return (await loadSharingRules(db, seed.tenantId, [id])).get(id)!.rule;
}

async function download(who: Person, id: string, key = false): Promise<number> {
  const res = await downloadDocument(as(who, `http://localhost/api/documents/${id}/download`, { params: { id }, key }));
  await res.arrayBuffer();
  return res.status;
}

async function zipBodies(who: Person, ids: string[]): Promise<{ status: number; bodies: string[] }> {
  const res = await exportZip(
    as(who, 'http://localhost/api/document-exports/zip', { method: 'POST', body: JSON.stringify({ document_ids: ids }) }),
  );
  if (res.status !== 200) {
    await res.arrayBuffer();
    return { status: res.status, bodies: [] };
  }
  const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));
  return {
    status: 200,
    bodies: Object.entries(zip).filter(([n]) => n !== 'manifest.csv').map(([, b]) => strFromU8(b)),
  };
}

async function ruleChangedRows(documentId: string) {
  const res = await db
    .prepare(`SELECT user_id, details FROM audit_log WHERE action = 'document.sharing_rule_changed' AND resource_id = ? ORDER BY id`)
    .bind(documentId)
    .all<{ user_id: string | null; details: string }>();
  return (res.results ?? []).map((r) => ({ user_id: r.user_id, ...JSON.parse(r.details) }));
}

interface CapturedMail {
  html: string;
}

function stubMail(): CapturedMail[] {
  const sent: CapturedMail[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('resend.com')) sent.push(JSON.parse(String(init?.body)) as CapturedMail);
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

beforeAll(async () => {
  seed = await seedTestData(db);
  supplierId = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(supplierId, seed.tenantId, 'Northfield Creamery', `northfield-${supplierId.slice(0, 5)}`)
    .run();

  types.free = generateTestId();
  types.qa = generateTestId();
  types.locked = generateTestId();
  types.foreignFree = generateTestId();
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
  // ANOTHER organization's type, stored "send freely".
  await db
    .prepare('INSERT INTO document_types (id, tenant_id, name, slug, sharing_rule) VALUES (?, ?, ?, ?, ?)')
    .bind(types.foreignFree, seed.tenantId2, 'Certificate of Analysis', `coa-${types.foreignFree.slice(0, 5)}`, 'free')
    .run();

  qaUserId = generateTestId();
  await db
    .prepare(
      `INSERT INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
       VALUES (?, ?, 'Quality Lead', 'user', ?, 'x', 1, 0)`,
    )
    .bind(qaUserId, `qa-${qaUserId.slice(0, 6)}@test.com`, seed.tenantId)
    .run();
  await db
    .prepare(`INSERT INTO owner_routes (id, tenant_id, owner_key, owner_label, user_id, active) VALUES (?, ?, 'qa', 'QA', ?, 1)`)
    .bind(generateTestId(), seed.tenantId, qaUserId)
    .run();
}, 30_000);

afterEach(async () => {
  vi.unstubAllGlobals();
  await db.prepare('DELETE FROM rate_limits').run();
});

// ===========================================================================
// 1. Re-typing a document
// ===========================================================================

describe('1. changing a document\'s TYPE cannot loosen its rule without the authority to', () => {
  it('the proven bypass: a user\'s API key re-types a W-9 as a COA and reads it -- refused', async () => {
    const doc = await makeDocument(types.locked, 'Tax form');
    expect(await download('user', doc.id, true)).toBe(403);

    const res = await put('user', doc.id, { document_type_id: types.free }, true);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('sharing_rule_change_refused');
    expect(res.body.error).toContain('API key');
    expect(await typeOf(doc.id)).toBe(types.locked);
    expect(await download('user', doc.id, true)).toBe(403);
  });

  it('the proven bypass: a plain user types an untyped document as a COA and it leaves in a reader\'s ZIP -- refused', async () => {
    const doc = await makeDocument(null, 'Unsorted scan');
    const res = await put('user', doc.id, { document_type_id: types.free });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Only an administrator can unlock');
    expect(await typeOf(doc.id)).toBeNull();
    const zip = await zipBodies('reader', [doc.id]);
    expect(zip.status).toBe(403);
    expect(zip.bodies).toEqual([]);
  });

  it('off "locked" is an administrator\'s act: not a user, not QA, not by a qa type either', async () => {
    const doc = await makeDocument(null, 'Unsorted scan');
    // Locked -> needs QA is still a loosening.
    for (const who of ['user', 'qa'] as Person[]) {
      for (const target of [types.free, types.qa]) {
        const res = await put(who, doc.id, { document_type_id: target });
        expect(res.status, `${who} -> ${target}`).toBe(403);
        expect(res.body.code).toBe('sharing_rule_change_refused');
      }
    }
    // Locked -> locked is no change: anybody who may edit may file it as a W-9.
    expect((await put('user', doc.id, { document_type_id: types.locked })).status).toBe(200);
    expect(await typeOf(doc.id)).toBe(types.locked);
    expect(await ruleChangedRows(doc.id)).toEqual([]);

    const admin = await put('org_admin', doc.id, { document_type_id: types.free });
    expect(admin.status).toBe(200);
    expect(admin.body.document.sharing).toMatchObject({ rule: 'free', source: 'type_name' });
    const rows = await ruleChangedRows(doc.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: seed.orgAdminId,
      from: 'locked',
      to: 'free',
      direction: 'loosened',
      cause: 'type_change',
      via: 'document_edit',
      previous_type_id: types.locked,
      type_id: types.free,
    });
  });

  it('"needs QA" -> "send freely" by re-typing needs a QA releaser', async () => {
    const doc = await makeDocument(types.qa, 'Guarantee letter');
    const user = await put('user', doc.id, { document_type_id: types.free });
    expect(user.status).toBe(403);
    expect(user.body.error).toContain('Only QA or an administrator');
    expect(await typeOf(doc.id)).toBe(types.qa);

    expect((await put('qa', doc.id, { document_type_id: types.free })).status).toBe(200);
    expect(await ruleOf(doc.id)).toBe('free');
    expect((await ruleChangedRows(doc.id))[0]).toMatchObject({ user_id: qaUserId, from: 'qa', to: 'free', cause: 'type_change' });
  });

  it('tightening is open to whoever may edit, and is recorded', async () => {
    const doc = await makeDocument(types.free, 'Cream COA');
    expect((await put('user', doc.id, { document_type_id: types.qa })).status).toBe(200);
    expect((await put('user', doc.id, { document_type_id: types.locked })).status).toBe(200);
    // Clearing the type is tightening too (no type = locked): already locked, so no move.
    expect((await put('user', doc.id, { document_type_id: null })).status).toBe(200);
    expect(await typeOf(doc.id)).toBeNull();
    const rows = await ruleChangedRows(doc.id);
    expect(rows.map((r) => [r.from, r.to, r.direction])).toEqual([
      ['free', 'qa', 'tightened'],
      ['qa', 'locked', 'tightened'],
    ]);
    // A key may tighten as well.
    const other = await makeDocument(types.free, 'Cream COA 2');
    expect((await put('user', other.id, { document_type_id: types.locked }, true)).status).toBe(200);
  });

  it('the same check through the category editor (`categories`), which also writes the type', async () => {
    const doc = await makeDocument(types.locked, 'Tax form');
    const res = await put('user', doc.id, { categories: [types.free], primary_category_id: types.free });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('sharing_rule_change_refused');
    expect(await typeOf(doc.id)).toBe(types.locked);
    // Nothing half-applied: the category set was not written either.
    const cats = await db.prepare('SELECT COUNT(*) AS n FROM document_categories WHERE document_id = ?').bind(doc.id).first<{ n: number }>();
    expect(cats!.n).toBe(0);

    expect((await put('org_admin', doc.id, { categories: [types.free], primary_category_id: types.free })).status).toBe(200);
    expect(await typeOf(doc.id)).toBe(types.free);
  });

  it('a refused type change refuses the WHOLE edit', async () => {
    const doc = await makeDocument(types.locked, 'Tax form');
    const res = await put('user', doc.id, { title: 'Renamed while trying', document_type_id: types.free });
    expect(res.status).toBe(403);
    const row = await db.prepare('SELECT title FROM documents WHERE id = ?').bind(doc.id).first<{ title: string }>();
    expect(row!.title).toBe('Tax form');
  });

  it('an override that pins the rule lets the type change freely: the effective rule did not move', async () => {
    const doc = await makeDocument(types.locked, 'Tax form');
    await db.prepare(`UPDATE documents SET sharing_rule_override = 'locked' WHERE id = ?`).bind(doc.id).run();
    expect((await put('user', doc.id, { document_type_id: types.free })).status).toBe(200);
    expect(await ruleOf(doc.id)).toBe('locked');
    expect(await ruleChangedRows(doc.id)).toEqual([]);
  });

  it('override and type in one request are judged together, before and after', async () => {
    // Type to a free one, but pin it locked in the same edit: nothing loosens.
    const doc = await makeDocument(types.locked, 'Tax form');
    const res = await put('qa', doc.id, {
      document_type_id: types.free,
      sharing_rule_override: 'locked',
      sharing_rule_reason: 'Filed as a COA but must stay in',
    });
    expect(res.status).toBe(200);
    expect(await ruleOf(doc.id)).toBe('locked');
  });

  describe('POST /api/documents/ingest and /ingest-url re-type an existing document on upsert', () => {
    function ingestForm(ref: string, typeId: string | null): FormData {
      const form = new FormData();
      form.append('file', new File([new Blob([`v2-${ref}`], { type: 'application/pdf' })], 'v2.pdf', { type: 'application/pdf' }));
      form.append('tenant_id', seed.tenantId);
      form.append('external_ref', ref);
      if (typeId) form.append('document_type_id', typeId);
      return form;
    }
    async function ingest(who: Person, ref: string, typeId: string | null, key = true) {
      const res = await ingestDocument(
        as(who, 'http://localhost/api/documents/ingest', { method: 'POST', body: ingestForm(ref, typeId), key }),
      );
      return { status: res.status, body: (await readJson(res)) as { error?: string; code?: string } };
    }
    async function versions(id: string): Promise<number> {
      return (await db.prepare('SELECT COUNT(*) AS n FROM document_versions WHERE document_id = ?').bind(id).first<{ n: number }>())!.n;
    }

    it('ingest: a key cannot loosen by naming a looser type; nothing is ingested', async () => {
      const ref = `ext-${generateTestId().slice(0, 8)}`;
      const doc = await makeDocument(types.locked, 'Tax form', { externalRef: ref });

      const refused = await ingest('org_admin', ref, types.free);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('sharing_rule_change_refused');
      expect(refused.body.error).toContain('Nothing was ingested');
      expect(await versions(doc.id)).toBe(1);
      expect(await typeOf(doc.id)).toBe(types.locked);

      // The same type again, or no type, adds the version as it always did.
      expect([200, 201]).toContain((await ingest('org_admin', ref, types.locked)).status);
      expect([200, 201]).toContain((await ingest('org_admin', ref, null)).status);
      expect(await versions(doc.id)).toBe(3);
      expect(await typeOf(doc.id)).toBe(types.locked);
    });

    it('ingest: a logged-in user cannot unlock either; an administrator can, and it is recorded', async () => {
      const ref = `ext-${generateTestId().slice(0, 8)}`;
      const doc = await makeDocument(types.locked, 'Tax form', { externalRef: ref });
      expect((await ingest('user', ref, types.free, false)).status).toBe(403);
      expect(await versions(doc.id)).toBe(1);

      expect([200, 201]).toContain((await ingest('org_admin', ref, types.free, false)).status);
      expect(await typeOf(doc.id)).toBe(types.free);
      expect((await ruleChangedRows(doc.id))[0]).toMatchObject({ from: 'locked', to: 'free', via: 'ingest', cause: 'type_change' });
    });

    it('ingest-url: the same check before the upsert', async () => {
      const ref = `ext-${generateTestId().slice(0, 8)}`;
      const doc = await makeDocument(types.qa, 'Guarantee letter', { externalRef: ref });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('fetched-bytes', { status: 200, headers: { 'Content-Type': 'application/pdf' } })),
      );
      const call = async (typeId: string, who: Person, key: boolean) => {
        const res = await ingestUrl(
          as(who, 'http://localhost/api/documents/ingest-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              file_url: 'https://files.example/letter.pdf',
              external_ref: ref,
              tenant_id: seed.tenantId,
              document_type_id: typeId,
            }),
            key,
          }),
        );
        return { status: res.status, body: (await readJson(res)) as { error?: string; code?: string } };
      };

      const refused = await call(types.free, 'org_admin', true);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('sharing_rule_change_refused');
      expect(await versions(doc.id)).toBe(1);

      // Another organization's type is not accepted at all.
      const foreign = await call(types.foreignFree, 'org_admin', false);
      expect(foreign.status).toBe(400);
      expect(foreign.body.error).toContain('this organization');
      expect(await versions(doc.id)).toBe(1);

      // Tightening through the key is fine.
      expect([200, 201]).toContain((await call(types.locked, 'org_admin', true)).status);
      expect(await typeOf(doc.id)).toBe(types.locked);
    });
  });
});

// ===========================================================================
// 2. Another organization's type
// ===========================================================================

describe('2. a document cannot take its rule from another organization\'s type', () => {
  it('PUT refuses a foreign document_type_id, for an administrator too', async () => {
    const doc = await makeDocument(types.locked, 'Tax form');
    for (const who of ['user', 'org_admin'] as Person[]) {
      const res = await put(who, doc.id, { document_type_id: types.foreignFree });
      expect(res.status, who).toBe(400);
      expect(res.body.error).toContain('does not reference a document type in this organization');
    }
    expect(await typeOf(doc.id)).toBe(types.locked);
  });

  it('POST /api/documents refuses one as well', async () => {
    const res = await createDocument(
      as('org_admin', 'http://localhost/api/documents', {
        method: 'POST',
        body: JSON.stringify({ title: 'New', document_type_id: types.foreignFree }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('a document that ALREADY points at a foreign type reads as having no type: locked', async () => {
    // However it got there (an older write path, a hand edit): the join is
    // tenant scoped, so the foreign type's "send freely" decides nothing.
    const doc = await makeDocument(null, 'Smuggled');
    await db.prepare('UPDATE documents SET document_type_id = ? WHERE id = ?').bind(types.foreignFree, doc.id).run();

    expect(await ruleOf(doc.id)).toBe('locked');
    const res = await getDocument(as('org_admin', `http://localhost/api/documents/${doc.id}`, { params: { id: doc.id } }));
    const sharing = ((await readJson(res)) as { document: { sharing: DocumentSharingInfo } }).document.sharing;
    expect(sharing).toMatchObject({ rule: 'locked', source: 'no_type' });

    expect(await download('org_admin', doc.id, true)).toBe(403);
    expect((await zipBodies('org_admin', [doc.id])).status).toBe(403);
  });
});

// ===========================================================================
// 4. An administrator's API key
// ===========================================================================

describe('4. an API key never loosens a rule, whoever owns it', () => {
  it('the override: an admin\'s key may tighten, not loosen', async () => {
    const doc = await makeDocument(types.qa, 'Guarantee letter');
    const loosen = await put('org_admin', doc.id, { sharing_rule_override: 'free', sharing_rule_reason: 'because' }, true);
    expect(loosen.status).toBe(403);
    expect(loosen.body.code).toBe('sharing_rule_change_refused');
    expect(loosen.body.error).toContain('API key');
    expect(await ruleOf(doc.id)).toBe('qa');
    expect(await download('org_admin', doc.id, true)).toBe(403);

    const tighten = await put('org_admin', doc.id, { sharing_rule_override: 'locked', sharing_rule_reason: 'Wrong lot' }, true);
    expect(tighten.status).toBe(200);
    expect(await ruleOf(doc.id)).toBe('locked');
    // And cannot take that back with the key: clearing the override loosens.
    const clear = await put('org_admin', doc.id, { sharing_rule_override: null, sharing_rule_reason: 'changed my mind' }, true);
    expect(clear.status).toBe(403);
    // The same administrator, logged in, can.
    expect((await put('org_admin', doc.id, { sharing_rule_override: null, sharing_rule_reason: 'Corrected' })).status).toBe(200);
  });

  it('the type\'s own rule: PUT /api/document-types/:id refuses a key that loosens it', async () => {
    const typeId = generateTestId();
    await db
      .prepare('INSERT INTO document_types (id, tenant_id, name, slug, sharing_rule) VALUES (?, ?, ?, ?, ?)')
      .bind(typeId, seed.tenantId, 'Vendor Questionnaire', `vq-${typeId.slice(0, 6)}`, 'qa')
      .run();
    const doc = await makeDocument(typeId, 'Questionnaire');
    const update = async (body: Record<string, unknown>, key: boolean) => {
      const res = await updateDocumentType(
        as('org_admin', `http://localhost/api/document-types/${typeId}`, {
          method: 'PUT',
          body: JSON.stringify(body),
          params: { id: typeId },
          key,
        }),
      );
      return { status: res.status, body: (await readJson(res)) as { error?: string; code?: string } };
    };
    const stored = async () =>
      (await db.prepare('SELECT sharing_rule AS r FROM document_types WHERE id = ?').bind(typeId).first<{ r: string | null }>())!.r;

    const loosen = await update({ sharing_rule: 'free' }, true);
    expect(loosen.status).toBe(403);
    expect(loosen.body.code).toBe('sharing_rule_change_refused');
    expect(await stored()).toBe('qa');
    expect(await download('org_admin', doc.id, true)).toBe(403);

    expect((await update({ sharing_rule: 'locked' }, true)).status).toBe(200);
    expect(await stored()).toBe('locked');
    expect((await update({ sharing_rule: 'qa' }, true)).status).toBe(403);
    // Logged in, the administrator sets it.
    expect((await update({ sharing_rule: 'free' }, false)).status).toBe(200);
    expect(await stored()).toBe('free');
  });

  it('a type with no stored rule is judged by what it READS as, and a rename cannot move it', async () => {
    // Predates 0137: nothing stored, read from its name as "needs QA".
    const typeId = generateTestId();
    await db
      .prepare('INSERT INTO document_types (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
      .bind(typeId, seed.tenantId, 'Vendor Form', `vf-${typeId.slice(0, 6)}`)
      .run();
    const doc = await makeDocument(typeId, 'Form');
    expect(await ruleOf(doc.id)).toBe('qa');
    const update = async (body: Record<string, unknown>, key: boolean) => {
      const res = await updateDocumentType(
        as('org_admin', `http://localhost/api/document-types/${typeId}`, {
          method: 'PUT',
          body: JSON.stringify(body),
          params: { id: typeId },
          key,
        }),
      );
      return res.status;
    };

    // A key cannot loosen what is read from the name, either.
    expect(await update({ sharing_rule: 'free' }, true)).toBe(403);

    // RENAMING it to a name the table reads "send freely" -- by a key or a
    // person -- does not release its documents: the rule it was read as is
    // written down first.
    expect(await update({ name: `Certificate of Analysis ${typeId.slice(0, 4)}` }, true)).toBe(200);
    const row = await db.prepare('SELECT name, sharing_rule AS r FROM document_types WHERE id = ?').bind(typeId).first<{ name: string; r: string | null }>();
    expect(row!.name).toContain('Certificate of Analysis');
    expect(row!.r).toBe('qa');
    expect(await ruleOf(doc.id)).toBe('qa');
    expect(await download('org_admin', doc.id, true)).toBe(403);
    const audit = await db
      .prepare(`SELECT details FROM audit_log WHERE action = 'document_type.sharing_rule_updated' AND resource_id = ?`)
      .bind(typeId)
      .first<{ details: string }>();
    expect(JSON.parse(audit!.details)).toMatchObject({ sharing_rule: 'qa', previous_sharing_rule: null });
  });
});

// ===========================================================================
// 6. The bundle ZIP
// ===========================================================================

describe('6. the bundle ZIP', () => {
  async function makeBundle(ids: string[]): Promise<string> {
    const bundleId = generateTestId();
    await db
      .prepare(`INSERT INTO document_bundles (id, tenant_id, name, status, created_by) VALUES (?, ?, 'Customer package', 'finalized', ?)`)
      .bind(bundleId, seed.tenantId, seed.orgAdminId)
      .run();
    for (const [i, id] of ids.entries()) {
      await db
        .prepare('INSERT INTO document_bundle_items (id, bundle_id, document_id, sort_order) VALUES (?, ?, ?, ?)')
        .bind(generateTestId(), bundleId, id, i)
        .run();
    }
    return bundleId;
  }

  it('does not serve a deleted document', async () => {
    const kept = await makeDocument(types.free, 'Current COA');
    const gone = await makeDocument(types.free, 'Deleted COA', { status: 'deleted' });
    const bundleId = await makeBundle([kept.id, gone.id]);
    const res = await bundleDownload(as('org_admin', `http://localhost/api/bundles/${bundleId}/download`, { params: { id: bundleId } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Bundle-Documents')).toBe('1');
    const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const bodies = Object.values(zip).map((b) => strFromU8(b));
    expect(bodies).toEqual([kept.body]);
    expect(bodies).not.toContain(gone.body);
  });

  it('a bundle of only deleted documents has nothing to give', async () => {
    const gone = await makeDocument(types.free, 'Deleted COA', { status: 'deleted' });
    const bundleId = await makeBundle([gone.id]);
    const res = await bundleDownload(as('org_admin', `http://localhost/api/bundles/${bundleId}/download`, { params: { id: bundleId } }));
    expect(res.status).toBe(400);
  });

  it('says so when a file is missing from storage: in the headers and in NOT-INCLUDED.txt', async () => {
    const present = await makeDocument(types.free, 'Present COA');
    const missing = await makeDocument(types.free, 'Lost COA', { withFile: false });
    const bundleId = await makeBundle([present.id, missing.id]);
    const res = await bundleDownload(as('org_admin', `http://localhost/api/bundles/${bundleId}/download`, { params: { id: bundleId } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Bundle-Documents')).toBe('1');
    expect(res.headers.get('X-Bundle-Unavailable')).toBe('1');
    expect(res.headers.get('X-Bundle-Unavailable-Ids')).toBe(missing.id);
    expect(res.headers.get('X-Bundle-Refused')).toBe('0');
    const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const note = strFromU8(zip['NOT-INCLUDED.txt']);
    expect(note).toContain('1 document is in this bundle but not in this archive');
    expect(note).toContain('Lost COA');
    expect(note).toContain('The file is not in storage.');
  });

  it('a complete bundle says nothing is unavailable', async () => {
    const a = await makeDocument(types.free, 'COA a');
    const bundleId = await makeBundle([a.id]);
    const res = await bundleDownload(as('reader', `http://localhost/api/bundles/${bundleId}/download`, { params: { id: bundleId } }));
    expect(res.headers.get('X-Bundle-Unavailable')).toBe('0');
    expect(res.headers.get('X-Bundle-Unavailable-Ids')).toBeNull();
    const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(zip['NOT-INCLUDED.txt']).toBeUndefined();
  });
});

// ===========================================================================
// 7. A public link and a `qa` document (C-045)
// ===========================================================================

describe('7. a public link serves a `qa` document only on its minter\'s authority (C-045)', () => {
  async function sendAs(who: Person, ids: string[]): Promise<string> {
    const mails = stubMail();
    const res = await exportSend(
      as(who, 'http://localhost/api/document-exports/send', {
        method: 'POST',
        body: JSON.stringify({ document_ids: ids, recipients: ['buyer@harbor.example'] }),
      }),
    );
    expect(res.status).toBe(200);
    const token = tokenFrom(mails);
    vi.unstubAllGlobals();
    return token;
  }
  async function landing(token: string): Promise<DocumentExportLandingView> {
    const res = await exportLanding(fnContext(`http://localhost/api/document-exports/public/${token}`, { params: { token } }));
    expect(res.status).toBe(200);
    return (await readJson(res)) as DocumentExportLandingView;
  }
  async function zipBodiesOf(token: string): Promise<string[] | number> {
    const res = await exportLandingZip(fnContext(`http://localhost/api/document-exports/public/${token}/download`, { params: { token } }));
    if (res.status !== 200) return res.status;
    const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));
    return Object.entries(zip).filter(([n]) => n !== 'manifest.csv').map(([, b]) => strFromU8(b));
  }
  async function fileStatus(token: string, index: number): Promise<number> {
    const res = await exportLandingFile(
      fnContext(`http://localhost/api/document-exports/public/${token}/file/${index}`, { params: { token, index: String(index) } }),
    );
    await res.arrayBuffer();
    return res.status;
  }

  it('minted by a plain user while the document was free: once it becomes qa, it is withheld', async () => {
    const keep = await makeDocument(types.free, 'Stays free');
    const turns = await makeDocument(types.free, 'Becomes qa');
    const token = await sendAs('user', [keep.id, turns.id]);
    expect((await landing(token)).documents).toHaveLength(2);

    // The document becomes "needs QA approval" after the link went out.
    await db.prepare('UPDATE documents SET document_type_id = ? WHERE id = ?').bind(types.qa, turns.id).run();

    const view = await landing(token);
    expect(view.documents).toHaveLength(1);
    expect(view.unavailable_count).toBe(1);
    expect(await zipBodiesOf(token)).toEqual([keep.body]);
    expect(await fileStatus(token, 0)).toBe(200);
    expect(await fileStatus(token, 1)).toBe(404);
  });

  it('minted by a QA releaser: the qa document is served', async () => {
    const letter = await makeDocument(types.qa, 'Guarantee letter');
    const token = await sendAs('qa', [letter.id]);
    const view = await landing(token);
    expect(view.documents).toHaveLength(1);
    expect(view.unavailable_count).toBe(0);
    expect(await zipBodiesOf(token)).toEqual([letter.body]);
    expect(await fileStatus(token, 0)).toBe(200);
  });

  it('minted by a user who has since LOST the QA route: withheld, and served again if they regain it', async () => {
    const letter = await makeDocument(types.qa, 'Guarantee letter');
    const token = await sendAs('qa', [letter.id]);
    expect((await landing(token)).documents).toHaveLength(1);

    await db.prepare('UPDATE owner_routes SET active = 0 WHERE tenant_id = ? AND user_id = ?').bind(seed.tenantId, qaUserId).run();
    try {
      const view = await landing(token);
      expect(view.documents).toEqual([]);
      expect(view.unavailable_count).toBe(1);
      expect(await zipBodiesOf(token)).toBe(404);
      expect(await fileStatus(token, 0)).toBe(404);
    } finally {
      await db.prepare('UPDATE owner_routes SET active = 1 WHERE tenant_id = ? AND user_id = ?').bind(seed.tenantId, qaUserId).run();
    }
    expect((await landing(token)).documents).toHaveLength(1);
  });

  it('a minter whose account is deactivated approves nothing', async () => {
    const adminId = generateTestId();
    await db
      .prepare(
        `INSERT INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
         VALUES (?, ?, 'Former Admin', 'org_admin', ?, 'x', 1, 0)`,
      )
      .bind(adminId, `former-${adminId.slice(0, 6)}@test.com`, seed.tenantId)
      .run();
    const letter = await makeDocument(types.qa, 'Guarantee letter');
    const linkId = generateTestId();
    const token = `tok-${generateTestId()}-${generateTestId()}`;
    await db
      .prepare(
        `INSERT INTO document_export_links (id, token, tenant_id, document_ids, created_by, recipients, expires_at)
         VALUES (?, ?, ?, ?, ?, '["buyer@harbor.example"]', '2999-01-01T00:00:00.000Z')`,
      )
      .bind(linkId, token, seed.tenantId, JSON.stringify([letter.id]), adminId)
      .run();
    expect((await landing(token)).documents).toHaveLength(1);
    await db.prepare('UPDATE users SET active = 0 WHERE id = ?').bind(adminId).run();
    expect((await landing(token)).documents).toEqual([]);
  });

  it('a never-expiring link is held to the same rule, and locked is never served', async () => {
    const letter = await makeDocument(types.free, 'Oversize certificate');
    const token = `tok-${generateTestId()}-${generateTestId()}`;
    await db
      .prepare(
        `INSERT INTO document_export_links (id, token, tenant_id, document_ids, created_by, recipients, expires_at, never_expires)
         VALUES (?, ?, ?, ?, ?, '["buyer@harbor.example"]', '9999-12-31T23:59:59.000Z', 1)`,
      )
      .bind(generateTestId(), token, seed.tenantId, JSON.stringify([letter.id]), seed.userId)
      .run();
    expect((await landing(token)).documents).toHaveLength(1);
    await db.prepare('UPDATE documents SET document_type_id = ? WHERE id = ?').bind(types.qa, letter.id).run();
    expect((await landing(token)).documents).toEqual([]);

    // Minted by an administrator instead: qa is served, locked never.
    await db.prepare('UPDATE document_export_links SET created_by = ? WHERE token = ?').bind(seed.orgAdminId, token).run();
    expect((await landing(token)).documents).toHaveLength(1);
    await db.prepare(`UPDATE documents SET sharing_rule_override = 'locked' WHERE id = ?`).bind(letter.id).run();
    expect((await landing(token)).documents).toEqual([]);
  });
});

// ===========================================================================
// 8. More documents than one SQL statement binds
// ===========================================================================

describe('8. loadExportDocuments reads in chunks', () => {
  it('loads 130 documents, keeps their order, and still judges every one', async () => {
    const ids: string[] = [];
    const stmts = [];
    for (let i = 0; i < 130; i++) {
      const id = generateTestId();
      ids.push(id);
      // Every tenth is locked, so the judgement is visibly applied across chunks.
      stmts.push(
        db
          .prepare(
            `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, document_type_id)
             VALUES (?, ?, ?, '[]', 1, 'active', ?, ?)`,
          )
          .bind(id, seed.tenantId, `Bulk ${i}`, seed.orgAdminId, i % 10 === 0 ? types.locked : types.free),
        db
          .prepare(
            `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, uploaded_by)
             VALUES (?, ?, 1, 'bulk.pdf', 10, 'application/pdf', ?, ?)`,
          )
          .bind(generateTestId(), id, `docs/${id}/v1.pdf`, seed.orgAdminId),
      );
    }
    for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));

    const loaded = await loadExportDocuments(db, seed.tenantId, [...ids, 'no-such-document'], {
      exit: 'order_send',
      actor: { method: 'jwt', canReleaseQa: false },
    });
    expect(loaded.rows).toHaveLength(117);
    expect(loaded.refused).toHaveLength(13);
    expect(loaded.missing_ids).toEqual(['no-such-document']);
    // In the order asked.
    expect(loaded.rows.map((r) => r.document_id)).toEqual(ids.filter((_, i) => i % 10 !== 0));
    expect(loaded.rows.every((r) => r.document_type_name === 'Certificate of Analysis')).toBe(true);
  });
});
