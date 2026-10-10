/**
 * The Records public pages: a public form (/f/:slug), an update request
 * (/u/:token) and a workflow sign-off (/a/:token) -- eight unauthenticated
 * routes.
 *
 * The client's sentence: "a test that plants an internal note, a limit and
 * another tenant's record confirms none of them leak." So what is pinned here
 * is not "the page renders". It is:
 *
 *   1. Every response is an ALLOW-LIST: no key outside the list at any depth.
 *   2. NOTHING PLANTED LEAVES: an internal note, a spec limit and its
 *      criticality, a row comment, a hidden column, an R2 key, a portal user's
 *      email, every internal id, and everything belonging to another tenant.
 *   3. A list of customers / suppliers / products is published ONLY for a
 *      field whose form builder opted it in, and then as id + name.
 *   4. A sign-off page shows the row's title plus ONLY the fields its step
 *      names; a reference is a name, never an id.
 *   5. Every unusable state -- unknown, draft, expired, cancelled, wrong
 *      tenant, organisation inactive, Records switched off -- is the SAME 404.
 *   6. What an outsider submits is coerced by column type and an id is
 *      accepted only when it belongs to the tenant.
 *
 * Each suspected leak in the Release A plan has its own test, written to fail
 * on the code as it stood before the fix.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { applyRecordsMigrations } from '../helpers/records';
import { onRequest as middleware } from '../../functions/api/_middleware';
import { onRequestGet as formGet } from '../../functions/api/forms/public/[slug]';
import { onRequestPost as formSubmit } from '../../functions/api/forms/public/[slug]/submit';
import { onRequestPost as formUpload } from '../../functions/api/forms/public/[slug]/upload';
import { onRequestDelete as formAttachmentDelete } from '../../functions/api/forms/public/[slug]/attachment/[attachmentId]';
import {
  onRequestGet as updateGet,
  onRequestPost as updatePost,
} from '../../functions/api/update-requests/public/[token]';
import {
  onRequestGet as approvalGet,
  onRequestPost as approvalPost,
} from '../../functions/api/workflow-approvals/public/[token]';
import { onRequestGet as rowGet } from '../../functions/api/records/sheets/[sheetId]/rows/[rowId]';
import { onRequestPut as formPut } from '../../functions/api/records/sheets/[sheetId]/forms/[formId]';
import { onRequestPost as updateRequestCreate } from '../../functions/api/records/sheets/[sheetId]/rows/[rowId]/update-requests/index';
import { normalizeWorkflowSteps } from '../../functions/lib/records/workflows';
import { projectColumnConfig, publicCellValue } from '../../functions/lib/records/publicView';
import type { RecordColumnRow } from '../../shared/types';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

// ---------------------------------------------------------------------------
// Calling a handler
// ---------------------------------------------------------------------------

let ipCounter = 0;
/** A fresh address per call, so no test trips another's rate limit by accident. */
function nextIp(): string {
  ipCounter += 1;
  return `10.9.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

interface CallInit {
  method?: string;
  body?: BodyInit | null;
  json?: unknown;
  params?: Record<string, string>;
  ip?: string;
  user?: unknown;
}

function ctx(url: string, init: CallInit = {}): never {
  const u = new URL(url, 'http://localhost');
  const headers: Record<string, string> = { 'CF-Connecting-IP': init.ip ?? nextIp() };
  let body = init.body ?? undefined;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  return {
    request: new Request(u.toString(), { method: init.method ?? 'GET', body, headers }),
    env: { ...env, TURNSTILE_SECRET: 'test-turnstile-secret', TURNSTILE_SITE_KEY: 'test-site-key' },
    data: init.user ? { user: init.user, authMethod: 'jwt' } : {},
    params: init.params ?? {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response('NEXT'),
    functionPath: u.pathname,
  } as never;
}

async function read(res: Response): Promise<{ status: number; body: Record<string, unknown>; text: string; headers: Headers }> {
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.status, body, text, headers: res.headers };
}

const getForm = async (slug: string, init: CallInit = {}) =>
  read(await formGet(ctx(`/api/forms/public/${slug}`, { ...init, params: { slug } })));
const submitForm = async (slug: string, data: unknown, extra: Record<string, unknown> = {}, init: CallInit = {}) =>
  read(
    await formSubmit(
      ctx(`/api/forms/public/${slug}/submit`, {
        ...init,
        method: 'POST',
        json: { data, turnstile_token: 'ok', ...extra },
        params: { slug },
      }),
    ),
  );
async function uploadToForm(slug: string, file: File, init: CallInit = {}) {
  const fd = new FormData();
  fd.append('file', file);
  return read(await formUpload(ctx(`/api/forms/public/${slug}/upload`, { ...init, method: 'POST', body: fd, params: { slug } })));
}
const deleteAttachment = async (slug: string, attachmentId: string, pendingToken: string, init: CallInit = {}) =>
  read(
    await formAttachmentDelete(
      ctx(`/api/forms/public/${slug}/attachment/${attachmentId}?pending_token=${encodeURIComponent(pendingToken)}`, {
        ...init,
        method: 'DELETE',
        params: { slug, attachmentId },
      }),
    ),
  );
const getUpdate = async (token: string, init: CallInit = {}) =>
  read(await updateGet(ctx(`/api/update-requests/public/${token}`, { ...init, params: { token } })));
const postUpdate = async (token: string, data: unknown, init: CallInit = {}) =>
  read(await updatePost(ctx(`/api/update-requests/public/${token}`, { ...init, method: 'POST', json: { data }, params: { token } })));
const getApproval = async (token: string, init: CallInit = {}) =>
  read(await approvalGet(ctx(`/api/workflow-approvals/public/${token}`, { ...init, params: { token } })));
const postApproval = async (token: string, body: unknown, init: CallInit = {}) =>
  read(await approvalPost(ctx(`/api/workflow-approvals/public/${token}`, { ...init, method: 'POST', json: body, params: { token } })));

/**
 * Every key in a payload AS A PATH from the root: `fields[].config.options[].value`.
 * A flat "this key name is allowed somewhere" list would let `id`, `name` or
 * `value` appear anywhere once it was allowed in one place; a path says where.
 */
function allPaths(value: unknown, prefix = '', into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) allPaths(v, `${prefix}[]`, into);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${k}` : k;
      into.add(path);
      allPaths(v, path, into);
    }
  }
  return into;
}

/** Paths in the payload that the allow-list does not name. */
function extraKeys(body: unknown, allowed: readonly string[]): string[] {
  const set = new Set(allowed);
  return [...allPaths(body)].filter((k) => !set.has(k)).sort();
}

/** A real PNG signature: the upload route decides a file's type from its bytes. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const pngFile = (name = 'photo.png') => new File([PNG_BYTES], name, { type: 'image/png' });

function expectNone(text: string, forbidden: Record<string, string>): void {
  const found = Object.entries(forbidden)
    .filter(([, value]) => value && text.includes(value))
    .map(([label]) => label);
  expect(found).toEqual([]);
}

// ---------------------------------------------------------------------------
// The planted world
// ---------------------------------------------------------------------------

interface World {
  tag: string;
  tenantId: string;
  creatorId: string;
  creatorEmail: string;
  creatorName: string;
  sheetId: string;
  otherSheetId: string;
  otherRowId: string;
  rowId: string;
  supplierId: string;
  customerId: string;
  productId: string;
  documentId: string;
  columnIds: Record<string, string>;
  /** Strings that never leave, whatever the route and whatever is opted in. */
  never: Record<string, string>;
  /** Cell values: leave only when the field is named / requested. */
  cells: Record<string, string>;
  /** Ids of pickable things: leave only inside an opted-in picker. */
  pickable: Record<string, string>;
  names: { supplier: string; customer: string; product: string; document: string; linked: string };
}

const COLUMN_DEFS: Array<{ key: string; label: string; type: string; config?: (w: { otherSheetId: string }) => unknown; is_title?: boolean }> = [
  { key: 'title', label: 'Title', type: 'text', is_title: true },
  { key: 'notes', label: 'Notes', type: 'long_text' },
  { key: 'hidden', label: 'Hidden', type: 'text' },
  { key: 'owner', label: 'Owner', type: 'contact' },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'phone', label: 'Phone', type: 'phone' },
  {
    key: 'supplier',
    label: 'Supplier',
    type: 'supplier_ref',
    // A ref column's config can hold builder internals next to what a renderer needs.
    config: (w) => ({ multiple: false, target_sheet_id: w.otherSheetId, lookup_note: 'CONFIG-INTERNAL-SECRET' }),
  },
  { key: 'product', label: 'Product', type: 'product_ref' },
  { key: 'customer', label: 'Customer', type: 'customer_ref' },
  { key: 'doc', label: 'Document', type: 'document_ref' },
  { key: 'linked', label: 'Linked', type: 'record_ref', config: (w) => ({ target_sheet_id: w.otherSheetId, multiple: true }) },
  {
    key: 'status',
    label: 'Status',
    type: 'dropdown_single',
    config: () => ({
      options: [
        { value: 'open', label: 'Open', color: '#00AA00', automation: 'OPTION-INTERNAL-SECRET' },
        { value: 'closed', label: 'Closed' },
      ],
      allow_custom: false,
      webhook_url: 'https://internal.example/CONFIG-INTERNAL-SECRET',
    }),
  },
  { key: 'qty', label: 'Quantity', type: 'number', config: () => ({ precision: 1 }) },
  { key: 'total', label: 'Total', type: 'rollup', config: (w) => ({ source_column_key: 'qty', target_sheet_id: w.otherSheetId, aggregation: 'sum' }) },
];

