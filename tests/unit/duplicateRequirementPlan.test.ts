/**
 * bin/lib/duplicateRequirementPlan.js — the plan behind
 * `bin/retire-duplicate-requirements`.
 *
 *   1. Links on the duplicate move to the canonical row, carried as they are.
 *   2. A canonical row is never modified: a clash is a CONFLICT, left, and the
 *      duplicate is HELD active.
 *   3. A superseded request version's lines are frozen.
 *   4. A missing canonical is a skip, never an invention.
 *   5. The SQL is guarded and audits the retirement.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain CJS module, no types.
import mod from '../../bin/lib/duplicateRequirementPlan.js';

const { DEFAULT_DUPLICATE_SLUGS, planDuplicateRequirements, duplicateRequirementsToSql } = mod;
const q = (v: unknown) => (v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

const requirements = [
  { id: 'dup_spec', slug: 'specification-sheet', name: 'Specification Sheet', active: 1 },
  { id: 'canon_spec', slug: 'spec-sheet', name: 'Specification Sheet', active: 1 },
];
const pairs = [{ dupSlug: 'specification-sheet', canonSlug: 'spec-sheet' }];

describe('planDuplicateRequirements', () => {
  it('folds the seed-arrivals-demo document-type slugs into the starter-pack requirement slugs', () => {
    expect(DEFAULT_DUPLICATE_SLUGS).toEqual({
      'specification-sheet': 'spec-sheet',
      'allergen-statement': 'allergen-matrix',
      'country-of-origin-statement': 'country-of-origin',
    });
  });

  it('re-points links, keeps a rejection a rejection, and retires the duplicate', () => {
    const plan = planDuplicateRequirements({
      pairs, requirements,
      links: {
        document_requirements: [{ id: 'dr1', k: 'doc1', requirement_id: 'dup_spec', detail: 'rejected' }],
        request_lines: [
          { id: 'rl1', k: 'req1', requirement_id: 'dup_spec', frozen: 0 },
          { id: 'rl0', k: 'req0', requirement_id: 'dup_spec', frozen: 1 },
        ],
      },
      notes: [{ id: 'n1', entity_id: 'dup_spec' }],
    });
    expect(plan[0].status).toBe('retire');
    const dr = plan[0].tables.find((t: any) => t.table === 'document_requirements');
    expect(dr.move.map((r: any) => r.id)).toEqual(['dr1']);
    const rl = plan[0].tables.find((t: any) => t.table === 'request_lines');
    expect(rl.move.map((r: any) => r.id)).toEqual(['rl1']);
    expect(rl.frozen.map((r: any) => r.id)).toEqual(['rl0']);

    const sql = duplicateRequirementsToSql('t1', plan, q);
    // status is never written: the row moves exactly as it is.
    expect(sql.find((s: string) => s.includes("'dr1'"))).not.toMatch(/status/);
    expect(sql.find((s: string) => s.includes("'dr1'"))).toContain('AND NOT EXISTS');
    expect(sql.some((s: string) => s.includes("'rl0'"))).toBe(false);
    expect(sql.some((s: string) => s.startsWith('UPDATE entity_notes'))).toBe(true);
    expect(sql.some((s: string) => s.startsWith('UPDATE requirements SET active = 0') && s.includes("'dup_spec'"))).toBe(true);
    expect(sql.some((s: string) => s.includes("'requirement.retired_as_duplicate'"))).toBe(true);
    expect(sql.some((s: string) => s.includes("'canon_spec'") && s.startsWith('UPDATE requirements'))).toBe(false);
  });

  it('holds the duplicate when the same document already links the canonical row', () => {
    const plan = planDuplicateRequirements({
      pairs, requirements,
      links: {
        document_requirements: [
          { id: 'dr1', k: 'doc1', requirement_id: 'dup_spec', detail: 'confirmed' },
          { id: 'dr2', k: 'doc1', requirement_id: 'canon_spec', detail: 'rejected' },
          { id: 'dr3', k: 'doc2', requirement_id: 'dup_spec', detail: 'suggested' },
        ],
      },
    });
    expect(plan[0].status).toBe('held');
    expect(plan[0].conflictCount).toBe(1);
    const sql = duplicateRequirementsToSql('t1', plan, q);
    expect(sql.some((s: string) => s.includes("'dr1'"))).toBe(false); // conflict left
    expect(sql.some((s: string) => s.includes("'dr2'"))).toBe(false); // canonical untouched
    expect(sql.some((s: string) => s.includes("'dr3'"))).toBe(true); // the rest still moves
    expect(sql.some((s: string) => s.startsWith('UPDATE requirements'))).toBe(false);
    expect(sql.some((s: string) => s.includes("'requirement.duplicate_links_moved'"))).toBe(true);
  });

  it('skips a pair whose canonical row does not exist', () => {
    const plan = planDuplicateRequirements({ pairs, requirements: [requirements[0]], links: {} });
    expect(plan[0].status).toBe('no_canonical');
    expect(duplicateRequirementsToSql('t1', plan, q)).toEqual([]);
  });
});
