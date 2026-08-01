/**
 * Starter-pack SEEDING tests — the SQL that `bin/create-tenant --pack <name>`
 * generates, executed against a real (test) D1 with the 0080 schema in place.
 *
 * The unit tests cover the compiler in isolation; this file covers the claim
 * the script actually makes: that provisioning a tenant is idempotent, lands
 * in every facet table, and never clobbers an admin's later edits.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData } from '../helpers/db';
import { packToStatements, packSummary } from '../../bin/lib/starter-packs.mjs';
import fsqaRaw from '../../starter-packs/fsqa.json?raw';
import financeRaw from '../../starter-packs/finance.json?raw';
import { requirementsOpenedByClaims } from '../../functions/lib/registry';

const db = env.DB;
const fsqa = JSON.parse(fsqaRaw);
const finance = JSON.parse(financeRaw);

const FSQA_TENANT = { id: 'tenant_pack_fsqa', slug: 'packfsqa' };
const FIN_TENANT = { id: 'tenant_pack_finance', slug: 'packfin' };

async function applyPack(pack: unknown, tenant: { id: string; slug: string }) {
  const statements = packToStatements(pack, { tenantId: tenant.id, tenantSlug: tenant.slug });
  for (const sql of statements) await db.prepare(sql).run();
  return statements.length;
}

async function counts(tenantId: string) {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM document_types WHERE tenant_id = ?1) AS document_types,
              (SELECT COUNT(*) FROM requirements   WHERE tenant_id = ?1) AS requirements,
              (SELECT COUNT(*) FROM claim_types    WHERE tenant_id = ?1) AS claim_types,
              (SELECT COUNT(*) FROM claim_type_requirements WHERE tenant_id = ?1) AS claim_rules`,
    )
    .bind(tenantId)
    .first<Record<string, number>>();
  return row!;
}

beforeAll(async () => {
  await seedTestData(db);
  for (const t of [FSQA_TENANT, FIN_TENANT]) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO tenants (id, name, slug, active) VALUES (?, ?, ?, 1)`,
      )
      .bind(t.id, t.slug, t.slug)
      .run();
  }
}, 30_000);

describe('starter pack seeding — fsqa', () => {
  it('populates every facet table', async () => {
    await applyPack(fsqa, FSQA_TENANT);
    const summary = packSummary(fsqa);
    expect(await counts(FSQA_TENANT.id)).toEqual({
      document_types: summary.document_types,
      requirements: summary.requirements,
      claim_types: summary.claim_types,
      claim_rules: summary.claim_rules,
    });
  });

  it('is idempotent — re-provisioning adds nothing', async () => {
    const before = await counts(FSQA_TENANT.id);
    await applyPack(fsqa, FSQA_TENANT);
    await applyPack(fsqa, FSQA_TENANT);
    expect(await counts(FSQA_TENANT.id)).toEqual(before);
  });

  it('preserves admin edits to a seeded row on re-provisioning', async () => {
    await db
      .prepare('UPDATE requirements SET name = ? WHERE id = ?')
      .bind('Renamed By The QA Manager', `req_${FSQA_TENANT.slug}_spec-sheet`)
      .run();
    await applyPack(fsqa, FSQA_TENANT);
    const row = await db
      .prepare('SELECT name FROM requirements WHERE id = ?')
      .bind(`req_${FSQA_TENANT.slug}_spec-sheet`)
      .first<any>();
    expect(row!.name).toBe('Renamed By The QA Manager');
  });

  it('seeds the audit REPORT and the audit CERTIFICATE as two distinct document types', async () => {
    const rows = await db
      .prepare(
        `SELECT slug, name FROM document_types
          WHERE tenant_id = ? AND slug IN ('3rd-party-food-safety-audit-report','3rd-party-audit-certificate')
          ORDER BY slug`,
      )
      .bind(FSQA_TENANT.id)
      .all<any>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results[0].slug).not.toBe(rows.results[1].slug);
  });

  it('a GFSI claim opens both audit requirements through the shared lib', async () => {
    const opened = await requirementsOpenedByClaims(db, FSQA_TENANT.id, [
      `clm_${FSQA_TENANT.slug}_gfsi-certified`,
    ]);
    expect(opened).toContain(`req_${FSQA_TENANT.slug}_third-party-audit-report`);
    expect(opened).toContain(`req_${FSQA_TENANT.slug}_third-party-audit-certificate`);
  });

  it('seeded advisory rules are excluded from required-only gap reads', async () => {
    const required = await requirementsOpenedByClaims(db, FSQA_TENANT.id, [
      `clm_${FSQA_TENANT.slug}_rbst-free`,
    ]);
    expect(required).toEqual([]);
    const all = await requirementsOpenedByClaims(
      db,
      FSQA_TENANT.id,
      [`clm_${FSQA_TENANT.slug}_rbst-free`],
      false,
    );
    expect(all).toContain(`req_${FSQA_TENANT.slug}_letter-of-guarantee`);
  });
});

describe('starter pack seeding — finance', () => {
  it('provisions a non-food tenant from the same machinery', async () => {
    await applyPack(finance, FIN_TENANT);
    const summary = packSummary(finance);
    expect(await counts(FIN_TENANT.id)).toEqual({
      document_types: summary.document_types,
      requirements: summary.requirements,
      claim_types: summary.claim_types,
      claim_rules: summary.claim_rules,
    });
  });

  it('keeps the two tenant vocabularies fully separate', async () => {
    const crossover = await db
      .prepare(
        `SELECT COUNT(*) c FROM requirements
          WHERE tenant_id = ? AND slug IN (SELECT slug FROM requirements WHERE tenant_id = ?)`,
      )
      .bind(FIN_TENANT.id, FSQA_TENANT.id)
      .first<any>();
    expect(crossover!.c).toBe(0);

    // A finance claim resolves to nothing when queried under the food tenant.
    const opened = await requirementsOpenedByClaims(db, FSQA_TENANT.id, [
      `clm_${FIN_TENANT.slug}_externally-audited`,
    ]);
    expect(opened).toEqual([]);
  });

  it('carries no food vocabulary at all', async () => {
    const row = await db
      .prepare(
        `SELECT COUNT(*) c FROM document_types
          WHERE tenant_id = ? AND (slug LIKE '%organic%' OR slug LIKE '%kosher%' OR slug LIKE '%haccp%')`,
      )
      .bind(FIN_TENANT.id)
      .first<any>();
    expect(row!.c).toBe(0);
  });
});
