/* eslint-disable no-console */
/**
 * bin/lib/specLimitsImport.js — the pure half of `bin/import-spec-limits`.
 *
 * Everything here is a function of its arguments: sheet rows in, a plan out.
 * No database, no filesystem, no xlsx. The driver script reads the workbook and
 * talks to D1; this module decides what the rows MEAN, which is the part worth
 * testing (tests/unit/specLimitsImport.test.ts).
 *
 * THE TWO TABS WE READ, AND THE ONE WE DO NOT
 * -------------------------------------------
 * "Limits by Analyte" holds each threshold exactly ONCE. "Test Name Variants"
 * holds every spelling suppliers print, keyed back to an analyte. The workbook
 * also carries a "Spec Limits" tab that joins the two for human reading -- one
 * row per spelling, so the same 8 limits appear 37 times. Importing that tab
 * would create 37 limits where 8 belong. It is a view; it is not the source.
 *
 * ALIASES MERGE, THEY NEVER REPLACE
 * ---------------------------------
 * The REST API's PUT overwrites `spec_tests.aliases` wholesale. An importer
 * that did the same would delete every spelling an operator added by hand
 * between runs, and the failure is invisible: the limit stays configured, it
 * just stops matching that supplier's COA. So a re-import is strictly additive.
 */

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Trimmed string form of a cell, tolerating null/undefined/numbers. */
function cell(v) {
  return String(v === null || v === undefined ? '' : v).trim();
}

/** Case/whitespace-insensitive comparison key. Used for alias dedupe. */
function ciKey(s) {
  return cell(s).toLowerCase().replace(/\s+/g, ' ');
}

function isBlankRow(row) {
  return !(row || []).some((c) => cell(c) !== '');
}

/** SQLite `''`-escaped literal, or NULL. Numbers are emitted bare. */
function sqlText(v) {
  if (v === null || v === undefined || v === '') return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function sqlNum(v) {
  if (v === null || v === undefined || v === '') return 'NULL';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : 'NULL';
}

// ---------------------------------------------------------------------------
// Operator + value mapping
// ---------------------------------------------------------------------------

/**
 * The sheet's operator column. U+2264 / U+2265 are what Excel actually holds;
 * the ASCII spellings are accepted so a hand-typed row still imports.
 */
const OPERATOR_ALIASES = {
  '≤': '<=',
  '<=': '<=',
  '=<': '<=',
  '<': '<',
  '≥': '>=',
  '>=': '>=',
  '=>': '>=',
  '>': '>',
  '=': '==',
  '==': '==',
};

/**
 * Value tokens that mean "this analyte must not be found". A presence row
 * leaves the operator column EMPTY and puts the word in the value column, so
 * the operator has to be inferred from the value -- there is no other signal.
 */
const ABSENT_VALUES = new Set([
  'absent',
  'negative',
  'neg',
  'nd',
  'not detected',
  'none detected',
  'no growth',
]);

/**
 * Map one sheet row's operator + value into the `spec_limits` shape.
 * Returns { operator, value_min, value_max } or { error }.
 */
function mapOperator(operatorCell, valueCell) {
  const op = cell(operatorCell);
  const raw = cell(valueCell);

  if (ABSENT_VALUES.has(raw.toLowerCase())) {
    if (op !== '') {
      return {
        error: `operator "${op}" makes no sense against the presence value "${raw}" — leave the operator blank`,
      };
    }
    // A presence limit carries no magnitude and therefore no unit. The unit is
    // dropped by the caller; see parseAnalyteSheet.
    return { operator: 'absent', value_min: null, value_max: null };
  }

  if (op === '') {
    return {
      error: raw
        ? `no operator, and "${raw}" is not a presence value (absent / negative / not detected)`
        : 'no operator and no value',
    };
  }

  const mapped = OPERATOR_ALIASES[op];
  if (!mapped) return { error: `unrecognised operator "${op}"` };

  if (raw === '') return { error: `operator "${op}" with no value` };
  const n = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(n)) return { error: `value "${raw}" is not a number` };

  if (mapped === '<=' || mapped === '<') {
    return { operator: mapped, value_min: null, value_max: n };
  }
  return { operator: mapped, value_min: n, value_max: null };
}

// ---------------------------------------------------------------------------
// Sheet parsing
// ---------------------------------------------------------------------------

