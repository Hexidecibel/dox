/**
 * Renewal engine — status computation for the IDP Document Registry.
 *
 * This is the MINIMAL Phase-4 engine: a `renewal_type`-aware status
 * computation over the registry fields added in migration 0077
 * (`renewal_type`, `renewal_interval_months`, `renewal_due_date`, `owner`),
 * the type-level renewal policy/period (0096, 0097), and the document's own
 * printed expiry `primary_metadata.$.document_expires_on`.
 *
 * That last one is NOT `primary_metadata.$.expiration_date` — the product's
 * shelf life — which this engine deliberately never reads.
 *
 * The core is pure + HTTP-free so both endpoints
 * (`GET /api/expirations`, `POST /api/expirations/notify`) share one
 * classifier and the tests exercise it without a request context.
 *
 * ── The canonical next-action date ──────────────────────────────────────────
 * This module no longer decides WHICH date wins. That precedence lives in one
 * place — `resolveRenewalExpiry` in shared/renewalPeriod.ts — because the
 * renewal-period defaults confirmed with the client's SME (annual by default,
 * three years for specification sheets, and a document's own stated expiry
 * overriding both) are a single rule that the dashboard, the alert engine and
 * the review screens must all answer identically. This module classifies the
 * date that function returns, and carries its `rule` through so a caller can
 * say WHY a row is due when it is.
 *
 * ── Two windows, one date ────────────────────────────────────────────────────
 * Every row is classified twice. `status` uses the caller's window (the
 * dashboard's look-ahead, a VIEW filter). `alert_status` uses the document's
 * own alert lead time (migration 0111: type override -> tenant -> default),
 * and is the only one the alert engine mails on, via LEAD_TIME_WINDOW. So
 * widening the dashboard to 180 days shows more rows and mails nobody extra.
 *
 * ── Per-renewal_type status rules (window = look-ahead in days) ──────────────
 *   hard_expiry         drop-dead date.
 *                         due < today            → expired
 *                         due <= today+window    → expiring
 *                         else                   → current
 *   renewal_application application-due model (a re-application is due; being
 *                       past the date is "overdue", NOT hard-expired).
 *                         due < today            → overdue
 *                         due <= today+window    → expiring
 *                         else                   → current
 *   review_cycle        periodic review; same window logic as
 *                       renewal_application (overdue / expiring / current),
 *                       fed by the computed next-review date.
 *   keep_current        informational only. Never expiring/expired/overdue and
 *                       never alerts. Surfaces a `stale` status when the
 *                       resolved date is very old (> STALE_DAYS before today),
 *                       otherwise `current`. It is also the one type that opts
 *                       OUT of the renewal-period defaults: "keep the latest
 *                       version on file" is a declaration that there is no
 *                       cadence, so none is manufactured for it.
 *
 * A document with a resolvable date but NO renewal_type is treated with
 * hard_expiry semantics — a bare `document_expires_on` is a real drop-dead
 * date, so legacy registry rows still surface. (Flagged as `unknown` in the
 * renewal_type summary bucket.)
 *
 * The ALERT set = { expiring, expired, overdue }. `current` and `stale` never
 * alert.
 */

import type { D1Database } from '@cloudflare/workers-types';
import {
  resolveRenewalExpiry,
  addMonths,
  type RenewalRule,
} from '../../shared/renewalPeriod';
import {
  DEFAULT_RENEWAL_ALERT_LEAD_DAYS,
  resolveRenewalAlertLead,
  type RenewalAlertLeadSource,
  type ResolvedRenewalAlertLead,
} from '../../shared/renewalLeadTime';

// Re-exported so the date helper keeps its long-standing import path.
export { addMonths };
export type { RenewalRule };

export type RenewalType =
  | 'renewal_application'
  | 'hard_expiry'
  | 'keep_current'
  | 'review_cycle';

export type ExpirationStatus =
  | 'current'
  | 'expiring'
  | 'expired'
  | 'overdue'
  | 'stale';

/** Statuses that warrant an alert email. */
export const ALERT_STATUSES: ReadonlySet<ExpirationStatus> = new Set<ExpirationStatus>([
  'expiring',
  'expired',
  'overdue',
]);

export function isAlertStatus(status: ExpirationStatus): boolean {
  return ALERT_STATUSES.has(status);
}

/** A keep_current record older than this (days past its resolved date) is `stale`. */
export const STALE_DAYS = 365;

/**
 * Default look-ahead window for "expiring soon", in days.
 *
 * The same number as the renewal alert lead-time default (migration 0111), and
 * defined in terms of it so the two cannot drift. Since 0111 the MAIL path no
 * longer uses a single window at all: each document is judged against its own
 * resolved lead time (type override -> tenant -> this default). This constant
 * survives as the dashboard's view default for callers that pass no window.
 */
