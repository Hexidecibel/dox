/**
 * bin/lib/duplicateRequirementPlan.js — the plan half of
 * `bin/retire-duplicate-requirements`.
 *
 * Pure: no D1, no clock, no process. The CLI reads the rows and renders what
 * this returns, so the rule is unit-testable.
 *
 * WHY: a requirement is the thing that has to be PROVEN, not the document that
 * proves it (AJ, rules table F4, 2026-09-20). `bin/seed-arrivals-demo` created
 * requirements under three DOCUMENT-TYPE slugs (`specification-sheet`,
 * `allergen-statement`, `country-of-origin-statement`) on a tenant that already
 * held the starter pack's requirement for each concept (`spec-sheet`,
 * `allergen-matrix`, `country-of-origin`), so each concept was listed twice and
 * a document closing one row left the other open as a false gap.
 *
 * THE RULE
 *   - every link to the duplicate is RE-POINTED to the canonical row, carried
 *     over exactly as it is (a confirmed link stays confirmed, a person's
 *     rejection stays a rejection, a tier stays its tier);
 *   - a canonical row is NEVER modified. Where the same document / supplier /
 *     claim / type / request / template already links the canonical row, the
 *     duplicate's link is a CONFLICT: it is left where it is and reported,
 *     never merged, because merging means choosing between two statements a
 *     person may have made (e.g. confirmed on one row, rejected on the other);
 *   - request lines of a SUPERSEDED request version are frozen (0090: an old
 *     version is never touched) and stay on the duplicate;
 *   - the duplicate is deactivated (never deleted -- its id stays resolvable
 *     for the frozen history) only when no conflict remains. A pair with a
 *     conflict is HELD for a person;
 *   - one audit row per retired duplicate, naming every row moved.
 */

'use strict';

/** Duplicate slug -> canonical (starter-pack requirement) slug. */
const DEFAULT_DUPLICATE_SLUGS = Object.freeze({
  'specification-sheet': 'spec-sheet',
  'allergen-statement': 'allergen-matrix',
  'country-of-origin-statement': 'country-of-origin',
});

/**
 * The link tables and the column that, with requirement_id, is unique.
 * `detail` is the column(s) worth showing a person when two links conflict.
 */
const LINK_TABLES = Object.freeze([
  { table: 'document_requirements', key: 'document_id', label: 'document links', detail: 'status' },
  { table: 'supplier_requirements', key: 'supplier_id', label: 'supplier checklist rows', detail: 'tier' },
  { table: 'claim_type_requirements', key: 'claim_type_id', label: 'claim rules', detail: null },
  { table: 'document_type_requirements', key: 'document_type_id', label: 'document-type defaults', detail: null },
  { table: 'request_lines', key: 'request_id', label: 'request lines', detail: null },
  { table: 'request_template_lines', key: 'template_id', label: 'request template lines', detail: null },
]);

/**
 * @param {object} input
 * @param {Array<{dupSlug:string, canonSlug:string}>} input.pairs
 * @param {Array<{id:string,slug:string,name:string,active:number}>} input.requirements  the tenant's rows for every slug named
 * @param {Record<string, Array<{id:string,k:string,requirement_id:string,detail?:string|null,frozen?:number}>>} input.links  by table
 * @param {Array<{id:string,entity_id:string}>} input.notes  entity_notes on either row
 */
function planDuplicateRequirements({ pairs, requirements, links, notes = [] }) {
  const bySlug = new Map(requirements.map((r) => [r.slug, r]));
  const out = [];
  for (const { dupSlug, canonSlug } of pairs) {
    const dup = bySlug.get(dupSlug);
    const canon = bySlug.get(canonSlug);
    if (!dup) {
      out.push({ dupSlug, canonSlug, status: 'absent', reason: `no requirement "${dupSlug}" on this tenant` });
      continue;
    }
    if (!canon) {
      out.push({ dupSlug, canonSlug, dup, status: 'no_canonical', reason: `the canonical "${canonSlug}" does not exist; nothing to re-point to` });
      continue;
    }
    const tables = [];
    let moveCount = 0;
    let conflictCount = 0;
    for (const t of LINK_TABLES) {
      const rows = links[t.table] || [];
      const canonKeys = new Map(rows.filter((r) => r.requirement_id === canon.id).map((r) => [r.k, r]));
      const move = [];
      const conflicts = [];
      const frozen = [];
      for (const r of rows.filter((x) => x.requirement_id === dup.id)) {
        if (r.frozen) frozen.push(r);
        else if (canonKeys.has(r.k)) conflicts.push({ dup: r, canon: canonKeys.get(r.k) });
        else move.push(r);
      }
      moveCount += move.length;
      conflictCount += conflicts.length;
      tables.push({ ...t, move, conflicts, frozen });
    }
    const movedNotes = notes.filter((n) => n.entity_id === dup.id);
    const status = conflictCount > 0 ? 'held' : dup.active ? 'retire' : 'already_inactive';
    out.push({ dupSlug, canonSlug, dup, canon, tables, notes: movedNotes, moveCount, conflictCount, status });
  }
  return out;
}

/**
 * Render one tenant's plan as guarded SQL. A held pair still has its
 * non-conflicting links moved (that is progress a person would want either
 * way) but the duplicate stays active.
 */
function duplicateRequirementsToSql(tenantId, plan, q) {
  const out = [];
  for (const p of plan) {
    if (!p.canon || !p.tables) continue;
    const moved = {};
    for (const t of p.tables) {
      for (const r of t.move) {
        out.push(
          `UPDATE ${t.table} SET requirement_id = ${q(p.canon.id)} WHERE id = ${q(r.id)} AND requirement_id = ${q(p.dup.id)}` +
          ` AND NOT EXISTS (SELECT 1 FROM ${t.table} x WHERE x.${t.key} = ${q(r.k)} AND x.requirement_id = ${q(p.canon.id)});`,
        );
      }
      if (t.move.length) moved[t.table] = t.move.map((r) => r.id);
    }
    for (const n of p.notes) {
      out.push(
        `UPDATE entity_notes SET entity_id = ${q(p.canon.id)} WHERE id = ${q(n.id)} AND entity_type = 'requirement' AND entity_id = ${q(p.dup.id)};`,
      );
    }
    if (p.notes.length) moved.entity_notes = p.notes.map((n) => n.id);
    const retire = p.status === 'retire';
    if (retire) {
      out.push(
        `UPDATE requirements SET active = 0, updated_at = datetime('now') WHERE id = ${q(p.dup.id)} AND tenant_id = ${q(tenantId)};`,
      );
    }
    if (retire || Object.keys(moved).length) {
      out.push(
        `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details) VALUES (NULL, ${q(tenantId)}, ${q(retire ? 'requirement.retired_as_duplicate' : 'requirement.duplicate_links_moved')}, 'requirement', ${q(p.dup.id)}, ${q(JSON.stringify({
          duplicate: { id: p.dup.id, slug: p.dup.slug, name: p.dup.name },
          canonical: { id: p.canon.id, slug: p.canon.slug, name: p.canon.name },
          moved,
          conflicts_left: p.conflictCount,
          frozen_left: p.tables.reduce((n, t) => n + t.frozen.length, 0),
          deactivated: retire,
          via: 'bin/retire-duplicate-requirements',
        }))});`,
      );
    }
  }
  return out;
}

module.exports = { DEFAULT_DUPLICATE_SLUGS, LINK_TABLES, planDuplicateRequirements, duplicateRequirementsToSql };
