/**
 * Review round 2 of the pack ledger and roll-forward: each finding as the test
 * that failed before its fix.
 *
 *   R1  the 50% bar let the MOST diverged legacy organisation through apply
 *   R2  a person's accept could rename a row onto a name another row holds
 *   R3  the apply refused an API key rather than requiring a signed-in admin
 *   nits  `field: ''`; a ticked supplier-scoped conflict; "up to date" while
 *         something still needs a person
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId, splitStatements } from '../helpers/db';
import { applyStarterPack } from '../../functions/lib/starter-packs';
import { STARTER_PACKS, type StarterPack } from '../../functions/lib/starterPacks.generated';
import { loadPackRows, runPackRollForward } from '../../functions/lib/pack-roll-forward';
import { onRequestPost as rollForwardRoute } from '../../functions/api/starter-packs/roll-forward';
import { onRequestPost as applyRoute } from '../../functions/api/starter-packs/apply';
import { packToStatements } from '../../bin/lib/starter-packs.mjs';
import { inferPack } from '../../bin/lib/packLedgerBaseline.js';
import fsqaRaw from '../../starter-packs/fsqa.json?raw';

const db = env.DB;
const v1: StarterPack = STARTER_PACKS.fsqa;

let seed: Awaited<ReturnType<typeof seedTestData>>;
let tenantId: string;
let tenantSlug: string;

const superAdmin = () => ({ id: seed.superAdminId, role: 'super_admin', tenant_id: null });

async function freshTenant(): Promise<void> {
  tenantId = generateTestId();
  tenantSlug = `r2-${tenantId.slice(0, 8)}`;
  await db
    .prepare('INSERT INTO tenants (id, name, slug, active) VALUES (?, ?, ?, 1)')
    .bind(tenantId, `Round two ${tenantId}`, tenantSlug)
    .run();
}

function next(pack: StarterPack, edit: (p: StarterPack) => void): StarterPack {
  const p: StarterPack = structuredClone(pack);
  p.version = pack.version + 1;
  edit(p);
  return p;
}

const TABLES = [
  'owner_labels',
  'document_types',
  'requirements',
  'claim_types',
  'claim_type_requirements',
  'document_type_requirements',
  'document_type_extraction_instructions',
  'spec_tests',
  'spec_limits',
  'tenant_modules',
  'pack_applied_items',
  'tenant_packs',
];

async function snapshot(): Promise<string> {
  const parts: string[] = [];
  for (const table of TABLES) {
    const res = await db.prepare(`SELECT * FROM ${table} WHERE tenant_id = ?`).bind(tenantId).all();
    parts.push(`${table}:${(res.results ?? []).map((r) => JSON.stringify(r)).sort().join('\n')}`);
  }
  return parts.join('\n\n');
}

async function callRoll(body: Record<string, unknown>, data: Record<string, unknown> = { authMethod: 'jwt' }) {
  const res = await rollForwardRoute({
    request: new Request('http://localhost/api/starter-packs/roll-forward', { method: 'POST', body: JSON.stringify(body) }),
    env,
    data: { user: superAdmin(), ...data },
    params: {},
    waitUntil: () => {},
  } as never);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function callApply(body: Record<string, unknown>) {
  const res = await applyRoute({
    request: new Request('http://localhost/api/starter-packs/apply', { method: 'POST', body: JSON.stringify(body) }),
    env,
    data: { user: superAdmin(), authMethod: 'jwt' },
    params: {},
  } as never);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function roll(pack: StarterPack, accept: Array<{ kind: string; key: string; field?: string }> = []) {
  const base = { tenantId, tenantSlug, pack, actorId: seed.superAdminId, ip: null };
  const preview = await runPackRollForward(db, { ...base, dryRun: true, accept: [] });
  return runPackRollForward(db, { ...base, dryRun: false, accept, fingerprint: preview.plan_fingerprint });
}

beforeAll(async () => {
  seed = await seedTestData(db);
});

beforeEach(freshTenant);

describe('R1: any evidence of an earlier seeding shuts apply, whatever the fraction', () => {
  /** Seeded before 0141, then stripped far below half: every requirement and claim type gone. */
  async function divergedLegacyTenant(): Promise<void> {
    await applyStarterPack(db, v1, tenantId, tenantSlug, seed.superAdminId);
    await db.prepare('DELETE FROM pack_applied_items WHERE tenant_id = ?').bind(tenantId).run();
    await db.prepare('DELETE FROM tenant_packs WHERE tenant_id = ?').bind(tenantId).run();
    await db.prepare('DELETE FROM claim_type_requirements WHERE tenant_id = ?').bind(tenantId).run();
    await db.prepare('DELETE FROM document_type_requirements WHERE tenant_id = ?').bind(tenantId).run();
    await db.prepare('DELETE FROM claim_types WHERE tenant_id = ?').bind(tenantId).run();
    await db.prepare('DELETE FROM requirements WHERE tenant_id = ?').bind(tenantId).run();
  }

  it('the rows a pack wrote carry its ids: the route, the library and the CLI statements all refuse', async () => {
    await divergedLegacyTenant();
    // Well under the 50% bar: this is the organisation the first guard let through.
    const held = v1.document_types.length;
    const total = v1.document_types.length + v1.requirements.length + v1.claim_types.length;
    expect(held * 2).toBeLessThan(total);
    const before = await snapshot();

    const { status, body } = await callApply({ tenant_id: tenantId, pack: 'fsqa' });
    expect(status).toBe(409);
    expect(body.code).toBe('baseline_required');
    await expect(applyStarterPack(db, v1, tenantId, tenantSlug, seed.superAdminId)).rejects.toMatchObject({
      code: 'baseline_required',
    });
    for (const sql of packToStatements(JSON.parse(fsqaRaw), { tenantId, tenantSlug }) as string[]) {
      for (const one of splitStatements(sql)) await db.prepare(one).run();
    }
    expect(await snapshot()).toBe(before);
  });

  it('a setup run that recorded an applied pack is evidence too, with every pack row gone', async () => {
    await db
      .prepare(
        `INSERT INTO tenant_setup_runs (id, tenant_id, status, pack, applied)
         VALUES (?, ?, 'completed', 'fsqa', ?)`,
      )
      .bind(generateTestId(), tenantId, JSON.stringify({ pack: { name: 'fsqa', applied_at: '2026-08-01T00:00:00Z' } }))
      .run();
    const before = await snapshot();
    const { status, body } = await callApply({ tenant_id: tenantId, pack: 'fsqa' });
    expect(status).toBe(409);
    expect(body.code).toBe('baseline_required');
    for (const sql of packToStatements(JSON.parse(fsqaRaw), { tenantId, tenantSlug }) as string[]) {
      for (const one of splitStatements(sql)) await db.prepare(one).run();
    }
    expect(await snapshot()).toBe(before);
  });

  it('the baseline recognises the same organisation as the pack\'s, by the same evidence', async () => {
    await divergedLegacyTenant();
    const answer = inferPack([STARTER_PACKS.finance, v1], await loadPackRows(db, tenantId));
    expect(answer.pack).toBe('fsqa');
    expect(answer.reason).toMatch(/ids this pack gives/);
  });

  it('a brand-new organisation applies; so does one with only hand-made rows at pack slugs', async () => {
    const fresh = await callApply({ tenant_id: tenantId, pack: 'fsqa' });
    expect(fresh.status).toBe(200);

    await freshTenant();
    // A setup run that chose a pack and has not applied it is not evidence.
    await db
      .prepare(`INSERT INTO tenant_setup_runs (id, tenant_id, status, pack, applied) VALUES (?, ?, 'draft', 'fsqa', '{}')`)
      .bind(generateTestId(), tenantId)
      .run();
    for (const slug of ['spec-sheet', 'gtin', 'pack-size']) {
      await db
        .prepare('INSERT INTO requirements (id, tenant_id, slug, name) VALUES (?, ?, ?, ?)')
        .bind(generateTestId(), tenantId, slug, `Ours: ${slug}`)
        .run();
    }
    const handMade = await callApply({ tenant_id: tenantId, pack: 'fsqa' });
    expect(handMade.status).toBe(200);
    expect(handMade.body.counts.requirements).toBe(v1.requirements.length - 3);
    // And such an organisation is not inferred to be on the pack by its ids.
    await freshTenant();
    await db
      .prepare('INSERT INTO requirements (id, tenant_id, slug, name) VALUES (?, ?, ?, ?)')
      .bind(generateTestId(), tenantId, 'spec-sheet', 'Ours')
      .run();
    expect(inferPack([STARTER_PACKS.finance, v1], await loadPackRows(db, tenantId)).pack).toBeNull();
  });
});

