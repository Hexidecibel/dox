/**
 * Integration tests for /api/notes (migration 0088) — the generic notes
 * facility.
 *
 * Three things are actually being defended here, and only one of them is CRUD:
 *
 *   1. TENANT ISOLATION. entity_id is polymorphic, so it cannot be a foreign
 *      key, so the database cannot stop a note being hung off another tenant's
 *      record. functions/lib/notes.ts is the entire guarantee, which makes
 *      these the load-bearing tests in the file.
 *   2. APPEND-ONLY. There is no PUT, delete is soft, and a retracted note is
 *      still there for an admin. If any of that quietly changes, the notes stop
 *      being worth having on a compliance record.
 *   3. ORDERING. Notes carry a one-second-granularity timestamp; same-second
 *      posts must still read back in the order they were written.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import {
  onRequestGet as listGet,
  onRequestPost as createPost,
} from '../../functions/api/notes/index';
import {
  onRequestGet as oneGet,
  onRequestDelete as oneDelete,
} from '../../functions/api/notes/[id]';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let admin: { id: string; role: 'org_admin'; tenant_id: string };
let member: { id: string; role: 'user'; tenant_id: string };
let reader: { id: string; role: 'reader'; tenant_id: string };
let otherAdmin: { id: string; role: 'org_admin'; tenant_id: string };
let superAdmin: { id: string; role: 'super_admin'; tenant_id: null };

let supplierA: string;
let documentA: string;
let requirementA: string;
let foreignSupplier: string;

async function makeSupplier(tenantId: string, name: string): Promise<string> {
  const id = `sup-${generateTestId()}`;
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(id, tenantId, name, `${name.toLowerCase().replace(/\W+/g, '-')}-${generateTestId()}`)
    .run();
  return id;
}

async function makeDocument(tenantId: string, title: string, createdBy: string): Promise<string> {
  const id = `doc-${generateTestId()}`;
  await db
    .prepare(
      'INSERT INTO documents (id, tenant_id, title, created_by) VALUES (?, ?, ?, ?)',
    )
    .bind(id, tenantId, title, createdBy)
    .run();
  return id;
}

async function makeRequirement(tenantId: string, name: string): Promise<string> {
  const id = `req-${generateTestId()}`;
  await db
    .prepare('INSERT INTO requirements (id, tenant_id, slug, name) VALUES (?, ?, ?, ?)')
    .bind(id, tenantId, `${name.toLowerCase().replace(/\W+/g, '-')}-${generateTestId()}`, name)
    .run();
  return id;
}

async function list(query: string, as: unknown = admin) {
  const res = await listGet({
    request: new Request(`http://localhost/api/notes${query}`),
    env,
    data: { user: as },
    params: {},
  } as any);
  return { status: res.status, body: (await res.json()) as any };
}

async function create(body: Record<string, unknown>, as: unknown = admin) {
  const res = await createPost({
    request: new Request('http://localhost/api/notes', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
    env,
    data: { user: as },
    params: {},
  } as any);
  return { status: res.status, body: (await res.json()) as any };
}

async function getOne(id: string, as: unknown = admin) {
  const res = await oneGet({
    request: new Request(`http://localhost/api/notes/${id}`),
    env,
    data: { user: as },
    params: { id },
  } as any);
  return { status: res.status, body: (await res.json()) as any };
}

async function retract(id: string, as: unknown = admin) {
  const res = await oneDelete({
    request: new Request(`http://localhost/api/notes/${id}`, { method: 'DELETE' }),
    env,
    data: { user: as },
    params: { id },
  } as any);
  return { status: res.status, body: (await res.json()) as any };
}

beforeAll(async () => {
  seed = await seedTestData(db);
  admin = { id: seed.orgAdminId, role: 'org_admin' as const, tenant_id: seed.tenantId };
  member = { id: seed.userId, role: 'user' as const, tenant_id: seed.tenantId };
  reader = { id: seed.readerId, role: 'reader' as const, tenant_id: seed.tenantId };
  otherAdmin = { id: seed.orgAdmin2Id, role: 'org_admin' as const, tenant_id: seed.tenantId2 };
  superAdmin = { id: seed.superAdminId, role: 'super_admin' as const, tenant_id: null };

  supplierA = await makeSupplier(seed.tenantId, 'Alpha Dairy');
  documentA = await makeDocument(seed.tenantId, 'Alpha COA', seed.orgAdminId);
  requirementA = await makeRequirement(seed.tenantId, 'Allergen Matrix');
  foreignSupplier = await makeSupplier(seed.tenantId2, 'Other Corp Supplier');
}, 30_000);

beforeEach(async () => {
  await db.prepare('DELETE FROM entity_notes').run();
});

describe('POST /api/notes — post a note', () => {
  it('posts a note against a supplier, attributed and timestamped', async () => {
    const res = await create({
      entity_type: 'supplier',
      entity_id: supplierA,
      body: 'Switched testing labs in March; expect a new COA layout.',
    });
    expect(res.status).toBe(201);
    expect(res.body.note.body).toContain('Switched testing labs');
    expect(res.body.note.author_id).toBe(admin.id);
    expect(res.body.note.author_name).toBe('Org Admin');
    expect(res.body.note.tenant_id).toBe(seed.tenantId);
    expect(res.body.note.created_at).toBeTruthy();
    expect(res.body.note.deleted_at).toBeNull();
  });

  it('posts against a document without touching documents.description', async () => {
    const before = await db
      .prepare('SELECT description FROM documents WHERE id = ?')
      .bind(documentA)
      .first<{ description: string | null }>();

    const res = await create({
      entity_type: 'document',
      entity_id: documentA,
      body: 'Chased the supplier for the missing pesticide panel.',
    });
    expect(res.status).toBe(201);

    const after = await db
      .prepare('SELECT description FROM documents WHERE id = ?')
      .bind(documentA)
      .first<{ description: string | null }>();
    expect(after?.description).toBe(before?.description ?? null);
  });

  it('serves a third parent type with no new table or endpoint', async () => {
    const res = await create({
      entity_type: 'requirement',
      entity_id: requirementA,
      body: 'Client confirmed this line item is annual, not per-lot.',
    });
    expect(res.status).toBe(201);
  });

  it('is NOT idempotent — two identical posts are two notes', async () => {
    await create({ entity_type: 'supplier', entity_id: supplierA, body: 'Called them.' });
    await create({ entity_type: 'supplier', entity_id: supplierA, body: 'Called them.' });
    const res = await list(`?entity_type=supplier&entity_id=${supplierA}`);
    expect(res.body.total).toBe(2);
  });

  it('rejects an unknown entity_type rather than storing free text', async () => {
    const res = await create({
      entity_type: 'banana',
      entity_id: supplierA,
      body: 'nope',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('entity_type must be one of');
  });

  it('the DB CHECK refuses an unknown entity_type even if the API were bypassed', async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO entity_notes (id, tenant_id, entity_type, entity_id, body, author_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(`n-${generateTestId()}`, seed.tenantId, 'banana', supplierA, 'x', admin.id)
        .run(),
    ).rejects.toThrow();
  });

  it('requires a non-empty body', async () => {
    expect((await create({ entity_type: 'supplier', entity_id: supplierA })).status).toBe(400);
    expect(
      (await create({ entity_type: 'supplier', entity_id: supplierA, body: '   ' })).status,
    ).toBe(400);
  });

  it('caps the body length', async () => {
    const res = await create({
      entity_type: 'supplier',
      entity_id: supplierA,
      body: 'x'.repeat(10001),
    });
    expect(res.status).toBe(400);
  });

  it('refuses a reader — the role is read-only and a note is permanent', async () => {
    const res = await create(
      { entity_type: 'supplier', entity_id: supplierA, body: 'hi' },
      reader,
    );
    expect(res.status).toBe(403);
  });

  it('allows a plain user — notes are ordinary work, not an admin act', async () => {
    const res = await create(
      { entity_type: 'supplier', entity_id: supplierA, body: 'Left a voicemail.' },
      member,
    );
    expect(res.status).toBe(201);
  });

  it('writes an audit row', async () => {
    const res = await create({
      entity_type: 'supplier',
      entity_id: supplierA,
      body: 'Audited.',
    });
    const audit = await db
      .prepare('SELECT * FROM audit_log WHERE resource_id = ? AND action = ?')
      .bind(res.body.note.id, 'note_created')
      .first();
    expect(audit).toBeTruthy();
  });
});

describe('tenant isolation — the guarantee no foreign key can make', () => {
  it('refuses to attach a note to another tenant\'s supplier', async () => {
    const res = await create({
      entity_type: 'supplier',
      entity_id: foreignSupplier,
      body: 'should never land',
    });
    expect(res.status).toBe(404);

    const row = await db
      .prepare('SELECT COUNT(*) as c FROM entity_notes WHERE entity_id = ?')
      .bind(foreignSupplier)
      .first<{ c: number }>();
    expect(row?.c).toBe(0);
  });

  it('refuses to READ notes on another tenant\'s record, even knowing the id', async () => {
    // Plant a legitimate note in tenant 2, then try to read it from tenant 1.
    await create(
      { entity_type: 'supplier', entity_id: foreignSupplier, body: 'tenant two business' },
      otherAdmin,
    );

    const res = await list(`?entity_type=supplier&entity_id=${foreignSupplier}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('tenant two business');
  });

  it('refuses to read one note by id across tenants', async () => {
    const created = await create(
      { entity_type: 'supplier', entity_id: foreignSupplier, body: 'tenant two business' },
      otherAdmin,
    );
    const res = await getOne(created.body.note.id, admin);
    expect(res.status).toBe(403);
  });

  it('refuses to retract another tenant\'s note', async () => {
    const created = await create(
      { entity_type: 'supplier', entity_id: foreignSupplier, body: 'tenant two business' },
      otherAdmin,
    );
    expect((await retract(created.body.note.id, admin)).status).toBe(403);

    const still = await db
      .prepare('SELECT deleted_at FROM entity_notes WHERE id = ?')
      .bind(created.body.note.id)
      .first<{ deleted_at: string | null }>();
    expect(still?.deleted_at).toBeNull();
  });

  it('makes a super_admin name the tenant instead of guessing', async () => {
    expect(
      (await create({ entity_type: 'supplier', entity_id: supplierA, body: 'x' }, superAdmin))
        .status,
    ).toBe(400);
    expect((await list(`?entity_type=supplier&entity_id=${supplierA}`, superAdmin)).status).toBe(
      400,
    );

    const ok = await create(
      {
        entity_type: 'supplier',
        entity_id: supplierA,
        body: 'super admin note',
        tenant_id: seed.tenantId,
      },
      superAdmin,
    );
    expect(ok.status).toBe(201);
    expect(ok.body.note.tenant_id).toBe(seed.tenantId);
  });
});

describe('GET /api/notes — list', () => {
  it('requires both entity params — this reads the thread ON a record', async () => {
    expect((await list('?entity_id=' + supplierA)).status).toBe(400);
    expect((await list('?entity_type=supplier')).status).toBe(400);
  });

  it('returns newest first, and keeps same-second posts in insertion order', async () => {
    // All three land inside one second, so created_at ties and the rowid
    // tiebreak is the only thing producing a stable answer.
    await create({ entity_type: 'supplier', entity_id: supplierA, body: 'first' });
    await create({ entity_type: 'supplier', entity_id: supplierA, body: 'second' });
    await create({ entity_type: 'supplier', entity_id: supplierA, body: 'third' });

    const res = await list(`?entity_type=supplier&entity_id=${supplierA}`);
    expect(res.body.notes.map((n: any) => n.body)).toEqual(['third', 'second', 'first']);

    // Stable across reads, not merely correct once.
    const again = await list(`?entity_type=supplier&entity_id=${supplierA}`);
    expect(again.body.notes.map((n: any) => n.body)).toEqual(['third', 'second', 'first']);
  });

  it('scopes to the record asked for, not the whole tenant', async () => {
    await create({ entity_type: 'supplier', entity_id: supplierA, body: 'about the supplier' });
    await create({ entity_type: 'document', entity_id: documentA, body: 'about the document' });

    const supplierNotes = await list(`?entity_type=supplier&entity_id=${supplierA}`);
    expect(supplierNotes.body.total).toBe(1);
    expect(supplierNotes.body.notes[0].body).toBe('about the supplier');

    const docNotes = await list(`?entity_type=document&entity_id=${documentA}`);
    expect(docNotes.body.total).toBe(1);
    expect(docNotes.body.notes[0].body).toBe('about the document');
  });

  it('does not confuse two records that share an id across entity types', async () => {
    // The realistic version of a polymorphic-key collision: same id string,
    // different entity_type. They must not bleed into each other.
    const collidingId = supplierA;
    await create({ entity_type: 'supplier', entity_id: collidingId, body: 'supplier side' });
    const res = await list(`?entity_type=document&entity_id=${collidingId}`);
    // It is not a document in this tenant, so the parent check rejects it
    // outright rather than returning an empty, reassuring list.
    expect(res.status).toBe(404);
  });

  it('lets a reader read the thread', async () => {
    await create({ entity_type: 'supplier', entity_id: supplierA, body: 'visible to readers' });
    const res = await list(`?entity_type=supplier&entity_id=${supplierA}`, reader);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });
});

describe('append-only', () => {
  it('exposes no update handler at all', async () => {
    const index = await import('../../functions/api/notes/index');
    const one = await import('../../functions/api/notes/[id]');
    expect((index as Record<string, unknown>).onRequestPut).toBeUndefined();
    expect((index as Record<string, unknown>).onRequestPatch).toBeUndefined();
    expect((one as Record<string, unknown>).onRequestPut).toBeUndefined();
    expect((one as Record<string, unknown>).onRequestPatch).toBeUndefined();
  });

  it('retracts softly — the row survives, stamped with who and when', async () => {
    const created = await create({
      entity_type: 'supplier',
      entity_id: supplierA,
      body: 'wrong record, sorry',
    });
    expect((await retract(created.body.note.id)).status).toBe(200);

    const row = await db
      .prepare('SELECT * FROM entity_notes WHERE id = ?')
      .bind(created.body.note.id)
      .first<{ body: string; deleted_at: string | null; deleted_by: string | null }>();
    expect(row).toBeTruthy();
    expect(row?.body).toBe('wrong record, sorry');
    expect(row?.deleted_at).toBeTruthy();
    expect(row?.deleted_by).toBe(admin.id);
  });

  it('hides a retracted note from the default read but keeps it for an admin', async () => {
    const created = await create({
      entity_type: 'supplier',
      entity_id: supplierA,
      body: 'retracted text',
    });
    await retract(created.body.note.id);

    const plain = await list(`?entity_type=supplier&entity_id=${supplierA}`);
    expect(plain.body.total).toBe(0);

    const withDeleted = await list(
      `?entity_type=supplier&entity_id=${supplierA}&include_deleted=1`,
    );
    expect(withDeleted.body.total).toBe(1);
    expect(withDeleted.body.notes[0].body).toBe('retracted text');
    expect(withDeleted.body.notes[0].deleted_by_name).toBe('Org Admin');
  });

  it('ignores include_deleted for a non-admin', async () => {
    const created = await create({
      entity_type: 'supplier',
      entity_id: supplierA,
      body: 'retracted text',
    });
    await retract(created.body.note.id);

    for (const who of [member, reader]) {
      const res = await list(
        `?entity_type=supplier&entity_id=${supplierA}&include_deleted=1`,
        who,
      );
      expect(res.body.total).toBe(0);
    }
  });

  it('404s a retracted note to a non-admin reading it by id', async () => {
    const created = await create({
      entity_type: 'supplier',
      entity_id: supplierA,
      body: 'retracted text',
    });
    await retract(created.body.note.id);
    expect((await getOne(created.body.note.id, member)).status).toBe(404);
    expect((await getOne(created.body.note.id, admin)).status).toBe(200);
  });

  it('lets an author retract their own note, but not a colleague\'s', async () => {
    const mine = await create(
      { entity_type: 'supplier', entity_id: supplierA, body: 'mine' },
      member,
    );
    expect((await retract(mine.body.note.id, member)).status).toBe(200);

    const theirs = await create(
      { entity_type: 'supplier', entity_id: supplierA, body: 'the admin\'s' },
      admin,
    );
    expect((await retract(theirs.body.note.id, member)).status).toBe(403);
  });

  it('refuses a reader outright', async () => {
    const created = await create({
      entity_type: 'supplier',
      entity_id: supplierA,
      body: 'x',
    });
    expect((await retract(created.body.note.id, reader)).status).toBe(403);
  });

  it('treats a repeat retraction as a no-op success, not an error', async () => {
    const created = await create({
      entity_type: 'supplier',
      entity_id: supplierA,
      body: 'x',
    });
    await retract(created.body.note.id);
    const second = await retract(created.body.note.id);
    expect(second.status).toBe(200);

    // And the original retraction stamp is not overwritten by the second call.
    const row = await db
      .prepare('SELECT deleted_by FROM entity_notes WHERE id = ?')
      .bind(created.body.note.id)
      .first<{ deleted_by: string }>();
    expect(row?.deleted_by).toBe(admin.id);
  });

  it('writes an audit row for the retraction', async () => {
    const created = await create({
      entity_type: 'supplier',
      entity_id: supplierA,
      body: 'x',
    });
    await retract(created.body.note.id);
    const audit = await db
      .prepare('SELECT * FROM audit_log WHERE resource_id = ? AND action = ?')
      .bind(created.body.note.id, 'note_retracted')
      .first();
    expect(audit).toBeTruthy();
  });
});
