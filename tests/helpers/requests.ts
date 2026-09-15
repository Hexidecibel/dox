/**
 * Shared fixtures for the supplier request portal and its staff side.
 *
 * Moved out of tests/api/supplier-request-portal.test.ts when the arrivals
 * screen (migration 0104) needed the same "issue an ask, send a file through
 * the link, approve it" sequence. Every helper takes its tenant, supplier and
 * vocabulary explicitly rather than reading test-file globals, so two files can
 * build asks against their own seed without sharing state.
 */

import { env } from 'cloudflare:test';
import { generateTestId } from './db';
import { onRequestPost as portalUpload } from '../../functions/api/supplier-requests/public/[token]/upload';
import { onRequestPut as queueUpdate } from '../../functions/api/queue/[id]';
import { itemRef, mintRequestLink } from '../../functions/lib/request-links';

/**
 * Strings that exist in the database next to everything the portal reads and
 * must never appear in a byte of its output.
 */
export const INTERNAL_NOTE = 'INTERNAL-they-always-send-the-2023-cert-escalate-to-Dan';
export const ROUTING_NOTE = 'INTERNAL-ROUTING-posted-via-Sarah-do-not-share';
export const RECIPIENT = 'internal-recipient@medosweet.example';
export const LINE_OWNER = 'INTERNAL-owner-Priya-in-QA';

export interface RequestFixture {
  tenantId: string;
  /** Issues the ask, mints the link, and is `created_by` on everything. */
  orgAdminId: string;
  supplierId: string;
  /** Typed lines cycle through these. */
  requirementIds: string[];
}

export interface TestUser {
  id: string;
  email: string;
  name: string;
  role: 'super_admin' | 'org_admin' | 'user' | 'reader';
  tenant_id: string | null;
}

export function orgAdminUser(fx: { tenantId: string; orgAdminId: string }): TestUser {
  return {
    id: fx.orgAdminId,
    email: 'orgadmin@test.com',
    name: 'Org Admin',
    role: 'org_admin',
    tenant_id: fx.tenantId,
  };
}

/** A Pages Function context, for calling a handler directly. */
export function fnContext(
  url: string,
  init: RequestInit & { user?: TestUser | null; params?: Record<string, string> } = {},
): never {
  const { user, params, ...requestInit } = init;
  const u = new URL(url, 'http://localhost');
  return {
    request: new Request(u.toString(), requestInit.method ? requestInit : { method: 'GET' }),
    env,
    data: user ? { user } : {},
    params: params ?? {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: u.pathname,
  } as never;
}

export async function readJson(resp: Response): Promise<unknown> {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * Build one issued ask with `names.length` typed lines, plus a link.
 * Every internal field that could leak is populated with a marked string.
 */
export async function makeRequest(
  fx: RequestFixture,
  names: string[],
  opts: {
    dueDate?: string | null;
    status?: string;
    tiers?: ('required' | 'recommended')[];
    supplier?: string;
  } = {},
): Promise<{ requestId: string; rootId: string; token: string; lineIds: string[] }> {
  const db = env.DB;
  const requestId = generateTestId();
  const supplier = opts.supplier ?? fx.supplierId;

  await db
    .prepare(
      `INSERT INTO document_requests
         (id, tenant_id, supplier_id, root_request_id, version, title, intro,
          due_date, assigned_to, origin, origin_ref, status, issued_at, created_by)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 'gap', 'INTERNAL-origin-ref-secret', ?, datetime('now'), ?)`,
    )
    .bind(
      requestId,
      fx.tenantId,
      supplier,
      requestId,
      'Annual supplier documentation',
      'Please send the items below.',
      opts.dueDate === undefined ? '2026-12-01' : opts.dueDate,
      fx.orgAdminId,
      opts.status ?? 'issued',
      fx.orgAdminId,
    )
    .run();

  await db
    .prepare(
      `INSERT INTO request_routing
         (id, tenant_id, request_id, issued_by, version, channel, recipient, internal_notes)
       VALUES (?, ?, ?, ?, 1, 'portal', ?, ?)`,
    )
    .bind(generateTestId(), fx.tenantId, requestId, fx.orgAdminId, RECIPIENT, ROUTING_NOTE)
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
        fx.tenantId,
        requestId,
        fx.requirementIds[i % fx.requirementIds.length],
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
    tenantId: fx.tenantId,
    rootRequestId: requestId,
    supplierId: supplier,
    dueDate: '2026-12-01',
    createdBy: fx.orgAdminId,
  });

  return { requestId, rootId: requestId, token: token!, lineIds };
}

export async function refsFor(token: string, lineIds: string[]): Promise<string[]> {
  return Promise.all(lineIds.map((id) => itemRef(token, id)));
}

/** Send one file through the public link, claimed against `refs`. */
export async function upload(
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

  const resp = await portalUpload(
    fnContext(`/api/supplier-requests/public/${token}/upload`, {
      method: 'POST',
      body: form,
      params: { token },
    }),
  );
  return { status: resp.status, body: await readJson(resp) };
}

/** Authenticated PUT against one queue item. */
export async function queuePut(
  queueId: string,
  body: Record<string, unknown>,
  user: TestUser,
): Promise<{ status: number; body: unknown }> {
  const resp = await queueUpdate(
    fnContext(`/api/queue/${queueId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      params: { id: queueId },
      user,
    }),
  );
  return { status: resp.status, body: await readJson(resp) };
}

/**
 * Stand in for the worker, then approve the queue item a portal upload
 * produced. Returns the document the approval created.
 */
export async function extractAndApprove(
  fx: RequestFixture,
  queueId: string,
  user: TestUser,
): Promise<string> {
  const db = env.DB;
  let docTypeId = (
    await db
      .prepare('SELECT id FROM document_types WHERE tenant_id = ? AND slug = ?')
      .bind(fx.tenantId, 'coa')
      .first<{ id: string }>()
  )?.id;
  if (!docTypeId) {
    docTypeId = generateTestId();
    await db
      .prepare(
        `INSERT INTO document_types (id, tenant_id, name, slug, active)
         VALUES (?, ?, 'COA', 'coa', 1)`,
      )
      .bind(docTypeId, fx.tenantId)
      .run();
  }
  await db
    .prepare(
      `UPDATE processing_queue
          SET document_type_id = ?, processing_status = 'ready',
              extracted_text = 'certificate text',
              ai_fields = ?, ai_confidence = 'high', confidence_score = 0.9
        WHERE id = ?`,
    )
    .bind(
      docTypeId,
      JSON.stringify({ supplier_name: 'Portal Supplier', lot_number: 'L-1', product_name: 'Cream' }),
      queueId,
    )
    .run();

  const resp = await queuePut(
    queueId,
    { status: 'approved', fields: { lot_number: 'L-1' }, supplier_id: fx.supplierId },
    user,
  );
  if (resp.status !== 200) {
    throw new Error(`approve failed: ${resp.status} ${JSON.stringify(resp.body)}`);
  }
  const row = await db
    .prepare('SELECT document_id FROM request_uploads WHERE queue_id = ?')
    .bind(queueId)
    .first<{ document_id: string | null }>();
  if (!row?.document_id) throw new Error('approve did not link a document to the upload');
  return row.document_id;
}