describe('R2: no rename lands on a taken name, however it was chosen', () => {
  const v2 = () =>
    next(v1, (p) => {
      p.requirements.find((r) => r.slug === 'pack-size')!.name = 'Case Configuration';
    });

  /** The organisation renamed the pack's row; somebody also made a row by hand with the pack's NEW name. */
  async function renamedWithTwin(): Promise<string> {
    await applyStarterPack(db, v1, tenantId, tenantSlug, seed.superAdminId);
    await db.prepare(`UPDATE requirements SET name = 'Pack sizes (ours)' WHERE tenant_id = ? AND slug = 'pack-size'`).bind(tenantId).run();
    const twinId = generateTestId();
    await db
      .prepare(`INSERT INTO requirements (id, tenant_id, slug, name) VALUES (?, ?, 'our-case-config', 'Case configuration')`)
      .bind(twinId, tenantId)
      .run();
    return twinId;
  }

  const names = async () =>
    (
      await db
        .prepare(`SELECT name FROM requirements WHERE tenant_id = ? AND slug IN ('pack-size', 'our-case-config') ORDER BY slug`)
        .bind(tenantId)
        .all<{ name: string }>()
    ).results.map((r) => r.name);

  it('the preview carries the conflict although the planner itself would only keep', async () => {
    const twinId = await renamedWithTwin();
    const preview = await runPackRollForward(db, {
      tenantId,
      tenantSlug,
      pack: v2(),
      dryRun: true,
      accept: [],
      actorId: seed.superAdminId,
      ip: null,
    });
    const shown = preview.items.find((i) => i.kind === 'requirement' && i.key === 'pack-size')!;
    expect(shown.fields[0]).toMatchObject({ field: 'name', action: 'keep', current: 'Pack sizes (ours)' });
    expect(shown.conflict).toMatchObject({ id: twinId });
    expect(preview.needs_attention).toBe(true);
  });

  for (const [label, accept] of [
    ['the column', [{ kind: 'requirement', key: 'pack-size', field: 'name' }]],
    ['the whole item', [{ kind: 'requirement', key: 'pack-size' }]],
  ] as const) {
    it(`a person ticking ${label} does not rename it: not applied, and said`, async () => {
      await renamedWithTwin();
      const res = await roll(v2(), [...accept]);
      expect(res.not_applied).toEqual([
        expect.objectContaining({ kind: 'requirement', key: 'pack-size', reason: 'duplicate_name' }),
      ]);
      expect(await names()).toEqual(['Case configuration', 'Pack sizes (ours)']);
      // Asked again later, by the column: still not, and still said.
      const later = await roll(v2(), [{ kind: 'requirement', key: 'pack-size', field: 'name' }]);
      expect(later.not_applied).toEqual([expect.objectContaining({ key: 'pack-size', reason: 'duplicate_name' })]);
      expect(await names()).toEqual(['Case configuration', 'Pack sizes (ours)']);
    });
  }
});

