/**
 * Scheduled, per-owner renewal alerts.
 *
 * What is worth pinning here is not "an email goes out". It is the four
 * properties that decide whether the October cutover survives November, when
 * renewal — not onboarding — is what Medosweet actually uses the portal for:
 *
 *   1. An alert reaches the RECORD'S OWNER, not a general admin pool. A
 *      free-text owner label ('QA', 'Insurance') resolves through
 *      `owner_routes`; a label with no route resolves to NOBODY, and that must
 *      be reported as a failure rather than quietly re-broadcast to every
 *      admin — which is exactly what the old code did.
 *   2. A DAILY job is not a daily email. Two consecutive runs over an
 *      unchanged record send once, not twice; a record whose status escalates
 *      re-sends immediately anyway.
 *   3. Tenants do not bleed into each other — not the routes, not the
 *      documents, not the recipients. And no super_admin receives every
 *      tenant's renewal mail, which the old recipient query guaranteed.
 *   4. A scheduled alert carries a WORKING link. An alert that makes its
 *      recipient go find the portal and log in has failed for the population
 *      this feature exists to serve.
 *
 * Handlers are driven directly with hand-rolled contexts (SELF.fetch is not
 * wired in this project's vitest-pool-workers config); the Resend HTTP call is
 * stubbed via vi.stubGlobal.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables, generateTestId } from '../helpers/db';
import { onRequestPost as runScheduled } from '../../functions/api/expirations/run-scheduled';
import { onRequestPost as notifyPost } from '../../functions/api/expirations/notify';
import { onRequestGet as alertGet } from '../../functions/api/alerts/public/[token]';
import {
  decideSend,
  statusRank,
  groupByOwner,
  runRenewalAlerts,
  DEFAULT_COOLDOWN_DAYS,
} from '../../functions/lib/renewal-alerts';
import { normalizeOwnerKey, resolveAlertRouting } from '../../functions/lib/alert-routing';
import type { ExpirationRow } from '../../functions/lib/expirations';
import type { AlertLandingView } from '../../shared/types';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

const AS_OF = '2026-07-22';
const TOKEN = 'test-renewal-alert-bearer-token';

/** Every Resend POST captured during a test. */
interface SentMail {
  to: string[];
  subject: string;
  html: string;
}

function stubResend(): { sent: SentMail[]; mock: ReturnType<typeof vi.fn> } {
  const sent: SentMail[] = [];
  const mock = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).includes('resend.com')) {
      const payload = JSON.parse((init?.body as string) ?? '{}');
      sent.push({ to: payload.to, subject: payload.subject, html: payload.html });
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', mock);
  return { sent, mock };
}

function scheduledContext(body: Record<string, unknown>, auth = `Bearer ${TOKEN}`, envOverride?: Record<string, unknown>): any {
  return {
    request: new Request('https://portal.example.com/api/expirations/run-scheduled', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: auth ? { Authorization: auth } : {},
    }),
    env: envOverride ?? { ...env, RENEWAL_ALERT_TOKEN: TOKEN, RESEND_API_KEY: 're_test' },
    data: {},
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/expirations/run-scheduled',
  };
}

async function runScheduledRun(body: Record<string, unknown> = {}, auth?: string, envOverride?: Record<string, unknown>) {
  const res = await runScheduled(scheduledContext(body, auth ?? `Bearer ${TOKEN}`, envOverride));
  return { status: res.status, body: (await res.json()) as any };
}

