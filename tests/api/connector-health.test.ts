/**
 * Phase B5 — GET /api/connectors/:id/health
 *
 * Aggregates 24h dispatched + success rate, last-error (7d lookback),
 * and per-source pills off connector_runs. Empty state when there's
 * been zero activity.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestGet as healthGet } from '../../functions/api/connectors/[id]/health';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

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
       VALUES (?, ?, ?, ?, 'erp', '{}', '{}', 1,
               datetime('now'), datetime('now'))`,
    )
    .bind(
      id,
      seed.tenantId,
      `health-${id}`,
      `health-${id.slice(0, 8)}`,
    )
    .run();
  return id;
}

async function insertRun(opts: {
  connectorId: string;
  status: 'success' | 'error' | 'partial' | 'running';
  source: string;
  startedAtIso?: string;
  errorMessage?: string;
}): Promise<string> {
  const id = generateTestId();
  const startedAt = opts.startedAtIso ?? new Date().toISOString().replace('T', ' ').replace(/\..*Z$/, '');
  await db
    .prepare(
      `INSERT INTO connector_runs (id, connector_id, tenant_id, status, source,
                                   started_at, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      opts.connectorId,
      seed.tenantId,
      opts.status,
      opts.source,
      startedAt,
      opts.errorMessage ?? null,
    )
    .run();
  return id;
}

const orgAdmin = {
  id: 'user-org-admin',
  email: 'orgadmin@test.com',
  name: 'Org Admin',
  role: 'org_admin',
  tenant_id: 'test-tenant-001',
  active: 1,
};

function makeContext(connectorId: string, user: any): any {
  return {
    request: new Request(`http://localhost/api/connectors/${connectorId}/health`),
    env,
    data: { user },
    params: { id: connectorId },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/connectors/${connectorId}/health`,
  };
}

describe('GET /api/connectors/:id/health', () => {
  it('returns the empty-state shape when nothing happened', async () => {
    const id = await insertConnector();
    const resp = await healthGet(makeContext(id, orgAdmin));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.last_24h.dispatched).toBe(0);
    expect(body.last_24h.success_rate).toBeNull();
    expect(body.last_error).toBeNull();
    expect(body.window_hours).toBe(24);
  });

  it('aggregates 24h counts, success rate, last error, and per-source pills', async () => {
    const id = await insertConnector();
    // Six runs in the window: 3 success (2 manual + 1 api), 1 partial
    // (email), 2 error (api).
    await insertRun({ connectorId: id, status: 'success', source: 'manual' });
    await insertRun({ connectorId: id, status: 'success', source: 'manual' });
    await insertRun({ connectorId: id, status: 'success', source: 'api' });
    await insertRun({ connectorId: id, status: 'partial', source: 'email' });
    await insertRun({
      connectorId: id, status: 'error', source: 'api',
      errorMessage: 'older error',
      // ~30 minutes ago
      startedAtIso: new Date(Date.now() - 30 * 60 * 1000)
        .toISOString().replace('T', ' ').replace(/\..*Z$/, ''),
    });
    await insertRun({
      connectorId: id, status: 'error', source: 'api',
      errorMessage: 'most recent boom',
    });

    const resp = await healthGet(makeContext(id, orgAdmin));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;

    expect(body.last_24h.dispatched).toBe(6);
    expect(body.last_24h.success).toBe(3);
    expect(body.last_24h.partial).toBe(1);
    expect(body.last_24h.error).toBe(2);
    // 3 / (3 + 1 + 2) = 50%
    expect(body.last_24h.success_rate).toBe(50);

    expect(body.by_source.manual).toBe(2);
    expect(body.by_source.api).toBe(3);
    expect(body.by_source.email).toBe(1);
    expect(body.by_source.s3).toBe(0);

    expect(body.last_error).toBeTruthy();
    expect(body.last_error.error_message).toBe('most recent boom');
  });
});
