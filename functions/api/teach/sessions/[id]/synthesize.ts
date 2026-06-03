/**
 * POST /api/teach/sessions/:id/synthesize
 *
 * Synthesize the interview into a proposed set of extraction instructions +
 * few-shot examples (buildSynthesisPrompt). Stores the proposal on the session,
 * flips status to 'synthesized', and returns the proposal for SME review.
 *
 * Auth: super_admin, org_admin, user.
 */

import { logAudit, getClientIp } from '../../../../lib/db';
import {
  requireRole,
  BadRequestError,
  NotFoundError,
  errorToResponse,
} from '../../../../lib/permissions';
import type { Env, User } from '../../../../lib/types';
import {
  callQwenChat,
  buildSynthesisPrompt,
  parseSynthesis,
  type ConversationTurn,
} from '../../../../lib/teach/qwen';
import {
  loadSessionRow,
  loadMessages,
  parseIssues,
  resolveTenantId,
} from '../../../../lib/teach/session';
import type { UncertaintyIssue } from '../../../../lib/teach/uncertainty';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const sessionId = context.params.id as string;
    const body = (await context.request.json().catch(() => ({}))) as { tenant_id?: string };

    const tenantId = resolveTenantId(user, body.tenant_id);
    if (!tenantId) throw new NotFoundError('Session not found');

    const row = await loadSessionRow(context.env.DB, sessionId, tenantId);
    if (!row) throw new NotFoundError('Session not found');
    if (row.status === 'confirmed') {
      throw new BadRequestError('Session already confirmed');
    }

    const turns = await loadMessages(context.env.DB, sessionId);
    const conversation: ConversationTurn[] = turns.map((t) => ({
      role: t.role as ConversationTurn['role'],
      content: t.content,
    }));
    const issues = parseIssues(row) as UncertaintyIssue[];

    const raw = await callQwenChat(
      context.env,
      buildSynthesisPrompt(conversation, issues),
      { model: 'best', temperature: 0.1, maxTokens: 3072 },
    );
    const proposal = parseSynthesis(raw);

    await context.env.DB.prepare(
      `UPDATE teach_sessions
         SET status = 'synthesized',
             proposed_instructions = ?,
             proposed_examples_json = ?,
             updated_at = datetime('now')
       WHERE id = ?`,
    )
      .bind(proposal.instructions, JSON.stringify(proposal.examples), sessionId)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'teach_session_synthesized',
      'teach_session',
      sessionId,
      JSON.stringify({
        instructions_length: proposal.instructions.length,
        example_count: proposal.examples.length,
      }),
      getClientIp(context.request),
    );

    return new Response(
      JSON.stringify({ session_id: sessionId, status: 'synthesized', proposal }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Teach synthesize error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
