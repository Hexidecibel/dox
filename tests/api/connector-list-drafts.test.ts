/**
 * Regression test for GET /api/connectors — draft visibility.
 *
 * Previously the list endpoint defaulted to `WHERE c.active = 1`, which
 * hid every saved draft from the main list because "Save as Draft" in the
 * wizard stores active=0. Users had no way to see their drafts short of
 * adding `?active=0` in the URL.
 *
 * The fix:
 *  - Default query returns BOTH active=1 and active=0
 *  - Tombstoned rows (deleted_at IS NOT NULL) are always hidden
 *  - ?active=1 and ?active=0 still work as explicit filters
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestGet as listConnectors } from '../../functions/api/connectors/index';
import { onRequestDelete as deleteConnector } from '../../functions/api/connectors/[id]';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

async function insertConnector(opts: {
  tenantId: string;
  active: number;
  name: string;
}): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO connectors (id, tenant_id, name, config, field_mappings, active, created_at, updated_at)
       VALUES (?, ?, ?, '{}', ?, ?, datetime('now'), datetime('now'))`,
    )
    .bind(
      id,
      opts.tenantId,
      opts.name,
      JSON.stringify({ version: 2, core: {}, extended: [] }),
      opts.active,
    )
    .run();
  return id;
}

function makeListContext(
  user: { id: string; role: string; tenant_id: string | null },
  query: Record<string, string> = {},
) {
  const qs = new URLSearchParams(query);
  const url = `http://localhost/api/connectors${qs.toString() ? '?' + qs.toString() : ''}`;
  const request = new Request(url, { method: 'GET' });
  return {
    request,
    env,
    data: { user },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/connectors',
  } as any;
}

function makeDeleteContext(
  id: string,
  user: { id: string; role: string; tenant_id: string | null },
) {
  const request = new Request(`http://localhost/api/connectors/${id}`, { method: 'DELETE' });
  return {
    request,
    env,
    data: { user },
    params: { id },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/connectors/${id}`,
  } as any;
}

describe('GET /api/connectors — draft visibility', () => {
  it('returns BOTH active and inactive connectors by default', async () => {
    // Seed a fresh pair so we can assert on exact ids without stepping on
    // other tests' leftovers.
    const activeName = `active-${Date.now()}`;
    const draftName = `draft-${Date.now()}`;
    const activeId = await insertConnector({
      tenantId: seed.tenantId,
      active: 1,
      name: activeName,
    });
    const draftId = await insertConnector({
      tenantId: seed.tenantId,
      active: 0,
      name: draftName,
    });

    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const response = await listConnectors(makeListContext(user));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      connectors: Array<{ id: string; active: number }>;
    };
    const ids = body.connectors.map((c) => c.id);
    expect(ids).toContain(activeId);
    expect(ids).toContain(draftId);

    const draftRow = body.connectors.find((c) => c.id === draftId);
    expect(draftRow).toBeDefined();
    // active is 0 for a draft — the field drives the UI's Draft chip.
    expect(draftRow!.active).toBe(0);
  });

  it('?active=1 still filters to only active connectors', async () => {
    const draftId = await insertConnector({
      tenantId: seed.tenantId,
      active: 0,
      name: `filter-draft-${Date.now()}`,
    });

    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const response = await listConnectors(makeListContext(user, { active: '1' }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      connectors: Array<{ id: string; active: number }>;
    };
    const ids = body.connectors.map((c) => c.id);
    expect(ids).not.toContain(draftId);
    // All returned rows should be active.
    for (const c of body.connectors) {
      expect(c.active).toBe(1);
    }
  });

  it('?active=0 still filters to only drafts', async () => {
    const activeId = await insertConnector({
      tenantId: seed.tenantId,
      active: 1,
      name: `filter-active-${Date.now()}`,
    });

    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const response = await listConnectors(makeListContext(user, { active: '0' }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      connectors: Array<{ id: string; active: number }>;
    };
    const ids = body.connectors.map((c) => c.id);
    expect(ids).not.toContain(activeId);
    for (const c of body.connectors) {
      expect(c.active).toBe(0);
    }
  });

  it('tombstoned (deleted_at IS NOT NULL) connectors are hidden from the list', async () => {
    const id = await insertConnector({
      tenantId: seed.tenantId,
      active: 1,
      name: `delete-${Date.now()}`,
    });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    // Delete stamps deleted_at via the handler.
    const deleteResponse = await deleteConnector(makeDeleteContext(id, user));
    expect(deleteResponse.status).toBe(200);

    // Default list must not surface the tombstoned row.
    const listResponse = await listConnectors(makeListContext(user));
    const listBody = (await listResponse.json()) as {
      connectors: Array<{ id: string }>;
    };
    const ids = listBody.connectors.map((c) => c.id);
    expect(ids).not.toContain(id);

    // Even ?active=0 must not surface it — deleted_at is a stronger filter
    // than active alone.
    const activeZeroResponse = await listConnectors(makeListContext(user, { active: '0' }));
    const activeZeroBody = (await activeZeroResponse.json()) as {
      connectors: Array<{ id: string }>;
    };
    expect(activeZeroBody.connectors.map((c) => c.id)).not.toContain(id);
  });
});
