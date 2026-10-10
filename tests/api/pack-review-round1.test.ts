/**
 * Review round 1 of the pack ledger and roll-forward: every finding, as the
 * test that failed before its fix.
 *
 *   M1  a DOWNGRADE was planned and applied as if it were an update
 *   M2  apply ledgered (and re-seeded) an organisation that was never baselined
 *   m1  a pack rename could land on a name another row already has
 *   m2  a caller-supplied slug walked around the duplicate-concept check
 *   m3  a supplier's own document type at a pack slug was adopted as the pack's
 *   m4  a pack row deleted and re-made by hand was treated as pack-written
 *   m5  an apply ran a plan nobody had previewed, and could stamp twice
 *   m6  an API key could run the apply
 *   nit an `accept` entry naming nothing was a silent 200
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId, splitStatements } from '../helpers/db';
import { applyStarterPack } from '../../functions/lib/starter-packs';
import { STARTER_PACKS, type StarterPack } from '../../functions/lib/starterPacks.generated';
import { runPackRollForward, currentPackVersion } from '../../functions/lib/pack-roll-forward';
import { onRequestPost as rollForwardRoute } from '../../functions/api/starter-packs/roll-forward';
import { onRequestPost as applyRoute } from '../../functions/api/starter-packs/apply';
import { onRequestPost as createRequirement } from '../../functions/api/requirements/index';
import { onRequestPost as createClaim } from '../../functions/api/claim-types/index';
import { packToStatements } from '../../bin/lib/starter-packs.mjs';
import fsqaRaw from '../../starter-packs/fsqa.json?raw';
import type { PackRollForwardResponse } from '../../shared/types';

const db = env.DB;
const v1: StarterPack = STARTER_PACKS.fsqa;

let seed: Awaited<ReturnType<typeof seedTestData>>;
let tenantId: string;
let tenantSlug: string;

const superAdmin = () => ({ id: seed.superAdminId, role: 'super_admin', tenant_id: null });

async function freshTenant(): Promise<void> {
  tenantId = generateTestId();
  tenantSlug = `r1-${tenantId.slice(0, 8)}`;
  await db
    .prepare('INSERT INTO tenants (id, name, slug, active) VALUES (?, ?, ?, 1)')
    .bind(tenantId, `Round one ${tenantId}`, tenantSlug)
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

async function count(table: string, where = ''): Promise<number> {
  const r = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ? ${where}`)
    .bind(tenantId)
    .first<{ n: number }>();
  return Number(r?.n ?? 0);
}

async function audits(action: string): Promise<number> {
  return count('audit_log', `AND action = '${action}'`);
}

/** Preview, then apply what was previewed -- the only way an apply is allowed. */
async function roll(pack: StarterPack, accept: Array<{ kind: string; key: string; field?: string }> = []) {
  const base = { tenantId, tenantSlug, pack, actorId: seed.superAdminId, ip: null };
  const preview = (await runPackRollForward(db, { ...base, dryRun: true, accept: [] })) as PackRollForwardResponse & {
    plan_fingerprint?: string;
  };
  return runPackRollForward(db, {
    ...base,
    dryRun: false,
    accept,
    fingerprint: preview.plan_fingerprint,
  } as never);
}

