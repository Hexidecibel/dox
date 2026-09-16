/**
 * API tests for the alias-gap surface:
 *   GET    /api/spec-unmatched            — the spellings nothing recognises
 *   POST   /api/spec-tests/:id/aliases    — the one-click fix
 *   POST   /api/spec-unmatched/ignore     — "that is not a test"
 *   DELETE /api/spec-unmatched/ignore     — undo
 *
 * The assertion that carries the most weight is the LOOP: a spelling listed
 * here, attached to an analyte, is gone from the next read. If that does not
 * hold, the panel is a list of things a person clicks and then sees again,
 * which is worse than no panel — it teaches them the fix does not work.
 *
 * After that, tenant isolation. The scan reads every approved document in a
 * tenant; a leak here would put one customer's printed test names, supplier
 * names and document titles on another customer's screen.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestGet as listUnmatched } from '../../functions/api/spec-unmatched/index';
import {
  onRequestPost as ignoreName,
  onRequestDelete as restoreName,
} from '../../functions/api/spec-unmatched/ignore';
import { onRequestPost as addAlias } from '../../functions/api/spec-tests/[id]/aliases';

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
    functionPath: '/api/spec-unmatched',
  };
}

async function call(fn: any, c: any) {
  const res = await fn(c);
  return { status: res.status, body: (await res.json()) as any };
}

let orgAdmin: ReturnType<typeof asUser>;
let otherAdmin: ReturnType<typeof asUser>;
let reader: ReturnType<typeof asUser>;
let superAdmin: ReturnType<typeof asUser>;
let coliformId = '';

/** An approved COA with a results table, as the COA producer stores it. */
async function seedDocument(
  tenantId: string,
  rows: string[][],
  opts: { title?: string; supplierId?: string | null } = {}
): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, status, supplier_id, extended_metadata,
                              created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, datetime('now'), datetime('now'))`
    )
    .bind(
      id,
      tenantId,
      opts.title ?? 'COA',
      opts.supplierId ?? null,
      JSON.stringify({
        tables: [{ name: 'results', headers: ['test', 'result', 'units'], rows }],
      }),
      seed.orgAdminId
    )
    .run();
  return id;
}

beforeAll(async () => {
  seed = await seedTestData(db);
  orgAdmin = asUser(seed.orgAdminId, 'org_admin', seed.tenantId);
  otherAdmin = asUser(seed.orgAdmin2Id, 'org_admin', seed.tenantId2);
  reader = asUser(seed.readerId, 'reader', seed.tenantId);
  superAdmin = asUser(seed.superAdminId, 'super_admin', null);
});

beforeEach(async () => {
  await db.prepare('DELETE FROM spec_unmatched_ignores').run();
  await db.prepare('DELETE FROM spec_limits').run();
  await db.prepare('DELETE FROM spec_tests').run();
  await db.prepare('DELETE FROM documents').run();

  coliformId = generateTestId();
  await db
    .prepare(
      `INSERT INTO spec_tests (id, tenant_id, name, aliases, default_unit)
       VALUES (?, ?, 'Coliform', '["Total Coliform"]', 'CFU/g')`
    )
    .bind(coliformId, seed.tenantId)
    .run();
  await db
    .prepare(
      `INSERT INTO spec_limits (id, tenant_id, spec_test_id, operator, value_max, unit, severity, active)
       VALUES (?, ?, ?, '<=', 10, 'CFU/g', 'alert', 1)`
    )
    .bind(generateTestId(), seed.tenantId, coliformId)
    .run();
});

describe('GET /api/spec-unmatched', () => {
  it('reports the spellings nothing recognises, with counts and an example', async () => {
    await seedDocument(
      seed.tenantId,
      [
        ['Coliform', '<10', 'CFU/g'],
        ['Butterfat', '80.2', '%'],
        ['Flavor', 'Good', ''],
      ],
      { title: 'Cream COA' }
    );
    await seedDocument(seed.tenantId, [['BUTTERFAT', '80.4', '%']], { title: 'Butter COA' });

    const { status, body } = await call(
      listUnmatched,
      ctx('http://x/api/spec-unmatched', 'GET', orgAdmin)
    );
    expect(status).toBe(200);
    expect(body.total_groups).toBe(2);
    expect(body.total_results).toBe(3);
    expect(body.documents_scanned).toBe(2);
    expect(body.scan_truncated).toBe(false);

    const butterfat = body.unmatched.find((g: any) => g.key === 'butterfat');
    expect(butterfat.results).toBe(2);
    expect(butterfat.documents).toBe(2);
    expect(butterfat.spellings).toHaveLength(2);
    expect(butterfat.example.document_title).toBeTruthy();
    // A recognised analyte never appears.
    expect(body.unmatched.some((g: any) => g.key === 'coliform')).toBe(false);
  });

  it('pages, and reports the total independently of the page', async () => {
    await seedDocument(seed.tenantId, [
      ['Flavor', 'Good', ''],
      ['Color', 'White', ''],
      ['Aroma', 'Clean', ''],
    ]);
    const first = await call(
      listUnmatched,
      ctx('http://x/api/spec-unmatched?limit=2&offset=0', 'GET', orgAdmin)
    );
    expect(first.body.unmatched).toHaveLength(2);
    expect(first.body.total_groups).toBe(3);

    const second = await call(
      listUnmatched,
      ctx('http://x/api/spec-unmatched?limit=2&offset=2', 'GET', orgAdmin)
    );
    expect(second.body.unmatched).toHaveLength(1);
    expect(second.body.offset).toBe(2);
    const names = [...first.body.unmatched, ...second.body.unmatched].map((g: any) => g.name);
    expect(new Set(names).size).toBe(3);
  });

  it('never reads another tenant documents', async () => {
    await seedDocument(seed.tenantId, [['Butterfat', '80.2', '%']]);
    await seedDocument(seed.tenantId2, [['Scorched Particles', 'B', '']], {
      title: 'Other Corp COA',
    });

    const mine = await call(listUnmatched, ctx('http://x/api/spec-unmatched', 'GET', orgAdmin));
    expect(mine.body.unmatched.map((g: any) => g.name)).toEqual(['Butterfat']);

    const theirs = await call(
      listUnmatched,
      ctx('http://x/api/spec-unmatched', 'GET', otherAdmin)
    );
    expect(theirs.body.unmatched.map((g: any) => g.name)).toEqual(['Scorched Particles']);
  });

  it('is org_admin+; a reader cannot run a corpus scan', async () => {
    const res = await listUnmatched(ctx('http://x/api/spec-unmatched', 'GET', reader));
    expect(res.status).toBe(403);
  });

  it('asks a super_admin which tenant', async () => {
    const { status } = await call(
      listUnmatched,
      ctx('http://x/api/spec-unmatched', 'GET', superAdmin)
    );
    expect(status).toBe(400);
    const scoped = await call(
      listUnmatched,
      ctx(`http://x/api/spec-unmatched?tenant_id=${seed.tenantId}`, 'GET', superAdmin)
    );
    expect(scoped.status).toBe(200);
  });

  it('says so when it read fewer documents than the tenant holds', async () => {
    await seedDocument(seed.tenantId, [['Flavor', 'Good', '']]);
    await seedDocument(seed.tenantId, [['Color', 'White', '']]);
    const { body } = await call(
      listUnmatched,
      ctx('http://x/api/spec-unmatched?scan=1', 'GET', orgAdmin)
    );
    expect(body.scan_truncated).toBe(true);
    expect(body.documents_scanned).toBe(1);
  });
});

