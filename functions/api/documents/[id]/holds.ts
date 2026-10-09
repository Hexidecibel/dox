/**
 * GET  /api/documents/:id/holds -- this certificate's holds: active, history,
 *                                  its lot rows, and what the caller may do.
 * POST /api/documents/:id/holds -- place a hold: `{ lot_id?, reason }`.
 *
 * Decision C-005, migration 0139. A hold stops the certificate leaving by every
 * exit until QA or an administrator releases it (POST /api/holds/:id/release).
 *
 * WHO PLACES. Any login but a read-only one, and an API key: a hold only
 * tightens. WHO READS. Anybody who can see the document.
 *
 * TENANT SCOPED. A document of another organization is a 404 on both verbs,
 * before any other check, so its existence is never confirmed.
 *
 * THERE IS NO PUT AND NO DELETE. A hold is released, never edited or removed.
 */
import { NotFoundError, errorToResponse } from '../../../lib/permissions';
import { getClientIp } from '../../../lib/db';
import { describeDocumentHolds, placeHold } from '../../../lib/holds';
import type { PlaceHoldRequest } from '../../../../shared/types';
import type { Env, User } from '../../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The document's organization, or a 404 when the caller may not see it. */
async function documentTenant(db: D1Database, user: User, documentId: string): Promise<string> {
  const doc = await db
    .prepare('SELECT tenant_id FROM documents WHERE id = ?')
    .bind(documentId)
    .first<{ tenant_id: string }>();
  if (!doc) throw new NotFoundError('Document not found');
  if (user.role !== 'super_admin' && user.tenant_id !== doc.tenant_id) {
    throw new NotFoundError('Document not found');
  }
  return doc.tenant_id;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const documentId = context.params.id as string;
    const tenantId = await documentTenant(context.env.DB, user, documentId);
    const body = await describeDocumentHolds(context.env.DB, context.data, user, tenantId, documentId);
    if (!body) throw new NotFoundError('Document not found');
    return json(body);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Document holds error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const documentId = context.params.id as string;
    const tenantId = await documentTenant(context.env.DB, user, documentId);
    let body: PlaceHoldRequest;
    try {
      body = (await context.request.json()) as PlaceHoldRequest;
    } catch {
      return json({ error: 'Send a JSON body with a reason.' }, 400);
    }
    const hold = await placeHold(context.env.DB, {
      tenantId,
      documentId,
      lotId: body?.lot_id,
      reason: body?.reason,
      user,
      data: context.data,
      clientIp: getClientIp(context.request),
      apiKey: context.env.RESEND_API_KEY,
      appUrl: new URL(context.request.url).origin,
    });
    return json({ hold }, 201);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Place hold error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
