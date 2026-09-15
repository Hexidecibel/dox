/**
 * Renewal alert LEAD TIME (migration 0111): per organization, overridable per
 * document type, resolved per DOCUMENT.
 *
 * The properties pinned here:
 *
 *   1. Precedence is type override -> tenant setting -> 60-day default, and one
 *      run applies DIFFERENT windows to different documents.
 *   2. The Renewals dashboard's look-ahead is a view filter. It cannot change
 *      who is mailed, through either the manual or the scheduled path.
 *   3. The re-alert ledger is untouched by a lead-time change: escalation still
 *      breaks the cooldown, the cooldown still holds, and moving the number
 *      (or toggling it back and forth) never re-sends a record already mailed
 *      inside the quiet period. Newly-entering records are a FIRST send, which
 *      is what the admin asked for, and the preview counts them beforehand.
 *   4. The manual button and the cron select the same documents.
 *   5. The preview is read-only and counts correctly.
 *   6. Only admins change it, only for their own tenant, and every change is
 *      stamped and audited.
 *
 * No real email: Resend is stubbed via vi.stubGlobal('fetch').
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables, generateTestId } from '../helpers/db';
import { onRequestPost as runScheduled } from '../../functions/api/expirations/run-scheduled';
import { onRequestPost as notifyPost } from '../../functions/api/expirations/notify';
import { onRequestGet as listExpirations } from '../../functions/api/expirations/index';
import {
  onRequestGet as getLeadTime,
  onRequestPut as putLeadTime,
} from '../../functions/api/expirations/lead-time/index';
import { onRequestGet as previewLeadTime } from '../../functions/api/expirations/lead-time/preview';
import { onRequestPut as putDocType } from '../../functions/api/document-types/[id]';
import { onRequestPost as createDocType } from '../../functions/api/document-types/index';
import { normalizeOwnerKey } from '../../functions/lib/alert-routing';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

const TOKEN = 'test-renewal-alert-bearer-token';
const AS_OF = '2026-07-01';

interface SentMail {
  to: string[];
  subject: string;
  html: string;
}

function stubResend(): { sent: SentMail[] } {
  const sent: SentMail[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes('resend.com')) {
        const payload = JSON.parse((init?.body as string) ?? '{}');
        sent.push({ to: payload.to, subject: payload.subject, html: payload.html });
      }
      return new Response('{}', { status: 200 });
    }),
  );
  return { sent };
}

function baseCtx(request: Request, user: unknown, params: Record<string, string> = {}, envOverride?: unknown): any {
  return {
    request,
    env: envOverride ?? { ...env, RESEND_API_KEY: 're_test', RENEWAL_ALERT_TOKEN: TOKEN },
    data: user ? { user } : {},
    params,
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/expirations',
  };
}

async function call(fn: any, c: any) {
  const res = await fn(c);
  return { status: res.status, body: (await res.json()) as any };
}

const asUser = (id: string, role: string, tenant_id: string | null) => ({ id, role, tenant_id });
let orgAdmin: ReturnType<typeof asUser>;

function scheduled(body: Record<string, unknown>) {
  return call(
    runScheduled,
    baseCtx(
      new Request('https://portal.example.com/api/expirations/run-scheduled', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      null,
    ),
  );
}

function notify(user: unknown, body: Record<string, unknown>) {
  return call(
    notifyPost,
    baseCtx(
      new Request('https://portal.example.com/api/expirations/notify', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      user,
    ),
  );
}

function putTenantLead(user: unknown, body: unknown) {
  return call(
    putLeadTime,
    baseCtx(
      new Request('https://portal.example.com/api/expirations/lead-time', {
        method: 'PUT',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      }),
      user,
    ),
  );
}

function preview(user: unknown, qs: string) {
  return call(
    previewLeadTime,
    baseCtx(new Request(`https://portal.example.com/api/expirations/lead-time/preview?${qs}`), user),
  );
}

/** A date `days` after AS_OF. */
function inDays(days: number, from = AS_OF): string {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function makeType(tenantId: string, name: string, leadDays: number | null): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO document_types (id, tenant_id, name, slug, active, renewal_alert_lead_days)
       VALUES (?, ?, ?, ?, 1, ?)`,
    )
    .bind(id, tenantId, name, `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id.slice(0, 6)}`, leadDays)
    .run();
  return id;
}

async function makeDoc(
  tenantId: string,
  title: string,
  dueDate: string,
  opts: { typeId?: string | null; owner?: string } = {},
): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO documents
         (id, tenant_id, title, tags, current_version, status, created_by,
          owner, renewal_type, renewal_due_date, document_type_id)
       VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, 'hard_expiry', ?, ?)`,
    )
    .bind(id, tenantId, title, seed.userId, opts.owner ?? 'QA', dueDate, opts.typeId ?? null)
    .run();
  return id;
}

