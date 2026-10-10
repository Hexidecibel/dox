/**
 * The renewal setting a SEEDED document type starts life with.
 *
 * THE DEFECT THESE PIN. The starter pack — which is how a real tenant actually
 * receives its 27 document types — wrote `INSERT OR IGNORE INTO document_types
 * (id, tenant_id, name, slug, description, default_owner)` and named neither
 * renewal column, so every row it created took the migration defaults,
 * `renewal_policy = 'inherit'` and `renewal_interval_months = NULL`, which the
 * resolver reads as "renews annually". `POST /api/document-types` had always
 * proposed a setting from the type's name, and the 0096/0097 backfills ran once
 * at migration time over the rows that existed then. A tenant seeded afterwards
 * therefore got a Certificate of Analysis on an annual cadence — the exact
 * "mail every COA owner about a certificate that does not renew" failure the
 * renewal design exists to prevent — and a Specification Sheet at one year
 * rather than the scheme-defined three. Measured on production: AJ Clean, the
 * one tenant created by the pack after the backfills, had all 27 types at
 * 'inherit'.
 *
 * All three insert paths now call `defaultRenewalSettingForTypeName`, so these
 * tests compare against THAT function rather than against literals: a change to
 * the rule moves the API, the CLI compiler and the in-portal applier together,
 * or it fails here.
 */

import { describe, it, expect } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { normalizePack, packToStatements } from '../../bin/lib/starter-packs.mjs';
import { starterPackStatements } from '../../functions/lib/starter-packs';
import { STARTER_PACKS } from '../../functions/lib/starterPacks.generated';
import { MODULE_KEYS } from '../../shared/modules';
import { defaultRenewalSettingForTypeName } from '../../shared/renewalPeriod';
import { defaultSharingRuleForTypeName } from '../../shared/sharingRule';
import fsqaRaw from '../../starter-packs/fsqa.json?raw';
import financeRaw from '../../starter-packs/finance.json?raw';

const fsqa = JSON.parse(fsqaRaw) as unknown;
const finance = JSON.parse(financeRaw) as unknown;
const PACKS: Array<[string, unknown]> = [
  ['fsqa', fsqa],
  ['finance', finance],
];
const TENANT = { tenantId: 'tenant_x', tenantSlug: 'acme-foods' };

interface NormalizedType {
  name: string;
  slug: string;
}

/** Enough of a D1 to capture what the in-portal applier would bind. */
function recordingDb(): { db: unknown; calls: Array<{ sql: string; args: unknown[] }> } {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          const call = { sql, args };
          calls.push(call);
          return call;
        },
      };
    },
  };
  return { db, calls };
}

