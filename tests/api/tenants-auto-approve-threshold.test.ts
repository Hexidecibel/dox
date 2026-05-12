/**
 * Doc-R1: PUT /api/tenants/:id should accept `auto_approve_threshold` for
 * super_admin, validate range [0, 1], allow null to disable, and reject the
 * field for org_admin (alongside slug/active which are already restricted).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData } from '../helpers/db';
import { onRequestPut as updateTenant } from '../../functions/api/tenants/[id]';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

function makePutContext(
  id: string,
  body: Record<string, unknown>,
  user: { id: string; role: string; tenant_id: string | null }
) {
  const request = new Request(`http://localhost/api/tenants/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    request,
    env,
    data: { user },
    params: { id },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/tenants/${id}`,
  } as unknown as Parameters<typeof updateTenant>[0];
}

describe('PUT /api/tenants/:id — auto_approve_threshold', () => {
  it('super_admin can set a numeric threshold in [0, 1]', async () => {
    const superUser = { id: seed.superAdminId, role: 'super_admin', tenant_id: null };
    const res = await updateTenant(makePutContext(seed.tenantId, { auto_approve_threshold: 0.85 }, superUser));
    expect(res.status).toBe(200);
    const row = await db
      .prepare('SELECT auto_approve_threshold FROM tenants WHERE id = ?')
      .bind(seed.tenantId)
      .first<{ auto_approve_threshold: number | null }>();
    expect(row!.auto_approve_threshold).toBeCloseTo(0.85, 5);
  });

  it('super_admin can clear the threshold with null (disables auto-approve)', async () => {
    const superUser = { id: seed.superAdminId, role: 'super_admin', tenant_id: null };
    // seed something first
    await updateTenant(makePutContext(seed.tenantId, { auto_approve_threshold: 0.5 }, superUser));
    // clear it
    const res = await updateTenant(makePutContext(seed.tenantId, { auto_approve_threshold: null }, superUser));
    expect(res.status).toBe(200);
    const row = await db
      .prepare('SELECT auto_approve_threshold FROM tenants WHERE id = ?')
      .bind(seed.tenantId)
      .first<{ auto_approve_threshold: number | null }>();
    expect(row!.auto_approve_threshold).toBeNull();
  });

  it('super_admin can set the boundary values 0 and 1', async () => {
    const superUser = { id: seed.superAdminId, role: 'super_admin', tenant_id: null };
    let res = await updateTenant(makePutContext(seed.tenantId, { auto_approve_threshold: 0 }, superUser));
    expect(res.status).toBe(200);
    res = await updateTenant(makePutContext(seed.tenantId, { auto_approve_threshold: 1 }, superUser));
    expect(res.status).toBe(200);
  });

  it('rejects values outside [0, 1] with 400', async () => {
    const superUser = { id: seed.superAdminId, role: 'super_admin', tenant_id: null };
    for (const bad of [-0.1, 1.5, 2, -1]) {
      const res = await updateTenant(makePutContext(seed.tenantId, { auto_approve_threshold: bad }, superUser));
      expect(res.status).toBe(400);
    }
  });

  it('rejects non-numeric, non-null threshold values with 400', async () => {
    const superUser = { id: seed.superAdminId, role: 'super_admin', tenant_id: null };
    // Note: JSON.stringify(NaN) serializes to "null" so we can't test NaN
    // through the JSON wire — that's effectively a "clear it" request.
    for (const bad of ['0.5', 'high', true]) {
      const res = await updateTenant(makePutContext(seed.tenantId, { auto_approve_threshold: bad }, superUser));
      expect(res.status).toBe(400);
    }
  });

  it('forbids org_admin from setting auto_approve_threshold (super_admin only)', async () => {
    const orgAdmin = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const res = await updateTenant(makePutContext(seed.tenantId, { auto_approve_threshold: 0.9 }, orgAdmin));
    expect(res.status).toBe(403);
  });
});
