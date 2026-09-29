/**
 * bin/lib/requirementScopePlan.js — the decision half of
 * `bin/propose-requirement-scopes`.
 *
 * PURE: rows in, plan out. No D1, no network, no clock. The script reads and
 * writes; everything that decides whether a requirement's scope is proposed
 * lives here so tests/unit/requirementScopePlan.test.ts can pin it.
 *
 * WHAT IT PROPOSES
 *
 * Migration 0123 gave `requirements` a `scope` column, DEFAULT 'supplier', and
 * backfilled nothing — every existing tenant's gaps are unchanged the day it
 * lands. The starter pack now says which requirements are owed per product
 * (spec sheet, ingredient statement, allergen matrix, nutritionals, label) and
 * which per lot (the COA), but the pack reaches NEW organisations only. This is
 * the existing tenants' way in, as a proposal a person applies.
 *
 *   proposed   a tenant requirement whose SLUG is in the pack with a
 *              non-supplier scope, still at the default 'supplier', and with no
 *              audit row saying a person set its scope.
 *   skipped    already carrying a non-default scope (somebody chose it);
 *              an audit row names a scope decision (a `requirement.scope_changed`,
 *              a `requirement_updated` whose changes named `scope`, or a
 *              `requirement_created` that recorded one); inactive.
 *
 * THE HONEST BOUND: before 0123 nothing recorded a scope, so "still at the
 * default with no audit row" is the only signature of "nobody decided". A
 * person who wanted 'supplier' for a spec sheet and said so nowhere is
 * indistinguishable from the default. The report prints this every run, and
 * the per-supplier impact is printed BEFORE anything is written.
 */

/** Mirror of shared/requirementScope.ts REQUIREMENT_SCOPES (pinned by the unit test). */
const REQUIREMENT_SCOPES = ['supplier', 'product', 'lot'];
const DEFAULT_SCOPE = 'supplier';

const SKIP_REASONS = {
  already_scoped: 'already carries a scope somebody chose',
  human_decided: 'a person is recorded as having set its scope',
  inactive: 'the requirement is inactive',
};

function normalizeScope(v) {
  return REQUIREMENT_SCOPES.includes(v) ? v : DEFAULT_SCOPE;
}

/** The pack's scope per slug, for the slugs whose scope is not the default. */
function packScopes(pack) {
  const out = new Map();
  for (const r of (pack && pack.requirements) || []) {
    const scope = r.scope == null ? DEFAULT_SCOPE : r.scope;
    if (!REQUIREMENT_SCOPES.includes(scope)) {
      throw new Error(`pack requirement "${r.slug}": unknown scope "${scope}"`);
    }
    if (scope !== DEFAULT_SCOPE && r.slug) out.set(String(r.slug), scope);
  }
  return out;
}

/** Does one audit row record a person deciding this requirement's scope? */
function auditNamesScope(action, details) {
  if (action === 'requirement.scope_changed') return true;
  let parsed;
  try {
    parsed = typeof details === 'string' ? JSON.parse(details) : details;
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;
  if (action === 'requirement_updated') {
    return !!(parsed.changes && Object.prototype.hasOwnProperty.call(parsed.changes, 'scope'));
  }
  if (action === 'requirement_created') {
    return Object.prototype.hasOwnProperty.call(parsed, 'scope');
  }
  return false;
}

/**
 * @param {object} args
 * @param {Array<{id,slug,name,scope,active}>} args.requirements  the tenant's rows
 * @param {object} args.pack  a starter pack (raw JSON is fine)
 * @param {Set<string>} args.humanDecided  requirement ids an audit row credits
 * @returns {{ proposals: Array<{id,slug,name,from,to}>, skipped: Array<{id,slug,name,reason,scope}> }}
 */
function planRequirementScopes({ requirements, pack, humanDecided }) {
  const wanted = packScopes(pack);
  const proposals = [];
  const skipped = [];
  for (const r of requirements || []) {
    const to = wanted.get(String(r.slug));
    if (!to) continue;
    const current = normalizeScope(r.scope);
    const base = { id: r.id, slug: r.slug, name: r.name };
    if (Number(r.active) === 0) {
      skipped.push({ ...base, scope: current, reason: 'inactive' });
    } else if (current !== DEFAULT_SCOPE) {
      skipped.push({ ...base, scope: current, reason: 'already_scoped' });
    } else if (humanDecided && humanDecided.has(r.id)) {
      skipped.push({ ...base, scope: current, reason: 'human_decided' });
    } else {
      proposals.push({ ...base, from: current, to });
    }
  }
  return { proposals, skipped };
}

function sqlStr(v) {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * The SQL for one proposal. Guarded by the value it expects, so a scope a
 * person set between the dry run and the apply is never overwritten; the audit
 * row names the script, never a person.
 */
function proposalToSql(tenantId, p) {
  const guard = `id = ${sqlStr(p.id)} AND tenant_id = ${sqlStr(tenantId)} AND scope = 'supplier'`;
  // Audit FIRST, under the same guard, so a row the UPDATE will skip gets no
  // audit row claiming it changed.
  return [
    `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details) SELECT NULL, ${sqlStr(tenantId)}, 'requirement.scope_changed', 'requirement', ${sqlStr(p.id)}, ${sqlStr(
      JSON.stringify({ name: p.name, from: p.from, to: p.to, via: 'bin/propose-requirement-scopes' }),
    )} WHERE EXISTS (SELECT 1 FROM requirements WHERE ${guard});`,
    `UPDATE requirements SET scope = ${sqlStr(p.to)}, updated_at = datetime('now') WHERE ${guard};`,
  ];
}

module.exports = {
  REQUIREMENT_SCOPES,
  SKIP_REASONS,
  packScopes,
  auditNamesScope,
  planRequirementScopes,
  proposalToSql,
};
