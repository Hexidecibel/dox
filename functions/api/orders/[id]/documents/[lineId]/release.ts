/**
 * POST /api/orders/:id/documents/:lineId/release — QA releases ONE held
 * document (migration 0138). Body `{ document_id, version_number,
 * pending_send_id }`: what QA saw. The batch route's own function with one
 * line, so there is one implementation of a release and it cannot drift.
 */
import { errorToResponse } from '../../../../../lib/permissions';
import { handleRelease } from '../release';
import type { Env } from '../../../../../lib/types';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    let body: Record<string, unknown> = {};
    try {
      body = ((await context.request.json()) ?? {}) as Record<string, unknown>;
    } catch {
      body = {};
    }
    return await handleRelease(context, [
      {
        id: context.params.lineId as string,
        document_id: body.document_id,
        version_number: body.version_number,
        pending_send_id: body.pending_send_id,
      },
    ]);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Release order document error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
