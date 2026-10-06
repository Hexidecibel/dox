/**
 * bin/lib/retainSplitOriginals.js -- the report and the plan behind
 * `bin/retain-split-originals`.
 *
 *   1. "Kept" is decided from the record: a reclaim date still on the item, one
 *      this script cleared, or an approval on/after retention began. An
 *      approval from before originals were kept is NOT counted as kept.
 *   2. A split document whose queue item cannot be named -- or belongs to
 *      another organization -- is counted as untraceable, never as kept.
 *   3. --apply clears only APPROVED split sources that still carry a date, and
 *      leaves an audit row naming each with the date it carried.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain CJS module, no types.
import mod from '../../bin/lib/retainSplitOriginals.js';

const { buildReport, applySql, queueIdFromExternalRef, CLEARED_ACTION } = mod;

function data(over: Record<string, unknown> = {}) {
  const docs = [
    { id: 'd1', tenant_id: 't1' },
    { id: 'd2', tenant_id: 't1' },
    { id: 'd3', tenant_id: 't1' },
    { id: 'd4', tenant_id: 't1' },
    { id: 'd5', tenant_id: 't1' },
    { id: 'd6', tenant_id: 't1' },
  ];
  return {
    docs,
    sourceOf: new Map<string, string | null>([
      ['d1', 'qStamped'],
      ['d2', 'qStamped'],
      ['d3', 'qOld'],
      ['d4', 'qCleared'],
      ['d5', null],
      ['d6', 'qForeign'],
    ]),
    queue: new Map<string, Record<string, unknown>>([
      ['qStamped', { id: 'qStamped', tenant_id: 't1', status: 'approved', file_name: 'a.pdf', file_size: 1048576, reviewed_at: '2026-09-10 10:00:00', file_retain_until: '2026-12-09 10:00:00' }],
      ['qOld', { id: 'qOld', tenant_id: 't1', status: 'approved', file_name: 'b.pdf', file_size: 500, reviewed_at: '2026-06-01 10:00:00', file_retain_until: null }],
      ['qCleared', { id: 'qCleared', tenant_id: 't1', status: 'approved', file_name: 'c.pdf', file_size: 500, reviewed_at: '2026-08-20 10:00:00', file_retain_until: null }],
      ['qForeign', { id: 'qForeign', tenant_id: 't2', status: 'approved', file_name: 'x.pdf', file_size: 500, reviewed_at: '2026-09-10 10:00:00', file_retain_until: '2026-12-09 10:00:00' }],
    ]),
    cleared: new Set(['qCleared']),
    retentionSince: '2026-08-20 10:00:00',
    tenantName: new Map([['t1', 'Cush Co']]),
    ...over,
  };
}

describe('buildReport', () => {
  it('counts what is kept from the record, and never an approval that predates retention', () => {
    const [row] = buildReport(data());
    expect(row.tenant_name).toBe('Cush Co');
    expect(row.split_documents).toBe(6);
    // d1+d2 share one source; d3 and d4 have their own.
    expect(row.source_certificates).toBe(3);
    // qStamped (still dated) + qCleared (audit row) are kept; qOld is not.
    expect(row.original_kept).toBe(2);
    expect(row.original_not_kept).toBe(1);
    // No queue item, and another organization's queue item.
    expect(row.no_traceable_source).toBe(2);
    expect(row.carrying_reclaim_date).toBe(1);
    expect(row.soonest_reclaim_date).toBe('2026-12-09 10:00:00');
    expect(row.to_clear.map((q: { id: string }) => q.id)).toEqual(['qStamped']);
  });

  it('with no stamp ever written, nothing is called kept', () => {
    const d = data({ retentionSince: null, cleared: new Set() });
    (d.queue.get('qStamped') as Record<string, unknown>).file_retain_until = null;
    const [row] = buildReport(d);
    expect(row.original_kept).toBe(0);
    expect(row.original_not_kept).toBe(3);
    expect(row.to_clear).toEqual([]);
  });

  it('a source still in review is counted apart, not as kept or lost', () => {
    const d = data();
    (d.queue.get('qOld') as Record<string, unknown>).status = 'pending';
    const [row] = buildReport(d);
    expect(row.still_in_review).toBe(1);
    expect(row.original_not_kept).toBe(0);
  });
});

describe('applySql', () => {
  it('clears only approved, still-dated rows of this organization and audits each', () => {
    const [row] = buildReport(data());
    const sql = applySql(row) as string[];
    expect(sql).toHaveLength(2);
    expect(sql[0]).toContain('UPDATE processing_queue SET file_retain_until = NULL');
    expect(sql[0]).toContain("tenant_id = 't1'");
    expect(sql[0]).toContain("status = 'approved'");
    expect(sql[0]).toContain('file_retain_until IS NOT NULL');
    expect(sql[0]).toContain("'qStamped'");
    // A rejected item's 90-day tombstone is a different rule; it is never named.
    expect(sql[0]).not.toContain('qOld');
    expect(sql[1]).toContain(CLEARED_ACTION);
    expect(sql[1]).toContain('2026-12-09 10:00:00');
  });
});

describe('queueIdFromExternalRef', () => {
  it('reads the queue id out of a per-record reference', () => {
    expect(queueIdFromExternalRef('queue-abc123-1042611005')).toBe('abc123');
    expect(queueIdFromExternalRef('queue-abc123')).toBe('abc123');
    expect(queueIdFromExternalRef('manual-1')).toBeNull();
    expect(queueIdFromExternalRef(null)).toBeNull();
  });
});
