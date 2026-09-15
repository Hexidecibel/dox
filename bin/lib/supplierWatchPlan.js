/**
 * bin/lib/supplierWatchPlan.js — the parse + plan half of `bin/seed-supplier-watch`.
 *
 * Pure: no D1, no clock, no process. The CLI reads the database, hands the rows
 * in, and renders the plan this returns — so the plan is unit-testable the way
 * bin/lib/specLimitsImport.js is.
 *
 * WHAT A "WATCH" IS (AJ Conner, 2026-09-14): supplier-specific limits layered
 * over the company limits (most specific wins) plus extra REQUIRED ANALYTES,
 * for a watch period that ends at a review-by date. Migration 0109.
 *
 * Idempotent by construction: a requirement or a supplier limit that already
 * matches is 'unchanged' and renders no SQL, so a re-run of the same command
 * plans nothing.
 */

'use strict';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function sqlText(v) {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function sqlNum(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return 'NULL';
  return String(Number(v));
}

function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Parse one --limit flag: "Coliform<=1 CFU/g", "Standard Plate Count <= 10000 CFU/g",
 * "E. coli<1", "Listeria monocytogenes=absent".
 * Returns { analyte, operator, value_min, value_max, unit } or { error }.
 */
function parseLimitFlag(raw) {
  const s = String(raw ?? '').trim();
  const absent = /^(.+?)\s*(?:=|==|:)\s*absent$/i.exec(s);
  if (absent) {
    return { analyte: absent[1].trim(), operator: 'absent', value_min: null, value_max: null, unit: null };
  }
  const m = /^(.+?)\s*(<=|>=|<|>|==|≤|≥)\s*([+-]?\d*\.?\d+)\s*(.*)$/.exec(s);
  if (!m) {
    return { error: `--limit "${s}" is not "<analyte><op><number> [unit]" (op one of < <= > >= ==) or "<analyte>=absent"` };
  }
  const op = m[2] === '≤' ? '<=' : m[2] === '≥' ? '>=' : m[2];
  const value = Number(m[3]);
  const isMax = op === '<' || op === '<=';
  return {
    analyte: m[1].trim(),
    operator: op,
    value_min: isMax ? null : value,
    value_max: isMax ? value : null,
    unit: m[4].trim() || null,
  };
}

/** Find an analyte by id, name or alias — exact on the normalized form, like `matchSpecTest`. */
function resolveAnalyte(ref, tests) {
  const key = norm(ref);
  if (!key) return null;
  return (
    tests.find((t) => t.id === ref) ||
    tests.find((t) => norm(t.name) === key) ||
    tests.find((t) => (t.aliases || []).some((a) => norm(a) === key)) ||
    null
  );
}

/**
 * Build the plan.
 *
 * @param {object} input
 * @param {string} input.tenantId
 * @param {{id:string,name:string}} input.supplier
 * @param {{id:string,name:string}} input.documentType   scope of the required analytes
 * @param {Array<{id,name,aliases,default_unit}>} input.tests
 * @param {Array<object>} input.existingLimits    this supplier's supplier-scoped limits
 * @param {Array<object>} input.existingRequired  this supplier's required analytes
 * @param {string[]} input.require    analyte refs to require
 * @param {string[]} input.limits     raw --limit flags
 * @param {string|null} input.reviewBy
 * @param {string|null} input.effectiveFrom
 * @param {string|null} input.reason
 * @param {() => string} input.newId
 * @param {(l:object) => string|null} input.validateLimitShape
 * @param {(u:string) => {family:string}} input.normalizeUnit
 */
function buildWatchPlan(input) {
  const errors = [];
  const reviewBy = input.reviewBy || null;
  const effectiveFrom = input.effectiveFrom || null;
  const reason = input.reason || null;
  if (reviewBy && !DAY_RE.test(reviewBy)) errors.push(`--review-by "${reviewBy}" is not YYYY-MM-DD`);
  if (effectiveFrom && !DAY_RE.test(effectiveFrom)) errors.push(`--effective-from "${effectiveFrom}" is not YYYY-MM-DD`);
  if (reviewBy && effectiveFrom && reviewBy < effectiveFrom) errors.push('--review-by is earlier than --effective-from');

  const required = [];
  const seenRequired = new Set();
  for (const ref of input.require || []) {
    const test = resolveAnalyte(ref, input.tests);
    if (!test) {
      errors.push(`--require "${ref}" matches no analyte in this tenant (by id, name or alias)`);
      continue;
    }
    if (seenRequired.has(test.id)) continue;
    seenRequired.add(test.id);
    const existing = (input.existingRequired || []).find(
      (r) => r.spec_test_id === test.id && r.document_type_id === input.documentType.id
    );
    if (!existing) {
      required.push({ action: 'create', id: input.newId(), specTestId: test.id, analyte: test.name, reviewBy, effectiveFrom, reason });
      continue;
    }
    const same =
      (existing.review_by || null) === reviewBy &&
      (existing.effective_from || null) === effectiveFrom &&
      (existing.reason || null) === reason;
    required.push({
      action: same ? 'unchanged' : 'update',
      id: existing.id,
      specTestId: test.id,
      analyte: test.name,
      reviewBy,
      effectiveFrom,
      reason,
      before: { review_by: existing.review_by || null, effective_from: existing.effective_from || null, reason: existing.reason || null },
    });
  }

  const limits = [];
  for (const raw of input.limits || []) {
    const parsed = parseLimitFlag(raw);
    if (parsed.error) {
      errors.push(parsed.error);
      continue;
    }
    const test = resolveAnalyte(parsed.analyte, input.tests);
    if (!test) {
      errors.push(`--limit "${raw}": "${parsed.analyte}" matches no analyte in this tenant`);
      continue;
    }
    const shapeError = input.validateLimitShape(parsed);
    if (shapeError) {
      errors.push(`--limit "${raw}": ${shapeError}`);
      continue;
    }
    const unit = parsed.unit || test.default_unit || null;
    if (unit && input.normalizeUnit(unit).family.startsWith('other:')) {
      errors.push(`--limit "${raw}": unit "${unit}" is not one the spec engine can compare; every result would read "could not check"`);
      continue;
    }
    const desired = { ...parsed, unit, review_by: reviewBy };
    // A supplier watch limit is scoped to the supplier only (no document type,
    // no product) — the same exact scope 0086's unique index keys on.
    const existing = (input.existingLimits || []).find(
      (l) => l.spec_test_id === test.id && l.supplier_id === input.supplier.id && !l.document_type_id && !l.product_id
    );
    if (!existing) {
      limits.push({ action: 'create', id: input.newId(), specTestId: test.id, analyte: test.name, desired });
      continue;
    }
    const same =
      existing.operator === desired.operator &&
      (existing.value_min ?? null) === desired.value_min &&
      (existing.value_max ?? null) === desired.value_max &&
      (existing.unit || null) === desired.unit &&
      (existing.review_by || null) === reviewBy &&
      Number(existing.active ?? 1) === 1;
    const thresholdMoved =
      existing.operator !== desired.operator ||
      (existing.value_min ?? null) !== desired.value_min ||
      (existing.value_max ?? null) !== desired.value_max ||
      (existing.unit || null) !== desired.unit;
    limits.push({
      action: same ? 'unchanged' : 'update',
      id: existing.id,
      specTestId: test.id,
      analyte: test.name,
      desired,
      version: thresholdMoved ? Number(existing.version || 1) + 1 : Number(existing.version || 1),
      before: { operator: existing.operator, value_min: existing.value_min, value_max: existing.value_max, unit: existing.unit, review_by: existing.review_by || null },
    });
  }

  const count = (list, action) => list.filter((x) => x.action === action).length;
  return {
    tenantId: input.tenantId,
    supplier: input.supplier,
    documentType: input.documentType,
    required,
    limits,
    errors,
    summary: {
      requiredCreated: count(required, 'create'),
      requiredUpdated: count(required, 'update'),
      limitsCreated: count(limits, 'create'),
      limitsUpdated: count(limits, 'update'),
      errors: errors.length,
    },
  };
}

function audit(tenantId, action, resourceType, resourceId, details) {
  return (
    `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details, ip_address) ` +
    `VALUES (NULL, ${sqlText(tenantId)}, ${sqlText(action)}, ${sqlText(resourceType)}, ${sqlText(resourceId)}, ` +
    `${sqlText(JSON.stringify({ ...details, via: 'bin/seed-supplier-watch' }))}, NULL);`
  );
}

/** Render the plan as SQL statements. 'unchanged' rows render nothing. */
function watchPlanToSql(plan) {
  const t = plan.tenantId;
  const stmts = [];
  for (const r of plan.required) {
    if (r.action === 'create') {
      stmts.push(
        `INSERT INTO supplier_required_analytes (id, tenant_id, supplier_id, document_type_id, spec_test_id, effective_from, review_by, reason) ` +
          `VALUES (${sqlText(r.id)}, ${sqlText(t)}, ${sqlText(plan.supplier.id)}, ${sqlText(plan.documentType.id)}, ${sqlText(r.specTestId)}, ` +
          `${sqlText(r.effectiveFrom)}, ${sqlText(r.reviewBy)}, ${sqlText(r.reason)});`
      );
      stmts.push(
        audit(t, 'spec_required_analyte.created', 'supplier_required_analytes', r.id, {
          supplier_id: plan.supplier.id,
          document_type_id: plan.documentType.id,
          spec_test_id: r.specTestId,
          effective_from: r.effectiveFrom,
          review_by: r.reviewBy,
          reason: r.reason,
        })
      );
    } else if (r.action === 'update') {
      stmts.push(
        `UPDATE supplier_required_analytes SET effective_from = ${sqlText(r.effectiveFrom)}, review_by = ${sqlText(r.reviewBy)}, ` +
          `reason = ${sqlText(r.reason)}, updated_at = datetime('now') WHERE id = ${sqlText(r.id)};`
      );
      stmts.push(
        audit(t, 'spec_required_analyte.updated', 'supplier_required_analytes', r.id, {
          before: r.before,
          after: { effective_from: r.effectiveFrom, review_by: r.reviewBy, reason: r.reason },
        })
      );
    }
  }
  for (const l of plan.limits) {
    const d = l.desired;
    if (l.action === 'create') {
      stmts.push(
        `INSERT INTO spec_limits (id, tenant_id, spec_test_id, supplier_id, document_type_id, product_id, operator, value_min, value_max, unit, severity, notes, active, version, review_by) ` +
          `VALUES (${sqlText(l.id)}, ${sqlText(t)}, ${sqlText(l.specTestId)}, ${sqlText(plan.supplier.id)}, NULL, NULL, ${sqlText(d.operator)}, ` +
          `${sqlNum(d.value_min)}, ${sqlNum(d.value_max)}, ${sqlText(d.unit)}, 'alert', 'Supplier watch (bin/seed-supplier-watch)', 1, 1, ${sqlText(d.review_by)});`
      );
      stmts.push(
        audit(t, 'spec_limit.created', 'spec_limits', l.id, {
          spec_test_id: l.specTestId,
          supplier_id: plan.supplier.id,
          operator: d.operator,
          valueMin: d.value_min,
          valueMax: d.value_max,
          unit: d.unit,
          review_by: d.review_by,
        })
      );
    } else if (l.action === 'update') {
      stmts.push(
        `UPDATE spec_limits SET operator = ${sqlText(d.operator)}, value_min = ${sqlNum(d.value_min)}, value_max = ${sqlNum(d.value_max)}, ` +
          `unit = ${sqlText(d.unit)}, review_by = ${sqlText(d.review_by)}, active = 1, version = ${l.version}, updated_at = datetime('now') ` +
          `WHERE id = ${sqlText(l.id)};`
      );
      stmts.push(
        audit(t, 'spec_limit.updated', 'spec_limits', l.id, {
          before: l.before,
          after: { operator: d.operator, value_min: d.value_min, value_max: d.value_max, unit: d.unit, review_by: d.review_by },
        })
      );
    }
  }
  return stmts;
}

function fmtLimit(d) {
  if (d.operator === 'absent') return 'absent';
  const v = d.value_max ?? d.value_min;
  return `${d.operator === '<=' ? '≤' : d.operator === '>=' ? '≥' : d.operator}${v}${d.unit ? ` ${d.unit}` : ''}`;
}

/** Human-readable plan lines. */
function formatWatchPlan(plan, { targetLabel }) {
  const lines = [
    `Supplier watch for ${plan.supplier.name} (${plan.supplier.id}) — ${targetLabel}`,
    `Required analytes apply to: ${plan.documentType.name} (${plan.documentType.id})`,
    '',
  ];
  if (plan.required.length) {
    lines.push('Required analytes:');
    for (const r of plan.required) {
      lines.push(
        `  ${r.action.padEnd(9)} ${r.analyte}${r.reviewBy ? `  review by ${r.reviewBy}` : ''}${r.effectiveFrom ? `  from ${r.effectiveFrom}` : ''}${r.reason ? `  — ${r.reason}` : ''}`
      );
    }
  }
  if (plan.limits.length) {
    lines.push('Supplier limits (over the company default):');
    for (const l of plan.limits) {
      lines.push(`  ${l.action.padEnd(9)} ${l.analyte} ${fmtLimit(l.desired)}${l.desired.review_by ? `  review by ${l.desired.review_by}` : ''}`);
    }
  }
  if (!plan.required.length && !plan.limits.length) lines.push('Nothing asked for: pass --require and/or --limit.');
  if (plan.errors.length) {
    lines.push('', 'Problems:');
    for (const e of plan.errors) lines.push(`  - ${e}`);
  }
  lines.push('');
  return lines;
}

module.exports = {
  parseLimitFlag,
  resolveAnalyte,
  buildWatchPlan,
  watchPlanToSql,
  formatWatchPlan,
};
