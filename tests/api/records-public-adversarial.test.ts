/**
 * The Records public pages, after the adversarial review of commit 1818968.
 *
 * The reviewer's proof file, kept: every scenario that failed the first build
 * is a regression test here, with the fix it forced (decisions C-133..C-141).
 * `tests/api/records-public-leak.test.ts` plants a world and checks every
 * route's shape; this file is the attacks that got through that net:
 *
 *   1. THE ROW TITLE was sent as stored, and for a reference title column the
 *      stored title was the cell's JSON -- an id, and a foreign id's label.
 *   2. A CONTACT CELL that is an address was shown as an address.
 *   3. AN ID WAS ACCEPTED on a field that never published a list, and told an
 *      id that exists from one that does not.
 *   4. A DECISION WAS RECORDED AND THE RUN STRANDED when the next step could
 *      not be started, with a builder's error text sent to the approver.
 *   5. A WORKFLOW'S UPDATE-REQUEST LINK outlived its run.
 *   6. TWO DECISIONS could both advance a run.
 *   7. A COMPUTED COLUMN could be offered on a sign-off page.
 *   8. AN UPLOADED SVG (or HTML called an image) was served inline.
 *   9. THE VIEW LIMITER counted by a header the caller writes.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { applyRecordsMigrations } from '../helpers/records';
import { onRequestGet as formGet } from '../../functions/api/forms/public/[slug]';
import { onRequestPost as formSubmit } from '../../functions/api/forms/public/[slug]/submit';
import { onRequestPost as formUpload } from '../../functions/api/forms/public/[slug]/upload';
import {
  onRequestGet as updateGet,
  onRequestPost as updatePost,
} from '../../functions/api/update-requests/public/[token]';
import {
  onRequestGet as approvalGet,
  onRequestPost as approvalPost,
} from '../../functions/api/workflow-approvals/public/[token]';
import { onRequestPost as runCancel } from '../../functions/api/records/workflow-runs/[runId]/cancel';
import { onRequestGet as attachmentDownload } from '../../functions/api/records/attachments/[attachmentId]/download';
import { computeDisplayTitle } from '../../functions/lib/records/helpers';
import {
  handleApprovalResponse,
  hydrateWorkflow,
  normalizeWorkflowSteps,
  startWorkflowRun,
} from '../../functions/lib/records/workflows';
import { sniffFileType, storedTypeForUpload } from '../../functions/lib/records/fileType';
import type { RecordColumnRow } from '../../shared/types';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let n = 0;
const ip = () => `10.77.${Math.floor(++n / 250)}.${(n % 250) + 1}`;

interface Init {
  method?: string;
  json?: unknown;
  body?: BodyInit;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  user?: unknown;
  resend?: boolean;
}

function ctx(url: string, init: Init = {}): never {
  const headers: Record<string, string> = init.headers ?? { 'CF-Connecting-IP': ip() };
  let body: BodyInit | undefined = init.body;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  return {
    request: new Request(new URL(url, 'http://localhost').toString(), { method: init.method ?? 'GET', body, headers }),
    env: { ...env, TURNSTILE_SECRET: 's', TURNSTILE_SITE_KEY: 'k', ...(init.resend ? { RESEND_API_KEY: 'test-resend-key' } : {}) },
    data: init.user ? { user: init.user, authMethod: 'jwt' } : {},
    params: init.params ?? {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response('NEXT'),
  } as never;
}
async function read(res: Response) {
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body, text, headers: res.headers };
}

const admin = () => ({ id: seed.orgAdminId, email: 'orgadmin@test.com', name: 'Org Admin', role: 'org_admin', tenant_id: seed.tenantId });

interface Col {
  key: string;
  type: string;
  is_title?: boolean;
  config?: unknown;
}
async function makeSheet(tenantId: string, cols: Col[]) {
  const sheetId = generateTestId();
  await db
    .prepare('INSERT INTO records_sheets (id, tenant_id, name, slug, created_by) VALUES (?, ?, ?, ?, ?)')
    .bind(sheetId, tenantId, 'Adv Sheet', `adv-${sheetId.slice(0, 8)}`, seed.orgAdminId)
    .run();
  const ids: Record<string, string> = {};
  let i = 0;
  for (const c of cols) {
    ids[c.key] = generateTestId();
    await db
      .prepare('INSERT INTO records_columns (id, sheet_id, tenant_id, key, label, type, config, is_title, display_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(ids[c.key], sheetId, tenantId, c.key, c.key.toUpperCase(), c.type, c.config ? JSON.stringify(c.config) : null, c.is_title ? 1 : 0, i++)
      .run();
  }
  return { sheetId, ids };
}
async function makeRow(tenantId: string, sheetId: string, data: Record<string, unknown>, displayTitle: string | null = 'R') {
  const rowId = generateTestId();
  await db
    .prepare('INSERT INTO records_rows (id, sheet_id, tenant_id, display_title, data) VALUES (?, ?, ?, ?, ?)')
    .bind(rowId, sheetId, tenantId, displayTitle, JSON.stringify(data))
    .run();
  return rowId;
}
async function makeForm(tenantId: string, sheetId: string, fields: Array<{ column_id: string; public_picker?: boolean }>, settings: Record<string, unknown> = {}) {
  const slug = `adv-${generateTestId()}`;
  await db
    .prepare(`INSERT INTO records_forms (id, tenant_id, sheet_id, name, public_slug, is_public, status, archived, field_config, settings) VALUES (?, ?, ?, 'F', ?, 1, 'live', 0, ?, ?)`)
    .bind(generateTestId(), tenantId, sheetId, slug, JSON.stringify(fields.map((f, i) => ({ ...f, position: i }))), JSON.stringify(settings))
    .run();
  return slug;
}
async function makeUR(tenantId: string, sheetId: string, rowId: string, keys: string[]) {
  const token = `adv-u-${generateTestId()}`;
  const id = generateTestId();
  await db
    .prepare(`INSERT INTO records_update_requests (id, tenant_id, sheet_id, row_id, token, recipient_email, fields_requested, status, created_by_user_id) VALUES (?, ?, ?, ?, ?, 'x@out.example', ?, 'pending', ?)`)
    .bind(id, tenantId, sheetId, rowId, token, JSON.stringify(keys), seed.orgAdminId)
    .run();
  return token;
}
async function makeWorkflow(tenantId: string, sheetId: string, steps: unknown[]) {
  const wf = generateTestId();
  await db
    .prepare(`INSERT INTO records_workflows (id, tenant_id, sheet_id, name, steps, status, created_by_user_id) VALUES (?, ?, ?, 'WF', ?, 'active', ?)`)
    .bind(wf, tenantId, sheetId, JSON.stringify(steps), seed.orgAdminId)
    .run();
  return wf;
}
/** A run parked on its first step, an approval awaiting an outside approver. */
async function makeApproval(tenantId: string, sheetId: string, rowId: string, steps: unknown[]) {
  const wf = await makeWorkflow(tenantId, sheetId, steps);
  const run = generateTestId();
  await db
    .prepare(`INSERT INTO records_workflow_runs (id, tenant_id, workflow_id, sheet_id, row_id, status, current_step_id) VALUES (?, ?, ?, ?, ?, 'in_progress', 's1')`)
    .bind(run, tenantId, wf, sheetId, rowId)
    .run();
  const token = `adv-a-${generateTestId()}`;
  const stepRunId = generateTestId();
  await db
    .prepare(`INSERT INTO records_workflow_step_runs (id, run_id, step_id, step_index, step_type, status, assignee_email, approver_token) VALUES (?, ?, 's1', 0, 'approval', 'awaiting_response', 'qa@out.example', ?)`)
    .bind(stepRunId, run, token)
    .run();
  return { token, run, stepRunId, wf };
}
async function makeSupplier(tenantId: string, name: string, active = 1) {
  const id = generateTestId();
  await db.prepare('INSERT INTO suppliers (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, ?)').bind(id, tenantId, name, `s-${id.slice(0, 10)}`, active).run();
  return id;
}