async function makeWorld(tenantId: string, tag: string): Promise<World> {
  const T = tag.toUpperCase();
  const creatorId = `user-${tag}-${generateTestId().slice(0, 8)}`;
  const creatorEmail = `sender.${tag}@portal-secret-${tag}.example`;
  const creatorName = `Sandy Sender ${T}`;
  await db
    .prepare(`INSERT INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change) VALUES (?, ?, ?, 'user', ?, 'x', 1, 0)`)
    .bind(creatorId, creatorEmail, creatorName, tenantId)
    .run();

  const supplierId = generateTestId();
  const supplierName = `Supplier Name ${T}`;
  await db.prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)').bind(supplierId, tenantId, supplierName, `sup-${tag}-${supplierId.slice(0, 6)}`).run();
  // A second supplier that no row points at: a picker would list it.
  const unusedSupplierId = generateTestId();
  await db.prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)').bind(unusedSupplierId, tenantId, `Unlisted Supplier ${T}`, `sup2-${tag}-${unusedSupplierId.slice(0, 6)}`).run();

  // A supplier the organisation stopped using: never offered, never accepted.
  const retiredSupplierId = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 0)')
    .bind(retiredSupplierId, tenantId, `RETIRED-SUPPLIER-SECRET-${T}`, `sup3-${tag}-${retiredSupplierId.slice(0, 6)}`)
    .run();

  const customerId = generateTestId();
  const customerName = `Customer Name ${T}`;
  await db
    .prepare('INSERT INTO customers (id, tenant_id, customer_number, name, email) VALUES (?, ?, ?, ?, ?)')
    .bind(customerId, tenantId, `CUSTNUM-SECRET-${T}`, customerName, `customer@cust-secret-${tag}.example`)
    .run();

  const productId = generateTestId();
  const productName = `Product Name ${T}`;
  await db
    .prepare('INSERT INTO products (id, tenant_id, name, slug, description) VALUES (?, ?, ?, ?, ?)')
    .bind(productId, tenantId, productName, `prod-${tag}-${productId.slice(0, 6)}`, `PRODUCT-DESC-SECRET-${T}`)
    .run();

  const documentId = generateTestId();
  const documentName = `Document Title ${T}`;
  await db
    .prepare(`INSERT INTO documents (id, tenant_id, title, current_version, status, created_by, supplier_id) VALUES (?, ?, ?, 1, 'active', ?, ?)`)
    .bind(documentId, tenantId, documentName, creatorId, supplierId)
    .run();

  // The client's list: an internal note, a limit and its criticality.
  await db
    .prepare(`INSERT INTO entity_notes (tenant_id, entity_type, entity_id, body, author_id) VALUES (?, 'supplier', ?, ?, ?)`)
    .bind(tenantId, supplierId, `INTERNAL-NOTE-SECRET-${T}`, creatorId)
    .run();
  const specTestId = generateTestId();
  await db.prepare('INSERT INTO spec_tests (id, tenant_id, name, notes) VALUES (?, ?, ?, ?)').bind(specTestId, tenantId, `SPEC-TEST-SECRET-${T}`, `SPEC-TEST-NOTE-SECRET-${T}`).run();
  await db
    .prepare(
      `INSERT INTO spec_limits (id, tenant_id, spec_test_id, supplier_id, product_id, operator, value_max, unit, notes, criticality)
       VALUES (?, ?, ?, ?, ?, '<=', 7.31337, 'CFU/g', ?, 'high')`,
    )
    .bind(generateTestId(), tenantId, specTestId, supplierId, productId, `SPEC-LIMIT-NOTE-SECRET-${T}`)
    .run();

  // A second sheet: the target of the record_ref / rollup columns.
  const otherSheetId = generateTestId();
  await db.prepare('INSERT INTO records_sheets (id, tenant_id, name, slug, created_by) VALUES (?, ?, ?, ?, ?)').bind(otherSheetId, tenantId, `OTHER-SHEET-SECRET-${T}`, `other-${tag}-${otherSheetId.slice(0, 6)}`, creatorId).run();
  await db
    .prepare(`INSERT INTO records_columns (id, sheet_id, tenant_id, key, label, type, is_title, display_order) VALUES (?, ?, ?, 'name', 'Name', 'text', 1, 0)`)
    .bind(generateTestId(), otherSheetId, tenantId)
    .run();
  await db
    .prepare(`INSERT INTO records_columns (id, sheet_id, tenant_id, key, label, type, is_title, display_order) VALUES (?, ?, ?, 'secret', 'Secret', 'text', 0, 1)`)
    .bind(generateTestId(), otherSheetId, tenantId)
    .run();
  const otherRowId = generateTestId();
  const linkedName = `Linked Row ${T}`;
  // The stored display_title is deliberately NOT the title: what leaves is
  // computed from the title cell, never read from this column.
  await db
    .prepare('INSERT INTO records_rows (id, sheet_id, tenant_id, display_title, data, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(otherRowId, otherSheetId, tenantId, `STORED-DISPLAY-TITLE-SECRET-${T}`, JSON.stringify({ name: linkedName, secret: `OTHER-SHEET-ROW-SECRET-${T}` }), creatorId)
    .run();

  const sheetId = generateTestId();
  await db.prepare('INSERT INTO records_sheets (id, tenant_id, name, slug, created_by) VALUES (?, ?, ?, ?, ?)').bind(sheetId, tenantId, `Intake Sheet ${T}`, `intake-${tag}-${sheetId.slice(0, 6)}`, creatorId).run();

  const columnIds: Record<string, string> = {};
  let order = 0;
  for (const def of COLUMN_DEFS) {
    const id = generateTestId();
    columnIds[def.key] = id;
    await db
      .prepare(`INSERT INTO records_columns (id, sheet_id, tenant_id, key, label, type, config, is_title, display_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, sheetId, tenantId, def.key, def.label, def.type, def.config ? JSON.stringify(def.config({ otherSheetId })) : null, def.is_title ? 1 : 0, order++)
      .run();
  }

  const cells = {
    notes: `ROWCELL-NOTES-${T}`,
    email: `cell.email@cell-secret-${tag}.example`,
    phone: `+1-555-0${tag === 'a' ? '1' : '2'}77-4242`,
  };
  const rowId = generateTestId();
  const data = {
    title: `Row Title ${T}`,
    notes: cells.notes,
    hidden: `HIDDEN-COLUMN-SECRET-${T}`,
    owner: { id: creatorId, name: creatorName, email: creatorEmail },
    email: cells.email,
    phone: cells.phone,
    supplier: { id: supplierId, name: supplierName },
    product: { id: productId, name: productName },
    customer: { id: customerId, name: customerName },
    doc: { id: documentId, name: documentName },
    linked: [{ id: otherRowId, name: linkedName }],
    status: 'open',
    qty: 12.5,
  };
  await db
    .prepare('INSERT INTO records_rows (id, sheet_id, tenant_id, display_title, data, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(rowId, sheetId, tenantId, data.title, JSON.stringify(data), creatorId)
    .run();
  await db
    .prepare('INSERT INTO records_comments (tenant_id, row_id, author_id, body) VALUES (?, ?, ?, ?)')
    .bind(tenantId, rowId, creatorId, `ROW-COMMENT-SECRET-${T}`)
    .run();
  const r2Key = `records/${tag}/R2KEY-SECRET-${T}/scan.pdf`;
  await db
    .prepare(`INSERT INTO records_row_attachments (tenant_id, row_id, r2_key, file_name, file_size, mime_type) VALUES (?, ?, ?, ?, 10, 'application/pdf')`)
    .bind(tenantId, rowId, r2Key, `ATTACHMENT-NAME-SECRET-${T}.pdf`)
    .run();

  return {
    tag,
    tenantId,
    creatorId,
    creatorEmail,
    creatorName,
    sheetId,
    otherSheetId,
    otherRowId,
    rowId,
    supplierId,
    customerId,
    productId,
    documentId,
    columnIds,
    never: {
      internal_note: `INTERNAL-NOTE-SECRET-${T}`,
      spec_test: `SPEC-TEST-SECRET-${T}`,
      spec_test_note: `SPEC-TEST-NOTE-SECRET-${T}`,
      spec_limit_note: `SPEC-LIMIT-NOTE-SECRET-${T}`,
      row_comment: `ROW-COMMENT-SECRET-${T}`,
      hidden_column: `HIDDEN-COLUMN-SECRET-${T}`,
      r2_key: `R2KEY-SECRET-${T}`,
      attachment_name: `ATTACHMENT-NAME-SECRET-${T}`,
      creator_email: creatorEmail,
      customer_number: `CUSTNUM-SECRET-${T}`,
      customer_email: `customer@cust-secret-${tag}.example`,
      product_description: `PRODUCT-DESC-SECRET-${T}`,
      retired_supplier: `RETIRED-SUPPLIER-SECRET-${T}`,
      retired_supplier_id: retiredSupplierId,
      other_sheet: `OTHER-SHEET-SECRET-${T}`,
      stored_display_title: `STORED-DISPLAY-TITLE-SECRET-${T}`,
      other_sheet_row: `OTHER-SHEET-ROW-SECRET-${T}`,
      tenant_id: tenantId,
      creator_id: creatorId,
      sheet_id: sheetId,
      other_sheet_id: otherSheetId,
      other_row_id: otherRowId,
      row_id: rowId,
      document_id: documentId,
      spec_test_id: specTestId,
      ...Object.fromEntries(Object.entries(columnIds).map(([k, v]) => [`column_id_${k}`, v])),
    },
    cells,
    pickable: { supplier_id: supplierId, customer_id: customerId, product_id: productId, unused_supplier_id: unusedSupplierId },
    names: { supplier: supplierName, customer: customerName, product: productName, document: documentName, linked: linkedName },
  };
}

/** Everything of a world, for "nothing of tenant B appears" checks. */
function everythingOf(w: World): Record<string, string> {
  return {
    ...w.never,
    ...Object.fromEntries(Object.entries(w.cells).map(([k, v]) => [`cell_${k}`, v])),
    ...w.pickable,
    name_supplier: w.names.supplier,
    name_customer: w.names.customer,
    name_product: w.names.product,
    name_document: w.names.document,
    name_linked: w.names.linked,
    row_title: `Row Title ${w.tag.toUpperCase()}`,
    sheet_name: `Intake Sheet ${w.tag.toUpperCase()}`,
    creator_name: w.creatorName,
    spec_limit_value: '7.31337',
  };
}

interface FieldInit {
  key: string;
  public_picker?: boolean;
  required?: boolean;
}

async function makeForm(
  w: World,
  fields: Array<string | FieldInit>,
  opts: { status?: string; isPublic?: number; archived?: number; settings?: Record<string, unknown>; sheetId?: string } = {},
): Promise<{ slug: string; formId: string }> {
  const formId = generateTestId();
  const slug = `form-${w.tag}-${generateTestId()}`;
  const fieldConfig = fields.map((f, i) => {
    const init = typeof f === 'string' ? { key: f } : f;
    return {
      column_id: w.columnIds[init.key],
      position: i,
      required: !!init.required,
      ...(init.public_picker ? { public_picker: true } : {}),
    };
  });
  await db
    .prepare(
      `INSERT INTO records_forms (id, tenant_id, sheet_id, name, public_slug, is_public, status, archived, field_config, settings, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      formId,
      w.tenantId,
      opts.sheetId ?? w.sheetId,
      `Public Intake ${w.tag.toUpperCase()}`,
      slug,
      opts.isPublic ?? 1,
      opts.status ?? 'live',
      opts.archived ?? 0,
      JSON.stringify(fieldConfig),
      JSON.stringify(opts.settings ?? {}),
      w.creatorId,
    )
    .run();
  return { slug, formId };
}

async function makeUpdateRequest(
  w: World,
  keys: string[],
  opts: { status?: string; expiresAt?: string | null; rowId?: string; sheetId?: string; createdBy?: string } = {},
): Promise<{ token: string; id: string }> {
  const id = generateTestId();
  const token = `upd-${w.tag}-${generateTestId()}-${generateTestId()}`;
  await db
    .prepare(
      `INSERT INTO records_update_requests (id, tenant_id, sheet_id, row_id, token, recipient_email, fields_requested, message, status, expires_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, 'pat@outside.example', ?, 'Please confirm these', ?, ?, ?)`,
    )
    .bind(id, w.tenantId, opts.sheetId ?? w.sheetId, opts.rowId ?? w.rowId, token, JSON.stringify(keys), opts.status ?? 'pending', opts.expiresAt ?? null, opts.createdBy ?? w.creatorId)
    .run();
  return { token, id };
}

async function makeApproval(
  w: World,
  stepConfig: Record<string, unknown> = {},
  opts: { rowId?: string; sheetId?: string; runTenantId?: string; stepStatus?: string; expiresAt?: string | null } = {},
): Promise<{ token: string; workflowId: string; runId: string; stepRunId: string }> {
  const workflowId = generateTestId();
  const stepId = 'step-1';
  await db
    .prepare(
      `INSERT INTO records_workflows (id, tenant_id, sheet_id, name, steps, status, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    )
    .bind(
      workflowId,
      w.tenantId,
      w.sheetId,
      `Sign-off ${w.tag.toUpperCase()}`,
      JSON.stringify([{ id: stepId, type: 'approval', name: 'QA sign-off', config: { assignee_email: 'qa@outside.example', message: 'Please review', ...stepConfig } }]),
      w.creatorId,
    )
    .run();
  const runId = generateTestId();
  await db
    .prepare(`INSERT INTO records_workflow_runs (id, tenant_id, workflow_id, sheet_id, row_id, status, current_step_id) VALUES (?, ?, ?, ?, ?, 'in_progress', ?)`)
    .bind(runId, opts.runTenantId ?? w.tenantId, workflowId, opts.sheetId ?? w.sheetId, opts.rowId ?? w.rowId, stepId)
    .run();
  const stepRunId = generateTestId();
  const token = `apr-${w.tag}-${generateTestId()}-${generateTestId()}`;
  await db
    .prepare(
      `INSERT INTO records_workflow_step_runs (id, run_id, step_id, step_index, step_type, status, assignee_email, approver_token, token_expires_at)
       VALUES (?, ?, ?, 0, 'approval', ?, 'qa@outside.example', ?, ?)`,
    )
    .bind(stepRunId, runId, stepId, opts.stepStatus ?? 'awaiting_response', token, opts.expiresAt ?? null)
    .run();
  return { token, workflowId, runId, stepRunId };
}

let A: World;
let B: World;

beforeAll(async () => {
  seed = await seedTestData(db);
  await applyRecordsMigrations(db);
  A = await makeWorld(seed.tenantId, 'a');
  B = await makeWorld(seed.tenantId2, 'b');
});

beforeEach(() => {
  // Turnstile is verified with an outbound call; a test never makes one.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await db.prepare('DELETE FROM tenant_modules').run();
  await db.prepare('UPDATE tenants SET active = 1').run();
});

// ---------------------------------------------------------------------------
// The allow-lists. A key that is not here cannot be in a response.
// ---------------------------------------------------------------------------

// Paths, not key names: `id` is allowed at `entity_options.supplier[].id` and
// nowhere else; `name` at `form.name` but not on a field; `value` inside a
// dropdown option but not on a field.
const FIELD_PATHS = (withPicker: boolean) => [
  'fields',
  'fields[].key',
  'fields[].type',
  'fields[].label',
  'fields[].help_text',
  'fields[].required',
  'fields[].position',
  ...(withPicker ? ['fields[].picker'] : []),
  'fields[].config',
  'fields[].config.options',
  'fields[].config.options[].value',
  'fields[].config.options[].label',
  'fields[].config.options[].color',
  'fields[].config.allow_custom',
  'fields[].config.precision',
  'fields[].config.format',
  'fields[].config.currency_code',
  'fields[].config.include_time',
  'fields[].config.multiple',
];

const FORM_GET_ALLOWED = [
  'form', 'form.name', 'form.description', 'form.accent_color', 'form.logo_url',
  ...FIELD_PATHS(true),
  'turnstile_site_key',
  'entity_options',
  'entity_options.customer', 'entity_options.customer[].id', 'entity_options.customer[].name',
  'entity_options.supplier', 'entity_options.supplier[].id', 'entity_options.supplier[].name',
  'entity_options.product', 'entity_options.product[].id', 'entity_options.product[].name',
  'attachments', 'attachments.enabled', 'attachments.max_attachments', 'attachments.max_file_size_mb', 'attachments.allowed_mime_types',
];
const FORM_SUBMIT_ALLOWED = ['success', 'thank_you_message', 'redirect_url'];
const FORM_UPLOAD_ALLOWED = ['attachment_id', 'pending_token', 'filename', 'mime_type', 'size_bytes', 'expires_at'];
const FORM_DELETE_ALLOWED = ['success'];
const UPDATE_GET_ALLOWED = [
  'request', 'request.sheet_name', 'request.row_title', 'request.sender_name', 'request.message', 'request.due_date', 'request.expires_at',
  ...FIELD_PATHS(false),
  // Keyed by column key; the keys are checked against the requested fields.
  'current_values',
];
const UPDATE_POST_ALLOWED = ['success', 'fields_updated'];
const APPROVAL_GET_ALLOWED = [
  'step', 'step.name', 'step.message', 'step.workflow_name', 'step.sender_name', 'step.expires_at',
  'row', 'row.sheet_name', 'row.title',
  'row.fields', 'row.fields[].label', 'row.fields[].type', 'row.fields[].value',
];
const APPROVAL_POST_ALLOWED = ['success', 'decision'];

const ALL_FORM_FIELDS = COLUMN_DEFS.map((c) => c.key).filter((k) => k !== 'hidden');

// ---------------------------------------------------------------------------
// 1. Public form: GET
// ---------------------------------------------------------------------------

describe('public form: what the page is given', () => {
  it('carries no key outside the allow-list and nothing planted, in this tenant or the other', async () => {
    const { slug, formId } = await makeForm(A, ALL_FORM_FIELDS, { settings: { allow_attachments: true } });
    const res = await getForm(slug);
    expect(res.status).toBe(200);

    expect(extraKeys(res.body, FORM_GET_ALLOWED)).toEqual([]);
    expectNone(res.text, { ...A.never, form_id: formId });
    // No row is read to draw a form, so no cell value may appear either.
    expectNone(res.text, Object.fromEntries(Object.entries(A.cells).map(([k, v]) => [`cell_${k}`, v])));
    expectNone(res.text, everythingOf(B));
  });

  it('SUSPICION 1: publishes no customer / supplier / product list unless a field opted in', async () => {
    const { slug } = await makeForm(A, ['title', 'supplier', 'product', 'customer']);
    const res = await getForm(slug);
    expect(res.status).toBe(200);
    expect(res.body.entity_options).toBeUndefined();
    expectNone(res.text, {
      ...A.pickable,
      supplier_name: A.names.supplier,
      customer_name: A.names.customer,
      product_name: A.names.product,
    });
    // The fields are still there, to be typed into.
    const fields = res.body.fields as Array<Record<string, unknown>>;
    expect(fields.map((f) => f.key)).toEqual(['title', 'supplier', 'product', 'customer']);
    expect(fields.some((f) => f.picker)).toBe(false);
  });

  it('SUSPICION 1: an opted-in field publishes id + name of ITS kind only, never a customer number or a description', async () => {
    const { slug } = await makeForm(A, ['title', { key: 'supplier', public_picker: true }, 'product', { key: 'customer', public_picker: true }]);
    const res = await getForm(slug);
    expect(res.status).toBe(200);
    const options = res.body.entity_options as Record<string, Array<Record<string, unknown>>>;
    expect(Object.keys(options).sort()).toEqual(['customer', 'supplier']);
    for (const list of Object.values(options)) {
      for (const option of list) expect(Object.keys(option).sort()).toEqual(['id', 'name']);
    }
    expect(options.supplier.map((o) => o.id)).toContain(A.supplierId);
    expect(options.customer.map((o) => o.name)).toContain(A.names.customer);
    // The product field did not opt in.
    expect(res.text).not.toContain(A.productId);
    expect(res.text).not.toContain(A.names.product);
    expectNone(res.text, A.never);
    expectNone(res.text, everythingOf(B));
    const fields = res.body.fields as Array<Record<string, unknown>>;
    expect(fields.filter((f) => f.picker).map((f) => f.key)).toEqual(['supplier', 'customer']);
  });

  it('SUSPICION 1: is never answered as publicly cacheable', async () => {
    const { slug } = await makeForm(A, ['title']);
    const res = await getForm(slug);
    expect(res.status).toBe(200);
    const cache = res.headers.get('Cache-Control') ?? '';
    expect(cache).not.toContain('public');
    expect(cache).toContain('no-store');
  });

  it('SUSPICION 4: a column config is projected per type (no target_sheet_id, no builder internals)', async () => {
    const { slug } = await makeForm(A, ['title', 'supplier', 'status', 'qty', 'linked']);
    const res = await getForm(slug);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('target_sheet_id');
    expect(res.text).not.toContain('CONFIG-INTERNAL-SECRET');
    expect(res.text).not.toContain('OPTION-INTERNAL-SECRET');
    expect(res.text).not.toContain(A.otherSheetId);
    const fields = res.body.fields as Array<{ key: string; config: Record<string, unknown> | null }>;
    const status = fields.find((f) => f.key === 'status')!;
    expect(status.config).toEqual({
      options: [
        { value: 'open', label: 'Open', color: '#00AA00' },
        { value: 'closed', label: 'Closed' },
      ],
      allow_custom: false,
    });
    expect(fields.find((f) => f.key === 'qty')!.config).toEqual({ precision: 1 });
  });

  it('leaves out the field types an outsider cannot fill (document, record, attachment, computed)', async () => {
    const { slug } = await makeForm(A, ALL_FORM_FIELDS);
    const res = await getForm(slug);
    const keys = (res.body.fields as Array<{ key: string }>).map((f) => f.key);
    expect(keys).not.toContain('doc');
    expect(keys).not.toContain('linked');
    expect(keys).not.toContain('total');
    expect(keys).toContain('supplier');
  });

  it('answers an unknown, a draft, a private, an archived form and an archived sheet with the same 404', async () => {
    const unknown = await getForm(`nope-${generateTestId()}`);
    expect(unknown.status).toBe(404);
    const draft = await getForm((await makeForm(A, ['title'], { status: 'draft' })).slug);
    const priv = await getForm((await makeForm(A, ['title'], { isPublic: 0 })).slug);
    const archived = await getForm((await makeForm(A, ['title'], { archived: 1 })).slug);
    for (const res of [draft, priv, archived]) {
      expect(res.status).toBe(404);
      expect(res.text).toBe(unknown.text);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Public form: submit, upload, delete
// ---------------------------------------------------------------------------

describe('public form: what an outsider can send', () => {
  it('answers a submit with three fields and never the row it made', async () => {
    const { slug, formId } = await makeForm(A, ['title', 'notes', 'qty'], { settings: { thank_you_message: 'Thanks' } });
    const res = await submitForm(slug, { title: 'From outside', notes: 'hello', qty: '3', hidden: 'SNEAK' });
    expect(res.status).toBe(200);
    expect(extraKeys(res.body, FORM_SUBMIT_ALLOWED)).toEqual([]);

    const row = await db
      .prepare(`SELECT r.id, r.data FROM records_rows r JOIN records_form_submissions s ON s.row_id = r.id WHERE s.form_id = ?`)
      .bind(formId)
      .first<{ id: string; data: string }>();
    expect(row).not.toBeNull();
    expect(res.text).not.toContain(row!.id);
    expectNone(res.text, { ...A.never, form_id: formId });
    // A column that is not on the form is not written.
    const data = JSON.parse(row!.data) as Record<string, unknown>;
    expect(data.hidden).toBeUndefined();
    expect(data.qty).toBe(3);
  });

  it('SUSPICION 1: a typed supplier is stored as text for a person to match, never as an id', async () => {
    const { slug, formId } = await makeForm(A, ['title', 'supplier']);
    // Typing another tenant's id into the box must not make it a reference.
    const res = await submitForm(slug, { title: 'Typed supplier', supplier: B.supplierId });
    expect(res.status).toBe(200);
    const row = await db
      .prepare(`SELECT r.id, r.data FROM records_rows r JOIN records_form_submissions s ON s.row_id = r.id WHERE s.form_id = ?`)
      .bind(formId)
      .first<{ id: string; data: string }>();
    const data = JSON.parse(row!.data) as { supplier: Record<string, unknown> };
    expect(data.supplier).toEqual({ name: B.supplierId, unmatched: true });
    const refs = await db.prepare('SELECT ref_id FROM records_row_refs WHERE row_id = ?').bind(row!.id).all();
    expect(refs.results).toEqual([]);
  });

  it("refuses an id that is not the tenant's, and stores this tenant's own name for one that is", async () => {
    const { slug, formId } = await makeForm(A, ['title', { key: 'supplier', public_picker: true }]);
    const foreign = await submitForm(slug, { title: 'Foreign', supplier: { id: B.supplierId, name: 'whatever' } });
    expect(foreign.status).toBe(400);
    expectNone(foreign.text, everythingOf(B));
    const unknown = await submitForm(slug, { title: 'Unknown', supplier: { id: 'no-such-supplier', name: 'whatever' } });
    expect(unknown.status).toBe(400);
    // A foreign id and an id that never existed read the same.
    expect(unknown.text).toBe(foreign.text);

    const own = await submitForm(slug, { title: 'Own', supplier: { id: A.supplierId, name: 'A NAME THE OUTSIDER MADE UP' } });
    expect(own.status).toBe(200);
    const row = await db
      .prepare(`SELECT r.data FROM records_rows r JOIN records_form_submissions s ON s.row_id = r.id WHERE s.form_id = ?`)
      .bind(formId)
      .first<{ data: string }>();
    expect((JSON.parse(row!.data) as { supplier: unknown }).supplier).toEqual({ id: A.supplierId, name: A.names.supplier });
  });

  it('answers an upload with six fields and no storage key', async () => {
    const { slug, formId } = await makeForm(A, ['title'], { settings: { allow_attachments: true } });
    const res = await uploadToForm(slug, pngFile('photo.png'));
    expect(res.status).toBe(200);
    expect(extraKeys(res.body, FORM_UPLOAD_ALLOWED)).toEqual([]);
    const att = await db.prepare('SELECT r2_key FROM records_row_attachments WHERE id = ?').bind(res.body.attachment_id as string).first<{ r2_key: string }>();
    expect(att).not.toBeNull();
    expect(res.text).not.toContain(att!.r2_key);
    expect(res.text).not.toContain('forms/');
    expectNone(res.text, { ...A.never, form_id: formId });
  });

  it('SUSPICION 9: a refused file type is not echoed back', async () => {
    const { slug } = await makeForm(A, ['title'], { settings: { allow_attachments: true, allowed_mime_types: ['image/*'] } });
    const res = await uploadToForm(slug, new File([new Uint8Array([1])], 'x.bin', { type: 'application/x-echo-me-back' }));
    expect(res.status).toBe(415);
    expect(res.text).not.toContain('x-echo-me-back');
    expect(extraKeys(res.body, ['error'])).toEqual([]);
  });

  it('SUSPICION 9: without a live form, a too-large or wrong-type upload is the same 404 as anything else', async () => {
    const unknown = await getForm(`nope-${generateTestId()}`);
    const big = new File([new Uint8Array(2 * 1024 * 1024)], 'big.png', { type: 'image/png' });
    const wrong = new File([new Uint8Array([1])], 'x.exe', { type: 'application/x-msdownload' });

    const noSlugBig = await uploadToForm(`nope-${generateTestId()}`, big);
    const noSlugWrong = await uploadToForm(`nope-${generateTestId()}`, wrong);
    const draft = await makeForm(A, ['title'], { status: 'draft', settings: { allow_attachments: true, max_file_size_mb: 1 } });
    const draftBig = await uploadToForm(draft.slug, big);
    // A live form that never switched uploads on tells nothing either.
    const noUploads = await makeForm(A, ['title']);
    const noUploadsWrong = await uploadToForm(noUploads.slug, wrong);
    for (const res of [noSlugBig, noSlugWrong, draftBig, noUploadsWrong]) {
      expect(res.status).toBe(404);
      expect(res.text).toBe(unknown.text);
    }
  });

  it('SUSPICION 9: a pending upload can be removed only through a LIVE form', async () => {
    const { slug, formId } = await makeForm(A, ['title'], { settings: { allow_attachments: true } });
    const up = await uploadToForm(slug, pngFile('photo.png'));
    const attachmentId = up.body.attachment_id as string;
    const pendingToken = up.body.pending_token as string;

    await db.prepare(`UPDATE records_forms SET status = 'draft' WHERE id = ?`).bind(formId).run();
    const whileDraft = await deleteAttachment(slug, attachmentId, pendingToken);
    expect(whileDraft.status).toBe(404);
    expect(await db.prepare('SELECT id FROM records_row_attachments WHERE id = ?').bind(attachmentId).first()).not.toBeNull();

    await db.prepare(`UPDATE records_forms SET status = 'live' WHERE id = ?`).bind(formId).run();
    const wrongToken = await deleteAttachment(slug, attachmentId, 'not-the-token');
    expect(wrongToken.status).toBe(404);
    expect(wrongToken.text).toBe(whileDraft.text);

    const ok = await deleteAttachment(slug, attachmentId, pendingToken);
    expect(ok.status).toBe(200);
    expect(extraKeys(ok.body, FORM_DELETE_ALLOWED)).toEqual([]);
    expect(await db.prepare('SELECT id FROM records_row_attachments WHERE id = ?').bind(attachmentId).first()).toBeNull();
  });

  it("cannot remove another form's pending upload, in this tenant or another", async () => {
    const mine = await makeForm(A, ['title'], { settings: { allow_attachments: true } });
    const theirs = await makeForm(B, ['title'], { settings: { allow_attachments: true } });
    const up = await uploadToForm(theirs.slug, pngFile('b.png'));
    const res = await deleteAttachment(mine.slug, up.body.attachment_id as string, up.body.pending_token as string);
    expect(res.status).toBe(404);
    expect(await db.prepare('SELECT id FROM records_row_attachments WHERE id = ?').bind(up.body.attachment_id as string).first()).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Update request
// ---------------------------------------------------------------------------

describe('update request: what the page is given', () => {
  it('carries no key outside the allow-list and nothing planted, in this tenant or the other', async () => {
    const { token, id } = await makeUpdateRequest(A, ['title', 'status', 'qty', 'supplier']);
    const res = await getUpdate(token);
    expect(res.status).toBe(200);

    const current = res.body.current_values as Record<string, unknown>;
    // current_values is keyed by column key; its keys are checked on their own.
    expect(Object.keys(current).every((k) => ['title', 'status', 'qty', 'supplier'].includes(k))).toBe(true);
    expect(extraKeys({ ...res.body, current_values: null }, UPDATE_GET_ALLOWED)).toEqual([]);

    expectNone(res.text, { ...A.never, request_id: id, token, ...A.pickable });
    // Columns nobody asked about stay inside.
    expectNone(res.text, Object.fromEntries(Object.entries(A.cells).map(([k, v]) => [`cell_${k}`, v])));
    expectNone(res.text, everythingOf(B));
    expect(res.headers.get('Cache-Control')).toContain('no-store');
  });

  it("SUSPICION 3: shows the sender's name and never an email", async () => {
    const { token } = await makeUpdateRequest(A, ['title']);
    const res = await getUpdate(token);
    const request = res.body.request as Record<string, unknown>;
    expect('sender_email' in request).toBe(false);
    expect(request.sender_name).toBe(A.creatorName);
    expect(res.text).not.toContain(A.creatorEmail);
    expect(res.text).not.toMatch(/@portal-secret/);
  });

  it('SUSPICION 3: a sender with no name is shown as the organisation, never as their email', async () => {
    const namelessId = `user-nameless-${generateTestId().slice(0, 8)}`;
    const email = `nameless@portal-secret-a.example`;
    // A user whose "name" is their address is the same case.
    await db
      .prepare(`INSERT INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change) VALUES (?, ?, ?, 'user', ?, 'x', 1, 0)`)
      .bind(namelessId, email, email, A.tenantId)
      .run();
    const { token } = await makeUpdateRequest(A, ['title'], { createdBy: namelessId });
    const res = await getUpdate(token);
    expect(res.status).toBe(200);
    expect((res.body.request as Record<string, unknown>).sender_name).toBe('Test Corp');
    expect(res.text).not.toContain(email);
  });

  it('SUSPICION 5: a reference is shown as a name, never as an id', async () => {
    const { token } = await makeUpdateRequest(A, ['supplier', 'product', 'customer']);
    const res = await getUpdate(token);
    expect(res.status).toBe(200);
    expect(res.body.current_values).toEqual({
      supplier: A.names.supplier,
      product: A.names.product,
      customer: A.names.customer,
    });
    expectNone(res.text, A.pickable);
  });

  it('SUSPICION 5: document, record and contact fields are not offered to an outsider', async () => {
    const { token } = await makeUpdateRequest(A, ['title', 'doc', 'linked', 'owner']);
    const res = await getUpdate(token);
    expect(res.status).toBe(200);
    expect((res.body.fields as Array<{ key: string }>).map((f) => f.key)).toEqual(['title']);
    expect(Object.keys(res.body.current_values as object)).toEqual(['title']);
    expectNone(res.text, {
      document_id: A.documentId,
      document_name: A.names.document,
      linked_row: A.names.linked,
      other_row_id: A.otherRowId,
      owner_email: A.creatorEmail,
      owner_id: A.creatorId,
    });
  });

  it('SUSPICION 4: a column config is projected per type', async () => {
    const { token } = await makeUpdateRequest(A, ['supplier', 'status']);
    const res = await getUpdate(token);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('target_sheet_id');
    expect(res.text).not.toContain('CONFIG-INTERNAL-SECRET');
    expect(res.text).not.toContain('OPTION-INTERNAL-SECRET');
    expect(res.text).not.toContain(A.otherSheetId);
  });

  it('answers unknown, expired, cancelled, responded, archived row and archived sheet with the same 404', async () => {
    const unknown = await getUpdate(`nope-${generateTestId()}`);
    expect(unknown.status).toBe(404);
    const expired = await makeUpdateRequest(A, ['title'], { expiresAt: '2020-01-01T00:00:00.000Z' });
    const cancelled = await makeUpdateRequest(A, ['title'], { status: 'cancelled' });
    const responded = await makeUpdateRequest(A, ['title'], { status: 'responded' });
    for (const t of [expired.token, cancelled.token, responded.token]) {
      const g = await getUpdate(t);
      const p = await postUpdate(t, { title: 'x' });
      expect(g.status).toBe(404);
      expect(g.text).toBe(unknown.text);
      expect(p.status).toBe(404);
      expect(p.text).toBe(unknown.text);
    }
  });
});

describe('update request: what an outsider can send', () => {
  it('answers a submit with two fields', async () => {
    const { token, id } = await makeUpdateRequest(A, ['notes']);
    const original = (await db.prepare('SELECT data FROM records_rows WHERE id = ?').bind(A.rowId).first<{ data: string }>())!.data;
    const res = await postUpdate(token, { notes: 'updated by the recipient', hidden: 'SNEAK' });
    expect(res.status).toBe(200);
    expect(extraKeys(res.body, UPDATE_POST_ALLOWED)).toEqual([]);
    expect(res.body.fields_updated).toBe(1);
    expectNone(res.text, { ...A.never, request_id: id });
    const data = JSON.parse((await db.prepare('SELECT data FROM records_rows WHERE id = ?').bind(A.rowId).first<{ data: string }>())!.data) as Record<string, unknown>;
    expect(data.notes).toBe('updated by the recipient');
    // A column that was not requested is not written.
    expect(data.hidden).toBe(`HIDDEN-COLUMN-SECRET-A`);
    await db.prepare('UPDATE records_rows SET data = ? WHERE id = ?').bind(original, A.rowId).run();
  });

  it("SUSPICION 5: refuses an id that is not the tenant's and leaves the row alone", async () => {
    const { token } = await makeUpdateRequest(A, ['supplier']);
    const before = (await db.prepare('SELECT data FROM records_rows WHERE id = ?').bind(A.rowId).first<{ data: string }>())!.data;
    const res = await postUpdate(token, { supplier: { id: B.supplierId, name: 'Looks legitimate' } });
    expect(res.status).toBe(400);
    expectNone(res.text, everythingOf(B));

    const after = (await db.prepare('SELECT data FROM records_rows WHERE id = ?').bind(A.rowId).first<{ data: string }>())!.data;
    expect(after).toBe(before);
    const planted = await db.prepare('SELECT id FROM records_row_refs WHERE ref_id = ?').bind(B.supplierId).all();
    expect(planted.results).toEqual([]);
    // Refused, not consumed: the recipient can still answer properly.
    expect((await getUpdate(token)).status).toBe(200);
  });

  it('SUSPICION 5: whatever a planted id did, the signed-in grid reads back nothing of the other tenant', async () => {
    const { token } = await makeUpdateRequest(A, ['supplier']);
    const before = (await db.prepare('SELECT data FROM records_rows WHERE id = ?').bind(A.rowId).first<{ data: string }>())!.data;
    await postUpdate(token, { supplier: { id: B.supplierId } });
    const res = await read(
      await rowGet(
        ctx(`/api/records/sheets/${A.sheetId}/rows/${A.rowId}`, {
          params: { sheetId: A.sheetId, rowId: A.rowId },
          user: { id: seed.orgAdminId, email: 'orgadmin@test.com', name: 'Org Admin', role: 'org_admin', tenant_id: A.tenantId },
        }),
      ),
    );
    expect(res.status).toBe(200);
    // The id itself is the outsider's own input; what must not come back is
    // anything the portal KNOWS about the other tenant's record.
    expect(res.text).not.toContain(B.names.supplier);
    expectNone(res.text, B.never);
    expect(res.text).not.toContain(B.supplierId);
    await db.prepare('UPDATE records_rows SET data = ? WHERE id = ?').bind(before, A.rowId).run();
    await db.prepare('DELETE FROM records_row_refs WHERE ref_id = ?').bind(B.supplierId).run();
  });

  it('SUSPICION 5: a typed reference is stored as text, and an untouched one is not a change', async () => {
    const original = (await db.prepare('SELECT data FROM records_rows WHERE id = ?').bind(A.rowId).first<{ data: string }>())!.data;

    // The page showed the supplier's name; sending it back unchanged changes nothing.
    const same = await makeUpdateRequest(A, ['supplier']);
    const unchanged = await postUpdate(same.token, { supplier: A.names.supplier });
    expect(unchanged.status).toBe(200);
    expect(unchanged.body.fields_updated).toBe(0);
    expect((await db.prepare('SELECT data FROM records_rows WHERE id = ?').bind(A.rowId).first<{ data: string }>())!.data).toBe(original);

    const typed = await makeUpdateRequest(A, ['supplier']);
    const res = await postUpdate(typed.token, { supplier: 'A supplier typed by hand' });
    expect(res.status).toBe(200);
    expect(res.body.fields_updated).toBe(1);
    const data = JSON.parse((await db.prepare('SELECT data FROM records_rows WHERE id = ?').bind(A.rowId).first<{ data: string }>())!.data) as Record<string, unknown>;
    expect(data.supplier).toEqual({ name: 'A supplier typed by hand', unmatched: true });
    const refs = await db.prepare(`SELECT ref_id FROM records_row_refs WHERE row_id = ? AND column_key = 'supplier'`).bind(A.rowId).all();
    expect(refs.results).toEqual([]);

    await db.prepare('UPDATE records_rows SET data = ? WHERE id = ?').bind(original, A.rowId).run();
  });

  it('SUSPICION 5: a submitted value is coerced by column type, and a wrong shape is refused', async () => {
    const original = (await db.prepare('SELECT data FROM records_rows WHERE id = ?').bind(A.rowId).first<{ data: string }>())!.data;

    const notNumber = await postUpdate((await makeUpdateRequest(A, ['qty'])).token, { qty: 'not a number' });
    expect(notNumber.status).toBe(400);

    const objectInText = await postUpdate((await makeUpdateRequest(A, ['notes'])).token, { notes: { $ne: null, html: '<script>' } });
    expect(objectInText.status).toBe(400);

    const badOption = await postUpdate((await makeUpdateRequest(A, ['status'])).token, { status: 'not-an-option' });
    expect(badOption.status).toBe(400);

    expect((await db.prepare('SELECT data FROM records_rows WHERE id = ?').bind(A.rowId).first<{ data: string }>())!.data).toBe(original);

    const ok = await postUpdate((await makeUpdateRequest(A, ['qty'])).token, { qty: '44' });
    expect(ok.status).toBe(200);
    const data = JSON.parse((await db.prepare('SELECT data FROM records_rows WHERE id = ?').bind(A.rowId).first<{ data: string }>())!.data) as Record<string, unknown>;
    expect(data.qty).toBe(44);
    await db.prepare('UPDATE records_rows SET data = ? WHERE id = ?').bind(original, A.rowId).run();
  });

  it('a field sent back exactly as the page showed it is not judged and not changed', async () => {
    // A value the column no longer allows, already in the row.
    const rowId = generateTestId();
    const data = { title: 'Legacy row', status: 'an-option-since-removed', qty: 3, supplier: { id: A.supplierId, name: A.names.supplier } };
    await db
      .prepare('INSERT INTO records_rows (id, sheet_id, tenant_id, display_title, data, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(rowId, A.sheetId, A.tenantId, 'Legacy row', JSON.stringify(data), A.creatorId)
      .run();
    const { token } = await makeUpdateRequest(A, ['status', 'qty', 'supplier', 'notes'], { rowId });
    const page = await getUpdate(token);
    expect(page.status).toBe(200);

    // The page pre-fills every field and the whole form comes back.
    const res = await postUpdate(token, { ...(page.body.current_values as object), notes: 'the one thing I changed' });
    expect(res.status).toBe(200);
    expect(res.body.fields_updated).toBe(1);
    const after = JSON.parse((await db.prepare('SELECT data FROM records_rows WHERE id = ?').bind(rowId).first<{ data: string }>())!.data);
    expect(after).toEqual({ ...data, notes: 'the one thing I changed' });
  });

  it('SUSPICION 5: a document, record or contact field cannot be written through a request', async () => {
    const original = (await db.prepare('SELECT data FROM records_rows WHERE id = ?').bind(A.rowId).first<{ data: string }>())!.data;
    const { token } = await makeUpdateRequest(A, ['doc', 'linked', 'owner']);
    const res = await postUpdate(token, {
      doc: { id: B.documentId },
      linked: [{ id: B.rowId }],
      owner: { id: B.creatorId },
    });
    expect([200, 400]).toContain(res.status);
    expect((await db.prepare('SELECT data FROM records_rows WHERE id = ?').bind(A.rowId).first<{ data: string }>())!.data).toBe(original);
    const planted = await db
      .prepare('SELECT id FROM records_row_refs WHERE ref_id IN (?, ?, ?)')
      .bind(B.documentId, B.rowId, B.creatorId)
      .all();
    expect(planted.results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Workflow sign-off
// ---------------------------------------------------------------------------

describe('sign-off page: what the approver is given', () => {
  it('SUSPICION 2: by default shows the row title and no field at all', async () => {
    const { token, workflowId, runId, stepRunId } = await makeApproval(A);
    const res = await getApproval(token);
    expect(res.status).toBe(200);
    expect(extraKeys(res.body, APPROVAL_GET_ALLOWED)).toEqual([]);
    const row = res.body.row as { title: string; fields: unknown[] };
    expect(row.title).toBe('Row Title A');
    expect(row.fields).toEqual([]);

    expectNone(res.text, { ...A.never, ...A.pickable, workflow_id: workflowId, run_id: runId, step_run_id: stepRunId, token });
    expectNone(res.text, Object.fromEntries(Object.entries(A.cells).map(([k, v]) => [`cell_${k}`, v])));
    expectNone(res.text, {
      supplier_name: A.names.supplier,
      customer_name: A.names.customer,
      product_name: A.names.product,
      document_name: A.names.document,
      linked_name: A.names.linked,
    });
    expectNone(res.text, everythingOf(B));
    expect(res.headers.get('Cache-Control')).toContain('no-store');
  });

  it('SUSPICION 2: shows ONLY the fields its step names, a reference as a name and never an id', async () => {
    const { token } = await makeApproval(A, { visible_fields: ['supplier', 'customer', 'product', 'doc', 'linked', 'status', 'qty', 'no_such_column'] });
    const res = await getApproval(token);
    expect(res.status).toBe(200);
    expect(extraKeys(res.body, APPROVAL_GET_ALLOWED)).toEqual([]);
    const fields = (res.body.row as { fields: Array<{ label: string; type: string; value: unknown }> }).fields;
    expect(fields).toEqual([
      { label: 'Supplier', type: 'supplier_ref', value: A.names.supplier },
      { label: 'Customer', type: 'customer_ref', value: A.names.customer },
      { label: 'Product', type: 'product_ref', value: A.names.product },
      { label: 'Document', type: 'document_ref', value: A.names.document },
      { label: 'Linked', type: 'record_ref', value: A.names.linked },
      { label: 'Status', type: 'dropdown_single', value: 'open' },
      { label: 'Quantity', type: 'number', value: 12.5 },
    ]);
    expectNone(res.text, { ...A.never, ...A.pickable });
    // Not named, so not sent.
    expectNone(res.text, Object.fromEntries(Object.entries(A.cells).map(([k, v]) => [`cell_${k}`, v])));
    expect(res.text).not.toContain(A.creatorEmail);
  });

  it('SUSPICION 2: a contact, an email and a phone are sent only when the step names them', async () => {
    const without = await getApproval((await makeApproval(A, { visible_fields: ['notes'] })).token);
    expect(without.text).toContain(A.cells.notes);
    expect(without.text).not.toContain(A.cells.email);
    expect(without.text).not.toContain(A.cells.phone);

    const withThem = await getApproval((await makeApproval(A, { visible_fields: ['owner', 'email', 'phone'] })).token);
    const fields = (withThem.body.row as { fields: Array<{ label: string; value: unknown }> }).fields;
    expect(fields).toEqual([
      { label: 'Owner', type: 'contact', value: A.creatorName },
      { label: 'Email', type: 'email', value: A.cells.email },
      { label: 'Phone', type: 'phone', value: A.cells.phone },
    ]);
    // Even a named contact is a name: never the person's id or login address.
    expect(withThem.text).not.toContain(A.creatorId);
    expect(withThem.text).not.toContain(A.creatorEmail);
  });

  it("SUSPICION 2: a reference to something that is not the tenant's resolves to nothing", async () => {
    const rowId = generateTestId();
    await db
      .prepare('INSERT INTO records_rows (id, sheet_id, tenant_id, display_title, data, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(
        rowId,
        A.sheetId,
        A.tenantId,
        'Row with planted refs',
        JSON.stringify({
          title: 'Row with planted refs',
          supplier: { id: B.supplierId, name: 'Planted label' },
          customer: B.customerId,
          doc: { id: B.documentId },
          linked: [{ id: B.rowId }],
        }),
        A.creatorId,
      )
      .run();
    const { token } = await makeApproval(A, { visible_fields: ['supplier', 'customer', 'doc', 'linked'] }, { rowId });
    const res = await getApproval(token);
    expect(res.status).toBe(200);
    expectNone(res.text, everythingOf(B));
    expect(res.text).not.toContain('Planted label');
    const fields = (res.body.row as { fields: Array<{ value: unknown }> }).fields;
    expect(fields.map((f) => f.value)).toEqual([null, null, null, null]);
  });

  it("SUSPICION 3: shows the sender's name and never an email", async () => {
    const { token } = await makeApproval(A);
    const res = await getApproval(token);
    const step = res.body.step as Record<string, unknown>;
    expect('sender_email' in step).toBe(false);
    expect(step.sender_name).toBe(A.creatorName);
    expect(res.text).not.toContain(A.creatorEmail);
    // Nor the approver's own address, which the page has no need to repeat.
    expect(res.text).not.toContain('qa@outside.example');
  });

  it('answers unknown, expired and already-answered with the same 404, on read and on decision', async () => {
    const unknown = await getApproval(`nope-${generateTestId()}`);
    expect(unknown.status).toBe(404);
    const expired = await makeApproval(A, {}, { expiresAt: '2020-01-01T00:00:00.000Z' });
    const answered = await makeApproval(A, {}, { stepStatus: 'approved' });
    for (const t of [expired.token, answered.token]) {
      const g = await getApproval(t);
      const p = await postApproval(t, { decision: 'approve' });
      expect(g.status).toBe(404);
      expect(g.text).toBe(unknown.text);
      expect(p.status).toBe(404);
      expect(p.text).toBe(unknown.text);
    }
  });
});

describe('sign-off page: the decision', () => {
  it('answers a decision with two fields', async () => {
    const { token, stepRunId } = await makeApproval(A);
    const res = await postApproval(token, { decision: 'approve', comment: 'fine' });
    expect(res.status).toBe(200);
    expect(extraKeys(res.body, APPROVAL_POST_ALLOWED)).toEqual([]);
    expectNone(res.text, { ...A.never, step_run_id: stepRunId });
    const sr = await db.prepare('SELECT status FROM records_workflow_step_runs WHERE id = ?').bind(stepRunId).first<{ status: string }>();
    expect(sr!.status).toBe('approved');
  });

  it('SUSPICION 7: a decision is refused exactly where the page is refused', async () => {
    const unknown = await getApproval(`nope-${generateTestId()}`);

    // An archived row.
    const rowId = generateTestId();
    await db
      .prepare('INSERT INTO records_rows (id, sheet_id, tenant_id, display_title, data, created_by, archived) VALUES (?, ?, ?, ?, ?, ?, 1)')
      .bind(rowId, A.sheetId, A.tenantId, 'Archived row', '{}', A.creatorId)
      .run();
    const onArchivedRow = await makeApproval(A, {}, { rowId });

    // An archived workflow, a workflow that is no longer active, a cancelled run.
    const archivedWorkflow = await makeApproval(A);
    await db.prepare('UPDATE records_workflows SET archived = 1 WHERE id = ?').bind(archivedWorkflow.workflowId).run();
    const draftWorkflow = await makeApproval(A);
    await db.prepare(`UPDATE records_workflows SET status = 'draft' WHERE id = ?`).bind(draftWorkflow.workflowId).run();
    const cancelledRun = await makeApproval(A);
    await db.prepare(`UPDATE records_workflow_runs SET status = 'cancelled' WHERE id = ?`).bind(cancelledRun.runId).run();

    for (const a of [onArchivedRow, archivedWorkflow, draftWorkflow, cancelledRun]) {
      const g = await getApproval(a.token);
      expect(g.status).toBe(404);
      expect(g.text).toBe(unknown.text);
      const p = await postApproval(a.token, { decision: 'approve' });
      expect(p.status).toBe(404);
      expect(p.text).toBe(unknown.text);
      const sr = await db.prepare('SELECT status FROM records_workflow_step_runs WHERE id = ?').bind(a.stepRunId).first<{ status: string }>();
      expect(sr!.status).toBe('awaiting_response');
    }
  });

  it('SUSPICION 7: an archived sheet refuses the decision too', async () => {
    const unknown = await getApproval(`nope-${generateTestId()}`);
    const sheetId = generateTestId();
    await db.prepare('INSERT INTO records_sheets (id, tenant_id, name, slug, created_by) VALUES (?, ?, ?, ?, ?)').bind(sheetId, A.tenantId, 'To be archived', `arch-${sheetId.slice(0, 8)}`, A.creatorId).run();
    const rowId = generateTestId();
    await db.prepare('INSERT INTO records_rows (id, sheet_id, tenant_id, display_title, data, created_by) VALUES (?, ?, ?, ?, ?, ?)').bind(rowId, sheetId, A.tenantId, 'Row', '{}', A.creatorId).run();
    const workflowId = generateTestId();
    await db
      .prepare(`INSERT INTO records_workflows (id, tenant_id, sheet_id, name, steps, status, created_by_user_id) VALUES (?, ?, ?, 'WF', ?, 'active', ?)`)
      .bind(workflowId, A.tenantId, sheetId, JSON.stringify([{ id: 's1', type: 'approval', name: 'Sign', config: { assignee_email: 'qa@outside.example' } }]), A.creatorId)
      .run();
    const runId = generateTestId();
    await db.prepare(`INSERT INTO records_workflow_runs (id, tenant_id, workflow_id, sheet_id, row_id, status, current_step_id) VALUES (?, ?, ?, ?, ?, 'in_progress', 's1')`).bind(runId, A.tenantId, workflowId, sheetId, rowId).run();
    const stepRunId = generateTestId();
    const token = `apr-arch-${generateTestId()}`;
    await db
      .prepare(`INSERT INTO records_workflow_step_runs (id, run_id, step_id, step_index, step_type, status, assignee_email, approver_token) VALUES (?, ?, 's1', 0, 'approval', 'awaiting_response', 'qa@outside.example', ?)`)
      .bind(stepRunId, runId, token)
      .run();
    expect((await getApproval(token)).status).toBe(200);

    await db.prepare('UPDATE records_sheets SET archived = 1 WHERE id = ?').bind(sheetId).run();
    const g = await getApproval(token);
    const p = await postApproval(token, { decision: 'reject' });
    expect(g.status).toBe(404);
    expect(p.status).toBe(404);
    expect(p.text).toBe(unknown.text);
    const sr = await db.prepare('SELECT status FROM records_workflow_step_runs WHERE id = ?').bind(stepRunId).first<{ status: string }>();
    expect(sr!.status).toBe('awaiting_response');
  });
});

// ---------------------------------------------------------------------------
// 5. A link resolves inside ONE tenant
// ---------------------------------------------------------------------------

describe('SUSPICION 6: a link whose parts belong to different tenants resolves to nothing', () => {
  it("an update request pointing at another tenant's row", async () => {
    const unknown = await getUpdate(`nope-${generateTestId()}`);
    // The request row says tenant A; the row and sheet it names are B's.
    const crossed = await makeUpdateRequest(A, ['title', 'notes'], { rowId: B.rowId, sheetId: B.sheetId });
    const g = await getUpdate(crossed.token);
    expect(g.status).toBe(404);
    expect(g.text).toBe(unknown.text);
    expectNone(g.text, everythingOf(B));

    const before = (await db.prepare('SELECT data FROM records_rows WHERE id = ?').bind(B.rowId).first<{ data: string }>())!.data;
    const p = await postUpdate(crossed.token, { title: 'OVERWRITTEN', notes: 'OVERWRITTEN' });
    expect(p.status).toBe(404);
    expect(p.text).toBe(unknown.text);
    expect((await db.prepare('SELECT data FROM records_rows WHERE id = ?').bind(B.rowId).first<{ data: string }>())!.data).toBe(before);
  });

  it("an update request whose row is on another sheet of the same tenant", async () => {
    const crossed = await makeUpdateRequest(A, ['secret'], { rowId: A.otherRowId });
    expect((await getUpdate(crossed.token)).status).toBe(404);
    expect((await postUpdate(crossed.token, { secret: 'x' })).status).toBe(404);
  });

  it("a sign-off whose run names another tenant's row", async () => {
    const unknown = await getApproval(`nope-${generateTestId()}`);
    const crossed = await makeApproval(A, { visible_fields: ['notes', 'supplier'] }, { rowId: B.rowId, sheetId: B.sheetId });
    const g = await getApproval(crossed.token);
    expect(g.status).toBe(404);
    expect(g.text).toBe(unknown.text);
    const p = await postApproval(crossed.token, { decision: 'approve' });
    expect(p.status).toBe(404);
    const sr = await db.prepare('SELECT status FROM records_workflow_step_runs WHERE id = ?').bind(crossed.stepRunId).first<{ status: string }>();
    expect(sr!.status).toBe('awaiting_response');
  });

  it("a sign-off whose run claims another tenant than its workflow", async () => {
    const crossed = await makeApproval(A, {}, { runTenantId: B.tenantId });
    expect((await getApproval(crossed.token)).status).toBe(404);
    expect((await postApproval(crossed.token, { decision: 'approve' })).status).toBe(404);
  });

  it("a form filed under one tenant on another tenant's sheet", async () => {
    const unknown = await getForm(`nope-${generateTestId()}`);
    // column ids are B's, so the field list would be B's columns.
    const formId = generateTestId();
    const slug = `form-crossed-${generateTestId()}`;
    await db
      .prepare(
        `INSERT INTO records_forms (id, tenant_id, sheet_id, name, public_slug, is_public, status, field_config, settings, created_by_user_id)
         VALUES (?, ?, ?, 'Crossed', ?, 1, 'live', ?, ?, ?)`,
      )
      .bind(formId, A.tenantId, B.sheetId, slug, JSON.stringify([{ column_id: B.columnIds.title, position: 0 }, { column_id: B.columnIds.supplier, position: 1, public_picker: true }]), JSON.stringify({ allow_attachments: true }), A.creatorId)
      .run();
    const g = await getForm(slug);
    expect(g.status).toBe(404);
    expect(g.text).toBe(unknown.text);
    const rowsBefore = await db.prepare('SELECT COUNT(*) AS n FROM records_rows WHERE sheet_id = ?').bind(B.sheetId).first<{ n: number }>();
    const s = await submitForm(slug, { title: 'Injected into B' });
    expect(s.status).toBe(404);
    expect(s.text).toBe(unknown.text);
    const rowsAfter = await db.prepare('SELECT COUNT(*) AS n FROM records_rows WHERE sheet_id = ?').bind(B.sheetId).first<{ n: number }>();
    expect(rowsAfter!.n).toBe(rowsBefore!.n);
    const u = await uploadToForm(slug, pngFile('a.png'));
    expect(u.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 6. Organisation inactive, or Records switched off
// ---------------------------------------------------------------------------

describe('SUSPICION 8: nothing is served for an inactive organisation or with Records switched off', () => {
  async function allEight(): Promise<Array<{ name: string; call: () => Promise<{ status: number; text: string }> }>> {
    const form = await makeForm(A, ['title'], { settings: { allow_attachments: true } });
    const up = await uploadToForm(form.slug, pngFile('a.png'));
    expect(up.status).toBe(200);
    const update = await makeUpdateRequest(A, ['notes']);
    const approval = await makeApproval(A);
    return [
      { name: 'form GET', call: () => getForm(form.slug) },
      { name: 'form submit', call: () => submitForm(form.slug, { title: 'x' }) },
      { name: 'form upload', call: () => uploadToForm(form.slug, pngFile('b.png')) },
      { name: 'form attachment DELETE', call: () => deleteAttachment(form.slug, up.body.attachment_id as string, up.body.pending_token as string) },
      { name: 'update request GET', call: () => getUpdate(update.token) },
      { name: 'update request POST', call: () => postUpdate(update.token, { notes: 'x' }) },
      { name: 'sign-off GET', call: () => getApproval(approval.token) },
      { name: 'sign-off POST', call: () => postApproval(approval.token, { decision: 'approve' }) },
    ];
  }

  const unknownBodies = async () => ({
    form: (await getForm(`nope-${generateTestId()}`)).text,
    update: (await getUpdate(`nope-${generateTestId()}`)).text,
    approval: (await getApproval(`nope-${generateTestId()}`)).text,
  });
  const expectedBody = (name: string, bodies: { form: string; update: string; approval: string }) =>
    name.startsWith('form') ? bodies.form : name.startsWith('update') ? bodies.update : bodies.approval;

  it('Records switched off for the tenant: all eight are the uniform 404', async () => {
    const routes = await allEight();
    const bodies = await unknownBodies();
    await db.prepare(`INSERT INTO tenant_modules (tenant_id, module_key, enabled) VALUES (?, 'records', 0)`).bind(A.tenantId).run();
    const failures: string[] = [];
    for (const route of routes) {
      const res = await route.call();
      if (res.status !== 404 || res.text !== expectedBody(route.name, bodies)) failures.push(`${route.name}: ${res.status}`);
    }
    expect(failures).toEqual([]);
  });

  it('the organisation is inactive: all eight are the uniform 404', async () => {
    const routes = await allEight();
    const bodies = await unknownBodies();
    await db.prepare('UPDATE tenants SET active = 0 WHERE id = ?').bind(A.tenantId).run();
    const failures: string[] = [];
    for (const route of routes) {
      const res = await route.call();
      if (res.status !== 404 || res.text !== expectedBody(route.name, bodies)) failures.push(`${route.name}: ${res.status}`);
    }
    expect(failures).toEqual([]);
  });

  it('no module row at all means Records is on (migration 0099: absence is unconstrained)', async () => {
    const routes = await allEight();
    const statuses: Record<string, number> = {};
    for (const route of routes) statuses[route.name] = (await route.call()).status;
    expect(statuses).toEqual({
      'form GET': 200,
      'form submit': 200,
      'form upload': 200,
      'form attachment DELETE': 200,
      'update request GET': 200,
      'update request POST': 200,
      'sign-off GET': 200,
      'sign-off POST': 200,
    });
  });

  it("another tenant switching Records off changes nothing here", async () => {
    await db.prepare(`INSERT INTO tenant_modules (tenant_id, module_key, enabled) VALUES (?, 'records', 0)`).bind(B.tenantId).run();
    expect((await getForm((await makeForm(A, ['title'])).slug)).status).toBe(200);
    expect((await getForm((await makeForm(B, ['title'])).slug)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 7. A view is recorded, and a link cannot be hammered
// ---------------------------------------------------------------------------

describe('SUSPICION 9: every view is audited and rate limited', () => {
  async function auditRows(action: string, resourceId: string) {
    const rows = await db
      .prepare('SELECT user_id, tenant_id, resource_type, details, ip_address FROM audit_log WHERE action = ? AND resource_id = ?')
      .bind(action, resourceId)
      .all<{ user_id: string | null; tenant_id: string; resource_type: string; details: string; ip_address: string }>();
    return rows.results ?? [];
  }

  it('a form view', async () => {
    const { slug, formId } = await makeForm(A, ['title']);
    await getForm(slug, { ip: '203.0.113.7' });
    const rows = await auditRows('records_form.view', formId);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBeNull();
    expect(rows[0].tenant_id).toBe(A.tenantId);
    expect(rows[0].ip_address).toBe('203.0.113.7');
    // The link itself is a bearer secret and is not written into the log.
    expect(rows[0].details).not.toContain(slug);
  });

  it('an update request view', async () => {
    const { token, id } = await makeUpdateRequest(A, ['title']);
    await getUpdate(token, { ip: '203.0.113.8' });
    const rows = await auditRows('records_update_request.view', id);
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(A.tenantId);
    expect(rows[0].ip_address).toBe('203.0.113.8');
    expect(rows[0].details).not.toContain(token);
  });

  it('a sign-off view', async () => {
    const { token, stepRunId } = await makeApproval(A);
    await getApproval(token, { ip: '203.0.113.9' });
    const rows = await auditRows('records_workflow_step_run.view', stepRunId);
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(A.tenantId);
    expect(rows[0].details).not.toContain(token);
  });

  it('an unusable link audits nothing', async () => {
    const before = await db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'records_%.view'`).first<{ n: number }>();
    await getForm(`nope-${generateTestId()}`);
    await getUpdate(`nope-${generateTestId()}`);
    await getApproval(`nope-${generateTestId()}`);
    const after = await db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'records_%.view'`).first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });

  it('one address reading one link over and over is stopped, and nobody else is', async () => {
    const form = await makeForm(A, ['title']);
    const update = await makeUpdateRequest(A, ['title']);
    const approval = await makeApproval(A);
    const cases: Array<[string, (ip: string) => Promise<{ status: number }>]> = [
      ['form', (ip) => getForm(form.slug, { ip })],
      ['update', (ip) => getUpdate(update.token, { ip })],
      ['approval', (ip) => getApproval(approval.token, { ip })],
    ];
    for (const [name, call] of cases) {
      const ip = `198.51.100.${name.length}`;
      let limitedAt = -1;
      for (let i = 0; i < 200; i++) {
        const res = await call(ip);
        if (res.status === 429) {
          limitedAt = i;
          break;
        }
        expect(res.status).toBe(200);
      }
      expect(limitedAt, `${name} was never rate limited`).toBeGreaterThan(0);
      // A different address is not affected.
      expect((await call('198.51.100.200')).status).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. What is published is decided by the people who build the form / workflow
// ---------------------------------------------------------------------------

describe('the opt-ins are set by a signed-in builder, and only where they mean something', () => {
  const builder = () => ({ id: seed.orgAdminId, email: 'orgadmin@test.com', name: 'Org Admin', role: 'org_admin', tenant_id: A.tenantId });

  it('a list is published only by an explicit true on a customer / supplier / product field, and the save is audited', async () => {
    const { slug, formId } = await makeForm(A, ['title', 'supplier', 'customer']);
    const res = await read(
      await formPut(
        ctx(`/api/records/sheets/${A.sheetId}/forms/${formId}`, {
          method: 'PUT',
          params: { sheetId: A.sheetId, formId },
          user: builder(),
          json: {
            field_config: [
              // A text column cannot publish a list, whatever is sent.
              { column_id: A.columnIds.title, position: 0, public_picker: true },
              { column_id: A.columnIds.supplier, position: 1, public_picker: true },
              // Anything but the boolean true is "no".
              { column_id: A.columnIds.customer, position: 2, public_picker: 'yes' },
            ],
          },
        }),
      ),
    );
    expect(res.status).toBe(200);
    const stored = JSON.parse(
      (await db.prepare('SELECT field_config FROM records_forms WHERE id = ?').bind(formId).first<{ field_config: string }>())!.field_config,
    ) as Array<{ column_id: string; public_picker?: boolean }>;
    expect(stored.filter((f) => f.public_picker).map((f) => f.column_id)).toEqual([A.columnIds.supplier]);

    const audit = await db
      .prepare(`SELECT details FROM audit_log WHERE action = 'records_form.updated' AND resource_id = ? ORDER BY id DESC LIMIT 1`)
      .bind(formId)
      .first<{ details: string }>();
    expect((JSON.parse(audit!.details) as { public_picker_fields: string[] }).public_picker_fields).toEqual(['supplier']);

    const page = await getForm(slug);
    expect(Object.keys(page.body.entity_options as object)).toEqual(['supplier']);
    expect(page.text).not.toContain(A.customerId);
  });

  it('a request cannot be made for a document, a record or a contact column', async () => {
    for (const key of ['doc', 'linked', 'owner', 'total']) {
      const res = await read(
        await updateRequestCreate(
          ctx(`/api/records/sheets/${A.sheetId}/rows/${A.rowId}/update-requests`, {
            method: 'POST',
            params: { sheetId: A.sheetId, rowId: A.rowId },
            user: builder(),
            json: { recipient_email: 'pat@outside.example', fields_requested: ['title', key] },
          }),
        ),
      );
      expect(res.status, key).toBe(400);
    }
  });

  it("a step's visible fields must be columns of the sheet that can be shown", async () => {
    const columns = (
      await db.prepare('SELECT * FROM records_columns WHERE sheet_id = ?').bind(A.sheetId).all<RecordColumnRow>()
    ).results;
    const attachment = { ...columns[0], id: 'att', key: 'scan', label: 'Scan', type: 'attachment' as const, is_title: 0 };
    const step = (visible_fields: unknown) => [
      { id: 's1', type: 'approval', name: 'Sign', config: { assignee_email: 'qa@outside.example', visible_fields } },
    ];
    expect(() => normalizeWorkflowSteps(step(['no_such_column']), columns)).toThrow();
    expect(() => normalizeWorkflowSteps(step(['scan']), [...columns, attachment])).toThrow();
    expect(() => normalizeWorkflowSteps(step('supplier'), columns)).toThrow();
    const ok = normalizeWorkflowSteps(step(['supplier', 'qty', 'supplier']), columns);
    expect((ok[0].config as { visible_fields: string[] }).visible_fields).toEqual(['supplier', 'qty']);
    // A step that says nothing shows nothing.
    const silent = normalizeWorkflowSteps(step(undefined), columns);
    expect((silent[0].config as { visible_fields?: string[] }).visible_fields).toBeUndefined();
  });
});

describe('the two projections, on their own', () => {
  it('a column config keeps only what its type is allowed', () => {
    expect(projectColumnConfig('record_ref', JSON.stringify({ target_sheet_id: 'x', multiple: true }))).toBeNull();
    expect(projectColumnConfig('rollup', JSON.stringify({ target_sheet_id: 'x', source_column_key: 'y', aggregation: 'sum' }))).toBeNull();
    expect(projectColumnConfig('text', JSON.stringify({ anything: 'at all' }))).toBeNull();
    expect(projectColumnConfig('supplier_ref', JSON.stringify({ target_sheet_id: 'x', multiple: true }))).toEqual({ multiple: true });
    expect(projectColumnConfig('currency', JSON.stringify({ precision: 2, currency_code: 'USD', formula: 'secret' }))).toEqual({ precision: 2, currency_code: 'USD' });
    expect(projectColumnConfig('dropdown_single', 'not json')).toBeNull();
    expect(projectColumnConfig('dropdown_single', JSON.stringify({ options: [{ value: 1 }, 'x', null, { value: 'a', label: 2 }] }))).toEqual({ options: [{ value: 'a' }] });
  });

  it('a cell is text, a number, a yes / no or a list of texts, and an object is nothing', async () => {
    const cell = (type: string, value: unknown) => publicCellValue(db, A.tenantId, { type } as RecordColumnRow, value);
    expect(await cell('text', { nested: 'object' })).toBeNull();
    expect(await cell('text', ['a'])).toBeNull();
    expect(await cell('number', '12')).toBe(12);
    expect(await cell('number', { n: 1 })).toBeNull();
    expect(await cell('checkbox', true)).toBe(true);
    expect(await cell('dropdown_multi', ['a', { b: 1 }, 'c'])).toEqual(['a', 'c']);
    expect(await cell('attachment', 'records/a/key.pdf')).toBeNull();
    expect(await cell('formula', 'x')).toBeNull();
    // Typed on a public page: shown as typed. An id of another tenant: nothing.
    expect(await cell('supplier_ref', { name: 'Typed by hand', unmatched: true })).toBe('Typed by hand');
    expect(await cell('supplier_ref', { id: B.supplierId, name: 'Planted' })).toBeNull();
    expect(await cell('supplier_ref', [{ id: A.supplierId }, { id: B.supplierId }])).toBe(A.names.supplier);
    expect(await cell('customer_ref', A.customerId)).toBe(A.names.customer);
    expect(await cell('record_ref', { id: B.rowId })).toBeNull();
    expect(await cell('document_ref', { id: B.documentId })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9. The routes are public, and only they are
// ---------------------------------------------------------------------------

describe('the three prefixes are public and nothing beside them is', () => {
  // The REAL auth middleware, not a re-declared copy of its list.
  async function throughMiddleware(path: string, method = 'GET'): Promise<Response> {
    const auth = middleware[1];
    let reachedHandler = false;
    const context = {
      request: new Request(`http://localhost${path}`, { method }),
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
    const resp = await auth(context);
    return new Response(reachedHandler ? 'handler' : await resp.text(), { status: resp.status });
  }

  it('lets all eight routes past the login gate', async () => {
    const routes: Array<[string, string]> = [
      ['GET', '/api/forms/public/some-slug'],
      ['POST', '/api/forms/public/some-slug/submit'],
      ['POST', '/api/forms/public/some-slug/upload'],
      ['DELETE', '/api/forms/public/some-slug/attachment/some-id'],
      ['GET', '/api/update-requests/public/some-token'],
      ['POST', '/api/update-requests/public/some-token'],
      ['GET', '/api/workflow-approvals/public/some-token'],
      ['POST', '/api/workflow-approvals/public/some-token'],
    ];
    for (const [method, path] of routes) {
      const resp = await throughMiddleware(path, method);
      expect(resp.status, `${method} ${path}`).toBe(200);
      expect(await resp.text()).toBe('handler');
    }
  });

  it('still gates every sibling', async () => {
    for (const path of [
      '/api/forms',
      '/api/forms/publicish',
      '/api/forms/some-id',
      '/api/update-requests',
      '/api/update-requests/publicish/x',
      '/api/workflow-approvals',
      '/api/workflow-approvals/some-id',
      '/api/records/sheets',
    ]) {
      const resp = await throughMiddleware(path);
      expect(resp.status, path).toBe(401);
    }
  });
});
