/**
 * A supplier merge must not delete what was asked of the loser.
 *
 * `mergeSuppliers` moved documents, products, lots and the extraction rows,
 * and then DELETEd the loser. Five tables reference suppliers ON DELETE
 * CASCADE and were in neither move list -- document_requests, request_links,
 * request_uploads, supplier_requirements -- so merging "Acme Dairy" into
 * "Acme Dairy Inc." silently deleted every request ever issued to Acme Dairy,
 * the link the supplier was holding, the files they had sent through it, and
 * the checklist of what they owe. This file reproduces that and pins the fix;
 * it also covers the two tables migration 0133 adds (supplier_contacts,
 * renewal_requests), which would have gone the same way.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables, generateTestId } from '../helpers/db';
import { mergeSuppliers } from '../../functions/lib/suppliers';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

async function makeSupplier(name: string): Promise<string> {
  const id = `sup-${generateTestId()}`;
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(id, seed.tenantId, name, `${name.toLowerCase().replace(/\W+/g, '-')}-${generateTestId()}`)
    .run();
  return id;
}

async function makeRequirement(name: string): Promise<string> {
  const id = `req-${generateTestId()}`;
  await db
    .prepare('INSERT INTO requirements (id, tenant_id, slug, name, active) VALUES (?, ?, ?, ?, 1)')
    .bind(id, seed.tenantId, `${name.toLowerCase().replace(/\W+/g, '-')}-${generateTestId()}`, name)
    .run();
  return id;
}

async function count(table: string, supplierId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE supplier_id = ?`)
    .bind(supplierId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function addContact(
  supplierId: string,
  email: string,
  opts: { documentContact?: boolean; name?: string } = {},
): Promise<string> {
  const id = `sc-${generateTestId()}`;
  await db
    .prepare(
      `INSERT INTO supplier_contacts
         (id, tenant_id, supplier_id, name, email, email_norm, is_document_contact, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .bind(id, seed.tenantId, supplierId, opts.name ?? null, email, email.toLowerCase(), opts.documentContact ? 1 : 0)
    .run();
  return id;
}

beforeAll(async () => {
  await runMigrations(db);
}, 30_000);

beforeEach(async () => {
  await cleanTables(db);
  seed = await seedTestData(db);
});

describe('mergeSuppliers keeps the loser\'s requests', () => {
  it('moves requests, the supplier link, uploads and the requirement checklist to the winner', async () => {
    const winner = await makeSupplier('Acme Dairy Inc.');
    const loser = await makeSupplier('Acme Dairy');
    const reqA = await makeRequirement('Certificate of Insurance');
    const reqB = await makeRequirement('Allergen Statement');

    // A request issued to the loser, with a line, a routing row, a live link
    // and one file that came back through it.
    const requestId = `dr-${generateTestId()}`;
    await db
      .prepare(
        `INSERT INTO document_requests
           (id, tenant_id, supplier_id, root_request_id, version, title, status, issued_at, created_by)
         VALUES (?, ?, ?, ?, 1, 'Annual packet', 'issued', datetime('now'), ?)`,
      )
      .bind(requestId, seed.tenantId, loser, requestId, seed.orgAdminId)
      .run();
    await db
      .prepare(
        `INSERT INTO request_lines (id, tenant_id, request_id, line_kind, requirement_id, name)
         VALUES (?, ?, ?, 'requirement', ?, 'Certificate of Insurance')`,
      )
      .bind(`rl-${generateTestId()}`, seed.tenantId, requestId, reqA)
      .run();
    const linkId = `lnk-${generateTestId()}`;
    await db
      .prepare(
        `INSERT INTO request_links (id, tenant_id, token, root_request_id, supplier_id, expires_at)
         VALUES (?, ?, ?, ?, ?, datetime('now', '+90 days'))`,
      )
      .bind(linkId, seed.tenantId, `tok-${generateTestId()}`, requestId, loser)
      .run();
    await db
      .prepare(
        `INSERT INTO request_uploads
           (id, tenant_id, link_id, request_id, supplier_id, r2_key, file_name, file_size, mime_type)
         VALUES (?, ?, ?, ?, ?, 'k/coi.pdf', 'coi.pdf', 10, 'application/pdf')`,
      )
      .bind(`up-${generateTestId()}`, seed.tenantId, linkId, requestId, loser)
      .run();

    // The checklist: one row only the loser has, one both have.
    await db
      .prepare(
        `INSERT INTO supplier_requirements (id, tenant_id, supplier_id, requirement_id, tier)
         VALUES (?, ?, ?, ?, 'required'), (?, ?, ?, ?, 'recommended'), (?, ?, ?, ?, 'required')`,
      )
      .bind(
        `sr-${generateTestId()}`, seed.tenantId, loser, reqA,
        `sr-${generateTestId()}`, seed.tenantId, loser, reqB,
        `sr-${generateTestId()}`, seed.tenantId, winner, reqB,
      )
      .run();

    const result = await mergeSuppliers(db, seed.tenantId, {
      winnerId: winner,
      loserIds: [loser],
      actor: { userId: seed.orgAdminId, ip: null },
    });

    expect(await db.prepare('SELECT id FROM suppliers WHERE id = ?').bind(loser).first()).toBeNull();

    // Nothing was deleted with the loser.
    expect(await count('document_requests', winner)).toBe(1);
    expect(await count('request_links', winner)).toBe(1);
    expect(await count('request_uploads', winner)).toBe(1);
    const lines = await db
      .prepare('SELECT COUNT(*) AS n FROM request_lines WHERE request_id = ?')
      .bind(requestId)
      .first<{ n: number }>();
    expect(lines?.n).toBe(1);

    // The checklist: the loser-only row moved; the shared row kept the
    // WINNER's tier (required), not the loser's.
    const owed = await db
      .prepare('SELECT requirement_id, tier FROM supplier_requirements WHERE supplier_id = ? ORDER BY requirement_id')
      .bind(winner)
      .all<{ requirement_id: string; tier: string }>();
    expect(owed.results).toHaveLength(2);
    expect(owed.results.find((r) => r.requirement_id === reqA)?.tier).toBe('required');
    expect(owed.results.find((r) => r.requirement_id === reqB)?.tier).toBe('required');

    expect(result.reassigned.document_requests).toBe(1);
    expect(result.reassigned.request_links).toBe(1);
    expect(result.reassigned.request_uploads).toBe(1);
    expect(result.reassigned.supplier_requirements).toBe(1);
  });

  it('moves contacts (one per address, one document contact) and renewal cycles', async () => {
    const winner = await makeSupplier('Beta Foods LLC');
    const loser = await makeSupplier('Beta Foods');

    await addContact(winner, 'qa@beta.example', { documentContact: true, name: 'Winner QA' });
    // Same address on the loser (a different spelling of it is still the same
    // contact) and a second, loser-only address that was ITS document contact.
    await addContact(loser, 'qa@beta.example', { name: 'Loser QA' });
    await addContact(loser, 'docs@beta.example', { documentContact: true, name: 'Docs' });

    const docId = `doc-${generateTestId()}`;
    await db
      .prepare(
        `INSERT INTO documents (id, tenant_id, supplier_id, title, status, created_by)
         VALUES (?, ?, ?, 'Beta COI', 'active', ?)`,
      )
      .bind(docId, seed.tenantId, loser, seed.orgAdminId)
      .run();
    const cycleId = `rr-${generateTestId()}`;
    await db
      .prepare(
        `INSERT INTO renewal_requests (id, tenant_id, document_id, supplier_id, due_date, status)
         VALUES (?, ?, ?, ?, '2026-09-01', 'open')`,
      )
      .bind(cycleId, seed.tenantId, docId, loser)
      .run();
    await db
      .prepare(
        `INSERT INTO renewal_request_sends
           (id, tenant_id, renewal_request_id, stage, status, draft_subject, draft_body, drafted_as_of)
         VALUES (?, ?, ?, 'window_open', 'pending', 's', 'b', '2026-07-10')`,
      )
      .bind(`rs-${generateTestId()}`, seed.tenantId, cycleId)
      .run();

    await mergeSuppliers(db, seed.tenantId, {
      winnerId: winner,
      loserIds: [loser],
      actor: { userId: seed.orgAdminId, ip: null },
    });

    const contacts = await db
      .prepare('SELECT email_norm, name, is_document_contact FROM supplier_contacts WHERE supplier_id = ? ORDER BY email_norm')
      .bind(winner)
      .all<{ email_norm: string; name: string; is_document_contact: number }>();
    expect(contacts.results.map((c) => c.email_norm)).toEqual(['docs@beta.example', 'qa@beta.example']);
    // The winner's row for the shared address is the one that stays.
    expect(contacts.results.find((c) => c.email_norm === 'qa@beta.example')?.name).toBe('Winner QA');
    // Still exactly one document contact: the winner's. The loser's arrives demoted.
    expect(contacts.results.filter((c) => c.is_document_contact === 1).map((c) => c.email_norm)).toEqual([
      'qa@beta.example',
    ]);

    const cycle = await db
      .prepare('SELECT supplier_id, status FROM renewal_requests WHERE id = ?')
      .bind(cycleId)
      .first<{ supplier_id: string; status: string }>();
    expect(cycle).toEqual({ supplier_id: winner, status: 'open' });
    const sends = await db
      .prepare('SELECT COUNT(*) AS n FROM renewal_request_sends WHERE renewal_request_id = ?')
      .bind(cycleId)
      .first<{ n: number }>();
    expect(sends?.n).toBe(1);
  });

  it('gives the winner the loser\'s document contact when it has none of its own', async () => {
    const winner = await makeSupplier('Gamma Mills Co.');
    const loser = await makeSupplier('Gamma Mills');
    await addContact(loser, 'docs@gamma.example', { documentContact: true });

    await mergeSuppliers(db, seed.tenantId, {
      winnerId: winner,
      loserIds: [loser],
      actor: { userId: seed.orgAdminId, ip: null },
    });

    const row = await db
      .prepare('SELECT email_norm, is_document_contact FROM supplier_contacts WHERE supplier_id = ?')
      .bind(winner)
      .first<{ email_norm: string; is_document_contact: number }>();
    expect(row).toEqual({ email_norm: 'docs@gamma.example', is_document_contact: 1 });
  });
});
