/**
 * POST /api/starter-packs/apply-packet — the setup wizard's closing action.
 *
 * The property under test is not "it writes rows". It is the SHAPE of what it
 * can be asked to do: one packet, one named supplier, provenance on every row,
 * and no request body that can mean "all of them". The live tenant's checklist
 * is uniform-and-wrong because six items were bulk-written across 21 suppliers
 * in a single pass, and the defence against a repeat is that the endpoint
 * cannot express it — not that the UI currently declines to.
 *
 * Also pinned: a re-run reports zeros rather than re-stamping rows (a packet is
 * a starting point, and an edit made afterwards must survive re-application),
 * and a packet naming a checklist item this tenant never seeded is REPORTED
 * rather than skipped in silence.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPost as applyPacket } from '../../functions/api/starter-packs/apply-packet';
import { onRequestGet as listSupplierRequirements } from '../../functions/api/supplier-requirements/index';

const db = env.DB;

// Every row a pack writes carries a deterministic id, `packRowId(prefix,
// tenantSlug, slug)`. The packet resolves its requirement slugs the same way,
// so the fixtures below have to be written with the real ids rather than random
// ones — which is itself the coupling worth testing.
const TENANT_SLUG = 'test-corp';
const reqId = (slug: string) => `req_${TENANT_SLUG}_${slug}`;

/** Every slug the fsqa `baseline` packet names, in its two tiers. */
const BASELINE_REQUIRED = [
  'letter-of-guarantee',
  'certificate-of-insurance',
  'w9-on-file',
  'third-party-audit-certificate',
];
const BASELINE_RECOMMENDED = ['third-party-audit-report', 'recall-program'];

let seed: Awaited<ReturnType<typeof seedTestData>>;
let admin: { id: string; role: 'org_admin'; tenant_id: string };
let reader: { id: string; role: 'reader'; tenant_id: string };

