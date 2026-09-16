/**
 * API tests for the spec-limit configuration surface:
 *   - /api/spec-tests   (analytes + the aliases suppliers print)
 *   - /api/spec-limits  (our acceptance thresholds)
 *
 * Drives the handlers directly with a fake PagesFunction context, mirroring
 * tests/api/lots-read.test.ts.
 *
 * The assertions that carry weight are the ones about limits that would
 * SILENTLY NEVER FIRE: a bound missing for its operator, or a scope pinned to
 * another tenant's supplier. Either produces a row the admin UI lists as active
 * while it can never match anything, which is worse than having no limit at all
 * — the tenant believes a check is running.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestGet as listTests, onRequestPost as createTest } from '../../functions/api/spec-tests/index';
import { onRequestPut as updateTest, onRequestDelete as deleteTest } from '../../functions/api/spec-tests/[id]';
import { onRequestGet as listLimits, onRequestPost as createLimit } from '../../functions/api/spec-limits/index';
import { onRequestPut as updateLimit, onRequestDelete as deleteLimit } from '../../functions/api/spec-limits/[id]';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

const asUser = (id: string, role: string, tenant_id: string | null) => ({ id, role, tenant_id });

function ctx(
  url: string,
  method: string,
  user: ReturnType<typeof asUser>,
  body?: unknown,
  params: Record<string, string> = {}
): any {
  return {
    request: new Request(url, {
      method,
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
        : {}),
    }),
    env,
    data: { user },
    params,
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/spec-limits',
  };
}

async function call(fn: any, c: any) {
  const res = await fn(c);
  return { status: res.status, body: (await res.json()) as any };
}

let orgAdmin: ReturnType<typeof asUser>;
let reader: ReturnType<typeof asUser>;
let coliformId = '';
let supplierId = '';
let otherTenantSupplierId = '';

beforeAll(async () => {
  seed = await seedTestData(db);
  orgAdmin = asUser(seed.orgAdminId, 'org_admin', seed.tenantId);
  reader = asUser(seed.readerId, 'reader', seed.tenantId);

  supplierId = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(supplierId, seed.tenantId, 'Andersen Dairy', `andersen-${supplierId.slice(0, 6)}`)
    .run();

  otherTenantSupplierId = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(otherTenantSupplierId, seed.tenantId2, 'Foreign Co', `foreign-${otherTenantSupplierId.slice(0, 6)}`)
    .run();
}, 30_000);

describe('spec-tests', () => {
  it('creates an analyte with the aliases suppliers print', async () => {
    const r = await call(
      createTest,
      ctx('http://localhost/api/spec-tests', 'POST', orgAdmin, {
        name: 'Coliform',
        aliases: ['Coliforms (MPN)', 'Total Coliform'],
        default_unit: 'CFU/g',
      })
    );
    expect(r.status).toBe(201);
    coliformId = r.body.specTest.id;
    expect(JSON.parse(r.body.specTest.aliases)).toEqual(['Coliforms (MPN)', 'Total Coliform']);
  });

  it('deduplicates and drops blank aliases', async () => {
    const r = await call(
      createTest,
      ctx('http://localhost/api/spec-tests', 'POST', orgAdmin, {
        name: 'Standard Plate Count',
        aliases: ['SPC', 'spc', '  ', 'APC'],
      })
    );
    expect(r.status).toBe(201);
    expect(JSON.parse(r.body.specTest.aliases)).toEqual(['SPC', 'APC']);
  });

  it('rejects a duplicate analyte name', async () => {
    const r = await call(
      createTest,
      ctx('http://localhost/api/spec-tests', 'POST', orgAdmin, { name: 'coliform' })
    );
    expect(r.status).toBe(409);
  });

  it('refuses writes from a reader but allows reads', async () => {
    const write = await call(
      createTest,
      ctx('http://localhost/api/spec-tests', 'POST', reader, { name: 'Yeast & Mold' })
    );
    expect(write.status).toBe(403);

    const read = await call(listTests, ctx('http://localhost/api/spec-tests', 'GET', reader));
    expect(read.status).toBe(200);
    expect(read.body.specTests.length).toBeGreaterThan(0);
  });

  it('lists only the caller tenant analytes, with parsed aliases', async () => {
    const r = await call(listTests, ctx('http://localhost/api/spec-tests', 'GET', orgAdmin));
    const coliform = r.body.specTests.find((t: any) => t.id === coliformId);
    expect(coliform.aliases).toEqual(['Coliforms (MPN)', 'Total Coliform']);
    expect(r.body.specTests.every((t: any) => t.tenant_id === seed.tenantId)).toBe(true);
  });

  it('updates aliases in place', async () => {
    const r = await call(
      updateTest,
      ctx(`http://localhost/api/spec-tests/${coliformId}`, 'PUT', orgAdmin, {
        aliases: ['Coliforms (MPN)', 'Total Coliform', 'COLIFORM CT'],
      }, { id: coliformId })
    );
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body.specTest.aliases)).toHaveLength(3);
  });
});

describe('spec-limits', () => {
  it('creates a tenant-wide limit — the day-one case, no supplier needed', async () => {
    const r = await call(
      createLimit,
      ctx('http://localhost/api/spec-limits', 'POST', orgAdmin, {
        spec_test_id: coliformId,
        operator: '<=',
        value_max: 10,
        unit: 'CFU/g',
      })
    );
    expect(r.status).toBe(201);
    expect(r.body.specLimit.supplier_id).toBeNull();
    expect(r.body.specLimit.severity).toBe('alert');
    expect(r.body.specLimit.version).toBe(1);
  });

  it('rejects an operator with no bound — a limit that could never fire', async () => {
    const r = await call(
      createLimit,
      ctx('http://localhost/api/spec-limits', 'POST', orgAdmin, {
        spec_test_id: coliformId,
        operator: '<=',
      })
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/maximum value is required/i);
  });

  it('rejects an inverted range', async () => {
    const r = await call(
      createLimit,
      ctx('http://localhost/api/spec-limits', 'POST', orgAdmin, {
        spec_test_id: coliformId,
        operator: 'between',
        value_min: 85,
        value_max: 80,
      })
    );
    expect(r.status).toBe(400);
  });

  it('accepts an absence limit with no bounds at all', async () => {
    // Its own analyte: one analyte holds at most one tenant-wide limit
    // (migration 0086), and coliform's is already taken by the test above.
    const salmonellaId = (
      await call(
        createTest,
        ctx('http://localhost/api/spec-tests', 'POST', orgAdmin, { name: 'Salmonella' })
      )
    ).body.specTest.id;
    const r = await call(
      createLimit,
      ctx('http://localhost/api/spec-limits', 'POST', orgAdmin, {
        spec_test_id: salmonellaId,
        operator: 'absent',
      })
    );
    expect(r.status).toBe(201);
  });

  it('refuses a second limit at the same scope instead of shadowing the first', async () => {
    // Two tenant-wide limits on one analyte are not a harmless duplicate:
    // resolveSpecLimits picks one by updated_at and the other sits in the admin
    // list looking active while judging nothing. Migration 0086 forbids it; this
    // check is what turns the constraint into a sentence rather than a 500.
    const r = await call(
      createLimit,
      ctx('http://localhost/api/spec-limits', 'POST', orgAdmin, {
        spec_test_id: coliformId,
        operator: '<=',
        value_max: 999,
      })
    );
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/already exists at that scope/i);
  });

  it("refuses a scope pinned to another tenant's supplier", async () => {
    // Stored, this row would be listed as active and never match anything.
    const r = await call(
      createLimit,
      ctx('http://localhost/api/spec-limits', 'POST', orgAdmin, {
        spec_test_id: coliformId,
        operator: '<=',
        value_max: 10,
        supplier_id: otherTenantSupplierId,
      })
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/supplier_id/);
  });

  it("refuses an analyte from another tenant", async () => {
    const foreignTest = generateTestId();
    await db
      .prepare('INSERT INTO spec_tests (id, tenant_id, name) VALUES (?, ?, ?)')
      .bind(foreignTest, seed.tenantId2, 'Foreign Analyte')
      .run();
    const r = await call(
      createLimit,
      ctx('http://localhost/api/spec-limits', 'POST', orgAdmin, {
        spec_test_id: foreignTest,
        operator: '<=',
        value_max: 1,
      })
    );
    expect(r.status).toBe(400);
  });

  it('bumps version on edit and validates the RESULTING shape', async () => {
    const created = await call(
      createLimit,
      ctx('http://localhost/api/spec-limits', 'POST', orgAdmin, {
        spec_test_id: coliformId,
        operator: '<=',
        value_max: 10,
        supplier_id: supplierId,
      })
    );
    const id = created.body.specLimit.id;

    // Switching to a minimum without supplying one must fail, even though the
    // row currently holds a valid maximum.
    const bad = await call(
      updateLimit,
      ctx(`http://localhost/api/spec-limits/${id}`, 'PUT', orgAdmin, { operator: '>=' }, { id })
    );
    expect(bad.status).toBe(400);

    const good = await call(
      updateLimit,
      ctx(`http://localhost/api/spec-limits/${id}`, 'PUT', orgAdmin, { value_max: 5 }, { id })
    );
    expect(good.status).toBe(200);
    expect(good.body.specLimit.value_max).toBe(5);
    expect(good.body.specLimit.version).toBe(2);
  });

  it('lists limits joined to their analyte and scope names', async () => {
    const r = await call(listLimits, ctx('http://localhost/api/spec-limits', 'GET', orgAdmin));
    expect(r.status).toBe(200);
    const scoped = r.body.specLimits.find((l: any) => l.supplier_id === supplierId);
    expect(scoped.test_name).toBe('Coliform');
    expect(scoped.supplier_name).toBe('Andersen Dairy');
  });

  it('deletes a limit, and cascades limits when its analyte goes', async () => {
    const doomedTest = (
      await call(
        createTest,
        ctx('http://localhost/api/spec-tests', 'POST', orgAdmin, { name: 'Doomed Analyte' })
      )
    ).body.specTest.id;
    const doomedLimit = (
      await call(
        createLimit,
        ctx('http://localhost/api/spec-limits', 'POST', orgAdmin, {
          spec_test_id: doomedTest,
          operator: '<=',
          value_max: 1,
        })
      )
    ).body.specLimit.id;

    const del = await call(
      deleteLimit,
      ctx(`http://localhost/api/spec-limits/${doomedLimit}`, 'DELETE', orgAdmin, undefined, {
        id: doomedLimit,
      })
    );
    expect(del.status).toBe(200);

    // Re-add one, then delete the analyte and confirm the count is reported.
    const survivor = (
      await call(
        createLimit,
        ctx('http://localhost/api/spec-limits', 'POST', orgAdmin, {
          spec_test_id: doomedTest,
          operator: '<=',
          value_max: 1,
        })
      )
    ).body.specLimit.id;

    const delTest = await call(
      deleteTest,
      ctx(`http://localhost/api/spec-tests/${doomedTest}`, 'DELETE', orgAdmin, undefined, {
        id: doomedTest,
      })
    );
    expect(delTest.status).toBe(200);
    expect(delTest.body.limits_removed).toBe(1);

    const gone = await db.prepare('SELECT id FROM spec_limits WHERE id = ?').bind(survivor).first();
    expect(gone).toBeNull();
  });

  it('refuses cross-tenant access to a limit', async () => {
    const otherAdmin = asUser(seed.orgAdmin2Id, 'org_admin', seed.tenantId2);
    const ownTest = (
      await call(
        createTest,
        ctx('http://localhost/api/spec-tests', 'POST', orgAdmin, { name: 'Cross Tenant Probe' })
      )
    ).body.specTest.id;
    const mine = (
      await call(
        createLimit,
        ctx('http://localhost/api/spec-limits', 'POST', orgAdmin, {
          spec_test_id: ownTest,
          operator: '<=',
          value_max: 10,
        })
      )
    ).body.specLimit.id;

    const r = await call(
      updateLimit,
      ctx(`http://localhost/api/spec-limits/${mine}`, 'PUT', otherAdmin, { value_max: 999 }, { id: mine })
    );
    expect(r.status).toBe(403);
  });
});

/**
 * WHEN `version` MOVES — one rule, and `bin/lib/specLimitsImport.js` applies the
 * same one (both call `limitThresholdChanged`; the importer's half is pinned in
 * tests/unit/specLimitsImport.test.ts).
 *
 * The counter's whole job is to tell a reader of an old verdict that the limit
 * on screen is not the one that judged it. Bumping it for a notes fix inflates
 * it until it means nothing; not bumping it for a moved threshold is worse,
 * because the frozen `limit_snapshot` would then cite one version for two
 * different sets of numbers.
 *
 * This endpoint used to bump on EVERY edit, so the same limit reached a
 * different version depending on whether it was last touched through the app or
 * through the workbook.
 */
