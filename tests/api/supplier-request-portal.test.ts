/**
 * /r/:token — the external supplier request page.
 *
 * This is an unauthenticated read AND an unauthenticated write against a
 * customer's compliance records, so what is pinned here is not "it renders".
 * It is the properties that make handing this URL to a vendor defensible:
 *
 *   1. The token is the ONLY gate, and every unusable state — unknown,
 *      expired, revoked, malformed, withdrawn — is indistinguishable.
 *   2. The response is an ALLOW-LIST. Nothing outside it can appear at any
 *      depth, and in particular OUR configured spec limits never leave the
 *      portal: a supplier who can read the threshold can certify to it.
 *   3. One document can close many items, and the response says so. That
 *      sentence is the product thesis and it has a test.
 *   4. The progress number counts SATISFIED items, never uploaded files, and
 *      nothing a supplier does on their own can move it.
 *   5. A needs_attention item is never the bare word "rejected".
 *   6. An amendment does not dead-link a URL already in a supplier's inbox.
 *   7. Every view and every upload is audited.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestGet as portalGet } from '../../functions/api/supplier-requests/public/[token]';
import { onRequestPost as portalUpload } from '../../functions/api/supplier-requests/public/[token]/upload';
import { onRequest as middleware } from '../../functions/api/_middleware';
import { onRequestPut as lineUpdate } from '../../functions/api/request-lines/[id]';
import {
  computeRequestLinkExpiry,
  generateRequestToken,
  itemRef,
  mintRequestLink,
  REQUEST_LINK_MIN_TTL_DAYS,
} from '../../functions/lib/request-links';
import { buildUploadMessage } from '../../functions/lib/request-links';
import type { SupplierRequestView, SupplierUploadResult } from '../../shared/types';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let supplierId = '';
let otherSupplierId = '';
let requirementIds: string[] = [];

/**
 * Strings that exist in the database next to everything this page reads and
 * must never appear in a byte of its output.
 */
const OUR_LIMIT_TEXT = '<=10 CFU/g';
const INTERNAL_NOTE = 'INTERNAL-they-always-send-the-2023-cert-escalate-to-Dan';
const ROUTING_NOTE = 'INTERNAL-ROUTING-posted-via-Sarah-do-not-share';
const RECIPIENT = 'internal-recipient@medosweet.example';
const LINE_OWNER = 'INTERNAL-owner-Priya-in-QA';
const OTHER_SUPPLIER_DOC = 'CONFIDENTIAL-OtherSupplier-Audit-Report';