describe('POST /api/spec-tests/:id/aliases', () => {
  it('adds the spelling, audits it, and the gap is gone on the next read', async () => {
    await seedDocument(seed.tenantId, [
      ['COLIFORM AEROBIC', '<10', 'CFU/g'],
      ['Flavor', 'Good', ''],
    ]);

    const before = await call(listUnmatched, ctx('http://x/api/spec-unmatched', 'GET', orgAdmin));
    expect(before.body.unmatched.map((g: any) => g.name).sort()).toEqual([
      'COLIFORM AEROBIC',
      'Flavor',
    ]);

    const added = await call(
      addAlias,
      ctx(
        `http://x/api/spec-tests/${coliformId}/aliases`,
        'POST',
        orgAdmin,
        { name: 'COLIFORM AEROBIC' },
        { id: coliformId }
      )
    );
    expect(added.status).toBe(201);
    expect(added.body.added).toEqual(['COLIFORM AEROBIC']);
    // Merged, never replaced: the spelling that was already there survives.
    expect(added.body.specTest.aliases).toEqual(['Total Coliform', 'COLIFORM AEROBIC']);

    const audit = await db
      .prepare(
        `SELECT action, details FROM audit_log
          WHERE tenant_id = ? AND action = 'spec_test.alias_added'
          ORDER BY id DESC LIMIT 1`
      )
      .bind(seed.tenantId)
      .first<{ action: string; details: string }>();
    expect(audit?.action).toBe('spec_test.alias_added');
    expect(JSON.parse(audit!.details).added).toEqual(['COLIFORM AEROBIC']);

    const after = await call(listUnmatched, ctx('http://x/api/spec-unmatched', 'GET', orgAdmin));
    expect(after.body.unmatched.map((g: any) => g.name)).toEqual(['Flavor']);
  });

  it('reports an alias that is already there instead of duplicating it', async () => {
    const { status, body } = await call(
      addAlias,
      ctx(
        `http://x/api/spec-tests/${coliformId}/aliases`,
        'POST',
        orgAdmin,
        { name: 'total coliform' },
        { id: coliformId }
      )
    );
    expect(status).toBe(200);
    expect(body.added).toEqual([]);
    expect(body.already_present).toEqual(['total coliform']);
    expect(body.specTest.aliases).toEqual(['Total Coliform']);
  });

  it('refuses a spelling another analyte already answers to', async () => {
    const spcId = generateTestId();
    await db
      .prepare(
        `INSERT INTO spec_tests (id, tenant_id, name, aliases) VALUES (?, ?, 'Standard Plate Count', '["APC"]')`
      )
      .bind(spcId, seed.tenantId)
      .run();

    const { status, body } = await call(
      addAlias,
      ctx(
        `http://x/api/spec-tests/${coliformId}/aliases`,
        'POST',
        orgAdmin,
        { name: 'apc' },
        { id: coliformId }
      )
    );
    expect(status).toBe(409);
    expect(body.analyte).toBe('Standard Plate Count');
  });

  it('is org_admin+ and tenant-scoped', async () => {
    const asReader = await addAlias(
      ctx(
        `http://x/api/spec-tests/${coliformId}/aliases`,
        'POST',
        reader,
        { name: 'x' },
        { id: coliformId }
      )
    );
    expect(asReader.status).toBe(403);

    const asOther = await addAlias(
      ctx(
        `http://x/api/spec-tests/${coliformId}/aliases`,
        'POST',
        otherAdmin,
        { name: 'x' },
        { id: coliformId }
      )
    );
    expect(asOther.status).toBe(403);
  });
});

