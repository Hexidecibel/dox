/**
 * bin/lib/specRegisterBackfill.js — the decision half of
 * `bin/backfill-spec-register`.
 *
 * The contract under test, in the order it matters:
 *
 *   1. NOBODY IS EMAILED. A bulk pass over 576 documents that finds 41 failures
 *      must not be able to mail anyone. That is asserted structurally — the
 *      script's own source is read and checked for any route to a send — and
 *      by the SQL, which can only ever touch one table plus one audit row.
 *   2. A ROW WRITTEN AT APPROVAL IS NEVER TOUCHED. It records a person looking
 *      at a result and going ahead; recomputing it under today's limits would
 *      destroy the only thing the register is for.
 *   3. THE SECOND RUN WRITES NOTHING. Idempotence is what makes it safe to
 *      re-run after an interrupted pass.
 *   4. A DATE IS NOT A MEASUREMENT. Values that parse as a clock time or a
 *      calendar date are refused on the way in and identified on the way out —
 *      and the identification NEVER deletes on its own.
 *   5. THE SNAPSHOT IS THE PRODUCER'S OWN. A backfilled row freezes its limit
 *      through the same function the approval path calls, criticality (0095)
 *      and unit equivalence (0093) included, so it stays as re-explainable as
 *      an approval-time one.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain CJS module, no types.
import mod from '../../bin/lib/specRegisterBackfill.js';
// @ts-expect-error — generated CJS bundle, no types.
import compiledSnapshot from '../../bin/lib/shared/specSnapshot.js';
import { buildLimitSnapshot } from '../../shared/specSnapshot';
import cliSource from '../../bin/backfill-spec-register?raw';
import libSource from '../../bin/lib/specRegisterBackfill.js?raw';
import type { SpecVerdict, ConfiguredLimit } from '../../shared/specCheck';

const {
  classifyArtifact,
  findArtifactRows,
  buildPlan,
  planToSql,
  auditSql,
  pruneToSql,
  indexExistingRows,
} = mod;

const RUN_AT = '2026-09-04T12:00:00.000Z';

const LIMIT: ConfiguredLimit = {
  id: 'limit-coliform',
  spec_test_id: 'st-coliform',
  operator: '<=',
  value_min: null,
  value_max: 10,
  unit: 'CFU/g',
  severity: 'alert',
  criticality: 'high',
  active: true,
  supplier_id: null,
  document_type_id: null,
  product_id: null,
};

function verdict(over: Partial<SpecVerdict> = {}): SpecVerdict {
  return {
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
    limit_id: LIMIT.id,
    spec_test_id: LIMIT.spec_test_id,
    value_num: 40,
    ...over,
  } as SpecVerdict;
}

let seq = 0;
function plan(over: Record<string, unknown> = {}) {
  seq = 0;
  return buildPlan({
    tenantId: 'tenant_x',
    runAt: RUN_AT,
    judged: [],
    existingRows: [],
    limits: [LIMIT],
    buildLimitSnapshot,
    newId: () => `row_${++seq}`,
    ...over,
  });
}

const DOC = { id: 'doc_1', title: 'Andersen COA', current_version: 1 };

// ---------------------------------------------------------------------------

describe('no alert can fire', () => {
  it('the script imports nothing that can send', () => {
    // The register and the notification are separate functions in
    // functions/lib/spec-register.ts on purpose. This is the assertion that a
    // future edit cannot quietly reach across that line: a bulk run that mailed
    // 41 out-of-spec findings to real recipients is the one unrecoverable
    // failure of this tool.
    for (const [name, src] of [
      ['bin/backfill-spec-register', cliSource],
      ['bin/lib/specRegisterBackfill.js', libSource],
    ] as const) {
      const code = src
        // Strip block and line comments — the header talks ABOUT email at
        // length, and it should be able to.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${name} must not require anything that sends`).not.toMatch(
        /require\([^)]*(email|alert-links|alert-routing|spec-register|resend)/i
      );
      expect(code, `${name} must not call a send`).not.toMatch(
        /\b(sendEmail|notifySpecFailures|mintAlertLink|resolveAlertRecipients|buildSpecAlertEmail)\s*\(/
      );
      expect(code, `${name} must not reach for an API key`).not.toMatch(/RESEND_API_KEY/);
    }
  });

  it('every statement it can emit touches one table, plus one audit row', () => {
    const p = plan({ judged: [{ document: DOC, verdicts: [verdict(), verdict({ verdict: 'in_spec', value_raw: '4', value_num: 4 })] }] });
    const statements = [...planToSql(p), auditSql(p)];
    expect(statements.length).toBe(3);
    for (const s of statements) {
      expect(s).toMatch(/^INSERT INTO (document_spec_checks|audit_log)\b/);
    }
    // Not one UPDATE, anywhere. `notified_at` in particular is never written:
    // nobody was told, and the register must not claim otherwise.
    expect(statements.join('\n')).not.toMatch(/\bUPDATE\b|\bDELETE\b|notified_at|acknowledged_by/);
  });

  it('the audit row names no human actor', () => {
    const p = plan({ judged: [{ document: DOC, verdicts: [verdict()] }] });
    // NULL user_id: no person did this. An audit trail that named one would be
    // the same falsehood migration 0103 exists to prevent.
    expect(auditSql(p)).toMatch(/VALUES \(NULL, /);
    expect(auditSql(p)).toContain('spec_register.backfill');
  });
});

describe('a row written at approval is never touched', () => {
  const approvalRow = {
    id: 'chk_1',
    document_id: 'doc_1',
    test_name_raw: 'Coliform',
    value_raw: '34',
    verdict: 'out_of_spec',
    judgement_origin: 'approval',
    bulk_run_at: null,
  };

  it('skips the whole document and says why', () => {
    const p = plan({
      judged: [{ document: DOC, verdicts: [verdict()] }],
      existingRows: [approvalRow],
    });
    expect(p.rows).toHaveLength(0);
    expect(p.counts.skipped_has_approval_rows).toBe(1);
    expect(p.skipped[0].reason).toBe('has_approval_rows');
    expect(planToSql(p)).toHaveLength(0);
  });

  it('treats a row with no recorded origin as an approval row', () => {
    // Pre-0103 rows carry NULL. The migration stamps them 'approval' because
    // that is provably what they are, but a NULL that survives — a row written
    // by something that did not say — must still be protected, not overwritten
    // on the assumption that it was a previous pass of this script.
    const p = plan({
      judged: [{ document: DOC, verdicts: [verdict()] }],
      existingRows: [{ ...approvalRow, judgement_origin: null }],
    });
    expect(p.counts.skipped_has_approval_rows).toBe(1);
    expect(p.rows).toHaveLength(0);
  });

  it('reports a document a previous pass wrote separately', () => {
    const p = plan({
      judged: [{ document: DOC, verdicts: [verdict()] }],
      existingRows: [{ ...approvalRow, judgement_origin: 'bulk_recheck', bulk_run_at: RUN_AT }],
    });
    expect(p.counts.skipped_already_backfilled).toBe(1);
    expect(p.counts.skipped_has_approval_rows).toBe(0);
    expect(p.rows).toHaveLength(0);
  });
});

describe('idempotence', () => {
  it('a second pass over its own output writes nothing', () => {
    const first = plan({ judged: [{ document: DOC, verdicts: [verdict(), verdict({ verdict: 'in_spec' })] }] });
    expect(first.rows).toHaveLength(2);

    // Feed the rows it just wrote back in, exactly as the script re-reads them.
    const second = plan({
      judged: [{ document: DOC, verdicts: [verdict(), verdict({ verdict: 'in_spec' })] }],
      existingRows: first.rows,
    });
    expect(second.rows).toHaveLength(0);
    expect(planToSql(second)).toHaveLength(0);
  });

  it('indexes existing rows by document, keeping every origin it saw', () => {
    const idx = indexExistingRows([
      { document_id: 'a', judgement_origin: 'approval' },
      { document_id: 'a', judgement_origin: 'bulk_recheck', bulk_run_at: RUN_AT },
      { document_id: 'b', judgement_origin: 'bulk_recheck', bulk_run_at: RUN_AT },
    ]);
    expect(idx.get('a').count).toBe(2);
    expect([...idx.get('a').origins].sort()).toEqual(['approval', 'bulk_recheck']);
    expect([...idx.get('b').runs]).toEqual([RUN_AT]);
  });
});

describe('a date is not a measurement', () => {
  it('recognises the values the incubation-log misread produces', () => {
    for (const value of ['12:08 PM', '9:32 AM', '13:45', '00:30', '08:15:00', '8/14/2026', '2026-08-19', '04/12/\'27', '12-Aug-2026', 'Aug 12, 2026']) {
      const a = classifyArtifact({ test_name_raw: 'Coliform', value_raw: value });
      expect(a, `${value} should be flagged`).toBeTruthy();
      expect(a.confidence, `${value} should be confident`).toBe('confident');
    }
  });

  it('leaves real results alone', () => {
    for (const value of ['34', '1,200', '<1', '2×10³', '0.6', '6.62', '40.12', '<10 CFU/g', 'ND', 'Negative', '10^3', '25,000']) {
      expect(classifyArtifact({ test_name_raw: 'Coliform', value_raw: value }), `${value} must not be flagged`).toBeNull();
    }
  });

  it('calls a bare 1:10 ambiguous rather than confident — a dilution reads the same', () => {
    const a = classifyArtifact({ test_name_raw: 'Coliform', value_raw: '1:10' });
    expect(a.confidence).toBe('ambiguous');
    // And an ambiguous row is NEVER rendered into a DELETE. A register is not a
    // place to delete on a maybe.
    expect(pruneToSql([{ ...a, id: 'chk_amb' }])).toHaveLength(0);
  });

  it('flags a column header that names a moment, but only ambiguously', () => {
    const a = classifyArtifact({ test_name_raw: 'Date In', value_raw: 'Petrifilm' });
    expect(a.kind).toBe('date_time_column');
    expect(a.confidence).toBe('ambiguous');
  });

  it('refuses to WRITE a verdict about a clock time, and reports it', () => {
    const p = plan({
      judged: [
        {
          document: DOC,
          verdicts: [
            verdict({ value_raw: '12:08 PM', verdict: 'not_checked', reason: 'result is in PM but the limit is in CFU/g' }),
            verdict(),
          ],
        },
      ],
    });
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0].value_raw).toBe('40');
    expect(p.counts.refused_artifact_values).toBe(1);
    expect(p.refused[0].why).toContain('clock time');
  });

  it('identifies existing artifact rows without proposing anything', () => {
    const rows = [
      { id: 'chk_1', document_id: 'd', test_name_raw: 'Coliform', value_raw: '12:08 PM', verdict: 'not_checked', judgement_origin: 'approval' },
      { id: 'chk_2', document_id: 'd', test_name_raw: 'Coliform', value_raw: '34', verdict: 'out_of_spec', judgement_origin: 'approval' },
      { id: 'chk_3', document_id: 'd', test_name_raw: 'Coliform', value_raw: '1:10', verdict: 'not_checked', judgement_origin: 'approval' },
    ];
    const found = findArtifactRows(rows);
    expect(found.map((f: { id: string }) => f.id)).toEqual(['chk_1', 'chk_3']);

    // A plain plan proposes no deletion at all — the identification is a report.
    const p = plan({ judged: [{ document: { ...DOC, id: 'd' }, verdicts: [verdict()] }], existingRows: rows });
    expect(planToSql(p).join('\n')).not.toMatch(/DELETE/);

    // Only the explicit prune renders one, and only for the confident row.
    const sql = pruneToSql(found).join('\n');
    expect(sql).toMatch(/^DELETE FROM document_spec_checks WHERE id IN \('chk_1'\);$/);
  });
});

describe('the row it writes', () => {
  it('stamps its own provenance and claims no acknowledgement', () => {
    const p = plan({ judged: [{ document: { ...DOC, current_version: 3 }, verdicts: [verdict()] }] });
    const row = p.rows[0];
    expect(row.judgement_origin).toBe('bulk_recheck');
    expect(row.bulk_run_at).toBe(RUN_AT);
    expect(row.queue_item_id).toBeNull();
    // The version the metadata belongs to — not the 1 the approval path writes,
    // which is true only because approval happens at version 1.
    expect(row.version_number).toBe(3);
    expect(Object.keys(row)).not.toContain('acknowledged_by');
    expect(Object.keys(row)).not.toContain('notified_at');
  });

  it('freezes the limit through the producer\'s own function', () => {
    const p = plan({ judged: [{ document: DOC, verdicts: [verdict()] }] });
    const snap = JSON.parse(p.rows[0].limit_snapshot);
    expect(snap).toEqual({
      operator: '<=',
      value_min: null,
      value_max: 10,
      unit: 'CFU/g',
      severity: 'alert',
      criticality: 'high',
      text: '≤10 CFU/g',
    });
  });

  it('carries the unit-equivalence declaration when one was applied', () => {
    const p = plan({
      judged: [{ document: DOC, verdicts: [verdict({ unit_equivalence_applied: true, unit_raw: 'CFU/mL' })] }],
    });
    expect(JSON.parse(p.rows[0].limit_snapshot).unit_equivalence).toBe('volume_mass');
  });

  it('the bundle bin/ loads and the source the Worker loads agree, byte for byte', () => {
    // The whole reason shared/specSnapshot.ts exists. If these two ever differ,
    // a backfilled row and an approval-written row stop meaning the same thing.
    const cases: SpecVerdict[] = [
      verdict(),
      verdict({ unit_equivalence_applied: true }),
      verdict({ source: 'printed', limit_id: null, limit_text: '<100 CFU/g' }),
      verdict({ source: 'printed', limit_id: null, limit_text: undefined }),
      verdict({ limit_id: 'a-limit-that-was-deleted' }),
    ];
    for (const v of cases) {
      expect(compiledSnapshot.buildLimitSnapshot(v, [LIMIT])).toBe(buildLimitSnapshot(v, [LIMIT]));
    }
  });

  it('counts a document with nothing to judge instead of dropping it', () => {
    const p = plan({ judged: [{ document: DOC, verdicts: [] }] });
    expect(p.counts.skipped_no_verdicts).toBe(1);
    expect(p.skipped[0].reason).toBe('no_verdicts');
  });

  it('reports a document whose every value was refused', () => {
    const p = plan({
      judged: [{ document: DOC, verdicts: [verdict({ value_raw: '12:08 PM', verdict: 'not_checked' })] }],
    });
    expect(p.rows).toHaveLength(0);
    expect(p.skipped[0].reason).toBe('all_values_refused');
    expect(p.counts.documents_written).toBe(0);
  });
});