describe('R3: only a signed-in administrator applies', () => {
  it('an apply with no auth method on record is refused, like one made with a key', async () => {
    await applyStarterPack(db, v1, tenantId, tenantSlug, seed.superAdminId);
    const preview = await callRoll({ tenant_id: tenantId });
    for (const data of [{}, { authMethod: undefined }, { authMethod: 'api_key' }, { authMethod: 'something_new' }]) {
      const res = await callRoll({ tenant_id: tenantId, dry_run: false, fingerprint: preview.body.plan_fingerprint }, data);
      expect(res.status, JSON.stringify(data)).toBe(403);
      expect(res.body.code).toBe('signed_in_admin_required');
    }
    // A dry run does not need one.
    expect((await callRoll({ tenant_id: tenantId }, {})).status).toBe(200);
    const ok = await callRoll({ tenant_id: tenantId, dry_run: false, fingerprint: preview.body.plan_fingerprint }, { authMethod: 'jwt' });
    expect(ok.status).toBe(200);
  });
});

describe('nits', () => {
  it("accept with field: '' is a 400, not a whole-item accept in disguise", async () => {
    await applyStarterPack(db, v1, tenantId, tenantSlug, seed.superAdminId);
    const res = await callRoll({ tenant_id: tenantId, accept: [{ kind: 'requirement', key: 'gtin', field: '' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/field/);
  });

  it('a ticked supplier-scoped conflict is listed as not applied, with the reason', async () => {
    const supplierId = generateTestId();
    await db
      .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
      .bind(supplierId, tenantId, 'Acme Dairy', 'acme-dairy')
      .run();
    await db
      .prepare(
        `INSERT INTO document_types (id, tenant_id, name, slug, supplier_id) VALUES (?, ?, 'Acme COA', 'certificate-of-analysis', ?)`,
      )
      .bind(generateTestId(), tenantId, supplierId)
      .run();
    await applyStarterPack(db, v1, tenantId, tenantSlug, seed.superAdminId);
    const res = await roll(v1, [{ kind: 'document_type', key: 'certificate-of-analysis' }]);
    expect(res.not_applied).toEqual([
      expect.objectContaining({ kind: 'document_type', key: 'certificate-of-analysis', reason: 'supplier_scoped' }),
    ]);
  });

  it('something a person must settle is flagged even when nothing would be written', async () => {
    await applyStarterPack(db, v1, tenantId, tenantSlug, seed.superAdminId);
    const clean = await callRoll({ tenant_id: tenantId });
    expect(clean.body.up_to_date).toBe(true);
    expect(clean.body.needs_attention).toBe(false);

    const v2 = next(v1, (p) => {
      p.requirements.push({
        name: 'Lot Coding Explanation on file',
        slug: 'lot-code-key',
        aliases: ['Lot Code Key'],
        description: null,
        checklist: 'Product Specification',
        sort_order: 9020,
        scope: 'supplier',
      });
    });
    await db
      .prepare(`INSERT INTO requirements (id, tenant_id, slug, name) VALUES (?, ?, 'our-lot-code-key', 'Lot Code Key')`)
      .bind(generateTestId(), tenantId)
      .run();
    await roll(v2);
    const again = await roll(v2);
    // Nothing left to write -- and still not "all done": the conflict is open.
    expect(again.up_to_date).toBe(true);
    expect(again.summary.writes).toBe(0);
    expect(again.needs_attention).toBe(true);
  });
});
