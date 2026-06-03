/**
 * GET /api/teach/sessions/:id
 *
 * Return a teach session with its full transcript, the captured uncertainty
 * issues, and the synthesized proposal (if any). Tenant-scoped + role-gated.
 */

import { requireRole, errorToResponse, NotFoundError } from '../../../../lib/permissions';
import type { Env, User } from '../../../../lib/types';
import {
  loadSessionRow,
  loadMessages,
  serializeSession,
  serializeMessage,
  parseIssues,
  parseProposal,
  resolveTenantId,
} from '../../../../lib/teach/session';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const sessionId = context.params.id as string;
    const url = new URL(context.request.url);
    const tenantId = resolveTenantId(user, url.searchParams.get('tenant_id'));
    if (!tenantId) {
      throw new NotFoundError('Session not found');
    }

    const row = await loadSessionRow(context.env.DB, sessionId, tenantId);
    if (!row) throw new NotFoundError('Session not found');

    const messages = (await loadMessages(context.env.DB, sessionId)).map(serializeMessage);

    return new Response(
      JSON.stringify({
        session: serializeSession(row),
        messages,
        issues: parseIssues(row),
        proposal: parseProposal(row),
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Get teach session error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
