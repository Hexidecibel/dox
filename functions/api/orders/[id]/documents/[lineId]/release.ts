/**
 * POST /api/orders/:id/documents/:lineId/release — QA releases ONE held
 * document (migration 0138). The batch route's own function with one id, so
 * there is one implementation of a release and it cannot drift.
 */
import { errorToResponse } from '../../../../../lib/permissions';
import { handleRelease } from '../release';
import type { Env } from '../../../../../lib/types';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    return await handleRelease(context, [context.params.lineId as string]);
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