async function callRoll(body: Record<string, unknown>, data: Record<string, unknown> = {}) {
  const res = await rollForwardRoute({
    request: new Request('http://localhost/api/starter-packs/roll-forward', { method: 'POST', body: JSON.stringify(body) }),
    env,
    data: { user: superAdmin(), authMethod: 'jwt', ...data },
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

beforeAll(async () => {
  seed = await seedTestData(db);
});

beforeEach(freshTenant);

describe('M1: a pack version never goes backwards', () => {
  it('refuses to roll an organisation on a NEWER version to this one, dry run included', async () => {
    const v2 = next(v1, (p) => {
      p.requirements.find((r) => r.slug === 'pack-size')!.description = 'v2 wording';
    });
    await applyStarterPack(db, v2, tenantId, tenantSlug, seed.superAdminId);
    expect(await currentPackVersion(db, tenantId, 'fsqa')).toBe(2);
    const before = await snapshot();

    // The route ships version 1; the organisation is on 2.
    for (const dry_run of [true, false]) {
      const { status, body } = await callRoll({ tenant_id: tenantId, dry_run });
      expect(status).toBe(409);
      expect(body.code).toBe('pack_version_behind');
      expect(body.error).toMatch(/version 2/);
    }
    // And the library refuses for any caller, not only the route.
    for (const dryRun of [true, false]) {
      await expect(
        runPackRollForward(db, { tenantId, tenantSlug, pack: v1, dryRun, accept: [], actorId: seed.superAdminId, ip: null }),
      ).rejects.toThrow(/version 2/);
    }
    expect(await snapshot()).toBe(before);
    expect(await audits('starter_pack.roll_forward')).toBe(0);
  });

  it('a same-version run on an untouched organisation writes nothing, however often', async () => {
    await applyStarterPack(db, v1, tenantId, tenantSlug, seed.superAdminId);
    const before = await snapshot();
    for (let i = 0; i < 3; i++) {
      const res = await roll(v1);
      expect(res.up_to_date).toBe(true);
      expect(res.summary.writes).toBe(0);
    }
    expect(await snapshot()).toBe(before);
    expect(await count('tenant_packs')).toBe(1);
    expect(await audits('starter_pack.roll_forward')).toBe(0);
  });
});

describe('M2: apply does not ledger an organisation that was never baselined', () => {
  /** Seeded before migration 0141: the pack's rows, no ledger; three links removed on purpose. */
  async function preLedgerTenant(): Promise<void> {
    await applyStarterPack(db, v1, tenantId, tenantSlug, seed.superAdminId);
    await db.prepare('DELETE FROM pack_applied_items WHERE tenant_id = ?').bind(tenantId).run();
    await db.prepare('DELETE FROM tenant_packs WHERE tenant_id = ?').bind(tenantId).run();
    await db
      .prepare(
        `DELETE FROM document_type_requirements WHERE id IN (
           SELECT id FROM document_type_requirements WHERE tenant_id = ? ORDER BY id LIMIT 3)`,
      )
      .bind(tenantId)
      .run();
  }

  it('the route refuses, names the baseline, and writes nothing', async () => {
    await preLedgerTenant();
    const before = await snapshot();
    const { status, body } = await callApply({ tenant_id: tenantId, pack: 'fsqa' });
    expect(status).toBe(409);
    expect(body.code).toBe('baseline_required');
    expect(body.error).toMatch(/baseline-pack-ledger/);
    expect(await snapshot()).toBe(before);
  });

  it('the library refuses for any caller, and a newer build refuses too', async () => {
    await preLedgerTenant();
    const before = await snapshot();
    await expect(applyStarterPack(db, v1, tenantId, tenantSlug, seed.superAdminId)).rejects.toThrow(/baseline/);
    const v2 = next(v1, (p) => {
      p.requirements.find((r) => r.slug === 'pack-size')!.description = 'v2 wording';
    });
    await expect(applyStarterPack(db, v2, tenantId, tenantSlug, seed.superAdminId)).rejects.toThrow(/baseline/);
    expect(await snapshot()).toBe(before);
  });

  it('the CLI statements write nothing either: the guard is in the SQL', async () => {
    await preLedgerTenant();
    const before = await snapshot();
    const statements: string[] = packToStatements(JSON.parse(fsqaRaw), { tenantId, tenantSlug });
    for (const sql of statements) {
      for (const one of splitStatements(sql)) await db.prepare(one).run();
    }
    expect(await snapshot()).toBe(before);
  });

  it('a genuinely new organisation still applies, by the route and by the CLI statements', async () => {
    const { status, body } = await callApply({ tenant_id: tenantId, pack: 'fsqa' });
    expect(status).toBe(200);
    expect(body.inserted).toBeGreaterThan(100);
    expect(await currentPackVersion(db, tenantId, 'fsqa')).toBe(v1.version);

    await freshTenant();
    const statements: string[] = packToStatements(JSON.parse(fsqaRaw), { tenantId, tenantSlug });
    for (const sql of statements) {
      for (const one of splitStatements(sql)) await db.prepare(one).run();
    }
    expect(await count('requirements')).toBe(v1.requirements.length);
    expect(await count('pack_applied_items')).toBeGreaterThan(100);
    expect(await currentPackVersion(db, tenantId, 'fsqa')).toBe(v1.version);
  });

  it('an organisation with a few rows of its own is not mistaken for a seeded one', async () => {
    for (const [slug, name] of [['spec-sheet', 'Our spec sheet'], ['our-thing', 'Our thing']]) {
      await db
        .prepare('INSERT INTO requirements (id, tenant_id, slug, name) VALUES (?, ?, ?, ?)')
        .bind(generateTestId(), tenantId, slug, name)
        .run();
    }
    const res = await applyStarterPack(db, v1, tenantId, tenantSlug, seed.superAdminId);
    expect(res.counts.requirements).toBe(v1.requirements.length - 1);
  });
});

describe('m1: a pack rename does not land on a name another row has', () => {
  it('the rename is held for a person and the two rows keep their names', async () => {
    await applyStarterPack(db, v1, tenantId, tenantSlug, seed.superAdminId);
    const twinId = generateTestId();
    await db
      .prepare(`INSERT INTO requirements (id, tenant_id, slug, name) VALUES (?, ?, 'our-case-config', 'Case configuration')`)
      .bind(twinId, tenantId)
      .run();
    const v2 = next(v1, (p) => {
      p.requirements.find((r) => r.slug === 'pack-size')!.name = 'Case Configuration';
    });

    const res = await roll(v2);
    const item = res.items.find((i) => i.kind === 'requirement' && i.key === 'pack-size')!;
    expect(item.fields).toEqual([
      expect.objectContaining({ field: 'name', action: 'keep', reason: 'duplicate_name', target: 'Case Configuration' }),
    ]);
    expect(item.conflict).toMatchObject({ id: twinId, slug: 'our-case-config' });
    const names = await db
      .prepare(`SELECT name FROM requirements WHERE tenant_id = ? AND slug IN ('pack-size', 'our-case-config') ORDER BY slug`)
      .bind(tenantId)
      .all<{ name: string }>();
    expect(names.results.map((r) => r.name)).toEqual([
      'Case configuration',
      v1.requirements.find((r) => r.slug === 'pack-size')!.name,
    ]);

    // It is offered again next time (it is not filed as the organisation's own edit)...
    const again = await roll(v2);
    expect(again.items.find((i) => i.key === 'pack-size')!.fields[0]).toMatchObject({ action: 'keep', reason: 'duplicate_name' });
    // ...and ticking it is NOT the way two rows come to share a name (round 2,
    // C-186): it is reported as not applied, and the row keeps its name.
    const ticked = await roll(v2, [{ kind: 'requirement', key: 'pack-size', field: 'name' }]);
    expect(ticked.not_applied).toEqual([expect.objectContaining({ key: 'pack-size', reason: 'duplicate_name' })]);
    const still = await db
      .prepare(`SELECT name FROM requirements WHERE tenant_id = ? AND slug = 'pack-size'`)
      .bind(tenantId)
      .first<{ name: string }>();
    expect(still!.name).toBe(v1.requirements.find((r) => r.slug === 'pack-size')!.name);
  });
});

describe('m2: a caller-supplied slug is compared too', () => {
  beforeEach(async () => {
    await applyStarterPack(db, v1, tenantId, tenantSlug, seed.superAdminId);
  });
  const post = async (handler: (c: never) => Response | Promise<Response>, body: Record<string, unknown>) => {
    const res = await handler({
      request: new Request('http://localhost/api/x', { method: 'POST', body: JSON.stringify({ tenant_id: tenantId, ...body }) }),
      env,
      data: { user: superAdmin(), authMethod: 'jwt' },
      params: {},
    } as never);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  it('refuses a requirement whose SLUG is another concept, whatever it is called', async () => {
    for (const body of [
      { name: 'Zed thing', slug: 'specsheet' },
      { name: 'Whatever else', slug: 'Specification Sheet' },
      { name: 'Third', slug: 'allergen statement' },
    ]) {
      const res = await post(createRequirement as never, body);
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(res.body.code, JSON.stringify(body)).toBe('duplicate_concept');
    }
  });

  it('and a claim type likewise', async () => {
    const res = await post(createClaim as never, { name: 'Something new', slug: 'nongmo' });
    expect(res.status).toBe(409);
    expect(res.body.duplicate).toMatchObject({ slug: 'non-gmo' });
    // A slug of its own is fine.
    const ok = await post(createClaim as never, { name: 'Something new', slug: 'grass-fed' });
    expect(ok.status).toBe(201);
  });
});

describe("m3: a supplier's own document type at a pack slug is not the pack's", () => {
  it('apply does not adopt it, and a roll-forward reports it instead of writing to it', async () => {
    const supplierId = generateTestId();
    await db
      .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
      .bind(supplierId, tenantId, 'Acme Dairy', 'acme-dairy')
      .run();
    const scopedId = generateTestId();
    await db
      .prepare(
        `INSERT INTO document_types (id, tenant_id, name, slug, supplier_id, sharing_rule)
         VALUES (?, ?, 'Acme COA', 'certificate-of-analysis', ?, 'locked')`,
      )
      .bind(scopedId, tenantId, supplierId)
      .run();

    await applyStarterPack(db, v1, tenantId, tenantSlug, seed.superAdminId);
    // Nothing of the pack's hangs off the supplier's type, and it is not ledgered as the pack's.
    const links = await db
      .prepare('SELECT COUNT(*) AS n FROM document_type_requirements WHERE document_type_id = ?')
      .bind(scopedId)
      .first<{ n: number }>();
    expect(links!.n).toBe(0);
    const instr = await db
      .prepare('SELECT COUNT(*) AS n FROM document_type_extraction_instructions WHERE document_type_id = ?')
      .bind(scopedId)
      .first<{ n: number }>();
    expect(instr!.n).toBe(0);
    const entry = await db
      .prepare(`SELECT state FROM pack_applied_items WHERE tenant_id = ? AND kind = 'document_type' AND item_key = 'certificate-of-analysis'`)
      .bind(tenantId)
      .first();
    expect(entry).toBeNull();

    const v2 = next(v1, (p) => {
      const coa = p.document_types.find((d) => d.slug === 'certificate-of-analysis')!;
      coa.name = 'Certificate of Analysis (COA)';
      coa.description = 'v2 description';
    });
    const res = await roll(v2, [{ kind: 'document_type', key: 'certificate-of-analysis' }]);
    const item = res.items.find((i) => i.kind === 'document_type' && i.key === 'certificate-of-analysis')!;
    expect(item.outcome).toBe('conflict');
    expect(item.conflict).toMatchObject({ id: scopedId, supplier_scoped: true });
    const row = await db.prepare('SELECT name, description, sharing_rule FROM document_types WHERE id = ?').bind(scopedId).first();
    expect(row).toEqual({ name: 'Acme COA', description: null, sharing_rule: 'locked' });
  });
});

describe('m4: a pack row re-made by hand is not the pack row', () => {
  it('is adopted as a row of unknown origin, and what differs is kept', async () => {
    await applyStarterPack(db, v1, tenantId, tenantSlug, seed.superAdminId);
    await db.prepare(`DELETE FROM claim_type_requirements WHERE tenant_id = ?`).bind(tenantId).run();
    await db.prepare(`DELETE FROM claim_types WHERE tenant_id = ? AND slug = 'organic'`).bind(tenantId).run();
    const handMade = generateTestId();
    const original = v1.claim_types.find((c) => c.slug === 'organic')!;
    // Re-made under the same slug, holding EXACTLY what v1 wrote in one column
    // and its own words in another.
    await db
      .prepare(`INSERT INTO claim_types (id, tenant_id, slug, name, description, subject_grain, sort_order) VALUES (?, ?, 'organic', ?, 'ours', ?, ?)`)
      .bind(handMade, tenantId, original.name, original.subject_grain, original.sort_order)
      .run();
    const v2 = next(v1, (p) => {
      const c = p.claim_types.find((x) => x.slug === 'organic')!;
      c.name = 'Certified Organic';
      c.description = 'v2 description';
    });

    const res = await roll(v2);
    const item = res.items.find((i) => i.kind === 'claim_type' && i.key === 'organic')!;
    expect(item.outcome).toBe('adopt');
    // Even the column that happens to equal what v1 wrote: nobody knows the pack wrote THIS row.
    expect(item.fields.map((f) => [f.field, f.action, f.reason]).sort()).toEqual([
      ['description', 'keep', 'unknown'],
      ['name', 'keep', 'unknown'],
    ]);
    const row = await db.prepare('SELECT name, description FROM claim_types WHERE id = ?').bind(handMade).first();
    expect(row).toEqual({ name: original.name, description: 'ours' });
  });
});

describe('m5: an apply runs the plan that was previewed, once', () => {
  it('refuses an apply with no fingerprint, and one whose plan has moved', async () => {
    await applyStarterPack(db, v1, tenantId, tenantSlug, seed.superAdminId);
    const preview = await callRoll({ tenant_id: tenantId });
    expect(preview.status).toBe(200);
    expect(typeof preview.body.plan_fingerprint).toBe('string');

    const bare = await callRoll({ tenant_id: tenantId, dry_run: false });
    expect(bare.status).toBe(409);
    expect(bare.body.code).toBe('preview_required');

    // Somebody edits a row after the preview: the plan is not the one that was seen.
    await db.prepare(`UPDATE requirements SET description = 'changed since' WHERE tenant_id = ? AND slug = 'gtin'`).bind(tenantId).run();
    const stale = await callRoll({ tenant_id: tenantId, dry_run: false, fingerprint: preview.body.plan_fingerprint });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('plan_changed');

    const fresh = await callRoll({ tenant_id: tenantId });
    const ok = await callRoll({ tenant_id: tenantId, dry_run: false, fingerprint: fresh.body.plan_fingerprint });
    expect(ok.status).toBe(200);
  });

  it('the same fingerprint sent twice stamps the version once', async () => {
    await applyStarterPack(db, v1, tenantId, tenantSlug, seed.superAdminId);
    const v2 = next(v1, (p) => {
      p.requirements.find((r) => r.slug === 'pack-size')!.description = 'v2 wording';
    });
    const base = { tenantId, tenantSlug, pack: v2, actorId: seed.superAdminId, ip: null };
    const preview = (await runPackRollForward(db, { ...base, dryRun: true, accept: [] })) as any;
    await runPackRollForward(db, { ...base, dryRun: false, accept: [], fingerprint: preview.plan_fingerprint } as never);
    // The double click: the plan it previewed is gone, so it is refused...
    await expect(
      runPackRollForward(db, { ...base, dryRun: false, accept: [], fingerprint: preview.plan_fingerprint } as never),
    ).rejects.toThrow();
    expect(await count('tenant_packs', `AND version = 2`)).toBe(1);
    // ...and the table itself will not hold the same step twice.
    await db
      .prepare(`INSERT OR IGNORE INTO tenant_packs (id, tenant_id, pack, version, from_version, source) VALUES (?, ?, 'fsqa', 2, 1, 'roll_forward')`)
      .bind(generateTestId(), tenantId)
      .run();
    expect(await count('tenant_packs', `AND version = 2`)).toBe(1);
  });
});

describe('m6: an API key may preview, and only a signed-in admin may apply', () => {
  it('refuses a non-dry run made with a key, in words', async () => {
    await applyStarterPack(db, v1, tenantId, tenantSlug, seed.superAdminId);
    const preview = await callRoll({ tenant_id: tenantId }, { authMethod: 'api_key' });
    expect(preview.status).toBe(200);
    const apply = await callRoll(
      { tenant_id: tenantId, dry_run: false, fingerprint: preview.body.plan_fingerprint },
      { authMethod: 'api_key' },
    );
    expect(apply.status).toBe(403);
    expect(apply.body.code).toBe('signed_in_admin_required');
    expect(apply.body.error).toMatch(/API key/);
  });
});

describe('nit: accept names something, or it is refused', () => {
  it('400 naming the entries that match nothing', async () => {
    await applyStarterPack(db, v1, tenantId, tenantSlug, seed.superAdminId);
    const res = await callRoll({
      tenant_id: tenantId,
      accept: [
        { kind: 'requirement', key: 'gtin', field: 'description' },
        { kind: 'requirement', key: 'no-such-item' },
        { kind: 'requirement', key: 'gtin', field: 'no_such_column' },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no-such-item/);
    expect(res.body.error).toMatch(/no_such_column/);
    expect(res.body.error).not.toMatch(/gtin \(description\)/);
  });
});
