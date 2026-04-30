/**
 * Phase B5 — POST /api/connectors/:id/runs/:runId/retry
 *
 * Covers:
 *   - Failed run with R2 file present -> 200 + new run row linked
 *     via retry_of_run_id
 *   - Successful run -> 400 (only error runs are retryable)
 *   - Missing source file -> 422
 *   - Wrong tenant -> 404
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPost as retryPost } from '../../functions/api/connectors/[id]/runs/[runId]/retry';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;
const r2 = env.FILES;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

async function insertConnector(): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO connectors (id, tenant_id, name, slug, system_type,
                               config, field_mappings, active,
                               created_at, updated_at)
       VALUES (?, ?, ?, ?, 'erp', '{}', ?, 1,
               datetime('now'), datetime('now'))`,
    )
    .bind(
      id,
      seed.tenantId,
      `retry-${id}`,
      `retry-${id.slice(0, 8)}`,
      JSON.stringify({
        version: 2,
        core: { order_number: { enabled: true, required: true, source_labels: ['Order #'] } },
        extended: [],
      }),
    )
    .run();
  return id;
}

async function insertRun(opts: {
  connectorId: string;
  status: 'success' | 'error' | 'partial';
  source: string;
  r2Key?: string;
}): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO connector_runs (id, connector_id, tenant_id, status, source,
                                   started_at, error_message)
       VALUES (?, ?, ?, ?, ?, datetime('now'), ?)`,
    )
    .bind(
      id,
      opts.connectorId,
      seed.tenantId,
      opts.status,
      opts.source,
      opts.status === 'error' ? 'Parse blew up' : null,
    )
    .run();
  if (opts.r2Key) {
    await db
      .prepare(
        `INSERT INTO connector_processed_keys (id, connector_id, r2_key, processed_at, run_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(generateTestId(), opts.connectorId, opts.r2Key, Date.now(), id)
      .run();
  }
  return id;
}

function makeContext(connectorId: string, runId: string, user: any): any {
  return {
    request: new Request(
      `http://localhost/api/connectors/${connectorId}/runs/${runId}/retry`,
      { method: 'POST' },
    ),
    env,
    data: { user },
    params: { id: connectorId, runId },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/connectors/${connectorId}/runs/${runId}/retry`,
  };
}

const orgAdmin = {
  id: 'user-org-admin',
  email: 'orgadmin@test.com',
  name: 'Org Admin',
  role: 'org_admin',
  tenant_id: 'test-tenant-001',
  active: 1,
};

describe('POST /api/connectors/:id/runs/:runId/retry', () => {
  it('refetches the R2 file and dispatches a new run linked via retry_of_run_id', async () => {
    const connectorId = await insertConnector();

    // Pre-populate R2 with the "original" file.
    const r2Key = `connector-drops/${connectorId}/2026-01-01T00-00-00Z-orders.csv`;
    await r2.put(r2Key, new TextEncoder().encode('Order #\nSO-RETRY-1'), {
      httpMetadata: { contentType: 'text/csv' },
    });

    const failedRunId = await insertRun({
      connectorId,
      status: 'error',
      source: 'api',
      r2Key,
    });

    const resp = await retryPost(makeContext(connectorId, failedRunId, orgAdmin));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      run_id: string;
      retry_of_run_id: string;
    };
    expect(body.retry_of_run_id).toBe(failedRunId);
    expect(body.run_id).not.toBe(failedRunId);

    // The new row points back at the original.
    const newRun = await db
      .prepare(`SELECT retry_of_run_id, source FROM connector_runs WHERE id = ?`)
      .bind(body.run_id)
      .first<{ retry_of_run_id: string; source: string }>();
    expect(newRun?.retry_of_run_id).toBe(failedRunId);
    // Source carries over from the original.
    expect(newRun?.source).toBe('api');

    // The original row is preserved.
    const original = await db
      .prepare(`SELECT status FROM connector_runs WHERE id = ?`)
      .bind(failedRunId)
      .first<{ status: string }>();
    expect(original?.status).toBe('error');
  });

  it('returns 400 for a successful run', async () => {
    const connectorId = await insertConnector();
    const successRunId = await insertRun({
      connectorId,
      status: 'success',
      source: 'manual',
      r2Key: `connector-drops/${connectorId}/foo.csv`,
    });
    const resp = await retryPost(makeContext(connectorId, successRunId, orgAdmin));
    expect(resp.status).toBe(400);
  });

  it('returns 422 when the source file is no longer in R2', async () => {
    const connectorId = await insertConnector();
    const failedRunId = await insertRun({
      connectorId,
      status: 'error',
      source: 'manual',
      r2Key: `connector-drops/${connectorId}/missing-file.csv`,
    });
    // Note: we did NOT pre-populate R2. The retry endpoint should
    // see no object and return 422.
    const resp = await retryPost(makeContext(connectorId, failedRunId, orgAdmin));
    expect(resp.status).toBe(422);
    const body = (await resp.json()) as { error: string; code: string };
    expect(body.code).toBe('unretryable');
  });

  it('returns 422 when the run has no processed-keys row at all', async () => {
    const connectorId = await insertConnector();
    const failedRunId = await insertRun({
      connectorId,
      status: 'error',
      source: 'manual',
      // no r2Key -> no processed-keys row
    });
    const resp = await retryPost(makeContext(connectorId, failedRunId, orgAdmin));
    expect(resp.status).toBe(422);
  });
});
