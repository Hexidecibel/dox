/**
 * dox-renewal-alerts - companion Worker holding the daily renewal-alert cron.
 *
 * Cloudflare Pages does not support `[triggers] crons`, so the schedule lives
 * here and the work lives in the Pages function. This Worker has no domain
 * logic at all: it POSTs to a bearer-auth endpoint on every tick and logs the
 * summary. All of the routing, suppression, link minting and mail happens
 * inside `/api/expirations/run-scheduled` so it shares the same D1/R2 bindings
 * as the manual "Send alert" button and cannot drift away from it.
 *
 * Modelled on `workers/connector-poller/` deliberately - one precedent for
 * "Pages needs a cron", not two.
 *
 * Direct HTTP traffic to this Worker is not expected; the fetch handler returns
 * 404 to make that explicit.
 */

export interface Env {
  DOX_API_BASE: string;
  RENEWAL_ALERT_TOKEN: string;
}

async function dispatchRenewalRun(env: Env): Promise<void> {
  const url = `${env.DOX_API_BASE.replace(/\/+$/, '')}/api/expirations/run-scheduled`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RENEWAL_ALERT_TOKEN}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
  } catch (err) {
    console.error(
      `renewal-alerts: fetch failed ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.error(`renewal-alerts: run failed ${resp.status} ${text}`);
    return;
  }

  // Log the whole summary so `wrangler tail` answers the two questions an
  // operator actually has: did anything go out, and did anything go UNROUTED.
  // The unrouted count is the one that means a tenant's ownership config is
  // broken, and it must not require opening the portal to notice.
  try {
    const body = await resp.text();
    console.log(`renewal-alerts: ok ${body}`);
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
    ctx.waitUntil(dispatchRenewalRun(env));
  },

  async fetch(_request: Request, _env: Env): Promise<Response> {
    return new Response(
      JSON.stringify({
        error: 'not_found',
        message:
          'dox-renewal-alerts is a cron-only Worker. No HTTP routes are exposed.',
      }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  },
};