export const DEFAULT_WINDOW_DAYS = DEFAULT_RENEWAL_ALERT_LEAD_DAYS;

/**
 * Pass as the window to `computeExpirations` to classify every row against
 * ITS OWN resolved lead time instead of one window for the whole tenant. This
 * is what the alert engine (manual and scheduled) uses.
 */
export const LEAD_TIME_WINDOW = 'lead_time' as const;
export type ExpirationWindow = number | typeof LEAD_TIME_WINDOW;

/** The raw fields the classifier needs, straight off a `documents` row. */
export interface RenewalInput {
  renewal_type: RenewalType | string | null;
  renewal_due_date: string | null;
  renewal_interval_months: number | null;
  /**
   * primary_metadata.$.document_expires_on — the date THE DOCUMENT stops being
   * valid, as printed on it (a certificate of insurance, an organic or GFSI
   * certificate, a third-party audit certificate).
   *
   * Deliberately NOT `primary_metadata.$.expiration_date`, which is the
   * PRODUCT's shelf life. Reading that one here put all 139 of prod's COAs on
   * this dashboard; see the header block in shared/renewalPeriod.ts.
   */
  meta_document_expires_on: string | null;
  /** primary_metadata.$.effective_date (the anchor a renewal period counts from). */
  meta_effective_date: string | null;
  /**
   * documents.renewal_decision (migration 0097) — what a reviewer did with the
   * proposal at approval. 'cleared' means they answered "this does not renew",
   * which is not the same as never having looked (NULL).
   */
  renewal_decision: string | null;
  /**
   * document_types.renewal_policy (migration 0097) — whether this document's
   * TYPE renews at all. 'none' (a COA) excludes the row categorically.
   */
  type_renewal_policy: string | null;
  /**
   * document_types.renewal_interval_months (migration 0096) — the renewal
   * period configured for this document's TYPE. Read only when the policy is
   * 'period'.
   */
  type_renewal_interval_months: number | null;
}

export interface StatusResult {
  /** Resolved next-action date (YYYY-MM-DD), or null when none is resolvable. */
  due_date: string | null;
  /** Whole days from `asOf` to `due_date`. Negative = in the past. Null when no date. */
  days_until: number | null;
  /** Computed status, or null when there's no resolvable date to classify. */
  status: ExpirationStatus | null;
  /** Which renewal rule produced `due_date` (stated expiry, type default, annual...). */
  rule: RenewalRule;
  /** The period that applied, in months; null when a stated date answered. */
  period_months: number | null;
  /** One human-readable sentence explaining `due_date`. */
  reason: string;
}

/** A fully-classified registry document row for the API/email. */
export interface ExpirationRow {
  id: string;
  title: string;
  primary_category_name: string | null;
  owner: string | null;
  renewal_type: RenewalType | 'unknown';
  /** The resolved next-action date (canonical). */
  renewal_due_date: string | null;
  status: ExpirationStatus;
  days_until: number | null;
  /**
   * Which rule produced `renewal_due_date` — the document's own stated expiry,
   * the type's configured period, or the annual default. Carried on the row so
   * a screen can explain a date instead of asserting it.
   */
  renewal_rule: RenewalRule;
  /** The renewal period that applied, in months; null when a stated date answered. */
  renewal_period_months: number | null;
  /**
   * How many days before its due date THIS document's owner is warned
   * (migration 0111): the document type's override, else the tenant's
   * setting, else the default. Carried on every row so an admin can predict
   * when a record will first be mailed.
   */
  alert_lead_days: number;
  /** Which rung answered `alert_lead_days`. */
  alert_lead_source: RenewalAlertLeadSource;
  /**
   * The status judged against `alert_lead_days` rather than the caller's view
   * window. This, not `status`, is what the alert engine mails on; the two are
   * equal when `computeExpirations` was called with LEAD_TIME_WINDOW.
   */
  alert_status: ExpirationStatus;
}

export interface ExpirationSummary {
  total: number;
  by_status: Record<ExpirationStatus, number>;
  by_renewal_type: Record<RenewalType | 'unknown', number>;
  /** Count of rows in the alert set (expiring + expired + overdue). */
  alerting: number;
}

// ── date helpers ────────────────────────────────────────────────────────────