describe('spec-limits — version moves only when the threshold does', () => {
  /** A limit on its own analyte, so each case is free of the scope-uniqueness rule. */
  const freshLimit = async (body: Record<string, unknown> = {}) => {
    const analyte = (
      await call(
        createTest,
        ctx('http://localhost/api/spec-tests', 'POST', orgAdmin, {
          name: `Version Probe ${generateTestId().slice(0, 8)}`,
        })
      )
    ).body.specTest.id as string;
    const created = await call(
      createLimit,
      ctx('http://localhost/api/spec-limits', 'POST', orgAdmin, {
        spec_test_id: analyte,
        operator: '<=',
        value_max: 10,
        unit: 'CFU/g',
        notes: 'first note',
        criticality: 'medium',
        ...body,
      })
    );
    expect(created.body.specLimit.version).toBe(1);
    return created.body.specLimit.id as string;
  };

  const put = (id: string, body: Record<string, unknown>) =>
    call(updateLimit, ctx(`http://localhost/api/spec-limits/${id}`, 'PUT', orgAdmin, body, { id }));

  it('bumps when the value moves', async () => {
    const id = await freshLimit();
    expect((await put(id, { value_max: 20 })).body.specLimit.version).toBe(2);
  });

  it('bumps when the operator moves', async () => {
    const id = await freshLimit();
    expect((await put(id, { operator: '<', value_max: 10 })).body.specLimit.version).toBe(2);
  });

  it('bumps when the unit moves — the same number is a different quantity', async () => {
    const id = await freshLimit();
    expect((await put(id, { unit: 'CFU/mL' })).body.specLimit.version).toBe(2);
  });

  it('does NOT bump for notes', async () => {
    const id = await freshLimit();
    const r = await put(id, { notes: 'clarified for the auditor' });
    expect(r.body.specLimit.version).toBe(1);
    expect(r.body.specLimit.notes).toBe('clarified for the auditor');
  });

  it('does NOT bump for criticality — a rank is not a threshold', async () => {
    const id = await freshLimit();
    const r = await put(id, { criticality: 'high' });
    expect(r.body.specLimit.version).toBe(1);
    expect(r.body.specLimit.criticality).toBe('high');
  });

  it('does NOT bump for severity, or for deactivating the limit', async () => {
    const id = await freshLimit();
    expect((await put(id, { severity: 'warn' })).body.specLimit.version).toBe(1);
    expect((await put(id, { active: false })).body.specLimit.version).toBe(1);
  });

  it('does NOT bump for a scope move — other documents, same threshold', async () => {
    const id = await freshLimit();
    const r = await put(id, { supplier_id: supplierId });
    expect(r.body.specLimit.version).toBe(1);
    expect(r.body.specLimit.supplier_id).toBe(supplierId);
  });

  it('says in the audit row whether this was a new version', async () => {
    const id = await freshLimit();
    await put(id, { notes: 'a note' });
    const quiet = await db
      .prepare(
        `SELECT details FROM audit_log WHERE action = 'spec_limit.updated' AND resource_id = ?
          ORDER BY id DESC LIMIT 1`
      )
      .bind(id)
      .first<{ details: string }>();
    expect(JSON.parse(quiet!.details).version_bumped).toBe(false);

    await put(id, { value_max: 5 });
    const loud = await db
      .prepare(
        `SELECT details FROM audit_log WHERE action = 'spec_limit.updated' AND resource_id = ?
          ORDER BY id DESC LIMIT 1`
      )
      .bind(id)
      .first<{ details: string }>();
    const parsed = JSON.parse(loud!.details);
    expect(parsed.version_bumped).toBe(true);
    expect(parsed.after.version).toBe(2);
  });
});