const getU = async (token: string, init: Init = {}) => read(await updateGet(ctx(`/api/update-requests/public/${token}`, { ...init, params: { token } })));
const postU = async (token: string, data: unknown, init: Init = {}) =>
  read(await updatePost(ctx(`/api/update-requests/public/${token}`, { ...init, method: 'POST', params: { token }, json: { data } })));
const getA = async (token: string) => read(await approvalGet(ctx(`/api/workflow-approvals/public/${token}`, { params: { token } })));
const postA = async (token: string, body: unknown, init: Init = {}) =>
  read(await approvalPost(ctx(`/api/workflow-approvals/public/${token}`, { ...init, method: 'POST', params: { token }, json: body })));
const submit = async (slug: string, data: unknown) =>
  read(await formSubmit(ctx(`/api/forms/public/${slug}/submit`, { method: 'POST', params: { slug }, json: { turnstile_token: 'ok', data } })));

interface Mail {
  to: string[] | string;
  subject: string;
  html: string;
}
/** Turnstile says yes; every mail is captured. */
function stubNet(): Mail[] {
  const sent: Mail[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('resend.com')) sent.push(JSON.parse(String(init?.body)) as Mail);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }),
  );
  return sent;
}

let mails: Mail[] = [];

beforeAll(async () => {
  seed = await seedTestData(db);
  await applyRecordsMigrations(db);
});
beforeEach(() => {
  mails = stubNet();
});
afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// 1. The title
// ---------------------------------------------------------------------------