/** Scope phrasings that mean "no scope columns at all" (tenant-wide default). */
const TENANT_WIDE_SCOPES = new Set(['', 'all suppliers', 'all', 'any', 'all products']);

/**
 * Locate the header row by its first cell. The workbook puts a title banner in
 * row 1 and the header in row 2; keying off the text rather than the number
 * means a re-exported sheet that gains or loses a banner row still imports.
 */
function findHeaderRow(rows, firstHeaderCell) {
  for (let i = 0; i < rows.length; i++) {
    if (ciKey((rows[i] || [])[0]).startsWith(firstHeaderCell)) return i;
  }
  return -1;
}

/**
 * Parse the "Limits by Analyte" tab.
 *
 * @param {Array<Array<unknown>>} rows  sheet_to_json(..., {header:1}) output.
 * @returns {{analytes: Array<object>, errors: Array<string>}}
 */
function parseAnalyteSheet(rows) {
  const errors = [];
  const analytes = [];
  const header = findHeaderRow(rows || [], 'analyte');
  if (header < 0) {
    return {
      analytes,
      errors: ['"Limits by Analyte": no header row — expected a cell reading "analyte".'],
    };
  }

  const seen = new Map(); // ciKey -> first row number
  for (let i = header + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    if (isBlankRow(row)) continue;
    const rowNo = i + 1; // 1-based, as the spreadsheet shows it

    const name = cell(row[0]);
    if (!name) {
      errors.push(`"Limits by Analyte" row ${rowNo}: no analyte name, but the row is not empty.`);
      continue;
    }
    const key = ciKey(name);
    if (seen.has(key)) {
      errors.push(
        `"Limits by Analyte" row ${rowNo}: analyte "${name}" already appears on row ${seen.get(key)}. ` +
          'Each analyte must be listed once — that is what the tab is for.'
      );
      continue;
    }
    seen.set(key, rowNo);

    const mapped = mapOperator(row[1], row[2]);
    if (mapped.error) {
      errors.push(`"Limits by Analyte" row ${rowNo} (${name}): ${mapped.error}.`);
      continue;
    }

    const appliesTo = cell(row[4]);
    if (!TENANT_WIDE_SCOPES.has(appliesTo.toLowerCase())) {
      errors.push(
        `"Limits by Analyte" row ${rowNo} (${name}): "applies to" says "${appliesTo}". ` +
          'This importer only writes tenant-wide limits (all scope columns NULL); ' +
          'a supplier-, product- or doctype-scoped limit has to be set in the app.'
      );
      continue;
    }

    // A presence limit has no magnitude, so a unit on it would be noise the
    // comparator would then try to reconcile.
    const unit = mapped.operator === 'absent' ? null : cell(row[3]) || null;

    analytes.push({
      row: rowNo,
      name,
      operator: mapped.operator,
      value_min: mapped.value_min,
      value_max: mapped.value_max,
      unit,
      notes: cell(row[5]) || null,
      severity: 'alert',
    });
  }

  return { analytes, errors };
}

/**
 * Parse the "Test Name Variants" tab.
 *
 * @returns {{variants: Array<object>, errors: Array<string>}}
 */
function parseVariantSheet(rows) {
  const errors = [];
  const variants = [];
  const header = findHeaderRow(rows || [], 'analyte');
  if (header < 0) {
    return {
      variants,
      errors: ['"Test Name Variants": no header row — expected a cell reading "analyte...".'],
    };
  }

  for (let i = header + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    if (isBlankRow(row)) continue;
    const rowNo = i + 1;
    const analyte = cell(row[0]);
    const printed = cell(row[1]);
    if (!analyte || !printed) {
      errors.push(
        `"Test Name Variants" row ${rowNo}: needs both an analyte and a printed test name ` +
          `(got analyte="${analyte}", printed="${printed}").`
      );
      continue;
    }
    variants.push({ row: rowNo, analyte, printed, provenance: cell(row[2]) || null });
  }

  return { variants, errors };
}

// ---------------------------------------------------------------------------
// Alias assembly
// ---------------------------------------------------------------------------

/**
 * Fold the variant rows onto their analytes.
 *
 * A variant whose analyte matches no row on the Limits tab is a SHEET ERROR,
 * not something to guess at. It is the exact failure that makes a limit never
 * fire, so it is reported and never silently dropped into a new analyte.
 *
 * @returns {{byAnalyte: Map<string, Array<object>>, unmatched: Array<object>}}
 *          byAnalyte is keyed by the analyte's ciKey.
 */
