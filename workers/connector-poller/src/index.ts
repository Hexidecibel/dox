/**
 * dox-connector-poller — companion Worker for Phase 2 of the file_watch
 * connector.
 *
 * Cloudflare Pages does not support `[triggers] crons`, so the polling
 * cadence lives in this Worker. The Worker has no domain logic; it
 * just POSTs to a bearer-auth endpoint on the Pages project on every
 * schedule tick. All actual work (R2 list, dedup, executor dispatch)
 * happens inside the Pages function so the same DB/R2 bindings drive
 * scheduled and manual runs.
 *
 * Direct HTTP traffic to this Worker is not expected — the default
 * fetch handler returns 404 to make that explicit.
 */

export interface Env {
  DOX_API_BASE: string;
  CONNECTOR_POLL_TOKEN: string;
}

async function dispatchPoll(env: Env): Promise<void> {
  const url = `${env.DOX_API_BASE.replace(/\/+$/, '')}/api/connectors/poll`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.CONNECTOR_POLL_TOKEN}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
  } catch (err) {
    console.error(
      `connector-poller: fetch failed ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.error(`connector-poller: poll failed ${resp.status} ${text}`);
    return;
  }

  // Log the summary so cron logs in `wrangler tail` are useful.
  try {
    const body = await resp.text();
    console.log(`connector-poller: ok ${body}`);
  } catch {
    /* no-op */
  }
}

export default {
  async scheduled(
    _ctrl: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(dispatchPoll(env));
  },

  async fetch(_request: Request, _env: Env): Promise<Response> {
    return new Response(
      JSON.stringify({
        error: 'not_found',
        message:
          'dox-connector-poller is a cron-only Worker. No HTTP routes are exposed.',
      }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  },
};