describe('starter packs — every seeded document type carries a renewal setting', () => {
  it('the CLI compiler emits what the API create path would set, for every type', () => {
    for (const [packName, pack] of PACKS) {
      const normalized = normalizePack(pack, { moduleKeys: MODULE_KEYS }) as {
        document_types: NormalizedType[];
      };
      const statements: string[] = packToStatements(pack, TENANT).filter((s: string) =>
        s.startsWith('INSERT OR IGNORE INTO document_types '),
      );
      expect(statements.length, packName).toBe(normalized.document_types.length);

      for (const dt of normalized.document_types) {
        const want = defaultRenewalSettingForTypeName(dt.name);
        const sql = statements.find((s) => s.includes(`'dt_acme-foods_${dt.slug}'`));
        expect(sql, `${packName}/${dt.slug}`).toBeTruthy();
        // The renewal pair, then the window (0125), then the sharing rule
        // (0137) are the last values in the row -- followed, since migration
        // 0141, by the apply guard (`WHERE NOT EXISTS ... pack_applied_items`).
        // The sharing rule comes from its own name match, for the same reason
        // and under the same contract.
        const months = want.interval_months === null ? 'NULL' : String(want.interval_months);
        const window = want.window === null ? 'NULL' : `'${JSON.stringify(want.window).replace(/'/g, "''")}'`;
        const rule = defaultSharingRuleForTypeName(dt.name);
        expect(
          sql!.includes(`'${want.policy}', ${months}, ${window}, '${rule}' WHERE NOT EXISTS (SELECT 1 FROM pack_applied_items `),
          `${packName}/${dt.slug}`,
        ).toBe(true);
      }
    }
  });

  it('the in-portal applier binds the same pair', () => {
    for (const name of Object.keys(STARTER_PACKS)) {
      const { db, calls } = recordingDb();
      starterPackStatements(
        db as unknown as D1Database,
        STARTER_PACKS[name],
        'tenant-1',
        'acme-foods',
      );
      const typeCalls = calls.filter((c) => c.sql.includes('INTO document_types'));
      expect(typeCalls.length, name).toBe(STARTER_PACKS[name].document_types.length);
      for (const c of typeCalls) {
        // The id is an expression with four parameters of its own (the id,
        // the tenant, the fallback id, the id: see `idExpr` in
        // shared/packItems.ts), so the row's values start at index 4:
        // (tenant_id, name, slug, description, default_owner, policy, months, window, sharing_rule)
        const typeName = c.args[5] as string;
        expect(STARTER_PACKS[name].document_types.map((d) => d.name), name).toContain(typeName);
        const want = defaultRenewalSettingForTypeName(typeName);
        expect(c.args[9], `${name}/${typeName} policy`).toBe(want.policy);
        expect(c.args[10], `${name}/${typeName} months`).toBe(want.interval_months);
        expect(c.args[11], `${name}/${typeName} window`).toBe(want.window === null ? null : JSON.stringify(want.window));
        expect(c.args[12], `${name}/${typeName} sharing rule`).toBe(defaultSharingRuleForTypeName(typeName));
      }
    }
  });

  it('a shipped pack exercises all three answers, not just the default', () => {
    // A guard on the guard: if every type resolved to 'inherit' the two tests
    // above would pass while proving nothing.
    const names = (
      normalizePack(fsqa, { moduleKeys: MODULE_KEYS }) as { document_types: NormalizedType[] }
    ).document_types.map((d) => d.name);
    const settings = names.map((n) => defaultRenewalSettingForTypeName(n));
    expect(settings.filter((s) => s.policy === 'none').length).toBeGreaterThan(0);
    expect(
      settings.filter((s) => s.policy === 'period' && s.interval_months === 36).length,
    ).toBeGreaterThan(0);
    expect(settings.filter((s) => s.policy === 'inherit').length).toBeGreaterThan(0);
    // G3: the FDA food facility registration type carries its window.
    expect(settings.filter((s) => s.window !== null).length).toBeGreaterThan(0);
  });

  it('names the two answers that matter, so a rule change has to be deliberate', () => {
    expect(defaultRenewalSettingForTypeName('Certificate of Analysis')).toEqual({
      policy: 'none',
      interval_months: null,
      window: null,
    });
    expect(defaultRenewalSettingForTypeName('Specification Sheet')).toEqual({
      policy: 'period',
      interval_months: 36,
      window: null,
    });
    // A certificate of INSURANCE renews. The COA match requires the analysis
    // word precisely so this cannot be swept up: a false 'none' here is a
    // policy that lapses and never appears on the dashboard.
    expect(defaultRenewalSettingForTypeName('Certificate of Insurance')).toEqual({
      policy: 'inherit',
      interval_months: null,
      window: null,
    });
  });

  it('never stores months under a policy that does not read them', () => {
    // The invariant parseTypeRenewalSetting enforces at the API edge: a
    // non-NULL interval exists only under 'period'.
    for (const [, pack] of PACKS) {
      const normalized = normalizePack(pack, { moduleKeys: MODULE_KEYS }) as {
        document_types: NormalizedType[];
      };
      for (const dt of normalized.document_types) {
        const s = defaultRenewalSettingForTypeName(dt.name);
        if (s.policy !== 'period') expect(s.interval_months).toBeNull();
        else expect(s.interval_months).toBeGreaterThan(0);
      }
    }
  });
});
