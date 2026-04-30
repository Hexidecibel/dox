/**
 * Tests for `POST /api/connectors` slug handling — Phase B0.5.
 *
 * Coverage:
 *   - Explicit valid slug round-trips through INSERT.
 *   - Missing slug -> server slugifies the name and uses that.
 *   - Invalid slug shape -> 400.
 *   - Conflict on existing slug -> 409 with `{ error: 'slug_taken',
 *     suggested: '<base>-2' }` so the wizard can offer a one-click
 *     alternative.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData } from '../helpers/db';
import { onRequestPost as createConnector } from '../../functions/api/connectors/index';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

function makePostContext(
  body: Record<string, unknown>,
  user: { id: string; role: string; tenant_id: string | null },
) {
  const request = new Request('http://localhost/api/connectors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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

describe('POST /api/connectors — slug handling', () => {
  it('persists an explicit slug and returns it on the created row', async () => {
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const response = await createConnector(
      makePostContext(
        {
          name: 'Slug Explicit Test',
          slug: 'slug-explicit-test',
          tenant_id: seed.tenantId,
        },
        user,
      ),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { connector: { id: string; slug: string } };
    expect(body.connector.slug).toBe('slug-explicit-test');

    // Cross-check the row directly.
    const row = await db
      .prepare('SELECT slug FROM connectors WHERE id = ?')
      .bind(body.connector.id)
      .first<{ slug: string }>();
    expect(row?.slug).toBe('slug-explicit-test');
  });

  it('auto-derives slug from name when slug is omitted', async () => {
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const response = await createConnector(
      makePostContext(
        {
          name: 'Auto Derived Connector',
          tenant_id: seed.tenantId,
        },
        user,
      ),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { connector: { slug: string } };
    expect(body.connector.slug).toBe('auto-derived-connector');
  });

  it('rejects a malformed slug with 400', async () => {
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const response = await createConnector(
      makePostContext(
        {
          name: 'Bad Slug Test',
          slug: 'Has Caps and spaces',
          tenant_id: seed.tenantId,
        },
        user,
      ),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/slug/i);
  });

  it('returns 409 with a suggested alternative when the slug is taken', async () => {
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    // First create — should succeed.
    const first = await createConnector(
      makePostContext(
        {
          name: 'Conflict Original',
          slug: 'conflict-original',
          tenant_id: seed.tenantId,
        },
        user,
      ),
    );
    expect(first.status).toBe(201);

    // Second create with the same slug — should 409 with a suggestion.
    const second = await createConnector(
      makePostContext(
        {
          name: 'Conflict Duplicate',
          slug: 'conflict-original',
          tenant_id: seed.tenantId,
        },
        user,
      ),
    );
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string; suggested: string };
    expect(body.error).toBe('slug_taken');
    expect(body.suggested).toBe('conflict-original-2');
  });
});
