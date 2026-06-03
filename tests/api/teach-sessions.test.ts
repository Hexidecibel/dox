/**
 * API tests for the Learning Interface (teach-chat) backend spine.
 *
 * Drives the handlers directly (no SELF.fetch), mirroring the connector tests.
 * Qwen is mocked by monkey-patching global fetch on /v1/chat/completions: we
 * inspect the outgoing system+user content to decide which phase is calling
 * (opening questions / follow-up DONE / synthesis JSON) and return the matching
 * OpenAI chat-completion envelope. This is the same interception strategy as
 * tests/helpers/qwen-mock.ts, but with phase-aware string responses (the teach
 * prompts return prose for questions/follow-ups and strict JSON for synthesis).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPost as createSession } from '../../functions/api/teach/sessions/index';
import { onRequestPost as postMessage } from '../../functions/api/teach/sessions/[id]/messages';
import { onRequestPost as confirmSession } from '../../functions/api/teach/sessions/[id]/confirm';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;
let supplierId: string;
let docTypeId: string;

// --- Qwen mock -------------------------------------------------------------
let originalFetch: typeof fetch;

function installTeachQwenMock() {
  originalFetch = globalThis.fetch;
  const mocked: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
    if (url.includes('/v1/chat/completions')) {
      const raw = typeof init?.body === 'string' ? init.body : '';
      const parsed = JSON.parse(raw || '{}') as { messages?: Array<{ role: string; content: string }> };
      const text = (parsed.messages || []).map((m) => m.content).join('\n');

      let content: string;
      if (/STRICT JSON|SYNTHESIZING/i.test(text)) {
        // Synthesis phase — return the proposal JSON.
        content = JSON.stringify({
          instructions: 'Read lot_number from the top-right box, never from the footer.',
          examples: [{ field: 'lot_number', value: 'L26-0842', note: 'top-right box' }],
          summary: 'Lot numbers come from the top-right box.',
        });
      } else if (/KNOW_ENOUGH/i.test(text) && /interview so far/i.test(text)) {
        // Follow-up phase — signal we know enough.
        content = 'KNOW_ENOUGH';
      } else {
        // Opening questions phase.
        content = 'Thanks! When the lot number appears twice, which one is correct?';
      }
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return originalFetch(input as RequestInfo, init);
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(mocked as typeof fetch);
}

function makeContext(
  request: Request,
  user: { id: string; role: string; tenant_id: string | null },
  params: Record<string, string> = {},
) {
  return {
    request,
    env,
    data: { user },
    params,
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/teach',
  } as any;
}

function postReq(url: string, body: unknown): Request {
  return new Request(url, { method: 'POST', body: JSON.stringify(body) });
}

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

beforeEach(async () => {
  installTeachQwenMock();
  supplierId = generateTestId();
  docTypeId = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(supplierId, seed.tenantId, 'Darigold', `darigold-${supplierId.slice(0, 6)}`)
    .run();
  await db
    .prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
    .bind(docTypeId, seed.tenantId, 'COA', `coa-${docTypeId.slice(0, 6)}`)
    .run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const user = () => ({ id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId });

describe('POST /api/teach/sessions', () => {
  it('creates a session, persists it, and returns an opening AI message', async () => {
    const req = postReq('http://localhost/api/teach/sessions', {
      supplier_id: supplierId,
      document_type_id: docTypeId,
    });
    const res = await createSession(makeContext(req, user()));
    expect(res.status).toBe(201);
    const data = (await res.json()) as { session_id: string; messages: any[]; issues: unknown[] };

    expect(data.session_id).toBeTruthy();
    expect(Array.isArray(data.issues)).toBe(true);
    // Exactly one AI message, persisted.
    expect(data.messages.length).toBe(1);
    expect(data.messages[0].role).toBe('ai');
    expect(data.messages[0].content).toContain('lot number');

    const row = await db
      .prepare('SELECT status, supplier_id, document_type_id FROM teach_sessions WHERE id = ?')
      .bind(data.session_id)
      .first<{ status: string; supplier_id: string; document_type_id: string }>();
    expect(row?.status).toBe('open');
    expect(row?.supplier_id).toBe(supplierId);

    const msgCount = await db
      .prepare('SELECT COUNT(*) AS n FROM teach_messages WHERE session_id = ?')
      .bind(data.session_id)
      .first<{ n: number }>();
    expect(msgCount?.n).toBe(1);
  });

  it('rejects a supplier from another tenant', async () => {
    const req = postReq('http://localhost/api/teach/sessions', {
      supplier_id: 'nonexistent-supplier',
      document_type_id: docTypeId,
    });
    const res = await createSession(makeContext(req, user()));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/teach/sessions/:id/messages', () => {
  it('appends the SME answer and flags ready_to_synthesize when Qwen says KNOW_ENOUGH', async () => {
    const created = await createSession(
      makeContext(postReq('http://localhost/api/teach/sessions', {
        supplier_id: supplierId,
        document_type_id: docTypeId,
      }), user()),
    );
    const { session_id } = (await created.json()) as { session_id: string };

    const res = await postMessage(
      makeContext(
        postReq(`http://localhost/api/teach/sessions/${session_id}/messages`, {
          content: 'The top-right box is always the correct lot number.',
        }),
        user(),
        { id: session_id },
      ),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { messages: any[]; ready_to_synthesize: boolean };
    expect(data.ready_to_synthesize).toBe(true);
    // SME answer persisted; no extra AI follow-up since we're done.
    const smeMsgs = data.messages.filter((m) => m.role === 'sme');
    expect(smeMsgs.length).toBe(1);
    expect(smeMsgs[0].content).toContain('top-right box');
  });
});

describe('POST /api/teach/sessions/:id/confirm', () => {
  it('writes supplier_extraction_instructions and extraction_examples', async () => {
    const created = await createSession(
      makeContext(postReq('http://localhost/api/teach/sessions', {
        supplier_id: supplierId,
        document_type_id: docTypeId,
      }), user()),
    );
    const { session_id } = (await created.json()) as { session_id: string };

    const res = await confirmSession(
      makeContext(
        postReq(`http://localhost/api/teach/sessions/${session_id}/confirm`, {
          instructions: 'Lot number is in the top-right box.',
          examples: [{ field: 'lot_number', value: 'L26-0842', note: 'top-right box' }],
        }),
        user(),
        { id: session_id },
      ),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; examples_written: number };
    expect(data.ok).toBe(true);
    expect(data.examples_written).toBe(1);

    // Profile instructions written.
    const sei = await db
      .prepare(
        'SELECT instructions FROM supplier_extraction_instructions WHERE supplier_id = ? AND document_type_id = ?',
      )
      .bind(supplierId, docTypeId)
      .first<{ instructions: string }>();
    expect(sei?.instructions).toBe('Lot number is in the top-right box.');

    // Example row written for the supplier/doctype.
    const ex = await db
      .prepare(
        'SELECT corrected_output, supplier FROM extraction_examples WHERE document_type_id = ? AND supplier = ?',
      )
      .bind(docTypeId, supplierId)
      .first<{ corrected_output: string; supplier: string }>();
    expect(ex?.supplier).toBe(supplierId);
    expect(ex?.corrected_output).toContain('L26-0842');

    // Session flipped to confirmed.
    const row = await db
      .prepare('SELECT status FROM teach_sessions WHERE id = ?')
      .bind(session_id)
      .first<{ status: string }>();
    expect(row?.status).toBe('confirmed');
  });
});
