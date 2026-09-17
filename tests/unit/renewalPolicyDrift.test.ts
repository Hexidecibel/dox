/**
 * The decision half of `bin/fix-starter-pack-renewal-policy`
 * (bin/lib/renewalPolicyDrift.js).
 *
 * Two properties matter and both are failures of the expensive kind if they
 * break:
 *
 *   1. It finds the starter pack's exact signature — a row still holding BOTH
 *      migration defaults ('inherit' + NULL) whose name derives something else.
 *      Missing one leaves a COA renewing annually and mailing its owner.
 *   2. It touches NOTHING else. A script that re-decides a setting an admin
 *      chose is worse than the drift it repairs, and `document_types` carries
 *      no per-column stamp to appeal to — only the stored value and the audit
 *      log.
 */

import { describe, it, expect } from 'vitest';
import {
  planRenewalPolicyDrift,
  correctionToSql,
  auditNamesRenewal,
  atMigrationDefaults,
  storedSetting,
} from '../../bin/lib/renewalPolicyDrift.js';

interface TypeRow {
  id: string;
  name: string;
  renewal_policy: string | null;
  renewal_interval_months: number | null;
  human_decided?: boolean;
}

interface Correction {
  id: string;
  name: string;
  from: { policy: string; interval_months: number | null };
  to: { policy: string; interval_months: number | null };
}

interface Skip extends Correction {
  reason: string;
}

interface Plan {
  total: number;
  agree: number;
  corrections: Correction[];
  skipped: Skip[];
}

/** A tenant as the starter pack leaves it: every row at the migration defaults. */
const AS_SEEDED: TypeRow[] = [
  { id: 'dt_coa', name: 'Certificate of Analysis', renewal_policy: 'inherit', renewal_interval_months: null },
  { id: 'dt_spec', name: 'Specification Sheet', renewal_policy: 'inherit', renewal_interval_months: null },
  { id: 'dt_coi', name: 'Certificate of Insurance', renewal_policy: 'inherit', renewal_interval_months: null },
  { id: 'dt_w9', name: 'W-9', renewal_policy: 'inherit', renewal_interval_months: null },
];

function plan(rows: TypeRow[]): Plan {
  return planRenewalPolicyDrift(rows) as Plan;
}

const sqlStr = (v: string | null): string =>
  v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;

describe('planRenewalPolicyDrift — what a starter-pack tenant needs', () => {
  it('corrects exactly the COA and the spec sheet, and nothing else', () => {
    const p = plan(AS_SEEDED);
    expect(p.total).toBe(4);
    expect(p.corrections.map((c) => c.id).sort()).toEqual(['dt_coa', 'dt_spec']);
    expect(p.skipped).toEqual([]);
    // The two rows whose names imply the default are already right, and are
    // reported as agreeing rather than as work.
    expect(p.agree).toBe(2);

    const coa = p.corrections.find((c) => c.id === 'dt_coa')!;
    expect(coa.from).toEqual({ policy: 'inherit', interval_months: null });
    expect(coa.to).toEqual({ policy: 'none', interval_months: null });

    const spec = p.corrections.find((c) => c.id === 'dt_spec')!;
    expect(spec.to).toEqual({ policy: 'period', interval_months: 36 });
  });

  it('is idempotent — re-planning after the corrections finds nothing', () => {
    const first = plan(AS_SEEDED);
    const applied: TypeRow[] = AS_SEEDED.map((row) => {
      const c = first.corrections.find((x) => x.id === row.id);
      return c
        ? { ...row, renewal_policy: c.to.policy, renewal_interval_months: c.to.interval_months }
        : row;
    });
    const second = plan(applied);
    expect(second.corrections).toEqual([]);
    expect(second.skipped).toEqual([]);
    expect(second.agree).toBe(4);
  });

  it('never re-decides a row that already carries a setting', () => {
    // A COA an admin deliberately put on a cadence, and a spec sheet somebody
    // set to two years. Both disagree with the name; both are left alone.
    const p = plan([
      { id: 'dt_coa', name: 'Certificate of Analysis', renewal_policy: 'period', renewal_interval_months: 12 },
      { id: 'dt_spec', name: 'Specification Sheet', renewal_policy: 'period', renewal_interval_months: 24 },
    ]);
    expect(p.corrections).toEqual([]);
    expect(p.skipped.map((s) => s.reason)).toEqual(['configured', 'configured']);
  });

  it('leaves a row a person is recorded as having decided, even at the defaults', () => {
    const p = plan([
      { ...AS_SEEDED[0], human_decided: true },
      AS_SEEDED[1],
    ]);
    expect(p.corrections.map((c) => c.id)).toEqual(['dt_spec']);
    expect(p.skipped).toHaveLength(1);
    expect(p.skipped[0].id).toBe('dt_coa');
    expect(p.skipped[0].reason).toBe('human_decided');
  });

  it('reads a NULL policy (a pre-0097 row) as the migration default', () => {
    const p = plan([
      { id: 'dt_coa', name: 'COA', renewal_policy: null, renewal_interval_months: null },
    ]);
    expect(p.corrections).toHaveLength(1);
    expect(p.corrections[0].to.policy).toBe('none');
  });

  it('a tenant with nothing drifted plans no work', () => {
    expect(plan([]).corrections).toEqual([]);
    expect(plan([AS_SEEDED[3]]).corrections).toEqual([]);
  });
});

