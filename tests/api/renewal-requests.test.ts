/**
 * The supplier renewal send (migration 0133).
 *
 * The property this file exists to pin, above every other:
 *
 *   NOTHING IS EVER SENT TO A SUPPLIER WITHOUT AN APPROVE CALL.
 *
 * AJ Conner's rulings (D-040..D-051) are that the portal drafts and a person
 * approves, once, every time. The first test walks the scheduled run through
 * the whole ladder -- window open, day of, +7, +14, escalation -- one day at a
 * time and asserts that not one message reached the supplier's address. The
 * rest pin what makes that safe to rely on: the ladder, the four-message
 * ceiling, the supersede rule, who may approve, what ends a cycle, what the
 * supplier is and is not shown, and that every send records exactly what left.
 *
 * Handlers are driven directly (SELF.fetch is not wired in this project's
 * vitest-pool-workers config); the Resend HTTP call is stubbed.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables, generateTestId } from '../helpers/db';
import { onRequestPost as runScheduled } from '../../functions/api/expirations/run-scheduled';
import { onRequestPost as notifyPost } from '../../functions/api/expirations/notify';
import { onRequestGet as listGet } from '../../functions/api/renewal-requests/index';
import { onRequestPost as approvePost } from '../../functions/api/renewal-requests/[id]/sends/[sendId]/approve';
import { onRequestPost as skipPost } from '../../functions/api/renewal-requests/[id]/sends/[sendId]/skip';
import {
  onRequestGet as defaultOwnerGet,
  onRequestPut as defaultOwnerPut,
} from '../../functions/api/expirations/default-owner';
import { onRequestGet as supplierPageGet } from '../../functions/api/supplier-requests/public/[token]';
import { runRenewalAlerts } from '../../functions/lib/renewal-alerts';
import { normalizeOwnerKey } from '../../functions/lib/alert-routing';
import {
  RENEWAL_ESCALATE_AFTER_DAYS,
  RENEWAL_REQUEST_STAGES,
  renderRenewalRequestDraft,
  renewalRequestLinkBlock,
  renewalStageFor,
} from '../../shared/renewalRequestTemplate';
import type { RenewalRequestListResponse } from '../../shared/types';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

const DUE = '2026-09-01';
const CONTACT = 'docs@acme-supplier.example';
const TOKEN = 'test-renewal-alert-bearer-token';
const ORIGIN = 'https://portal.example.com';

interface SentMail {
  to: string[];
  from: string;
  reply_to?: string;
  subject: string;
  html: string;
  attachments?: unknown;
}

/** Every Resend POST. `failFor` makes the provider refuse mail to that address. */
function stubResend(failFor?: string): { sent: SentMail[] } {
  const sent: SentMail[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes('resend.com')) {
        const p = JSON.parse((init?.body as string) ?? '{}');
        if (failFor && (p.to as string[]).includes(failFor)) {
          return new Response('{"message":"mailbox unavailable"}', { status: 422 });
        }
        sent.push(p as SentMail);
      }
      return new Response('{}', { status: 200 });
    }),
  );
  return { sent };
}

const toContact = (sent: SentMail[]) => sent.filter((m) => m.to.includes(CONTACT));

/** YYYY-MM-DD `days` after `iso` (negative = before). */
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/** The `as_of` on which DUE is `daysUntil` days away. */
const asOfFor = (daysUntil: number) => addDays(DUE, -daysUntil);

function user(id: string, role: string, tenantId: string | null = seed.tenantId, email = `${id}@test.com`) {
  return { id, email, name: id, role, tenant_id: tenantId, active: 1 };
}
const orgAdmin = () => user(seed.orgAdminId, 'org_admin', seed.tenantId, 'orgadmin@test.com');
const regular = () => user(seed.userId, 'user', seed.tenantId, 'user@test.com');
const reader = () => user(seed.readerId, 'reader', seed.tenantId, 'reader@test.com');

