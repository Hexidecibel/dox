/**
 * Renewal engine — status computation for the IDP Document Registry.
 *
 * This is the MINIMAL Phase-4 engine: a `renewal_type`-aware status
 * computation over the registry fields added in migration 0077
 * (`renewal_type`, `renewal_interval_months`, `renewal_due_date`, `owner`)
 * plus the legacy `primary_metadata.$.expiration_date`.
 *
 * The core is pure + HTTP-free so both endpoints
 * (`GET /api/expirations`, `POST /api/expirations/notify`) share one
 * classifier and the tests exercise it without a request context.
 *
 * ── The canonical next-action date ──────────────────────────────────────────
 * `renewal_due_date` is canonical; when it's null we fall back to
 * `json_extract(primary_metadata,'$.expiration_date')` — mirroring how search
 * does `expiration = COALESCE(renewal_due_date, primary_metadata expiration)`.
 * `review_cycle` has one extra fallback: a next-review date computed from
 * `effective_date + renewal_interval_months`.
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
 *                       otherwise `current`.
 *
 * A document with a resolvable date but NO renewal_type is treated with
 * hard_expiry semantics — a bare `expiration_date` is a real drop-dead date,
 * so legacy registry rows still surface. (Flagged as `unknown` in the
 * renewal_type summary bucket.)
 *
 * The ALERT set = { expiring, expired, overdue }. `current` and `stale` never
 * alert.
 */

import type { D1Database } from '@cloudflare/workers-types';

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

/** Default look-ahead window for "expiring soon", in days. */
export const DEFAULT_WINDOW_DAYS = 60;

/** The raw fields the classifier needs, straight off a `documents` row. */
export interface RenewalInput {
  renewal_type: RenewalType | string | null;
  renewal_due_date: string | null;
  renewal_interval_months: number | null;
  /** primary_metadata.$.expiration_date (legacy expiry fallback). */
  meta_expiration_date: string | null;
  /** primary_metadata.$.effective_date (review_cycle interval anchor). */
  meta_effective_date: string | null;
}

export interface StatusResult {
  /** Resolved next-action date (YYYY-MM-DD), or null when none is resolvable. */
  due_date: string | null;
  /** Whole days from `asOf` to `due_date`. Negative = in the past. Null when no date. */
  days_until: number | null;
  /** Computed status, or null when there's no resolvable date to classify. */
  status: ExpirationStatus | null;
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
}

export interface ExpirationSummary {
  total: number;
  by_status: Record<ExpirationStatus, number>;
  by_renewal_type: Record<RenewalType | 'unknown', number>;
  /** Count of rows in the alert set (expiring + expired + overdue). */
  alerting: number;
}

// ── date helpers ────────────────────────────────────────────────────────────

/** Strip any time component; empty/blank → null. */
function dateOnly(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  if (!s) return null;
  return s.slice(0, 10);
}

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

/** Add `months` to a YYYY-MM-DD date, clamping the day to the target month. */
export function addMonths(date: string, months: number): string | null {
  const d = dateOnly(date);
  if (!d) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const day = Number(m[3]);
  const base = new Date(Date.UTC(y, mo, 1));
  base.setUTCMonth(base.getUTCMonth() + months);
  // Clamp day to last valid day of the resulting month.
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(day, lastDay));
  return base.toISOString().slice(0, 10);
}

// ── resolution + classification (pure) ──────────────────────────────────────

/**
 * Resolve the canonical next-action date for a row.
 *   1. renewal_due_date (canonical).
 *   2. review_cycle only: effective_date + renewal_interval_months.
 *   3. primary_metadata.$.expiration_date (legacy fallback).
 * Returns YYYY-MM-DD or null.
 */
export function resolveDueDate(input: RenewalInput): string | null {
  const canonical = dateOnly(input.renewal_due_date);
  if (canonical) return canonical;

  if (input.renewal_type === 'review_cycle') {
    const eff = dateOnly(input.meta_effective_date);
    if (eff && input.renewal_interval_months && input.renewal_interval_months > 0) {
      const next = addMonths(eff, input.renewal_interval_months);
      if (next) return next;
    }
  }

  return dateOnly(input.meta_expiration_date);
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
  const due = resolveDueDate(input);
  if (!due) return { due_date: null, days_until: null, status: null };

  const daysUntil = daysBetween(asOf, due);
  if (daysUntil === null) return { due_date: due, days_until: null, status: null };

  const past = daysUntil < 0; // due < today
  const withinWindow = daysUntil <= windowDays; // due <= today + window

  let status: ExpirationStatus;
  switch (input.renewal_type) {
    case 'keep_current':
      // Informational only. Never alerts. Very old → stale.
      status = daysUntil < -STALE_DAYS ? 'stale' : 'current';
      break;
    case 'renewal_application':
    case 'review_cycle':
      if (past) status = 'overdue';
      else if (withinWindow) status = 'expiring';
      else status = 'current';
      break;
    case 'hard_expiry':
    default:
      // hard_expiry + null/unknown renewal_type: a drop-dead date.
      if (past) status = 'expired';
      else if (withinWindow) status = 'expiring';
      else status = 'current';
      break;
  }

  return { due_date: due, days_until: daysUntil, status };
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
  meta_expiration_date: string | null;
  meta_effective_date: string | null;
}

const DOC_SQL = `
  SELECT
    d.id                          AS id,
    d.title                       AS title,
    dt.name                       AS primary_category_name,
    d.owner                       AS owner,
    d.renewal_type                AS renewal_type,
    d.renewal_due_date            AS renewal_due_date,
    d.renewal_interval_months     AS renewal_interval_months,
    json_extract(d.primary_metadata, '$.expiration_date') AS meta_expiration_date,
    json_extract(d.primary_metadata, '$.effective_date')  AS meta_effective_date
  FROM documents d
  LEFT JOIN document_types dt ON dt.id = d.document_type_id
  WHERE d.tenant_id = ? AND d.status = 'active'
`;

export interface ExpirationResult {
  rows: ExpirationRow[];
  summary: ExpirationSummary;
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
  windowDays: number = DEFAULT_WINDOW_DAYS,
): Promise<ExpirationResult> {
  const res = await db.prepare(DOC_SQL).bind(tenantId).all<RawDocRow>();
  const raw = res.results ?? [];

  const rows: ExpirationRow[] = [];
  const summary: ExpirationSummary = {
    total: 0,
    by_status: emptyStatusCounts(),
    by_renewal_type: emptyTypeCounts(),
    alerting: 0,
  };

  for (const r of raw) {
    const { due_date, days_until, status } = computeStatus(
      {
        renewal_type: r.renewal_type,
        renewal_due_date: r.renewal_due_date,
        renewal_interval_months: r.renewal_interval_months,
        meta_expiration_date: r.meta_expiration_date,
        meta_effective_date: r.meta_effective_date,
      },
      asOf,
      windowDays,
    );
    if (!status || !due_date) continue; // no resolvable date → skip

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

  return { rows, summary };
}

/** The subset of rows that warrant an alert (expiring/expired/overdue). */
export function alertingRows(rows: ExpirationRow[]): ExpirationRow[] {
  return rows.filter((r) => isAlertStatus(r.status));
}