describe('FINDING 1: the row TITLE is projected like any other cell (C-133)', () => {
  it('a row made by the real public submit path shows the supplier NAME, never its id, on /u and /a', async () => {
    const t = seed.tenantId;
    const supplierId = await makeSupplier(t, 'Title Supplier');
    const { sheetId, ids } = await makeSheet(t, [
      { key: 'supplier', type: 'supplier_ref', is_title: true },
      { key: 'notes', type: 'text' },
    ]);
    const slug = await makeForm(t, sheetId, [{ column_id: ids.supplier, public_picker: true }, { column_id: ids.notes }]);
    const sub = await submit(slug, { supplier: { id: supplierId }, notes: 'n' });
    expect(sub.status).toBe(200);
    const row = await db.prepare('SELECT id, display_title FROM records_rows WHERE sheet_id = ?').bind(sheetId).first<{ id: string; display_title: string }>();
    // The grid's own stored title is the name too, no longer the cell's JSON.
    expect(row!.display_title).toBe('Title Supplier');

    const u = await getU(await makeUR(t, sheetId, row!.id, ['notes']));
    expect(u.status).toBe(200);
    expect(u.body.request.row_title).toBe('Title Supplier');

    const a = await makeApproval(t, sheetId, row!.id, [{ id: 's1', type: 'approval', name: 'QA', config: { assignee_email: 'qa@out.example' } }]);
    const ap = await getA(a.token);
    expect(ap.status).toBe(200);
    expect(ap.body.row.title).toBe('Title Supplier');

    // "never an id"
    expect(u.text).not.toContain(supplierId);
    expect(ap.text).not.toContain(supplierId);
  });

  it('a row written BEFORE the fix, whose stored title is the JSON, still shows only the name', async () => {
    const t = seed.tenantId;
    const supplierId = await makeSupplier(t, 'Legacy Title Supplier');
    const { sheetId } = await makeSheet(t, [{ key: 'supplier', type: 'supplier_ref', is_title: true }, { key: 'notes', type: 'text' }]);
    const cell = { id: supplierId, name: 'A STALE LABEL IN THE CELL' };
    const rowId = await makeRow(t, sheetId, { supplier: cell }, JSON.stringify(cell));

    const u = await getU(await makeUR(t, sheetId, rowId, ['notes']));
    const a = await makeApproval(t, sheetId, rowId, [{ id: 's1', type: 'approval', name: 'QA', config: { assignee_email: 'qa@out.example' } }]);
    const ap = await getA(a.token);
    // The tenant's own name for the supplier, read now -- not the stored label.
    expect(u.body.request.row_title).toBe('Legacy Title Supplier');
    expect(ap.body.row.title).toBe('Legacy Title Supplier');
    for (const text of [u.text, ap.text]) {
      expect(text).not.toContain(supplierId);
      expect(text).not.toContain('A STALE LABEL');
      expect(text).not.toContain('{\\"id\\"');
    }
  });

  it("another tenant's id and its label sitting in a title cell show NOTHING, as a field and as the title", async () => {
    const t = seed.tenantId;
    const foreignId = await makeSupplier(seed.tenantId2, 'FOREIGN SUPPLIER NAME');
    const { sheetId } = await makeSheet(t, [{ key: 'supplier', type: 'supplier_ref', is_title: true }, { key: 'notes', type: 'text' }]);
    const data = { supplier: { id: foreignId, name: 'FOREIGN SUPPLIER NAME' } };
    // The stored title exactly as the code BEFORE the fix computed it.
    const rowId = await makeRow(t, sheetId, data, JSON.stringify(data.supplier));
    const a = await makeApproval(t, sheetId, rowId, [{ id: 's1', type: 'approval', name: 'QA', config: { assignee_email: 'qa@out.example', visible_fields: ['supplier'] } }]);
    const ap = await getA(a.token);
    expect(ap.status).toBe(200);
    expect(ap.body.row.fields[0].value).toBeNull();
    expect(ap.body.row.title).toBeNull();
    const u = await getU(await makeUR(t, sheetId, rowId, ['notes']));
    expect(u.body.request.row_title).toBeNull();
    for (const text of [ap.text, u.text]) {
      expect(text).not.toContain(foreignId);
      expect(text).not.toContain('FOREIGN SUPPLIER NAME');
    }
  });

  it('a CONTACT title is the person\'s name: never their id, never their address', async () => {
    const t = seed.tenantId;
    const { sheetId } = await makeSheet(t, [{ key: 'owner', type: 'contact', is_title: true }, { key: 'notes', type: 'text' }]);
    const cell = { id: seed.orgAdminId, name: 'Org Admin', email: 'orgadmin@test.com' };
    const rowId = await makeRow(t, sheetId, { owner: cell }, JSON.stringify(cell));
    const u = await getU(await makeUR(t, sheetId, rowId, ['notes']));
    const ap = await getA((await makeApproval(t, sheetId, rowId, [{ id: 's1', type: 'approval', name: 'QA', config: { assignee_email: 'qa@out.example' } }])).token);
    expect(u.body.request.row_title).toBe('Org Admin');
    expect(ap.body.row.title).toBe('Org Admin');
    for (const text of [u.text, ap.text]) {
      expect(text).not.toContain(seed.orgAdminId);
      expect(text).not.toContain('orgadmin@test.com');
    }

    // A contact title that IS an address is no title at all.
    const bare = await makeRow(t, sheetId, { owner: 'someone.login@tenant-secret.example' }, 'someone.login@tenant-secret.example');
    const u2 = await getU(await makeUR(t, sheetId, bare, ['notes']));
    expect(u2.body.request.row_title).toBeNull();
    expect(u2.text).not.toContain('@tenant-secret.example');
  });

  it("a linked record named on a sign-off page is that record's PROJECTED title, not its stored one", async () => {
    const t = seed.tenantId;
    const supplierId = await makeSupplier(t, 'Linked Title Supplier');
    const target = await makeSheet(t, [{ key: 'supplier', type: 'supplier_ref', is_title: true }]);
    const cell = { id: supplierId, name: 'Linked Title Supplier' };
    const targetRow = await makeRow(t, target.sheetId, { supplier: cell }, JSON.stringify(cell));
    const foreignTarget = await makeSheet(seed.tenantId2, [{ key: 'name', type: 'text', is_title: true }]);
    const foreignRow = await makeRow(seed.tenantId2, foreignTarget.sheetId, { name: 'FOREIGN ROW TITLE' }, 'FOREIGN ROW TITLE');

    const { sheetId } = await makeSheet(t, [{ key: 'title', type: 'text', is_title: true }, { key: 'linked', type: 'record_ref' }]);
    const rowId = await makeRow(t, sheetId, { title: 'R', linked: [{ id: targetRow }, { id: foreignRow, name: 'FOREIGN ROW TITLE' }] });
    const a = await makeApproval(t, sheetId, rowId, [{ id: 's1', type: 'approval', name: 'QA', config: { assignee_email: 'qa@out.example', visible_fields: ['linked'] } }]);
    const ap = await getA(a.token);
    expect(ap.body.row.fields).toEqual([{ label: 'LINKED', type: 'record_ref', value: 'Linked Title Supplier' }]);
    expect(ap.text).not.toContain(supplierId);
    expect(ap.text).not.toContain(targetRow);
    expect(ap.text).not.toContain('FOREIGN ROW TITLE');
  });

  it('the MAIL that carries the link names the record by the same projection', async () => {
    const t = seed.tenantId;
    const supplierId = await makeSupplier(t, 'Mailed Title Supplier');
    const { sheetId } = await makeSheet(t, [{ key: 'supplier', type: 'supplier_ref', is_title: true }, { key: 'notes', type: 'text' }]);
    const cell = { id: supplierId, name: 'Mailed Title Supplier' };
    const rowId = await makeRow(t, sheetId, { supplier: cell }, JSON.stringify(cell));
    const wf = await makeWorkflow(t, sheetId, [
      { id: 's1', type: 'approval', name: 'QA', config: { assignee_email: 'qa@out.example' } },
      { id: 's2', type: 'update_request', name: 'Ask', config: { recipient_email: 'pat@out.example', fields_requested: ['notes'] } },
    ]);
    const row = await db.prepare('SELECT * FROM records_workflows WHERE id = ?').bind(wf).first<Record<string, unknown>>();
    const { runId } = await startWorkflowRun(
      { DB: db, RESEND_API_KEY: 'test-resend-key', appOrigin: 'http://portal.test' },
      { workflow: hydrateWorkflow(row as never), rowId, triggeredByUserId: seed.orgAdminId },
    );
    const sr = await db.prepare(`SELECT approver_token FROM records_workflow_step_runs WHERE run_id = ?`).bind(runId).first<{ approver_token: string }>();
    expect((await postA(sr!.approver_token, { decision: 'approve' }, { resend: true })).status).toBe(200);

    expect(mails).toHaveLength(2);
    for (const m of mails) {
      expect(m.html).toContain('Mailed Title Supplier');
      expect(m.html).not.toContain(supplierId);
      expect(m.html).not.toContain('&quot;id&quot;');
      expect(m.subject).not.toContain(supplierId);
    }
  });

  it('computeDisplayTitle stores a reference title as its name, for the grid', () => {
    const col = (type: string) => [{ key: 't', type, is_title: 1, archived: 0 }] as unknown as RecordColumnRow[];
    expect(computeDisplayTitle(col('supplier_ref'), { t: { id: 'x', name: 'Alpha' } })).toBe('Alpha');
    expect(computeDisplayTitle(col('record_ref'), { t: [{ id: 'x', name: 'One' }, { id: 'y', name: 'Two' }] })).toBe('One, Two');
    expect(computeDisplayTitle(col('supplier_ref'), { t: { id: 'only-an-id' } })).toBeNull();
    expect(computeDisplayTitle(col('text'), { t: 'plain' })).toBe('plain');
    expect(computeDisplayTitle(col('number'), { t: 7 })).toBe('7');
  });
});

