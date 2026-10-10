/**
 * Baselining an organisation that was seeded before the pack ledger existed
 * (bin/baseline-pack-ledger, bin/lib/packLedgerBaseline.js).
 *
 * Such an organisation has the pack's rows and no record of them. The baseline
 * cannot recover what the pack wrote; it can only bound it by comparing each
 * row with today's pack, and the rule it must hold is one sentence: NOTHING IS
 * OVERWRITTEN OR ADDED ON A GUESS. A row that differs might be a person's
 * edit; a row that is absent might be a deliberate removal. Both are kept as
 * they are and offered to a person on the next roll-forward.
 *
 * The statements the CLI would run are executed here against the test
 * database, so what is asserted is what `--apply` writes.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { applyStarterPack } from '../../functions/lib/starter-packs';
import { STARTER_PACKS, type StarterPack } from '../../functions/lib/starterPacks.generated';
import { loadPackLedger, loadPackRows, runPackRollForward, currentPackVersion } from '../../functions/lib/pack-roll-forward';
import { onRequestPost as rollForwardRoute } from '../../functions/api/starter-packs/roll-forward';
import { planBaseline, inferPack, baselineToSql } from '../../bin/lib/packLedgerBaseline.js';
import { splitStatements } from '../helpers/db';

const db = env.DB;
const fsqa: StarterPack = STARTER_PACKS.fsqa;
const finance: StarterPack = STARTER_PACKS.finance;

let seed: Awaited<ReturnType<typeof seedTestData>>;
let tenantId: string;
let tenantSlug: string;

/** An organisation as it was before migration 0141: the pack's rows, no ledger. */
async function seededBeforeTheLedger(pack: StarterPack): Promise<void> {
  tenantId = generateTestId();
  tenantSlug = `base-${tenantId.slice(0, 8)}`;
  await db
    .prepare('INSERT INTO tenants (id, name, slug, active) VALUES (?, ?, ?, 1)')
    .bind(tenantId, `Baseline ${tenantId}`, tenantSlug)
    .run();
  await applyStarterPack(db, pack, tenantId, tenantSlug);
  await db.prepare('DELETE FROM pack_applied_items WHERE tenant_id = ?').bind(tenantId).run();
  await db.prepare('DELETE FROM tenant_packs WHERE tenant_id = ?').bind(tenantId).run();
}

async function baseline(pack: StarterPack) {
  const rows = await loadPackRows(db, tenantId);
  const existing = await loadPackLedger(db, tenantId, pack.pack);
  const plan = planBaseline(pack, rows, existing);
  for (const sql of baselineToSql(plan, tenantId)) {
    for (const statement of splitStatements(sql)) await db.prepare(statement).run();
  }
  return plan;
}

async function ledgerOf(kind: string, key: string) {
  return db
    .prepare(`SELECT * FROM pack_applied_items WHERE tenant_id = ? AND kind = ? AND item_key = ?`)
    .bind(tenantId, kind, key)
    .first<{ row_id: string | null; pack_version: number; differing: string; state: string; source: string }>();
}

beforeAll(async () => {
  seed = await seedTestData(db);
});

describe('which pack is it on', () => {
  beforeEach(() => seededBeforeTheLedger(fsqa));

  it('infers the pack from the rows, and says how sure it is', async () => {
    const rows = await loadPackRows(db, tenantId);
    const answer = inferPack([finance, fsqa], rows);
    expect(answer.pack).toBe('fsqa');
    expect(answer.reason).toMatch(/holds \d+ of \d+/);
    expect(answer.scores.find((s: { pack: string }) => s.pack === 'fsqa').share).toBe(1);
    // W-9 is a document type in both packs, so finance scores above zero and
    // far below the bar -- which is exactly why the scores are printed.
    expect(answer.scores.find((s: { pack: string }) => s.pack === 'finance').share).toBeLessThan(0.5);
  });

  it('refuses to guess for an organisation that holds little of any pack, all of it hand-made', async () => {
    // Its own rows at a few pack slugs, under random ids: not a seeded organisation.
    const own = generateTestId();
    await db.prepare('INSERT INTO tenants (id, name, slug, active) VALUES (?, ?, ?, 1)').bind(own, `Own rows ${own}`, `own-${own.slice(0, 8)}`).run();
    for (const slug of ['organic', 'kosher', 'halal']) {
      await db.prepare('INSERT INTO claim_types (id, tenant_id, slug, name) VALUES (?, ?, ?, ?)').bind(generateTestId(), own, slug, slug).run();
    }
    const answer = inferPack([finance, fsqa], await loadPackRows(db, own));
    expect(answer.pack).toBeNull();
    expect(answer.reason).toMatch(/under the 50% needed/);
  });

  it('a seeded organisation that has diverged a long way is still recognised, by the ids a pack gives its rows', async () => {
    // Round 2 (C-185): the apply gate refuses this organisation, so the
    // baseline -- its only way in -- must be able to name its pack.
    await db.prepare('DELETE FROM document_type_requirements WHERE tenant_id = ?').bind(tenantId).run();
    await db.prepare('DELETE FROM document_type_extraction_instructions WHERE tenant_id = ?').bind(tenantId).run();
    await db.prepare('DELETE FROM claim_type_requirements WHERE tenant_id = ?').bind(tenantId).run();
    await db.prepare('DELETE FROM document_types WHERE tenant_id = ?').bind(tenantId).run();
    await db.prepare('DELETE FROM requirements WHERE tenant_id = ?').bind(tenantId).run();
    const answer = inferPack([finance, fsqa], await loadPackRows(db, tenantId));
    expect(answer.pack).toBe('fsqa');
    expect(answer.reason).toMatch(/carry the ids this pack gives/);
  });

  it('an organisation with nothing matches nothing', () => {
    expect(inferPack([finance, fsqa], {}).pack).toBeNull();
  });
});

