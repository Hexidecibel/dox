/**
 * Connector intake doors — full end-to-end coverage on staging.
 *
 * Phase C of the connector intake button-up. Each test creates a fresh
 * connector via the wizard's underlying API, exercises ONE intake door
 * (manual, API, public-link, email-via-webhook, S3-via-poller), then
 * asserts that:
 *   1. A connector_run row exists for the connector with status=success.
 *   2. Orders are reachable via /api/orders?connector_id=<id>.
 *   3. Where applicable, the runs table renders the run in the UI.
 *
 * Each scenario stands alone — it owns its connector and tears it down
 * at the end. This costs a little extra setup time per test but keeps
 * the suite parallel-safe (well, parallel-ready — the project still
 * runs with workers=1 against staging) and avoids cross-test data
 * leaks if any assertion fails midway.
 *
 * Why so much setup in each test?
 *
 * The wizard already has an e2e in `connector-wizard.spec.ts` that
 * proves discover -> preview -> create -> run -> test -> delete works.
 * The doors specs reuse the same shape but ONLY for the parts that are
 * load-bearing for the door under test — discover + create + the
 * door's POST + a follow-up read. That keeps each scenario under ~1
 * minute on staging.
 */

import {
  test,
  expect,
  request as pwRequest,
  type APIRequestContext,
} from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SAMPLE_CSV = join(__dirname, 'fixtures', 'connector-orders.csv');
const TENANT_ID = 'default';

/**
 * The orchestrator upserts `orders` by `(tenant_id, order_number)` and on
 * collision it UPDATEs the existing row WITHOUT rewriting `connector_id`.
 * Practical effect: if two runs across two different connectors share an
 * order_number, only the first run "owns" the orders by connector_id; the
 * second run reports `records_updated` but its connector_id-filtered
 * /api/orders query returns 0.
 *
 * The doors specs run on a real, accumulating staging DB, so they need
 * unique order_numbers per test invocation to assert orders surfaced
 * under the right connector. We rewrite the canonical fixture's
 * order numbers (`ORD-DOOR-001..008`) to a per-run unique stem
 * (`ORD-DOOR-<TS>-001..008`) before posting it. The fixture file on
 * disk stays canonical for human-readability.
 */
function uniquifyCsv(csvBytes: Buffer): { buffer: Buffer; stem: string } {
  const stem = `T${Date.now().toString(36)}`;
  const text = csvBytes.toString('utf8');
  const rewritten = text.replace(/ORD-DOOR-(\d{3})/g, `ORD-DOOR-${stem}-$1`);
  return { buffer: Buffer.from(rewritten, 'utf8'), stem };
}

// ---------- Shared helpers ----------

