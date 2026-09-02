/**
 * Integration tests for the request composer (migration 0090).
 *
 * The client called the composer "the primitive" — every checklist source is a
 * feeder into it. So the things asserted here are the ones that would quietly
 * stop being true first:
 *
 *   * a line resolves to a requirement by DEFAULT, and free text has to be
 *     asked for by name;
 *   * an amendment after issue produces a NEW version and leaves the original
 *     packet byte-for-byte intact;
 *   * a re-issue is a NEW ask, not an amendment;
 *   * exactly one routing record per issue event, and it never crosses to the
 *     external projection;
 *   * everything is tenant-scoped and role-gated.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import {
  onRequestGet as listGet,
  onRequestPost as composePost,
} from '../../functions/api/document-requests/index';
import {
  onRequestGet as detailGet,
  onRequestPut as detailPut,
  onRequestDelete as detailDelete,
} from '../../functions/api/document-requests/[id]';
import { onRequestPost as issuePost } from '../../functions/api/document-requests/[id]/issue';
import { onRequestPost as amendPost } from '../../functions/api/document-requests/[id]/amend';
import { onRequestPost as reissuePost } from '../../functions/api/document-requests/[id]/reissue';
import { onRequestGet as externalGet } from '../../functions/api/document-requests/[id]/external';
import {
  onRequestGet as linesGet,
  onRequestPost as linesPost,
} from '../../functions/api/document-requests/[id]/lines';
import {
  onRequestPut as linePut,
  onRequestDelete as lineDelete,
} from '../../functions/api/request-lines/[id]';
import {
  onRequestGet as templatesGet,
  onRequestPost as templatePost,
} from '../../functions/api/request-templates/index';
import { onRequestPost as instantiatePost } from '../../functions/api/request-templates/[id]/instantiate';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

type Actor = { id: string; role: string; tenant_id: string | null };
let admin: Actor;
let worker: Actor;
let reader: Actor;
let otherAdmin: Actor;

let supplierA: string;
let supplierB: string;
let reqAllergen: string;
let reqNutrition: string;
let reqOrganic: string;
let reqRetired: string;
let foreignSupplier: string;
let foreignRequirement: string;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function makeSupplier(tenantId: string, name: string): Promise<string> {
  const id = `sup-${generateTestId()}`;
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(id, tenantId, name, `${name.toLowerCase().replace(/\W+/g, '-')}-${generateTestId()}`)
    .run();
  return id;
}

async function makeRequirement(tenantId: string, name: string, active = 1): Promise<string> {
  const id = `req-${generateTestId()}`;
  await db
    .prepare(
      'INSERT INTO requirements (id, tenant_id, slug, name, active) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(id, tenantId, `${name.toLowerCase().replace(/\W+/g, '-')}-${generateTestId()}`, name, active)
    .run();
  return id;
}

/** A confirmed document_requirements link — the existing satisfaction record. */
async function makeSatisfyingDocument(
  tenantId: string,
  supplierId: string,
  requirementId: string,
  title: string,
): Promise<string> {
  const docId = `doc-${generateTestId()}`;
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, supplier_id, title, status, created_by)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    )
    .bind(docId, tenantId, supplierId, title, seed.orgAdminId)
    .run();
  await db
    .prepare(
      `INSERT INTO document_requirements
         (id, document_id, requirement_id, status, confirmed_at, confirmed_by)
       VALUES (?, ?, ?, 'confirmed', datetime('now'), ?)`,
    )
    .bind(`dr-${generateTestId()}`, docId, requirementId, seed.orgAdminId)
    .run();
  return docId;
}

// ---------------------------------------------------------------------------
// Call helpers
// ---------------------------------------------------------------------------

