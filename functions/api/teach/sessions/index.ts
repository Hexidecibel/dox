/**
 * POST /api/teach/sessions
 *
 * Start a Learning Interface session for a (supplier, document_type) pair.
 * Runs the uncertainty analyzer to find recurring extraction ambiguities,
 * persists them on the session, asks Qwen (buildQuestionsPrompt) for the
 * opening interview message, persists it, and returns the new session.
 *
 * Auth: super_admin, org_admin, user — matches extraction-instructions.
 */

import { generateId, logAudit, getClientIp } from '../../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../../lib/permissions';
import type { TeachSessionSummary } from '../../../../shared/types';
import type { Env, User } from '../../../lib/types';
import { analyzeUncertainty } from '../../../lib/teach/uncertainty';
import { callQwenChat, buildQuestionsPrompt } from '../../../lib/teach/qwen';
import {
  loadMessages,
  serializeMessage,
  resolveTenantId,
  insertMessage,
  parseIssues,
  loadSessionRow,
} from '../../../lib/teach/session';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const body = (await context.request.json()) as {
      supplier_id?: string;
      document_type_id?: string;
      tenant_id?: string;
    };

    if (!body.supplier_id) throw new BadRequestError('supplier_id is required');
    if (!body.document_type_id) throw new BadRequestError('document_type_id is required');

    const tenantId = resolveTenantId(user, body.tenant_id);
    if (!tenantId) {
      throw new BadRequestError('tenant_id is required for super_admin');
    }
    requireTenantAccess(user, tenantId);

    // Validate supplier + doctype belong to the tenant (fail fast).
    const supplier = await context.env.DB.prepare(
      'SELECT id FROM suppliers WHERE id = ? AND tenant_id = ?',
    )
      .bind(body.supplier_id, tenantId)
      .first();
    if (!supplier) {
      throw new BadRequestError('Supplier not found or does not belong to this tenant');
    }
    const docType = await context.env.DB.prepare(
      'SELECT id FROM document_types WHERE id = ? AND tenant_id = ?',
    )
      .bind(body.document_type_id, tenantId)
      .first();
    if (!docType) {
      throw new BadRequestError('Document type not found or does not belong to this tenant');
    }

    // 0. Resume an existing in-progress interview for this exact pair, if any.
    // "open" (still collecting answers) is the only status we resume; once a
    // session is synthesized/confirmed/abandoned it's terminal and a fresh
    // interview should start. This lets the reviewer keep one running interview
    // while working through multiple docs of the same supplier.
    //
    // Invariant: at most one active `open` session per
    // (tenant, supplier, doctype). The newest open row is resumed; any older
    // open rows are stale orphans (a chat that was started then abandoned) and
    // get flipped to `abandoned` below so they stop accumulating forever.
    const existing = await context.env.DB.prepare(
      `SELECT id FROM teach_sessions
       WHERE tenant_id = ? AND supplier_id = ? AND document_type_id = ? AND status = 'open'
       ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(tenantId, body.supplier_id, body.document_type_id)
      .first<{ id: string }>();

    // Archive every OTHER open session for this pair (no-op when none exist or
    // there's nothing to resume). Keeps a single live interview per combo.
    const archived = await context.env.DB.prepare(
      `UPDATE teach_sessions
         SET status = 'abandoned', updated_at = datetime('now')
       WHERE tenant_id = ? AND supplier_id = ? AND document_type_id = ?
         AND status = 'open' AND id != ?`,
    )
      .bind(tenantId, body.supplier_id, body.document_type_id, existing?.id ?? '')
      .run();

    const archivedCount = archived.meta?.changes ?? 0;
    if (archivedCount > 0) {
      await logAudit(
        context.env.DB,
        user.id,
        tenantId,
        'teach_sessions_auto_archived',
        'teach_session',
        existing?.id ?? null,
        JSON.stringify({
          supplier_id: body.supplier_id,
          document_type_id: body.document_type_id,
          archived_count: archivedCount,
        }),
        getClientIp(context.request),
      );
    }

    if (existing) {
      const row = await loadSessionRow(context.env.DB, existing.id, tenantId);
      // row is non-null here (we just found it scoped to this tenant).
      const messages = (await loadMessages(context.env.DB, existing.id)).map(serializeMessage);
      const issues = row ? parseIssues(row) : [];
      return new Response(
        JSON.stringify({ session_id: existing.id, messages, issues, resumed: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // 1. Analyze recurring extraction ambiguities for this pair.
    // analyzeUncertainty returns { issues }; unwrap to the array.
    const analysis = await analyzeUncertainty(context.env.DB, {
      tenantId,
      supplierId: body.supplier_id,
      documentTypeId: body.document_type_id,
      env: context.env,
    });
    const issues = analysis?.issues ?? [];

    // 2. Create the session row with the captured issues.
    const sessionId = generateId();
    await context.env.DB.prepare(
      `INSERT INTO teach_sessions
         (id, tenant_id, supplier_id, document_type_id, status, issues_json, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?, datetime('now'), datetime('now'))`,
    )
      .bind(
        sessionId,
        tenantId,
        body.supplier_id,
        body.document_type_id,
        JSON.stringify(issues ?? []),
        user.id,
      )
      .run();

    // 3. Ask Qwen for the opening interview message.
    let aiContent: string;
    try {
      aiContent = await callQwenChat(
        context.env,
        buildQuestionsPrompt(issues ?? []),
        { model: 'best', temperature: 0.3 },
      );
    } catch (err) {
      aiContent = '';
      console.error('teach: opening question generation failed:', err);
    }
    if (!aiContent || aiContent.trim().length === 0) {
      aiContent =
        "Let's teach the system how to read this supplier's documents. " +
        'Could you describe how you decide which value goes in each field when ' +
        'the document is ambiguous?';
    }

    await insertMessage(context.env.DB, generateId(), sessionId, 'ai', aiContent, {
      issues: issues ?? [],
    });

    const messages = (await loadMessages(context.env.DB, sessionId)).map(serializeMessage);

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'teach_session_created',
      'teach_session',
      sessionId,
      JSON.stringify({
        supplier_id: body.supplier_id,
        document_type_id: body.document_type_id,
        issue_count: (issues ?? []).length,
      }),
      getClientIp(context.request),
    );

    return new Response(
      JSON.stringify({ session_id: sessionId, messages, issues: issues ?? [], resumed: false }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Create teach session error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/**
 * GET /api/teach/sessions?supplier_id=X&document_type_id=Y
 *
 * List PAST (non-active) teach sessions for a (supplier, document_type) pair:
 * everything except the single active `open` session — i.e. `confirmed`,
 * `abandoned`, and `synthesized`. Newest first, capped. Light rows only (a
 * message_count subquery, no inline transcript) — full transcripts come from
 * GET /api/teach/sessions/:id.
 *
 * Auth + tenant scoping mirror the POST handler above.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const url = new URL(context.request.url);
    const supplierId = url.searchParams.get('supplier_id');
    const documentTypeId = url.searchParams.get('document_type_id');
    if (!supplierId) throw new BadRequestError('supplier_id is required');
    if (!documentTypeId) throw new BadRequestError('document_type_id is required');

    const tenantId = resolveTenantId(user, url.searchParams.get('tenant_id'));
    if (!tenantId) {
      throw new BadRequestError('tenant_id is required for super_admin');
    }
    requireTenantAccess(user, tenantId);

    const res = await context.env.DB.prepare(
      `SELECT s.id, s.status, s.created_at, s.updated_at, s.proposed_instructions,
              (SELECT COUNT(*) FROM teach_messages m WHERE m.session_id = s.id) AS message_count
       FROM teach_sessions s
       WHERE s.tenant_id = ? AND s.supplier_id = ? AND s.document_type_id = ?
         AND s.status != 'open'
       ORDER BY s.created_at DESC
       LIMIT 50`,
    )
      .bind(tenantId, supplierId, documentTypeId)
      .all<{
        id: string;
        status: string;
        created_at: string;
        updated_at: string;
        proposed_instructions: string | null;
        message_count: number;
      }>();

    const sessions: TeachSessionSummary[] = (res.results ?? []).map((r) => ({
      id: r.id,
      status: r.status as TeachSessionSummary['status'],
      created_at: r.created_at,
      updated_at: r.updated_at,
      proposed_instructions: r.proposed_instructions,
      message_count: Number(r.message_count) || 0,
    }));

    return new Response(JSON.stringify({ sessions }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List teach sessions error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