function buildAliasMap(analytes, variants) {
  const known = new Map(analytes.map((a) => [ciKey(a.name), a]));
  const byAnalyte = new Map();
  const unmatched = [];
  for (const v of variants) {
    const key = ciKey(v.analyte);
    if (!known.has(key)) {
      unmatched.push(v);
      continue;
    }
    if (!byAnalyte.has(key)) byAnalyte.set(key, []);
    byAnalyte.get(key).push(v);
  }
  return { byAnalyte, unmatched };
}

/**
 * Merge printed spellings into an analyte's existing alias array.
 *
 * ADDITIVE ONLY. `existing` survives verbatim, in order, whatever the sheet
 * says -- the sheet is one person's view of the spellings, not the whole truth.
 *
 * Two kinds of incoming alias are dropped rather than stored:
 *   - a duplicate of one already present (compared case-insensitively);
 *   - one that is just the analyte's own name in different case. `matchSpecTest`
 *     tries the canonical name before the aliases and normalises case, so such
 *     an alias can never be the thing that makes a match -- it is pure noise.
 *
 * @returns {{merged: string[], added: string[], kept: number,
 *            duplicates: string[], sameAsName: string[]}}
 */
function mergeAliases(existing, incoming, canonicalName) {
  const merged = [];
  const index = new Set();
  for (const a of existing || []) {
    const s = cell(a);
    if (!s) continue;
    const k = ciKey(s);
    if (index.has(k)) continue;
    index.add(k);
    merged.push(s);
  }
  const kept = merged.length;

  const nameKey = ciKey(canonicalName);
  const added = [];
  const duplicates = [];
  const sameAsName = [];
  for (const a of incoming || []) {
    const s = cell(a);
    if (!s) continue;
    const k = ciKey(s);
    if (k === nameKey) {
      sameAsName.push(s);
      continue;
    }
    if (index.has(k)) {
      duplicates.push(s);
      continue;
    }
    index.add(k);
    merged.push(s);
    added.push(s);
  }

  return { merged, added, kept, duplicates, sameAsName };
}

// ---------------------------------------------------------------------------
// Unit validation
// ---------------------------------------------------------------------------

/**
 * A unit the engine cannot place lands in the `other:*` family, and
 * `unitFactor` then refuses to compare it against anything -- every result for
 * that analyte becomes `not_checked` forever, which looks like silence rather
 * than like a misconfiguration. A typo here is therefore fatal to the import,
 * not a warning.
 *
 * A BLANK unit is fine and means the opposite thing: "unknown", which the
 * comparator treats as agreement, because COAs routinely print the unit once in
 * a header and omit it per row.
 *
 * @param {(raw: unknown) => {family: string}} normalizeUnit  from the engine.
 */