describe('correctionToSql — the write is its own guard', () => {
  it('restates the migration defaults in the WHERE, so a stale plan writes nothing', () => {
    const p = plan(AS_SEEDED);
    const sql = correctionToSql('tenant_x', p.corrections[0], sqlStr);
    expect(sql).toContain("renewal_policy = 'none'");
    expect(sql).toContain('renewal_interval_months = NULL');
    expect(sql).toContain("WHERE id = 'dt_coa' AND tenant_id = 'tenant_x'");
    expect(sql).toContain("AND renewal_policy = 'inherit' AND renewal_interval_months IS NULL");
  });

  it('writes the months for a spec sheet', () => {
    const p = plan(AS_SEEDED);
    const sql = correctionToSql('tenant_x', p.corrections.find((c) => c.id === 'dt_spec')!, sqlStr);
    expect(sql).toContain('renewal_interval_months = 36');
  });
});

describe('auditNamesRenewal — what counts as a person having decided', () => {
  it('reads a document_type_updated payload', () => {
    expect(auditNamesRenewal(JSON.stringify({ changes: { renewal_policy: 'inherit' } }))).toBe(true);
    expect(auditNamesRenewal(JSON.stringify({ changes: { renewal_interval_months: 24 } }))).toBe(true);
    expect(auditNamesRenewal(JSON.stringify({ changes: { name: 'Renamed' } }))).toBe(false);
  });

  it('reads a document_type_created payload', () => {
    expect(auditNamesRenewal(JSON.stringify({ name: 'X', renewal_policy: 'inherit' }))).toBe(true);
    expect(auditNamesRenewal(JSON.stringify({ name: 'X', slug: 'x' }))).toBe(false);
  });

  it('is not fooled by an unreadable blob — that is not evidence', () => {
    expect(auditNamesRenewal('not json')).toBe(false);
    expect(auditNamesRenewal(null)).toBe(false);
    expect(auditNamesRenewal('"renewal_policy"')).toBe(false);
  });
});

describe('the signature itself', () => {
  it('only inherit + NULL is the migration default', () => {
    expect(atMigrationDefaults(storedSetting({ renewal_policy: 'inherit', renewal_interval_months: null }))).toBe(true);
    expect(atMigrationDefaults(storedSetting({ renewal_policy: null, renewal_interval_months: null }))).toBe(true);
    expect(atMigrationDefaults(storedSetting({ renewal_policy: 'none', renewal_interval_months: null }))).toBe(false);
    expect(atMigrationDefaults(storedSetting({ renewal_policy: 'inherit', renewal_interval_months: 12 }))).toBe(false);
  });
});
