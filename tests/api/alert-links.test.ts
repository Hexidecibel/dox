/**
 * GET /api/alerts/public/:token — the token-gated alert landing page.
 *
 * This route is an unauthenticated read of a compliance record, so what is
 * worth pinning here is not "it renders". It is the four properties that make
 * handing this URL out defensible:
 *
 *   1. The token is the ONLY gate, and every unusable state — unknown,
 *      expired, revoked, tampered — is indistinguishable from the others.
 *   2. The response is an ALLOW-LIST. Nothing outside it can appear, and in
 *      particular our configured acceptance limits never leave the portal: a
 *      supplier who can read the threshold can certify to it.
 *   3. A renewal link cannot widen. It shows the exact documents its email
 *      listed and nothing else in the tenant.
 *   4. Every view is audited, because this is exactly the event an auditor
 *      asks about.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestGet as alertGet } from '../../functions/api/alerts/public/[token]';
import { onRequest as middleware } from '../../functions/api/_middleware';
import { buildSpecAlertEmail, buildRenewalAlertEmail } from '../../functions/lib/email';
import { mintAlertLink, generateAlertToken } from '../../functions/lib/alert-links';
import type { AlertLandingView } from '../../shared/types';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let supplierId = '';
let docTypeId = '';

/** Our configured limit. This number must never reach the response. */
const OUR_LIMIT_MAX = 10;
const OUR_LIMIT_TEXT = '<=10 CFU/g';
/** The supplier's own printed limit. Echoing this back leaks nothing. */
const PRINTED_LIMIT_TEXT = '<100 CFU/g';

