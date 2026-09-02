/**
 * /api/spec-unit-policy — the per-tenant unit equivalence (migration 0093).
 *
 * This is the one setting in the spec feature that changes an ANSWER rather
 * than adding a rule: with it on, a CFU/mL result is judged against a CFU/g
 * limit. So the properties worth pinning are not "the column round-trips":
 *
 *   1. OFF by default. A tenant that has said nothing — a new one, or one
 *      handling powders — gets today's refusal, which is the correct answer
 *      when a gram and a millilitre are genuinely different quantities.
 *   2. The loader actually carries it into the engine, and the verdict that
 *      results SAYS SO. An equivalence that reached the engine but not the
 *      reason text would be the silent pass the module exists to refuse.
 *   3. The register FREEZES it. A verdict must stay re-explainable after
 *      someone turns the setting back off.
 *   4. Only an admin can flip it, and only with an explicit boolean.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import {
  onRequestGet as getPolicy,
  onRequestPut as putPolicy,
} from '../../functions/api/spec-unit-policy/index';
import { loadSpecConfig, specResultsWithConfig } from '../../functions/lib/spec-warnings';
import { registerSpecChecks } from '../../functions/lib/spec-register';
import type { ConfiguredLimit, SpecVerdict } from '../../shared/specCheck';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

const asUser = (id: string, role: string, tenant_id: string | null) => ({ id, role, tenant_id });

function ctx(url: string, method: string, user: ReturnType<typeof asUser>, body?: unknown): any {
  return {
    request: new Request(url, {
      method,
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
        : {}),
    }),
    env,
    data: { user },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/spec-unit-policy',
  };
}

async function call(fn: any, c: any) {
  const res = await fn(c);
  return { status: res.status, body: (await res.json()) as any };
}

const URL_BASE = 'http://localhost/api/spec-unit-policy';

let orgAdmin: ReturnType<typeof asUser>;
let plainUser: ReturnType<typeof asUser>;

/** A COA row printing its coliform count per millilitre, as fluid dairy does. */
const FLUID_ROW = {
  tables: JSON.stringify([
    {
      name: 'micro',
      headers: ['test', 'specification', 'result', 'units'],
      rows: [['Coliform', '', '120', 'CFU/mL']],
    },
  ]),
};

let specTestId = '';

beforeAll(async () => {
  seed = await seedTestData(db);
  orgAdmin = asUser(seed.orgAdminId, 'org_admin', seed.tenantId);
  plainUser = asUser(seed.userId, 'user', seed.tenantId);

  // One analyte and one tenant-wide limit, written per gram — the shape the
  // production tenant is actually in.
  specTestId = generateTestId();
  await db
    .prepare('INSERT INTO spec_tests (id, tenant_id, name, aliases, default_unit) VALUES (?, ?, ?, ?, ?)')
    .bind(specTestId, seed.tenantId, 'Coliform', JSON.stringify(['Total Coliform']), 'CFU/g')
    .run();
  await db
    .prepare(
      `INSERT INTO spec_limits (id, tenant_id, spec_test_id, operator, value_max, unit, severity, active)
       VALUES (?, ?, ?, '<=', 20000, 'CFU/g', 'alert', 1)`
    )
    .bind(generateTestId(), seed.tenantId, specTestId)
    .run();
}, 30_000);