async function call(
  fn: PagesFunction<any>,
  path: string,
  opts: { method?: string; body?: unknown; params?: Record<string, string>; as?: unknown; env?: Record<string, unknown> } = {},
): Promise<{ status: number; body: any }> {
  const init: RequestInit = { method: opts.method ?? 'GET' };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  const res = await fn({
    request: new Request(`${ORIGIN}${path}`, init),
    env: opts.env ?? { ...env, RESEND_API_KEY: 're_test' },
    data: { user: opts.as ?? orgAdmin() },
    params: opts.params ?? {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: path,
  } as any);
  return { status: res.status, body: await res.json() };
}

/** One tenant run, exactly as the cron makes it. */
async function run(asOf: string, opts: { key?: string | undefined; respectCooldown?: boolean } = {}) {
  return runRenewalAlerts(db, 'key' in opts ? opts.key : 're_test', {
    tenantId: seed.tenantId,
    asOf,
    appUrl: ORIGIN,
    respectCooldown: opts.respectCooldown ?? true,
    actorUserId: null,
  });
}

async function makeSupplier(name: string, tenantId = seed.tenantId): Promise<string> {
  const id = `sup-${generateTestId()}`;
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(id, tenantId, name, `${name.toLowerCase().replace(/\W+/g, '-')}-${generateTestId()}`)
    .run();
  return id;
}

async function addContact(supplierId: string, email = CONTACT, name: string | null = 'Dana Reyes'): Promise<string> {
  const id = `sc-${generateTestId()}`;
  await db
    .prepare(
      `INSERT INTO supplier_contacts
         (id, tenant_id, supplier_id, name, email, email_norm, is_document_contact, active)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
    )
    .bind(id, seed.tenantId, supplierId, name, email, email.toLowerCase())
    .run();
  return id;
}

async function makeRequirement(name: string, description: string | null = null): Promise<string> {
  const id = `req-${generateTestId()}`;
  await db
    .prepare('INSERT INTO requirements (id, tenant_id, slug, name, description, active) VALUES (?, ?, ?, ?, ?, 1)')
    .bind(id, seed.tenantId, `${name.toLowerCase().replace(/\W+/g, '-')}-${generateTestId()}`, name, description)
    .run();
  return id;
}

async function makeDoc(
  title: string,
  fields: {
    supplierId?: string | null;
    owner?: string | null;
    due?: string;
    requirementId?: string;
    description?: string;
    tenantId?: string;
  } = {},
): Promise<string> {
  const id = `doc-${generateTestId()}`;
  await db
    .prepare(
      `INSERT INTO documents
         (id, tenant_id, title, description, tags, current_version, status, created_by,
          owner, supplier_id, renewal_type, renewal_due_date)
       VALUES (?, ?, ?, ?, '[]', 1, 'active', ?, ?, ?, 'hard_expiry', ?)`,
    )
    .bind(
      id,
      fields.tenantId ?? seed.tenantId,
      title,
      fields.description ?? null,
      seed.userId,
      fields.owner ?? null,
      fields.supplierId ?? null,
      fields.due ?? DUE,
    )
    .run();
  if (fields.requirementId) {
    await db
      .prepare(
        `INSERT INTO document_requirements
           (id, document_id, requirement_id, status, confirmed_at, confirmed_by)
         VALUES (?, ?, ?, 'confirmed', datetime('now'), ?)`,
      )
      .bind(`dr-${generateTestId()}`, id, fields.requirementId, seed.orgAdminId)
      .run();
  }
  return id;
}

async function addRoute(label: string, target: { userId?: string; email?: string }): Promise<void> {
  await db
    .prepare(
      `INSERT INTO owner_routes (id, tenant_id, owner_key, owner_label, user_id, email, active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    )
    .bind(generateTestId(), seed.tenantId, normalizeOwnerKey(label), label, target.userId ?? null, target.email ?? null)
    .run();
}

async function setMasterUser(userId: string | null): Promise<void> {
  await db.prepare('UPDATE tenants SET default_owner_user_id = ? WHERE id = ?').bind(userId, seed.tenantId).run();
}

interface SendRow {
  id: string;
  renewal_request_id: string;
  stage: string;
  status: string;
  approver_user_id: string | null;
  approver_via: string | null;
  draft_subject: string;
  draft_body: string;
  sent_to: string | null;
  sent_subject: string | null;
  sent_body: string | null;
  approved_by: string | null;
  approved_at: string | null;
  notified_at: string | null;
  failure: string | null;
}

async function sendsFor(documentId: string): Promise<SendRow[]> {
  const res = await db
    .prepare(
      `SELECT s.* FROM renewal_request_sends s
         JOIN renewal_requests r ON r.id = s.renewal_request_id
        WHERE r.document_id = ?
        ORDER BY s.drafted_at, s.rowid`,
    )
    .bind(documentId)
    .all<SendRow>();
  return res.results ?? [];
}

async function waitingSend(documentId: string): Promise<SendRow> {
  const s = (await sendsFor(documentId)).filter((x) => x.status === 'pending' || x.status === 'failed');
  expect(s).toHaveLength(1);
  return s[0];
}

async function cycleFor(documentId: string, due = DUE) {
  return db
    .prepare('SELECT * FROM renewal_requests WHERE document_id = ? AND due_date = ?')
    .bind(documentId, due)
    .first<{ id: string; status: string; status_reason: string | null; request_id: string | null; supplier_id: string }>();
}

async function approve(send: SendRow, as: unknown = orgAdmin(), body?: { subject?: string; body?: string }, envOverride?: Record<string, unknown>) {
  return call(approvePost, `/api/renewal-requests/${send.renewal_request_id}/sends/${send.id}/approve`, {
    method: 'POST',
    params: { id: send.renewal_request_id, sendId: send.id },
    as,
    env: envOverride,
    body: { subject: body?.subject ?? send.draft_subject, body: body?.body ?? send.draft_body },
  });
}

async function audits(action: string): Promise<Array<{ user_id: string | null; details: any }>> {
  const res = await db
    .prepare('SELECT user_id, details FROM audit_log WHERE action = ? ORDER BY rowid')
    .bind(action)
    .all<{ user_id: string | null; details: string }>();
  return (res.results ?? []).map((r) => ({ user_id: r.user_id, details: JSON.parse(r.details) }));
}

beforeAll(async () => {
  await runMigrations(db);
}, 30_000);

beforeEach(async () => {
  await cleanTables(db);
  seed = await seedTestData(db);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ───────────────────────────────────────────────────────────────────────────
describe('the ladder (pure)', () => {
  it('names the stage that is due, and stops at the escalation line', () => {
    expect(renewalStageFor(61, 60)).toBeNull();
    expect(renewalStageFor(60, 60)).toBe('window_open');
    expect(renewalStageFor(1, 60)).toBe('window_open');
    expect(renewalStageFor(0, 60)).toBe('day_of');
    expect(renewalStageFor(-6, 60)).toBe('day_of');
    expect(renewalStageFor(-7, 60)).toBe('plus_7');
    expect(renewalStageFor(-13, 60)).toBe('plus_7');
    expect(renewalStageFor(-14, 60)).toBe('plus_14');
    expect(renewalStageFor(-(RENEWAL_ESCALATE_AFTER_DAYS - 1), 60)).toBe('plus_14');
    expect(renewalStageFor(-RENEWAL_ESCALATE_AFTER_DAYS, 60)).toBe('escalate');
    expect(RENEWAL_ESCALATE_AFTER_DAYS).toBe(21);
  });

  it('opens with the document\'s own lead time, not a fixed 60', () => {
    expect(renewalStageFor(85, 90)).toBe('window_open');
    expect(renewalStageFor(45, 30)).toBeNull();
  });

  it('has exactly four stages - the ceiling on what a supplier can receive', () => {
    expect([...RENEWAL_REQUEST_STAGES]).toEqual(['window_open', 'day_of', 'plus_7', 'plus_14']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the template is an allow-list', () => {
  const NEVER = [
    'doc-internal-id-9931',
    'OWNER-LABEL-QA-TEAM',
    'INTERNAL-NOTE-do-not-share',
    'SPEC-LIMIT-10-cfu',
    'buyer@internal.example',
    'INTERNAL-TITLE-Acme-COI-2026',
  ];

  it('ignores every field it was not built to read, at any depth', () => {
    // A caller handing it a whole document/expiration row plus the kitchen sink.
    const stuffed: any = {
      tenantName: 'Test Corp',
      contactName: 'Dana Reyes',
      items: [{ name: 'Certificate of Insurance', explanation: null, requirement_id: NEVER[0], notes: NEVER[2] }],
      dueDate: DUE,
      stage: 'window_open',
      requesterName: 'Pat Buyer',
      isFollowUp: false,
      id: NEVER[0],
      document_id: NEVER[0],
      owner: NEVER[1],
      title: NEVER[5],
      notes: NEVER[2],
      status_note: NEVER[2],
      spec_limits: [{ value_max: NEVER[3] }],
      assigned_to: NEVER[4],
      nested: { deeper: { owner: NEVER[1], note: NEVER[2] } },
    };
    for (const stage of RENEWAL_REQUEST_STAGES) {
      const { subject, body } = renderRenewalRequestDraft({ ...stuffed, stage });
      for (const needle of NEVER) {
        expect(subject).not.toContain(needle);
        expect(body).not.toContain(needle);
      }
      expect(body).toContain('Certificate of Insurance');
      expect(body).toContain('Hello Dana Reyes,');
    }
  });

  it('contains no link: the link block is the system\'s, appended at send', () => {
    const { body } = renderRenewalRequestDraft({
      tenantName: 'Test Corp',
      contactName: null,
      items: [{ name: 'Kosher Certificate' }],
      dueDate: DUE,
      stage: 'day_of',
      requesterName: null,
      isFollowUp: true,
    });
    expect(body).not.toMatch(/https?:\/\//);
    expect(body).toContain('Hello,');
    expect(body).toContain('following up');
    expect(renewalRequestLinkBlock('https://x.example/r/abc')).toContain('https://x.example/r/abc');
  });

  it('a drafted and a SENT request carry none of the document\'s internal text', async () => {
    const { sent } = stubResend();
    const supplierId = await makeSupplier('Acme Supplier');
    await addContact(supplierId);
    const reqId = await makeRequirement('Certificate of Insurance', NEVER[2]);
    const docId = await makeDoc(NEVER[5], {
      supplierId,
      owner: NEVER[1],
      requirementId: reqId,
      description: NEVER[2],
    });
    await db
      .prepare(
        `INSERT INTO entity_notes (id, tenant_id, entity_type, entity_id, body, author_id)
         VALUES (?, ?, 'document', ?, ?, ?)`,
      )
      .bind(generateTestId(), seed.tenantId, docId, NEVER[2], seed.orgAdminId)
      .run();

    await run(asOfFor(30));
    const draft = await waitingSend(docId);
    const res = await approve(draft);
    expect(res.status).toBe(200);

    const mail = toContact(sent);
    expect(mail).toHaveLength(1);
    const stored = (await sendsFor(docId))[0];
    for (const text of [draft.draft_subject, draft.draft_body, mail[0].subject, mail[0].html, stored.sent_body ?? '']) {
      for (const needle of [...NEVER, docId, reqId, seed.orgAdminId]) {
        expect(text).not.toContain(needle);
      }
    }
    expect(mail[0].html).toContain('Certificate of Insurance');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('THE INVARIANT: the portal never emails a supplier on its own', () => {
  it('a scheduled run on every day of the whole ladder sends the supplier nothing', async () => {
    const { sent } = stubResend();
    const supplierId = await makeSupplier('Acme Supplier');
    await addContact(supplierId);
    await addRoute('QA', { userId: seed.userId });
    const docId = await makeDoc('Acme COI', { supplierId, owner: 'QA' });

    // From before the window opens to well past escalation, every single day,
    // through the real cron endpoint.
    for (let d = 65; d >= -30; d--) {
      const res = await runScheduled({
        request: new Request(`${ORIGIN}/api/expirations/run-scheduled`, {
          method: 'POST',
          body: JSON.stringify({ as_of: asOfFor(d) }),
          headers: { Authorization: `Bearer ${TOKEN}` },
        }),
        env: { ...env, RENEWAL_ALERT_TOKEN: TOKEN, RESEND_API_KEY: 're_test' },
        data: {},
        params: {},
        waitUntil: () => {},
        passThroughOnException: () => {},
        next: async () => new Response(null),
        functionPath: '/api/expirations/run-scheduled',
      } as any);
      expect(res.status).toBe(200);
    }
    // ...and the manual button, for good measure.
    await call(notifyPost, '/api/expirations/notify', { method: 'POST', body: { as_of: asOfFor(-3) } });

    // Internal mail went out (digests, approval notices, the escalation).
    expect(sent.length).toBeGreaterThan(0);
    // Not one message to the supplier.
    expect(toContact(sent)).toEqual([]);
    for (const m of sent) {
      expect(m.to).not.toContain(CONTACT);
      expect(m.html).not.toContain('/r/'); // no supplier link was ever minted
    }

    // The ladder did run: four drafts, none sent, the cycle escalated.
    const sends = await sendsFor(docId);
    expect(sends.map((s) => s.stage)).toEqual(['window_open', 'day_of', 'plus_7', 'plus_14']);
    expect(sends.every((s) => s.status !== 'sent' && s.sent_to === null)).toBe(true);
    expect((await cycleFor(docId))?.status).toBe('escalated');
    // And nothing was composed or issued, because nobody approved anything.
    const requests = await db.prepare('SELECT COUNT(*) AS n FROM document_requests').first<{ n: number }>();
    const links = await db.prepare('SELECT COUNT(*) AS n FROM request_links').first<{ n: number }>();
    expect(requests?.n).toBe(0);
    expect(links?.n).toBe(0);
  }, 120_000);
});

// ───────────────────────────────────────────────────────────────────────────
describe('the ladder with a person approving each stage', () => {
  it('sends at most four, each on one approval, then stops and escalates', async () => {
    const { sent } = stubResend();
    const supplierId = await makeSupplier('Acme Supplier');
    await addContact(supplierId);
    const reqId = await makeRequirement('Certificate of Insurance');
    const docId = await makeDoc('Acme COI', { supplierId, requirementId: reqId });

    const stages: Array<[number, string]> = [
      [45, 'window_open'],
      [0, 'day_of'],
      [-7, 'plus_7'],
      [-14, 'plus_14'],
    ];
    for (const [d, stage] of stages) {
      const before = toContact(sent).length;
      await run(asOfFor(d));
      // Drafted, not sent.
      expect(toContact(sent)).toHaveLength(before);
      const draft = await waitingSend(docId);
      expect(draft.stage).toBe(stage);
      const res = await approve(draft);
      expect(res.status).toBe(200);
      expect(res.body.sent).toBe(true);
      expect(toContact(sent)).toHaveLength(before + 1);
    }

    const mail = toContact(sent);
    expect(mail).toHaveLength(4);
    for (const m of mail) {
      expect(m.to).toEqual([CONTACT]);
      // "<Tenant> via SupDox", from the portal's own address; reply-to the approver.
      expect(m.from).toBe('Test Corp via SupDox <noreply@supdox.com>');
      expect(m.reply_to).toBe('orgadmin@test.com');
      expect(m.attachments).toBeUndefined();
      expect(m.html).toMatch(/https:\/\/portal\.example\.com\/r\/[A-Za-z0-9_-]+/);
    }
    // Follow-ups say they are follow-ups; the first does not.
    expect(mail[0].html).not.toContain('following up');
    expect(mail[1].html).toContain('following up');

    // ONE request and ONE link for the whole cycle, issued by the approver.
    const requests = await db
      .prepare('SELECT id, origin, origin_ref, status, supplier_id, created_by FROM document_requests')
      .all<any>();
    expect(requests.results).toHaveLength(1);
    expect(requests.results[0]).toMatchObject({
      origin: 'generated',
      origin_ref: `renewal:${docId}:${DUE}`,
      status: 'issued',
      supplier_id: supplierId,
      created_by: seed.orgAdminId,
    });
    const routing = await db.prepare('SELECT channel, recipient, issued_by FROM request_routing').all<any>();
    expect(routing.results).toEqual([{ channel: 'email', recipient: CONTACT, issued_by: seed.orgAdminId }]);
    const lines = await db.prepare('SELECT line_kind, requirement_id, name FROM request_lines').all<any>();
    expect(lines.results).toEqual([
      { line_kind: 'requirement', requirement_id: reqId, name: 'Certificate of Insurance' },
    ]);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM request_links').first<{ n: number }>())?.n).toBe(1);

    // The supplier's page shows ONLY the expiring item.
    const token = /\/r\/([A-Za-z0-9_-]+)/.exec(mail[0].html)![1];
    const page = await call(supplierPageGet, `/api/supplier-requests/public/${token}`, { params: { token }, as: undefined });
    expect(page.status).toBe(200);
    expect(page.body.items.map((i: any) => i.name)).toEqual(['Certificate of Insurance']);

    // Day 20: still inside the last follow-up window. Nothing new.
    await run(asOfFor(-20));
    expect((await sendsFor(docId)).filter((s) => s.status === 'pending')).toEqual([]);
    expect((await cycleFor(docId))?.status).toBe('open');

    // Day 21: stop. Escalate internally, once.
    const beforeEscalation = sent.length;
    const escalated = await run(asOfFor(-RENEWAL_ESCALATE_AFTER_DAYS));
    expect(escalated.supplier_requests.escalated).toEqual([
      { renewal_request_id: (await cycleFor(docId))!.id, document_id: docId, emails_sent: 4 },
    ]);
    expect((await cycleFor(docId))?.status).toBe('escalated');
    const notice = sent.slice(beforeEscalation).find((m) => m.subject.includes('unanswered'));
    expect(notice?.to).toEqual(['orgadmin@test.com']);
    expect(notice?.html).toContain('4 requests sent');
    const audit = await audits('expirations.supplier_send_escalated');
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ document_id: docId, emails_sent: 4, days_past_due: 21 });

    // And it stays stopped: later runs draft nothing and escalate nothing.
    const after = sent.length;
    await run(asOfFor(-22));
    await run(asOfFor(-40));
    expect(toContact(sent)).toHaveLength(4);
    expect(sent.slice(after).some((m) => m.subject.includes('unanswered'))).toBe(false);
    expect(await sendsFor(docId)).toHaveLength(4);
    expect(await audits('expirations.supplier_send_escalated')).toHaveLength(1);
  });

  it('stores and audits exactly what left: the edited text plus the system link block', async () => {
    const { sent } = stubResend();
    const supplierId = await makeSupplier('Acme Supplier');
    await addContact(supplierId);
    const docId = await makeDoc('Acme COI', { supplierId });
    await run(asOfFor(30));
    const draft = await waitingSend(docId);

    const edited = 'Hi Dana,\n\nPlease send the new certificate.\n\nThanks,\nPat';
    const res = await approve(draft, orgAdmin(), { subject: 'New certificate please', body: edited });
    expect(res.status).toBe(200);

    const stored = (await sendsFor(docId))[0];
    const url = /https:\/\/portal\.example\.com\/r\/[A-Za-z0-9_-]+/.exec(toContact(sent)[0].html)![0];
    expect(stored.status).toBe('sent');
    expect(stored.sent_to).toBe(CONTACT);
    expect(stored.sent_subject).toBe('New certificate please');
    // The approved body, then the block the system appended - nothing else.
    expect(stored.sent_body).toBe(`${edited}\n\n${renewalRequestLinkBlock(url)}`);
    expect(stored.approved_by).toBe(seed.orgAdminId);
    expect(stored.approved_at).toBeTruthy();
    // The draft the template produced is kept as it was.
    expect(stored.draft_body).toBe(draft.draft_body);

    const [row] = await audits('renewal_request.sent');
    expect(row.user_id).toBe(seed.orgAdminId);
    expect(row.details).toMatchObject({
      send_id: draft.id,
      stage: 'window_open',
      document_id: docId,
      sent_to: CONTACT,
      reply_to: 'orgadmin@test.com',
      from_name: 'Test Corp via SupDox',
      subject: 'New certificate please',
      body: stored.sent_body,
      edited: true,
    });
  });

  it('the link block cannot be edited out: an approved body with no link still sends one', async () => {
    const { sent } = stubResend();
    const supplierId = await makeSupplier('Acme Supplier');
    await addContact(supplierId);
    const docId = await makeDoc('Acme COI', { supplierId });
    await run(asOfFor(30));
    const res = await approve(await waitingSend(docId), orgAdmin(), { subject: 'x', body: 'No link here.' });
    expect(res.status).toBe(200);
    expect(toContact(sent)[0].html).toMatch(/\/r\/[A-Za-z0-9_-]+/);
    expect((await sendsFor(docId))[0].sent_body).toContain('Upload the document here');
  });

  it('refuses an empty subject or body, and sends nothing', async () => {
    const { sent } = stubResend();
    const supplierId = await makeSupplier('Acme Supplier');
    await addContact(supplierId);
    const docId = await makeDoc('Acme COI', { supplierId });
    await run(asOfFor(30));
    const draft = await waitingSend(docId);
    expect((await approve(draft, orgAdmin(), { subject: '   ', body: 'x' })).status).toBe(400);
    expect((await approve(draft, orgAdmin(), { subject: 'x', body: '  ' })).status).toBe(400);
    expect(toContact(sent)).toEqual([]);
    expect((await waitingSend(docId)).status).toBe('pending');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('drafting', () => {
  it('is idempotent: the cron twice and the manual button draft once', async () => {
    stubResend();
    const supplierId = await makeSupplier('Acme Supplier');
    await addContact(supplierId);
    const docId = await makeDoc('Acme COI', { supplierId });

    const first = await run(asOfFor(30));
    expect(first.supplier_requests.drafted).toHaveLength(1);
    const second = await run(asOfFor(30));
    expect(second.supplier_requests.drafted).toEqual([]);
    const button = await call(notifyPost, '/api/expirations/notify', { method: 'POST', body: { as_of: asOfFor(30) } });
    expect(button.body.supplier_requests.drafted).toEqual([]);
    await run(asOfFor(29));

    expect(await sendsFor(docId)).toHaveLength(1);
    expect(await audits('renewal_request.drafted')).toHaveLength(1);
  });

  it('a newer stage SUPERSEDES an unapproved older one - only one draft ever waits', async () => {
    stubResend();
    const supplierId = await makeSupplier('Acme Supplier');
    await addContact(supplierId);
    const docId = await makeDoc('Acme COI', { supplierId });

    await run(asOfFor(30));
    const dayOf = await run(asOfFor(0));
    expect(dayOf.supplier_requests.superseded_count).toBe(1);
    await run(asOfFor(-8));

    const sends = await sendsFor(docId);
    expect(sends.map((s) => [s.stage, s.status])).toEqual([
      ['window_open', 'superseded'],
      ['day_of', 'superseded'],
      ['plus_7', 'pending'],
    ]);
    // A superseded draft can no longer be approved.
    const stale = await approve(sends[0]);
    expect(stale.status).toBe(409);
  });

  it('still drafts the day-of stage when the owner digest is suppressed by its cooldown', async () => {
    const { sent } = stubResend();
    const supplierId = await makeSupplier('Acme Supplier');
    await addContact(supplierId);
    await addRoute('QA', { userId: seed.userId });
    const docId = await makeDoc('Acme COI', { supplierId, owner: 'QA' });

    // Three days out: the digest goes (first sight) and carries the draft.
    const a = await run(asOfFor(3));
    expect(a.sent).toBe(true);
    // Day of: still 'expiring', mailed 3 days ago -> the digest is suppressed...
    const before = sent.length;
    const b = await run(asOfFor(0));
    expect(b.reason).toBe('all_suppressed');
    // ...and the day-of draft exists anyway, announced by its own notice.
    expect(b.supplier_requests.drafted.map((d) => d.stage)).toEqual(['day_of']);
    expect((await waitingSend(docId)).stage).toBe('day_of');
    const notice = sent.slice(before);
    expect(notice).toHaveLength(1);
    expect(notice[0].to).toEqual(['user@test.com']);
    expect(notice[0].subject).toContain('waiting for your approval');
    expect(b.supplier_requests.approver_notices).toEqual([
      { send_ids: [(await waitingSend(docId)).id], recipients: ['user@test.com'], via: 'notice', sent: true },
    ]);
  });

  it('reports a document with no supplier, and a supplier with no document contact - never silently', async () => {
    stubResend();
    const withContact = await makeSupplier('Has Contact');
    await addContact(withContact);
    const noContact = await makeSupplier('No Contact Co');
    const orphan = await makeDoc('Our own FDA registration');
    const waiting = await makeDoc('No Contact COI', { supplierId: noContact });
    const drafted = await makeDoc('Has Contact COI', { supplierId: withContact });

    const res = await run(asOfFor(30));
    expect(res.supplier_requests.drafted.map((d) => d.document_id)).toEqual([drafted]);
    expect(res.supplier_requests.not_drafted.no_supplier.map((d) => d.document_id)).toEqual([orphan]);
    expect(res.supplier_requests.not_drafted.no_contact).toEqual([
      expect.objectContaining({ document_id: waiting, supplier_id: noContact, supplier_name: 'No Contact Co' }),
    ]);
    // No cycle and no draft is opened for either.
    expect(await cycleFor(orphan)).toBeNull();
    expect(await cycleFor(waiting)).toBeNull();

    // The Renewals page says the same thing, at read.
    const list = await call(listGet, `/api/renewal-requests?as_of=${asOfFor(30)}`);
    const body = list.body as RenewalRequestListResponse;
    expect(body.not_drafted.no_supplier.map((d) => d.document_id)).toEqual([orphan]);
    expect(body.not_drafted.no_contact.map((d) => d.document_id)).toEqual([waiting]);
    expect(body.requests.map((r) => r.document.id)).toEqual([drafted]);

    // Adding the contact is what starts it.
    await addContact(noContact, 'qa@nocontact.example');
    const next = await run(asOfFor(29));
    expect(next.supplier_requests.drafted.map((d) => d.document_id)).toEqual([waiting]);
  });

  it('is inert for a tenant with no contacts: no rows, and no mail beyond the existing alert', async () => {
    const { sent } = stubResend();
    const supplierId = await makeSupplier('Acme Supplier');
    await addRoute('QA', { userId: seed.userId });
    await makeDoc('Acme COI', { supplierId, owner: 'QA' });

    const res = await run(asOfFor(30));
    expect(res.sent).toBe(true);
    expect(sent).toHaveLength(1); // the owner digest, exactly as before 0133
    expect(sent[0].html).not.toContain('waiting for approval');
    expect(res.supplier_requests.drafted).toEqual([]);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM renewal_requests').first<{ n: number }>())?.n).toBe(0);
  });

  it('does not open a cycle for a document first seen past the escalation line', async () => {
    const { sent } = stubResend();
    const supplierId = await makeSupplier('Acme Supplier');
    await addContact(supplierId);
    const docId = await makeDoc('Long expired COI', { supplierId });

    const res = await run(asOfFor(-45));
    expect(res.supplier_requests.not_drafted.past_escalation.map((d) => d.document_id)).toEqual([docId]);
    expect(res.supplier_requests.escalated).toEqual([]);
    expect(await cycleFor(docId)).toBeNull();
    expect(sent.some((m) => m.subject.includes('unanswered'))).toBe(false);
  });

  it('a document first seen late starts at the stage due today, never backfilling earlier ones', async () => {
    stubResend();
    const supplierId = await makeSupplier('Acme Supplier');
    await addContact(supplierId);
    const docId = await makeDoc('Acme COI', { supplierId });
    await run(asOfFor(-9));
    const sends = await sendsFor(docId);
    expect(sends.map((s) => s.stage)).toEqual(['plus_7']);
    // Nothing was sent before it, so it does not claim to be a follow-up.
    expect(sends[0].draft_body).not.toContain('following up');
  });

  it('drafts without a mail key (nothing to send yet), and says the approver was not told', async () => {
    const supplierId = await makeSupplier('Acme Supplier');
    await addContact(supplierId);
    const docId = await makeDoc('Acme COI', { supplierId });

    const res = await run(asOfFor(30), { key: undefined });
    expect(res.reason).toBe('email_not_configured');
    expect(res.supplier_requests.drafted).toHaveLength(1);
    expect(res.supplier_requests.approver_notices).toEqual([
      expect.objectContaining({ via: 'notice', sent: false, recipients: ['orgadmin@test.com'] }),
    ]);
    const draft = await waitingSend(docId);
    expect(draft.notified_at).toBeNull();

    // Approving with no mail configured sends nothing and leaves the draft waiting.
    const noMail = await approve(draft, orgAdmin(), undefined, { ...env, RESEND_API_KEY: undefined });
    expect(noMail.status).toBe(503);
    expect(noMail.body.code).toBe('email_not_configured');
    expect((await waitingSend(docId)).status).toBe('pending');
    expect((await db.prepare('SELECT COUNT(*) AS n FROM document_requests').first<{ n: number }>())?.n).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('who approves (D-050) and how they hear about it (D-049)', () => {
  it('the first portal user on the owner route - told in the SAME email as the alert', async () => {
    const { sent } = stubResend();
    const supplierId = await makeSupplier('Acme Supplier');
    await addContact(supplierId);
    await addRoute('QA', { userId: seed.userId });
    const docId = await makeDoc('Acme COI', { supplierId, owner: 'QA' });

    const res = await run(asOfFor(30));
    const draft = await waitingSend(docId);
    expect(draft.approver_user_id).toBe(seed.userId);
    expect(draft.approver_via).toBe('owner_route');

    // ONE notification: the owner digest, carrying the draft and its link.
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['user@test.com']);
    expect(sent[0].html).toContain('waiting for approval');
    expect(sent[0].html).toContain(`${ORIGIN}/expirations?supplier_request=${draft.id}`);
    expect(res.supplier_requests.approver_notices).toEqual([
      { send_ids: [draft.id], recipients: ['user@test.com'], via: 'owner_digest', sent: true },
    ]);
    expect((await waitingSend(docId)).notified_at).toBeTruthy();

    // Told once: the next morning repeats nothing.
    await run(asOfFor(29));
    expect(sent).toHaveLength(1);
  });

  it('falls back to the master user when the route names no portal user, with a notice of their own', async () => {
    const { sent } = stubResend();
    const supplierId = await makeSupplier('Acme Supplier');
    await addContact(supplierId);
    // The route holds only a bare address: someone to alert, nobody to approve.
    await addRoute('Insurance', { email: 'broker@outside.example' });
    await setMasterUser(seed.userId);
    const docId = await makeDoc('Acme COI', { supplierId, owner: 'Insurance' });

    await run(asOfFor(30));
    const draft = await waitingSend(docId);
    expect(draft.approver_user_id).toBe(seed.userId);
    expect(draft.approver_via).toBe('master_user');

    // The broker gets the alert WITHOUT the approval line; the master user gets the notice.
    const digest = sent.find((m) => m.to.includes('broker@outside.example'))!;
    expect(digest.html).not.toContain('waiting for approval');
    const notice = sent.find((m) => m.to.includes('user@test.com'))!;
    expect(notice.subject).toContain('waiting for your approval');
    expect(sent).toHaveLength(2);
  });

  it('falls back to the org_admins when there is neither', async () => {
    const { sent } = stubResend();
    const supplierId = await makeSupplier('Acme Supplier');
    await addContact(supplierId);
    const docId = await makeDoc('Acme COI', { supplierId });

    await run(asOfFor(30));
    const draft = await waitingSend(docId);
    expect(draft.approver_user_id).toBeNull();
    expect(draft.approver_via).toBe('org_admins');
    const notice = sent.find((m) => m.subject.includes('waiting for your approval'))!;
    expect(notice.to).toEqual(['orgadmin@test.com']);
  });

  it('a deactivated master user stops resolving', async () => {
    stubResend();
    const supplierId = await makeSupplier('Acme Supplier');
    await addContact(supplierId);
    await setMasterUser(seed.inactiveId);
    const docId = await makeDoc('Acme COI', { supplierId });
    await run(asOfFor(30));
    expect((await waitingSend(docId)).approver_via).toBe('org_admins');
  });

  it('a read-only account is never the approver, and cannot approve even when one is on the route', async () => {
    const { sent } = stubResend();
    const supplierId = await makeSupplier('Acme Supplier');
    await addContact(supplierId);
    // The owner route names only a reader: the draft falls through to the admins.
    await addRoute('QA', { userId: seed.readerId });
    const docId = await makeDoc('Acme COI', { supplierId, owner: 'QA' });
    await run(asOfFor(30));
    const draft = await waitingSend(docId);
    expect(draft.approver_user_id).toBeNull();
    expect(draft.approver_via).toBe('org_admins');

    // Even a draft stamped with a reader's id is refused: approving sends mail
    // outside the organization.
    await db.prepare('UPDATE renewal_request_sends SET approver_user_id = ? WHERE id = ?').bind(seed.readerId, draft.id).run();
    expect((await approve(await waitingSend(docId), reader())).status).toBe(403);
    expect(toContact(sent)).toEqual([]);
  });

  it('only the assigned approver or an administrator may approve or skip', async () => {
    const { sent } = stubResend();
    const supplierId = await makeSupplier('Acme Supplier');
    await addContact(supplierId);
    await addRoute('QA', { userId: seed.userId });
    const docId = await makeDoc('Acme COI', { supplierId, owner: 'QA' });
    await run(asOfFor(30));
    const draft = await waitingSend(docId);

    // A reader, and a user the draft was not routed to: refused.
    expect((await approve(draft, reader())).status).toBe(403);
    const other = user('user-other', 'user');
    await db
      .prepare(
        `INSERT INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
         VALUES ('user-other', 'other@test.com', 'Other', 'user', ?, 'x', 1, 0)`,
      )
      .bind(seed.tenantId)
      .run();
    expect((await approve(draft, other)).status).toBe(403);
    expect(
      (await call(skipPost, '/x', { method: 'POST', params: { id: draft.renewal_request_id, sendId: draft.id }, as: other })).status,
    ).toBe(403);
    // Another organisation's admin cannot even see it.
    const foreign = user(seed.orgAdmin2Id, 'org_admin', seed.tenantId2);
    expect((await approve(draft, foreign)).status).toBe(404);
    expect(toContact(sent)).toEqual([]);

    // The list tells each caller the truth about the button.
    const asReader = await call(listGet, '/api/renewal-requests', { as: reader() });
    expect(asReader.body.requests[0].can_approve).toBe(false);
    const asApprover = await call(listGet, '/api/renewal-requests', { as: regular() });
    expect(asApprover.body.requests[0].can_approve).toBe(true);
    expect(asApprover.body.requests[0].contact).toEqual({ name: 'Dana Reyes', email: CONTACT });

    // The assigned approver - a plain `user`, not an admin - approves.
    const ok = await approve(draft, regular());
    expect(ok.status).toBe(200);
    expect(toContact(sent)).toHaveLength(1);
    expect(toContact(sent)[0].reply_to).toBe('user@test.com');
    // The request was composed and issued AS them.
    const routing = await db.prepare('SELECT issued_by FROM request_routing').first<{ issued_by: string }>();
    expect(routing?.issued_by).toBe(seed.userId);

    // Approving twice does not send twice.
    expect((await approve(draft, regular())).status).toBe(409);
    expect(toContact(sent)).toHaveLength(1);
  });

  it('skip sends nothing, and the next stage is still drafted', async () => {
    const { sent } = stubResend();
    const supplierId = await makeSupplier('Acme Supplier');
    await addContact(supplierId);
    const docId = await makeDoc('Acme COI', { supplierId });
    await run(asOfFor(30));
    const draft = await waitingSend(docId);

    const res = await call(skipPost, '/x', {
      method: 'POST',
      params: { id: draft.renewal_request_id, sendId: draft.id },
    });
    expect(res.status).toBe(200);
    expect(res.body.request.sends[0].status).toBe('skipped');
    expect(toContact(sent)).toEqual([]);
    expect((await audits('renewal_request.skipped'))[0].details.send_id).toBe(draft.id);
    expect((await approve(draft)).status).toBe(409);

    await run(asOfFor(0));
    expect((await waitingSend(docId)).stage).toBe('day_of');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('sending can fail without lying', () => {
  it('a refused send is `failed`, says why, is retryable, and re-uses the same request', async () => {
    const supplierId = await makeSupplier('Acme Supplier');
    await addContact(supplierId);
    const docId = await makeDoc('Acme COI', { supplierId });

    stubResend(CONTACT);
    await run(asOfFor(30));
    const draft = await waitingSend(docId);
    const refused = await approve(draft);
    expect(refused.status).toBe(502);
    expect(refused.body).toMatchObject({ sent: false, code: 'send_failed' });

    const failed = (await sendsFor(docId))[0];
    expect(failed.status).toBe('failed');
    expect(failed.sent_to).toBeNull();
    expect(failed.sent_body).toBeNull();
    expect(failed.failure).toContain('mailbox unavailable');
    expect(await audits('renewal_request.sent')).toEqual([]);
    expect((await audits('renewal_request.send_failed'))[0].details.sent_to).toBe(CONTACT);

    // The provider recovers; the same draft is approved again.
    vi.unstubAllGlobals();
    const { sent } = stubResend();
    const retried = await approve(failed);
    expect(retried.status).toBe(200);
    expect(toContact(sent)).toHaveLength(1);
    expect((await sendsFor(docId))[0].status).toBe('sent');
    // One request, one link - the failed attempt's, not a second pair.
    expect((await db.prepare('SELECT COUNT(*) AS n FROM document_requests').first<{ n: number }>())?.n).toBe(1);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM request_links').first<{ n: number }>())?.n).toBe(1);
  });

  it('refuses when the document contact was removed after drafting', async () => {
    const { sent } = stubResend();
    const supplierId = await makeSupplier('Acme Supplier');
    const contactId = await addContact(supplierId);
    const docId = await makeDoc('Acme COI', { supplierId });
    await run(asOfFor(30));
    await db.prepare('DELETE FROM supplier_contacts WHERE id = ?').bind(contactId).run();

    const res = await approve(await waitingSend(docId));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('no_document_contact');
    expect(sent.filter((m) => m.to.includes(CONTACT))).toEqual([]);
    expect((await waitingSend(docId)).status).toBe('pending');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('what ends a cycle', () => {
  async function sentOnce(): Promise<{ docId: string; supplierId: string; sent: SentMail[] }> {
    const { sent } = stubResend();
    const supplierId = await makeSupplier('Acme Supplier');
    await addContact(supplierId);
    const reqId = await makeRequirement('Certificate of Insurance');
    const docId = await makeDoc('Acme COI', { supplierId, requirementId: reqId });
    await run(asOfFor(30));
    expect((await approve(await waitingSend(docId))).status).toBe(200);
    return { docId, supplierId, sent };
  }

  it('an accepted replacement: satisfied, and no further reminder is drafted', async () => {
    const { docId, supplierId, sent } = await sentOnce();
    // A person accepts the supplier's new certificate against the request line.
    const replacement = await makeDoc('Acme COI 2027', { supplierId, due: '2027-09-01' });
    await db.prepare('UPDATE request_lines SET status = ?, accepted_document_id = ?').bind('accepted', replacement).run();

    const res = await run(asOfFor(0));
    expect(res.supplier_requests.ended).toEqual([
      expect.objectContaining({ document_id: docId, status: 'satisfied', reason: 'replacement_accepted' }),
    ]);
    expect(res.supplier_requests.drafted).toEqual([]);
    expect((await cycleFor(docId))?.status).toBe('satisfied');

    for (const d of [-7, -14, -21, -30]) await run(asOfFor(d));
    expect((await sendsFor(docId)).map((s) => s.stage)).toEqual(['window_open']);
    expect(toContact(sent)).toHaveLength(1);
    expect(await audits('expirations.supplier_send_escalated')).toEqual([]);
    expect((await audits('renewal_request.cycle_ended'))[0].details.reason).toBe('replacement_accepted');
  });

  it('a changed due date: the old cycle stops, its waiting draft is withdrawn, the new date is a new cycle', async () => {
    const { docId, sent } = await sentOnce();
    await run(asOfFor(0)); // day-of draft now waiting
    const waiting = await waitingSend(docId);
    expect(waiting.stage).toBe('day_of');

    const newDue = addDays(DUE, 365);
    await db.prepare('UPDATE documents SET renewal_due_date = ? WHERE id = ?').bind(newDue, docId).run();
    const res = await run(asOfFor(-1));
    expect(res.supplier_requests.ended).toEqual([
      expect.objectContaining({ document_id: docId, status: 'stopped', reason: 'due_date_changed' }),
    ]);
    expect((await cycleFor(docId))).toMatchObject({ status: 'stopped', status_reason: 'due_date_changed' });
    expect((await sendsFor(docId)).map((s) => [s.stage, s.status])).toEqual([
      ['window_open', 'sent'],
      ['day_of', 'cancelled'],
    ]);
    // The withdrawn draft cannot be sent.
    expect((await approve(waiting)).status).toBe(409);
    expect(toContact(sent)).toHaveLength(1);

    // Next year, inside the new window: a fresh cycle with its own first request.
    const next = await run(addDays(newDue, -20));
    expect(next.supplier_requests.drafted.map((d) => d.stage)).toEqual(['window_open']);
    expect((await cycleFor(docId, newDue))?.status).toBe('open');
  });

  it('an archived document: stopped', async () => {
    const { docId } = await sentOnce();
    await db.prepare(`UPDATE documents SET status = 'archived' WHERE id = ?`).bind(docId).run();
    const res = await run(asOfFor(0));
    expect(res.supplier_requests.ended).toEqual([
      expect.objectContaining({ document_id: docId, status: 'stopped', reason: 'document_archived' }),
    ]);
    await run(asOfFor(-25));
    expect(await audits('expirations.supplier_send_escalated')).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('what the request asks for', () => {
  it('falls back to the type\'s default requirements, then to one declared free-text line', async () => {
    stubResend();
    const supplierId = await makeSupplier('Acme Supplier');
    await addContact(supplierId);
    const typeId = `dt-${generateTestId()}`;
    await db
      .prepare(`INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, 'Kosher Certificate', ?, 1)`)
      .bind(typeId, seed.tenantId, `kosher-${generateTestId()}`)
      .run();
    const reqId = await makeRequirement('Kosher Certification');
    await db
      .prepare('INSERT INTO document_type_requirements (id, tenant_id, document_type_id, requirement_id) VALUES (?, ?, ?, ?)')
      .bind(generateTestId(), seed.tenantId, typeId, reqId)
      .run();

    const typed = await makeDoc('Acme kosher letter', { supplierId });
    await db.prepare('UPDATE documents SET document_type_id = ? WHERE id = ?').bind(typeId, typed).run();
    const bare = await makeDoc('Acme something', { supplierId });

    await run(asOfFor(30));
    const typedDraft = (await sendsFor(typed))[0];
    expect(typedDraft.draft_body).toContain('Kosher Certification');
    expect((await approve(typedDraft)).status).toBe(200);
    expect((await approve((await sendsFor(bare))[0])).status).toBe(200);

    const lines = await db
      .prepare(
        `SELECT rl.line_kind, rl.requirement_id, rl.name
           FROM request_lines rl JOIN document_requests dr ON dr.id = rl.request_id
          ORDER BY dr.origin_ref`,
      )
      .all<any>();
    const byKind = Object.fromEntries(lines.results.map((l: any) => [l.line_kind, l]));
    expect(byKind.requirement).toMatchObject({ requirement_id: reqId, name: 'Kosher Certification' });
    // Never the document's title - that is our filing label, not their word.
    expect(byKind.free_text.name).toBe('Current version of the document on file');
    expect(lines.results).toHaveLength(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the master user setting', () => {
  it('is set, read, audited, and refuses anyone who is not an active user of the tenant', async () => {
    const put = (body: unknown, as: unknown = orgAdmin()) =>
      call(defaultOwnerPut, '/api/expirations/default-owner', { method: 'PUT', body, as });

    const initial = await call(defaultOwnerGet, '/api/expirations/default-owner');
    expect(initial.body).toMatchObject({ user_id: null, resolves: false });
    expect(initial.body.candidates.map((c: any) => c.id)).toContain(seed.userId);
    expect(initial.body.candidates.map((c: any) => c.id)).not.toContain(seed.inactiveId);

    expect((await put({})).status).toBe(400); // omission is not "clear it"
    expect((await put({ user_id: seed.inactiveId })).status).toBe(400);
    expect((await put({ user_id: seed.orgAdmin2Id })).status).toBe(400); // another tenant
    expect((await put({ user_id: seed.userId }, regular())).status).toBe(403);

    const set = await put({ user_id: seed.userId });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ user_id: seed.userId, user_email: 'user@test.com', resolves: true, unchanged: false });
    expect((await put({ user_id: seed.userId })).body.unchanged).toBe(true);

    const cleared = await put({ user_id: null });
    expect(cleared.body).toMatchObject({ user_id: null, resolves: false });

    const rows = await audits('renewal_default_owner_updated');
    expect(rows.map((r) => r.details)).toEqual([
      { previous_user_id: null, user_id: seed.userId },
      { previous_user_id: seed.userId, user_id: null },
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The tenant brand on a supplier request (migration 0140)
// ───────────────────────────────────────────────────────────────────────────
describe('the tenant brand on a supplier request (migration 0140)', () => {
  async function setBrand(tenantId: string, cols: Record<string, string | null>): Promise<void> {
    const keys = Object.keys(cols);
    await db
      .prepare(`INSERT INTO tenant_brands (tenant_id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`)
      .bind(tenantId, ...keys.map((k) => cols[k]))
      .run();
  }

  it('dresses the mail and names the organisation by its display name; the approved text is untouched', async () => {
    await setBrand(seed.tenantId, {
      display_name: 'Northfield Foods',
      primary_color: '#0B6E4F',
      support_text: 'DEFAULT-LINE-NOT-FOR-SUPPLIERS',
      support_overrides: JSON.stringify({
        supplier_request: { text: 'Supplier desk', email: 'suppliers@northfield.example', phone: null },
      }),
    });
    await setBrand(seed.tenantId2, { display_name: 'OTHER-TENANT-BRAND', support_text: 'OTHER-TENANT-LINE' });

    const { sent } = stubResend();
    const supplierId = await makeSupplier('Acme Supplier');
    await addContact(supplierId);
    const docId = await makeDoc('Acme COI', { supplierId });
    await run(asOfFor(30));
    const draft = await waitingSend(docId);
    // The draft a person reads already says who the supplier knows us as.
    expect(draft.draft_subject).toContain('Northfield Foods');
    expect(draft.draft_body).toContain('Northfield Foods');
    expect(`${draft.draft_subject}\n${draft.draft_body}`).not.toContain('Test Corp');

    expect((await approve(draft)).status).toBe(200);
    const [mail] = toContact(sent);
    expect(mail.html).toContain('<td style="background:#0B6E4F;padding:24px 32px;">');
    expect(mail.html).toContain('font-weight:600;">Northfield Foods</h1>');
    expect(mail.html).toContain('background:#0B6E4F;color:#ffffff;');
    expect(mail.html).toContain('<strong>Northfield Foods</strong> &middot; Supplier desk &middot; <a href="mailto:suppliers@northfield.example"');
    // The supplier surface's line only; nothing of the other tenant.
    for (const leak of ['DEFAULT-LINE-NOT-FOR-SUPPLIERS', 'OTHER-TENANT-BRAND', 'OTHER-TENANT-LINE', 'Test Corp', '#1A365D']) {
      expect(mail.html).not.toContain(leak);
    }
    // Who it is from and who a reply reaches: the address never moves.
    expect(mail.from).toBe('Northfield Foods via SupDox <noreply@supdox.com>');
    expect(mail.reply_to).toBe('orgadmin@test.com');

    // What is STORED as sent is still the approved text plus the link block.
    const stored = (await sendsFor(docId))[0];
    const url = /https:\/\/portal\.example\.com\/r\/[A-Za-z0-9_-]+/.exec(mail.html)![0];
    expect(stored.sent_body).toBe(`${String(draft.draft_body).replace(/\s+$/, '')}\n\n${renewalRequestLinkBlock(url)}`);
    expect(stored.sent_body).not.toContain('Supplier desk');

    // ...and the audit row says what it was dressed in.
    const [row] = await audits('renewal_request.sent');
    expect(row.details).toMatchObject({
      from_name: 'Northfield Foods via SupDox',
      body: stored.sent_body,
      brand: {
        display_name: 'Northfield Foods',
        logo_url: null,
        primary_color: '#0B6E4F',
        support: 'Supplier desk · suppliers@northfield.example',
      },
    });

    // The page the link opens carries the same brand, for the same surface.
    const token = url.split('/r/')[1];
    const page = await supplierPageGet({
      request: new Request(`${ORIGIN}/api/supplier-requests/public/${token}`),
      env,
      data: {},
      params: { token },
      waitUntil: () => {},
      passThroughOnException: () => {},
      next: async () => new Response(null),
      functionPath: `/api/supplier-requests/public/${token}`,
    } as never);
    expect(((await page.json()) as { brand: unknown }).brand).toEqual({
      display_name: 'Northfield Foods',
      logo_url: null,
      primary_color: '#0B6E4F',
      accent_color: null,
      support: { text: 'Supplier desk', email: 'suppliers@northfield.example', phone: null },
    });
  });

  it('no brand record: the mail, the sender name and the audit row are what they were', async () => {
    // Another tenant having a brand changes nothing here.
    await setBrand(seed.tenantId2, { display_name: 'OTHER-TENANT-BRAND', primary_color: '#7A1F5C' });
    const { sent } = stubResend();
    const supplierId = await makeSupplier('Acme Supplier');
    await addContact(supplierId);
    const docId = await makeDoc('Acme COI', { supplierId });
    await run(asOfFor(30));
    const draft = await waitingSend(docId);
    expect(draft.draft_body).toContain('Test Corp');
    expect((await approve(draft)).status).toBe(200);
    const [mail] = toContact(sent);
    expect(mail.html).toContain(
      '<td style="background:#1A365D;padding:24px 32px;">\n        <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">Test Corp</h1>',
    );
    expect(mail.html).not.toContain('OTHER-TENANT-BRAND');
    expect(mail.html).not.toContain('#7A1F5C');
    expect(mail.html).not.toContain('<strong>');
    expect(mail.from).toBe('Test Corp via SupDox <noreply@supdox.com>');
    const [row] = await audits('renewal_request.sent');
    expect(row.details.from_name).toBe('Test Corp via SupDox');
    expect(Object.prototype.hasOwnProperty.call(row.details, 'brand')).toBe(false);
  });
  /** A published logo for the tenant, put on its brand. Returns the URL token. */
  async function giveLogo(tenantId: string): Promise<string> {
    const token = 'c0de'.repeat(10);
    const sha = 'ab'.repeat(32);
    await db
      .prepare(
        `INSERT INTO tenant_brand_logos (id, tenant_id, url_token, sha256, r2_key, content_type, size_bytes, width, height)
         VALUES ('logo-e2e', ?, ?, ?, ?, 'image/png', 1200, 320, 96)`,
      )
      .bind(tenantId, token, sha, `brand/${tenantId}/logo-${sha}.png`)
      .run();
    await db.prepare(`UPDATE tenant_brands SET logo_id = 'logo-e2e' WHERE tenant_id = ?`).bind(tenantId).run();
    return token;
  }
  const HOSTILE_NAME = `<script>alert(1)</script>"'& Co`;
  const HOSTILE_LINE = `"><img src=x onerror=alert(2)>`;

  it('END TO END with a logo and hostile text: the logo is ours and absolute, and every typed character is escaped', async () => {
    await setBrand(seed.tenantId, {
      display_name: HOSTILE_NAME,
      primary_color: '#0B6E4F',
      support_overrides: JSON.stringify({ supplier_request: { text: HOSTILE_LINE, email: null, phone: null } }),
    });
    const token = await giveLogo(seed.tenantId);

    const { sent } = stubResend();
    const supplierId = await makeSupplier('Acme Supplier');
    await addContact(supplierId);
    const docId = await makeDoc('Acme COI', { supplierId });
    await run(asOfFor(30));
    const draft = await waitingSend(docId);
    expect((await approve(draft)).status).toBe(200);
    const [mail] = toContact(sent);

    // The logo: our own route, absolute, on white, alt text the (escaped) name.
    expect(mail.html).toContain(
      `<img src="${ORIGIN}/api/public/brand-logo/${token}" alt="&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp; Co" height="48"`,
    );
    expect(mail.html).toContain('<td style="background:#ffffff;padding:24px 32px 16px;border-bottom:4px solid #0B6E4F;">');
    // The name and the line, as text.
    expect(mail.html).toContain('<strong>&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp; Co</strong> &middot; &quot;&gt;&lt;img src=x onerror=alert(2)&gt;');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<img src=x');
    expect(mail.html.match(/<img /g)).toHaveLength(1);
    // The body a person approved names the organisation as typed, escaped too.
    expect(mail.html).not.toMatch(/alert\(1\)<\/script>/);
    // The From name cannot carry markup or break the header; the address is ours.
    expect(mail.from).toBe('script alert(1) /script \'& Co via SupDox <noreply@supdox.com>');
    expect(mail.reply_to).toBe('orgadmin@test.com');

    const [row] = await audits('renewal_request.sent');
    expect(row.details.brand).toMatchObject({
      display_name: HOSTILE_NAME,
      logo_url: `${ORIGIN}/api/public/brand-logo/${token}`,
      support: HOSTILE_LINE,
    });
  });
});