/** UTC-midnight ms for a YYYY-MM-DD string, or NaN. */
function dayMs(d: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Whole days from `asOf` to `due` (due - asOf). Null if either unparseable. */
export function daysBetween(asOf: string, due: string): number | null {
  const a = dayMs(asOf);
  const b = dayMs(due);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

// ── resolution + classification (pure) ──────────────────────────────────────

/**
 * Resolve the canonical next-action date for a row.
 *
 * A thin delegate to `resolveRenewalExpiry` (shared/renewalPeriod.ts), which
 * owns the whole precedence ladder: the document's own stated expiry, then a
 * period set on the document, then the type's period, then annual. Kept as a
 * named export because "just the date, please" is the common call and because
 * it is the shape every existing caller already expects.
 */
export function resolveDueDate(input: RenewalInput): string | null {
  return resolveRenewalExpiry(input).due_date;
}

/**
 * Classify a row into an ExpirationStatus against `asOf` and a look-ahead
 * `windowDays`. Returns status=null when no date is resolvable (caller skips).
 */
export function computeStatus(
  input: RenewalInput,
  asOf: string,
  windowDays: number = DEFAULT_WINDOW_DAYS,
): StatusResult {
  const resolved = resolveRenewalExpiry(input);
  const provenance = {
    rule: resolved.rule,
    period_months: resolved.period_months,
    reason: resolved.reason,
  };
  const due = resolved.due_date;
  if (!due) return { due_date: null, days_until: null, status: null, ...provenance };

  const daysUntil = daysBetween(asOf, due);
  if (daysUntil === null) return { due_date: due, days_until: null, status: null, ...provenance };

  const status = classifyDaysUntil(input.renewal_type, daysUntil, windowDays);
  return { due_date: due, days_until: daysUntil, status, ...provenance };
}

/**
 * The per-renewal_type status rules, given whole days until the due date and a
 * window. Split out of `computeStatus` so one resolved date can be classified
 * against two windows (the dashboard's view window and the document's own
 * alert lead time) without resolving it twice.
 */
export function classifyDaysUntil(
  renewalType: RenewalType | string | null,
  daysUntil: number,
  windowDays: number,
): ExpirationStatus {
  const past = daysUntil < 0; // due < today
  const withinWindow = daysUntil <= windowDays; // due <= today + window

  switch (renewalType) {
    case 'keep_current':
      // Informational only. Never alerts. Very old → stale.
      return daysUntil < -STALE_DAYS ? 'stale' : 'current';
    case 'renewal_application':
    case 'review_cycle':
      if (past) return 'overdue';
      return withinWindow ? 'expiring' : 'current';
    case 'hard_expiry':
    default:
      // hard_expiry + null/unknown renewal_type: a drop-dead date.
      if (past) return 'expired';
      return withinWindow ? 'expiring' : 'current';
  }
}

/** Normalize renewal_type into the summary bucket key. */
function typeBucket(t: RenewalType | string | null): RenewalType | 'unknown' {
  if (
    t === 'renewal_application' ||
    t === 'hard_expiry' ||
    t === 'keep_current' ||
    t === 'review_cycle'
  ) {
    return t;
  }
  return 'unknown';
}

function emptyStatusCounts(): Record<ExpirationStatus, number> {
  return { current: 0, expiring: 0, expired: 0, overdue: 0, stale: 0 };
}

function emptyTypeCounts(): Record<RenewalType | 'unknown', number> {
  return {
    renewal_application: 0,
    hard_expiry: 0,
    keep_current: 0,
    review_cycle: 0,
    unknown: 0,
  };
}

// ── data access ─────────────────────────────────────────────────────────────

/** The raw shape pulled from `documents` (+ primary category name). */
interface RawDocRow {
  id: string;
  title: string;
  primary_category_name: string | null;
  owner: string | null;
  renewal_type: string | null;
  renewal_due_date: string | null;
  renewal_interval_months: number | null;
  renewal_decision: string | null;
  meta_document_expires_on: string | null;
  meta_effective_date: string | null;
  type_renewal_policy: string | null;
  type_renewal_interval_months: number | null;
  type_renewal_alert_lead_days: number | null;
  document_type_id: string | null;
}

const DOC_SQL = `
  SELECT
    d.id                          AS id,
    d.title                       AS title,
    dt.name                       AS primary_category_name,
    d.owner                       AS owner,
    d.document_type_id            AS document_type_id,
    d.renewal_type                AS renewal_type,
    d.renewal_due_date            AS renewal_due_date,
    d.renewal_interval_months     AS renewal_interval_months,
    d.renewal_decision            AS renewal_decision,
    -- document_expires_on, NOT expiration_date. The latter is the PRODUCT's
    -- shelf life; reading it here is what put every COA on this dashboard.
    json_extract(d.primary_metadata, '$.document_expires_on') AS meta_document_expires_on,
    json_extract(d.primary_metadata, '$.effective_date')      AS meta_effective_date,
    dt.renewal_policy             AS type_renewal_policy,
    dt.renewal_interval_months    AS type_renewal_interval_months,
    dt.renewal_alert_lead_days    AS type_renewal_alert_lead_days
  FROM documents d
  LEFT JOIN document_types dt ON dt.id = d.document_type_id
  WHERE d.tenant_id = ? AND d.status = 'active'
`;

export interface ExpirationResult {
  rows: ExpirationRow[];
  summary: ExpirationSummary;
  /** The tenant-level lead time (setting or default) the rows inherited from. */
  tenant_lead: ResolvedRenewalAlertLead;
}

/**
 * The tenant's own lead-time setting (0111), or null. A database that has not
 * run 0111 yields null, which resolves to the default: exactly the behaviour
 * before the setting existed.
 */
export async function loadTenantAlertLeadDays(
  db: D1Database,
  tenantId: string,
): Promise<number | null> {
  try {
    const row = await db
      .prepare('SELECT renewal_alert_lead_days FROM tenants WHERE id = ?')
      .bind(tenantId)
      .first<{ renewal_alert_lead_days: number | null }>();
    return row?.renewal_alert_lead_days ?? null;
  } catch {
    return null;
  }
}

/**
 * A hypothetical lead-time configuration, for the "what would this change"
 * preview. `tenantLeadDays` replaces the tenant's stored value; `typeLeadDays`
 * replaces one document type's stored override. `undefined` = keep stored.
 */
export interface LeadTimeOverride {
  tenantLeadDays?: number | null;
  documentTypeId?: string;
  typeLeadDays?: number | null;
}

/**
 * Load + classify every active document in a tenant that has a resolvable
 * next-action date. Rows come back sorted by days_until ascending (most
 * urgent first); rows with no resolvable date are dropped.
 */
export async function computeExpirations(
  db: D1Database,
  tenantId: string,
  asOf: string,
  window: ExpirationWindow = DEFAULT_WINDOW_DAYS,
  override: LeadTimeOverride = {},
): Promise<ExpirationResult> {
  const res = await db.prepare(DOC_SQL).bind(tenantId).all<RawDocRow>();
  const raw = res.results ?? [];

  const tenantLeadDays =
    override.tenantLeadDays !== undefined
      ? override.tenantLeadDays
      : await loadTenantAlertLeadDays(db, tenantId);
  const tenantLead = resolveRenewalAlertLead(null, tenantLeadDays);

  const rows: ExpirationRow[] = [];
  const summary: ExpirationSummary = {
    total: 0,
    by_status: emptyStatusCounts(),
    by_renewal_type: emptyTypeCounts(),
    alerting: 0,
  };

  for (const r of raw) {
    const typeLeadDays =
      override.documentTypeId !== undefined &&
      override.typeLeadDays !== undefined &&
      r.document_type_id === override.documentTypeId
        ? override.typeLeadDays
        : r.type_renewal_alert_lead_days;
    const lead = resolveRenewalAlertLead(typeLeadDays, tenantLeadDays);
    const viewWindow = window === LEAD_TIME_WINDOW ? lead.days : window;

    const { due_date, days_until, status, rule, period_months } = computeStatus(
      {
        renewal_type: r.renewal_type,
        renewal_due_date: r.renewal_due_date,
        renewal_interval_months: r.renewal_interval_months,
        renewal_decision: r.renewal_decision,
        meta_document_expires_on: r.meta_document_expires_on,
        meta_effective_date: r.meta_effective_date,
        type_renewal_policy: r.type_renewal_policy,
        type_renewal_interval_months: r.type_renewal_interval_months,
      },
      asOf,
      viewWindow,
    );
    if (!status || !due_date) continue; // no resolvable date → skip
    const alertStatus =
      days_until === null ? status : classifyDaysUntil(r.renewal_type, days_until, lead.days);

    const bucket = typeBucket(r.renewal_type);
    rows.push({
      id: r.id,
      title: r.title,
      primary_category_name: r.primary_category_name,
      owner: r.owner,
      renewal_type: bucket,
      renewal_due_date: due_date,
      status,
      days_until,
      renewal_rule: rule,
      renewal_period_months: period_months,
      alert_lead_days: lead.days,
      alert_lead_source: lead.source,
      alert_status: alertStatus,
    });

    summary.total += 1;
    summary.by_status[status] += 1;
    summary.by_renewal_type[bucket] += 1;
    if (isAlertStatus(status)) summary.alerting += 1;
  }

  rows.sort((a, b) => {
    const av = a.days_until ?? Number.POSITIVE_INFINITY;
    const bv = b.days_until ?? Number.POSITIVE_INFINITY;
    return av - bv;
  });

  return { rows, summary, tenant_lead: tenantLead };
}

/** The subset of rows that warrant an alert (expiring/expired/overdue). */
export function alertingRows(rows: ExpirationRow[]): ExpirationRow[] {
  return rows.filter((r) => isAlertStatus(r.status));
}