describe('the setting itself', () => {
  it('is OFF for a tenant that has never touched it', async () => {
    const r = await call(getPolicy, ctx(URL_BASE, 'GET', orgAdmin));
    expect(r.status).toBe(200);
    expect(r.body.volume_mass_equivalent).toBe(false);
    expect(r.body.updated_at).toBeNull();
  });

  it('turns on and back off, stamping who did it', async () => {
    const on = await call(
      putPolicy,
      ctx(URL_BASE, 'PUT', orgAdmin, { volume_mass_equivalent: true })
    );
    expect(on.status).toBe(200);
    expect(on.body.volume_mass_equivalent).toBe(true);
    expect(on.body.updated_by).toBe(seed.orgAdminId);
    expect(on.body.updated_at).toBeTruthy();

    expect((await call(getPolicy, ctx(URL_BASE, 'GET', orgAdmin))).body.volume_mass_equivalent).toBe(
      true
    );

    const off = await call(
      putPolicy,
      ctx(URL_BASE, 'PUT', orgAdmin, { volume_mass_equivalent: false })
    );
    expect(off.body.volume_mass_equivalent).toBe(false);
  });

  it('refuses anything that is not an explicit boolean', async () => {
    // A fuzzy value would quietly mean "off" on a setting nobody would think to
    // re-check, so the request is refused instead.
    for (const bad of [undefined, 'true', 1, null]) {
      const r = await call(putPolicy, ctx(URL_BASE, 'PUT', orgAdmin, { volume_mass_equivalent: bad }));
      expect(r.status, `body ${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it('is not a setting an ordinary user may flip', async () => {
    const r = await call(putPolicy, ctx(URL_BASE, 'PUT', plainUser, { volume_mass_equivalent: true }));
    expect(r.status).toBe(403);
  });
});

describe('the setting reaches the engine — and announces itself', () => {
  it('leaves CFU/mL unjudged while it is off', async () => {
    await call(putPolicy, ctx(URL_BASE, 'PUT', orgAdmin, { volume_mass_equivalent: false }));
    const config = await loadSpecConfig(db, seed.tenantId);
    expect(config.unitPolicy.volume_mass_equivalent).toBe(false);

    const { results } = specResultsWithConfig(FLUID_ROW, config, {}, { includePasses: true });
    const ours = results.filter((v) => v.source === 'limit');
    expect(ours).toHaveLength(1);
    expect(ours[0].verdict).toBe('not_checked');
    expect(ours[0].reason).toMatch(/not comparable/);
  });

  it('judges it once on, and every sentence says why', async () => {
    await call(putPolicy, ctx(URL_BASE, 'PUT', orgAdmin, { volume_mass_equivalent: true }));
    const config = await loadSpecConfig(db, seed.tenantId);
    expect(config.unitPolicy.volume_mass_equivalent).toBe(true);

    const { results } = specResultsWithConfig(FLUID_ROW, config, {}, { includePasses: true });
    const ours = results.filter((v) => v.source === 'limit');
    expect(ours).toHaveLength(1);
    expect(ours[0].verdict).toBe('in_spec');
    expect(ours[0].unit_equivalence_applied).toBe(true);
    expect(ours[0].reason).toMatch(/CFU\/mL judged as CFU\/g, per this tenant's setting/);
    expect(ours[0].message).toMatch(/CFU\/mL judged as CFU\/g, per this tenant's setting/);
  });

  it('is per tenant — the neighbour still refuses', async () => {
    await call(putPolicy, ctx(URL_BASE, 'PUT', orgAdmin, { volume_mass_equivalent: true }));
    const other = await loadSpecConfig(db, seed.tenantId2);
    expect(other.unitPolicy.volume_mass_equivalent).toBe(false);
  });
});

describe('the register freezes the equivalence', () => {
  it('records that a verdict was reached under it', async () => {
    // Turn the setting off next month and this row must still explain itself.
    const documentId = generateTestId();
    await db
      .prepare(
        `INSERT INTO documents (id, tenant_id, title, current_version, status, created_by)
         VALUES (?, ?, ?, 1, 'active', ?)`
      )
      .bind(documentId, seed.tenantId, 'Fluid COA', seed.orgAdminId)
      .run();

    const limit: ConfiguredLimit = {
      id: 'limit-fluid',
      spec_test_id: specTestId,
      operator: '<=',
      value_min: null,
      value_max: 20000,
      unit: 'CFU/g',
      severity: 'alert',
      active: true,
      supplier_id: null,
      document_type_id: null,
      product_id: null,
    };
    const equated: SpecVerdict = {
      scope: 'ai_fields',
      target: { kind: 'table', table_index: 0, row_index: 0, table_name: 'micro' },
      test_name_raw: 'Coliform',
      value_raw: '120',
      unit_raw: 'CFU/mL',
      verdict: 'in_spec',
      source: 'limit',
      limit_text: '≤20000 CFU/g',
      reason: "120 is within the 20000 limit (CFU/mL judged as CFU/g, per this tenant's setting)",
      message: 'Coliform is 120, within our limit of ≤20000 CFU/g.',
      limit_id: limit.id,
      spec_test_id: specTestId,
      value_num: 120,
      unit_equivalence_applied: true,
    };
    const plain: SpecVerdict = {
      ...equated,
      target: { kind: 'table', table_index: 0, row_index: 1, table_name: 'micro' },
      unit_raw: 'CFU/g',
      reason: '120 is within the 20000 limit',
      unit_equivalence_applied: undefined,
    };

    await registerSpecChecks(
      db,
      { tenantId: seed.tenantId, documentId, versionNumber: 1 },
      [equated, plain],
      [limit]
    );

    const rows = await db
      .prepare('SELECT unit_raw, limit_snapshot, reason FROM document_spec_checks WHERE document_id = ?')
      .bind(documentId)
      .all<{ unit_raw: string; limit_snapshot: string; reason: string }>();

    const byUnit = Object.fromEntries(
      (rows.results ?? []).map((r) => [r.unit_raw, JSON.parse(r.limit_snapshot)])
    );
    expect(byUnit['CFU/mL']).toMatchObject({ value_max: 20000, unit_equivalence: 'volume_mass' });
    // A row that never needed the equivalence must not claim it.
    expect(byUnit['CFU/g']).toMatchObject({ value_max: 20000 });
    expect(byUnit['CFU/g'].unit_equivalence).toBeUndefined();
  });
});
