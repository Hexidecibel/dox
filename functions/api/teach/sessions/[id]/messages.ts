/**
 * POST /api/teach/sessions/:id/messages
 *
 * Append an SME answer to the transcript, then ask Qwen (buildFollowupPrompt)
 * whether to ask one clarifying follow-up or that we know enough. Appends the
 * follow-up AI message (if any) and returns the updated transcript plus a
 * `ready_to_synthesize` flag.
 *
 * Auth: super_admin, org_admin, user.
 */

import { generateId } from '../../../../lib/db';
import {
  requireRole,
  BadRequestError,
  NotFoundError,
  errorToResponse,
} from '../../../../lib/permissions';
import type { Env, User } from '../../../../lib/types';
import {
  callQwenChat,
  buildFollowupPrompt,
  DONE_SIGNAL,
  type ConversationTurn,
} from '../../../../lib/teach/qwen';
import {
  loadSessionRow,
  loadMessages,
  serializeMessage,
  parseIssues,
  resolveTenantId,
  insertMessage,
} from '../../../../lib/teach/session';
import type { UncertaintyIssue } from '../../../../lib/teach/uncertainty';
import { loadTeachBackground } from '../../../../lib/teach/background';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const sessionId = context.params.id as string;
    const body = (await context.request.json()) as { content?: string; tenant_id?: string };

    if (typeof body.content !== 'string' || body.content.trim().length === 0) {
      throw new BadRequestError('content is required');
    }

    const tenantId = resolveTenantId(user, body.tenant_id);
    if (!tenantId) throw new NotFoundError('Session not found');

    const row = await loadSessionRow(context.env.DB, sessionId, tenantId);
    if (!row) throw new NotFoundError('Session not found');
    if (row.status !== 'open') {
      throw new BadRequestError(`Session is ${row.status}; cannot add messages`);
    }

    // 1. Append the SME answer.
    await insertMessage(context.env.DB, generateId(), sessionId, 'sme', body.content.trim());

    // 2. Build the running conversation and ask Qwen for a follow-up decision.
    const turns = await loadMessages(context.env.DB, sessionId);
    const conversation: ConversationTurn[] = turns.map((t) => ({
      role: t.role as ConversationTurn['role'],
      content: t.content,
    }));
    const issues = parseIssues(row) as UncertaintyIssue[];

    // Ground the follow-up decision in already-known context for this pair.
    const background = await loadTeachBackground(context.env.DB, {
      tenantId,
      supplierId: row.supplier_id,
      documentTypeId: row.document_type_id,
    });

    let decision = '';
    try {
      decision = await callQwenChat(
        context.env,
        buildFollowupPrompt(conversation, issues, background),
        { model: 'best', temperature: 0.2 },
      );
    } catch (err) {
      console.error('teach: follow-up generation failed:', err);
    }

    const trimmed = decision.trim();
    const readyToSynthesize = trimmed === '' || trimmed.toUpperCase().includes(DONE_SIGNAL);

    if (!readyToSynthesize) {
      await insertMessage(context.env.DB, generateId(), sessionId, 'ai', trimmed);
    }

    await context.env.DB.prepare(
      `UPDATE teach_sessions SET updated_at = datetime('now') WHERE id = ?`,
    )
      .bind(sessionId)
      .run();

    const messages = (await loadMessages(context.env.DB, sessionId)).map(serializeMessage);

    return new Response(
      JSON.stringify({ messages, ready_to_synthesize: readyToSynthesize }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Teach message error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
