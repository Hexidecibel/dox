/**
 * Tests for the Phase B4 public-link management endpoints.
 *
 *   POST   /api/connectors/:id/public-link/generate
 *   DELETE /api/connectors/:id/public-link
 *
 * Both sit behind the standard JWT/API-key gate and require
 * super_admin or org_admin in the connector's tenant.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPost as generatePost } from '../../functions/api/connectors/[id]/public-link/generate';
import { onRequestDelete as revokeDelete } from '../../functions/api/connectors/[id]/public-link/index';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

function defaultMappings() {
  return {
    version: 2,
    core: {
      order_number: { enabled: true, required: true, source_labels: ['Order #'] },
    },
    extended: [],
  };
}

async function insertConnector(opts: {
  tenantId: string;
  publicLinkToken?: string | null;
  publicLinkExpiresAt?: number | null;
  slug?: string | null;
}): Promise<{ id: string; slug: string | null }> {
  const id = generateTestId();
  const slug =
    opts.slug === undefined ? `plm-test-${id.slice(0, 8)}` : opts.slug;
  await db
    .prepare(
      `INSERT INTO connectors (id, tenant_id, name, slug,
                               config, field_mappings, active,
                               public_link_token, public_link_expires_at,
                               created_at, updated_at)
       VALUES (?, ?, ?, ?, '{}', ?, 1, ?, ?,
               datetime('now'), datetime('now'))`,
    )
    .bind(
      id,
      opts.tenantId,
      `plm-test-${id}`,
      slug,
      JSON.stringify(defaultMappings()),
      opts.publicLinkToken === undefined ? null : opts.publicLinkToken,
      opts.publicLinkExpiresAt === undefined ? null : opts.publicLinkExpiresAt,
    )
    .run();
  return { id, slug };
}

function makeGenerateContext(
  connectorId: string,
  user: { id: string; role: string; tenant_id: string | null },
  body: Record<string, unknown> | null = null,
) {
  const init: RequestInit = { method: 'POST' };
  if (body !== null) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  const request = new Request(
    `http://localhost/api/connectors/${connectorId}/public-link/generate`,
    init,
  );
  return {
    request,
    env,
    data: { user },
    params: { id: connectorId },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/connectors/${connectorId}/public-link/generate`,
  } as any;
}

function makeRevokeContext(
  connectorId: string,
  user: { id: string; role: string; tenant_id: string | null },
) {
  const request = new Request(
    `http://localhost/api/connectors/${connectorId}/public-link`,
    { method: 'DELETE' },
  );
  return {
    request,
    env,
    data: { user },
    params: { id: connectorId },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/connectors/${connectorId}/public-link`,
  } as any;
}

describe('POST /api/connectors/:id/public-link/generate — permission gate', () => {
  it('blocks readers with 403', async () => {
    const { id } = await insertConnector({ tenantId: seed.tenantId });
    const ctx = makeGenerateContext(id, {
      id: seed.readerId,
      role: 'reader',
      tenant_id: seed.tenantId,
    });
    const resp = await generatePost(ctx);
    expect(resp.status).toBe(403);
  });

  it('blocks regular users with 403', async () => {
    const { id } = await insertConnector({ tenantId: seed.tenantId });
    const ctx = makeGenerateContext(id, {
      id: seed.userId,
      role: 'user',
      tenant_id: seed.tenantId,
    });
    const resp = await generatePost(ctx);
    expect(resp.status).toBe(403);
  });

  it('blocks org_admins from a different tenant', async () => {
    const { id } = await insertConnector({ tenantId: seed.tenantId });
    const ctx = makeGenerateContext(id, {
      id: seed.orgAdmin2Id,
      role: 'org_admin',
      tenant_id: seed.tenantId2,
    });
    const resp = await generatePost(ctx);
    expect(resp.status).toBe(403);
  });

  it('allows org_admin in the connector tenant', async () => {
    const { id } = await insertConnector({ tenantId: seed.tenantId });
    const ctx = makeGenerateContext(id, {
      id: seed.orgAdminId,
      role: 'org_admin',
      tenant_id: seed.tenantId,
    });
    const resp = await generatePost(ctx);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { public_link_token: string };
    expect(body.public_link_token).toMatch(/^[a-f0-9]{64}$/);
  });

  it('allows super_admin against any tenant', async () => {
    const { id } = await insertConnector({ tenantId: seed.tenantId });
    const ctx = makeGenerateContext(id, {
      id: seed.superAdminId,
      role: 'super_admin',
      tenant_id: null,
    });
    const resp = await generatePost(ctx);
    expect(resp.status).toBe(200);
  });
});

describe('POST /api/connectors/:id/public-link/generate — behavior', () => {
  it('defaults to a 30-day expiry when no body is sent', async () => {
    const { id } = await insertConnector({ tenantId: seed.tenantId });
    const ctx = makeGenerateContext(id, {
      id: seed.orgAdminId,
      role: 'org_admin',
      tenant_id: seed.tenantId,
    });
    const resp = await generatePost(ctx);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      public_link_expires_at: number | null;
      rotated: boolean;
      url: string;
    };
    expect(body.public_link_expires_at).not.toBeNull();
    const now = Math.floor(Date.now() / 1000);
    expect(body.public_link_expires_at!).toBeGreaterThan(now + 29 * 86400);
    expect(body.public_link_expires_at!).toBeLessThan(now + 31 * 86400);
    expect(body.rotated).toBe(false);
    // URL embeds the slug + token.
    expect(body.url).toMatch(/\/drop\/[a-z0-9-]+\/[a-f0-9]{64}$/);
  });

  it('honors explicit `expires_in_days`', async () => {
    const { id } = await insertConnector({ tenantId: seed.tenantId });
    const ctx = makeGenerateContext(
      id,
      { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId },
      { expires_in_days: 7 },
    );
    const resp = await generatePost(ctx);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { public_link_expires_at: number | null };
    const now = Math.floor(Date.now() / 1000);
    expect(body.public_link_expires_at!).toBeGreaterThan(now + 6 * 86400);
    expect(body.public_link_expires_at!).toBeLessThan(now + 8 * 86400);
  });

  it('treats `expires_in_days: null` as no expiry', async () => {
    const { id } = await insertConnector({ tenantId: seed.tenantId });
    const ctx = makeGenerateContext(
      id,
      { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId },
      { expires_in_days: null },
    );
    const resp = await generatePost(ctx);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { public_link_expires_at: number | null };
    expect(body.public_link_expires_at).toBeNull();
  });

  it('rejects negative / non-integer expiry with 400', async () => {
    const { id } = await insertConnector({ tenantId: seed.tenantId });
    const ctx = makeGenerateContext(
      id,
      { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId },
      { expires_in_days: -1 },
    );
    const resp = await generatePost(ctx);
    expect(resp.status).toBe(400);
  });

  it('rotates idempotently: second call replaces the token and returns rotated:true', async () => {
    const { id } = await insertConnector({
      tenantId: seed.tenantId,
      publicLinkToken: 'pre-existing-token',
      publicLinkExpiresAt: null,
    });
    const ctx = makeGenerateContext(id, {
      id: seed.orgAdminId,
      role: 'org_admin',
      tenant_id: seed.tenantId,
    });
    const resp = await generatePost(ctx);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { public_link_token: string; rotated: boolean };
    expect(body.rotated).toBe(true);
    expect(body.public_link_token).not.toBe('pre-existing-token');
    expect(body.public_link_token).toMatch(/^[a-f0-9]{64}$/);

    const row = await db
      .prepare(`SELECT public_link_token FROM connectors WHERE id = ?`)
      .bind(id)
      .first<{ public_link_token: string }>();
    expect(row?.public_link_token).toBe(body.public_link_token);
  });

  it('writes an audit row tagged `connector.public_link_generated` (or _rotated) carrying only last4', async () => {
    const { id } = await insertConnector({ tenantId: seed.tenantId });
    const ctx = makeGenerateContext(id, {
      id: seed.orgAdminId,
      role: 'org_admin',
      tenant_id: seed.tenantId,
    });
    const resp = await generatePost(ctx);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { public_link_token: string };

    const audit = await db
      .prepare(
        `SELECT action, details FROM audit_log
          WHERE resource_type = 'connector' AND resource_id = ?
          ORDER BY id DESC LIMIT 1`,
      )
      .bind(id)
      .first<{ action: string; details: string }>();
    expect(audit?.action).toBe('connector.public_link_generated');
    const details = JSON.parse(audit!.details) as { last4: string };
    expect(details.last4).toBe(body.public_link_token.slice(-4));
    expect(audit!.details).not.toContain(body.public_link_token);
  });

  it('returns 404 for a missing connector', async () => {
    const fakeId = generateTestId();
    const ctx = makeGenerateContext(fakeId, {
      id: seed.superAdminId,
      role: 'super_admin',
      tenant_id: null,
    });
    const resp = await generatePost(ctx);
    expect(resp.status).toBe(404);
  });
});

describe('DELETE /api/connectors/:id/public-link — permission gate', () => {
  it('blocks readers with 403', async () => {
    const { id } = await insertConnector({
      tenantId: seed.tenantId,
      publicLinkToken: 'rev-pre-tok',
    });
    const ctx = makeRevokeContext(id, {
      id: seed.readerId,
      role: 'reader',
      tenant_id: seed.tenantId,
    });
    const resp = await revokeDelete(ctx);
    expect(resp.status).toBe(403);
  });

  it('blocks org_admins from a different tenant', async () => {
    const { id } = await insertConnector({
      tenantId: seed.tenantId,
      publicLinkToken: 'rev-other-tenant',
    });
    const ctx = makeRevokeContext(id, {
      id: seed.orgAdmin2Id,
      role: 'org_admin',
      tenant_id: seed.tenantId2,
    });
    const resp = await revokeDelete(ctx);
    expect(resp.status).toBe(403);
  });
});

describe('DELETE /api/connectors/:id/public-link — behavior', () => {
  it('clears both token + expiry and returns revoked:true on first call', async () => {
    const { id } = await insertConnector({
      tenantId: seed.tenantId,
      publicLinkToken: 'rev-token',
      publicLinkExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const ctx = makeRevokeContext(id, {
      id: seed.orgAdminId,
      role: 'org_admin',
      tenant_id: seed.tenantId,
    });
    const resp = await revokeDelete(ctx);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { revoked: boolean };
    expect(body.revoked).toBe(true);

    const row = await db
      .prepare(
        `SELECT public_link_token, public_link_expires_at FROM connectors WHERE id = ?`,
      )
      .bind(id)
      .first<{
        public_link_token: string | null;
        public_link_expires_at: number | null;
      }>();
    expect(row?.public_link_token).toBeNull();
    expect(row?.public_link_expires_at).toBeNull();
  });

  it('is idempotent: revoking when there is no link returns revoked:false (200)', async () => {
    const { id } = await insertConnector({ tenantId: seed.tenantId });
    const ctx = makeRevokeContext(id, {
      id: seed.orgAdminId,
      role: 'org_admin',
      tenant_id: seed.tenantId,
    });
    const resp = await revokeDelete(ctx);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { revoked: boolean };
    expect(body.revoked).toBe(false);
  });

  it('writes an audit row tagged `connector.public_link_revoked` only when there was a token', async () => {
    const { id } = await insertConnector({
      tenantId: seed.tenantId,
      publicLinkToken: 'rev-audit-tok',
    });
    const ctx = makeRevokeContext(id, {
      id: seed.orgAdminId,
      role: 'org_admin',
      tenant_id: seed.tenantId,
    });
    const resp = await revokeDelete(ctx);
    expect(resp.status).toBe(200);

    const audit = await db
      .prepare(
        `SELECT action FROM audit_log
          WHERE resource_type = 'connector' AND resource_id = ?
          ORDER BY id DESC LIMIT 1`,
      )
      .bind(id)
      .first<{ action: string }>();
    expect(audit?.action).toBe('connector.public_link_revoked');
  });

  it('returns 404 for a missing connector', async () => {
    const fakeId = generateTestId();
    const ctx = makeRevokeContext(fakeId, {
      id: seed.superAdminId,
      role: 'super_admin',
      tenant_id: null,
    });
    const resp = await revokeDelete(ctx);
    expect(resp.status).toBe(404);
  });
});
