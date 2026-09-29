/**
 * G4 at approval, against D1: the arrival is stamped, a certificate already
 * expired on that day is audited and routed to the QA lane (renewal-style: no
 * admin fallback, a routing-gap notice instead), and the gap loader stops
 * counting it as closing its requirement.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { recordArrivalAndCheckExpiry } from '../../functions/lib/expired-on-arrival';
import { loadSupplierGaps } from '../../functions/lib/requirement-gaps';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let supplierId = '';

async function makeDocument(title: string, expiresOn: string | null): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, current_version, status, created_by, supplier_id, primary_metadata, classification_status)
       VALUES (?, ?, ?, 1, 'active', ?, ?, ?, 'classified')`
    )
    .bind(
      id,
      seed.tenantId,
      title,
      seed.orgAdminId,
      supplierId,
      JSON.stringify(expiresOn ? { document_expires_on: expiresOn } : {})
    )
    .run();
  return id;
}

const ctx = (over: Partial<Parameters<typeof recordArrivalAndCheckExpiry>[2]> = {}) => ({
  tenantId: seed.tenantId,
  tenantName: 'Test Corp',
  queueItemId: 'q-eoa',
  arrivedAt: '2026-09-17 10:00:00',
  supplierId,
  supplierName: 'Alpha Dairy',
  documentTypeId: null,
  actorUserId: seed.orgAdminId,
  ...over,
});

beforeAll(async () => {
  seed = await seedTestData(db);
  supplierId = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(supplierId, seed.tenantId, 'Alpha Dairy', `alpha-${supplierId.slice(0, 6)}`)
    .run();
}, 30_000);

describe('recordArrivalAndCheckExpiry', () => {
  it('stamps the arrival and says nothing about a current certificate', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    try {
      const doc = await makeDocument('Current COI', '2027-01-01');
      const r = await recordArrivalAndCheckExpiry(db, 're_test', ctx(), [doc]);
      expect(r.expired).toEqual([]);
      const row = await db.prepare('SELECT arrived_at FROM documents WHERE id = ?').bind(doc).first<{ arrived_at: string }>();
      expect(row!.arrived_at).toBe('2026-09-17 10:00:00');
      expect(fetchSpy.mock.calls.filter((c) => String(c[0]).includes('resend.com'))).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('with no QA route: audits it and sends the routing-gap notice, not a broadcast', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    try {
      const doc = await makeDocument('SQF Certificate 2025', '2026-04-23');
      const r = await recordArrivalAndCheckExpiry(db, 're_test', ctx(), [doc]);
      expect(r.expired).toHaveLength(1);
      expect(r.via).toBe('unrouted');

      const calls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('resend.com'));
      expect(calls).toHaveLength(1);
      const body = JSON.parse(String((calls[0][1] as RequestInit).body));
      expect(body.subject).toMatch(/nobody was alerted/);

      const audits = await db
        .prepare(`SELECT action FROM audit_log WHERE tenant_id = ? AND action LIKE 'document.expired_on_arrival%'`)
        .bind(seed.tenantId)
        .all<{ action: string }>();
      const actions = audits.results.map((a) => a.action);
      expect(actions).toContain('document.expired_on_arrival');
      expect(actions).toContain('document.expired_on_arrival.routing_gap');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('with a QA route: mails the QA lane', async () => {
    await db
      .prepare(
        `INSERT INTO owner_routes (id, tenant_id, owner_key, owner_label, email) VALUES (?, ?, 'qa', 'QA', 'qa@test.com')`
      )
      .bind(generateTestId(), seed.tenantId)
      .run();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    try {
      const doc = await makeDocument('Kosher Letter', '2026-06-30');
      const r = await recordArrivalAndCheckExpiry(db, 're_test', ctx(), [doc]);
      expect(r.via).toBe('owner_route');
      expect(r.notified).toEqual(['qa@test.com']);
      const calls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('resend.com'));
      const body = JSON.parse(String((calls[0][1] as RequestInit).body));
      expect(body.to).toEqual(['qa@test.com']);
      expect(body.subject).toBe('SupDox: Kosher Letter was already expired when it arrived');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('never moves an arrival already on file', async () => {
    const doc = await makeDocument('Re-approved', null);
    await recordArrivalAndCheckExpiry(db, undefined, ctx({ arrivedAt: '2026-01-01 00:00:00' }), [doc]);
    await recordArrivalAndCheckExpiry(db, undefined, ctx({ arrivedAt: '2026-09-01 00:00:00' }), [doc]);
    const row = await db.prepare('SELECT arrived_at FROM documents WHERE id = ?').bind(doc).first<{ arrived_at: string }>();
    expect(row!.arrived_at).toBe('2026-01-01 00:00:00');
  });
});

describe('the gap loader reads the arrival', () => {
  it('an expired-on-arrival certificate does not close its requirement', async () => {
    const reqId = generateTestId();
    await db
      .prepare(`INSERT INTO requirements (id, tenant_id, name, slug) VALUES (?, ?, 'SQF Certificate', ?)`)
      .bind(reqId, seed.tenantId, `sqf-${reqId.slice(0, 6)}`)
      .run();
    await db
      .prepare(
        `INSERT INTO supplier_requirements (id, tenant_id, supplier_id, requirement_id, tier) VALUES (?, ?, ?, ?, 'required')`
      )
      .bind(generateTestId(), seed.tenantId, supplierId, reqId)
      .run();
    const doc = await makeDocument('SQF Certificate (old)', '2026-04-23');
    await recordArrivalAndCheckExpiry(db, undefined, ctx(), [doc]);
    await db
      .prepare(
        `INSERT INTO document_requirements (id, document_id, requirement_id, status, source, confirmed_at)
         VALUES (?, ?, ?, 'confirmed', 'human', datetime('now'))`
      )
      .bind(generateTestId(), doc, reqId)
      .run();

    const {
      gaps: [gap],
    } = await loadSupplierGaps(db, seed.tenantId, { supplierId });
    const item = gap.applicable.find((a) => a.requirement_id === reqId)!;
    expect(item.satisfied).toBe(false);
    expect(item.gap_reason).toBe('expired_on_arrival');
    expect(item.not_counted[0].document_id).toBe(doc);
  });
});
