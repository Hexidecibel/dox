/**
 * GET /api/records/sheets/:sheetId/connect
 *
 * Auth-guarded WebSocket upgrade that forwards to the per-sheet
 * SheetSession Durable Object. The middleware (`functions/api/_middleware.ts`)
 * has already authenticated the caller via the standard `Authorization`
 * header OR the `?token=` query-param fallback (browsers can't set
 * headers on `new WebSocket(...)` so the frontend uses ?token=).
 *
 * This handler:
 *   1. Verifies the user has tenant access to the requested sheet.
 *   2. Adds `userId` to the URL so the DO knows who is connecting.
 *      (The DO does NOT trust the client for identity.)
 *   3. Forwards the original Request — including the `Upgrade: websocket`
 *      header — to the DO via stub.fetch().
 *
 * The DO's `/connect` route consumes `userId` and (optional) `sessionId`
 * query params, accepts the WebSocket on the server side of the pair,
 * and returns the client end with status 101.
 */

import { errorToResponse, NotFoundError } from '../../../../lib/permissions';
import { loadSheetForUser } from '../../../../lib/records/helpers';
import type { Env, User } from '../../../../lib/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User | undefined;
    const sheetId = context.params.sheetId as string;

    // Middleware should have populated context.data.user. Defensive 401
    // here in case this route was ever moved out from under it.
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const upgradeHeader = context.request.headers.get('Upgrade');
    if (upgradeHeader?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    // Tenant check — same conventions as every other Records handler.
    // loadSheetForUser throws NotFoundError on cross-tenant access so we
    // hide existence (mirrors loadSheetForUser usage elsewhere).
    const sheet = await loadSheetForUser(context.env.DB, sheetId, user);
    if (sheet.archived === 1) {
      // Don't fan-out edits for archived sheets. Treat as "not found"
      // for the realtime surface; the REST routes still work for admins
      // who want to unarchive.
      throw new NotFoundError('Sheet not found');
    }

    // Build the forward URL. We replace the path with `/connect` (the
    // DO's only WebSocket route) and inject `userId`. We deliberately
    // forward any client-provided `sessionId` as-is so reconnects can
    // resume the same presence slot — but if the client tries to spoof
    // `userId`, our overwrite wins.
    const incomingUrl = new URL(context.request.url);
    const forwardUrl = new URL('https://sheet-session.do/connect');
    forwardUrl.searchParams.set('userId', user.id);
    const sessionId = incomingUrl.searchParams.get('sessionId');
    if (sessionId) {
      forwardUrl.searchParams.set('sessionId', sessionId);
    }

    // Construct a new Request that preserves the WebSocket upgrade
    // semantics. The platform forwards Upgrade/Sec-WebSocket-* headers
    // as long as they're on the Request we hand to the DO stub.
    const forwardedRequest = new Request(forwardUrl.toString(), context.request);

    const stubId = context.env.SHEET_SESSION.idFromName(sheetId);
    const stub = context.env.SHEET_SESSION.get(stubId);
    return stub.fetch(forwardedRequest);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Records WebSocket connect error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