async function adminApi(baseURL: string): Promise<{
  api: APIRequestContext;
  token: string;
}> {
  const api = await pwRequest.newContext({ baseURL });
  const res = await api.post('/api/auth/login', {
    data: { email: 'a@a.a', password: 'a' },
  });
  if (!res.ok()) {
    throw new Error(`login failed: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string };
  return { api, token: body.token };
}

interface CreatedConnector {
  id: string;
  slug?: string | null;
  api_token?: string | null;
  csvBytes: Buffer;
}

/**
 * Run discover + create against staging, returning the new connector's
 * id (and a freshly-read CSV buffer for the body). The mapping is the
 * minimum required for the orchestrator to insert orders + customers
 * for our 8-row fixture: order_number, po_number, customer_name,
 * customer_number.
 */
async function createConnector(
  api: APIRequestContext,
  token: string,
  name: string,
): Promise<CreatedConnector> {
  const auth = { Authorization: `Bearer ${token}` };
  const baseCsv = readFileSync(SAMPLE_CSV);
  // Rewrite order numbers so this test owns its rows in the orders table
  // even on a long-lived staging DB. See uniquifyCsv() for the why.
  const { buffer: csvBytes } = uniquifyCsv(baseCsv);

  const discoverRes = await api.post('/api/connectors/discover-schema', {
    headers: auth,
    multipart: {
      file: {
        name: 'connector-orders.csv',
        mimeType: 'text/csv',
        buffer: csvBytes,
      },
      source_type: 'csv',
      tenant_id: TENANT_ID,
    },
  });
  expect(discoverRes.status(), await discoverRes.text()).toBe(200);
  const discoverBody = (await discoverRes.json()) as {
    sample_id: string;
  };

  const fieldMappings = {
    core: {
      order_number: {
        enabled: true,
        source_labels: ['order_number'],
        aliases: [],
        target: 'order_number',
      },
      po_number: {
        enabled: true,
        source_labels: ['po_number'],
        aliases: [],
        target: 'po_number',
      },
      customer_name: {
        enabled: true,
        source_labels: ['customer_name'],
        aliases: [],
        target: 'customer_name',
      },
      customer_number: {
        enabled: true,
        source_labels: ['customer_number'],
        aliases: [],
        target: 'customer_number',
      },
    },
    extras: [],
  };

  const createRes = await api.post('/api/connectors', {
    headers: { ...auth, 'Content-Type': 'application/json' },
    data: {
      name,
      config: {},
      field_mappings: fieldMappings,
      tenant_id: TENANT_ID,
      sample_r2_key: discoverBody.sample_id,
      active: true,
    },
  });
  expect(createRes.status(), await createRes.text()).toBe(201);
  const createBody = (await createRes.json()) as {
    connector?: {
      id?: string;
      slug?: string | null;
      api_token?: string | null;
    };
    id?: string;
    slug?: string | null;
    api_token?: string | null;
  };
  const id = createBody.connector?.id || createBody.id;
  expect(id).toBeTruthy();

  return {
    id: id as string,
    slug: createBody.connector?.slug ?? createBody.slug ?? null,
    api_token: createBody.connector?.api_token ?? createBody.api_token ?? null,
    csvBytes,
  };
}

/**
 * GET /api/connectors/:id and pluck the api_token. Some create
 * responses don't echo it; the GET always does (it's plaintext at
 * rest by design — see the rotate endpoint comments).
 */
async function fetchApiToken(
  api: APIRequestContext,
  token: string,
  connectorId: string,
): Promise<string> {
  const res = await api.get(`/api/connectors/${connectorId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as {
    connector?: { api_token?: string | null };
    api_token?: string | null;
  };
  const apiToken = body.connector?.api_token ?? body.api_token ?? null;
  if (!apiToken) {
    // Rotate to mint one if missing — older connectors predate B2.
    const rotateRes = await api.post(
      `/api/connectors/${connectorId}/api-token/rotate`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(rotateRes.status()).toBe(200);
    const rotated = (await rotateRes.json()) as { api_token: string };
    return rotated.api_token;
  }
  return apiToken;
}

async function deleteConnector(
  api: APIRequestContext,
  token: string,
  connectorId: string,
): Promise<void> {
  await api.delete(`/api/connectors/${connectorId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

interface RunSummary {
  total: number;
  latestStatus: string | null;
  latestSource: string | null;
  latestRecords: number;
}

async function fetchRunSummary(
  api: APIRequestContext,
  token: string,
  connectorId: string,
): Promise<RunSummary> {
  const res = await api.get(`/api/connectors/${connectorId}/runs?limit=10`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as {
    runs: Array<{
      status: string;
      source?: string | null;
      records_found?: number;
    }>;
    total: number;
  };
  const latest = body.runs[0];
  return {
    total: body.total,
    latestStatus: latest?.status ?? null,
    latestSource: latest?.source ?? null,
    latestRecords: latest?.records_found ?? 0,
  };
}

async function fetchOrderCount(
  api: APIRequestContext,
  token: string,
  connectorId: string,
): Promise<number> {
  // tenant_id is required for super_admin callers (the staging admin
  // user a@a.a is super_admin); org_admins have it inferred. Pass it
  // explicitly so this works in both worlds.
  //
  // Retry: D1's eventual-consistency window across replica reads can be
  // a second or two longer than the orchestrator's `INSERT INTO orders`
  // commit latency. We re-query up to 5 times with a 600 ms gap so a
  // freshly-dispatched run has time to surface in the read replica
  // backing /api/orders. If the connector really created zero orders
  // that's a real failure — the assert in the caller still catches it
  // after the last retry.
  for (let i = 0; i < 5; i++) {
    const res = await api.get(
      `/api/orders?tenant_id=${encodeURIComponent(TENANT_ID)}&connector_id=${encodeURIComponent(connectorId)}&limit=50`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as {
      orders?: unknown[];
      total?: number;
    };
    const count = body.total ?? body.orders?.length ?? 0;
    if (count > 0) return count;
    await new Promise((r) => setTimeout(r, 600));
  }
  return 0;
}

// ---------- Scenarios ----------

test.describe('connector intake doors', () => {
  test.describe.configure({ mode: 'serial' });

  // --- Scenario 1: Manual upload door -----------------------------------
  test('manual upload door — POST /run multipart from admin UI path', async ({
    page,
    baseURL,
  }) => {
    const url = baseURL!;
    const { api, token } = await adminApi(url);
    const auth = { Authorization: `Bearer ${token}` };

    const created = await createConnector(
      api,
      token,
      `E2E manual ${Date.now()}`,
    );

    try {
      // The detail page renders the manual drop zone as the first card.
      // Confirm it's there before driving the door via API (Playwright's
      // setInputFiles on a hidden <input ref> is brittle on staging; the
      // backend wire is what we actually need to prove).
      await page.goto(`/admin/connectors/${created.id}`);
      await expect(
        page.getByRole('heading', { name: /manual upload/i }),
      ).toBeVisible({ timeout: 15_000 });

      const runRes = await api.post(`/api/connectors/${created.id}/run`, {
        headers: auth,
        multipart: {
          file: {
            name: 'connector-orders.csv',
            mimeType: 'text/csv',
            buffer: created.csvBytes,
          },
        },
      });
      expect(runRes.status(), await runRes.text()).toBeLessThan(300);
      const runBody = (await runRes.json()) as {
        rows_processed?: number;
        rows_inserted?: number;
        run?: { status?: string; records_found?: number };
        status?: string;
      };
      expect(runBody.run?.status || runBody.status).toBe('success');

      // Run shows up in the connector's runs feed.
      const summary = await fetchRunSummary(api, token, created.id);
      expect(summary.total).toBeGreaterThan(0);
      expect(summary.latestStatus).toBe('success');

      // Orders are queryable for this connector.
      const orderCount = await fetchOrderCount(api, token, created.id);
      expect(orderCount).toBeGreaterThan(0);
    } finally {
      await deleteConnector(api, token, created.id);
      await api.dispose();
    }
  });

  // --- Scenario 2: HTTP API door ----------------------------------------
  test('http api door — bearer drop endpoint', async ({ baseURL }) => {
    const url = baseURL!;
    const { api, token } = await adminApi(url);

    const created = await createConnector(api, token, `E2E api ${Date.now()}`);
    const apiToken = await fetchApiToken(api, token, created.id);

    try {
      // Hit the public drop endpoint with the connector's bearer.
      // This is the SAME wire a vendor's curl would hit — no JWT, just
      // the per-connector api_token.
      const dropRes = await api.post(
        `/api/connectors/${created.id}/drop`,
        {
          headers: { Authorization: `Bearer ${apiToken}` },
          multipart: {
            file: {
              name: 'connector-orders.csv',
              mimeType: 'text/csv',
              buffer: created.csvBytes,
            },
          },
        },
      );
      expect(dropRes.status(), await dropRes.text()).toBe(200);
      const dropBody = (await dropRes.json()) as {
        run_id: string;
        status: string;
        orders_created?: number;
      };
      expect(dropBody.run_id).toBeTruthy();
      expect(dropBody.status).toBe('success');

      const summary = await fetchRunSummary(api, token, created.id);
      expect(summary.total).toBeGreaterThan(0);
      expect(summary.latestStatus).toBe('success');
      // Phase B5 stamps `source` on the run row — the drop endpoint
      // tags as 'api' when the api_token matched.
      if (summary.latestSource) {
        expect(summary.latestSource).toBe('api');
      }

      const orderCount = await fetchOrderCount(api, token, created.id);
      expect(orderCount).toBeGreaterThan(0);

      // Negative path: a wrong bearer must 401, not leak existence.
      const badRes = await api.post(`/api/connectors/${created.id}/drop`, {
        headers: { Authorization: 'Bearer not-a-real-token-aaaaaaaa' },
        multipart: {
          file: {
            name: 'connector-orders.csv',
            mimeType: 'text/csv',
            buffer: created.csvBytes,
          },
        },
      });
      expect(badRes.status()).toBe(401);
    } finally {
      await deleteConnector(api, token, created.id);
      await api.dispose();
    }
  });

  // --- Scenario 3: S3 bucket door ---------------------------------------
  //
  // The S3 door requires:
  //   1. Provisioning a real R2 bucket via the CF API
  //      (POST /api/connectors/:id/r2/provision)
  //   2. Using aws4fetch to S3-PUT into that bucket
  //   3. Triggering the poll endpoint to pick up the new key
  //
  // (1) charges the staging Cloudflare account every run and creates
  // accumulating buckets; on a clean staging environment the
  // CLOUDFLARE_API_TOKEN may also not be wired up. Driving (2) from
  // playwright requires aws4fetch + the per-connector secret in
  // plaintext at test time, which we deliberately don't echo from the
  // create endpoint.
  //
  // The orchestrator path the S3 door uses is IDENTICAL to what the
  // R2 poller runs — the same `pollAllR2Connectors` -> file_watch
  // executor as the API drop. That path is covered in
  // `tests/api/connector-poll-r2.test.ts` (vitest, against the local
  // miniflare D1+R2). What's NOT covered there is the staging poller
  // round-trip, which depends on a CF Worker cron + the staging
  // CONNECTOR_POLL_TOKEN handshake — both already verified in Phase
  // B3.5 walkthrough notes.
  //
  // For e2e regression we skip the door here with an explicit reason
  // so the suite output flags the gap rather than silently passing.
  test.skip(
    'S3 bucket door — provision + S3 PUT + poll round-trip (staging)',
    async () => {
      // Intentionally empty. See block comment above.
    },
  );

  // --- Scenario 4: Public link door -------------------------------------
  test('public link door — generate link, drop via link bearer', async ({
    baseURL,
  }) => {
    const url = baseURL!;
    const { api, token } = await adminApi(url);

    const created = await createConnector(
      api,
      token,
      `E2E publink ${Date.now()}`,
    );

    try {
      const auth = { Authorization: `Bearer ${token}` };

      // Generate a public link (default 30-day expiry).
      const genRes = await api.post(
        `/api/connectors/${created.id}/public-link/generate`,
        {
          headers: { ...auth, 'Content-Type': 'application/json' },
          data: {},
        },
      );
      expect(genRes.status(), await genRes.text()).toBe(200);
      const genBody = (await genRes.json()) as {
        public_link_token: string;
        public_link_expires_at: number | null;
        url: string;
      };
      expect(genBody.public_link_token).toMatch(/^[a-f0-9]{64}$/);
      expect(genBody.url).toContain('/drop/');

      // Drop using the public-link token. Same /drop endpoint as the
      // API door but the bearer is the public_link_token instead of
      // api_token; the server's checkAuth() resolves which one matched.
      const dropRes = await api.post(
        `/api/connectors/${created.id}/drop`,
        {
          headers: { Authorization: `Bearer ${genBody.public_link_token}` },
          multipart: {
            file: {
              name: 'connector-orders.csv',
              mimeType: 'text/csv',
              buffer: created.csvBytes,
            },
          },
        },
      );
      expect(dropRes.status(), await dropRes.text()).toBe(200);
      const dropBody = (await dropRes.json()) as {
        run_id: string;
        status: string;
      };
      expect(dropBody.run_id).toBeTruthy();
      expect(dropBody.status).toBe('success');

      const summary = await fetchRunSummary(api, token, created.id);
      expect(summary.total).toBeGreaterThan(0);
      expect(summary.latestStatus).toBe('success');
      if (summary.latestSource) {
        expect(summary.latestSource).toBe('public_link');
      }

      const orderCount = await fetchOrderCount(api, token, created.id);
      expect(orderCount).toBeGreaterThan(0);
    } finally {
      await deleteConnector(api, token, created.id);
      await api.dispose();
    }
  });

  // --- Scenario 5: Email door (simulated via webhook) -------------------
  //
  // The real inbound mail path on staging is wired all the way to the
  // email-worker's HTTP bridge into `/api/webhooks/connector-email-ingest`,
  // but the *DNS-level* MX binding is intentionally left off staging
  // (no inbound mail ever reaches the staging Email Worker). To still
  // exercise the dispatch path end-to-end, this test posts the same
  // payload the email-worker would generate — that's the seam the
  // orchestrator actually consumes, so it covers the orchestrator
  // bridge plus the mapping code without needing real SMTP.
  //
  // If staging ever gets MX-bound for inbound, replace this with a real
  // mail send + assert via run row. The code wire-up below already
  // matches `EmailWorkerPayload` shape from the email-worker source.
  test('email door — webhook bridge with base64 attachment', async ({
    baseURL,
  }) => {
    const url = baseURL!;
    const { api, token } = await adminApi(url);

    const created = await createConnector(
      api,
      token,
      `E2E email ${Date.now()}`,
    );

    try {
      const auth = { Authorization: `Bearer ${token}` };

      // Encode the CSV as base64 — the email worker does the same
      // before pushing into the webhook.
      const csvB64 = created.csvBytes.toString('base64');

      const ingestRes = await api.post(
        '/api/webhooks/connector-email-ingest',
        {
          headers: { ...auth, 'Content-Type': 'application/json' },
          data: {
            connector_id: created.id,
            tenant_id: TENANT_ID,
            sender: 'partner@example.com',
            subject: 'Order batch — e2e test',
            body: 'See attached.',
            attachments: [
              {
                filename: 'connector-orders.csv',
                content_type: 'text/csv',
                size: created.csvBytes.length,
                content_base64: csvB64,
              },
            ],
          },
        },
      );
      expect(ingestRes.status(), await ingestRes.text()).toBe(200);
      const ingestBody = (await ingestRes.json()) as {
        success: boolean;
        run_id: string;
        status: string;
      };
      expect(ingestBody.success).toBe(true);
      expect(ingestBody.run_id).toBeTruthy();

      const summary = await fetchRunSummary(api, token, created.id);
      expect(summary.total).toBeGreaterThan(0);
      // Status is `success` if the orchestrator parsed the attachment.
      // If the run came back `error`, fail loudly with the body so the
      // staging orchestrator regression is visible.
      expect(summary.latestStatus).toBe('success');

      const orderCount = await fetchOrderCount(api, token, created.id);
      expect(orderCount).toBeGreaterThan(0);
    } finally {
      await deleteConnector(api, token, created.id);
      await api.dispose();
    }
  });
});