describe('what a baseline records', () => {
  beforeEach(async () => {
    await seededBeforeTheLedger(fsqa);
    // The organisation's own history, all of it invisible to a ledger that did not exist:
    await db.prepare(`UPDATE requirements SET description = 'ours' WHERE tenant_id = ? AND slug = 'gtin'`).bind(tenantId).run();
    await db.prepare(`UPDATE requirements SET active = 0 WHERE tenant_id = ? AND slug = 'shelf-life'`).bind(tenantId).run();
    await db.prepare(`DELETE FROM claim_type_requirements WHERE tenant_id = ?`).bind(tenantId).run();
    await db.prepare(`DELETE FROM claim_types WHERE tenant_id = ? AND slug = 'made-in-usa'`).bind(tenantId).run();
    await db
      .prepare(`INSERT INTO requirements (id, tenant_id, slug, name) VALUES (?, ?, 'our-own-thing', 'Our own thing')`)
      .bind(generateTestId(), tenantId)
      .run();
  });

  it('pack / differs / inactive / absent, and nothing of the organisation\'s is touched', async () => {
    const before = await db.prepare('SELECT * FROM requirements WHERE tenant_id = ? ORDER BY id').bind(tenantId).all();
    const plan = await baseline(fsqa);
    const after = await db.prepare('SELECT * FROM requirements WHERE tenant_id = ? ORDER BY id').bind(tenantId).all();
    expect(after.results).toEqual(before.results);

    expect(await currentPackVersion(db, tenantId, 'fsqa')).toBe(fsqa.version);

    expect(await ledgerOf('requirement', 'pack-size')).toMatchObject({ state: 'pack', differing: '{}', source: 'baseline' });
    const gtin = (await ledgerOf('requirement', 'gtin'))!;
    expect(gtin.state).toBe('differs');
    expect(JSON.parse(gtin.differing)).toEqual({ description: 'unknown' });
    expect(await ledgerOf('requirement', 'shelf-life')).toMatchObject({ state: 'inactive' });
    expect(await ledgerOf('claim_type', 'made-in-usa')).toMatchObject({ state: 'absent', row_id: null });
    // The organisation's own row is not a pack item: counted, never ledgered.
    expect(await ledgerOf('requirement', 'our-own-thing')).toBeNull();
    expect(plan.counts.requirement.extra).toBe(1);
    expect(plan.counts.requirement.differs).toBe(1);
    expect(plan.counts.requirement.inactive).toBe(1);
    expect(plan.counts.claim_type.absent).toBe(1);
    expect(plan.counts.claim_rule.absent).toBe(plan.counts.claim_rule.total);

    const audit = await db
      .prepare(`SELECT details FROM audit_log WHERE tenant_id = ? AND action = 'starter_pack.baseline'`)
      .bind(tenantId)
      .first<{ details: string }>();
    expect(JSON.parse(audit!.details)).toMatchObject({ pack: 'fsqa', version: fsqa.version });
  });

  it('a second baseline adds nothing', async () => {
    await baseline(fsqa);
    const count = async () =>
      (await db.prepare('SELECT COUNT(*) AS n FROM pack_applied_items WHERE tenant_id = ?').bind(tenantId).first<{ n: number }>())!.n;
    const n = await count();
    const again = await baseline(fsqa);
    expect(again.entries).toEqual([]);
    expect(await count()).toBe(n);
    expect(
      (await db.prepare('SELECT COUNT(*) AS n FROM tenant_packs WHERE tenant_id = ?').bind(tenantId).first<{ n: number }>())!.n,
    ).toBe(1);
  });

  it('before the baseline the door is shut; after it, the organisation is simply up to date', async () => {
    const call = async () => {
      const res = await rollForwardRoute({
        request: new Request('http://localhost/api/starter-packs/roll-forward', {
          method: 'POST',
          body: JSON.stringify({ tenant_id: tenantId }),
        }),
        env,
        data: { user: { id: seed.superAdminId, role: 'super_admin', tenant_id: null } },
        params: {},
      } as never);
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    expect((await call()).status).toBe(409);
    await baseline(fsqa);
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body.up_to_date).toBe(true);
    expect(body.summary.inserted).toBe(0);
    expect(body.summary.fields_updated).toBe(0);
  });

  it('a later version never overwrites a "differs" column or adds an "absent" item -- until a person says so', async () => {
    await baseline(fsqa);
    const v2: StarterPack = structuredClone(fsqa);
    v2.version = fsqa.version + 1;
    v2.requirements.find((r) => r.slug === 'gtin')!.description = 'v2 GTIN wording';
    v2.requirements.find((r) => r.slug === 'pack-size')!.description = 'v2 pack size wording';
    v2.requirements.find((r) => r.slug === 'shelf-life')!.description = 'v2 shelf life wording';

    const roll = async (accept: Array<{ kind: string; key: string; field?: string }> = []) => {
      const base = { tenantId, tenantSlug, pack: v2, actorId: seed.superAdminId, ip: null };
      const preview = await runPackRollForward(db, { ...base, dryRun: true, accept: [] });
      return runPackRollForward(db, { ...base, dryRun: false, accept, fingerprint: preview.plan_fingerprint });
    };
    const read = async (slug: string) =>
      db.prepare(`SELECT description, active FROM requirements WHERE tenant_id = ? AND slug = ?`).bind(tenantId, slug).first<{
        description: string;
        active: number;
      }>();

    const first = await roll();
    expect(first.not_applied).toEqual([]);
    // Recorded as the pack's: updated.
    expect((await read('pack-size'))!.description).toBe('v2 pack size wording');
    // Recorded as differing, origin unknown: kept, and SAID.
    expect((await read('gtin'))!.description).toBe('ours');
    expect(first.items.find((i) => i.key === 'gtin')!.fields).toEqual([
      { field: 'description', action: 'keep', reason: 'unknown', current: 'ours', target: 'v2 GTIN wording' },
    ]);
    // Switched off: untouched.
    expect(await read('shelf-life')).toMatchObject({ active: 0, description: fsqa.requirements.find((r) => r.slug === 'shelf-life')!.description });
    // Absent: not resurrected, and neither are the rules that hung off it.
    expect(await db.prepare(`SELECT id FROM claim_types WHERE tenant_id = ? AND slug = 'made-in-usa'`).bind(tenantId).first()).toBeNull();
    expect(first.summary.inserted).toBe(0);

    // A person ticks them.
    const usaRules = v2.claim_rules.filter((r) => r.claim === 'made-in-usa');
    const second = await roll([
      { kind: 'requirement', key: 'gtin', field: 'description' },
      { kind: 'claim_type', key: 'made-in-usa' },
      ...usaRules.flatMap((r) =>
        [...r.requires, ...r.recommends].map((req) => ({ kind: 'claim_rule', key: `made-in-usa__${req}` })),
      ),
    ]);
    expect(second.not_applied).toEqual([]);
    expect((await read('gtin'))!.description).toBe('v2 GTIN wording');
    const usa = await db
      .prepare(`SELECT id FROM claim_types WHERE tenant_id = ? AND slug = 'made-in-usa'`)
      .bind(tenantId)
      .first<{ id: string }>();
    expect(usa).not.toBeNull();
    expect(await ledgerOf('claim_type', 'made-in-usa')).toMatchObject({ state: 'pack', row_id: usa!.id });
    const rules = await db
      .prepare(`SELECT COUNT(*) AS n FROM claim_type_requirements WHERE tenant_id = ? AND claim_type_id = ?`)
      .bind(tenantId, usa!.id)
      .first<{ n: number }>();
    expect(rules!.n).toBe(usaRules.reduce((n, r) => n + r.requires.length + r.recommends.length, 0));
    // The other claims' rules were absent too, were not asked for, and stay absent.
    expect(
      (await db.prepare(`SELECT COUNT(*) AS n FROM claim_type_requirements WHERE tenant_id = ?`).bind(tenantId).first<{ n: number }>())!.n,
    ).toBe(rules!.n);
  });
});