async function call(
  fn: PagesFunction<any>,
  url: string,
  opts: { method?: string; body?: unknown; params?: Record<string, string>; as?: Actor } = {},
) {
  const init: RequestInit = { method: opts.method ?? 'GET' };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  const res = await fn({
    request: new Request(`http://localhost${url}`, init),
    env,
    data: { user: opts.as ?? admin },
    params: opts.params ?? {},
  } as any);
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

const compose = (body: unknown, as?: Actor) =>
  call(composePost, '/api/document-requests', { method: 'POST', body, as });

const detail = (id: string, as?: Actor) =>
  call(detailGet, `/api/document-requests/${id}`, { params: { id }, as });

const issue = (id: string, body: unknown = {}, as?: Actor) =>
  call(issuePost, `/api/document-requests/${id}/issue`, {
    method: 'POST',
    body,
    params: { id },
    as,
  });

const amend = (id: string, body: unknown, as?: Actor) =>
  call(amendPost, `/api/document-requests/${id}/amend`, {
    method: 'POST',
    body,
    params: { id },
    as,
  });

const reissue = (id: string, body: unknown = {}, as?: Actor) =>
  call(reissuePost, `/api/document-requests/${id}/reissue`, {
    method: 'POST',
    body,
    params: { id },
    as,
  });

const external = (id: string, as?: Actor) =>
  call(externalGet, `/api/document-requests/${id}/external`, { params: { id }, as });

const setLine = (id: string, body: unknown, as?: Actor) =>
  call(linePut, `/api/request-lines/${id}`, { method: 'PUT', body, params: { id }, as });

/** Compose one two-line typed draft and return its id. */
async function composeStandard(supplier = supplierA): Promise<string> {
  const { status, body } = await compose({
    supplier_id: supplier,
    title: 'Onboarding packet',
    intro: 'Please return the following.',
    due_date: '2026-12-01',
    assigned_to: seed.orgAdminId,
    lines: [
      { requirement_id: reqAllergen, explanation: 'Needed for the label review.' },
      { requirement_id: reqNutrition, tier: 'recommended' },
    ],
  });
  expect(status).toBe(201);
  return body.request.id as string;
}

beforeAll(async () => {
  seed = await seedTestData(db);
  admin = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
  worker = { id: seed.userId, role: 'user', tenant_id: seed.tenantId };
  reader = { id: seed.readerId, role: 'reader', tenant_id: seed.tenantId };
  otherAdmin = { id: seed.orgAdmin2Id, role: 'org_admin', tenant_id: seed.tenantId2 };

  supplierA = await makeSupplier(seed.tenantId, 'Alpha Dairy');
  supplierB = await makeSupplier(seed.tenantId, 'Beta Foods');
  reqAllergen = await makeRequirement(seed.tenantId, 'Allergen Matrix');
  reqNutrition = await makeRequirement(seed.tenantId, '100g Nutritionals');
  reqOrganic = await makeRequirement(seed.tenantId, 'Organic Certificate');
  reqRetired = await makeRequirement(seed.tenantId, 'Retired Line Item', 0);

  foreignSupplier = await makeSupplier(seed.tenantId2, 'Other Corp Supplier');
  foreignRequirement = await makeRequirement(seed.tenantId2, 'Other Corp Line Item');
}, 30_000);

beforeEach(async () => {
  await db.prepare('DELETE FROM request_routing').run();
  await db.prepare('DELETE FROM request_lines').run();
  await db.prepare('DELETE FROM document_requests').run();
  await db.prepare('DELETE FROM request_template_lines').run();
  await db.prepare('DELETE FROM request_templates').run();
  await db.prepare('DELETE FROM document_requirements').run();
  await db.prepare('DELETE FROM documents').run();
});

// ===========================================================================
// Composing
// ===========================================================================

describe('POST /api/document-requests — compose', () => {
  it('composes a DRAFT, never an issued request', async () => {
    const id = await composeStandard();
    const { body } = await detail(id);
    expect(body.request.status).toBe('draft');
    expect(body.request.issued_at).toBeNull();
    expect(body.request.routing).toBeNull();
    expect(body.request.version).toBe(1);
    // A first version is its own root, so the chain always has an anchor.
    expect(body.request.root_request_id).toBe(id);
  });

  it('a line resolves to a requirement by default, and inherits its name', async () => {
    const id = await composeStandard();
    const { body } = await detail(id);
    const line = body.request.lines.find((l: any) => l.requirement_id === reqAllergen);
    expect(line.line_kind).toBe('requirement');
    expect(line.name).toBe('Allergen Matrix');
    expect(line.status).toBe('not_started');
  });

  it('REFUSES an untyped line rather than silently creating one', async () => {
    const { status, body } = await compose({
      supplier_id: supplierA,
      title: 'Sloppy packet',
      lines: [{ name: 'Just send us the thing' }],
    });
    expect(status).toBe(400);
    // The error has to name the escape hatch, or a caller cannot discover it.
    expect(String(body.error)).toMatch(/requirement_id/);
    expect(String(body.error)).toMatch(/free_text/);
  });

  it('accepts a free-text line ONLY when it is asked for by name', async () => {
    const { status, body } = await compose({
      supplier_id: supplierA,
      title: 'Edge case packet',
      lines: [
        { requirement_id: reqAllergen },
        {
          line_kind: 'free_text',
          name: 'Signed side-letter about the 2026 packaging change',
          explanation: 'The taxonomy has nothing for this yet.',
        },
      ],
    });
    expect(status).toBe(201);
    const kinds = body.request.lines.map((l: any) => l.line_kind).sort();
    expect(kinds).toEqual(['free_text', 'requirement']);
    // The exception is COUNTED, so a reviewer sees how much of the packet the
    // registry cannot reason about without scanning for it.
    expect(body.request.counts.free_text).toBe(1);
    expect(body.request.counts.typed).toBe(1);
  });

  it('refuses a line that claims to be both typed and free text', async () => {
    const { status, body } = await compose({
      supplier_id: supplierA,
      title: 'Confused packet',
      lines: [{ line_kind: 'free_text', requirement_id: reqAllergen, name: 'Both' }],
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/must not carry a requirement_id/);
  });

  it('the DB itself refuses a half-declared line', async () => {
    // The API gate above is the readable one; this asserts the CHECK is really
    // in the schema, independently of the API.
    const id = await composeStandard();
    await expect(
      db
        .prepare(
          `INSERT INTO request_lines (id, tenant_id, request_id, line_kind, requirement_id, name)
           VALUES (?, ?, ?, 'requirement', NULL, 'Untyped but claiming otherwise')`,
        )
        .bind(`rl-${generateTestId()}`, seed.tenantId, id)
        .run(),
    ).rejects.toThrow();
  });

  it('refuses a retired requirement', async () => {
    const { status, body } = await compose({
      supplier_id: supplierA,
      title: 'Stale packet',
      lines: [{ requirement_id: reqRetired }],
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/inactive/);
  });

  it('refuses the same requirement twice in one packet', async () => {
    const { status, body } = await compose({
      supplier_id: supplierA,
      title: 'Duplicated packet',
      lines: [{ requirement_id: reqAllergen }, { requirement_id: reqAllergen }],
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/more than once/);
  });

  it('the DB itself refuses a duplicate typed line, and allows duplicate free-text ones', async () => {
    // The partial unique index is `WHERE requirement_id IS NOT NULL`: typed
    // lines are constrained, free-text lines are exempted by a stated
    // predicate rather than by SQLite's NULL-distinct behaviour. Both halves
    // are asserted, because both are deliberate.
    const id = await composeStandard();

    await expect(
      db
        .prepare(
          `INSERT INTO request_lines (id, tenant_id, request_id, line_kind, requirement_id, name)
           VALUES (?, ?, ?, 'requirement', ?, 'Allergen Matrix again')`,
        )
        .bind(`rl-${generateTestId()}`, seed.tenantId, id, reqAllergen)
        .run(),
    ).rejects.toThrow();

    for (const label of ['Side letter A', 'Side letter B']) {
      await db
        .prepare(
          `INSERT INTO request_lines (id, tenant_id, request_id, line_kind, requirement_id, name)
           VALUES (?, ?, ?, 'free_text', NULL, ?)`,
        )
        .bind(`rl-${generateTestId()}`, seed.tenantId, id, label)
        .run();
    }
    const n = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM request_lines WHERE request_id = ? AND line_kind = 'free_text'`,
      )
      .bind(id)
      .first<{ n: number }>();
    expect(n?.n).toBe(2);
  });

  it('carries the tier per line and counts both tiers', async () => {
    const id = await composeStandard();
    const { body } = await detail(id);
    expect(body.request.counts.required).toBe(1);
    expect(body.request.counts.recommended).toBe(1);
    const rec = body.request.lines.find((l: any) => l.requirement_id === reqNutrition);
    expect(rec.tier).toBe('recommended');
  });

  it('rejects an unknown tier', async () => {
    const { status, body } = await compose({
      supplier_id: supplierA,
      title: 'Bad tier',
      lines: [{ requirement_id: reqAllergen, tier: 'nice_to_have' }],
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/required, recommended/);
  });
});

// ===========================================================================
// Issue
// ===========================================================================

describe('POST /api/document-requests/:id/issue — the one issue path', () => {
  it('issues, stamps issued_at, and creates EXACTLY ONE routing record', async () => {
    const id = await composeStandard();
    const { status, body } = await issue(id, { recipient: 'qa@alpha.example', channel: 'email' });
    expect(status).toBe(200);
    expect(body.request.status).toBe('issued');
    expect(body.request.issued_at).toBeTruthy();

    const routing = await db
      .prepare('SELECT * FROM request_routing WHERE request_id = ?')
      .bind(id)
      .all<any>();
    expect(routing.results.length).toBe(1);
    expect(routing.results[0].issued_by).toBe(seed.orgAdminId);
    expect(routing.results[0].channel).toBe('email');
    expect(routing.results[0].version).toBe(1);
  });

  it('writes one audit row for the issue event', async () => {
    const id = await composeStandard();
    await issue(id);
    const rows = await db
      .prepare(
        `SELECT * FROM audit_log
          WHERE resource_id = ? AND action = 'document_request_issued'`,
      )
      .bind(id)
      .all<any>();
    expect(rows.results.length).toBe(1);
    expect(rows.results[0].resource_type).toBe('document_request');
  });

  it('refuses to issue twice — one routing record per issue event', async () => {
    const id = await composeStandard();
    expect((await issue(id)).status).toBe(200);
    const again = await issue(id);
    expect(again.status).toBe(400);
    expect(String(again.body.error)).toMatch(/amend/i);

    const routing = await db
      .prepare('SELECT COUNT(*) AS n FROM request_routing WHERE request_id = ?')
      .bind(id)
      .first<{ n: number }>();
    expect(routing?.n).toBe(1);
  });

  it('refuses to issue an empty packet', async () => {
    const { body } = await compose({
      supplier_id: supplierA,
      title: 'Nothing asked for',
      lines: [],
    });
    const { status, body: err } = await issue(body.request.id);
    expect(status).toBe(400);
    expect(String(err.error)).toMatch(/at least one line/);
  });

  it('an issued request cannot be edited in place', async () => {
    const id = await composeStandard();
    await issue(id);
    const { status, body } = await call(detailPut, `/api/document-requests/${id}`, {
      method: 'PUT',
      body: { title: 'Quietly different' },
      params: { id },
    });
    expect(status).toBe(409);
    expect(String(body.error)).toMatch(/amend/);
  });

  it('a line cannot be added to an issued packet', async () => {
    const id = await composeStandard();
    await issue(id);
    const { status } = await call(linesPost, `/api/document-requests/${id}/lines`, {
      method: 'POST',
      body: { lines: [{ requirement_id: reqOrganic }] },
      params: { id },
    });
    expect(status).toBe(409);
  });

  it('a line cannot be removed from an issued packet', async () => {
    const id = await composeStandard();
    const before = await detail(id);
    const lineId = before.body.request.lines[0].id;
    await issue(id);
    const { status } = await call(lineDelete, `/api/request-lines/${lineId}`, {
      method: 'DELETE',
      params: { id: lineId },
    });
    expect(status).toBe(409);
  });
});

// ===========================================================================
// Amendment — the audit-trail rule
// ===========================================================================

describe('POST /api/document-requests/:id/amend — versioned, never overwritten', () => {
  it('preserves the ORIGINAL packet byte-for-byte and creates a new version', async () => {
    const id = await composeStandard();
    await issue(id);
    const before = await detail(id);
    const originalTitle = before.body.request.title;
    const originalDue = before.body.request.due_date;
    const originalLineNames = before.body.request.lines.map((l: any) => l.name).sort();

    const { status, body } = await amend(id, {
      amendment_reason: 'Buyer moved the deadline and added the organic certificate',
      title: 'Onboarding packet (revised)',
      due_date: '2027-01-15',
      lines: [
        { requirement_id: reqAllergen },
        { requirement_id: reqNutrition, tier: 'recommended' },
        { requirement_id: reqOrganic },
      ],
    });
    expect(status).toBe(201);
    const newId = body.request.id;
    expect(newId).not.toBe(id);
    expect(body.supersedes_id).toBe(id);

    // The ORIGINAL is untouched apart from the supersession marker.
    const originalAfter = await detail(id);
    expect(originalAfter.body.request.title).toBe(originalTitle);
    expect(originalAfter.body.request.due_date).toBe(originalDue);
    expect(originalAfter.body.request.lines.map((l: any) => l.name).sort()).toEqual(
      originalLineNames,
    );
    // Its status stays 'issued', because it WAS issued. Supersession is chain
    // metadata, not a restatement of the ask.
    expect(originalAfter.body.request.status).toBe('issued');
    expect(originalAfter.body.request.superseded_at).toBeTruthy();

    // The amendment is version 2 on the SAME root.
    expect(body.request.version).toBe(2);
    expect(body.request.root_request_id).toBe(id);
    expect(body.request.supersedes_id).toBe(id);
    expect(body.request.superseded_at).toBeNull();
    expect(body.request.status).toBe('issued');
    expect(body.request.counts.total).toBe(3);
    expect(body.request.amendment_reason).toMatch(/deadline/);
  });

  it('gives the amendment its own routing record, linked to the one it amends', async () => {
    const id = await composeStandard();
    await issue(id);
    const { body } = await amend(id, { amendment_reason: 'Corrected the due date' });

    const rows = await db
      .prepare(
        `SELECT * FROM request_routing WHERE request_id IN (?, ?) ORDER BY version`,
      )
      .bind(id, body.request.id)
      .all<any>();
    expect(rows.results.length).toBe(2);
    expect(rows.results[1].version).toBe(2);
    expect(rows.results[1].amendment_of_routing_id).toBe(rows.results[0].id);
  });

  it('carries per-line progress forward so a buyer is not told to re-chase', async () => {
    const id = await composeStandard();
    await issue(id);
    const before = await detail(id);
    const allergenLine = before.body.request.lines.find(
      (l: any) => l.requirement_id === reqAllergen,
    );
    await setLine(allergenLine.id, { status: 'under_review' });

    const { body } = await amend(id, {
      amendment_reason: 'Added the organic certificate',
      lines: [
        { requirement_id: reqAllergen },
        { requirement_id: reqNutrition, tier: 'recommended' },
        { requirement_id: reqOrganic },
      ],
    });

    const byReq = Object.fromEntries(
      body.request.lines.map((l: any) => [l.requirement_id, l.status]),
    );
    expect(byReq[reqAllergen]).toBe('under_review');
    // A line that is new in the amendment starts fresh.
    expect(byReq[reqOrganic]).toBe('not_started');
  });

  it('keeps the previous composition verbatim when no lines are supplied', async () => {
    const id = await composeStandard();
    await issue(id);
    const { body } = await amend(id, { amendment_reason: 'Deadline slipped', due_date: '2027-03-01' });
    expect(body.request.counts.total).toBe(2);
    expect(body.request.due_date).toBe('2027-03-01');
  });

  it('requires a stated reason — an amendment with none is an untraceable rewrite', async () => {
    const id = await composeStandard();
    await issue(id);
    const { status, body } = await amend(id, { title: 'Silently different' });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/amendment_reason/);
  });

  it('refuses to amend a DRAFT — versioning begins at issue', async () => {
    const id = await composeStandard();
    const { status, body } = await amend(id, { amendment_reason: 'Too early' });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/edited in place/);
  });

  it('refuses to amend an already-superseded version', async () => {
    const id = await composeStandard();
    await issue(id);
    await amend(id, { amendment_reason: 'First amendment' });
    const second = await amend(id, { amendment_reason: 'Amending stale history' });
    expect(second.status).toBe(400);
    expect(String(second.body.error)).toMatch(/already been amended/);
  });

  it('the DB permits exactly one LIVE version per ask', async () => {
    // The partial unique index `(root_request_id) WHERE superseded_at IS NULL`
    // is what makes "the current version" a lookup rather than a sort, and
    // what stops two concurrent amendments from both landing.
    const id = await composeStandard();
    await issue(id);
    await amend(id, { amendment_reason: 'v2' });

    await expect(
      db
        .prepare(
          `INSERT INTO document_requests
             (id, tenant_id, supplier_id, root_request_id, version, title, status)
           VALUES (?, ?, ?, ?, 99, 'A second live version', 'issued')`,
        )
        .bind(`dr-${generateTestId()}`, seed.tenantId, supplierA, id)
        .run(),
    ).rejects.toThrow();
  });

  it('exposes the whole chain as history, with exactly one current version', async () => {
    const id = await composeStandard();
    await issue(id);
    const v2 = await amend(id, { amendment_reason: 'v2' });
    const v3 = await amend(v2.body.request.id, { amendment_reason: 'v3' });

    const { body } = await detail(v3.body.request.id);
    expect(body.request.history.map((h: any) => h.version)).toEqual([1, 2, 3]);
    expect(body.request.history.filter((h: any) => h.is_current).length).toBe(1);
    expect(body.request.history.find((h: any) => h.is_current).version).toBe(3);
    // Every version's stated reason survives, so the chain explains itself.
    expect(body.request.history[1].amendment_reason).toBe('v2');
  });

  it('the default list shows the live version only, never both', async () => {
    const id = await composeStandard();
    await issue(id);
    await amend(id, { amendment_reason: 'v2' });

    const live = await call(listGet, '/api/document-requests');
    expect(live.body.requests.filter((r: any) => r.root_request_id === id).length).toBe(1);

    const all = await call(listGet, '/api/document-requests?include_superseded=1');
    expect(all.body.requests.filter((r: any) => r.root_request_id === id).length).toBe(2);
  });
});

// ===========================================================================
// Re-issue — a NEW ask, not an amendment
// ===========================================================================

describe('POST /api/document-requests/:id/reissue', () => {
  it('starts a NEW root at version 1 and keeps provenance', async () => {
    const id = await composeStandard();
    await issue(id);

    const { status, body } = await reissue(id, { title: '2027 renewal', due_date: '2027-06-01' });
    expect(status).toBe(201);
    expect(body.request.id).not.toBe(id);
    expect(body.request.root_request_id).toBe(body.request.id);
    expect(body.request.version).toBe(1);
    expect(body.request.reissue_of_request_id).toBe(id);
    expect(body.request.supersedes_id).toBeNull();
    // A renewal is still an ask a person should look at before it goes out.
    expect(body.request.status).toBe('draft');
    expect(body.request.title).toBe('2027 renewal');
  });

  it('leaves the source ask completely untouched', async () => {
    const id = await composeStandard();
    await issue(id);
    await reissue(id);
    const { body } = await detail(id);
    expect(body.request.superseded_at).toBeNull();
    expect(body.request.status).toBe('issued');
    expect(body.request.history.length).toBe(1);
  });

  it('resets line progress — last year’s certificate is not this year’s', async () => {
    const id = await composeStandard();
    await issue(id);
    const before = await detail(id);
    await setLine(before.body.request.lines[0].id, { status: 'accepted' });

    const { body } = await reissue(id);
    expect(body.request.lines.every((l: any) => l.status === 'not_started')).toBe(true);
  });

  it('can be pointed at a different, already-approved supplier', async () => {
    const id = await composeStandard(supplierA);
    await issue(id);
    const { body } = await reissue(id, { supplier_id: supplierB });
    expect(body.request.supplier_id).toBe(supplierB);
    expect(body.request.counts.total).toBe(2);
  });

  it('refuses a supplier from another tenant', async () => {
    const id = await composeStandard();
    await issue(id);
    const { status } = await reissue(id, { supplier_id: foreignSupplier });
    expect(status).toBe(400);
  });
});

// ===========================================================================
// Per-line status
// ===========================================================================

describe('PUT /api/request-lines/:id — the client’s five states', () => {
  let lineId: string;

  beforeEach(async () => {
    const id = await composeStandard();
    await issue(id);
    const { body } = await detail(id);
    lineId = body.request.lines[0].id;
  });

  it('walks the whole sequence and stamps every move', async () => {
    for (const status of ['received', 'under_review', 'accepted'] as const) {
      const res = await setLine(lineId, { status });
      expect(res.status).toBe(200);
      expect(res.body.line.status).toBe(status);
      expect(res.body.line.status_changed_at).toBeTruthy();
      expect(res.body.line.status_changed_by).toBe(seed.orgAdminId);
    }
  });

  it('allows accepted -> needs_attention, because a document can later be found deficient', async () => {
    await setLine(lineId, { status: 'accepted' });
    const res = await setLine(lineId, {
      status: 'needs_attention',
      status_note: 'Signature block is missing',
    });
    expect(res.status).toBe(200);
    expect(res.body.line.status).toBe('needs_attention');
    expect(res.body.line.status_note).toMatch(/Signature/);
  });

  it('rejects a status outside the five', async () => {
    const res = await setLine(lineId, { status: 'pending_vendor' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/not_started/);
  });

  it('the DB itself rejects a sixth state', async () => {
    await expect(
      db
        .prepare("UPDATE request_lines SET status = 'pending_vendor' WHERE id = ?")
        .bind(lineId)
        .run(),
    ).rejects.toThrow();
  });

  it('audits each status change with both endpoints of the move', async () => {
    await setLine(lineId, { status: 'received' });
    const rows = await db
      .prepare(
        `SELECT * FROM audit_log WHERE action = 'request_line_status_changed'
          ORDER BY id DESC LIMIT 1`,
      )
      .all<any>();
    const details = JSON.parse(rows.results[0].details);
    expect(details.from).toBe('not_started');
    expect(details.to).toBe('received');
    expect(details.line_id).toBe(lineId);
  });

  it('refuses to change WHAT was asked for after issue', async () => {
    const res = await setLine(lineId, { name: 'Something else entirely' });
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/Amend it/);
  });

  it('refuses to swap a line’s identity', async () => {
    const res = await setLine(lineId, { requirement_id: reqOrganic } as any);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/identity/);
  });
});

// ===========================================================================
// Satisfaction — the seam, deliberately read-only
// ===========================================================================

describe('closure — what document_requirements already says', () => {
  it('surfaces a confirmed link on the matching typed line', async () => {
    const id = await composeStandard();
    await issue(id);
    await makeSatisfyingDocument(
      seed.tenantId,
      supplierA,
      reqAllergen,
      'Alpha Dairy allergen matrix 2026',
    );

    const { body } = await detail(id);
    const line = body.request.lines.find((l: any) => l.requirement_id === reqAllergen);
    expect(line.closure.length).toBe(1);
    expect(line.closure[0].document_title).toMatch(/allergen matrix/i);

    const other = body.request.lines.find((l: any) => l.requirement_id === reqNutrition);
    expect(other.closure).toEqual([]);
  });

  it('does NOT move the line status — accepted stays a human verdict', async () => {
    const id = await composeStandard();
    await issue(id);
    await makeSatisfyingDocument(seed.tenantId, supplierA, reqAllergen, 'Allergen matrix');
    const { body } = await detail(id);
    const line = body.request.lines.find((l: any) => l.requirement_id === reqAllergen);
    expect(line.closure.length).toBe(1);
    expect(line.status).toBe('not_started');
  });

  it('ignores a SUGGESTED link — the pipeline does not close its own asks', async () => {
    const id = await composeStandard();
    await issue(id);
    const docId = `doc-${generateTestId()}`;
    await db
      .prepare(
        `INSERT INTO documents (id, tenant_id, supplier_id, title, status, created_by)
         VALUES (?, ?, ?, 'Machine guess', 'active', ?)`,
      )
      .bind(docId, seed.tenantId, supplierA, seed.orgAdminId)
      .run();
    await db
      .prepare(
        `INSERT INTO document_requirements (id, document_id, requirement_id, status)
         VALUES (?, ?, ?, 'suggested')`,
      )
      .bind(`dr-${generateTestId()}`, docId, reqAllergen)
      .run();

    const { body } = await detail(id);
    const line = body.request.lines.find((l: any) => l.requirement_id === reqAllergen);
    expect(line.closure).toEqual([]);
  });

  it('a document from ANOTHER supplier cannot close this supplier’s line', async () => {
    const id = await composeStandard(supplierA);
    await issue(id);
    await makeSatisfyingDocument(seed.tenantId, supplierB, reqAllergen, 'Beta Foods allergen matrix');
    const { body } = await detail(id);
    const line = body.request.lines.find((l: any) => l.requirement_id === reqAllergen);
    expect(line.closure).toEqual([]);
  });

  it('a free-text line can never have a closure — the cost of the escape hatch', async () => {
    const { body: composed } = await compose({
      supplier_id: supplierA,
      title: 'Mixed packet',
      lines: [
        { requirement_id: reqAllergen },
        { line_kind: 'free_text', name: 'Signed side-letter' },
      ],
    });
    await issue(composed.request.id);
    await makeSatisfyingDocument(seed.tenantId, supplierA, reqAllergen, 'Allergen matrix');

    const { body } = await call(
      linesGet,
      `/api/document-requests/${composed.request.id}/lines`,
      { params: { id: composed.request.id } },
    );
    const typed = body.lines.find((l: any) => l.line_kind === 'requirement');
    const free = body.lines.find((l: any) => l.line_kind === 'free_text');
    expect(typed.closure.length).toBe(1);
    expect(free.closure).toEqual([]);
  });
});

// ===========================================================================
// The external projection — an allow-list, not a filter
// ===========================================================================

describe('GET /api/document-requests/:id/external', () => {
  it('returns only the allow-listed fields, and no internal ones', async () => {
    const id = await composeStandard();
    await issue(id, { recipient: 'qa@alpha.example', internal_notes: 'Chase via Sam' });

    const { status, body } = await external(id);
    expect(status).toBe(200);

    // The exact outward contract. Adding a field to `buildSupplierRequestView`
    // fails here on purpose — that is the whole point of asserting the key set
    // rather than spot-checking a few of them.
    expect(Object.keys(body.view).sort()).toEqual(
      [
        'accepting_uploads',
        'amended',
        'complete',
        'due_date',
        'history',
        'intro',
        'issued_at',
        'items',
        'link_expires_at',
        'progress',
        'supplier_name',
        'title',
        'tenant_name',
      ].sort(),
    );
    expect(Object.keys(body.view.items[0]).sort()).toEqual(
      [
        'acceptable_formats',
        'also_covers',
        'attention_reason',
        'criteria',
        'explanation',
        'name',
        'received_count',
        'ref',
        'status',
        'tier',
      ].sort(),
    );

    // `status` is now shown DELIBERATELY — see the note on SupplierRequestItem.
    // A supplier who cannot tell "we have it" from "we are waiting on you"
    // phones to ask. What is still withheld is everything about how we JUDGED
    // it, which is the list below.
    expect(body.view.items[0].status).toBe('not_started');

    // The whole payload, serialized, must not contain anything internal.
    const serialized = JSON.stringify(body);
    for (const secret of [
      id,
      seed.tenantId,
      supplierA,
      reqAllergen,
      seed.orgAdminId,
      'Chase via Sam',
      'qa@alpha.example',
      'manual',
      'status_note',
      'internal_notes',
      'issued_by',
      'assigned_to',
      'line_kind',
      'origin_ref',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('marks an amendment as amended without saying why', async () => {
    const id = await composeStandard();
    await issue(id);
    const { body: amended } = await amend(id, {
      amendment_reason: 'We got the internal spec wrong',
    });
    const { body } = await external(amended.request.id);
    expect(body.view.amended).toBe(true);
    expect(JSON.stringify(body)).not.toContain('internal spec wrong');
  });

  it('projects nothing at all for a draft, a superseded version, or a cancelled ask', async () => {
    const draftId = await composeStandard();
    expect((await external(draftId)).status).toBe(409);

    await issue(draftId);
    await amend(draftId, { amendment_reason: 'v2' });
    const superseded = await external(draftId);
    expect(superseded.status).toBe(409);
    expect(String(superseded.body.error)).toMatch(/superseded/);

    const cancelId = await composeStandard(supplierB);
    await issue(cancelId);
    await call(detailDelete, `/api/document-requests/${cancelId}`, {
      method: 'DELETE',
      params: { id: cancelId },
    });
    expect((await external(cancelId)).status).toBe(409);
  });
});

// ===========================================================================
// Templates
// ===========================================================================

describe('/api/request-templates', () => {
  it('saves a composed set and instantiates it as an ordinary DRAFT', async () => {
    const created = await call(templatesGet, '/api/request-templates');
    expect(created.body.templates.length).toBe(0);

    const tpl = await call(templatePost, '/api/request-templates', {
      method: 'POST',
      body: {
        name: 'Standard onboarding',
        default_due_in_days: 30,
        lines: [{ requirement_id: reqAllergen }, { requirement_id: reqOrganic }],
      },
    });
    expect(tpl.status).toBe(201);
    expect(tpl.body.template.slug).toBe('standard-onboarding');
    expect(tpl.body.template.lines.length).toBe(2);

    const inst = await call(
      instantiatePost,
      `/api/request-templates/${tpl.body.template.id}/instantiate`,
      {
        method: 'POST',
        body: { supplier_id: supplierB },
        params: { id: tpl.body.template.id },
      },
    );
    expect(inst.status).toBe(201);
    // A feeder, not a shortcut: it lands as a draft and is issued through the
    // one issue path like everything else.
    expect(inst.body.request.status).toBe('draft');
    expect(inst.body.request.origin).toBe('template');
    expect(inst.body.request.origin_ref).toBe(tpl.body.template.id);
    expect(inst.body.request.counts.total).toBe(2);
    expect(inst.body.request.due_date).toBeTruthy();
    expect(inst.body.request.routing).toBeNull();
  });

  it('snapshots an existing request, and later template edits do not reach it', async () => {
    const id = await composeStandard();
    const tpl = await call(templatePost, '/api/request-templates', {
      method: 'POST',
      body: { name: 'Saved from a packet', from_request_id: id },
    });
    expect(tpl.status).toBe(201);
    expect(tpl.body.template.lines.length).toBe(2);

    // Instantiate, then confirm the instance stands on its own.
    const inst = await call(
      instantiatePost,
      `/api/request-templates/${tpl.body.template.id}/instantiate`,
      {
        method: 'POST',
        body: { supplier_id: supplierB },
        params: { id: tpl.body.template.id },
      },
    );
    await db
      .prepare('DELETE FROM request_template_lines WHERE template_id = ?')
      .bind(tpl.body.template.id)
      .run();
    const still = await detail(inst.body.request.id);
    expect(still.body.request.counts.total).toBe(2);
  });

  it('template lines obey the same typed-by-default rule', async () => {
    const bad = await call(templatePost, '/api/request-templates', {
      method: 'POST',
      body: { name: 'Sloppy template', lines: [{ name: 'Some paperwork' }] },
    });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/free_text/);
  });

  it('refuses a duplicate slug in one tenant', async () => {
    const body = { name: 'Onboarding', lines: [{ requirement_id: reqAllergen }] };
    expect((await call(templatePost, '/api/request-templates', { method: 'POST', body })).status).toBe(201);
    const again = await call(templatePost, '/api/request-templates', { method: 'POST', body });
    expect(again.status).toBe(409);
  });

  it('a template has no supplier, no status and no version chain — which is why it is its own table', async () => {
    const tpl = await call(templatePost, '/api/request-templates', {
      method: 'POST',
      body: { name: 'Shape check', lines: [{ requirement_id: reqAllergen }] },
    });
    const cols = Object.keys(tpl.body.template);
    for (const absent of ['supplier_id', 'status', 'issued_at', 'root_request_id', 'version']) {
      expect(cols).not.toContain(absent);
    }
    for (const absent of ['status', 'status_changed_at', 'request_id']) {
      expect(Object.keys(tpl.body.template.lines[0])).not.toContain(absent);
    }
  });
});

// ===========================================================================
// Tenant isolation + role gates
// ===========================================================================

describe('tenant isolation', () => {
  it('refuses a supplier from another tenant', async () => {
    const { status } = await compose({
      supplier_id: foreignSupplier,
      title: 'Cross-tenant packet',
      lines: [{ requirement_id: reqAllergen }],
    });
    expect(status).toBe(400);
  });

  it('refuses a requirement from another tenant', async () => {
    const { status, body } = await compose({
      supplier_id: supplierA,
      title: 'Cross-tenant line',
      lines: [{ requirement_id: foreignRequirement }],
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/unknown requirement/i);
  });

  it('another tenant’s admin cannot read, issue or amend the request', async () => {
    const id = await composeStandard();
    expect((await detail(id, otherAdmin)).status).toBe(404);
    expect((await issue(id, {}, otherAdmin)).status).toBe(404);
    expect((await amend(id, { amendment_reason: 'x' }, otherAdmin)).status).toBe(404);
    expect((await external(id, otherAdmin)).status).toBe(404);
  });

  it('another tenant’s admin cannot move a line’s status', async () => {
    const id = await composeStandard();
    await issue(id);
    const { body } = await detail(id);
    const res = await setLine(body.request.lines[0].id, { status: 'received' }, otherAdmin);
    expect(res.status).toBe(404);
  });

  it('the list never leaks another tenant’s requests', async () => {
    await composeStandard();
    const { body } = await call(listGet, '/api/document-requests', { as: otherAdmin });
    expect(body.requests.length).toBe(0);
  });
});

describe('role gates', () => {
  it('a reader cannot compose, issue or amend', async () => {
    const id = await composeStandard();
    expect((await compose({ supplier_id: supplierA, title: 'x', lines: [] }, reader)).status).toBe(403);
    expect((await issue(id, {}, reader)).status).toBe(403);
    expect((await amend(id, { amendment_reason: 'x' }, reader)).status).toBe(403);
    expect((await reissue(id, {}, reader)).status).toBe(403);
  });

  it('a reader cannot move a line’s status', async () => {
    const id = await composeStandard();
    await issue(id);
    const { body } = await detail(id);
    const res = await setLine(body.request.lines[0].id, { status: 'received' }, reader);
    expect(res.status).toBe(403);
  });

  it('a reader CAN read — an outstanding-requests list is evidence, not configuration', async () => {
    const id = await composeStandard();
    expect((await detail(id, reader)).status).toBe(200);
    expect((await call(listGet, '/api/document-requests', { as: reader })).status).toBe(200);
  });

  it('the assigned buyer (role: user) can move a line but cannot compose', async () => {
    const id = await composeStandard();
    await issue(id);
    const { body } = await detail(id);

    const moved = await setLine(body.request.lines[0].id, { status: 'received' }, worker);
    expect(moved.status).toBe(200);
    expect(moved.body.line.status_changed_by).toBe(seed.userId);

    expect((await compose({ supplier_id: supplierA, title: 'x', lines: [] }, worker)).status).toBe(403);
    expect((await amend(id, { amendment_reason: 'x' }, worker)).status).toBe(403);
  });

  it('a reader cannot create a template', async () => {
    const res = await call(templatePost, '/api/request-templates', {
      method: 'POST',
      body: { name: 'Nope', lines: [{ requirement_id: reqAllergen }] },
      as: reader,
    });
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// Cancel
// ===========================================================================

describe('DELETE /api/document-requests/:id', () => {
  it('hard-deletes a draft — it was committed to nobody', async () => {
    const id = await composeStandard();
    const res = await call(detailDelete, `/api/document-requests/${id}`, {
      method: 'DELETE',
      params: { id },
    });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect((await detail(id)).status).toBe(404);
  });

  it('soft-cancels an issued request, keeping the record that it went out', async () => {
    const id = await composeStandard();
    await issue(id);
    const res = await call(detailDelete, `/api/document-requests/${id}`, {
      method: 'DELETE',
      params: { id },
    });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(false);

    const { body } = await detail(id);
    expect(body.request.status).toBe('cancelled');
    expect(body.request.cancelled_at).toBeTruthy();
    expect(body.request.issued_at).toBeTruthy();
    expect(body.request.routing).not.toBeNull();
  });
});
