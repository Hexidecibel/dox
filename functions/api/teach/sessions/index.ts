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
import type { Env, User } from '../../../lib/types';
import { analyzeUncertainty } from '../../../lib/teach/uncertainty';
import { callQwenChat, buildQuestionsPrompt } from '../../../lib/teach/qwen';
import {
  loadMessages,
  serializeMessage,
  resolveTenantId,
  insertMessage,
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
      JSON.stringify({ session_id: sessionId, messages, issues: issues ?? [] }),
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
