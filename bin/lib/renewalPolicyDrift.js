/**
 * bin/lib/renewalPolicyDrift.js — the decision half of
 * `bin/fix-starter-pack-renewal-policy`.
 *
 * PURE: rows in, plan out. No D1, no network, no clock. The script does the
 * reading and the writing; everything that decides whether a row is corrected
 * is here, so `tests/unit/renewalPolicyDrift.test.ts` can exercise the rules
 * without a database.
 *
 * ---------------------------------------------------------------------------
 * WHAT WENT WRONG, AND THEREFORE WHAT THIS MAY TOUCH
 * ---------------------------------------------------------------------------
 * `POST /api/document-types` has always proposed a renewal setting from the
 * type's name (a Certificate of Analysis does not renew; a specification sheet
 * renews at three years). The STARTER PACK — which is how a real tenant
 * actually receives its 27 types — named neither column, so every row it wrote
 * took the migration defaults, `renewal_policy = 'inherit'` and
 * `renewal_interval_months = NULL`. The 0096 and 0097 backfills ran once, at
 * migration time, over the rows that existed then; a tenant created afterwards
 * never met them.
 *
 * So the drift this corrects has one exact signature: a row that still holds
 * BOTH migration defaults while its name derives something else.
 *
 * ---------------------------------------------------------------------------
 * TELLING A DEFAULT FROM A DECISION — honestly
 * ---------------------------------------------------------------------------
 * There is no `renewal_policy_updated_by` stamp on `document_types` (0111 added
 * that pattern for the alert lead time, not for this), and `updated_at` moves
 * for every edit of every column, so it proves nothing. Two things are real
 * evidence and both are used:
 *
 *   1. THE STORED VALUE ITSELF. A row NOT at the migration defaults was written
 *      by somebody — the API's own proposal, an admin, or a backfill. It is
 *      never touched here, whatever its name suggests. An admin who deliberately
 *      set a type to 'none' keeps it; a COA an admin deliberately set to
 *      'period' keeps that too.
 *   2. THE AUDIT LOG. `document_type_updated` rows carry `{changes: body}`, so
 *      an edit that named `renewal_policy` or `renewal_interval_months` is
 *      findable. `document_type_created` rows carry the values the create path
 *      settled on. Either one naming a renewal key marks the row as
 *      human-decided, and it is then left alone even if it sits at the
 *      defaults — which is the case of an admin who looked at a COA and chose
 *      'inherit' on purpose.
 *
 * Where neither applies — a row at the migration defaults with no audit trail
 * naming a renewal key, which is exactly what the starter pack leaves — the
 * correction is applied and the report says so. That is the honest bound of
 * this script and the report prints it every run.
 */

const { defaultRenewalSettingForTypeName } = require('./shared/renewalPeriod.js');

/** The pair a row holds when nothing has ever written it (0096 + 0097). */
const MIGRATION_DEFAULT_POLICY = 'inherit';

/** Why a row was not corrected. */
const SKIP_REASONS = {
  configured: 'already carries a renewal setting somebody wrote',
  human_decided: 'a person is recorded as having set it',
};

/** Normalize one stored row into the pair the resolver reads. */
function storedSetting(row) {
  return {
    policy: row.renewal_policy || MIGRATION_DEFAULT_POLICY,
    interval_months:
      row.renewal_interval_months === undefined || row.renewal_interval_months === null
        ? null
        : Number(row.renewal_interval_months),
  };
}

function sameSetting(a, b) {
  return a.policy === b.policy && a.interval_months === b.interval_months;
}

/** Is this row still exactly as the migration left it? */
function atMigrationDefaults(stored) {
  return stored.policy === MIGRATION_DEFAULT_POLICY && stored.interval_months === null;
}

/**
 * Plan one tenant.
 *
 * @param {Array<{id:string,name:string,slug?:string,active?:number,
 *                renewal_policy:string|null,renewal_interval_months:number|null,
 *                human_decided?:boolean}>} types
 * @returns {{total:number, corrections:Array, skipped:Array, agree:number}}
 */
function planRenewalPolicyDrift(types) {
  const corrections = [];
  const skipped = [];
  let agree = 0;

  for (const row of types || []) {
    const stored = storedSetting(row);
    const want = defaultRenewalSettingForTypeName(row.name || '');

    if (sameSetting(stored, want)) {
      agree += 1;
      continue;
    }

    const entry = {
      id: row.id,
      name: row.name,
      slug: row.slug ?? null,
      active: row.active === undefined ? null : Number(row.active),
      from: stored,
      to: want,
    };

    // A row somebody has already written is never re-decided by a script. The
    // point of this pass is rows nothing ever wrote.
    if (!atMigrationDefaults(stored)) {
      skipped.push({ ...entry, reason: 'configured' });
      continue;
    }
    if (row.human_decided) {
      skipped.push({ ...entry, reason: 'human_decided' });
      continue;
    }

    corrections.push(entry);
  }

  return { total: (types || []).length, corrections, skipped, agree };
}

/**
 * The UPDATE for one correction.
 *
 * The WHERE restates the migration defaults, so the write is idempotent and a
 * plan read minutes ago cannot overwrite a decision made since: if anything has
 * touched the row in between, the statement matches nothing.
 */
function correctionToSql(tenantId, correction, sqlStr) {
  const months = correction.to.interval_months;
  return (
    `UPDATE document_types SET renewal_policy = ${sqlStr(correction.to.policy)}, ` +
    `renewal_interval_months = ${months === null ? 'NULL' : String(months)}, ` +
    `updated_at = datetime('now') ` +
    `WHERE id = ${sqlStr(correction.id)} AND tenant_id = ${sqlStr(tenantId)} ` +
    `AND renewal_policy = ${sqlStr(MIGRATION_DEFAULT_POLICY)} AND renewal_interval_months IS NULL;`
  );
}

/** Renewal keys whose presence in an audit payload proves a person chose. */
const RENEWAL_KEYS = ['renewal_policy', 'renewal_interval_months'];

/**
 * Does one audit row's details JSON name a renewal setting?
 *
 * `document_type_updated` files `{changes: <request body>}`; the create path
 * files the settled values at the top level. Both are read, and an unparseable
 * blob is not evidence (it returns false rather than guessing).
 */
function auditNamesRenewal(details) {
  if (!details) return false;
  let parsed;
  try {
    parsed = JSON.parse(details);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;
  const bodies = [parsed, parsed.changes].filter((b) => b && typeof b === 'object');
  return bodies.some((b) => RENEWAL_KEYS.some((k) => Object.prototype.hasOwnProperty.call(b, k)));
}

module.exports = {
  MIGRATION_DEFAULT_POLICY,
  SKIP_REASONS,
  planRenewalPolicyDrift,
  correctionToSql,
  auditNamesRenewal,
  storedSetting,
  atMigrationDefaults,
};
