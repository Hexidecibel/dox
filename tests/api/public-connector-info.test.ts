/**
 * Tests for `GET /api/public/connectors/:slug?token=<token>` — the
 * Phase B4 public connector-info endpoint that the public drop form
 * hits on mount.
 *
 * The route is allowlisted in `_middleware.ts` (anonymous read) and
 * gated by an unguessable token matched against
 * `connectors.public_link_token`. Every "not visible" reason returns
 * the same generic 404 so the route can't be used to enumerate
 * connectors.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestGet as publicConnectorGet } from '../../functions/api/public/connectors/[slug]';

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
  name?: string;
  slug?: string;
  publicLinkToken?: string | null;
  publicLinkExpiresAt?: number | null;
  active?: number;
  deletedAt?: string | null;
}): Promise<{ id: string; slug: string }> {
  const id = generateTestId();
  const slug = opts.slug ?? `pub-info-${id.slice(0, 8)}`;
  await db
    .prepare(
      `INSERT INTO connectors (id, tenant_id, name, slug, system_type,
                               config, field_mappings, active,
                               public_link_token, public_link_expires_at,
                               deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'erp', '{}', ?, ?, ?, ?, ?,
               datetime('now'), datetime('now'))`,
    )
    .bind(
      id,
      opts.tenantId,
      opts.name ?? `Pub Info ${id}`,
      slug,
      JSON.stringify(defaultMappings()),
      opts.active ?? 1,
      opts.publicLinkToken === undefined ? null : opts.publicLinkToken,
      opts.publicLinkExpiresAt === undefined ? null : opts.publicLinkExpiresAt,
      opts.deletedAt ?? null,
    )
    .run();
  return { id, slug };
}

function makeContext(slug: string, token: string | null) {
  const url = new URL(`http://localhost/api/public/connectors/${slug}`);
  if (token !== null) url.searchParams.set('token', token);
  const request = new Request(url.toString(), { method: 'GET' });
  return {
    request,
    env,
    data: {},
    params: { slug },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/public/connectors/${slug}`,
  } as any;
}

describe('GET /api/public/connectors/:slug — happy path', () => {
  it('returns minimal info when slug + token match and link is active', async () => {
    const { slug } = await insertConnector({
      tenantId: seed.tenantId,
      name: 'Acme Vendor Drop',
      publicLinkToken: 'pi-correct-token',
      publicLinkExpiresAt: null,
    });
    const resp = await publicConnectorGet(makeContext(slug, 'pi-correct-token'));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      connector: { name: string; slug: string };
      tenant: { name: string | null };
      accepted_extensions: string[];
      max_size_bytes: { text: number; binary: number };
      expires_at: number | null;
    };
    expect(body.connector.name).toBe('Acme Vendor Drop');
    expect(body.connector.slug).toBe(slug);
    expect(body.tenant.name).toBe('Test Corp');
    expect(body.accepted_extensions).toContain('.csv');
    expect(body.accepted_extensions).toContain('.pdf');
    expect(body.max_size_bytes.text).toBeGreaterThan(0);
    expect(body.max_size_bytes.binary).toBeGreaterThan(0);
    expect(body.expires_at).toBeNull();
  });

  it('does NOT leak field_mappings or any other connector internals', async () => {
    const { slug } = await insertConnector({
      tenantId: seed.tenantId,
      publicLinkToken: 'pi-no-leak',
    });
    const resp = await publicConnectorGet(makeContext(slug, 'pi-no-leak'));
    expect(resp.status).toBe(200);
    const text = await resp.text();
    expect(text).not.toContain('field_mappings');
    expect(text).not.toContain('order_number');
    expect(text).not.toContain('source_labels');
    expect(text).not.toContain('api_token');
    expect(text).not.toContain('credentials');
    expect(text).not.toContain('r2_bucket_name');
    expect(text).not.toContain('public_link_token');
  });
});

describe('GET /api/public/connectors/:slug — failure modes (all 404)', () => {
  it('returns 404 when the token query param is missing', async () => {
    const { slug } = await insertConnector({
      tenantId: seed.tenantId,
      publicLinkToken: 'pi-needs-token',
    });
    const resp = await publicConnectorGet(makeContext(slug, null));
    expect(resp.status).toBe(404);
  });

  it('returns 404 when the slug does not exist', async () => {
    const resp = await publicConnectorGet(
      makeContext('nonexistent-slug-xyz', 'whatever'),
    );
    expect(resp.status).toBe(404);
  });

  it('returns 404 when the token is wrong', async () => {
    const { slug } = await insertConnector({
      tenantId: seed.tenantId,
      publicLinkToken: 'pi-correct',
    });
    const resp = await publicConnectorGet(makeContext(slug, 'pi-wrong'));
    expect(resp.status).toBe(404);
  });

  it('returns 404 when the link has been revoked (token NULL)', async () => {
    const { slug } = await insertConnector({
      tenantId: seed.tenantId,
      publicLinkToken: null,
    });
    // Vendor still has the old token in their bookmark.
    const resp = await publicConnectorGet(makeContext(slug, 'old-token'));
    expect(resp.status).toBe(404);
  });

  it('returns 404 when the link has expired', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const { slug } = await insertConnector({
      tenantId: seed.tenantId,
      publicLinkToken: 'pi-expired',
      publicLinkExpiresAt: past,
    });
    const resp = await publicConnectorGet(makeContext(slug, 'pi-expired'));
    expect(resp.status).toBe(404);
  });

  it('returns 404 when the connector is inactive', async () => {
    const { slug } = await insertConnector({
      tenantId: seed.tenantId,
      publicLinkToken: 'pi-inactive',
      active: 0,
    });
    const resp = await publicConnectorGet(makeContext(slug, 'pi-inactive'));
    expect(resp.status).toBe(404);
  });

  it('returns 404 when the connector is soft-deleted', async () => {
    const { slug } = await insertConnector({
      tenantId: seed.tenantId,
      publicLinkToken: 'pi-deleted',
      deletedAt: new Date().toISOString(),
    });
    const resp = await publicConnectorGet(makeContext(slug, 'pi-deleted'));
    expect(resp.status).toBe(404);
  });

  it('uses the same generic error message regardless of failure cause', async () => {
    // Spot-check three different failure modes return identical bodies.
    const a = await publicConnectorGet(makeContext('no-such-slug', 'whatever'));
    const { slug } = await insertConnector({
      tenantId: seed.tenantId,
      publicLinkToken: 'msg-token',
    });
    const b = await publicConnectorGet(makeContext(slug, 'wrong-token'));
    const { slug: slug2 } = await insertConnector({
      tenantId: seed.tenantId,
      publicLinkToken: 'msg-revoked',
      publicLinkExpiresAt: Math.floor(Date.now() / 1000) - 60,
    });
    const c = await publicConnectorGet(makeContext(slug2, 'msg-revoked'));
    const [aBody, bBody, cBody] = await Promise.all([a.text(), b.text(), c.text()]);
    expect(aBody).toBe(bBody);
    expect(bBody).toBe(cBody);
  });
});