function ctx(token: string, init?: RequestInit, path = '') {
  const url = `http://localhost/api/supplier-requests/public/${token}${path}`;
  return {
    request: new Request(url, init ?? { method: 'GET' }),
    env,
    data: {},
    params: { token },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/supplier-requests/public/${token}${path}`,
  } as never;
}

async function get(token: string): Promise<{ status: number; body: unknown }> {
  const resp = await portalGet(ctx(token));
  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    body = null;
  }
  return { status: resp.status, body };
}

async function upload(
  token: string,
  refs: string[],
  opts: { name?: string; type?: string; bytes?: number; label?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const form = new FormData();
  const blob = new Blob([new Uint8Array(opts.bytes ?? 64)], {
    type: opts.type ?? 'application/pdf',
  });
  form.append('file', new File([blob], opts.name ?? 'cert.pdf', {
    type: opts.type ?? 'application/pdf',
  }));
  form.append('item_refs', JSON.stringify(refs));
  if (opts.label) form.append('uploader_label', opts.label);

  const resp = await portalUpload(ctx(token, { method: 'POST', body: form }, '/upload'));
  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    body = null;
  }
  return { status: resp.status, body };
}

/** Authenticated PUT against one request line, as an org_admin reviewer. */
async function linePut(
  lineId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const c = {
    request: new Request(`http://localhost/api/request-lines/${lineId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
    env,
    data: {
      user: {
        id: seed.orgAdminId,
        email: 'orgadmin@test.com',
        name: 'Org Admin',
        role: 'org_admin',
        tenant_id: seed.tenantId,
      },
    },
    params: { id: lineId },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/request-lines/${lineId}`,
  } as never;
  const resp = await lineUpdate(c);
  let parsed: unknown = null;
  try {
    parsed = await resp.json();
  } catch {
    parsed = null;
  }
  return { status: resp.status, body: parsed };
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

/**
 * Build one issued ask with `names.length` typed lines, plus a link.
 * Every internal field that could leak is populated with a marked string.
 */
async function makeRequest(
  names: string[],
  opts: {
    dueDate?: string | null;
    status?: string;
    tiers?: ('required' | 'recommended')[];
    supplier?: string;
  } = {},
): Promise<{ requestId: string; rootId: string; token: string; lineIds: string[] }> {
  const requestId = generateTestId();
  const supplier = opts.supplier ?? supplierId;

  await db
    .prepare(
      `INSERT INTO document_requests
         (id, tenant_id, supplier_id, root_request_id, version, title, intro,
          due_date, assigned_to, origin, origin_ref, status, issued_at, created_by)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 'gap', 'INTERNAL-origin-ref-secret', ?, datetime('now'), ?)`,
    )
    .bind(
      requestId,
      seed.tenantId,
      supplier,
      requestId,
      'Annual supplier documentation',
      'Please send the items below.',
      opts.dueDate === undefined ? '2026-12-01' : opts.dueDate,
      seed.orgAdminId,
      opts.status ?? 'issued',
      seed.orgAdminId,
    )
    .run();

  await db
    .prepare(
      `INSERT INTO request_routing
         (id, tenant_id, request_id, issued_by, version, channel, recipient, internal_notes)
       VALUES (?, ?, ?, ?, 1, 'portal', ?, ?)`,
    )
    .bind(generateTestId(), seed.tenantId, requestId, seed.orgAdminId, RECIPIENT, ROUTING_NOTE)
    .run();

  const lineIds: string[] = [];
  for (let i = 0; i < names.length; i += 1) {
    const lineId = generateTestId();
    lineIds.push(lineId);
    await db
      .prepare(
        `INSERT INTO request_lines
           (id, tenant_id, request_id, line_kind, requirement_id, name, explanation,
            acceptable_formats, criteria, owner, tier, status, status_note, sort_order)
         VALUES (?, ?, ?, 'requirement', ?, ?, ?, ?, ?, ?, ?, 'not_started', ?, ?)`,
      )
      .bind(
        lineId,
        seed.tenantId,
        requestId,
        requirementIds[i % requirementIds.length],
        names[i],
        `Plain-language reason for ${names[i]}.`,
        'PDF or a clear photo',
        'Signed, dated within 12 months',
        LINE_OWNER,
        opts.tiers?.[i] ?? 'required',
        INTERNAL_NOTE,
        i,
      )
      .run();
  }

  const token = await mintRequestLink(db, {
    tenantId: seed.tenantId,
    rootRequestId: requestId,
    supplierId: supplier,
    dueDate: '2026-12-01',
    createdBy: seed.orgAdminId,
  });

  return { requestId, rootId: requestId, token: token!, lineIds };
}

async function refsFor(token: string, lineIds: string[]): Promise<string[]> {
  return Promise.all(lineIds.map((id) => itemRef(token, id)));
}

beforeAll(async () => {
  seed = await seedTestData(db);

  supplierId = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(supplierId, seed.tenantId, 'Andersen Dairy', `andersen-rp-${supplierId.slice(0, 6)}`)
    .run();

  otherSupplierId = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(otherSupplierId, seed.tenantId, 'Rival Foods', `rival-rp-${otherSupplierId.slice(0, 6)}`)
    .run();

  // A registry vocabulary big enough to build a 14-item ask from.
  requirementIds = [];
  for (let i = 0; i < 14; i += 1) {
    const id = generateTestId();
    requirementIds.push(id);
    await db
      .prepare(
        'INSERT INTO requirements (id, tenant_id, slug, name, active) VALUES (?, ?, ?, ?, 1)',
      )
      .bind(id, seed.tenantId, `req-rp-${i}-${id.slice(0, 6)}`, `Requirement ${i}`)
      .run();
  }

  // A document belonging to ANOTHER supplier, carrying a confidential title and
  // a configured out-of-spec judgement. Nothing about it may surface.
  const otherDocId = generateTestId();
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, current_version, status, created_by, supplier_id)
       VALUES (?, ?, ?, 1, 'active', ?, ?)`,
    )
    .bind(otherDocId, seed.tenantId, OTHER_SUPPLIER_DOC, seed.orgAdminId, otherSupplierId)
    .run();
  await db
    .prepare(
      `INSERT INTO document_spec_checks
         (id, tenant_id, document_id, version_number, queue_item_id, spec_test_id,
          test_name_raw, value_raw, value_num, unit_raw, verdict, reason, source,
          limit_id, limit_snapshot)
       VALUES (?, ?, ?, 1, 'queue-secret', 'spec-test-secret', 'Coliform', '40', 40, 'CFU/g',
               'out_of_spec', 'INTERNAL-judgement-reasoning', 'limit', 'limit-id-secret', ?)`,
    )
    .bind(
      generateTestId(),
      seed.tenantId,
      otherDocId,
      JSON.stringify({ operator: '<=', value_max: 10, unit: 'CFU/g', text: OUR_LIMIT_TEXT }),
    )
    .run();
}, 30_000);

// ---------------------------------------------------------------------------