function makeContext(token: string) {
  const request = new Request(`http://localhost/api/alerts/public/${token}`, { method: 'GET' });
  return {
    request,
    env,
    data: {},
    params: { token },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/alerts/public/${token}`,
  } as never;
}

async function makeDocument(title: string, opts: { renewalDue?: string } = {}): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO documents
         (id, tenant_id, title, current_version, status, created_by,
          supplier_id, document_type_id, owner, renewal_type, renewal_due_date)
       VALUES (?, ?, ?, 1, 'active', ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      seed.tenantId,
      title,
      seed.orgAdminId,
      supplierId,
      docTypeId,
      'Priya in QA — internal routing, must not leak',
      opts.renewalDue ? 'hard_expiry' : null,
      opts.renewalDue ?? null
    )
    .run();
  return id;
}

async function insertSpecCheck(
  documentId: string,
  over: { source?: 'printed' | 'limit'; test?: string; value?: string } = {}
) {
  const source = over.source ?? 'limit';
  const snapshot =
    source === 'printed'
      ? JSON.stringify({ printed: PRINTED_LIMIT_TEXT })
      : JSON.stringify({
          operator: '<=',
          value_min: null,
          value_max: OUR_LIMIT_MAX,
          unit: 'CFU/g',
          severity: 'alert',
          text: OUR_LIMIT_TEXT,
        });
  await db
    .prepare(
      `INSERT INTO document_spec_checks
         (id, tenant_id, document_id, version_number, queue_item_id,
          spec_test_id, test_name_raw, value_raw, value_num, unit_raw,
          verdict, reason, source, limit_id, limit_snapshot)
       VALUES (?, ?, ?, 1, 'queue-item-secret', 'spec-test-secret', ?, ?, 40, 'CFU/g',
               'out_of_spec', 'internal reasoning that must not leak', ?, 'limit-id-secret', ?)`
    )
    .bind(
      generateTestId(),
      seed.tenantId,
      documentId,
      over.test ?? 'Coliform',
      over.value ?? '40',
      source,
      snapshot
    )
    .run();
}

async function get(token: string): Promise<{ status: number; body: unknown }> {
  const resp = await alertGet(makeContext(token));
  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    body = null;
  }
  return { status: resp.status, body };
}

/** Every key that appears anywhere in the payload, at any depth. */
function allKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) allKeys(v, into);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      allKeys(v, into);
    }
  }
  return into;
}

beforeAll(async () => {
  seed = await seedTestData(db);

  supplierId = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(supplierId, seed.tenantId, 'Andersen Dairy', `andersen-al-${supplierId.slice(0, 6)}`)
    .run();

  docTypeId = generateTestId();
  await db
    .prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
    .bind(docTypeId, seed.tenantId, 'COA', `coa-al-${docTypeId.slice(0, 6)}`)
    .run();
}, 30_000);

describe('a valid token renders the alert', () => {
  it('shows the document and its failing result', async () => {
    const documentId = await makeDocument('Andersen COA 8817');
    await insertSpecCheck(documentId);
    const token = await mintAlertLink(db, {
      tenantId: seed.tenantId,
      kind: 'spec_alert',
      documentId,
    });
    expect(token).toBeTruthy();

    const { status, body } = await get(token!);
    expect(status).toBe(200);
    const view = body as AlertLandingView;
    expect(view.kind).toBe('spec_alert');
    expect(view.tenant_name).toBe('Test Corp');
    expect(view.document?.title).toBe('Andersen COA 8817');
    expect(view.document?.supplier_name).toBe('Andersen Dairy');
    expect(view.document?.document_type_name).toBe('COA');
    expect(view.failures).toHaveLength(1);
    expect(view.failures[0].test).toBe('Coliform');
    expect(view.failures[0].value).toBe('40');
    expect(view.expires_at).toBeTruthy();
  });

  it('mints a token with real entropy', () => {
    const a = generateAlertToken();
    const b = generateAlertToken();
    expect(a).not.toBe(b);
    // 32 bytes -> base64url, no padding, no + or /
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('the response is an allow-list', () => {
  it('never exposes OUR configured limit, only the certificate\'s own', async () => {
    const documentId = await makeDocument('Two-source COA');
    await insertSpecCheck(documentId, { source: 'limit', test: 'Coliform' });
    await insertSpecCheck(documentId, { source: 'printed', test: 'Yeast' });
    const token = await mintAlertLink(db, {
      tenantId: seed.tenantId,
      kind: 'spec_alert',
      documentId,
    });

    const { status, body } = await get(token!);
    expect(status).toBe(200);
    const view = body as AlertLandingView;
    const serialized = JSON.stringify(body);

    const ours = view.failures.find((f) => f.test === 'Coliform')!;
    const printed = view.failures.find((f) => f.test === 'Yeast')!;

    // The judgement is stated. The threshold behind it is not.
    expect(ours.judged_against).toBe('internal');
    expect(ours.printed_limit).toBeNull();
    expect(serialized).not.toContain(OUR_LIMIT_TEXT);
    expect(serialized).not.toContain('value_max');
    expect(serialized).not.toContain('severity');
    expect(serialized).not.toContain('limit_snapshot');
    expect(serialized).not.toContain('limit-id-secret');
    expect(serialized).not.toContain('spec-test-secret');
    // The bare number, too — not just the formatted text. Scoped to the
    // failures, since the expiry timestamp legitimately contains digits.
    expect(JSON.stringify(view.failures)).not.toMatch(/\b10\b/);

    // The supplier's own printed limit IS shown. It came off their document.
    expect(printed.judged_against).toBe('printed');
    expect(printed.printed_limit).toBe(PRINTED_LIMIT_TEXT);
  });

  it('carries no key outside the allow-list, and no internal ids at all', async () => {
    const documentId = await makeDocument('Allow-list COA');
    await insertSpecCheck(documentId);
    const token = await mintAlertLink(db, {
      tenantId: seed.tenantId,
      kind: 'spec_alert',
      documentId,
    });

    const { body } = await get(token!);
    const keys = allKeys(body);

    const ALLOWED = new Set([
      'kind',
      'tenant_name',
      'expires_at',
      'document',
      'title',
      'supplier_name',
      'document_type_name',
      'received_date',
      'failures',
      'test',
      'value',
      'unit',
      'judged_against',
      'printed_limit',
      'renewals',
      'category',
      'due_date',
      'days_until',
      'status',
    ]);
    const extra = [...keys].filter((k) => !ALLOWED.has(k));
    expect(extra).toEqual([]);

    // No id of any kind — so this payload cannot be used to hand-craft a call
    // against any other endpoint.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(documentId);
    expect(serialized).not.toContain(seed.tenantId);
    expect(serialized).not.toContain(supplierId);
    expect(serialized).not.toContain(docTypeId);
    expect(serialized).not.toContain('queue-item-secret');
    // Internal reasoning and routing stay inside.
    expect(serialized).not.toContain('internal reasoning');
    expect(serialized).not.toContain('Priya in QA');
  });
});

describe('bad tokens', () => {
  it('404s an unknown token', async () => {
    const { status } = await get(generateAlertToken());
    expect(status).toBe(404);
  });

  it('404s a tampered token rather than matching a prefix', async () => {
    const documentId = await makeDocument('Tamper COA');
    await insertSpecCheck(documentId);
    const token = (await mintAlertLink(db, {
      tenantId: seed.tenantId,
      kind: 'spec_alert',
      documentId,
    }))!;

    const flipped = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
    expect(flipped).not.toBe(token);
    expect((await get(flipped)).status).toBe(404);
    // Truncation must not match either.
    expect((await get(token.slice(0, -1))).status).toBe(404);
  });

  it('404s an expired token', async () => {
    const documentId = await makeDocument('Expired COA');
    await insertSpecCheck(documentId);
    const token = (await mintAlertLink(db, {
      tenantId: seed.tenantId,
      kind: 'spec_alert',
      documentId,
    }))!;
    expect((await get(token)).status).toBe(200);

    await db
      .prepare("UPDATE alert_links SET expires_at = '2020-01-01T00:00:00.000Z' WHERE token = ?")
      .bind(token)
      .run();
    expect((await get(token)).status).toBe(404);
  });

  it('404s a revoked token', async () => {
    const documentId = await makeDocument('Revoked COA');
    await insertSpecCheck(documentId);
    const token = (await mintAlertLink(db, {
      tenantId: seed.tenantId,
      kind: 'spec_alert',
      documentId,
    }))!;
    await db
      .prepare("UPDATE alert_links SET revoked_at = datetime('now') WHERE token = ?")
      .bind(token)
      .run();
    expect((await get(token)).status).toBe(404);
  });

  it('404s when the document behind the link is gone', async () => {
    const documentId = await makeDocument('Deleted COA');
    await insertSpecCheck(documentId);
    const token = (await mintAlertLink(db, {
      tenantId: seed.tenantId,
      kind: 'spec_alert',
      documentId,
    }))!;
    await db.prepare("UPDATE documents SET status = 'deleted' WHERE id = ?").bind(documentId).run();
    expect((await get(token)).status).toBe(404);
  });

  it('is not single-use — the same link opens more than once', async () => {
    const documentId = await makeDocument('Reopen COA');
    await insertSpecCheck(documentId);
    const token = (await mintAlertLink(db, {
      tenantId: seed.tenantId,
      kind: 'spec_alert',
      documentId,
    }))!;
    expect((await get(token)).status).toBe(200);
    expect((await get(token)).status).toBe(200);

    const row = await db
      .prepare('SELECT view_count FROM alert_links WHERE token = ?')
      .bind(token)
      .first<{ view_count: number }>();
    expect(row!.view_count).toBe(2);
  });
});

describe('rate limiting', () => {
  it('429s once the per-link budget is spent', async () => {
    const documentId = await makeDocument('Rate limited COA');
    await insertSpecCheck(documentId);
    const token = (await mintAlertLink(db, {
      tenantId: seed.tenantId,
      kind: 'spec_alert',
      documentId,
    }))!;
    const link = await db
      .prepare('SELECT id FROM alert_links WHERE token = ?')
      .bind(token)
      .first<{ id: string }>();

    // getClientIp has nothing to read in tests, so the endpoint keys on
    // 'unknown'. Pre-spend the budget rather than issuing 30 real requests.
    await db
      .prepare(
        `INSERT INTO rate_limits (key, attempts, window_start)
         VALUES (?, 30, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET attempts = 30, window_start = datetime('now')`
      )
      .bind(`alert_link_view:${link!.id}:unknown`)
      .run();

    expect((await get(token)).status).toBe(429);
  });
});

describe('the audit trail', () => {
  it('writes an alert_link.view row with no user and the tenant attached', async () => {
    const documentId = await makeDocument('Audited COA');
    await insertSpecCheck(documentId);
    const token = (await mintAlertLink(db, {
      tenantId: seed.tenantId,
      kind: 'spec_alert',
      documentId,
    }))!;
    const link = await db
      .prepare('SELECT id FROM alert_links WHERE token = ?')
      .bind(token)
      .first<{ id: string }>();

    expect((await get(token)).status).toBe(200);

    const audit = await db
      .prepare(
        `SELECT user_id, tenant_id, action, resource_type, resource_id, details
           FROM audit_log
          WHERE action = 'alert_link.view' AND resource_id = ?`
      )
      .bind(link!.id)
      .first<Record<string, unknown>>();

    expect(audit).toBeTruthy();
    expect(audit!.user_id).toBeNull();
    expect(audit!.tenant_id).toBe(seed.tenantId);
    expect(audit!.resource_type).toBe('alert_link');
    expect(JSON.parse(String(audit!.details))).toMatchObject({
      kind: 'spec_alert',
      document_id: documentId,
    });
  });
});

describe('renewal digests', () => {
  it('shows only the documents its own email listed', async () => {
    const soon = new Date();
    soon.setUTCDate(soon.getUTCDate() + 10);
    const dueSoon = soon.toISOString().slice(0, 10);

    const inEmail = await makeDocument('Organic certificate', { renewalDue: dueSoon });
    const notInEmail = await makeDocument('Kosher certificate', { renewalDue: dueSoon });

    const token = (await mintAlertLink(db, {
      tenantId: seed.tenantId,
      kind: 'renewal_alert',
      subjectIds: [inEmail],
    }))!;

    const { status, body } = await get(token);
    expect(status).toBe(200);
    const view = body as AlertLandingView;
    expect(view.kind).toBe('renewal_alert');
    expect(view.document).toBeNull();
    expect(view.failures).toEqual([]);
    expect(view.renewals.map((r) => r.title)).toEqual(['Organic certificate']);

    // A link forwarded from one digest must never widen to cover a document
    // that was not in the email it came from.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('Kosher certificate');
    expect(serialized).not.toContain(notInEmail);
    // The `owner` string is internal routing and stays out.
    expect(serialized).not.toContain('Priya in QA');
    expect(serialized).not.toContain('owner');
  });
});

describe('the route is actually public', () => {
  // Run the REAL auth middleware, not a re-declared copy of its list. A
  // missing allowlist entry shows up as a 401 — which is precisely the bug
  // this whole feature exists to fix, so it gets a test that would catch it.
  async function throughMiddleware(path: string): Promise<Response> {
    const auth = middleware[1];
    let reachedHandler = false;
    const ctx = {
      request: new Request(`http://localhost${path}`, { method: 'GET' }),
      env,
      data: {},
      params: {},
      waitUntil: () => {},
      passThroughOnException: () => {},
      next: async () => {
        reachedHandler = true;
        return new Response('handler', { status: 200 });
      },
      functionPath: path,
    } as never;
    const resp = await auth(ctx);
    return new Response(reachedHandler ? 'handler' : await resp.text(), {
      status: resp.status,
    });
  }

  it('lets an unauthenticated alert-link read past the JWT gate', async () => {
    const resp = await throughMiddleware('/api/alerts/public/whatever-token');
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe('handler');
  });

  it('still gates every sibling under /api/alerts', async () => {
    // The prefix is deliberately narrow so a future /api/alerts admin
    // endpoint is not allowlisted by accident.
    for (const path of ['/api/alerts', '/api/alerts/limits', '/api/alerts/publicish']) {
      const resp = await throughMiddleware(path);
      expect(resp.status).toBe(401);
    }
  });

  it('answers no-store so a shared cache never holds the record', async () => {
    const documentId = await makeDocument('Cache header COA');
    await insertSpecCheck(documentId);
    const token = (await mintAlertLink(db, {
      tenantId: seed.tenantId,
      kind: 'spec_alert',
      documentId,
    }))!;
    const resp = await alertGet(makeContext(token));
    expect(resp.status).toBe(200);
    expect(resp.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('the emails carry the link', () => {
  it('makes the no-login landing page the primary call to action on a spec alert', () => {
    const { html, text } = buildSpecAlertEmail({
      tenantName: 'Test Corp',
      documentTitle: 'Andersen COA 8817',
      documentId: 'doc-123',
      supplierName: 'Andersen Dairy',
      failures: [{ test: 'Coliform', value: '40', limit: '<=10 CFU/g', source: 'limit' }],
      appUrl: 'https://supdox.com',
      alertUrl: 'https://supdox.com/alert/TOKEN123',
    });
    expect(html).toContain('https://supdox.com/alert/TOKEN123');
    expect(text).toContain('https://supdox.com/alert/TOKEN123');
    // The portal deep link survives as a clearly secondary line for the
    // account-holding queue owner, who needs the full record.
    expect(html).toContain('https://supdox.com/documents/doc-123');
  });

  it('falls back to the portal link when no alert link could be minted', () => {
    const { html } = buildSpecAlertEmail({
      tenantName: 'Test Corp',
      documentTitle: 'Andersen COA 8817',
      documentId: 'doc-123',
      supplierName: null,
      failures: [{ test: 'Coliform', value: '40', limit: null, source: 'printed' }],
      appUrl: 'https://supdox.com',
      alertUrl: null,
    });
    expect(html).toContain('https://supdox.com/documents/doc-123');
    expect(html).not.toContain('/alert/');
  });

  it('gives the renewal alert a link, which it did not have at all before', () => {
    const docs = [
      {
        id: 'd1',
        title: 'Organic certificate',
        primary_category_name: 'Certification',
        owner: 'Priya',
        renewal_type: 'hard_expiry' as const,
        renewal_due_date: '2026-10-01',
        status: 'expiring' as const,
        days_until: 10,
      },
    ];
    const withLink = buildRenewalAlertEmail(docs, 'Test Corp', 'https://supdox.com/alert/TOKEN456');
    expect(withLink.html).toContain('https://supdox.com/alert/TOKEN456');
    expect(withLink.text).toContain('https://supdox.com/alert/TOKEN456');

    // Still degrades to the old shape when minting failed.
    const withoutLink = buildRenewalAlertEmail(docs, 'Test Corp', null);
    expect(withoutLink.html).not.toContain('/alert/');
  });
});