async function post(body: unknown, as = admin) {
  const res = await applyPacket({
    request: new Request('http://localhost/api/starter-packs/apply-packet', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    env,
    data: { user: as },
    params: {},
  } as never);
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

beforeAll(async () => {
  seed = await seedTestData(db);
  admin = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
  reader = { id: seed.readerId, role: 'reader', tenant_id: seed.tenantId };
});

beforeEach(async () => {
  await db.prepare('DELETE FROM supplier_requirements WHERE tenant_id = ?').bind(seed.tenantId).run();
  await db.prepare('DELETE FROM suppliers WHERE tenant_id = ?').bind(seed.tenantId).run();
  await db.prepare('DELETE FROM requirements WHERE tenant_id = ?').bind(seed.tenantId).run();
  for (const slug of [...BASELINE_REQUIRED, ...BASELINE_RECOMMENDED]) {
    await db
      .prepare('INSERT OR IGNORE INTO requirements (id, tenant_id, slug, name) VALUES (?, ?, ?, ?)')
      .bind(reqId(slug), seed.tenantId, slug, slug.replace(/-/g, ' '))
      .run();
  }
});

describe('POST /api/starter-packs/apply-packet', () => {
  it('attaches one packet to one named supplier, creating it', async () => {
    const name = `Darigold ${generateTestId()}`;
    const { status, body } = await post({ pack: 'fsqa', packet: 'baseline', supplier_name: name });

    expect(status).toBe(200);
    expect(body.supplier_created).toBe(true);
    expect(body.attached).toEqual({
      required: BASELINE_REQUIRED.length,
      recommended: BASELINE_RECOMMENDED.length,
    });
    expect(body.unknown_requirements).toEqual([]);

    const rows = await db
      .prepare(
        'SELECT tier, source, packet_slug FROM supplier_requirements WHERE tenant_id = ? AND supplier_id = ?',
      )
      .bind(seed.tenantId, body.supplier_id)
      .all<{ tier: string; source: string; packet_slug: string }>();

    expect(rows.results).toHaveLength(BASELINE_REQUIRED.length + BASELINE_RECOMMENDED.length);
    // Provenance on EVERY row: a wrong default has to be findable later, which
    // is the whole reason migration 0102 exists.
    expect(rows.results.every((r) => r.source === 'packet')).toBe(true);
    expect(rows.results.every((r) => r.packet_slug === 'baseline')).toBe(true);
    expect(rows.results.filter((r) => r.tier === 'required')).toHaveLength(BASELINE_REQUIRED.length);
  });

  it('attaches to an EXISTING supplier rather than forking a duplicate', async () => {
    const name = `Country Morning Farms ${generateTestId()}`;
    const first = await post({ pack: 'fsqa', packet: 'baseline', supplier_name: name });
    // Same company, a spelling a human would type. The shared lookup-or-create
    // resolver is what stops this becoming a second supplier owning half a
    // checklist — the exact defect the supplier merge tool was built for.
    const second = await post({
      pack: 'fsqa',
      packet: 'baseline',
      supplier_name: `${name}, Inc.`,
    });

    expect(second.body.supplier_id).toBe(first.body.supplier_id);
    expect(second.body.supplier_created).toBe(false);
  });

  it('re-applying reports zeros and overwrites nothing', async () => {
    const name = `Repeat Co ${generateTestId()}`;
    const first = await post({ pack: 'fsqa', packet: 'baseline', supplier_name: name });

    // A human downgrades one line item. Re-applying the packet must not undo it.
    await db
      .prepare(
        `UPDATE supplier_requirements SET tier = 'recommended', source = 'human'
          WHERE tenant_id = ? AND supplier_id = ? AND requirement_id = ?`,
      )
      .bind(seed.tenantId, first.body.supplier_id, reqId('w9-on-file'))
      .run();

    const again = await post({
      pack: 'fsqa',
      packet: 'baseline',
      supplier_id: first.body.supplier_id,
    });
    expect(again.body.attached).toEqual({ required: 0, recommended: 0 });

    const row = await db
      .prepare(
        'SELECT tier, source FROM supplier_requirements WHERE supplier_id = ? AND requirement_id = ?',
      )
      .bind(first.body.supplier_id, reqId('w9-on-file'))
      .first<{ tier: string; source: string }>();
    expect(row?.tier).toBe('recommended');
    expect(row?.source).toBe('human');
  });

  it('reports a packet item this tenant never seeded instead of dropping it', async () => {
    await db
      .prepare('DELETE FROM requirements WHERE id = ?')
      .bind(reqId('w9-on-file'))
      .run();

    const { body } = await post({
      pack: 'fsqa',
      packet: 'baseline',
      supplier_name: `Gap Co ${generateTestId()}`,
    });

    expect(body.unknown_requirements).toEqual(['w9-on-file']);
    // The rest still landed. A divergence between pack and tenant narrows the
    // checklist; it does not abort the action.
    expect(body.attached).toEqual({
      required: BASELINE_REQUIRED.length - 1,
      recommended: BASELINE_RECOMMENDED.length,
    });
  });

  it('refuses a request that names no supplier, and one that names two', async () => {
    const neither = await post({ pack: 'fsqa', packet: 'baseline' });
    expect(neither.status).toBe(400);

    const both = await post({
      pack: 'fsqa',
      packet: 'baseline',
      supplier_id: 'sup-x',
      supplier_name: 'Also This',
    });
    expect(both.status).toBe(400);
  });

  it('refuses an unknown pack or packet, and a non-admin', async () => {
    expect((await post({ pack: 'nope', packet: 'baseline', supplier_name: 'A Co' })).status).toBe(404);
    expect((await post({ pack: 'fsqa', packet: 'nope', supplier_name: 'A Co' })).status).toBe(404);
    expect(
      (await post({ pack: 'fsqa', packet: 'baseline', supplier_name: 'A Co' }, reader)).status,
    ).toBe(403);
  });

  it('leaves every other supplier alone — there is no bulk path', async () => {
    const target = await post({
      pack: 'fsqa',
      packet: 'baseline',
      supplier_name: `Chosen ${generateTestId()}`,
    });
    // A second supplier that exists but was never named.
    const bystanderId = `sup-${generateTestId()}`;
    await db
      .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
      .bind(bystanderId, seed.tenantId, 'Bystander', `bystander-${generateTestId()}`)
      .run();

    await post({ pack: 'fsqa', packet: 'ingredient-supplier', supplier_id: target.body.supplier_id });

    const res = await listSupplierRequirements({
      request: new Request(
        `http://localhost/api/supplier-requirements?supplier_id=${bystanderId}`,
      ),
      env,
      data: { user: admin },
      params: {},
    } as never);
    const listed = (await res.json()) as { total: number };
    expect(listed.total).toBe(0);
  });
});
