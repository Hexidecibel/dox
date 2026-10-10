/**
 * A pack applied over rows it did not write.
 *
 * Every pack row id used to be `packRowId(prefix, TENANT SLUG, slug)`, and
 * every junction row named its parents BY THAT ID. `INSERT OR IGNORE` swallows
 * a unique conflict and nothing else, so a tenant holding a pack slug under any
 * other id -- a row a person made by hand, an old seed, or simply a tenant whose
 * slug a super admin changed after seeding -- ignored the vocabulary insert and
 * then failed the whole batch on the junction's foreign key.
 *
 * The first test here was written BEFORE the fix and failed with
 * "FOREIGN KEY constraint failed"; it is the proof the hazard was real and not
 * only inferred from reading.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { applyStarterPack } from '../../functions/lib/starter-packs';
import { STARTER_PACKS } from '../../functions/lib/starterPacks.generated';
import { onRequestPost as applyPacket } from '../../functions/api/starter-packs/apply-packet';

const db = env.DB;
const pack = STARTER_PACKS.fsqa;

let seed: Awaited<ReturnType<typeof seedTestData>>;
let tenantId: string;
let tenantSlug: string;

async function freshTenant(): Promise<void> {
  tenantId = generateTestId();
  tenantSlug = `adopt-${tenantId.slice(0, 8)}`;
  await db
    .prepare('INSERT INTO tenants (id, name, slug, active) VALUES (?, ?, ?, 1)')
    .bind(tenantId, `Adoption ${tenantSlug}`, tenantSlug)
    .run();
}

async function count(table: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`)
    .bind(tenantId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

beforeAll(async () => {
  seed = await seedTestData(db);
});

beforeEach(async () => {
  await freshTenant();
});

describe('a pack applied over a row it did not write', () => {
  it('adopts a hand-made requirement holding a pack slug instead of failing the batch', async () => {
    // A requirement a person made, under a random id, whose slug the pack also
    // uses. `spec-sheet` is closed by a document type and opened by no claim in
    // fsqa, so at least one junction row names it.
    const handMadeId = generateTestId();
    await db
      .prepare(
        `INSERT INTO requirements (id, tenant_id, slug, name, description) VALUES (?, ?, 'spec-sheet', 'Our spec sheet', 'typed by a person')`,
      )
      .bind(handMadeId, tenantId)
      .run();

    await applyStarterPack(db, pack, tenantId, tenantSlug);

    // Adopted, not duplicated: one row for the slug, still the person's row.
    const rows = await db
      .prepare(`SELECT id, name, description FROM requirements WHERE tenant_id = ? AND slug = 'spec-sheet'`)
      .bind(tenantId)
      .all<{ id: string; name: string; description: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].id).toBe(handMadeId);
    expect(rows.results[0].name).toBe('Our spec sheet');

    // Every junction the pack says hangs off that slug points at THE ADOPTED ROW.
    const closers = pack.document_types.filter((dt) => dt.closes.includes('spec-sheet'));
    expect(closers.length).toBeGreaterThan(0);
    const links = await db
      .prepare(`SELECT document_type_id FROM document_type_requirements WHERE tenant_id = ? AND requirement_id = ?`)
      .bind(tenantId, handMadeId)
      .all();
    expect(links.results).toHaveLength(closers.length);

    // And the rest of the pack landed.
    expect(await count('requirements')).toBe(pack.requirements.length);
    expect(await count('document_types')).toBe(pack.document_types.length);
  });

  it('survives a changed tenant slug: a re-apply adds nothing and breaks nothing', async () => {
    await applyStarterPack(db, pack, tenantId, tenantSlug);
    const before = {
      requirements: await count('requirements'),
      document_types: await count('document_types'),
      claim_type_requirements: await count('claim_type_requirements'),
      document_type_requirements: await count('document_type_requirements'),
      spec_tests: await count('spec_tests'),
      spec_limits: await count('spec_limits'),
      dtei: await count('document_type_extraction_instructions'),
    };

    // A super admin renames the tenant's slug (PUT /api/tenants/:id allows it).
    const renamed = `${tenantSlug}-renamed`;
    await db.prepare('UPDATE tenants SET slug = ? WHERE id = ?').bind(renamed, tenantId).run();

    const again = await applyStarterPack(db, pack, tenantId, renamed);
    expect(again.inserted).toBe(0);
    expect({
      requirements: await count('requirements'),
      document_types: await count('document_types'),
      claim_type_requirements: await count('claim_type_requirements'),
      document_type_requirements: await count('document_type_requirements'),
      spec_tests: await count('spec_tests'),
      spec_limits: await count('spec_limits'),
      dtei: await count('document_type_extraction_instructions'),
    }).toEqual(before);
  });

  it('after a slug change the wizard packet still finds the requirements', async () => {
    await applyStarterPack(db, pack, tenantId, tenantSlug);
    const renamed = `${tenantSlug}-renamed`;
    await db.prepare('UPDATE tenants SET slug = ? WHERE id = ?').bind(renamed, tenantId).run();

    const packet = pack.requirement_packets.find((p) => p.default) ?? pack.requirement_packets[0];
    const res = await applyPacket({
      request: new Request('http://localhost/api/starter-packs/apply-packet', {
        method: 'POST',
        body: JSON.stringify({
          tenant_id: tenantId,
          pack: 'fsqa',
          packet: packet.slug,
          supplier_name: `Slug Change Dairy ${generateTestId()}`,
        }),
      }),
      env,
      data: { user: { id: seed.superAdminId, role: 'super_admin', tenant_id: null } },
      params: {},
    } as never);
    const body = (await res.json()) as {
      attached: { required: number; recommended: number };
      unknown_requirements: string[];
    };
    expect(res.status).toBe(200);
    expect(body.unknown_requirements).toEqual([]);
    expect(body.attached).toEqual({
      required: packet.requirements.length,
      recommended: packet.recommends.length,
    });
  });

  it('a second tenant taking a freed slug gets its own rows, not silence', async () => {
    // Tenant A is seeded as `acme`, renamed away; tenant B then takes `acme`.
    // B's deterministic ids are A's primary keys.
    await applyStarterPack(db, pack, tenantId, tenantSlug);
    const freed = tenantSlug;
    await db.prepare('UPDATE tenants SET slug = ? WHERE id = ?').bind(`${freed}-old`, tenantId).run();
    const firstTenant = tenantId;

    tenantId = generateTestId();
    await db
      .prepare('INSERT INTO tenants (id, name, slug, active) VALUES (?, ?, ?, 1)')
      .bind(tenantId, 'Second holder', freed)
      .run();
    await applyStarterPack(db, pack, tenantId, freed);

    expect(await count('requirements')).toBe(pack.requirements.length);
    expect(await count('document_types')).toBe(pack.document_types.length);
    expect(await count('document_type_requirements')).toBe(
      pack.document_types.reduce((n, d) => n + d.closes.length, 0),
    );
    // And nothing of B's points into A.
    const crossed = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM document_type_requirements dtr
           JOIN requirements r ON r.id = dtr.requirement_id
          WHERE dtr.tenant_id = ? AND r.tenant_id = ?`,
      )
      .bind(tenantId, firstTenant)
      .first<{ n: number }>();
    expect(crossed?.n).toBe(0);
  });
});