describe('POST/DELETE /api/spec-unmatched/ignore', () => {
  it('drops a dismissed spelling from the list and audits both directions', async () => {
    await seedDocument(seed.tenantId, [
      ['LOT CODE', 'A1', ''],
      ['Butterfat', '80.2', '%'],
    ]);

    const dismissed = await call(
      ignoreName,
      ctx('http://x/api/spec-unmatched/ignore', 'POST', orgAdmin, {
        name: 'LOT CODE',
        reason: 'lot identifier, not a test',
      })
    );
    expect(dismissed.status).toBe(201);

    const after = await call(listUnmatched, ctx('http://x/api/spec-unmatched', 'GET', orgAdmin));
    expect(after.body.unmatched.map((g: any) => g.name)).toEqual(['Butterfat']);
    expect(after.body.ignored_count).toBe(1);

    // Visible on request — a dismissal is never invisible.
    const withIgnored = await call(
      listUnmatched,
      ctx('http://x/api/spec-unmatched?include_ignored=1', 'GET', orgAdmin)
    );
    expect(withIgnored.body.ignored[0]).toMatchObject({
      name_raw: 'LOT CODE',
      reason: 'lot identifier, not a test',
      created_by_name: 'Org Admin',
    });

    const restored = await call(
      restoreName,
      ctx('http://x/api/spec-unmatched/ignore?name=lot%20code', 'DELETE', orgAdmin)
    );
    expect(restored.status).toBe(200);

    const back = await call(listUnmatched, ctx('http://x/api/spec-unmatched', 'GET', orgAdmin));
    expect(back.body.unmatched.map((g: any) => g.name).sort()).toEqual(['Butterfat', 'LOT CODE']);

    const actions = await db
      .prepare(
        `SELECT action FROM audit_log WHERE tenant_id = ? AND action LIKE 'spec_unmatched%'
          ORDER BY id`
      )
      .bind(seed.tenantId)
      .all();
    expect((actions.results ?? []).map((r: any) => r.action)).toEqual([
      'spec_unmatched.ignored',
      'spec_unmatched.restored',
    ]);
  });

  it('dismisses every spelling of the same name, not just the one clicked', async () => {
    await seedDocument(seed.tenantId, [
      ['Flavor', 'Good', ''],
      ['FLAVOR', 'GOOD', ''],
    ]);
    await call(
      ignoreName,
      ctx('http://x/api/spec-unmatched/ignore', 'POST', orgAdmin, { name: 'flavor' })
    );
    const after = await call(listUnmatched, ctx('http://x/api/spec-unmatched', 'GET', orgAdmin));
    expect(after.body.unmatched).toEqual([]);
  });

  it('is idempotent — two admins clearing the same worklist is not a conflict', async () => {
    const first = await call(
      ignoreName,
      ctx('http://x/api/spec-unmatched/ignore', 'POST', orgAdmin, { name: 'Odor' })
    );
    const second = await call(
      ignoreName,
      ctx('http://x/api/spec-unmatched/ignore', 'POST', orgAdmin, { name: 'ODOR' })
    );
    expect(second.status).toBe(201);
    expect(second.body.ignored.id).toBe(first.body.ignored.id);
    const rows = await db
      .prepare('SELECT COUNT(*) AS n FROM spec_unmatched_ignores WHERE tenant_id = ?')
      .bind(seed.tenantId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it('keeps one tenant dismissals out of another tenant list', async () => {
    await seedDocument(seed.tenantId, [['Flavor', 'Good', '']]);
    await seedDocument(seed.tenantId2, [['Flavor', 'Good', '']]);
    await call(
      ignoreName,
      ctx('http://x/api/spec-unmatched/ignore', 'POST', orgAdmin, { name: 'Flavor' })
    );
    const theirs = await call(
      listUnmatched,
      ctx('http://x/api/spec-unmatched', 'GET', otherAdmin)
    );
    expect(theirs.body.unmatched.map((g: any) => g.name)).toEqual(['Flavor']);
    expect(theirs.body.ignored_count).toBe(0);
  });

  it('is org_admin+', async () => {
    const res = await ignoreName(
      ctx('http://x/api/spec-unmatched/ignore', 'POST', reader, { name: 'Flavor' })
    );
    expect(res.status).toBe(403);
  });
});
