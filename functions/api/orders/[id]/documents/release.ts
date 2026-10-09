/**
 * POST /api/orders/:id/documents/release { lines } — QA releases documents
 * that were held on this order (migration 0138, decision C-044).
 *
 * `lines` is `[{ id, document_id, version_number, pending_send_id }]`: each
 * line WITH WHAT QA SAW, exactly as GET /api/order-documents/pending returned
 * it. A line whose document, version or asking send has changed since is not
 * released, and says so (`refused[].code: "changed"`). At most 50 lines -- what
 * one link carries; more is a 400 with both numbers and releases nothing.
 *
 * The batch form, and the only implementation: the single-line route
 * (./[lineId]/release.ts) calls the same function with one id. Lines released
 * together and bound for the same recipients leave on ONE link in ONE email.
 *
 * A QA releaser signed in to the portal. Never an API key, never a read-only
 * account. See functions/lib/order-document-release.ts for what is checked
 * and in which order.
 *
 * 200 when at least one document was released (`refused` still lists any that
 * were not, with the reason); 409 when none was.
 */
import { getClientIp } from '../../../../lib/db';
import { BadRequestError, errorToResponse } from '../../../../lib/permissions';
import { loadOrderForLineWrite, refuseStaged, requireOrderAccess } from '../../../../lib/order-items';
import { releaseOrderDocuments, requireQaReleaser } from '../../../../lib/order-document-release';
import type { OrderDocumentsReleaseRequest } from '../../../../../shared/types';
import type { Env, User } from '../../../../lib/types';
import { loadOutwardName } from '../../../../lib/tenant-brand';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Shared by the batch route and the single-line route. */
export async function handleRelease(
  context: Parameters<PagesFunction<Env>>[0],
  lineIds: unknown,
): Promise<Response> {
  const user = context.data.user as User;
  // The order first: another organization's order is a 404 before anything
  // about who may release is said.
  const order = await loadOrderForLineWrite(context.env.DB, context.params.id as string);
  requireOrderAccess(user, order);
  const actor = await requireQaReleaser(context.env.DB, context.data, user, order.tenant_id);
  refuseStaged(order);

  if (!context.env.RESEND_API_KEY) {
    return json(
      {
        error: 'Email is not configured for this portal, so nothing was released. Ask an administrator to set up email.',
        code: 'email_not_configured',
      },
      503,
    );
  }

  const tenant = await context.env.DB.prepare('SELECT name FROM tenants WHERE id = ?')
    .bind(order.tenant_id)
    .first<{ name: string }>();

  const result = await releaseOrderDocuments(
    {
      db: context.env.DB,
      apiKey: context.env.RESEND_API_KEY,
      origin: new URL(context.request.url).origin,
      tenantName: await loadOutwardName(context.env.DB, order.tenant_id, tenant?.name ?? 'Documents'),
      order,
      user,
      actor,
      clientIp: getClientIp(context.request),
    },
    lineIds,
  );
  if (result.released.length === 0) {
    return json(
      { error: result.refused[0]?.reason ?? 'Nothing was released.', code: 'nothing_released', ...result },
      409,
    );
  }
  return json(result);
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    let body: OrderDocumentsReleaseRequest;
    try {
      body = (await context.request.json()) as OrderDocumentsReleaseRequest;
    } catch {
      throw new BadRequestError('Invalid JSON body');
    }
    return await handleRelease(context, body?.lines);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Release order documents error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