function validateUnit(unit, normalizeUnit) {
  if (unit === null || unit === undefined || cell(unit) === '') return null;
  const info = normalizeUnit(unit);
  if (String(info.family).startsWith('other:')) {
    return (
      `unit "${unit}" is not one the spec engine recognises (it resolves to "${info.family}"). ` +
      'A limit in an unrecognised unit is never comparable, so every result for this analyte ' +
      'would come back "not checked" forever. Fix the spelling — CFU/g, CFU/mL, MPN/g, %, pH.'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Plan building
// ---------------------------------------------------------------------------

const LIMIT_FIELDS = ['operator', 'value_min', 'value_max', 'unit'];

/** Do two limits differ in a way that changes what gets judged? */
function limitMateriallyDiffers(existing, desired) {
  return LIMIT_FIELDS.some((f) => {
    const a = existing[f];
    const b = desired[f];
    if (a === null || a === undefined || a === '') return !(b === null || b === undefined || b === '');
    if (b === null || b === undefined || b === '') return true;
    if (f === 'value_min' || f === 'value_max') return Number(a) !== Number(b);
    return String(a) !== String(b);
  });
}

/**
 * Turn parsed sheets plus the current database contents into an executable plan.
 *
 * @param {object} input
 * @param {string} input.tenantId
 * @param {Array<object>} input.analytes        parseAnalyteSheet output
 * @param {Array<object>} input.variants        parseVariantSheet output
 * @param {Array<object>} input.existingTests   {id, name, aliases: string[], default_unit}
 * @param {Array<object>} input.existingLimits  raw spec_limits rows for the tenant
 * @param {Function} input.normalizeUnit        engine import
 * @param {Function} input.validateLimitShape   engine import
 * @param {Function} [input.newId]              id generator (injectable for tests)
 * @returns {object} plan
 */
function buildPlan(input) {
  const {
    tenantId,
    analytes,
    variants,
    existingTests,
    existingLimits,
    normalizeUnit,
    validateLimitShape,
    newId,
  } = input;

  const errors = [];
  const { byAnalyte, unmatched } = buildAliasMap(analytes, variants);

  for (const v of unmatched) {
    errors.push(
      `"Test Name Variants" row ${v.row}: analyte "${v.analyte}" (for the printed name ` +
        `"${v.printed}") matches nothing on the "Limits by Analyte" tab. That spelling would ` +
        'never be checked. Fix the sheet — do not let the importer invent an analyte.'
    );
  }

  const testsByName = new Map((existingTests || []).map((t) => [ciKey(t.name), t]));
  // A tenant-wide limit is the one with all three scope columns NULL.
  const limitsByTest = new Map();
  for (const l of existingLimits || []) {
    if (l.supplier_id || l.document_type_id || l.product_id) continue;
    limitsByTest.set(l.spec_test_id, l);
  }

  const tests = [];
  const limits = [];

  for (const a of analytes) {
    const unitError = validateUnit(a.unit, normalizeUnit);
    if (unitError) {
      errors.push(`"Limits by Analyte" row ${a.row} (${a.name}): ${unitError}`);
    }
    const shapeError = validateLimitShape({
      operator: a.operator,
      value_min: a.value_min,
      value_max: a.value_max,
    });
    if (shapeError) {
      errors.push(`"Limits by Analyte" row ${a.row} (${a.name}): ${shapeError}`);
    }

    const key = ciKey(a.name);
    const incoming = (byAnalyte.get(key) || []).map((v) => v.printed);
    const existingTest = testsByName.get(key) || null;
    const merge = mergeAliases(existingTest ? existingTest.aliases : [], incoming, a.name);

    // default_unit is a FALLBACK the comparator reaches for when a limit omits
    // its unit. Filling a blank one is helpful; overwriting one someone chose is
    // not, so an existing value is left exactly as it is.
    const existingDefaultUnit = existingTest ? cell(existingTest.default_unit) : '';
    const setDefaultUnit = !existingDefaultUnit && a.unit ? a.unit : null;

    const testPlan = {
      row: a.row,
      name: a.name,
      storedName: existingTest ? existingTest.name : a.name,
      id: existingTest ? existingTest.id : newId(),
      action: existingTest ? 'update' : 'create',
      aliases: merge.merged,
      aliasesAdded: merge.added,
      aliasesKept: merge.kept,
      aliasesDuplicate: merge.duplicates,
      aliasesSameAsName: merge.sameAsName,
      setDefaultUnit,
      defaultUnit: existingTest ? existingTest.default_unit || setDefaultUnit : a.unit,
    };
    if (existingTest && merge.added.length === 0 && !setDefaultUnit) {
      testPlan.action = 'unchanged';
    }
    if (existingTest && existingTest.name !== a.name) {
      testPlan.casingDiffers = true;
    }
    tests.push(testPlan);

    const desired = {
      operator: a.operator,
      value_min: a.value_min,
      value_max: a.value_max,
      unit: a.unit,
      severity: a.severity,
      notes: a.notes,
    };
    const existingLimit = existingTest ? limitsByTest.get(existingTest.id) || null : null;

    const limitPlan = {
      row: a.row,
      testName: a.name,
      specTestId: testPlan.id,
      id: existingLimit ? existingLimit.id : newId(),
      action: existingLimit ? 'unchanged' : 'create',
      desired,
      before: existingLimit
        ? {
            operator: existingLimit.operator,
            value_min: existingLimit.value_min === null ? null : Number(existingLimit.value_min),
            value_max: existingLimit.value_max === null ? null : Number(existingLimit.value_max),
            unit: existingLimit.unit,
            notes: existingLimit.notes,
            version: Number(existingLimit.version || 1),
          }
        : null,
      version: existingLimit ? Number(existingLimit.version || 1) : 1,
      bumpVersion: false,
    };

    if (existingLimit) {
      const material = limitMateriallyDiffers(limitPlan.before, desired);
      const cosmetic =
        cell(existingLimit.notes) !== cell(desired.notes) ||
        cell(existingLimit.severity) !== cell(desired.severity) ||
        Number(existingLimit.active) !== 1;
      if (material) {
        limitPlan.action = 'update';
        limitPlan.bumpVersion = true;
        limitPlan.version = limitPlan.before.version + 1;
      } else if (cosmetic) {
        // Notes and severity do not change any verdict, so `version` -- which
        // is frozen into document_spec_checks.limit_snapshot as the audit trail
        // of WHAT WAS JUDGED -- must not move for them.
        limitPlan.action = 'update';
      }
    }

    limits.push(limitPlan);
  }

  const count = (arr, action) => arr.filter((x) => x.action === action).length;

  return {
    tenantId,
    tests,
    limits,
    errors,
    unmatchedVariants: unmatched,
    summary: {
      analytesCreated: count(tests, 'create'),
      analytesUpdated: count(tests, 'update'),
      analytesUnchanged: count(tests, 'unchanged'),
      aliasesAdded: tests.reduce((n, t) => n + t.aliasesAdded.length, 0),
      aliasesKept: tests.reduce((n, t) => n + t.aliasesKept, 0),
      aliasesSkipped: tests.reduce(
        (n, t) => n + t.aliasesDuplicate.length + t.aliasesSameAsName.length,
        0
      ),
      limitsCreated: count(limits, 'create'),
      limitsUpdated: count(limits, 'update'),
      limitsUnchanged: count(limits, 'unchanged'),
      versionBumps: limits.filter((l) => l.bumpVersion).length,
      errors: errors.length,
    },
  };
}

// ---------------------------------------------------------------------------
// SQL rendering
// ---------------------------------------------------------------------------

/**
 * Render the plan as SQL statements. Every value goes through sqlText/sqlNum --
 * the wrangler CLI takes a statement string, not bound parameters, so escaping
 * is this module's job and is done in exactly one place.
 *
 * Scope columns are written as literal NULL, never ''. See migration 0086: NULL
 * is what the read path branches on, and the uniqueness index COALESCEs instead.
 */
function planToSql(plan) {
  const stmts = [];
  const t = sqlText(plan.tenantId);

  for (const test of plan.tests) {
    if (test.action === 'create') {
      stmts.push(
        `INSERT INTO spec_tests (id, tenant_id, name, aliases, default_unit)\n` +
          `VALUES (${sqlText(test.id)}, ${t}, ${sqlText(test.name)}, ` +
          `${sqlText(JSON.stringify(test.aliases))}, ${sqlText(test.defaultUnit)});`
      );
    } else if (test.action === 'update') {
      const sets = [`aliases = ${sqlText(JSON.stringify(test.aliases))}`];
      if (test.setDefaultUnit) sets.push(`default_unit = ${sqlText(test.setDefaultUnit)}`);
      sets.push(`updated_at = datetime('now')`);
      stmts.push(`UPDATE spec_tests SET ${sets.join(', ')} WHERE id = ${sqlText(test.id)};`);
    }
  }

  for (const limit of plan.limits) {
    const d = limit.desired;
    if (limit.action === 'create') {
      stmts.push(
        `INSERT INTO spec_limits (id, tenant_id, spec_test_id, supplier_id, document_type_id,\n` +
          `  product_id, operator, value_min, value_max, unit, severity, notes, active, version)\n` +
          `VALUES (${sqlText(limit.id)}, ${t}, ${sqlText(limit.specTestId)}, NULL, NULL,\n` +
          `  NULL, ${sqlText(d.operator)}, ${sqlNum(d.value_min)}, ${sqlNum(d.value_max)}, ` +
          `${sqlText(d.unit)}, ${sqlText(d.severity)}, ${sqlText(d.notes)}, 1, 1);`
      );
    } else if (limit.action === 'update') {
      stmts.push(
        `UPDATE spec_limits SET operator = ${sqlText(d.operator)}, ` +
          `value_min = ${sqlNum(d.value_min)}, value_max = ${sqlNum(d.value_max)}, ` +
          `unit = ${sqlText(d.unit)}, severity = ${sqlText(d.severity)}, ` +
          `notes = ${sqlText(d.notes)}, active = 1, version = ${limit.version}, ` +
          `updated_at = datetime('now') WHERE id = ${sqlText(limit.id)};`
      );
    }
  }

  return stmts;
}

// ---------------------------------------------------------------------------
// Plan rendering (human)
// ---------------------------------------------------------------------------

function describeLimit(l) {
  if (l.operator === 'absent') return 'absent';
  const unit = l.unit ? ` ${l.unit}` : '';
  if (l.operator === 'between') return `between ${l.value_min} and ${l.value_max}${unit}`;
  const v = l.value_max === null || l.value_max === undefined ? l.value_min : l.value_max;
  return `${l.operator} ${v}${unit}`;
}

/** Render the plan as the lines the script prints. Returns an array of lines. */
function formatPlan(plan, opts = {}) {
  const out = [];
  const s = plan.summary;

  out.push('');
  out.push(`Spec limits import — tenant ${plan.tenantId}${opts.targetLabel ? ` (${opts.targetLabel})` : ''}`);
  out.push('='.repeat(72));

  out.push('');
  out.push('Analytes');
  out.push('-'.repeat(72));
  for (const t of plan.tests) {
    const verb = t.action === 'create' ? 'CREATE  ' : t.action === 'update' ? 'UPDATE  ' : 'unchanged';
    out.push(`  ${verb} ${t.name}`);
    if (t.casingDiffers) {
      out.push(`            stored as "${t.storedName}" — kept, not renamed`);
    }
    if (t.action === 'create') {
      out.push(
        `            ${t.aliases.length} alias(es), default unit ${t.defaultUnit || '(none)'}`
      );
    } else {
      out.push(
        `            aliases: ${t.aliasesKept} kept, ${t.aliasesAdded.length} added` +
          (t.setDefaultUnit ? `; default unit set to ${t.setDefaultUnit}` : '')
      );
    }
    if (t.aliasesAdded.length) {
      out.push(`            + ${t.aliasesAdded.join(', ')}`);
    }
    if (t.aliasesSameAsName.length) {
      out.push(
        `            skipped (same as the analyte name, matched already): ${t.aliasesSameAsName.join(', ')}`
      );
    }
    if (t.aliasesDuplicate.length) {
      out.push(`            skipped (already present): ${t.aliasesDuplicate.join(', ')}`);
    }
  }

  out.push('');
  out.push('Limits (tenant-wide — supplier, document type and product all NULL)');
  out.push('-'.repeat(72));
  for (const l of plan.limits) {
    const verb =
      l.action === 'create' ? 'CREATE  ' : l.action === 'update' ? 'UPDATE  ' : 'unchanged';
    out.push(`  ${verb} ${l.testName}: ${describeLimit(l.desired)}`);
    if (l.action === 'update' && l.before) {
      out.push(`            was ${describeLimit(l.before)}`);
      out.push(
        l.bumpVersion
          ? `            threshold moved — version ${l.before.version} → ${l.version}`
          : `            notes/severity only — version stays at ${l.version}`
      );
    }
  }

  if (plan.errors.length) {
    out.push('');
    out.push('ERRORS — nothing will be written until these are fixed');
    out.push('-'.repeat(72));
    for (const e of plan.errors) out.push(`  ${e}`);
  }

  out.push('');
  out.push('Summary');
  out.push('-'.repeat(72));
  out.push(`  Analytes  created ${s.analytesCreated}, updated ${s.analytesUpdated}, unchanged ${s.analytesUnchanged}`);
  out.push(`  Aliases   added ${s.aliasesAdded}, kept ${s.aliasesKept}, skipped ${s.aliasesSkipped}`);
  out.push(`  Limits    created ${s.limitsCreated}, updated ${s.limitsUpdated}, unchanged ${s.limitsUnchanged}`);
  out.push(`  Version bumps ${s.versionBumps}`);
  out.push(`  Errors    ${s.errors}`);
  out.push('');

  return out;
}

module.exports = {
  cell,
  ciKey,
  sqlText,
  sqlNum,
  mapOperator,
  parseAnalyteSheet,
  parseVariantSheet,
  buildAliasMap,
  mergeAliases,
  validateUnit,
  limitMateriallyDiffers,
  buildPlan,
  planToSql,
  formatPlan,
  describeLimit,
};