async function runNotify(user: any, body: Record<string, unknown>) {
  const res = await notifyPost({
    request: new Request('https://portal.example.com/api/expirations/notify', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    env: { ...env, RESEND_API_KEY: 're_test' },
    data: { user },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/expirations/notify',
  } as any);
  return { status: res.status, body: (await res.json()) as any };
}

async function makeDoc(
  tenantId: string,
  title: string,
  fields: { owner?: string | null; renewalType?: string; renewalDueDate?: string } = {},
): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO documents
         (id, tenant_id, title, tags, current_version, status, created_by,
          owner, renewal_type, renewal_due_date)
       VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, ?, ?)`,
    )
    .bind(
      id,
      tenantId,
      title,
      seed.userId,
      fields.owner ?? null,
      fields.renewalType ?? 'hard_expiry',
      fields.renewalDueDate ?? '2026-08-01',
    )
    .run();
  return id;
}

async function addRoute(
  tenantId: string,
  label: string,
  target: { userId?: string; email?: string; active?: number },
): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO owner_routes (id, tenant_id, owner_key, owner_label, user_id, email, active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      tenantId,
      normalizeOwnerKey(label),
      label,
      target.userId ?? null,
      target.email ?? null,
      target.active ?? 1,
    )
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

afterEach(() => {
  vi.unstubAllGlobals();
});

// ───────────────────────────────────────────────────────────────────────────
describe('the pure suppression rules', () => {
  const row = (status: string) => ({ status }) as Pick<ExpirationRow, 'status'>;
  const state = (last_status: string, last_notified_at: string) => ({
    document_id: 'd', last_status, last_due_date: null, last_notified_at, notify_count: 1,
  });

  it('sends a record it has never alerted on', () => {
    expect(decideSend(row('expiring'), null, AS_OF)).toBe('first');
  });

  it('SUPPRESSES an unchanged record inside the cooldown — the whole point', () => {
    expect(decideSend(row('expiring'), state('expiring', '2026-07-21'), AS_OF)).toBe('suppressed');
    // ...on every one of the intervening days, not just the second.
    for (let d = 1; d < DEFAULT_COOLDOWN_DAYS; d++) {
      const asOf = new Date(Date.UTC(2026, 6, 15 + d)).toISOString().slice(0, 10);
      expect(decideSend(row('expiring'), state('expiring', '2026-07-15'), asOf)).toBe('suppressed');
    }
  });

  it('re-sends once the cooldown elapses', () => {
    expect(decideSend(row('expiring'), state('expiring', '2026-07-15'), AS_OF)).toBe('cooldown_elapsed');
  });

  it('IGNORES the cooldown when the status escalates — the date actually passed', () => {
    expect(decideSend(row('expired'), state('expiring', '2026-07-21'), AS_OF)).toBe('escalated');
    expect(decideSend(row('overdue'), state('expiring', '2026-07-21'), AS_OF)).toBe('escalated');
  });

  it('does NOT treat a de-escalation as news (a renewed record goes quiet)', () => {
    expect(decideSend(row('expiring'), state('expired', '2026-07-21'), AS_OF)).toBe('suppressed');
  });

  it('ranks overdue and expired equally — two renewal_types, one severity', () => {
    expect(statusRank('overdue')).toBe(statusRank('expired'));
    expect(statusRank('expiring')).toBeLessThan(statusRank('expired'));
  });

  it('breaks the silence rather than trusting an unparseable stamp', () => {
    expect(decideSend(row('expiring'), state('expiring', 'not-a-date'), AS_OF)).toBe('cooldown_elapsed');
  });
});

describe('owner grouping', () => {
  const r = (id: string, owner: string | null) => ({ id, owner }) as ExpirationRow;

  it('folds spelling variants of one label into one group', () => {
    const groups = groupByOwner([r('a', 'QA'), r('b', 'qa'), r('c', ' Qa ')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows.map((x) => x.id).sort()).toEqual(['a', 'b', 'c']);
    // The as-typed spelling is what the recipient recognises.
    expect(groups[0].label).toBe('QA');
  });

  it('keeps distinct owners apart and buckets the ownerless under null', () => {
    const groups = groupByOwner([r('a', 'QA'), r('b', 'Accounting'), r('c', null), r('d', '  ')]);
    const byLabel = new Map(groups.map((g) => [g.label, g.rows.map((x) => x.id)]));
    expect(byLabel.get('QA')).toEqual(['a']);
    expect(byLabel.get('Accounting')).toEqual(['b']);
    expect(byLabel.get(null)?.sort()).toEqual(['c', 'd']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('owner resolution', () => {
  it('routes to a portal user mapped to the label', async () => {
    await addRoute(seed.tenantId, 'QA', { userId: seed.userId });
    const r = await resolveAlertRouting(db, {
      tenantId: seed.tenantId, ownerLabel: 'QA', adminFallback: false,
    });
    expect(r.via).toBe('owner_route');
    expect(r.recipients.map((x) => x.email)).toEqual(['user@test.com']);
  });

  it('routes to a bare address for an owner who has no account', async () => {
    await addRoute(seed.tenantId, 'Insurance', { email: 'broker@agency.example' });
    const r = await resolveAlertRouting(db, {
      tenantId: seed.tenantId, ownerLabel: 'Insurance', adminFallback: false,
    });
    expect(r.via).toBe('owner_route');
    expect(r.recipients.map((x) => x.email)).toEqual(['broker@agency.example']);
  });

  it('matches the label case- and whitespace-insensitively', async () => {
    await addRoute(seed.tenantId, 'QA', { userId: seed.userId });
    for (const label of ['qa', ' QA ', 'Qa']) {
      const r = await resolveAlertRouting(db, {
        tenantId: seed.tenantId, ownerLabel: label, adminFallback: false,
      });
      expect(r.via).toBe('owner_route');
    }
  });

  it('drops a route whose user was deactivated, without editing the route', async () => {
    await addRoute(seed.tenantId, 'QA', { userId: seed.inactiveId });
    const r = await resolveAlertRouting(db, {
      tenantId: seed.tenantId, ownerLabel: 'QA', adminFallback: false,
    });
    expect(r.via).toBe('unrouted');
    expect(r.recipients).toHaveLength(0);
  });

  it('honours active = 0 as the off switch for a bare-email route', async () => {
    await addRoute(seed.tenantId, 'QA', { email: 'muted@example.com', active: 0 });
    const r = await resolveAlertRouting(db, {
      tenantId: seed.tenantId, ownerLabel: 'QA', adminFallback: false,
    });
    expect(r.via).toBe('unrouted');
  });

  describe('the unresolvable case', () => {
    it('reports "unrouted" for a label nobody is mapped to', async () => {
      const r = await resolveAlertRouting(db, {
        tenantId: seed.tenantId, ownerLabel: 'Purchasing', adminFallback: false,
      });
      expect(r.via).toBe('unrouted');
      expect(r.recipients).toEqual([]);
    });

    it('reports "unrouted" for a record that names no owner at all', async () => {
      const r = await resolveAlertRouting(db, {
        tenantId: seed.tenantId, ownerLabel: null, adminFallback: false,
      });
      expect(r.via).toBe('unrouted');
    });

    it('does NOT silently fall back to admins on the renewal path', async () => {
      const r = await resolveAlertRouting(db, {
        tenantId: seed.tenantId, ownerLabel: 'Purchasing', adminFallback: false,
      });
      expect(r.recipients.map((x) => x.email)).not.toContain('orgadmin@test.com');
    });

    it('DOES fall back for the spec path, which opts in explicitly', async () => {
      const r = await resolveAlertRouting(db, {
        tenantId: seed.tenantId, ownerLabel: 'Purchasing', adminFallback: true,
      });
      expect(r.via).toBe('tenant_admins');
      expect(r.recipients.map((x) => x.email)).toEqual(['orgadmin@test.com']);
      // Even then: this tenant's admins only. Never every super_admin.
      expect(r.recipients.map((x) => x.email)).not.toContain('admin@test.com');
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('a scheduled run', () => {
  it('rejects a missing / wrong bearer, and fails closed when unconfigured', async () => {
    expect((await runScheduledRun({}, '')).status).toBe(401);
    expect((await runScheduledRun({}, 'Bearer wrong')).status).toBe(401);
    const unconfigured = await runScheduledRun({}, `Bearer ${TOKEN}`, {
      ...env, RENEWAL_ALERT_TOKEN: undefined, RESEND_API_KEY: 're_test',
    });
    expect(unconfigured.status).toBe(401);
  });

  it('sends ONE digest per owner, each carrying only that owner’s records', async () => {
    await addRoute(seed.tenantId, 'QA', { userId: seed.userId });
    await addRoute(seed.tenantId, 'Insurance', { email: 'broker@agency.example' });
    await makeDoc(seed.tenantId, 'Plant Licence', { owner: 'QA', renewalDueDate: '2026-08-01' });
    await makeDoc(seed.tenantId, 'Lab Accreditation', { owner: 'qa', renewalDueDate: '2026-08-10' });
    await makeDoc(seed.tenantId, 'Certificate of Insurance', { owner: 'Insurance', renewalDueDate: '2026-06-01' });

    const { sent } = stubResend();
    const { status, body } = await runScheduledRun({ as_of: AS_OF, tenant_id: seed.tenantId });

    expect(status).toBe(200);
    expect(body.emails_sent).toBe(2);
    expect(sent).toHaveLength(2);

    const qa = sent.find((m) => m.to.includes('user@test.com'))!;
    const ins = sent.find((m) => m.to.includes('broker@agency.example'))!;
    expect(qa).toBeTruthy();
    expect(ins).toBeTruthy();

    // QA sees QA's two records and NOT Insurance's, and vice versa. This is
    // the difference between an alert and a newsletter.
    expect(qa.html).toContain('Plant Licence');
    expect(qa.html).toContain('Lab Accreditation');
    expect(qa.html).not.toContain('Certificate of Insurance');
    expect(ins.html).toContain('Certificate of Insurance');
    expect(ins.html).not.toContain('Plant Licence');

    // Nobody got the other owner's mail, and no admin got either.
    expect(qa.to).toEqual(['user@test.com']);
    expect(ins.to).toEqual(['broker@agency.example']);
    for (const m of sent) {
      expect(m.to).not.toContain('orgadmin@test.com');
      expect(m.to).not.toContain('admin@test.com');
    }
  });

  it('carries a working /alert link that opens without a login and shows only that owner’s records', async () => {
    await addRoute(seed.tenantId, 'QA', { userId: seed.userId });
    await addRoute(seed.tenantId, 'Insurance', { email: 'broker@agency.example' });
    await makeDoc(seed.tenantId, 'Plant Licence', { owner: 'QA', renewalDueDate: '2026-08-01' });
    await makeDoc(seed.tenantId, 'Certificate of Insurance', { owner: 'Insurance', renewalDueDate: '2026-06-01' });

    const { sent } = stubResend();
    await runScheduledRun({ as_of: AS_OF, tenant_id: seed.tenantId });

    const qa = sent.find((m) => m.to.includes('user@test.com'))!;
    const match = /https:\/\/portal\.example\.com\/alert\/([A-Za-z0-9_-]+)/.exec(qa.html);
    expect(match, 'the scheduled digest must contain an /alert/<token> link').toBeTruthy();

    // The link resolves, unauthenticated, to a real landing view...
    const token = match![1];
    const res = await alertGet({
      request: new Request(`https://portal.example.com/api/alerts/public/${token}`),
      env,
      data: {},
      params: { token },
      waitUntil: () => {},
      passThroughOnException: () => {},
      next: async () => new Response(null),
      functionPath: `/api/alerts/public/${token}`,
    } as any);
    expect(res.status).toBe(200);
    const view = (await res.json()) as AlertLandingView;
    expect(view.kind).toBe('renewal_alert');

    // ...scoped to the records THIS email listed. A forwarded QA link must not
    // open Insurance's certificate.
    const titles = view.renewals.map((r) => r.title);
    expect(titles).toContain('Plant Licence');
    expect(titles).not.toContain('Certificate of Insurance');
  });

  it('skips a tenant with nothing due, and reports why', async () => {
    const { sent } = stubResend();
    const { body } = await runScheduledRun({ as_of: AS_OF, tenant_id: seed.tenantId });
    expect(sent).toHaveLength(0);
    expect(body.emails_sent).toBe(0);
    expect(body.tenants[0].reason).toBe('no_documents');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('idempotency across consecutive runs', () => {
  beforeEach(async () => {
    await addRoute(seed.tenantId, 'QA', { userId: seed.userId });
    await makeDoc(seed.tenantId, 'Plant Licence', { owner: 'QA', renewalDueDate: '2026-08-01' });
  });

  it('mails on the first run and STAYS SILENT on the second the same day', async () => {
    const { sent } = stubResend();

    const first = await runScheduledRun({ as_of: AS_OF, tenant_id: seed.tenantId });
    expect(first.body.emails_sent).toBe(1);
    expect(first.body.documents_alerted).toBe(1);
    expect(sent).toHaveLength(1);

    const second = await runScheduledRun({ as_of: AS_OF, tenant_id: seed.tenantId });
    expect(second.body.emails_sent).toBe(0);
    expect(second.body.documents_suppressed).toBe(1);
    expect(second.body.tenants[0].reason).toBe('all_suppressed');
    // The mail server was NOT hit a second time. Thirty consecutive mornings
    // about one certificate is the failure this exists to prevent.
    expect(sent).toHaveLength(1);
  });

  it('stays silent on every day inside the cooldown, then speaks again after it', async () => {
    const { sent } = stubResend();
    await runScheduledRun({ as_of: '2026-07-22', tenant_id: seed.tenantId });
    expect(sent).toHaveLength(1);

    for (const day of ['2026-07-23', '2026-07-24', '2026-07-26', '2026-07-28']) {
      await runScheduledRun({ as_of: day, tenant_id: seed.tenantId });
    }
    expect(sent).toHaveLength(1);

    // Day 7 — the weekly nudge.
    await runScheduledRun({ as_of: '2026-07-29', tenant_id: seed.tenantId });
    expect(sent).toHaveLength(2);
  });

  it('breaks the cooldown the morning a record escalates', async () => {
    const { sent } = stubResend();
    // 2026-07-22: due 2026-08-01 is inside the window -> expiring.
    await runScheduledRun({ as_of: '2026-07-22', tenant_id: seed.tenantId });
    expect(sent).toHaveLength(1);

    // Next day the date has passed -> expired. New information, cooldown or not.
    await runScheduledRun({ as_of: '2026-08-02', window_days: 60, tenant_id: seed.tenantId });
    expect(sent).toHaveLength(2);
    expect(sent[1].subject).toContain('renewal attention');
  });

  it('counts the sends, so a renewal nobody is doing is visible in the ledger', async () => {
    stubResend();
    await runScheduledRun({ as_of: '2026-07-22', tenant_id: seed.tenantId });
    await runScheduledRun({ as_of: '2026-07-29', tenant_id: seed.tenantId });
    const row = await db
      .prepare('SELECT notify_count, last_status FROM renewal_alert_state WHERE tenant_id = ?')
      .bind(seed.tenantId)
      .first<{ notify_count: number; last_status: string }>();
    expect(row?.notify_count).toBe(2);
    expect(row?.last_status).toBe('expiring');
  });

  it('lets the MANUAL button ignore the cooldown but still stamp it', async () => {
    const { sent } = stubResend();
    await runScheduledRun({ as_of: AS_OF, tenant_id: seed.tenantId });
    expect(sent).toHaveLength(1);

    // A human asking right now gets it right now.
    const manual = await runNotify(
      { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId },
      { as_of: AS_OF },
    );
    expect(manual.body.sent).toBe(true);
    expect(sent).toHaveLength(2);

    // ...and the cron does not then repeat it later the same day.
    const after = await runScheduledRun({ as_of: AS_OF, tenant_id: seed.tenantId });
    expect(after.body.emails_sent).toBe(0);
    expect(sent).toHaveLength(2);
  });

  it('does NOT stamp a record whose send failed, so the next run retries it', async () => {
    // Resend rejects — the mail did not leave.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await runScheduledRun({ as_of: AS_OF, tenant_id: seed.tenantId });
    const stamped = await db
      .prepare('SELECT COUNT(*) AS n FROM renewal_alert_state WHERE tenant_id = ?')
      .bind(seed.tenantId)
      .first<{ n: number }>();
    expect(stamped?.n).toBe(0);

    vi.unstubAllGlobals();
    const { sent } = stubResend();
    await runScheduledRun({ as_of: AS_OF, tenant_id: seed.tenantId });
    expect(sent).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('when no owner resolves', () => {
  it('sends NO renewal alert, and says so instead of mailing the admin pool', async () => {
    await makeDoc(seed.tenantId, 'Orphan Permit', { owner: 'Purchasing', renewalDueDate: '2026-08-01' });
    await makeDoc(seed.tenantId, 'Nameless Cert', { owner: null, renewalDueDate: '2026-06-01' });

    const { sent } = stubResend();
    const { body } = await runScheduledRun({ as_of: AS_OF, tenant_id: seed.tenantId });

    expect(body.documents_unrouted).toBe(2);
    expect(body.emails_sent).toBe(0);
    expect(body.tenants[0].reason).toBe('all_unrouted');

    // Exactly ONE message went out, and it is the routing-gap notice — not the
    // renewal digest wearing a different hat.
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain('no owner');
    expect(sent[0].subject).toContain('nobody was alerted');
    expect(sent[0].html).toContain('routing gap');
    expect(sent[0].html).toContain('no renewal alert was sent');
    // It names both problems distinctly: a label with no route, and no label.
    expect(sent[0].html).toContain('no route configured');
    expect(sent[0].html).toContain('No owner set');
  });

  it('sends the gap notice to the tenant’s org_admins ONLY — never every super_admin', async () => {
    await makeDoc(seed.tenantId, 'Orphan Permit', { owner: 'Purchasing', renewalDueDate: '2026-08-01' });
    const { sent } = stubResend();
    await runScheduledRun({ as_of: AS_OF, tenant_id: seed.tenantId });
    expect(sent[0].to).toEqual(['orgadmin@test.com']);
    expect(sent[0].to).not.toContain('admin@test.com');
    expect(sent[0].to).not.toContain('orgadmin2@test.com');
  });

  it('writes an audit row, so the gap survives the mail path failing', async () => {
    await makeDoc(seed.tenantId, 'Orphan Permit', { owner: 'Purchasing', renewalDueDate: '2026-08-01' });
    // Mail is dead; the record of what went unalerted must not be.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await runScheduledRun({ as_of: AS_OF, tenant_id: seed.tenantId });

    const audit = await db
      .prepare(`SELECT details FROM audit_log WHERE action = 'expirations.routing_gap' AND tenant_id = ?`)
      .bind(seed.tenantId)
      .first<{ details: string }>();
    expect(audit).toBeTruthy();
    const details = JSON.parse(audit!.details);
    expect(details.unrouted_count).toBe(1);
    expect(details.owner_labels).toEqual(['Purchasing']);
  });

  it('splits a mixed run — the routed owner is mailed, the rest are reported', async () => {
    await addRoute(seed.tenantId, 'QA', { userId: seed.userId });
    await makeDoc(seed.tenantId, 'Plant Licence', { owner: 'QA', renewalDueDate: '2026-08-01' });
    await makeDoc(seed.tenantId, 'Orphan Permit', { owner: 'Purchasing', renewalDueDate: '2026-08-01' });

    const { sent } = stubResend();
    const { body } = await runScheduledRun({ as_of: AS_OF, tenant_id: seed.tenantId });

    expect(body.emails_sent).toBe(1);
    expect(body.documents_unrouted).toBe(1);
    const qa = sent.find((m) => m.to.includes('user@test.com'))!;
    // QA's digest is not quietly padded with the record QA does not own.
    expect(qa.html).toContain('Plant Licence');
    expect(qa.html).not.toContain('Orphan Permit');
  });

  it('surfaces the gap through the MANUAL endpoint response too', async () => {
    await makeDoc(seed.tenantId, 'Orphan Permit', { owner: 'Purchasing', renewalDueDate: '2026-08-01' });
    stubResend();
    const { body } = await runNotify(
      { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId },
      { as_of: AS_OF },
    );
    expect(body.sent).toBe(false);
    expect(body.reason).toBe('all_unrouted');
    expect(body.unrouted.count).toBe(1);
    expect(body.unrouted.owner_labels).toEqual(['Purchasing']);
    expect(body.unrouted.documents[0].title).toBe('Orphan Permit');
    expect(body.unrouted.notice_sent).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('cross-tenant isolation', () => {
  it('never uses one tenant’s owner route to address another tenant’s record', async () => {
    // Same label, two tenants, different people behind it.
    await addRoute(seed.tenantId, 'QA', { email: 'qa-one@example.com' });
    await addRoute(seed.tenantId2, 'QA', { email: 'qa-two@example.com' });

    const r1 = await resolveAlertRouting(db, {
      tenantId: seed.tenantId, ownerLabel: 'QA', adminFallback: false,
    });
    expect(r1.recipients.map((x) => x.email)).toEqual(['qa-one@example.com']);

    const r2 = await resolveAlertRouting(db, {
      tenantId: seed.tenantId2, ownerLabel: 'QA', adminFallback: false,
    });
    expect(r2.recipients.map((x) => x.email)).toEqual(['qa-two@example.com']);
  });

  it('keeps an all-tenant run’s digests separate — no document crosses over', async () => {
    await addRoute(seed.tenantId, 'QA', { email: 'qa-one@example.com' });
    await addRoute(seed.tenantId2, 'QA', { email: 'qa-two@example.com' });
    await makeDoc(seed.tenantId, 'Tenant One Licence', { owner: 'QA', renewalDueDate: '2026-08-01' });
    await makeDoc(seed.tenantId2, 'Tenant Two Licence', { owner: 'QA', renewalDueDate: '2026-08-01' });

    const { sent } = stubResend();
    const { body } = await runScheduledRun({ as_of: AS_OF });

    expect(body.tenants_checked).toBeGreaterThanOrEqual(2);
    expect(sent).toHaveLength(2);

    const one = sent.find((m) => m.to.includes('qa-one@example.com'))!;
    const two = sent.find((m) => m.to.includes('qa-two@example.com'))!;
    expect(one.html).toContain('Tenant One Licence');
    expect(one.html).not.toContain('Tenant Two Licence');
    expect(two.html).toContain('Tenant Two Licence');
    expect(two.html).not.toContain('Tenant One Licence');
  });

  it('does not put a super_admin on every tenant’s renewal mail', async () => {
    await addRoute(seed.tenantId, 'QA', { email: 'qa-one@example.com' });
    await makeDoc(seed.tenantId, 'Tenant One Licence', { owner: 'QA', renewalDueDate: '2026-08-01' });
    await makeDoc(seed.tenantId2, 'Tenant Two Licence', { owner: 'QA', renewalDueDate: '2026-08-01' });

    const { sent } = stubResend();
    await runScheduledRun({ as_of: AS_OF });
    for (const m of sent) {
      expect(m.to).not.toContain('admin@test.com');
    }
  });

  it('scopes the re-alert ledger per tenant', async () => {
    await addRoute(seed.tenantId, 'QA', { email: 'qa-one@example.com' });
    await addRoute(seed.tenantId2, 'QA', { email: 'qa-two@example.com' });
    await makeDoc(seed.tenantId, 'Tenant One Licence', { owner: 'QA', renewalDueDate: '2026-08-01' });
    await makeDoc(seed.tenantId2, 'Tenant Two Licence', { owner: 'QA', renewalDueDate: '2026-08-01' });

    const { sent } = stubResend();
    await runScheduledRun({ as_of: AS_OF, tenant_id: seed.tenantId });
    expect(sent).toHaveLength(1);

    // Tenant 1 being alerted must not suppress tenant 2's first-ever alert.
    await runScheduledRun({ as_of: AS_OF });
    expect(sent).toHaveLength(2);
    expect(sent[1].to).toEqual(['qa-two@example.com']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('degradation', () => {
  it('reports the routing it WOULD have used when email is not configured', async () => {
    await addRoute(seed.tenantId, 'QA', { userId: seed.userId });
    await makeDoc(seed.tenantId, 'Plant Licence', { owner: 'QA', renewalDueDate: '2026-08-01' });
    await makeDoc(seed.tenantId, 'Orphan Permit', { owner: 'Purchasing', renewalDueDate: '2026-08-01' });

    const { mock } = stubResend();
    const result = await runRenewalAlerts(db, undefined, {
      tenantId: seed.tenantId, asOf: AS_OF, respectCooldown: true,
    });

    expect(result.reason).toBe('email_not_configured');
    expect(mock).not.toHaveBeenCalled();
    // A dry check before the cutover: who would be mailed, and what would be
    // dropped on the floor.
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].recipients).toEqual(['user@test.com']);
    expect(result.unrouted.count).toBe(1);
    // ...and it changed nothing, so the real run still fires.
    const stamped = await db
      .prepare('SELECT COUNT(*) AS n FROM renewal_alert_state WHERE tenant_id = ?')
      .bind(seed.tenantId)
      .first<{ n: number }>();
    expect(stamped?.n).toBe(0);
  });
});
