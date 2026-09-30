/**
 * Scope clauses as SQL over `documents d` — and the SAME rules as a JS
 * predicate over a loaded subject.
 *
 * Two forms because two paths need them: the scope/text path filters in SQL
 * (one batch: the page plus every facet), while the coverage path loads its
 * candidates unfiltered and applies scope in memory, so each facet's counts
 * can leave out that facet's own selection (sticky exclusion) without a second
 * judging pass. `tests/api/search-query-compose.test.ts` and
 * `tests/api/search-scope-fields.test.ts` pin that the two agree on every
 * clause.
 *
 * The COMPUTED attributes (spec result, renewal state) are one SQL expression
 * each, used by both forms: the WHERE clause filters on it, and the coverage
 * path SELECTs it into the subject (`SCOPE_ATTR_COLUMNS`) so the JS mirror
 * compares the very value SQL computed. There is no second implementation to
 * drift. The renewal expression is pinned against `resolveRenewalAlertLead` +
 * the alert engine's `classifyDaysUntil` by `tests/api/search-renewal-state.test.ts`.
 *
 * Rules:
 *   - clauses AND together; values inside one clause OR together;
 *   - an `exclude` clause keeps every document EXCEPT its values (a document
 *     with no supplier is not "from supplier X", so it stays);
 *   - with no status clause, only active documents are searched (as before);
 *     'deleted' is never searchable;
 *   - product = linked through document_products OR through a linked lot row's
 *     product (a split COA is linked only that way);
 *   - requirement / claim = a link that is not REJECTED (a suggested link is a
 *     rule's default a person has not overruled; a rejected one is a person
 *     saying no, and never counts);
 *   - owner / intake source: `__none__` is "nothing recorded";
 *   - uploaded / approved dates compare at DAY granularity; `created_at` holds
 *     both `YYYY-MM-DD HH:MM:SS` and ISO `…T…Z` spellings — a day-start string
 *     bound sorts correctly against both. An approved clause never matches a
 *     document whose approval was not recorded, except `missing` which asks
 *     for exactly those.
 */

import type { Clause } from '../../../shared/searchQuery';
import type { FieldKey } from '../../../shared/searchFields';
import { NONE_VALUE, SEARCH_FIELDS, STATUS_VALUES } from '../../../shared/searchFields';
import { DEFAULT_RENEWAL_ALERT_LEAD_DAYS, MAX_RENEWAL_ALERT_LEAD_DAYS, MIN_RENEWAL_ALERT_LEAD_DAYS } from '../../../shared/renewalLeadTime';

export interface ScopeAttrs {
  supplier_id: string | null;
  document_type_id: string | null;
  product_ids: string[];
  status: string | null;
  created_at: string | null;
  // --- Phase 3 ---
  requirement_ids?: string[];
  claim_ids?: string[];
  /** Display names for those ids. */
  names?: Record<string, string>;
  spec_verdict?: string | null;
  renewal_state?: string | null;
  classification?: string | null;
  owner?: string | null;
  intake_source?: string | null;
  approved_at?: string | null;
}

export interface CompiledScope {
  clauses: Clause[];
  /** The day uploaded-date windows (and renewal states) count from (UTC). */
  today: string;
}

