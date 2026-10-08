// The plan behind bin/backfill-sharing-rules: which document types have no
// stored sharing rule, and what each would be given. Pure -- no D1, no clock --
// so tests/unit/sharingRuleBackfill.test.ts can pin it.
//
// The name match is NOT repeated here. It is the compiled mirror of
// shared/sharingRule.ts (rebuild with `npm run build:worker-shared`), the same
// function POST /api/document-types and both starter-pack appliers call.

const { defaultSharingRuleForTypeName, parseSharingRule, SHARING_RULE_LABELS } = require('./shared/sharingRule.js');

/**
 * @param {Array<{id: string, name: string, slug?: string, active?: number, sharing_rule: string | null}>} types
 * @returns {{
 *   total: number,
 *   stored: Array<{id: string, name: string, rule: string}>,
 *   unreadable: Array<{id: string, name: string, value: string, reads_as: string}>,
 *   fills: Array<{id: string, name: string, active: boolean, rule: string}>,
 * }}
 */
function planSharingRuleBackfill(types) {
  const stored = [];
  const unreadable = [];
  const fills = [];
  for (const t of types) {
    const raw = t.sharing_rule;
    if (raw === null || raw === undefined) {
      // Exactly what the portal already reads this type as. Writing it changes
      // nothing about what may leave; it makes the setting visible.
      fills.push({
        id: t.id,
        name: t.name,
        active: Number(t.active ?? 1) === 1,
        rule: defaultSharingRuleForTypeName(t.name),
      });
      continue;
    }
    const parsed = parseSharingRule(raw);
    if (parsed) {
      stored.push({ id: t.id, name: t.name, rule: parsed });
    } else {
      // Not NULL and not one of the three words. Never overwritten here: it
      // was written by something, and the portal already reads it as the
      // name default. Reported so a person can look.
      unreadable.push({
        id: t.id,
        name: t.name,
        value: String(raw),
        reads_as: defaultSharingRuleForTypeName(t.name),
      });
    }
  }
  return { total: types.length, stored, unreadable, fills };
}

/**
 * One fill as SQL. `sharing_rule IS NULL` is in the WHERE, not only in the
 * plan: a rule an admin set between the read and the write is not overwritten.
 */
function fillToSql(tenantId, fill, sqlStr) {
  return (
    `UPDATE document_types SET sharing_rule = ${sqlStr(fill.rule)}, updated_at = datetime('now') ` +
    `WHERE id = ${sqlStr(fill.id)} AND tenant_id = ${sqlStr(tenantId)} AND sharing_rule IS NULL;`
  );
}

module.exports = { planSharingRuleBackfill, fillToSql, SHARING_RULE_LABELS };
