/**
 * Worker entrypoint. Re-exports the SheetSession DO class so the Cloudflare
 * runtime can host it, and provides a default fetch handler that returns
 * 404 for any direct HTTP traffic.
 *
 * This Worker is invoked exclusively via Durable Object RPC from the Pages
 * project. There are no public routes; the default handler exists only so
 * the runtime has a fetch implementation to dispatch incoming requests to
 * if anything ever lands here directly (misconfiguration, probing, etc.).
 */

export { SheetSession } from './sheet-session';

import type { Env } from './sheet-session';

export default {
  async fetch(_request: Request, _env: Env): Promise<Response> {
    return new Response(
      JSON.stringify({
        error: 'not_found',
        message:
          'dox-sheet-session is a DO-only Worker. No HTTP routes are exposed.',
      }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  },
};
