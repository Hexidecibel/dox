/**
 * Supplier contacts (migration 0133), and the two older paths that now feed or
 * depend on them:
 *
 *   1. /api/suppliers/:id/contacts -- the address a renewal request goes to.
 *      At most ONE active document contact per supplier, every change audited
 *      with what it replaced.
 *   2. The verified supplier list import, whose `Supplier contact email`
 *      column was parsed and thrown away until there was a table to put it in.
 *   3. PUT /api/documents/:id: a renewal date changed after approval is a
 *      DECISION (D-041) -- who, why, and the original proposal kept.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables, generateTestId } from '../helpers/db';
import {
  onRequestGet as contactsGet,
  onRequestPost as contactsPost,
} from '../../functions/api/suppliers/[id]/contacts/index';
import {
  onRequestPut as contactPut,
  onRequestDelete as contactDelete,
} from '../../functions/api/suppliers/[id]/contacts/[contactId]';
import { onRequestPost as importPost } from '../../functions/api/supplier-list/import';
import { onRequestPut as docPut } from '../../functions/api/documents/[id]';
import { applyStarterPack } from '../../functions/lib/starter-packs';
import { getStarterPack } from '../../functions/lib/starterPacks.generated';
import { computeExpirations } from '../../functions/lib/expirations';
import type { SupplierContactsResponse } from '../../shared/types';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let supplierId: string;

type Actor = { id: string; role: string; tenant_id: string | null; email?: string; name?: string };
const admin = (): Actor => ({ id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId });
const regular = (): Actor => ({ id: seed.userId, role: 'user', tenant_id: seed.tenantId });
const reader = (): Actor => ({ id: seed.readerId, role: 'reader', tenant_id: seed.tenantId });
const foreignAdmin = (): Actor => ({ id: seed.orgAdmin2Id, role: 'org_admin', tenant_id: seed.tenantId2 });

async function call(
  fn: PagesFunction<any>,
  opts: { method?: string; body?: unknown; params?: Record<string, string>; as?: Actor } = {},
): Promise<{ status: number; body: any }> {
  const init: RequestInit = { method: opts.method ?? 'GET' };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  const res = await fn({
    request: new Request('http://localhost/api/x', init),
    env,
    data: { user: opts.as ?? admin() },
    params: opts.params ?? {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
  } as any);
  return { status: res.status, body: await res.json() };
}

async function makeSupplier(name: string, tenantId = seed.tenantId): Promise<string> {
  const id = `sup-${generateTestId()}`;
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(id, tenantId, name, `${name.toLowerCase().replace(/\W+/g, '-')}-${generateTestId()}`)
    .run();
  return id;
}

async function audits(action: string): Promise<any[]> {
  const res = await db
    .prepare('SELECT details FROM audit_log WHERE action = ? ORDER BY rowid')
    .bind(action)
    .all<{ details: string }>();
  return (res.results ?? []).map((r) => JSON.parse(r.details));
}

const add = (body: unknown, as?: Actor, id = supplierId) =>
  call(contactsPost, { method: 'POST', body, params: { id }, as });
const list = (as?: Actor, id = supplierId) => call(contactsGet, { params: { id }, as });

beforeAll(async () => {
  await runMigrations(db);
}, 30_000);

beforeEach(async () => {
  await cleanTables(db);
  seed = await seedTestData(db);
  supplierId = await makeSupplier('Acme Supplier');
});

// ───────────────────────────────────────────────────────────────────────────
describe('/api/suppliers/:id/contacts', () => {
  it('the first contact becomes the document contact; a second does not displace it', async () => {
    const first = await add({ email: 'Docs@Acme.example', name: 'Dana Reyes', role: 'QA' });
    expect(first.status).toBe(201);
    expect(first.body.contact).toMatchObject({
      email: 'Docs@Acme.example',
      name: 'Dana Reyes',
      role: 'QA',
      is_document_contact: true,
      active: true,
      source: 'admin',
    });

    const second = await add({ email: 'sales@acme.example', name: 'Sam' });
    expect(second.status).toBe(201);
    expect(second.body.contact.is_document_contact).toBe(false);

    const body = (await list(reader())).body as SupplierContactsResponse;
    expect(body.contacts).toHaveLength(2);
    expect(body.document_contact?.email).toBe('Docs@Acme.example');
    expect((await audits('supplier.contact_added')).map((a) => a.email)).toEqual([
      'Docs@Acme.example',
      'sales@acme.example',
    ]);
  });

  it('one address per supplier, whatever its capitalisation; a real address is required', async () => {
    expect((await add({ email: 'docs@acme.example' })).status).toBe(201);
    expect((await add({ email: ' DOCS@ACME.EXAMPLE ' })).status).toBe(409);
    expect((await add({ email: 'not-an-address' })).status).toBe(400);
    expect((await add({})).status).toBe(400);
    // The same address on ANOTHER supplier is fine.
    const other = await makeSupplier('Other Supplier');
    expect((await add({ email: 'docs@acme.example' }, undefined, other)).status).toBe(201);
  });

  it('naming a new document contact demotes the old one, and the audit says who was replaced', async () => {
    const a = (await add({ email: 'a@acme.example' })).body.contact;
    const b = (await add({ email: 'b@acme.example' })).body.contact;

    const res = await call(contactPut, {
      method: 'PUT',
      body: { is_document_contact: true },
      params: { id: supplierId, contactId: b.id },
    });
    expect(res.status).toBe(200);
    expect(res.body.document_contact.id).toBe(b.id);
    expect(res.body.contacts.filter((c: any) => c.is_document_contact).map((c: any) => c.id)).toEqual([b.id]);

    const [audit] = await audits('supplier.contact_updated');
    expect(audit.replaced_document_contact).toEqual({ contact_id: a.id, email: 'a@acme.example' });
    expect(audit.previous.is_document_contact).toBe(false);
    expect(audit.current.is_document_contact).toBe(true);

    // Adding one AS the document contact does the same in one step.
    const c = await add({ email: 'c@acme.example', is_document_contact: true });
    expect(c.body.document_contact.email).toBe('c@acme.example');
    const n = await db
      .prepare('SELECT COUNT(*) AS n FROM supplier_contacts WHERE supplier_id = ? AND is_document_contact = 1')
      .bind(supplierId)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it('deactivating or removing the document contact leaves NONE - nothing is promoted by guess', async () => {
    const a = (await add({ email: 'a@acme.example' })).body.contact;
    await add({ email: 'b@acme.example' });

    const off = await call(contactPut, {
      method: 'PUT',
      body: { active: false },
      params: { id: supplierId, contactId: a.id },
    });
    expect(off.body.document_contact).toBeNull();
    expect(off.body.contact).toMatchObject({ active: false, is_document_contact: false });

    const gone = await call(contactDelete, { method: 'DELETE', params: { id: supplierId, contactId: a.id } });
    expect(gone.status).toBe(200);
    expect(gone.body.contacts.map((c: any) => c.email)).toEqual(['b@acme.example']);
    expect(gone.body.document_contact).toBeNull();
    const [removed] = await audits('supplier.contact_removed');
    expect(removed.removed).toMatchObject({ contact_id: a.id, email: 'a@acme.example' });
  });

  it('writes are admin-only; another organisation sees a 404, not a row', async () => {
    expect((await add({ email: 'x@acme.example' }, regular())).status).toBe(403);
    expect((await add({ email: 'x@acme.example' }, reader())).status).toBe(403);
    expect((await add({ email: 'x@acme.example' }, foreignAdmin())).status).toBe(404);
    expect((await list(foreignAdmin())).status).toBe(404);

    const mine = (await add({ email: 'x@acme.example' })).body.contact;
    const theirs = await makeSupplier('Their Supplier', seed.tenantId2);
    // A contact id addressed through the wrong supplier does not resolve.
    const cross = await call(contactPut, {
      method: 'PUT',
      body: { name: 'hijack' },
      params: { id: theirs, contactId: mine.id },
      as: foreignAdmin(),
    });
    expect(cross.status).toBe(404);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the verified supplier list writes its contact column', () => {
  const rows = [
    { supplier_name: 'Listed Dairy', supplier_contact_email: 'QA@Listed.example', supplier_category: 'ingredient', approved: 'Y' },
    { supplier_name: 'Listed Dairy', supplier_contact_email: 'qa@listed.example', supplier_category: 'ingredient', approved: 'Y', product_name: 'Cream' },
    { supplier_name: 'Listed Dairy', supplier_contact_email: 'second@listed.example', supplier_category: 'ingredient', approved: 'Y', product_name: 'Butter' },
    { supplier_name: 'No Email Co', supplier_category: 'packaging', approved: 'Y' },
  ];
  const post = (body: unknown) => call(importPost, { method: 'POST', body });

  beforeEach(async () => {
    await applyStarterPack(db, getStarterPack('fsqa')!, seed.tenantId, 'test-corp');
  });

  it('a dry run counts them and writes nothing', async () => {
    const preview = await post({ rows, dry_run: true });
    expect(preview.status).toBe(200);
    expect(preview.body.counts.contacts_added).toBe(2);
    const n = await db.prepare('SELECT COUNT(*) AS n FROM supplier_contacts').first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('apply records each address once; the first is the document contact; re-applying adds nothing', async () => {
    const applied = await post({ rows, dry_run: false });
    expect(applied.status).toBe(201);
    expect(applied.body.counts.contacts_added).toBe(2);

    const read = async () =>
      (
        await db
          .prepare(
            `SELECT c.email, c.is_document_contact, c.source
               FROM supplier_contacts c JOIN suppliers s ON s.id = c.supplier_id
              WHERE s.name = 'Listed Dairy' ORDER BY c.created_at, c.rowid`,
          )
          .all<{ email: string; is_document_contact: number; source: string }>()
      ).results;
    expect(await read()).toEqual([
      { email: 'QA@Listed.example', is_document_contact: 1, source: 'import' },
      { email: 'second@listed.example', is_document_contact: 0, source: 'import' },
    ]);

    // A person has since switched the document contact; a re-import leaves it alone.
    await db.prepare(`UPDATE supplier_contacts SET is_document_contact = 0 WHERE email = 'QA@Listed.example'`).run();
    await db.prepare(`UPDATE supplier_contacts SET is_document_contact = 1 WHERE email = 'second@listed.example'`).run();
    const again = await post({ rows, dry_run: false });
    expect(again.body.counts.contacts_added).toBe(0);
    expect(await read()).toEqual([
      { email: 'QA@Listed.example', is_document_contact: 0, source: 'import' },
      { email: 'second@listed.example', is_document_contact: 1, source: 'import' },
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('a renewal date changed after approval is a decision (D-041)', () => {
  const APPROVAL_SNAPSHOT = {
    proposed_due_date: '2026-09-01',
    confirmed_due_date: '2026-09-01',
    decision: 'accepted',
    rule: 'stated_expiry',
    period_months: null,
    anchor_date: null,
    reason: 'The document states it expires on 2026-09-01.',
    type_renewal_policy: 'inherit',
    type_renewal_interval_months: null,
  };

  async function makeDoc(withDecision: boolean): Promise<string> {
    const id = `doc-${generateTestId()}`;
    await db
      .prepare(
        `INSERT INTO documents
           (id, tenant_id, title, tags, current_version, status, created_by, renewal_type,
            renewal_due_date, renewal_decision, renewal_snapshot, renewal_decided_at, renewal_decided_by)
         VALUES (?, ?, 'Acme COI', '[]', 1, 'active', ?, 'hard_expiry', ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        seed.tenantId,
        seed.userId,
        withDecision ? '2026-09-01' : null,
        withDecision ? 'accepted' : null,
        withDecision ? JSON.stringify(APPROVAL_SNAPSHOT) : null,
        withDecision ? '2026-01-05T00:00:00.000Z' : null,
        withDecision ? seed.orgAdminId : null,
      )
      .run();
    return id;
  }

  const put = (id: string, body: Record<string, unknown>, as: Actor = regular()) =>
    call(docPut, { method: 'PUT', body, params: { id }, as });

  const read = (id: string) =>
    db
      .prepare(
        'SELECT renewal_due_date, renewal_decision, renewal_snapshot, renewal_decided_at, renewal_decided_by FROM documents WHERE id = ?',
      )
      .bind(id)
      .first<{
        renewal_due_date: string | null;
        renewal_decision: string | null;
        renewal_snapshot: string | null;
        renewal_decided_at: string | null;
        renewal_decided_by: string | null;
      }>();

  it('records who, why and the previous date - and keeps the original proposal', async () => {
    const id = await makeDoc(true);
    const res = await put(id, { renewal_due_date: '2027-03-15', renewal_reason: 'Supplier sent an extension letter' });
    expect(res.status).toBe(200);

    const row = (await read(id))!;
    expect(row.renewal_due_date).toBe('2027-03-15');
    expect(row.renewal_decision).toBe('overridden');
    expect(row.renewal_decided_by).toBe(seed.userId);
    expect(row.renewal_decided_at).not.toBe('2026-01-05T00:00:00.000Z');

    const snap = JSON.parse(row.renewal_snapshot!);
    // Every approval-time field is exactly as it was.
    expect(snap).toMatchObject(APPROVAL_SNAPSHOT);
    expect(snap.post_approval_edits).toEqual([
      {
        previous_due_date: '2026-09-01',
        new_due_date: '2027-03-15',
        decision: 'overridden',
        reason: 'Supplier sent an extension letter',
        decided_by: seed.userId,
        decided_at: row.renewal_decided_at,
      },
    ]);

    const [audit] = await audits('document.renewal_decided');
    expect(audit).toMatchObject({
      via: 'document_edit',
      decision: 'overridden',
      previous_due_date: '2026-09-01',
      renewal_due_date: '2027-03-15',
      reason: 'Supplier sent an extension letter',
    });

    // A second edit APPENDS; the first is not rewritten.
    await put(id, { renewal_due_date: '2027-04-01', renewal_reason: 'Corrected' });
    const edits = JSON.parse((await read(id))!.renewal_snapshot!).post_approval_edits;
    expect(edits.map((e: any) => [e.previous_due_date, e.new_due_date, e.reason])).toEqual([
      ['2026-09-01', '2027-03-15', 'Supplier sent an extension letter'],
      ['2027-03-15', '2027-04-01', 'Corrected'],
    ]);
    expect(await audits('document.renewal_decided')).toHaveLength(2);
  });

  it('emptying the date records "does not renew", and the dashboard honours it', async () => {
    const id = await makeDoc(true);
    await put(id, { renewal_due_date: null, renewal_reason: 'One-off letter, not re-issued' });

    const row = (await read(id))!;
    expect(row.renewal_due_date).toBeNull();
    expect(row.renewal_decision).toBe('cleared');
    const [audit] = await audits('document.renewal_decided');
    expect(audit).toMatchObject({ decision: 'cleared', previous_due_date: '2026-09-01', renewal_due_date: null });

    // Not on the renewals list at all: a person said it does not renew.
    const { rows } = await computeExpirations(db, seed.tenantId, '2026-08-01', 3650);
    expect(rows.find((r) => r.id === id)).toBeUndefined();
  });

  it('an unchanged date is not a decision: the registry editor sends the field on every save', async () => {
    const id = await makeDoc(true);
    await put(id, { renewal_due_date: '2026-09-01', owner: 'QA', renewal_reason: 'ignored' });
    const row = (await read(id))!;
    expect(row.renewal_decision).toBe('accepted');
    expect(JSON.parse(row.renewal_snapshot!).post_approval_edits).toBeUndefined();
    expect(row.renewal_decided_at).toBe('2026-01-05T00:00:00.000Z');
    expect(await audits('document.renewal_decided')).toEqual([]);

    // Likewise empty -> empty on a document nobody ever answered for.
    const bare = await makeDoc(false);
    await put(bare, { renewal_due_date: null, owner: 'QA' });
    expect((await read(bare))!.renewal_decision).toBeNull();
    expect(await audits('document.renewal_decided')).toEqual([]);
  });

  it('a document with no approval-time decision gets a snapshot holding only the edit; a reason is not enforced', async () => {
    const id = await makeDoc(false);
    const res = await put(id, { renewal_due_date: '2026-12-31' });
    expect(res.status).toBe(200);
    const row = (await read(id))!;
    expect(row.renewal_decision).toBe('overridden');
    const snap = JSON.parse(row.renewal_snapshot!);
    expect(Object.keys(snap)).toEqual(['post_approval_edits']);
    expect(snap.post_approval_edits[0]).toMatchObject({ previous_due_date: null, new_due_date: '2026-12-31', reason: null });
  });

  it('refuses something that is not a date', async () => {
    const id = await makeDoc(true);
    expect((await put(id, { renewal_due_date: 'next spring' })).status).toBe(400);
    expect((await read(id))!.renewal_due_date).toBe('2026-09-01');
  });
});