// ---------------------------------------------------------------------------
// 2. Contact addresses
// ---------------------------------------------------------------------------

describe('FINDING 2: a contact is never an address, whatever shape the cell has (C-134)', () => {
  it('a bare string, an id-less object, and a user whose name is their address', async () => {
    const t = seed.tenantId;
    const namelessId = `adv-nameless-${generateTestId().slice(0, 8)}`;
    await db
      .prepare(`INSERT INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change) VALUES (?, ?, ?, 'user', ?, 'x', 1, 0)`)
      .bind(namelessId, 'carol.login@tenant-secret.example', 'carol.login@tenant-secret.example', t)
      .run();
    const { sheetId } = await makeSheet(t, [
      { key: 'title', type: 'text', is_title: true },
      { key: 'owner', type: 'contact' },
      { key: 'owner2', type: 'contact' },
      { key: 'owner3', type: 'contact' },
      { key: 'owner4', type: 'contact' },
    ]);
    const rowId = await makeRow(t, sheetId, {
      title: 'R',
      owner: 'jane.login@tenant-secret.example',
      owner2: { name: 'bob.login@tenant-secret.example', email: 'bob.login@tenant-secret.example' },
      owner3: { id: namelessId, email: 'carol.login@tenant-secret.example' },
      // A name typed by hand is still shown.
      owner4: ['Dana Typed', 'dave.login@tenant-secret.example'],
    });
    const a = await makeApproval(t, sheetId, rowId, [
      { id: 's1', type: 'approval', name: 'QA', config: { assignee_email: 'qa@out.example', visible_fields: ['owner', 'owner2', 'owner3', 'owner4'] } },
    ]);
    const ap = await getA(a.token);
    expect(ap.status).toBe(200);
    expect(ap.body.row.fields.map((f: { value: unknown }) => f.value)).toEqual([null, null, null, 'Dana Typed']);
    expect(ap.text).not.toContain('@tenant-secret.example');
    expect(ap.text).not.toContain(namelessId);
  });
});

// ---------------------------------------------------------------------------
// 3. Ids
// ---------------------------------------------------------------------------

