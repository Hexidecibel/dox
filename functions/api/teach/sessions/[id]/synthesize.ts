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
import { loadTeachBackground } from '../../../../lib/teach/background';

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

    // Ground synthesis in already-known context so the proposal is supplier
    // deltas, not a restatement of org-level / existing instructions.
    const background = await loadTeachBackground(context.env.DB, {
      tenantId,
      supplierId: row.supplier_id,
      documentTypeId: row.document_type_id,
    });

    // Synthesis output is short (a paragraph of rules + a few examples), so cap
    // tokens low to keep it well under the wall-clock budget, with headroom on
    // the timeout. If Qwen is slow/unreachable or returns nothing usable, fall
    // back to a draft built from the SME's own answers — the flow must NEVER
    // 500 here; the SME can always edit/confirm the draft.
    const fallbackProposal = () => {
      const smeText = conversation
        .filter((t) => t.role === 'sme')
        .map((t) => t.content.trim())
        .filter(Boolean)
        .join('\n\n');
      return {
        instructions: smeText,
        examples: [] as { field: string; value: string; note: string }[],
        summary: smeText
          ? 'Draft assembled from your answers — please review and edit.'
          : '',
      };
    };
    let proposal;
    try {
      const raw = await callQwenChat(
        context.env,
        buildSynthesisPrompt(conversation, issues, background),
        { model: 'best', temperature: 0.1, maxTokens: 1280, timeoutMs: 300_000 },
      );
      const parsed = parseSynthesis(raw);
      proposal = parsed.instructions.trim() ? parsed : fallbackProposal();
    } catch (synthErr) {
      console.error('Teach synthesize: Qwen failed, using fallback draft:', synthErr);
      proposal = fallbackProposal();
    }

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
