/**
 * Phase B5 — activity feed source filter (now wired against
 * connector_runs.source).
 *
 * The B0-era report flagged the source filter as a no-op for connector
 * runs because `connector_runs` had no source column. Migration 0049
 * added it; this test confirms the filter actually narrows the
 * connector_run rows in the feed.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestGet as activityGet } from '../../functions/api/activity/index';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);

  // Make a connector and seed a mix of source-tagged runs.
  const connectorId = generateTestId();
  await db
    .prepare(
      `INSERT INTO connectors (id, tenant_id, name, slug,
                               config, field_mappings, active,
                               created_at, updated_at)
       VALUES (?, ?, ?, ?, '{}', '{}', 1,
               datetime('now'), datetime('now'))`,
    )
    .bind(connectorId, seed.tenantId, 'src-filter-conn', `src-filter-${connectorId.slice(0, 8)}`)
    .run();

  const insertRun = async (source: string) => {
    await db
      .prepare(
        `INSERT INTO connector_runs (id, connector_id, tenant_id, status, source, started_at)
         VALUES (?, ?, ?, 'success', ?, datetime('now'))`,
      )
      .bind(generateTestId(), connectorId, seed.tenantId, source)
      .run();
  };

  await insertRun('manual');
  await insertRun('manual');
  await insertRun('api');
  await insertRun('s3');
  await insertRun('email');
  await insertRun('public_link');
}, 30_000);

const orgAdmin = {
  id: 'user-org-admin',
  email: 'orgadmin@test.com',
  name: 'Org Admin',
  role: 'org_admin',
  tenant_id: 'test-tenant-001',
  active: 1,
};

function buildRequest(source: string): Request {
  const url = new URL('http://localhost/api/activity');
  url.searchParams.set('source', source);
  // Wide window so the seeded rows fall inside.
  url.searchParams.set('event_type', 'connector_run');
  return new Request(url.toString());
}

function makeContext(req: Request): any {
  return {
    request: req,
    env,
    data: { user: orgAdmin },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/activity',
  };
}

describe('GET /api/activity ?source=…', () => {
  it('narrows connector_run events to source=manual', async () => {
    const resp = await activityGet(makeContext(buildRequest('manual')));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { events: any[] };
    const types = new Set(body.events.map((e) => e.type));
    expect(types.has('connector_run')).toBe(true);

    // Every connector_run event in the response should belong to a
    // run with source='manual' (validated by direct DB lookup).
    for (const ev of body.events) {
      if (ev.type !== 'connector_run') continue;
      const row = await db
        .prepare(`SELECT source FROM connector_runs WHERE id = ?`)
        .bind(ev.id)
        .first<{ source: string }>();
      expect(row?.source).toBe('manual');
    }
  });

  it('narrows connector_run events to source=s3', async () => {
    const resp = await activityGet(makeContext(buildRequest('s3')));
    const body = (await resp.json()) as { events: any[] };
    for (const ev of body.events) {
      if (ev.type !== 'connector_run') continue;
      const row = await db
        .prepare(`SELECT source FROM connector_runs WHERE id = ?`)
        .bind(ev.id)
        .first<{ source: string }>();
      expect(row?.source).toBe('s3');
    }
  });

  it('returns no connector_run events when filtering on the queue-only source "import"', async () => {
    const resp = await activityGet(makeContext(buildRequest('import')));
    const body = (await resp.json()) as { events: any[] };
    const runEvents = body.events.filter((e) => e.type === 'connector_run');
    expect(runEvents.length).toBe(0);
  });
});
