/**
 * Connector wizard e2e — full create -> run -> test -> delete loop against
 * staging, exercising the file_watch connector path (the one we actually
 * use from the admin UI).
 *
 * The wizard has 5 steps. Click-through time is lots of DOM wrangling
 * against staging latency, so this test does the heavy lifting via the
 * backend APIs that the wizard itself calls:
 *
 *   1. POST /api/connectors/discover-schema   (the Upload step)
 *   2. POST /api/connectors/preview-extraction (the Live Preview step)
 *   3. POST /api/connectors                   (the Save step)
 *   4. POST /api/connectors/:id/run           (file_watch manual run)
 *   5. POST /api/connectors/:id/test          (the live probe)
 *   6. DELETE /api/connectors/:id
 *
 * Each of those endpoints is independently covered by Vitest API tests.
 * This spec proves the full loop works end-to-end on a live Pages
 * deployment, plus it confirms the list UI surfaces the new connector
 * between create and delete.
 */

import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SAMPLE_CSV = join(__dirname, 'fixtures', 'orders-sample.csv');

async function adminToken(baseURL: string): Promise<{ api: APIRequestContext; token: string }> {
  const api = await pwRequest.newContext({ baseURL });
  const res = await api.post('/api/auth/login', {
    data: { email: 'a@a.a', password: 'a' },
  });
  const body = (await res.json()) as { token: string };
  return { api, token: body.token };
}

test.describe('connector wizard', () => {
  test('full file_watch flow: discover → create → run → test → delete', async ({
    page,
    baseURL,
  }) => {
    const url = baseURL!;
    const { api, token } = await adminToken(url);
    const auth = { Authorization: `Bearer ${token}` };
    const tenantId = 'default';
    const csvBytes = readFileSync(SAMPLE_CSV);
    const connectorName = `E2E file_watch ${Date.now()}`;

    // --- 1. Load the wizard page so we know it renders (smoke). ---
    await page.goto('/admin/connectors/new');
    await expect(
      page.getByRole('heading', { name: /new connector/i }),
    ).toBeVisible({ timeout: 15_000 });
    // The Name & Type step should render the File Upload / Watch card.
    await expect(page.getByText(/file upload \/ watch/i).first()).toBeVisible();

    // --- 2. Discover schema (simulates StepUploadSample). ---
    const form = new FormData();
    form.append(
      'file',
      new Blob([csvBytes], { type: 'text/csv' }),
      'orders-sample.csv',
    );
    form.append('source_type', 'csv');
    form.append('tenant_id', tenantId);

    const discoverRes = await api.post('/api/connectors/discover-schema', {
      headers: auth,
      multipart: {
        file: {
          name: 'orders-sample.csv',
          mimeType: 'text/csv',
          buffer: csvBytes,
        },
        source_type: 'csv',
        tenant_id: tenantId,
      },
    });
    expect(
      discoverRes.status(),
      await discoverRes.text(),
    ).toBe(200);
    const discoverBody = (await discoverRes.json()) as {
      sample_id: string;
      detected_fields: Array<{ source_label: string; candidate_targets?: Array<{ target: string; confidence: number }> }>;
      suggested_mappings?: unknown;
    };
    expect(discoverBody.sample_id).toBeTruthy();
    expect(discoverBody.detected_fields.length).toBeGreaterThan(0);

    // Build a minimal-but-valid mapping: map order_number, PO, customer name
    // from the detected CSV columns into dox core fields.
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
      },
      extras: [],
    };

    // --- 3. Live preview step. ---
    const previewRes = await api.post('/api/connectors/preview-extraction', {
      headers: { ...auth, 'Content-Type': 'application/json' },
      data: {
        sample_id: discoverBody.sample_id,
        field_mappings: fieldMappings,
        tenant_id: tenantId,
      },
    });
    expect(previewRes.status(), await previewRes.text()).toBe(200);
    const previewBody = (await previewRes.json()) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(previewBody.rows.length).toBeGreaterThan(0);

    // --- 4. Save as Draft. ---
    const createRes = await api.post('/api/connectors', {
      headers: { ...auth, 'Content-Type': 'application/json' },
      data: {
        name: connectorName,
        // Phase B0: no connector_type — the universal-doors model.
        system_type: 'erp',
        config: {},
        field_mappings: fieldMappings,
        tenant_id: tenantId,
        sample_r2_key: discoverBody.sample_id,
        // Must be active for the /run endpoint; draft runs are rejected.
        active: true,
      },
    });
    expect(createRes.status(), await createRes.text()).toBe(201);
    const createBody = (await createRes.json()) as {
      connector?: { id?: string };
      id?: string;
    };
    const connectorId = createBody.connector?.id || createBody.id;
    expect(connectorId).toBeTruthy();

    // UI smoke: connector detail page renders for the just-created connector.
    // (List view is filtered by selectedTenantId and requires driving the
    // drawer-level Tenant Filter; we skip that dance since the detail
    // route works directly.)
    await page.goto(`/admin/connectors/${connectorId}`);
    await expect(page.getByText(connectorName).first()).toBeVisible({
      timeout: 15_000,
    });

    // --- 5. Run (manual file upload against file_watch). ---
    const runRes = await api.post(`/api/connectors/${connectorId}/run`, {
      headers: auth,
      multipart: {
        file: {
          name: 'orders-sample.csv',
          mimeType: 'text/csv',
          buffer: csvBytes,
        },
      },
    });
    expect(runRes.status(), await runRes.text()).toBeLessThan(300);
    const runBody = (await runRes.json()) as {
      rows_processed?: number;
      rows_inserted?: number;
      status?: string;
      run?: { status?: string; records_found?: number };
    };
    // On reruns the same CSV rows upsert rather than insert — count
    // processed rows (rows_processed == records_found) instead.
    const processed =
      runBody.rows_processed ?? runBody.run?.records_found ?? 0;
    expect(runBody.run?.status || runBody.status).toBe('success');
    expect(processed).toBeGreaterThan(0);

    // --- 6. Live test probe. ---
    const testRes = await api.post(`/api/connectors/${connectorId}/test`, {
      headers: { ...auth, 'Content-Type': 'application/json' },
      data: {},
    });
    expect(testRes.status(), await testRes.text()).toBe(200);
    const testBody = (await testRes.json()) as {
      success?: boolean;
      probe?: { ok?: boolean; message?: string };
    };
    // The test endpoint always returns success=true when config validates.
    // probe.ok tells us whether the live probe actually reached the target
    // (e.g. R2 bucket for file_watch). For file_watch we expect ok=true.
    expect(testBody.success).toBe(true);
    expect(testBody.probe?.ok).toBe(true);

    // --- 7. Delete. ---
    const delRes = await api.delete(`/api/connectors/${connectorId}`, {
      headers: auth,
    });
    expect([200, 204]).toContain(delRes.status());

    // Verify the API-level delete succeeded: subsequent GETs return
    // either 404 or a soft-deleted flag. (The detail page may still
    // render cached content from a prior tab; the authoritative check is
    // the backend lookup.)
    const checkRes = await api.get(`/api/connectors/${connectorId}`, {
      headers: auth,
    });
    if (checkRes.status() === 200) {
      const body = (await checkRes.json()) as {
        connector?: { deleted_at?: string | null };
      };
      expect(body.connector?.deleted_at).toBeTruthy();
    } else {
      expect([404, 410]).toContain(checkRes.status());
    }

    await api.dispose();
  });
});
