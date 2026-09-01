/**
 * bin/lib/coaBackfill.js — the decision half of
 * `bin/backfill-coa-extended-metadata`.
 *
 * The contract under test, in the order it matters:
 *   1. THE MATCH IS EXACT. `queue-<id>` is the flat producer's ref; a
 *      `queue-<id>-p1` or `queue-<id>-<lotKey>` ref belongs to the multi-product
 *      or records producer, which already wrote a RICHER payload. A prefix match
 *      would overwrite a per-record document with the whole file's tables, so
 *      the suffixed forms must be recognised and refused, not merely unmatched.
 *   2. A non-NULL extended_metadata is NEVER overwritten — not by any input,
 *      and the emitted SQL carries `AND extended_metadata IS NULL` so it also
 *      loses the race against an approval that lands mid-run.
 *   3. A missing queue item is COUNTED, not silently dropped. The tables went
 *      with it; a backfill that leaves quiet gaps is indistinguishable from one
 *      that worked.
 *   4. The JSON shape is the producer's own, byte for byte. The test imports
 *      the SAME compiled module the script does and asserts it against
 *      shared/coaExtendedMetadata.ts, so a drift between the worker and bin/
 *      fails here rather than on prod.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain CJS module, no types.
import mod from '../../bin/lib/coaBackfill.js';
// @ts-expect-error — generated CJS bundle, no types.
import shared from '../../bin/lib/shared/coaExtendedMetadata.js';
import { buildFlatExtendedMetadata } from '../../shared/coaExtendedMetadata';

const { flatExternalRef, isFlatQueueRef, decideRow, buildPlan, planToSql, batchStatements } = mod;

const QUEUE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

const TABLES = [
  {
    name: 'Microbiological Results',
    headers: ['Test', 'Result', 'Spec', 'Units'],
    rows: [['Coliform', '10', '<100', 'CFU/g']],
  },
];

/** A row as the driver's LEFT JOIN hands it over. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: 'doc1',
    title: 'Andersen Dairy COA 2026-01',
    external_ref: flatExternalRef(QUEUE_ID),
    extended_metadata: null,
    queue_id: QUEUE_ID,
    queue_status: 'approved',
    queue_tables: JSON.stringify(TABLES),
    ...over,
  };
}

const decide = (r: Record<string, unknown>) => decideRow(r, buildFlatExtendedMetadata);

describe('the exact-ref matching rule', () => {
  it('mints the flat producer’s ref with no suffix', () => {
    expect(flatExternalRef(QUEUE_ID)).toBe(`queue-${QUEUE_ID}`);
  });

  it('accepts only the bare `queue-<id>` form', () => {
    expect(isFlatQueueRef(`queue-${QUEUE_ID}`)).toBe(true);
  });

  it('REFUSES the multi-product ref — that path already wrote its own tables', () => {
    expect(isFlatQueueRef(`queue-${QUEUE_ID}-p0`)).toBe(false);
    expect(isFlatQueueRef(`queue-${QUEUE_ID}-p12`)).toBe(false);
  });

  it('REFUSES the records/sublot ref, however the lot key is spelled', () => {
    expect(isFlatQueueRef(`queue-${QUEUE_ID}-LOT12345`)).toBe(false);
    expect(isFlatQueueRef(`queue-${QUEUE_ID}-r0`)).toBe(false);
    expect(isFlatQueueRef(`queue-${QUEUE_ID}-LOT-123-A`)).toBe(false);
  });

  it('refuses anything that is not a queue ref at all', () => {
    expect(isFlatQueueRef('')).toBe(false);
    expect(isFlatQueueRef(null)).toBe(false);
    expect(isFlatQueueRef('ingest-abc')).toBe(false);
    expect(isFlatQueueRef('queue-')).toBe(false);
  });

  it('classifies a suffixed ref as not_flat_ref rather than as a missing queue item', () => {
    // The distinction is the whole point: "gone" means unrecoverable data,
    // "not the flat path" means a document that is already fine.
    const d = decide(row({ external_ref: `queue-${QUEUE_ID}-p1`, queue_id: null }));
    expect(d.outcome).toBe('not_flat_ref');
  });
});

describe('the eligibility decision', () => {
  it('writes when the column is empty and the queue item has approved tables', () => {
    const d = decide(row());
    expect(d.outcome).toBe('write');
    expect(d.extended).toBe(JSON.stringify({ tables: TABLES }));
  });

  it('never overwrites an existing payload, however rich or poor', () => {
    for (const existing of ['{"tables":[]}', '{}', JSON.stringify({ tables: TABLES, groups: {} })]) {
      const d = decide(row({ extended_metadata: existing }));
      expect(d.outcome).toBe('already_populated');
      expect(d.extended).toBeNull();
    }
  });

  it('checks "already populated" BEFORE anything else, so a rich row is never re-judged', () => {
    const d = decide(row({ extended_metadata: '{"tables":[]}', queue_id: null }));
    expect(d.outcome).toBe('already_populated');
  });

  it('reports a pruned queue item instead of skipping it quietly', () => {
    const d = decide(row({ queue_id: null, queue_status: null, queue_tables: null }));
    expect(d.outcome).toBe('queue_item_gone');
    expect(d.reason).toMatch(/no longer exists/);
  });

  it('leaves a queue item that is not approved alone', () => {
    expect(decide(row({ queue_status: 'pending' })).outcome).toBe('queue_item_not_approved');
    expect(decide(row({ queue_status: 'rejected' })).outcome).toBe('queue_item_not_approved');
  });

  it('writes nothing when the queue item carries no usable tables', () => {
    for (const tables of [null, '', '   ', '[]', '{"tables":[]}', '{not json']) {
      const d = decide(row({ queue_tables: tables }));
      expect(d.outcome).toBe('no_tables');
      expect(d.extended).toBeNull();
    }
  });
});

describe('JSON shaping matches the producer exactly', () => {
  it('uses the SAME function the worker approve path uses', () => {
    // shared/coaExtendedMetadata.ts is the one definition; bin/ gets it through
    // the generated bundle. If these ever disagree, the backfill would write a
    // shape no approval writes.
    expect(shared.buildFlatExtendedMetadata(JSON.stringify(TABLES))).toBe(
      buildFlatExtendedMetadata(JSON.stringify(TABLES))
    );
    expect(shared.buildFlatExtendedMetadata('[]')).toBe(buildFlatExtendedMetadata('[]'));
    expect(shared.buildFlatExtendedMetadata(null)).toBe(buildFlatExtendedMetadata(null));
  });

  it('emits `{"tables":[...]}` — no wrapper, no groups, no nulls padded in', () => {
    const d = decideRow(row(), shared.buildFlatExtendedMetadata);
    expect(JSON.parse(d.extended as string)).toEqual({ tables: TABLES });
    expect(Object.keys(JSON.parse(d.extended as string))).toEqual(['tables']);
  });

  it('accepts an already-parsed array as readily as a JSON string', () => {
    const fromString = decide(row({ queue_tables: JSON.stringify(TABLES) }));
    const fromArray = decide(row({ queue_tables: TABLES }));
    expect(fromArray.extended).toBe(fromString.extended);
  });
});

describe('the plan and its SQL', () => {
  const rows = [
    row({ id: 'd-write-1', title: 'Fill me 1' }),
    row({ id: 'd-write-2', title: 'Fill me 2' }),
    row({ id: 'd-full', extended_metadata: '{"tables":[]}' }),
    row({ id: 'd-gone', queue_id: null }),
    row({ id: 'd-empty', queue_tables: '[]' }),
    row({ id: 'd-multi', external_ref: `queue-${QUEUE_ID}-p1` }),
    row({ id: 'd-pending', queue_status: 'pending' }),
  ];

  it('counts every row into exactly one bucket', () => {
    const plan = buildPlan(rows, buildFlatExtendedMetadata);
    expect(plan.scanned).toBe(rows.length);
    expect(plan.counts).toEqual({
      write: 2,
      already_populated: 1,
      not_flat_ref: 1,
      queue_item_gone: 1,
      queue_item_not_approved: 1,
      no_tables: 1,
    });
    const total = Object.values(plan.counts).reduce((a, b) => (a as number) + (b as number), 0);
    expect(total).toBe(plan.scanned);
  });

  it('carries example titles for the report', () => {
    const plan = buildPlan(rows, buildFlatExtendedMetadata);
    expect(plan.examples.write.map((e: { title: string }) => e.title)).toEqual([
      'Fill me 1',
      'Fill me 2',
    ]);
    expect(plan.examples.queue_item_gone).toHaveLength(1);
  });

  it('guards every UPDATE with `extended_metadata IS NULL`', () => {
    const plan = buildPlan(rows, buildFlatExtendedMetadata);
    const sql = planToSql(plan.writes);
    expect(sql).toHaveLength(2);
    for (const s of sql) {
      expect(s).toMatch(/^UPDATE documents SET extended_metadata = '/);
      expect(s).toMatch(/AND extended_metadata IS NULL;$/);
      // A backfill is not an edit anyone made to the document.
      expect(s).not.toMatch(/updated_at/);
    }
    expect(sql[0]).toContain("WHERE id = 'd-write-1'");
  });

  it('escapes quotes in the payload rather than breaking the statement', () => {
    const quoted = [{ name: "O'Brien's Dairy", headers: [], rows: [] }];
    const sql = planToSql([
      { id: "d'1", title: 't', extended: JSON.stringify({ tables: quoted }) },
    ]);
    expect(sql[0]).toContain("O''Brien''s Dairy");
    expect(sql[0]).toContain("WHERE id = 'd''1'");
    // Exactly one statement terminator — the quoting did not split it.
    expect(sql[0].match(/;/g)).toHaveLength(1);
  });

  it('produces no statements when nothing is eligible', () => {
    const plan = buildPlan([row({ extended_metadata: '{}' })], buildFlatExtendedMetadata);
    expect(planToSql(plan.writes)).toEqual([]);
  });

  it('tolerates an empty or absent row set', () => {
    expect(buildPlan([], buildFlatExtendedMetadata).scanned).toBe(0);
    expect(buildPlan(undefined, buildFlatExtendedMetadata).counts.write).toBe(0);
  });
});

describe('batching for D1 statement limits', () => {
  const stmt = (n: number) => `UPDATE documents SET extended_metadata = '${'x'.repeat(n)}';`;

  it('splits on count', () => {
    const batches = batchStatements(Array.from({ length: 125 }, () => stmt(10)), {
      maxCount: 50,
    });
    expect(batches.map((b: string[]) => b.length)).toEqual([50, 50, 25]);
  });

  it('splits on BYTES too — a COA table is not a small string', () => {
    const batches = batchStatements([stmt(400), stmt(400), stmt(400)], {
      maxCount: 50,
      maxBytes: 500,
    });
    expect(batches).toHaveLength(3);
  });

  it('never drops or duplicates a statement', () => {
    const all = Array.from({ length: 37 }, (_, i) => stmt(i + 1));
    const flat = batchStatements(all, { maxCount: 7 }).flat();
    expect(flat).toEqual(all);
  });

  it('keeps an oversized single statement rather than losing it', () => {
    const batches = batchStatements([stmt(5000)], { maxCount: 50, maxBytes: 100 });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
  });

  it('returns no batches for no statements', () => {
    expect(batchStatements([])).toEqual([]);
  });
});