describe('the token is the only gate', () => {
  it('renders the ask for a valid token', async () => {
    const { token } = await makeRequest(['Allergen Statement', 'Kosher Certificate']);
    const { status, body } = await get(token);
    expect(status).toBe(200);
    const view = body as SupplierRequestView;
    expect(view.tenant_name).toBe('Test Corp');
    expect(view.supplier_name).toBe('Andersen Dairy');
    expect(view.title).toBe('Annual supplier documentation');
    expect(view.items).toHaveLength(2);
    expect(view.items[0].name).toBe('Allergen Statement');
    expect(view.items[0].explanation).toContain('Plain-language reason');
    expect(view.items[0].acceptable_formats).toBe('PDF or a clear photo');
    expect(view.items[0].criteria).toContain('Signed, dated');
    expect(view.items[0].status).toBe('not_started');
    expect(view.link_expires_at).toBeTruthy();
  });

  it('404s identically for unknown, malformed, revoked and expired tokens', async () => {
    const { token } = await makeRequest(['Item A']);

    const unknown = await get(generateRequestToken());
    const malformed = await get('short');
    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(unknown.body).toEqual(malformed.body);

    await db
      .prepare("UPDATE request_links SET revoked_at = datetime('now') WHERE token = ?")
      .bind(token)
      .run();
    const revoked = await get(token);
    expect(revoked.status).toBe(404);
    expect(revoked.body).toEqual(unknown.body);

    // Expired reads the same as revoked reads the same as never-existed.
    const { token: t2 } = await makeRequest(['Item B']);
    await db
      .prepare("UPDATE request_links SET revoked_at = NULL, expires_at = '2020-01-01T00:00:00.000Z' WHERE token = ?")
      .bind(t2)
      .run();
    const expired = await get(t2);
    expect(expired.status).toBe(404);
    expect(expired.body).toEqual(unknown.body);
  });

  it('404s for a draft, a cancelled ask and a superseded version', async () => {
    for (const status of ['draft', 'cancelled']) {
      const { token } = await makeRequest(['Item'], { status });
      expect((await get(token)).status).toBe(404);
    }
    const { token, requestId } = await makeRequest(['Item']);
    await db
      .prepare("UPDATE document_requests SET superseded_at = datetime('now') WHERE id = ?")
      .bind(requestId)
      .run();
    expect((await get(token)).status).toBe(404);
  });

  it('mints tokens with real entropy', () => {
    const a = generateRequestToken();
    const b = generateRequestToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

// ---------------------------------------------------------------------------

describe('the response is an allow-list', () => {
  it('carries no key outside the allow-list, at any depth', async () => {
    const { token, lineIds } = await makeRequest(['Allergen Statement', 'Kosher Certificate']);
    await upload(token, await refsFor(token, [lineIds[0]]), { label: 'Priya' });
    await db
      .prepare(
        `UPDATE request_lines SET status = 'needs_attention',
           attention_reason = 'The certificate you sent expired in March.'
         WHERE id = ?`,
      )
      .bind(lineIds[1])
      .run();

    const { body } = await get(token);
    const keys = allKeys(body);

    const ALLOWED = new Set([
      // request
      'tenant_name',
      'supplier_name',
      'title',
      'intro',
      'due_date',
      'issued_at',
      'amended',
      'items',
      'progress',
      'complete',
      'history',
      'accepting_uploads',
      'link_expires_at',
      // progress
      'required_total',
      'required_satisfied',
      'recommended_total',
      'recommended_satisfied',
      // items
      'ref',
      'name',
      'explanation',
      'acceptable_formats',
      'criteria',
      'tier',
      'status',
      'attention_reason',
      'received_count',
      'also_covers',
      // history
      'file_name',
      'size_bytes',
      'uploaded_at',
      'uploader_label',
      'covered_items',
    ]);
    const extra = [...keys].filter((k) => !ALLOWED.has(k));
    expect(extra).toEqual([]);
  });

  it('holds the upload response to an allow-list too', async () => {
    // The POST builds its own payload, so it needs its own set-difference. A
    // leak here would be just as unrecoverable as one on the GET.
    const { token, lineIds } = await makeRequest(['Allergen Statement', 'Kosher Certificate']);
    const { body } = await upload(token, await refsFor(token, lineIds), {
      name: 'pack.pdf',
      label: 'Priya',
    });

    const ALLOWED = new Set([
      'file_name',
      'covered_count',
      'covered_items',
      'message',
      'progress',
      'required_total',
      'required_satisfied',
      'recommended_total',
      'recommended_satisfied',
    ]);
    expect([...allKeys(body)].filter((k) => !ALLOWED.has(k))).toEqual([]);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(OUR_LIMIT_TEXT);
    expect(serialized).not.toContain(INTERNAL_NOTE);
    expect(serialized).not.toContain(ROUTING_NOTE);
    expect(serialized).not.toContain(LINE_OWNER);
    expect(serialized).not.toContain(seed.tenantId);
    expect(serialized).not.toContain(supplierId);
    expect(serialized).not.toContain(token);
    for (const id of lineIds) expect(serialized).not.toContain(id);
    // No r2 key, and no id for the arrival it just created.
    expect(serialized).not.toContain('r2_key');
    expect(serialized).not.toContain('requests/');
    expect(serialized).not.toContain('upload_id');
  });

  it('never exposes OUR configured spec limits', async () => {
    const { token } = await makeRequest(['Allergen Statement']);
    const { body } = await get(token);
    const serialized = JSON.stringify(body);

    // The threshold text, the bare number, the column names, and every id that
    // would let someone go and ask for it.
    expect(serialized).not.toContain(OUR_LIMIT_TEXT);
    expect(serialized).not.toContain('value_max');
    expect(serialized).not.toContain('value_min');
    expect(serialized).not.toContain('limit_snapshot');
    expect(serialized).not.toContain('spec_test');
    expect(serialized).not.toContain('limit-id-secret');
    expect(serialized).not.toContain('spec-test-secret');
    expect(serialized).not.toContain('severity');
    expect(serialized).not.toContain('verdict');
    expect(serialized).not.toContain('out_of_spec');
    expect(serialized).not.toContain('not_checked');
  });

  it('never exposes routing, internal notes, classification or another supplier', async () => {
    const { token, lineIds } = await makeRequest(['Allergen Statement']);
    await db
      .prepare("UPDATE request_lines SET status_note = ? WHERE id = ?")
      .bind(INTERNAL_NOTE, lineIds[0])
      .run();

    const { body } = await get(token);
    const serialized = JSON.stringify(body);

    expect(serialized).not.toContain(INTERNAL_NOTE);
    expect(serialized).not.toContain(ROUTING_NOTE);
    expect(serialized).not.toContain(RECIPIENT);
    expect(serialized).not.toContain(LINE_OWNER);
    expect(serialized).not.toContain(OTHER_SUPPLIER_DOC);
    expect(serialized).not.toContain('Rival Foods');
    expect(serialized).not.toContain('INTERNAL-judgement-reasoning');
    expect(serialized).not.toContain('INTERNAL-origin-ref-secret');
    expect(serialized).not.toContain('classification_status');
    expect(serialized).not.toContain('issued_by');
    expect(serialized).not.toContain('assigned_to');
    expect(serialized).not.toContain('amendment_reason');
    expect(serialized).not.toContain('line_kind');
    expect(serialized).not.toContain(seed.orgAdminId);
  });

  it('carries no internal id — not the request, tenant, supplier, line or requirement', async () => {
    const { token, requestId, lineIds } = await makeRequest(['A', 'B']);
    const { body } = await get(token);
    const serialized = JSON.stringify(body);

    expect(serialized).not.toContain(requestId);
    expect(serialized).not.toContain(seed.tenantId);
    expect(serialized).not.toContain(supplierId);
    for (const id of lineIds) expect(serialized).not.toContain(id);
    for (const id of requirementIds) expect(serialized).not.toContain(id);
    // Nor the token itself, which would put the secret in the page body.
    expect(serialized).not.toContain(token);
  });

  it('derives item handles that are bound to their own token', async () => {
    const { token, lineIds } = await makeRequest(['A']);
    const { token: other } = await makeRequest(['B']);
    const mine = await itemRef(token, lineIds[0]);
    const foreign = await itemRef(other, lineIds[0]);

    expect(mine).not.toBe(foreign);
    expect(mine).not.toContain(lineIds[0]);
    // A handle harvested from another link addresses nothing here.
    const res = await upload(token, [foreign]);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------

describe('one document can close many items', () => {
  it('says so, in a sentence, when a file covers more than one', async () => {
    const names = Array.from({ length: 14 }, (_, i) => `Item ${i + 1}`);
    const { token, lineIds } = await makeRequest(names);
    const refs = await refsFor(token, lineIds.slice(0, 7));

    const { status, body } = await upload(token, refs, { name: 'allergen-pack.pdf' });
    expect(status).toBe(200);
    const result = body as SupplierUploadResult;

    expect(result.covered_count).toBe(7);
    expect(result.covered_items).toHaveLength(7);
    expect(result.message).toContain('7 of your 14 items');
    expect(result.message).toContain('you do not need to send it again');

    // Every one of the seven moved, and only those seven.
    const view = (await get(token)).body as SupplierRequestView;
    const received = view.items.filter((i) => i.status === 'received');
    expect(received).toHaveLength(7);
    expect(view.items.filter((i) => i.status === 'not_started')).toHaveLength(7);
    for (const item of received) expect(item.received_count).toBe(1);
  });

  it('is a plain confirmation for a single item, not a boast', () => {
    expect(buildUploadMessage(1, 14)).not.toContain('1 of your 14');
    expect(buildUploadMessage(7, 14)).toContain('7 of your 14 items');
    expect(buildUploadMessage(0, 14)).toBeTruthy();
  });

  it('suggests siblings this supplier has closed together before', async () => {
    // One prior document of theirs that CONFIRMED two requirements at once.
    const priorDoc = generateTestId();
    await db
      .prepare(
        `INSERT INTO documents (id, tenant_id, title, current_version, status, created_by, supplier_id)
         VALUES (?, ?, 'Prior pack', 1, 'active', ?, ?)`,
      )
      .bind(priorDoc, seed.tenantId, seed.orgAdminId, supplierId)
      .run();
    for (const rid of [requirementIds[0], requirementIds[1]]) {
      await db
        .prepare(
          `INSERT INTO document_requirements (id, document_id, requirement_id, status)
           VALUES (?, ?, ?, 'confirmed')`,
        )
        .bind(generateTestId(), priorDoc, rid)
        .run();
    }
    // A REJECTED pairing must not be suggested — a human already said no.
    await db
      .prepare(
        `INSERT INTO document_requirements (id, document_id, requirement_id, status)
         VALUES (?, ?, ?, 'rejected')`,
      )
      .bind(generateTestId(), priorDoc, requirementIds[2])
      .run();

    const { token } = await makeRequest(['Item 1', 'Item 2', 'Item 3']);
    const view = (await get(token)).body as SupplierRequestView;

    expect(view.items[0].also_covers).toContain(view.items[1].ref);
    expect(view.items[1].also_covers).toContain(view.items[0].ref);
    expect(view.items[0].also_covers).not.toContain(view.items[2].ref);
    expect(view.items[0].also_covers).not.toContain(view.items[0].ref);
  });

  it('does not learn co-satisfaction from another supplier', async () => {
    const rivalDoc = generateTestId();
    await db
      .prepare(
        `INSERT INTO documents (id, tenant_id, title, current_version, status, created_by, supplier_id)
         VALUES (?, ?, 'Rival pack', 1, 'active', ?, ?)`,
      )
      .bind(rivalDoc, seed.tenantId, seed.orgAdminId, otherSupplierId)
      .run();
    for (const rid of [requirementIds[9], requirementIds[10]]) {
      await db
        .prepare(
          `INSERT INTO document_requirements (id, document_id, requirement_id, status)
           VALUES (?, ?, ?, 'confirmed')`,
        )
        .bind(generateTestId(), rivalDoc, rid)
        .run();
    }

    const names = Array.from({ length: 11 }, (_, i) => `N${i}`);
    const { token } = await makeRequest(names);
    const view = (await get(token)).body as SupplierRequestView;
    expect(view.items[9].also_covers).not.toContain(view.items[10].ref);
  });
});

// ---------------------------------------------------------------------------

describe('uploading', () => {
  it('takes a batch and a single targeted file', async () => {
    const { token, lineIds } = await makeRequest(['A', 'B', 'C']);
    const refs = await refsFor(token, lineIds);

    // Batch: one file across all three.
    const batch = await upload(token, refs, { name: 'pack.pdf' });
    expect(batch.status).toBe(200);
    expect((batch.body as SupplierUploadResult).covered_count).toBe(3);

    // Targeted: a replacement for just one.
    const single = await upload(token, [refs[1]], { name: 'fix.pdf' });
    expect(single.status).toBe(200);
    expect((single.body as SupplierUploadResult).covered_count).toBe(1);

    const view = (await get(token)).body as SupplierRequestView;
    expect(view.items[1].received_count).toBe(2);
    expect(view.items[0].received_count).toBe(1);
    expect(view.history).toHaveLength(2);
    expect(view.history[0].file_name).toBe('fix.pdf');
    expect(view.history[0].covered_items).toEqual(['B']);
    expect(view.history[1].covered_items).toEqual(['A', 'B', 'C']);
  });

  it('refuses a file claimed against nothing', async () => {
    const { token } = await makeRequest(['A']);
    const res = await upload(token, []);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('which item');
  });

  it('takes an iPhone HEIC with no usable mime type', async () => {
    const { token, lineIds } = await makeRequest(['A']);
    const refs = await refsFor(token, lineIds);
    const res = await upload(token, refs, {
      name: 'IMG_4471.HEIC',
      type: 'application/octet-stream',
    });
    expect(res.status).toBe(200);
  });

  it('refuses a type it cannot read, and a file that is too big', async () => {
    const { token, lineIds } = await makeRequest(['A']);
    const refs = await refsFor(token, lineIds);
    expect((await upload(token, refs, { name: 'x.zip', type: 'application/zip' })).status).toBe(415);
    expect(
      (await upload(token, refs, { bytes: 26 * 1024 * 1024 })).status,
    ).toBe(413);
  });

  it('refuses uploads through an expired, revoked or closed link', async () => {
    const { token: revoked } = await makeRequest(['A']);
    await db
      .prepare("UPDATE request_links SET revoked_at = datetime('now') WHERE token = ?")
      .bind(revoked)
      .run();
    expect((await upload(revoked, ['anything'])).status).toBe(404);

    const { token: closed, requestId, lineIds } = await makeRequest(['A']);
    const refs = await refsFor(closed, lineIds);
    await db
      .prepare("UPDATE document_requests SET status = 'closed' WHERE id = ?")
      .bind(requestId)
      .run();
    // A closed ask stays READABLE but stops taking files, and says which of the
    // two it is rather than 404ing a page the supplier can still see.
    const res = await upload(closed, refs);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('closed');
  });

  it('keeps a closed ask readable so the supplier keeps their record', async () => {
    const { token, requestId, lineIds } = await makeRequest(['A', 'B']);
    await upload(token, await refsFor(token, lineIds), { name: 'final-pack.pdf' });
    await db
      .prepare("UPDATE request_lines SET status = 'accepted' WHERE request_id = ?")
      .bind(requestId)
      .run();
    await db
      .prepare("UPDATE document_requests SET status = 'closed' WHERE id = ?")
      .bind(requestId)
      .run();

    const { status, body } = await get(token);
    expect(status).toBe(200);
    const view = body as SupplierRequestView;
    expect(view.complete).toBe(true);
    expect(view.accepting_uploads).toBe(false);
    // The whole point: what they sent is still there.
    expect(view.history).toHaveLength(1);
    expect(view.history[0].file_name).toBe('final-pack.pdf');
    expect(view.history[0].covered_items).toEqual(['A', 'B']);
  });

  it('rate limits, per link and per IP', async () => {
    const { token, lineIds } = await makeRequest(['A']);
    const refs = await refsFor(token, lineIds);
    let limited = false;
    for (let i = 0; i < 45; i += 1) {
      const res = await upload(token, refs, { name: `f${i}.pdf` });
      if (res.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });

  it('rate limits reads too', async () => {
    const { token } = await makeRequest(['A']);
    let limited = false;
    for (let i = 0; i < 65; i += 1) {
      if ((await get(token)).status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });

  it('writes an audit row for the view and for the upload', async () => {
    const { token, lineIds } = await makeRequest(['A']);
    await get(token);
    await upload(token, await refsFor(token, lineIds));

    const view = await db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'request_link.view'")
      .first<{ n: number }>();
    const up = await db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'request_link.upload'")
      .first<{ n: number }>();
    expect(Number(view?.n ?? 0)).toBeGreaterThan(0);
    expect(Number(up?.n ?? 0)).toBeGreaterThan(0);
  });

  it('does not turn an arrival into a document', async () => {
    const { token, lineIds } = await makeRequest(['A']);
    await upload(token, await refsFor(token, lineIds));
    const row = await db
      .prepare('SELECT document_id FROM request_uploads ORDER BY rowid DESC LIMIT 1')
      .first<{ document_id: string | null }>();
    expect(row?.document_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('the progress number counts satisfied items, not files', () => {
  it('does not move when a supplier uploads', async () => {
    const { token, lineIds } = await makeRequest(['A', 'B', 'C', 'D']);
    const refs = await refsFor(token, lineIds);

    const before = (await get(token)).body as SupplierRequestView;
    expect(before.progress).toEqual({
      required_total: 4,
      required_satisfied: 0,
      recommended_total: 0,
      recommended_satisfied: 0,
    });

    // Ten files against every item. The flattering number would now be 10.
    for (let i = 0; i < 10; i += 1) await upload(token, refs, { name: `f${i}.pdf` });

    const after = (await get(token)).body as SupplierRequestView;
    expect(after.progress.required_satisfied).toBe(0);
    expect(after.history).toHaveLength(10);
    expect(after.complete).toBe(false);
  });

  it('moves only when a reviewer accepts, and counts required items only', async () => {
    const { token, lineIds } = await makeRequest(['A', 'B', 'C'], {
      tiers: ['required', 'required', 'recommended'],
    });
    await db
      .prepare("UPDATE request_lines SET status = 'accepted' WHERE id = ?")
      .bind(lineIds[0])
      .run();
    await db
      .prepare("UPDATE request_lines SET status = 'under_review' WHERE id = ?")
      .bind(lineIds[1])
      .run();

    const view = (await get(token)).body as SupplierRequestView;
    expect(view.progress).toEqual({
      required_total: 2,
      required_satisfied: 1,
      recommended_total: 1,
      recommended_satisfied: 0,
    });
    expect(view.complete).toBe(false);
  });

  it('reports complete when every REQUIRED item is accepted', async () => {
    const { token, lineIds } = await makeRequest(['A', 'B'], {
      tiers: ['required', 'recommended'],
    });
    await db
      .prepare("UPDATE request_lines SET status = 'accepted' WHERE id = ?")
      .bind(lineIds[0])
      .run();

    const view = (await get(token)).body as SupplierRequestView;
    expect(view.complete).toBe(true);
    // The page stays open and their history stays visible after completion.
    expect(view.accepting_uploads).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('needs_attention is always actionable', () => {
  it("shows the reviewer's own sentence when one was written", async () => {
    const { token, lineIds } = await makeRequest(['Kosher Certificate']);
    await db
      .prepare(
        `UPDATE request_lines
            SET status = 'needs_attention',
                attention_reason = 'The certificate expired in March. Send the one valid through 2027.'
          WHERE id = ?`,
      )
      .bind(lineIds[0])
      .run();

    const view = (await get(token)).body as SupplierRequestView;
    expect(view.items[0].attention_reason).toContain('expired in March');
    expect(view.items[0].attention_reason).toContain('valid through 2027');
  });

  it('never renders the bare word "rejected" when no reason was written', async () => {
    const { token, lineIds } = await makeRequest(['Allergen Statement']);
    await db
      .prepare("UPDATE request_lines SET status = 'needs_attention' WHERE id = ?")
      .bind(lineIds[0])
      .run();

    const view = (await get(token)).body as SupplierRequestView;
    const reason = view.items[0].attention_reason;
    expect(reason).toBeTruthy();
    expect(reason!.toLowerCase()).not.toBe('rejected');
    // It restates what the replacement must contain, from the item's own criteria.
    expect(reason).toContain('Signed, dated within 12 months');
    expect(reason).toContain('PDF or a clear photo');
    expect(JSON.stringify(view)).not.toContain(INTERNAL_NOTE);
  });

  it('is null for every other state', async () => {
    const { token } = await makeRequest(['A']);
    const view = (await get(token)).body as SupplierRequestView;
    expect(view.items[0].status).toBe('not_started');
    expect(view.items[0].attention_reason).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('the link survives an amendment and expires deliberately', () => {
  it('follows the ask to its new version instead of dead-linking', async () => {
    const { token, requestId, rootId } = await makeRequest(['Original item']);
    const v1 = (await get(token)).body as SupplierRequestView;
    expect(v1.items[0].name).toBe('Original item');
    expect(v1.amended).toBe(false);

    // Amend: v1 superseded, v2 issued under the SAME root.
    const v2Id = generateTestId();
    await db
      .prepare("UPDATE document_requests SET superseded_at = datetime('now') WHERE id = ?")
      .bind(requestId)
      .run();
    await db
      .prepare(
        `INSERT INTO document_requests
           (id, tenant_id, supplier_id, root_request_id, version, supersedes_id, title,
            due_date, status, issued_at, created_by)
         VALUES (?, ?, ?, ?, 2, ?, 'Annual supplier documentation', '2027-01-15', 'issued',
                 datetime('now'), ?)`,
      )
      .bind(v2Id, seed.tenantId, supplierId, rootId, requestId, seed.orgAdminId)
      .run();
    await db
      .prepare(
        `INSERT INTO request_lines
           (id, tenant_id, request_id, line_kind, requirement_id, name, tier, status, sort_order)
         VALUES (?, ?, ?, 'requirement', ?, 'Revised item', 'required', 'not_started', 0)`,
      )
      .bind(generateTestId(), seed.tenantId, v2Id, requirementIds[0])
      .run();

    // Same URL, still works, now showing the current version.
    const { status, body } = await get(token);
    expect(status).toBe(200);
    const v2 = body as SupplierRequestView;
    expect(v2.items[0].name).toBe('Revised item');
    expect(v2.amended).toBe(true);
    expect(v2.due_date).toBe('2027-01-15');
  });

  it('keeps the received count across an amendment', async () => {
    const { token, requestId, rootId, lineIds } = await makeRequest(['Carried item']);
    await upload(token, await refsFor(token, lineIds));

    const v2Id = generateTestId();
    await db
      .prepare("UPDATE document_requests SET superseded_at = datetime('now') WHERE id = ?")
      .bind(requestId)
      .run();
    await db
      .prepare(
        `INSERT INTO document_requests
           (id, tenant_id, supplier_id, root_request_id, version, title, status, issued_at, created_by)
         VALUES (?, ?, ?, ?, 2, 'Annual supplier documentation', 'issued', datetime('now'), ?)`,
      )
      .bind(v2Id, seed.tenantId, supplierId, rootId, seed.orgAdminId)
      .run();
    await db
      .prepare(
        `INSERT INTO request_lines
           (id, tenant_id, request_id, line_kind, requirement_id, name, tier, status, sort_order)
         VALUES (?, ?, ?, 'requirement', ?, 'Carried item', 'required', 'received', 0)`,
      )
      .bind(generateTestId(), seed.tenantId, v2Id, requirementIds[0])
      .run();

    const view = (await get(token)).body as SupplierRequestView;
    // Same requirement, new row: the count follows the item, not the row id.
    expect(view.items[0].received_count).toBe(1);
    expect(view.history).toHaveLength(1);
  });

  it('derives its lifetime from the deadline, floored and capped', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const day = 86_400_000;

    // No deadline -> the floor.
    const none = new Date(computeRequestLinkExpiry(null, now)).getTime();
    expect(Math.round((none - now.getTime()) / day)).toBe(REQUEST_LINK_MIN_TTL_DAYS);

    // A near deadline still gets the floor, never less.
    const near = new Date(computeRequestLinkExpiry('2026-01-20', now)).getTime();
    expect(Math.round((near - now.getTime()) / day)).toBe(REQUEST_LINK_MIN_TTL_DAYS);

    // A far deadline gets due + grace.
    const far = new Date(computeRequestLinkExpiry('2026-09-01', now)).getTime();
    expect(Math.round((far - now.getTime()) / day)).toBe(243 + 60);

    // An absurd deadline is capped.
    const capped = new Date(computeRequestLinkExpiry('2099-01-01', now)).getTime();
    expect(Math.round((capped - now.getTime()) / day)).toBe(400);

    // And nothing is ever unbounded.
    expect(capped).toBeLessThan(now.getTime() + 401 * day);
  });
});

// ---------------------------------------------------------------------------

describe('a link cannot reach another supplier', () => {
  it('resolves nothing when the ask moves to a different supplier', async () => {
    const { token, requestId } = await makeRequest(['A']);
    expect((await get(token)).status).toBe(200);

    // The second fence: supplier_id is re-checked against the link.
    await db
      .prepare('UPDATE document_requests SET supplier_id = ? WHERE id = ?')
      .bind(otherSupplierId, requestId)
      .run();
    expect((await get(token)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------

describe('the route is actually public', () => {
  // Runs the REAL auth middleware rather than a re-declared copy of its list.
  // A missing allowlist entry shows up as a 401 on the supplier's first tap,
  // which is a silent, total failure of the feature — so it gets a test.
  async function throughMiddleware(
    path: string,
    method = 'GET',
  ): Promise<{ status: number; reached: boolean }> {
    const auth = middleware[1];
    let reached = false;
    const c = {
      request: new Request(`http://localhost${path}`, { method }),
      env,
      data: {},
      params: {},
      waitUntil: () => {},
      passThroughOnException: () => {},
      next: async () => {
        reached = true;
        return new Response('handler', { status: 200 });
      },
      functionPath: path,
    } as never;
    const resp = await auth(c);
    return { status: resp.status, reached };
  }

  it('lets an unauthenticated read past the JWT gate', async () => {
    const r = await throughMiddleware('/api/supplier-requests/public/whatever-token');
    expect(r.reached).toBe(true);
    expect(r.status).toBe(200);
  });

  it('lets an unauthenticated upload past the JWT gate', async () => {
    const r = await throughMiddleware(
      '/api/supplier-requests/public/whatever-token/upload',
      'POST',
    );
    expect(r.reached).toBe(true);
  });

  it('still gates every sibling under /api/supplier-requests', async () => {
    // The prefix is deliberately narrow, so a future admin endpoint here is
    // not allowlisted by accident.
    const r = await throughMiddleware('/api/supplier-requests');
    expect(r.reached).toBe(false);
    expect(r.status).toBe(401);
  });

  it('still gates the internal preview and the link-rotation route', async () => {
    for (const p of [
      '/api/document-requests/abc/external',
      '/api/document-requests/abc/link',
    ]) {
      const r = await throughMiddleware(p);
      expect(r.reached).toBe(false);
      expect(r.status).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------

describe('the two note columns have two audiences', () => {
  it('lets a reviewer set the supplier-facing reason on an ISSUED ask', async () => {
    const { token, lineIds } = await makeRequest(['Kosher Certificate']);
    const lineId = lineIds[0];

    const resp = await linePut(lineId, {
      status: 'needs_attention',
      status_note: INTERNAL_NOTE,
      attention_reason: 'The certificate expired in March. Send one valid through 2027.',
    });
    expect(resp.status).toBe(200);

    const view = (await get(token)).body as SupplierRequestView;
    expect(view.items[0].status).toBe('needs_attention');
    expect(view.items[0].attention_reason).toContain('valid through 2027');
    // The internal note was written at the same moment and still does not leave.
    expect(JSON.stringify(view)).not.toContain(INTERNAL_NOTE);
  });
});