describe('FINDING 3: an id is accepted only where a list was published, and only one the list offers (C-136)', () => {
  it('a field WITHOUT the opt-in refuses every id the same way, and links nothing', async () => {
    const t = seed.tenantId;
    const activeId = await makeSupplier(t, 'Live Supplier');
    const inactiveId = await makeSupplier(t, 'Dropped Supplier', 0);
    const foreignId = await makeSupplier(seed.tenantId2, 'Foreign Supplier');
    const { sheetId, ids } = await makeSheet(t, [{ key: 'title', type: 'text', is_title: true }, { key: 'supplier', type: 'supplier_ref' }]);
    const slug = await makeForm(t, sheetId, [{ column_id: ids.title }, { column_id: ids.supplier }]); // NO public_picker
    const view = await read(await formGet(ctx(`/api/forms/public/${slug}`, { params: { slug } })));
    expect(view.body.entity_options).toBeUndefined();

    const answers = [];
    for (const id of ['no-such-id', activeId, inactiveId, foreignId]) {
      answers.push(await submit(slug, { title: 'x', supplier: { id } }));
    }
    // No existence oracle: a real id, a retired one, a foreign one and a
    // made-up one are the same status and the same bytes.
    for (const a of answers) {
      expect(a.status).toBe(400);
      expect(a.text).toBe(answers[0].text);
    }
    const refs = await db.prepare('SELECT ref_id FROM records_row_refs WHERE sheet_id = ?').bind(sheetId).all<{ ref_id: string }>();
    expect(refs.results).toEqual([]);
    const rows = await db.prepare('SELECT COUNT(*) AS n FROM records_rows WHERE sheet_id = ?').bind(sheetId).first<{ n: number }>();
    expect(rows!.n).toBe(0);

    // Typed text is what the field is for.
    const typed = await submit(slug, { title: 'x', supplier: 'Live Supplier' });
    expect(typed.status).toBe(200);
    const row = await db.prepare('SELECT data FROM records_rows WHERE sheet_id = ?').bind(sheetId).first<{ data: string }>();
    expect(JSON.parse(row!.data).supplier).toEqual({ name: 'Live Supplier', unmatched: true });
  });

  it('an OPTED-IN field accepts exactly what its published list offers: not a retired supplier', async () => {
    const t = seed.tenantId;
    const activeId = await makeSupplier(t, 'Offered Supplier');
    const inactiveId = await makeSupplier(t, 'Retired Supplier', 0);
    const { sheetId, ids } = await makeSheet(t, [{ key: 'title', type: 'text', is_title: true }, { key: 'supplier', type: 'supplier_ref' }]);
    const slug = await makeForm(t, sheetId, [{ column_id: ids.title }, { column_id: ids.supplier, public_picker: true }]);
    const view = await read(await formGet(ctx(`/api/forms/public/${slug}`, { params: { slug } })));
    const offered = (view.body.entity_options.supplier as Array<{ id: string }>).map((o) => o.id);
    expect(offered).toContain(activeId);
    expect(offered).not.toContain(inactiveId);
    expect(view.text).not.toContain('Retired Supplier');

    const unknown = await submit(slug, { title: 'x', supplier: { id: 'no-such-id' } });
    const retired = await submit(slug, { title: 'x', supplier: { id: inactiveId } });
    expect(unknown.status).toBe(400);
    expect(retired.status).toBe(400);
    expect(retired.text).toBe(unknown.text);
    expect((await submit(slug, { title: 'x', supplier: { id: activeId, name: 'ATTACKER LABEL' } })).status).toBe(200);
    const row = await db.prepare('SELECT data FROM records_rows WHERE sheet_id = ?').bind(sheetId).first<{ data: string }>();
    expect(JSON.parse(row!.data).supplier).toEqual({ id: activeId, name: 'Offered Supplier' });
  });

  it('an update request never published a list, so its reference fields take typed text only', async () => {
    const t = seed.tenantId;
    const sup = await makeSupplier(t, 'Real Supplier');
    const { sheetId } = await makeSheet(t, [
      { key: 'title', type: 'text', is_title: true },
      { key: 'supplier', type: 'supplier_ref' },
      { key: 'secret', type: 'text' },
      { key: 'calc', type: 'formula' },
      { key: 'd', type: 'date' },
    ]);
    const before = { title: 'R', secret: 'S', calc: 1 };
    const rowId = await makeRow(t, sheetId, before);

    // The reviewer's forged payload: a real id with an attacker's label,
    // columns that were not requested, a computed column, a prototype key.
    const tok = await makeUR(t, sheetId, rowId, ['supplier', 'd', 'calc']);
    const forged = await postU(tok, {
      supplier: { id: sup, name: 'ATTACKER LABEL', unmatched: false, extra: 1 },
      secret: 'PWNED',
      calc: 999,
      title: 'PWNED',
      d: '2026-01-02',
      ['__proto__']: { polluted: 1 },
    });
    const missing = await postU(await makeUR(t, sheetId, rowId, ['supplier']), { supplier: { id: 'no-such-id' } });
    expect(forged.status).toBe(400);
    expect(missing.status).toBe(400);
    // The same answer for an id that exists and one that does not.
    expect(forged.text).toBe(missing.text);
    const row = await db.prepare('SELECT data FROM records_rows WHERE id = ?').bind(rowId).first<{ data: string }>();
    expect(JSON.parse(row!.data)).toEqual(before);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(({} as any).polluted).toBeUndefined();
    // Refused, not consumed.
    expect((await getU(tok)).status).toBe(200);

    const ok = await postU(tok, { supplier: 'Real Supplier', secret: 'PWNED', calc: 999, title: 'PWNED', d: '2026-01-02' });
    expect(ok.status).toBe(200);
    const after = JSON.parse((await db.prepare('SELECT data FROM records_rows WHERE id = ?').bind(rowId).first<{ data: string }>())!.data);
    expect(after).toEqual({ ...before, supplier: { name: 'Real Supplier', unmatched: true }, d: '2026-01-02' });
    expect((await db.prepare('SELECT ref_id FROM records_row_refs WHERE row_id = ?').bind(rowId).all()).results).toEqual([]);
  });

  it('a REFUSED answer counts against the limit: the write path cannot be probed for free (C-141)', async () => {
    const t = seed.tenantId;
    const { sheetId } = await makeSheet(t, [{ key: 'title', type: 'text', is_title: true }, { key: 'qty', type: 'number' }]);
    const rowId = await makeRow(t, sheetId, { title: 'R' });
    const tok = await makeUR(t, sheetId, rowId, ['qty']);
    const from = { headers: { 'CF-Connecting-IP': '198.51.100.77' } };
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await postU(tok, { qty: 'not a number' }, { headers: { ...from.headers } })).status);
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429, 429]);
    // Even a correct answer now waits, from that address.
    expect((await postU(tok, { qty: 3 }, { headers: { ...from.headers } })).status).toBe(429);
    // Somebody else is not locked out by it.
    expect((await postU(tok, { qty: 3 })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 4. A decision is recorded with a well-defined run
// ---------------------------------------------------------------------------

describe('FINDING 4: a next step that cannot be started stops the run, visibly (C-135)', () => {
  async function auditOf(runId: string) {
    const rows = await db
      .prepare(`SELECT details FROM audit_log WHERE action = 'records_workflow_run.step_failed' AND resource_id = ?`)
      .bind(runId)
      .all<{ details: string }>();
    return (rows.results ?? []).map((r) => JSON.parse(r.details) as { reason: string; step_id: string; run_status: string });
  }

  it('a workflow saved before C-124 whose update-request step names only a contact column', async () => {
    const t = seed.tenantId;
    const { sheetId } = await makeSheet(t, [{ key: 'title', type: 'text', is_title: true }, { key: 'owner', type: 'contact' }]);
    const rowId = await makeRow(t, sheetId, { title: 'R' });
    const a = await makeApproval(t, sheetId, rowId, [
      { id: 's1', type: 'approval', name: 'QA', config: { assignee_email: 'qa@out.example' }, on_approve: 's2' },
      { id: 's2', type: 'update_request', name: 'Ask the supplier', config: { recipient_email: 'x@out.example', fields_requested: ['owner'] } },
      { id: 's3', type: 'approval', name: 'Final', config: { assignee_email: 'final@out.example' } },
    ]);
    const res = await postA(a.token, { decision: 'approve' }, { resend: true });

    // The approver's decision is recorded and answered as any other.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, decision: 'approve' });
    // Not a word of the engine's validation reaches them.
    expect(res.text).not.toContain('Pick at least');
    expect(res.text).not.toContain('None of the fields');
    expect(res.text).not.toContain('field');

    const steps = (
      await db
        .prepare('SELECT step_id, status, response_comment, response_value FROM records_workflow_step_runs WHERE run_id = ? ORDER BY step_index')
        .bind(a.run)
        .all<{ step_id: string; status: string; response_comment: string | null; response_value: string | null }>()
    ).results;
    expect(steps.map((s) => [s.step_id, s.status])).toEqual([
      ['s1', 'approved'],
      ['s2', 'skipped'],
    ]);
    // The step says why, where the run view prints it.
    expect(steps[1].response_comment).toContain('Could not be started');
    expect(JSON.parse(steps[1].response_value!)).toMatchObject({ failed: true });

    // The run is ended, not left "in progress" with nobody to wait for; the
    // step after the one that failed never ran.
    const run = await db.prepare('SELECT status, completed_at FROM records_workflow_runs WHERE id = ?').bind(a.run).first<{ status: string; completed_at: string | null }>();
    expect(run!.status).toBe('cancelled');
    expect(run!.completed_at).not.toBeNull();
    expect((await db.prepare('SELECT COUNT(*) AS n FROM records_update_requests WHERE sheet_id = ?').bind(sheetId).first<{ n: number }>())!.n).toBe(0);

    // Recorded for the owner: audit, the row's activity, and a mail.
    const audit = await auditOf(a.run);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ step_id: 's2', run_status: 'cancelled' });
    const activity = await db.prepare(`SELECT details FROM records_activity WHERE row_id = ? AND kind = 'workflow_step_failed'`).bind(rowId).all<{ details: string }>();
    expect(activity.results).toHaveLength(1);
    expect(JSON.parse(activity.results[0].details).step_name).toBe('Ask the supplier');
    const toOwner = mails.filter((m) => [m.to].flat().includes('orgadmin@test.com'));
    expect(toOwner).toHaveLength(1);
    expect(toOwner[0].subject).toContain('could not be started');
    expect(toOwner[0].html).toContain('Ask the supplier');
    // The owner IS told why, in words about the step.
    expect(toOwner[0].html).toContain('None of the fields this step asks for can be requested');
    expect(audit[0].reason).toContain('None of the fields');
    // Nobody outside was sent anything for the failed step.
    expect(mails.filter((m) => [m.to].flat().includes('x@out.example'))).toEqual([]);

    // The link is closed, like any answered one.
    expect((await getA(a.token)).status).toBe(404);
    expect((await postA(a.token, { decision: 'reject' })).status).toBe(404);
  });

  it('the same when a step-by-step run is STARTED on a first step that cannot be sent', async () => {
    const t = seed.tenantId;
    const { sheetId } = await makeSheet(t, [{ key: 'title', type: 'text', is_title: true }, { key: 'owner', type: 'contact' }]);
    const rowId = await makeRow(t, sheetId, { title: 'R' });
    const wf = await makeWorkflow(t, sheetId, [{ id: 's1', type: 'update_request', name: 'Ask', config: { recipient_email: 'x@out.example', fields_requested: ['owner'] } }]);
    const row = await db.prepare('SELECT * FROM records_workflows WHERE id = ?').bind(wf).first<Record<string, unknown>>();
    const { runId } = await startWorkflowRun({ DB: db, RESEND_API_KEY: null, appOrigin: 'http://portal.test' }, { workflow: hydrateWorkflow(row as never), rowId, triggeredByUserId: seed.orgAdminId });
    const run = await db.prepare('SELECT status FROM records_workflow_runs WHERE id = ?').bind(runId).first<{ status: string }>();
    expect(run!.status).toBe('cancelled');
    expect(await auditOf(runId)).toHaveLength(1);
  });

  it('a mixed step keeps the columns that can still be asked for and goes out', async () => {
    const t = seed.tenantId;
    const { sheetId } = await makeSheet(t, [{ key: 'title', type: 'text', is_title: true }, { key: 'owner', type: 'contact' }, { key: 'notes', type: 'text' }]);
    const rowId = await makeRow(t, sheetId, { title: 'R' });
    const a = await makeApproval(t, sheetId, rowId, [
      { id: 's1', type: 'approval', name: 'QA', config: { assignee_email: 'qa@out.example' } },
      { id: 's2', type: 'update_request', name: 'Ask', config: { recipient_email: 'x@out.example', fields_requested: ['owner', 'notes'] } },
    ]);
    expect((await postA(a.token, { decision: 'approve' })).status).toBe(200);
    const ur = await db.prepare('SELECT fields_requested FROM records_update_requests WHERE sheet_id = ?').bind(sheetId).first<{ fields_requested: string }>();
    expect(JSON.parse(ur!.fields_requested)).toEqual(['notes']);
    expect((await db.prepare('SELECT status FROM records_workflow_runs WHERE id = ?').bind(a.run).first<{ status: string }>())!.status).toBe('in_progress');
  });

  it('a multi-step workflow that is fine moves from one sign-off to the next', async () => {
    const t = seed.tenantId;
    const { sheetId } = await makeSheet(t, [{ key: 'title', type: 'text', is_title: true }]);
    const rowId = await makeRow(t, sheetId, { title: 'R' });
    const a = await makeApproval(t, sheetId, rowId, [
      { id: 's1', type: 'approval', name: 'QA', config: { assignee_email: 'qa@out.example' } },
      { id: 's2', type: 'approval', name: 'Director', config: { assignee_email: 'director@out.example' } },
    ]);
    expect((await postA(a.token, { decision: 'approve' })).status).toBe(200);
    const next = await db
      .prepare(`SELECT status, approver_token FROM records_workflow_step_runs WHERE run_id = ? AND step_id = 's2'`)
      .bind(a.run)
      .first<{ status: string; approver_token: string }>();
    expect(next!.status).toBe('awaiting_response');
    const page = await getA(next!.approver_token);
    expect(page.status).toBe(200);
    expect(page.body.step.name).toBe('Director');
    expect((await postA(next!.approver_token, { decision: 'approve' })).status).toBe(200);
    expect((await db.prepare('SELECT status FROM records_workflow_runs WHERE id = ?').bind(a.run).first<{ status: string }>())!.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// 5. A workflow's update-request link
// ---------------------------------------------------------------------------

describe("FINDING 5: a workflow's update-request link closes with its run (C-137)", () => {
  async function workflowRequest() {
    const t = seed.tenantId;
    const { sheetId } = await makeSheet(t, [{ key: 'title', type: 'text', is_title: true }, { key: 'notes', type: 'text' }]);
    const rowId = await makeRow(t, sheetId, { title: 'R', notes: 'before' });
    const wf = await makeWorkflow(t, sheetId, [{ id: 's1', type: 'update_request', name: 'Ask', config: { recipient_email: 'x@out.example', fields_requested: ['notes'] } }]);
    const row = await db.prepare('SELECT * FROM records_workflows WHERE id = ?').bind(wf).first<Record<string, unknown>>();
    const { runId } = await startWorkflowRun({ DB: db, RESEND_API_KEY: null, appOrigin: 'http://portal.test' }, { workflow: hydrateWorkflow(row as never), rowId, triggeredByUserId: seed.orgAdminId });
    const ur = await db.prepare('SELECT token FROM records_update_requests WHERE sheet_id = ?').bind(sheetId).first<{ token: string }>();
    return { token: ur!.token, runId, wf, rowId };
  }
  const notesOf = async (rowId: string) =>
    JSON.parse((await db.prepare('SELECT data FROM records_rows WHERE id = ?').bind(rowId).first<{ data: string }>())!.data).notes;

  it('cancelling the run closes the link for the read and the write', async () => {
    const w = await workflowRequest();
    const unknown = await getU(`nope-${generateTestId()}`);
    expect((await getU(w.token)).status).toBe(200);

    const cancelled = await runCancel(ctx(`/api/records/workflow-runs/${w.runId}/cancel`, { method: 'POST', params: { runId: w.runId }, user: admin() }));
    expect(cancelled.status).toBe(200);

    const g = await getU(w.token);
    const p = await postU(w.token, { notes: 'WRITTEN AFTER CANCEL' });
    expect(g.status).toBe(404);
    expect(g.text).toBe(unknown.text);
    expect(p.status).toBe(404);
    expect(p.text).toBe(unknown.text);
    expect(await notesOf(w.rowId)).toBe('before');
  });

  it('pausing or archiving the workflow closes it, and reactivating opens it again', async () => {
    const w = await workflowRequest();
    await db.prepare(`UPDATE records_workflows SET status = 'draft' WHERE id = ?`).bind(w.wf).run();
    expect((await getU(w.token)).status).toBe(404);
    expect((await postU(w.token, { notes: 'x' })).status).toBe(404);
    await db.prepare(`UPDATE records_workflows SET status = 'active', archived = 1 WHERE id = ?`).bind(w.wf).run();
    expect((await getU(w.token)).status).toBe(404);
    await db.prepare(`UPDATE records_workflows SET archived = 0 WHERE id = ?`).bind(w.wf).run();
    expect((await getU(w.token)).status).toBe(200);
    expect((await postU(w.token, { notes: 'answered' })).status).toBe(200);
    expect(await notesOf(w.rowId)).toBe('answered');
    expect((await db.prepare('SELECT status FROM records_workflow_runs WHERE id = ?').bind(w.runId).first<{ status: string }>())!.status).toBe('completed');
  });

  it('a request somebody sent by hand belongs to no run and is unaffected', async () => {
    const t = seed.tenantId;
    const { sheetId } = await makeSheet(t, [{ key: 'title', type: 'text', is_title: true }]);
    const rowId = await makeRow(t, sheetId, { title: 'R' });
    expect((await getU(await makeUR(t, sheetId, rowId, ['title']))).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 6. One decision wins
// ---------------------------------------------------------------------------

describe('FINDING 6: two decisions arriving together advance the run once (C-138)', () => {
  async function twoStep() {
    const t = seed.tenantId;
    const { sheetId } = await makeSheet(t, [{ key: 'title', type: 'text', is_title: true }]);
    const rowId = await makeRow(t, sheetId, { title: 'R' });
    return makeApproval(t, sheetId, rowId, [
      { id: 's1', type: 'approval', name: 'QA', config: { assignee_email: 'qa@out.example' } },
      { id: 's2', type: 'approval', name: 'Director', config: { assignee_email: 'director@out.example' } },
    ]);
  }
  const nextSteps = async (run: string) =>
    (await db.prepare(`SELECT COUNT(*) AS n FROM records_workflow_step_runs WHERE run_id = ? AND step_id = 's2'`).bind(run).first<{ n: number }>())!.n;

  it('through the public route: one 200, one 404, one next step', async () => {
    const a = await twoStep();
    const unknown = await getA(`nope-${generateTestId()}`);
    const [x, y] = await Promise.all([postA(a.token, { decision: 'approve' }), postA(a.token, { decision: 'approve' })]);
    expect([x.status, y.status].sort()).toEqual([200, 404]);
    const loser = x.status === 404 ? x : y;
    expect(loser.text).toBe(unknown.text);
    expect(await nextSteps(a.run)).toBe(1);
  });

  it('in the engine itself: exactly one call records, and an approve racing a reject does not do both', async () => {
    const a = await twoStep();
    const engine = { DB: db, RESEND_API_KEY: null, appOrigin: 'http://portal.test' };
    const call = (decision: 'approve' | 'reject') =>
      handleApprovalResponse(engine, { stepRunId: a.stepRunId, decision, comment: null, responder: { kind: 'email', email: 'qa@out.example' } });
    const results = await Promise.all([call('approve'), call('reject'), call('approve')]);
    expect(results.filter((r) => r.recorded)).toHaveLength(1);
    const run = await db.prepare('SELECT status FROM records_workflow_runs WHERE id = ?').bind(a.run).first<{ status: string }>();
    const step = await db.prepare('SELECT status FROM records_workflow_step_runs WHERE id = ?').bind(a.stepRunId).first<{ status: string }>();
    // Whichever won, the run agrees with it.
    if (step!.status === 'approved') {
      expect(run!.status).toBe('in_progress');
      expect(await nextSteps(a.run)).toBe(1);
    } else {
      expect(step!.status).toBe('rejected');
      expect(run!.status).toBe('rejected');
      expect(await nextSteps(a.run)).toBe(0);
    }
    // A decision after the fact records nothing.
    expect((await call('approve')).recorded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Computed columns on a sign-off page
// ---------------------------------------------------------------------------

describe('FINDING 7: a computed column is not offered on a sign-off page (C-139)', () => {
  it('the builder refuses it, and a step that already names one shows no dash for it', async () => {
    const t = seed.tenantId;
    const { sheetId } = await makeSheet(t, [{ key: 'title', type: 'text', is_title: true }, { key: 'calc', type: 'formula' }, { key: 'roll', type: 'rollup' }, { key: 'qty', type: 'number' }]);
    const columns = (await db.prepare('SELECT * FROM records_columns WHERE sheet_id = ?').bind(sheetId).all<RecordColumnRow>()).results;
    const step = (visible_fields: string[]) => [{ id: 's1', type: 'approval', name: 'QA', config: { assignee_email: 'qa@out.example', visible_fields } }];
    expect(() => normalizeWorkflowSteps(step(['calc']), columns)).toThrow();
    expect(() => normalizeWorkflowSteps(step(['qty', 'roll']), columns)).toThrow();
    expect(() => normalizeWorkflowSteps(step(['qty']), columns)).not.toThrow();

    const rowId = await makeRow(t, sheetId, { title: 'R', calc: 5, qty: 2 });
    const a = await makeApproval(t, sheetId, rowId, step(['calc', 'roll', 'qty']));
    const ap = await getA(a.token);
    expect(ap.body.row.fields).toEqual([{ label: 'QTY', type: 'number', value: 2 }]);
  });
});

// ---------------------------------------------------------------------------
// 8. Uploads
// ---------------------------------------------------------------------------

describe('FINDING 8: an upload is what its bytes say, and only inert types are drawn inline (C-140)', () => {
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52];
  const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1];
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.cookie)"><script>alert(1)</script></svg>';
  const HTML = '<!doctype html><html><body><script>alert(document.cookie)</script></body></html>';

  async function upload(slug: string, file: File) {
    const fd = new FormData();
    fd.append('file', file);
    return read(await formUpload(ctx(`/api/forms/public/${slug}/upload`, { method: 'POST', params: { slug }, body: fd })));
  }
  async function uploadForm(settings: Record<string, unknown> = {}) {
    const t = seed.tenantId;
    const { sheetId, ids } = await makeSheet(t, [{ key: 'title', type: 'text', is_title: true }]);
    return makeForm(t, sheetId, [{ column_id: ids.title }], { allow_attachments: true, ...settings });
  }
  const storedMime = async (id: string) =>
    (await db.prepare('SELECT mime_type FROM records_row_attachments WHERE id = ?').bind(id).first<{ mime_type: string }>())!.mime_type;

  it('the default form (image/*) refuses an SVG and HTML dressed as an image', async () => {
    const slug = await uploadForm();
    const before = (await db.prepare('SELECT COUNT(*) AS n FROM records_row_attachments').first<{ n: number }>())!.n;
    const refused = [
      await upload(slug, new File([SVG], 'logo.svg', { type: 'image/svg+xml' })),
      await upload(slug, new File([SVG], 'logo.png', { type: 'image/png' })),
      await upload(slug, new File([HTML], 'photo.png', { type: 'image/png' })),
      await upload(slug, new File([HTML], 'photo.jpg', { type: 'image/jpeg' })),
      await upload(slug, new File([HTML], 'page.html', { type: 'text/html' })),
    ];
    for (const r of refused) expect(r.status).toBe(415);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM records_row_attachments').first<{ n: number }>())!.n).toBe(before);
  });

  it('markup is refused even by a form that allows every type', async () => {
    const slug = await uploadForm({ allowed_mime_types: ['*/*', 'image/svg+xml', 'text/html', 'application/xhtml+xml'] });
    for (const type of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml']) {
      expect((await upload(slug, new File([SVG], 'x', { type }))).status, type).toBe(415);
    }
  });

  it('the stored type is the type of the BYTES, whatever was declared', async () => {
    const slug = await uploadForm();
    const jpegAsPng = await upload(slug, new File([new Uint8Array(JPEG)], 'photo.png', { type: 'image/png' }));
    expect(jpegAsPng.status).toBe(200);
    expect(jpegAsPng.body.mime_type).toBe('image/jpeg');
    expect(await storedMime(jpegAsPng.body.attachment_id)).toBe('image/jpeg');
    const png = await upload(slug, new File([new Uint8Array(PNG)], 'photo.png', { type: 'image/png; charset=binary' }));
    expect(await storedMime(png.body.attachment_id)).toBe('image/png');
  });

  it('the two rules, on their own', () => {
    expect(sniffFileType(new Uint8Array(PNG))).toBe('image/png');
    expect(sniffFileType(new TextEncoder().encode('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffFileType(new TextEncoder().encode(SVG))).toBeNull();
    expect(storedTypeForUpload('image/heic', new Uint8Array([0, 0, 0, 24]))).toBe('image/heic');
    expect(storedTypeForUpload('application/pdf', new TextEncoder().encode(HTML))).toBeNull();
    expect(storedTypeForUpload('IMAGE/SVG+XML', new TextEncoder().encode(SVG))).toBeNull();
    expect(storedTypeForUpload('', new Uint8Array(JPEG))).toBe('image/jpeg');
  });

  async function storedAttachment(mime: string, body: string | Uint8Array, name = 'file') {
    const t = seed.tenantId;
    const { sheetId } = await makeSheet(t, [{ key: 'title', type: 'text', is_title: true }]);
    const rowId = await makeRow(t, sheetId, { title: 'R' });
    const id = generateTestId();
    const key = `records/adv/${id}/stored`;
    await env.FILES.put(key, body);
    await db
      .prepare(`INSERT INTO records_row_attachments (id, tenant_id, row_id, r2_key, file_name, file_size, mime_type) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, t, rowId, key, name, typeof body === 'string' ? body.length : body.length, mime)
      .run();
    return id;
  }
  const preview = async (id: string) =>
    attachmentDownload(ctx(`/api/records/attachments/${id}/download?preview=true`, { params: { attachmentId: id }, user: admin() }));

  it('an SVG or HTML already in storage is a DOWNLOAD on ?preview=true, never drawn on our origin', async () => {
    for (const [mime, body] of [['image/svg+xml', SVG], ['text/html', HTML], ['application/xhtml+xml', HTML], ['image/x-unknown', SVG]] as const) {
      const res = await preview(await storedAttachment(mime, body, 'evil"\r\n.svg'));
      expect(res.status, mime).toBe(200);
      const disposition = res.headers.get('Content-Disposition') ?? '';
      expect(disposition.startsWith('attachment'), mime).toBe(true);
      expect(disposition).not.toContain('\r');
      expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
      expect(res.headers.get('Content-Security-Policy')).toContain('sandbox');
      await res.arrayBuffer();
    }
  });

  it('a raster image is still drawn inline, with nosniff and a policy that lets it do nothing', async () => {
    const res = await preview(await storedAttachment('image/png', new Uint8Array(PNG), 'photo.png'));
    expect(res.headers.get('Content-Disposition')).toBe('inline');
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toContain('sandbox');
    await res.arrayBuffer();
  });
});

// ---------------------------------------------------------------------------
// 9. The limiter's address
// ---------------------------------------------------------------------------

describe('FINDING 9: the limiter does not count by a header the caller writes (C-141)', () => {
  it('35 reads of one /u link with a rotating X-Forwarded-For are one caller', async () => {
    const t = seed.tenantId;
    const { sheetId } = await makeSheet(t, [{ key: 'title', type: 'text', is_title: true }]);
    const rowId = await makeRow(t, sheetId, { title: 'R' });
    const tok = await makeUR(t, sheetId, rowId, ['title']);
    let ok = 0;
    for (let i = 0; i < 35; i++) {
      const r = await updateGet(ctx(`/api/update-requests/public/${tok}`, { params: { token: tok }, headers: { 'X-Forwarded-For': `1.2.3.${i}` } }));
      if (r.status === 200) ok++;
    }
    expect(ok).toBe(30);
  });
});