export function dayOffset(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export function compileScope(allClauses: Clause[], now: Date = new Date()): CompiledScope {
  return {
    clauses: allClauses.filter((c) => SEARCH_FIELDS[c.field].class === 'scope'),
    today: now.toISOString().slice(0, 10),
  };
}

/** [lower-inclusive, upper-exclusive] day bounds for an uploaded / approved clause. */
export function uploadedBounds(c: Pick<Clause, 'op' | 'values'>, today: string): { from: string | null; to: string | null } {
  const [a, b] = c.values;
  switch (c.op) {
    case 'within': return { from: dayOffset(today, -Number(a)), to: null };
    case 'older_than': return { from: null, to: dayOffset(today, -Number(a)) };
    case 'on': return { from: a, to: dayOffset(a, 1) };
    case 'between': return { from: a, to: dayOffset(b ?? a, 1) };
    case 'before': return { from: null, to: a };
    case 'after': return { from: dayOffset(a, 1), to: null };
    default: return { from: null, to: null };
  }
}

function placeholders(n: number): string {
  return Array(n).fill('?').join(',');
}

function isoDayLiteral(today: string): string {
  // Inlined as a literal (the subject SELECT is a fixed string): validated, so never an injection.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`bad day ${today}`);
  return `'${today}'`;
}

// ===========================================================================
// Computed attributes — ONE SQL expression each, over `documents d`
// ===========================================================================

/**
 * The document's spec result: the WORST judgement its register (0085) and its
 * gaps (0109) hold. No rows at all is 'none' ("no results judged"), never a pass.
 */
export const SPEC_VERDICT_SQL = `(CASE
    WHEN EXISTS (SELECT 1 FROM document_spec_checks sx WHERE sx.document_id = d.id AND sx.verdict = 'out_of_spec') THEN 'out_of_spec'
    WHEN EXISTS (SELECT 1 FROM document_spec_checks sx WHERE sx.document_id = d.id AND sx.verdict = 'not_checked')
      OR EXISTS (SELECT 1 FROM document_spec_gaps gx WHERE gx.document_id = d.id) THEN 'not_checked'
    WHEN EXISTS (SELECT 1 FROM document_spec_checks sx WHERE sx.document_id = d.id) THEN 'in_spec'
    ELSE 'none' END)`;

const usableLead = (col: string) => `${col} BETWEEN ${MIN_RENEWAL_ALERT_LEAD_DAYS} AND ${MAX_RENEWAL_ALERT_LEAD_DAYS} AND ${col} = CAST(${col} AS INTEGER)`;

/**
 * The warning time (days) that applies to this document — `resolveRenewalAlertLead`
 * in SQL: the type's override, else the organization's, else the default. A
 * value outside the range falls through, exactly as the resolver's does.
 */
export const RENEWAL_LEAD_SQL = `COALESCE(
    (SELECT CAST(dtl.renewal_alert_lead_days AS INTEGER) FROM document_types dtl
      WHERE dtl.id = d.document_type_id AND ${usableLead('dtl.renewal_alert_lead_days')}),
    (SELECT CAST(tl.renewal_alert_lead_days AS INTEGER) FROM tenants tl
      WHERE tl.id = d.tenant_id AND ${usableLead('tl.renewal_alert_lead_days')}),
    ${DEFAULT_RENEWAL_ALERT_LEAD_DAYS})`;

/**
 * The document's renewal state on its CONFIRMED renewal date, by the alert
 * engine's own rules (functions/lib/expirations.ts#classifyDaysUntil): a
 * keep_current record is never due; otherwise a date before today is past due
 * (`expired` / `overdue`), one within the warning time is expiring, the rest
 * current. No date + a recorded decision, or a type whose policy is none, is
 * "does not renew"; no date and nobody decided is "not set".
 */
export function renewalStateSql(today: string): string {
  const t = isoDayLiteral(today);
  return `(CASE
    WHEN d.renewal_due_date IS NULL OR julianday(d.renewal_due_date) IS NULL
      OR d.renewal_due_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' THEN
      CASE WHEN d.renewal_decision IS NOT NULL
             OR EXISTS (SELECT 1 FROM document_types dtp WHERE dtp.id = d.document_type_id AND dtp.renewal_policy = 'none')
           THEN 'does_not_renew' ELSE 'not_set' END
    WHEN d.renewal_type = 'keep_current' THEN 'current'
    WHEN d.renewal_due_date < ${t} THEN 'past_due'
    WHEN CAST(julianday(d.renewal_due_date) - julianday(${t}) AS INTEGER) <= ${RENEWAL_LEAD_SQL} THEN 'expiring'
    ELSE 'current' END)`;
}

/** The non-rejected requirement / claim links, as char(31)-joined `id char(30) name` pairs. */
const REQ_IDS_SQL = `(SELECT GROUP_CONCAT(drx.requirement_id || char(30) || COALESCE(rx.name, ''), char(31))
    FROM document_requirements drx LEFT JOIN requirements rx ON rx.id = drx.requirement_id
    WHERE drx.document_id = d.id AND drx.status != 'rejected')`;
const CLAIM_IDS_SQL = `(SELECT GROUP_CONCAT(dcx.claim_type_id || char(30) || COALESCE(cx.name, ''), char(31))
    FROM document_claims dcx LEFT JOIN claim_types cx ON cx.id = dcx.claim_type_id
    WHERE dcx.document_id = d.id AND dcx.status != 'rejected')`;

const OWNER_SQL = `NULLIF(TRIM(d.owner), '')`;
const INTAKE_SQL = `NULLIF(TRIM(d.intake_source), '')`;

/**
 * What the coverage path SELECTs into each subject so the JS mirror compares
 * the very values SQL computes. Read back by `scopeAttrsFromRow`.
 */
export function scopeAttrColumns(today: string): string {
  return `${REQ_IDS_SQL} AS scope_requirement_ids,
  ${CLAIM_IDS_SQL} AS scope_claim_ids,
  ${SPEC_VERDICT_SQL} AS scope_spec_verdict,
  ${renewalStateSql(today)} AS scope_renewal_state,
  d.classification_status AS scope_classification,
  ${OWNER_SQL} AS scope_owner,
  ${INTAKE_SQL} AS scope_intake_source,
  d.approved_at AS scope_approved_at`;
}

export interface ScopeAttrRow {
  scope_requirement_ids?: string | null;
  scope_claim_ids?: string | null;
  scope_spec_verdict?: string | null;
  scope_renewal_state?: string | null;
  scope_classification?: string | null;
  scope_owner?: string | null;
  scope_intake_source?: string | null;
  scope_approved_at?: string | null;
}

export function scopeAttrsFromRow(r: ScopeAttrRow): Required<Pick<ScopeAttrs, 'requirement_ids' | 'claim_ids' | 'names' | 'spec_verdict' | 'renewal_state' | 'classification' | 'owner' | 'intake_source' | 'approved_at'>> {
  const names: Record<string, string> = {};
  const list = (v: string | null | undefined) => (v ? v.split('\u001f').filter(Boolean) : []).map((pair) => {
    const [id, name] = pair.split('\u001e');
    if (id && name) names[id] = name;
    return id;
  }).filter(Boolean);
  return {
    requirement_ids: list(r.scope_requirement_ids),
    claim_ids: list(r.scope_claim_ids),
    names,
    spec_verdict: r.scope_spec_verdict ?? 'none',
    renewal_state: r.scope_renewal_state ?? 'not_set',
    classification: r.scope_classification ?? null,
    owner: r.scope_owner ?? null,
    intake_source: r.scope_intake_source ?? null,
    approved_at: r.scope_approved_at ?? null,
  };
}

// ===========================================================================
// SQL
// ===========================================================================

function negate(c: Clause, sql: string): string {
  // A NULL inside must not turn "not X" into "not anything": COALESCE to false first.
  return c.exclude ? `NOT COALESCE((${sql}), 0)` : sql;
}

/** `col IN (...)`, with `__none__` meaning NULL. */
function enumSql(c: Clause, col: string): { sql: string; params: unknown[] } {
  const real = c.values.filter((v) => v !== NONE_VALUE);
  const none = c.values.includes(NONE_VALUE);
  const parts: string[] = [];
  if (real.length) parts.push(`${col} IN (${placeholders(real.length)})`);
  if (none) parts.push(`${col} IS NULL`);
  return { sql: negate(c, parts.length ? `(${parts.join(' OR ')})` : '0'), params: real };
}

function dateSql(c: Clause, col: string, today: string): { sql: string; params: unknown[] } {
  if (c.op === 'missing') return { sql: `${col} IS NULL`, params: [] };
  const { from, to } = uploadedBounds(c, today);
  const parts: string[] = [`${col} IS NOT NULL`];
  const params: unknown[] = [];
  if (from) { parts.push(`${col} >= ?`); params.push(from); }
  if (to) { parts.push(`${col} < ?`); params.push(to); }
  return { sql: parts.join(' AND '), params };
}

function clauseSql(c: Clause, today: string): { sql: string; params: unknown[] } {
  const vals = c.values;
  const inList = (col: string) => (c.exclude
    ? { sql: `(${col} IS NULL OR ${col} NOT IN (${placeholders(vals.length)}))`, params: vals }
    : { sql: `${col} IN (${placeholders(vals.length)})`, params: vals });
  const p = placeholders(vals.length);
  switch (c.field) {
    case 'supplier': return inList('d.supplier_id');
    case 'document_type': return inList('d.document_type_id');
    case 'status': return inList('d.status');
    case 'product': {
      const has = `(EXISTS (SELECT 1 FROM document_products dp WHERE dp.document_id = d.id AND dp.product_id IN (${p}))
         OR EXISTS (SELECT 1 FROM document_lots dl JOIN lots l ON l.id = dl.lot_id WHERE dl.document_id = d.id AND l.product_id IN (${p})))`;
      return { sql: c.exclude ? `NOT ${has}` : has, params: [...vals, ...vals] };
    }
    case 'requirement': {
      const has = `EXISTS (SELECT 1 FROM document_requirements drq WHERE drq.document_id = d.id AND drq.status != 'rejected' AND drq.requirement_id IN (${p}))`;
      return { sql: c.exclude ? `NOT ${has}` : has, params: vals };
    }
    case 'claim': {
      const has = `EXISTS (SELECT 1 FROM document_claims dcq WHERE dcq.document_id = d.id AND dcq.status != 'rejected' AND dcq.claim_type_id IN (${p}))`;
      return { sql: c.exclude ? `NOT ${has}` : has, params: vals };
    }
    case 'spec_verdict': return enumSql(c, SPEC_VERDICT_SQL);
    case 'renewal_state': return enumSql(c, renewalStateSql(today));
    case 'classification': return enumSql(c, 'd.classification_status');
    case 'owner': return enumSql(c, OWNER_SQL);
    case 'intake_source': return enumSql(c, INTAKE_SQL);
    case 'uploaded': {
      const r = dateSql(c, 'd.created_at', today);
      return r;
    }
    case 'approved': return dateSql(c, 'd.approved_at', today);
    default:
      return { sql: '1 = 1', params: [] };
  }
}

/**
 * The WHERE conjunction over `documents d` for a tenant. `except` leaves out a
 * field's INCLUDE clauses (its facet selection); its exclude clauses stay.
 */
export function scopeWhere(scope: CompiledScope, tenantId: string, except?: FieldKey): { sql: string; params: unknown[] } {
  const parts: string[] = ['d.tenant_id = ?'];
  const params: unknown[] = [tenantId];
  const hasStatus = scope.clauses.some((c) => c.field === 'status' && !c.exclude);
  if (!hasStatus || except === 'status') {
    // Default: active only. The status facet itself counts every searchable status.
    if (except === 'status') {
      parts.push(`d.status IN (${placeholders(STATUS_VALUES.length)})`);
      params.push(...STATUS_VALUES);
    } else {
      parts.push("d.status = 'active'");
    }
  }
  for (const c of scope.clauses) {
    if (except && c.field === except && !c.exclude) continue;
    const s = clauseSql(c, scope.today);
    parts.push(s.sql);
    params.push(...s.params);
  }
  if (hasStatus) {
    // Never 'deleted', whatever a status clause says.
    parts.push("d.status != 'deleted'");
  }
  return { sql: parts.join(' AND '), params };
}

// ===========================================================================
// The JS mirror
// ===========================================================================

function enumHolds(c: Clause, v: string | null | undefined): boolean {
  const value = v ?? null;
  const any = value === null ? c.values.includes(NONE_VALUE) : c.values.includes(value);
  return c.exclude ? !any : any;
}

function dateHolds(c: Clause, at: string | null | undefined, today: string): boolean {
  if (c.op === 'missing') return !at;
  if (!at) return false;
  const { from, to } = uploadedBounds(c, today);
  if (from && at < from) return false;
  if (to && at >= to) return false;
  return true;
}

function clauseHolds(c: Clause, a: ScopeAttrs, today: string): boolean {
  const vals = new Set(c.values);
  const inList = (v: string | null) => (c.exclude ? v === null || !vals.has(v) : v !== null && vals.has(v));
  const anyOf = (list: string[] | undefined) => {
    const any = (list ?? []).some((x) => vals.has(x));
    return c.exclude ? !any : any;
  };
  switch (c.field) {
    case 'supplier': return inList(a.supplier_id);
    case 'document_type': return inList(a.document_type_id);
    case 'status': return inList(a.status);
    case 'product': return anyOf(a.product_ids);
    case 'requirement': return anyOf(a.requirement_ids);
    case 'claim': return anyOf(a.claim_ids);
    case 'spec_verdict': return enumHolds(c, a.spec_verdict ?? 'none');
    case 'renewal_state': return enumHolds(c, a.renewal_state ?? 'not_set');
    case 'classification': return enumHolds(c, a.classification);
    case 'owner': return enumHolds(c, a.owner);
    case 'intake_source': return enumHolds(c, a.intake_source);
    case 'uploaded': return dateHolds(c, a.created_at, today);
    case 'approved': return dateHolds(c, a.approved_at, today);
    default:
      return true;
  }
}

/** The JS mirror of `scopeWhere` (tenant already applied by the caller). */
export function scopeHolds(scope: CompiledScope, a: ScopeAttrs, except?: FieldKey): boolean {
  const hasStatus = scope.clauses.some((c) => c.field === 'status' && !c.exclude);
  if (a.status === 'deleted') return false;
  if (except === 'status') {
    if (!(STATUS_VALUES as readonly string[]).includes(a.status ?? '')) return false;
  } else if (!hasStatus && a.status !== 'active') {
    return false;
  }
  for (const c of scope.clauses) {
    if (except && c.field === except && !c.exclude) continue;
    if (!clauseHolds(c, a, scope.today)) return false;
  }
  return true;
}
