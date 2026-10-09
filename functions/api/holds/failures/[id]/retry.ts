/**
 * POST /api/holds/failures/:id/retry -- place the holds an approval should have
 * placed and could not (decision C-087, migration 0139).
 *
 * An automatic hold is written after the approval has already happened. When
 * that write fails the approval stands, the certificate is NOT held, and the
 * failure is recorded (`document_hold_failures`), mailed to QA and shown on
 * the document page and the Holds page. This is the button on that notice.
 *
 * IDEMPOTENT: it places exactly the holds the failed approval computed, once
 * per judged result. A hold placed in the meantime is not placed twice.
 *
 * Anybody who may PLACE a hold may retry (any login but a read-only one, and
 * an API key): it only tightens. Another organization's id is a 404.
 */
import { errorToResponse } from '../../../../lib/permissions';
import { getClientIp } from '../../../../lib/db';
import { retryHoldFailure } from '../../../../lib/holds';
import { NotFoundError } from '../../../../lib/permissions';
import type { Env, User } from '../../../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const failureId = context.params.id as string;
    const row = await context.env.DB
      .prepare('SELECT tenant_id FROM document_hold_failures WHERE id = ?')
      .bind(failureId)
      .first<{ tenant_id: string }>();
    if (!row || (user.role !== 'super_admin' && user.tenant_id !== row.tenant_id)) {
      throw new NotFoundError('Not found');
    }
    const result = await retryHoldFailure(context.env.DB, context.env.RESEND_API_KEY, {
      tenantId: row.tenant_id,
      failureId,
      user,
      clientIp: getClientIp(context.request),
      appUrl: new URL(context.request.url).origin,
    });
    return json(result);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Retry hold placement error:', err);
    return json({ error: 'The hold could not be placed. Nothing changed; try again, or place a hold by hand.' }, 500);
  }
};