async function routeQa(tenantId: string, email = 'qa@example.com') {
  await db
    .prepare(
      `INSERT INTO owner_routes (id, tenant_id, owner_key, owner_label, email, active)
       VALUES (?, ?, ?, 'QA', ?, 1)`,
    )
    .bind(generateTestId(), tenantId, normalizeOwnerKey('QA'), email)
    .run();
}

/** Titles mailed across every captured message. */
function mailedTitles(sent: SentMail[], titles: string[]): string[] {
  return titles.filter((t) => sent.some((m) => m.html.includes(t)));
}

beforeAll(async () => {
  await runMigrations(db);
}, 30_000);

beforeEach(async () => {
  await cleanTables(db);
  seed = await seedTestData(db);
  // tenants survive cleanTables via INSERT OR IGNORE; reset the setting.
  await db
    .prepare(
      `UPDATE tenants SET renewal_alert_lead_days = NULL,
                          renewal_alert_lead_updated_at = NULL,
                          renewal_alert_lead_updated_by = NULL`,
    )
    .run();
  orgAdmin = asUser(seed.orgAdminId, 'org_admin', seed.tenantId);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ───────────────────────────────────────────────────────────────────────────
describe('per-document windows in ONE run', () => {
  it('warns a 90-day type at 80 days out and a 30-day type not at 45, in the same digest run', async () => {
    await routeQa(seed.tenantId);
    const audit = await makeType(seed.tenantId, 'Audit Certificate', 90);
    const log = await makeType(seed.tenantId, 'Letter of Guarantee', 30);
    const plain = await makeType(seed.tenantId, 'Insurance', null);
    await makeDoc(seed.tenantId, 'Audit 80d', inDays(80), { typeId: audit });
    await makeDoc(seed.tenantId, 'LOG 45d', inDays(45), { typeId: log });
    await makeDoc(seed.tenantId, 'LOG 20d', inDays(20), { typeId: log });
    await makeDoc(seed.tenantId, 'Insurance 50d', inDays(50), { typeId: plain });
    await makeDoc(seed.tenantId, 'Untyped 70d', inDays(70), { typeId: null });

    const { sent } = stubResend();
    const { status, body } = await scheduled({ as_of: AS_OF, tenant_id: seed.tenantId });
    expect(status).toBe(200);

    const all = ['Audit 80d', 'LOG 45d', 'LOG 20d', 'Insurance 50d', 'Untyped 70d'];
    expect(mailedTitles(sent, all).sort()).toEqual(['Audit 80d', 'Insurance 50d', 'LOG 20d']);

    // The resolved lead time and its source travel with each document.
    const docs = body.tenants[0].groups.flatMap((g: any) => g.documents);
    const byDays = new Map(docs.map((d: any) => [d.days_until, d]));
    expect(byDays.get(80)).toMatchObject({ alert_lead_days: 90, alert_lead_source: 'document_type' });
    expect(byDays.get(20)).toMatchObject({ alert_lead_days: 30, alert_lead_source: 'document_type' });
    expect(byDays.get(50)).toMatchObject({ alert_lead_days: 60, alert_lead_source: 'default' });
    expect(body.tenants[0].tenant_lead_days).toBe(60);
    expect(body.tenants[0].tenant_lead_source).toBe('default');

    // ...and into the digest row itself, so the recipient can see why.
    expect(sent[0].html).toContain('warned 90 days ahead (document type)');
    expect(sent[0].html).toContain('warned 60 days ahead (system default)');
  });

  it('applies the organization setting to every type without an override', async () => {
    await routeQa(seed.tenantId);
    const audit = await makeType(seed.tenantId, 'Audit Certificate', 90);
    await makeDoc(seed.tenantId, 'Audit 80d', inDays(80), { typeId: audit });
    await makeDoc(seed.tenantId, 'Untyped 50d', inDays(50));
    await makeDoc(seed.tenantId, 'Untyped 25d', inDays(25));
    await db.prepare('UPDATE tenants SET renewal_alert_lead_days = 30 WHERE id = ?').bind(seed.tenantId).run();

    const { sent } = stubResend();
    const { body } = await scheduled({ as_of: AS_OF, tenant_id: seed.tenantId });
    expect(mailedTitles(sent, ['Audit 80d', 'Untyped 50d', 'Untyped 25d']).sort()).toEqual(['Audit 80d', 'Untyped 25d']);
    expect(body.tenants[0].tenant_lead_source).toBe('tenant');
    const untyped = body.tenants[0].groups[0].documents.find((d: any) => d.days_until === 25);
    expect(untyped).toMatchObject({ alert_lead_days: 30, alert_lead_source: 'tenant' });
  });

  it('keeps one tenant’s setting out of another tenant’s run', async () => {
    await routeQa(seed.tenantId, 'qa-one@example.com');
    await routeQa(seed.tenantId2, 'qa-two@example.com');
    await makeDoc(seed.tenantId, 'One 80d', inDays(80));
    await makeDoc(seed.tenantId2, 'Two 80d', inDays(80));
    await db.prepare('UPDATE tenants SET renewal_alert_lead_days = 90 WHERE id = ?').bind(seed.tenantId).run();

    const { sent } = stubResend();
    await scheduled({ as_of: AS_OF });
    expect(mailedTitles(sent, ['One 80d', 'Two 80d'])).toEqual(['One 80d']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the dashboard look-ahead is a VIEW filter', () => {
  it('defaults to the tenant lead time, and a wider window shows more without mailing more', async () => {
    await routeQa(seed.tenantId);
    await makeDoc(seed.tenantId, 'Due 40d', inDays(40));
    await makeDoc(seed.tenantId, 'Due 120d', inDays(120));
    await db.prepare('UPDATE tenants SET renewal_alert_lead_days = 45 WHERE id = ?').bind(seed.tenantId).run();

    const dflt = await call(
      listExpirations,
      baseCtx(new Request(`https://portal.example.com/api/expirations?as_of=${AS_OF}`), orgAdmin),
    );
    expect(dflt.body.window_days).toBe(45);
    expect(dflt.body.tenant_lead).toEqual({ days: 45, source: 'tenant' });

    const wide = await call(
      listExpirations,
      baseCtx(new Request(`https://portal.example.com/api/expirations?as_of=${AS_OF}&window_days=180`), orgAdmin),
    );
    const far = wide.body.rows.find((r: any) => r.title === 'Due 120d');
    expect(far.status).toBe('expiring'); // the VIEW says expiring...
    expect(far.alert_status).toBe('current'); // ...the mail path does not.
    expect(far.alert_lead_days).toBe(45);

    const { sent } = stubResend();
    // An old client passing the selector's value straight through.
    const manual = await notify(orgAdmin, { as_of: AS_OF, window_days: 180 });
    expect(manual.body.window_days_ignored).toBe(true);
    expect(mailedTitles(sent, ['Due 40d', 'Due 120d'])).toEqual(['Due 40d']);
    expect(manual.body.document_count).toBe(1);

    await db.prepare('DELETE FROM renewal_alert_state').run();
    const run = await scheduled({ as_of: AS_OF, tenant_id: seed.tenantId, window_days: 180 });
    expect(run.body.window_days_ignored).toBe(true);
    expect(run.body.documents_alerted).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('manual notify and the scheduled run select the same documents', () => {
  it('produces the same document set with the same lead times', async () => {
    await routeQa(seed.tenantId);
    const audit = await makeType(seed.tenantId, 'Audit Certificate', 90);
    const log = await makeType(seed.tenantId, 'Letter of Guarantee', 30);
    await makeDoc(seed.tenantId, 'Audit 80d', inDays(80), { typeId: audit });
    await makeDoc(seed.tenantId, 'LOG 45d', inDays(45), { typeId: log });
    await makeDoc(seed.tenantId, 'Untyped 10d', inDays(10));
    await makeDoc(seed.tenantId, 'Expired', inDays(-3));

    stubResend();
    const manual = await notify(orgAdmin, { as_of: AS_OF });
    await db.prepare('DELETE FROM renewal_alert_state').run();
    const run = await scheduled({ as_of: AS_OF, tenant_id: seed.tenantId });

    const pick = (docs: any[]) =>
      docs.map((d) => `${d.id}:${d.alert_lead_days}:${d.alert_lead_source}`).sort();
    const manualDocs = pick(manual.body.groups.flatMap((g: any) => g.documents));
    const runDocs = pick(run.body.tenants[0].groups.flatMap((g: any) => g.documents));
    expect(manualDocs).toHaveLength(3);
    expect(manualDocs).toEqual(runDocs);
    expect(manual.body.tenant_lead).toEqual({ days: 60, source: 'default' });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('suppression is unchanged by lead time', () => {
  it('still breaks the cooldown when a record escalates under a type override', async () => {
    await routeQa(seed.tenantId);
    const log = await makeType(seed.tenantId, 'Letter of Guarantee', 30);
    await makeDoc(seed.tenantId, 'LOG', inDays(5), { typeId: log });

    const { sent } = stubResend();
    await scheduled({ as_of: AS_OF, tenant_id: seed.tenantId });
    expect(sent).toHaveLength(1);
    // Two days later: still expiring, inside the cooldown -> silent.
    await scheduled({ as_of: inDays(2), tenant_id: seed.tenantId });
    expect(sent).toHaveLength(1);
    // Six days later the date has passed -> expired, cooldown ignored.
    const escalated = await scheduled({ as_of: inDays(6), tenant_id: seed.tenantId });
    expect(escalated.body.documents_alerted).toBe(1);
    expect(sent).toHaveLength(2);
  });

  it('holds the 7-day cooldown for a record inside a 90-day window, then speaks again', async () => {
    await routeQa(seed.tenantId);
    await db.prepare('UPDATE tenants SET renewal_alert_lead_days = 90 WHERE id = ?').bind(seed.tenantId).run();
    await makeDoc(seed.tenantId, 'Permit', inDays(85));

    const { sent } = stubResend();
    await scheduled({ as_of: AS_OF, tenant_id: seed.tenantId });
    for (const d of [1, 3, 6]) await scheduled({ as_of: inDays(d), tenant_id: seed.tenantId });
    expect(sent).toHaveLength(1);
    await scheduled({ as_of: inDays(7), tenant_id: seed.tenantId });
    expect(sent).toHaveLength(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('changing the lead time does not burst re-send', () => {
  it('re-sends nothing already mailed; a newly-entering record is a first send', async () => {
    await routeQa(seed.tenantId);
    await makeDoc(seed.tenantId, 'Mailed 50d', inDays(50));
    await makeDoc(seed.tenantId, 'Newcomer 80d', inDays(80));

    const { sent } = stubResend();
    // Day 0 at the 60-day default: only the 50-day record.
    await scheduled({ as_of: AS_OF, tenant_id: seed.tenantId });
    expect(mailedTitles(sent, ['Mailed 50d', 'Newcomer 80d'])).toEqual(['Mailed 50d']);
    expect(sent).toHaveLength(1);

    // Admin moves the organization to 90 days.
    expect((await putTenantLead(orgAdmin, { lead_days: 90 })).status).toBe(200);

    // Day 1: the newcomer is new (first). The mailed record is NOT repeated.
    const day1 = await scheduled({ as_of: inDays(1), tenant_id: seed.tenantId });
    expect(sent).toHaveLength(2);
    expect(sent[1].html).toContain('Newcomer 80d');
    expect(sent[1].html).not.toContain('Mailed 50d');
    expect(day1.body.documents_suppressed).toBe(1);
    expect(day1.body.documents_alerted).toBe(1);
  });

  it('toggling the lead time out and back inside a week sends nothing twice', async () => {
    await routeQa(seed.tenantId);
    await makeDoc(seed.tenantId, 'Band 75d', inDays(75));

    const { sent } = stubResend();
    await putTenantLead(orgAdmin, { lead_days: 90 });
    await scheduled({ as_of: AS_OF, tenant_id: seed.tenantId });
    expect(sent).toHaveLength(1);

    // Down to 30: it leaves the alert set. Nothing is said about it.
    await putTenantLead(orgAdmin, { lead_days: 30 });
    const out = await scheduled({ as_of: inDays(2), tenant_id: seed.tenantId });
    expect(out.body.tenants[0].reason).toBe('no_documents');
    expect(sent).toHaveLength(1);

    // Back to 90 three days after the send: still inside the cooldown.
    await putTenantLead(orgAdmin, { lead_days: 90 });
    const back = await scheduled({ as_of: inDays(3), tenant_id: seed.tenantId });
    expect(back.body.documents_suppressed).toBe(1);
    expect(sent).toHaveLength(1);

    // The weekly nudge arrives on its ordinary schedule, not earlier.
    await scheduled({ as_of: inDays(7), tenant_id: seed.tenantId });
    expect(sent).toHaveLength(2);
  });

  it('a type override change never manufactures an escalation', async () => {
    await routeQa(seed.tenantId);
    const t = await makeType(seed.tenantId, 'Audit Certificate', null);
    await makeDoc(seed.tenantId, 'Audit 40d', inDays(40), { typeId: t });

    const { sent } = stubResend();
    await scheduled({ as_of: AS_OF, tenant_id: seed.tenantId });
    expect(sent).toHaveLength(1);
    await db.prepare('UPDATE document_types SET renewal_alert_lead_days = 120 WHERE id = ?').bind(t).run();
    const next = await scheduled({ as_of: inDays(1), tenant_id: seed.tenantId });
    expect(next.body.documents_suppressed).toBe(1);
    expect(sent).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the preview', () => {
  it('counts what a tenant change would add, send, and remove, and writes nothing', async () => {
    await routeQa(seed.tenantId);
    await makeDoc(seed.tenantId, 'In 50d', inDays(50)); // alerting today
    await makeDoc(seed.tenantId, 'In 75d', inDays(75)); // enters at 90
    await makeDoc(seed.tenantId, 'In 85d', inDays(85)); // enters at 90, but already mailed
    await makeDoc(seed.tenantId, 'In 200d', inDays(200)); // never
    const override = await makeType(seed.tenantId, 'Audit Certificate', 30);
    await makeDoc(seed.tenantId, 'Typed 50d', inDays(50), { typeId: override }); // type wins

    // "In 85d" was mailed two days ago (e.g. under an earlier 90-day setting).
    const mailedId = (await db.prepare(`SELECT id FROM documents WHERE title = 'In 85d'`).first<{ id: string }>())!.id;
    await db
      .prepare(
        `INSERT INTO renewal_alert_state (id, tenant_id, document_id, last_status, last_due_date,
           last_notified_at, last_notified_as_of, notify_count)
         VALUES (?, ?, ?, 'expiring', ?, datetime('now'), ?, 1)`,
      )
      .bind(generateTestId(), seed.tenantId, mailedId, inDays(85), inDays(-2))
      .run();

    const auditBefore = await db.prepare('SELECT COUNT(*) AS n FROM audit_log').first<{ n: number }>();

    const up = await preview(orgAdmin, `lead_days=90&as_of=${AS_OF}`);
    expect(up.status).toBe(200);
    expect(up.body.scope).toBe('tenant');
    expect(up.body.current_alerting_count).toBe(1);
    expect(up.body.proposed_alerting_count).toBe(3);
    expect(up.body.newly_entering_count).toBe(2);
    expect(up.body.newly_entering_would_send_count).toBe(1);
    expect(up.body.leaving_count).toBe(0);
    const decisions = Object.fromEntries(up.body.newly_entering.map((d: any) => [d.title, d.next_run_decision]));
    expect(decisions).toEqual({ 'In 75d': 'first', 'In 85d': 'suppressed' });
    expect(up.body.newly_entering[0]).toMatchObject({ alert_lead_days: 90, current_alert_lead_days: 60 });
    // The typed record keeps its own 30 days, so its lead did not change.
    expect(up.body.lead_changed_count).toBe(4);

    const down = await preview(orgAdmin, `lead_days=30&as_of=${AS_OF}`);
    expect(down.body.newly_entering_count).toBe(0);
    expect(down.body.leaving_count).toBe(1);
    expect(down.body.leaving[0].title).toBe('In 50d');
    expect(down.body.leaving[0].next_run_decision).toBeNull();

    // Read-only: no ledger rows, no audit rows, the setting unchanged.
    const ledger = await db.prepare('SELECT COUNT(*) AS n FROM renewal_alert_state').first<{ n: number }>();
    expect(ledger?.n).toBe(1);
    const auditAfter = await db.prepare('SELECT COUNT(*) AS n FROM audit_log').first<{ n: number }>();
    expect(auditAfter?.n).toBe(auditBefore?.n);
    const t = await db.prepare('SELECT renewal_alert_lead_days FROM tenants WHERE id = ?').bind(seed.tenantId).first<any>();
    expect(t.renewal_alert_lead_days).toBeNull();
  });

  it('previews a type override, including clearing it back to inherit', async () => {
    const audit = await makeType(seed.tenantId, 'Audit Certificate', null);
    await makeDoc(seed.tenantId, 'Audit 80d', inDays(80), { typeId: audit });
    await makeDoc(seed.tenantId, 'Other 80d', inDays(80));

    const on = await preview(orgAdmin, `lead_days=90&document_type_id=${audit}&as_of=${AS_OF}`);
    expect(on.body.scope).toBe('document_type');
    expect(on.body.newly_entering_count).toBe(1);
    expect(on.body.newly_entering[0].title).toBe('Audit 80d');
    expect(on.body.newly_entering[0].alert_lead_source).toBe('document_type');

    await db.prepare('UPDATE document_types SET renewal_alert_lead_days = 90 WHERE id = ?').bind(audit).run();
    const off = await preview(orgAdmin, `lead_days=inherit&document_type_id=${audit}&as_of=${AS_OF}`);
    expect(off.body.leaving_count).toBe(1);
    expect(off.body.leaving[0].alert_lead_source).toBe('default');
  });

  it('refuses a bad value, another tenant’s type, and a non-admin', async () => {
    const foreign = await makeType(seed.tenantId2, 'Theirs', null);
    expect((await preview(orgAdmin, 'lead_days=3')).status).toBe(400);
    expect((await preview(orgAdmin, 'lead_days=abc')).status).toBe(400);
    expect((await preview(orgAdmin, '')).status).toBe(400);
    expect((await preview(orgAdmin, `lead_days=30&document_type_id=${foreign}`)).status).toBe(404);
    expect((await preview(asUser(seed.userId, 'user', seed.tenantId), 'lead_days=30')).status).toBe(403);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the organization setting: roles, tenant isolation, stamps and audit', () => {
  it('reads the default, saves a value with who/when, audits the previous value', async () => {
    const get0 = await call(getLeadTime, baseCtx(new Request('https://portal.example.com/api/expirations/lead-time'), orgAdmin));
    expect(get0.status).toBe(200);
    expect(get0.body).toMatchObject({ lead_days: null, effective: { days: 60, source: 'default' }, presets: [30, 60, 90] });

    const put = await putTenantLead(orgAdmin, { lead_days: 90 });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ lead_days: 90, effective: { days: 90, source: 'tenant' }, updated_by: seed.orgAdminId, updated_by_name: 'Org Admin' });
    expect(put.body.updated_at).toBeTruthy();

    await putTenantLead(orgAdmin, { lead_days: 30 });
    const rows = await db
      .prepare(`SELECT details FROM audit_log WHERE action = 'renewal_alert_lead_time_updated' AND tenant_id = ? ORDER BY id`)
      .bind(seed.tenantId)
      .all<{ details: string }>();
    const details = (rows.results ?? []).map((r) => JSON.parse(r.details));
    expect(details).toContainEqual({ lead_days: 90, previous_lead_days: null });
    expect(details).toContainEqual({ lead_days: 30, previous_lead_days: 90 });

    // A no-op save is not a change: no new audit row.
    await putTenantLead(orgAdmin, { lead_days: 30 });
    const again = await db
      .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'renewal_alert_lead_time_updated' AND tenant_id = ?`)
      .bind(seed.tenantId)
      .first<{ n: number }>();
    expect(again?.n).toBe(2);

    // Back to the default.
    const reset = await putTenantLead(orgAdmin, { lead_days: null });
    expect(reset.body.effective).toEqual({ days: 60, source: 'default' });
  });

  it('refuses users and readers, out-of-range or missing values', async () => {
    expect((await putTenantLead(asUser(seed.userId, 'user', seed.tenantId), { lead_days: 30 })).status).toBe(403);
    expect((await putTenantLead(asUser(seed.readerId, 'reader', seed.tenantId), { lead_days: 30 })).status).toBe(403);
    expect((await putTenantLead(orgAdmin, { lead_days: 6 })).status).toBe(400);
    expect((await putTenantLead(orgAdmin, { lead_days: 366 })).status).toBe(400);
    expect((await putTenantLead(orgAdmin, { lead_days: 30.5 })).status).toBe(400);
    expect((await putTenantLead(orgAdmin, { lead_days: '30' })).status).toBe(400);
    expect((await putTenantLead(orgAdmin, {})).status).toBe(400);
  });

  it('pins an org_admin to its own tenant and makes a super_admin name one', async () => {
    // An org_admin naming another tenant still writes only its own.
    await putTenantLead(orgAdmin, { lead_days: 45, tenant_id: seed.tenantId2 });
    const t2 = await db.prepare('SELECT renewal_alert_lead_days FROM tenants WHERE id = ?').bind(seed.tenantId2).first<any>();
    expect(t2.renewal_alert_lead_days).toBeNull();
    const t1 = await db.prepare('SELECT renewal_alert_lead_days FROM tenants WHERE id = ?').bind(seed.tenantId).first<any>();
    expect(t1.renewal_alert_lead_days).toBe(45);

    const sa = asUser(seed.superAdminId, 'super_admin', null);
    expect((await putTenantLead(sa, { lead_days: 45 })).status).toBe(400);
    const ok = await putTenantLead(sa, { lead_days: 120, tenant_id: seed.tenantId2 });
    expect(ok.status).toBe(200);
    expect(ok.body.tenant_id).toBe(seed.tenantId2);
  });

  it('the database refuses an out-of-range value even without the API', async () => {
    await expect(
      db.prepare('UPDATE tenants SET renewal_alert_lead_days = 400 WHERE id = ?').bind(seed.tenantId).run(),
    ).rejects.toThrow();
    const t = await makeType(seed.tenantId, 'Checked', null);
    await expect(
      db.prepare('UPDATE document_types SET renewal_alert_lead_days = 0 WHERE id = ?').bind(t).run(),
    ).rejects.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the per-type override on /api/document-types', () => {
  function putType(user: unknown, id: string, body: unknown) {
    return call(
      putDocType,
      baseCtx(
        new Request(`https://portal.example.com/api/document-types/${id}`, {
          method: 'PUT',
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
        }),
        user,
        { id },
      ),
    );
  }

  it('saves, stamps and audits an override; clearing it inherits; a no-op is not audited', async () => {
    const t = await makeType(seed.tenantId, 'Audit Certificate', null);
    const res = await putType(orgAdmin, t, { renewal_alert_lead_days: 90 });
    expect(res.status).toBe(200);
    expect(res.body.documentType).toMatchObject({ renewal_alert_lead_days: 90, renewal_alert_lead_updated_by: seed.orgAdminId });

    await putType(orgAdmin, t, { renewal_alert_lead_days: 90, description: 'same lead' });
    await putType(orgAdmin, t, { renewal_alert_lead_days: null });

    const rows = await db
      .prepare(`SELECT details FROM audit_log WHERE action = 'document_type.renewal_alert_lead_time_updated' AND resource_id = ?`)
      .bind(t)
      .all<{ details: string }>();
    expect((rows.results ?? []).map((r) => JSON.parse(r.details))).toEqual([
      { renewal_alert_lead_days: 90, previous_renewal_alert_lead_days: null },
      { renewal_alert_lead_days: null, previous_renewal_alert_lead_days: 90 },
    ]);

    const listed = await call(getLeadTime, baseCtx(new Request('https://portal.example.com/api/expirations/lead-time'), orgAdmin));
    expect(listed.body.document_type_overrides).toEqual([]);
  });

  it('refuses a bad override and another tenant’s admin', async () => {
    const t = await makeType(seed.tenantId, 'Audit Certificate', null);
    expect((await putType(orgAdmin, t, { renewal_alert_lead_days: 5 })).status).toBe(400);
    expect((await putType(asUser(seed.orgAdmin2Id, 'org_admin', seed.tenantId2), t, { renewal_alert_lead_days: 30 })).status).toBe(403);
    const row = await db.prepare('SELECT renewal_alert_lead_days FROM document_types WHERE id = ?').bind(t).first<any>();
    expect(row.renewal_alert_lead_days).toBeNull();
  });

  it('accepts an override at creation and lists it on the organization setting', async () => {
    const res = await call(
      createDocType,
      baseCtx(
        new Request('https://portal.example.com/api/document-types', {
          method: 'POST',
          body: JSON.stringify({ name: 'Third Party Audit', renewal_alert_lead_days: 120 }),
          headers: { 'Content-Type': 'application/json' },
        }),
        orgAdmin,
      ),
    );
    expect(res.status).toBe(201);
    expect(res.body.documentType).toMatchObject({ renewal_alert_lead_days: 120, renewal_alert_lead_updated_by: seed.orgAdminId });
    const listed = await call(getLeadTime, baseCtx(new Request('https://portal.example.com/api/expirations/lead-time'), orgAdmin));
    expect(listed.body.document_type_overrides).toMatchObject([{ name: 'Third Party Audit', lead_days: 120 }]);
  });
});
