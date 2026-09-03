/**
 * Criticality across the write path and the register (migration 0095).
 *
 * Three things are worth a database for:
 *
 *   1. A LIMIT WRITTEN WITHOUT A TIER LANDS ON THE DEFAULT. Every existing
 *      client, the importer, and the review-queue seed all POST without the
 *      field, and none of them may end up marked critical — "everything is
 *      critical" is the flat screen this feature exists to undo.
 *   2. AN UNRECOGNISED TIER IS A 400, not a silent demotion. Quietly coercing a
 *      typo would take a limit somebody marked as load-stopping and file it as
 *      tracked, with nothing on any screen saying so.
 *   3. THE TIER IS FROZEN INTO limit_snapshot. Ranks get re-tuned exactly like
 *      thresholds do, and a register that re-labelled old rows to match today's
 *      ranking would answer a different question than the auditor asked.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPost as createLimit } from '../../functions/api/spec-limits/index';
import { onRequestPut as updateLimit } from '../../functions/api/spec-limits/[id]';
import { registerSpecChecks } from '../../functions/lib/spec-register';
import { loadSpecConfig } from '../../functions/lib/spec-warnings';
import {
  DEFAULT_SPEC_CRITICALITY,
  SPEC_CRITICALITY_VALUES,
} from '../../shared/specCriticality';
import type { ConfiguredLimit, SpecVerdict } from '../../shared/specCheck';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let orgAdmin: { id: string; role: string; tenant_id: string | null };
let specTestId = '';

const [TOP_TIER] = SPEC_CRITICALITY_VALUES;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ctx(url: string, method: string, body?: unknown, params: Record<string, string> = {}): any {
  return {
    request: new Request(url, {
      method,
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
        : {}),
    }),
    env,
    data: { user: orgAdmin },
    params,
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/spec-limits',
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(fn: any, c: any) {
  const res = await fn(c);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as any };
}

beforeAll(async () => {
  seed = await seedTestData(db);
  orgAdmin = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

  specTestId = generateTestId();
  await db
    .prepare('INSERT INTO spec_tests (id, tenant_id, name, aliases) VALUES (?, ?, ?, ?)')
    .bind(specTestId, seed.tenantId, 'Coliform', '["Total Coliform"]')
    .run();
}, 30_000);

describe('POST /api/spec-limits', () => {
  it('defaults a limit written without a tier to the middle one', async () => {
    const r = await call(
      createLimit,
      ctx('http://localhost/api/spec-limits', 'POST', {
        spec_test_id: specTestId,
        operator: '<=',
        value_max: 10,
        unit: 'CFU/g',
      })
    );
    expect(r.status).toBe(201);
    expect(r.body.specLimit.criticality).toBe(DEFAULT_SPEC_CRITICALITY);
  });

  it('stores a tier that was asked for, and refuses one that was not', async () => {
    // Its own scope: one analyte holds at most one limit per scope (0086).
    const supplierId = generateTestId();
    await db
      .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
      .bind(supplierId, seed.tenantId, 'Andersen Dairy', `andersen-${supplierId.slice(0, 6)}`)
      .run();

    const ok = await call(
      createLimit,
      ctx('http://localhost/api/spec-limits', 'POST', {
        spec_test_id: specTestId,
        supplier_id: supplierId,
        operator: '<=',
        value_max: 1,
        unit: 'CFU/g',
        criticality: TOP_TIER,
      })
    );
    expect(ok.status).toBe(201);
    expect(ok.body.specLimit.criticality).toBe(TOP_TIER);

    const bad = await call(
      createLimit,
      ctx('http://localhost/api/spec-limits', 'POST', {
        spec_test_id: specTestId,
        operator: '<=',
        value_max: 5,
        criticality: 'URGENT',
      })
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/criticality must be one of/i);

    // And the same refusal on the edit path, which is where a limit's rank
    // actually gets changed.
    const put = await call(
      updateLimit,
      ctx(
        `http://localhost/api/spec-limits/${ok.body.specLimit.id}`,
        'PUT',
        { criticality: 'kinda-important' },
        { id: ok.body.specLimit.id }
      )
    );
    expect(put.status).toBe(400);
  });
});

describe('loadSpecConfig', () => {
  it('hands the engine the stored tier', async () => {
    const config = await loadSpecConfig(db, seed.tenantId);
    const tiers = config.limits.map((l) => l.criticality);
    expect(tiers.length).toBeGreaterThan(0);
    expect(tiers).toContain(TOP_TIER);
    expect(tiers).toContain(DEFAULT_SPEC_CRITICALITY);
  });
});

describe('registerSpecChecks', () => {
  it('freezes the tier alongside the numbers', async () => {
    const documentId = generateTestId();
    await db
      .prepare(
        `INSERT INTO documents (id, tenant_id, title, current_version, status, created_by)
         VALUES (?, ?, ?, 1, 'active', ?)`
      )
      .bind(documentId, seed.tenantId, 'Criticality COA', seed.orgAdminId)
      .run();

    const limit: ConfiguredLimit = {
      id: 'limit-frozen',
      spec_test_id: specTestId,
      operator: '<=',
      value_min: null,
      value_max: 10,
      unit: 'CFU/g',
      severity: 'alert',
      criticality: TOP_TIER,
      active: true,
      supplier_id: null,
      document_type_id: null,
      product_id: null,
    };
    const verdict: SpecVerdict = {
      scope: 'ai_fields',
      target: { kind: 'table', table_index: 0, row_index: 0, table_name: 'micro' },
      test_name_raw: 'Coliform',
      value_raw: '40',
      unit_raw: 'CFU/g',
      verdict: 'out_of_spec',
      source: 'limit',
      limit_text: '≤10 CFU/g',
      reason: '40 exceeds the 10 limit',
      message: 'Coliform is 40, outside our limit of ≤10 CFU/g.',
      limit_id: limit.id,
      spec_test_id: specTestId,
      criticality: TOP_TIER,
      value_num: 40,
    };

    await registerSpecChecks(db, { tenantId: seed.tenantId, documentId, versionNumber: 1 }, [verdict], [
      limit,
    ]);

    const row = await db
      .prepare('SELECT limit_snapshot FROM document_spec_checks WHERE document_id = ?')
      .bind(documentId)
      .first<{ limit_snapshot: string }>();
    expect(JSON.parse(row!.limit_snapshot)).toMatchObject({
      value_max: 10,
      criticality: TOP_TIER,
    });

    // Demote the limit. The recorded judgement keeps the tier it was filed
    // under, for the same reason it keeps the threshold it was judged against.
    await registerSpecChecks(
      db,
      { tenantId: seed.tenantId, documentId, versionNumber: 2 },
      [verdict],
      [{ ...limit, criticality: DEFAULT_SPEC_CRITICALITY }]
    );
    const original = await db
      .prepare(
        'SELECT limit_snapshot FROM document_spec_checks WHERE document_id = ? AND version_number = 1'
      )
      .bind(documentId)
      .first<{ limit_snapshot: string }>();
    expect(JSON.parse(original!.limit_snapshot).criticality).toBe(TOP_TIER);
  });

  it('records no tier for a verdict judged against the COA\'s own printed spec', async () => {
    const documentId = generateTestId();
    await db
      .prepare(
        `INSERT INTO documents (id, tenant_id, title, current_version, status, created_by)
         VALUES (?, ?, ?, 1, 'active', ?)`
      )
      .bind(documentId, seed.tenantId, 'Printed spec COA', seed.orgAdminId)
      .run();

    const printed: SpecVerdict = {
      scope: 'ai_fields',
      target: { kind: 'table', table_index: 0, row_index: 0, table_name: 'micro' },
      test_name_raw: 'Coliform',
      value_raw: '40',
      unit_raw: 'CFU/g',
      verdict: 'out_of_spec',
      source: 'printed',
      limit_text: '<10',
      reason: '40 exceeds the printed 10 limit',
      message: 'Coliform is 40, outside the limit printed on this COA (<10).',
      value_num: 40,
    };
    await registerSpecChecks(db, { tenantId: seed.tenantId, documentId }, [printed], []);

    const row = await db
      .prepare('SELECT limit_snapshot FROM document_spec_checks WHERE document_id = ?')
      .bind(documentId)
      .first<{ limit_snapshot: string }>();
    // We hold no limit behind it, so there is no rank to claim.
    expect(JSON.parse(row!.limit_snapshot)).toEqual({ printed: '<10' });
  });
});
