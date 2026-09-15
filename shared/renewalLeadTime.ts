/**
 * Renewal alert LEAD TIME: how far ahead of a document's due date its owner is
 * warned (migration 0111).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SETTING AND NOT A CONSTANT
 * ---------------------------------------------------------------------------
 * Client SME ruling, 2026-09-14: some clients want three months' warning so
 * they can start chasing suppliers early; others want one month so they do not
 * spam suppliers about a certificate that is not yet renewable. Both are right
 * for their own supplier base, so the number belongs to the organization.
 *
 * Some document TYPES need a different answer from the rest of the file: a
 * third-party audit certificate needs an audit booked months ahead, while a
 * letter of guarantee can be re-signed in a week. So a type may override the
 * organization's number. The ladder, most specific first:
 *
 *   1. document_types.renewal_alert_lead_days   ("document_type")
 *   2. tenants.renewal_alert_lead_days          ("tenant")
 *   3. DEFAULT_RENEWAL_ALERT_LEAD_DAYS (60)     ("default")
 *
 * NULL at either level means "inherit", never zero. A stored value is there
 * because a named admin chose it (the columns carry updated_at / updated_by).
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not decide WHETHER a document renews (0097 renewal_policy) or WHEN it
 * is due (shared/renewalPeriod.ts). It decides only the day a due document
 * starts being "expiring" for the purpose of mailing its owner. Who gets that
 * mail is owner routing (0091). And the Renewals dashboard's look-ahead
 * selector is a VIEW filter over the same data: it never changes who is mailed.
 *
 * Pure and dependency-free so the Pages functions, the React app and the tests
 * all resolve it identically.
 */

/** The code default when neither the type nor the organization says. */
export const DEFAULT_RENEWAL_ALERT_LEAD_DAYS = 60;

/**
 * Below a week the 7-day re-alert cooldown means an owner may hear only once
 * before the date passes; above a year a document on the annual default is
 * permanently "expiring". Both ends are enforced by a CHECK in 0111 too.
 */
export const MIN_RENEWAL_ALERT_LEAD_DAYS = 7;
export const MAX_RENEWAL_ALERT_LEAD_DAYS = 365;

/** The presets the settings screens offer; any value in range is allowed. */
export const RENEWAL_ALERT_LEAD_PRESETS: readonly number[] = [30, 60, 90];

/** Which rung of the ladder answered. */
export type RenewalAlertLeadSource = 'document_type' | 'tenant' | 'default';

export interface ResolvedRenewalAlertLead {
  days: number;
  source: RenewalAlertLeadSource;
}

/** A stored value is usable only when it is an integer inside the range. */
function usable(v: number | null | undefined): v is number {
  return (
    typeof v === 'number' &&
    Number.isInteger(v) &&
    v >= MIN_RENEWAL_ALERT_LEAD_DAYS &&
    v <= MAX_RENEWAL_ALERT_LEAD_DAYS
  );
}

/**
 * Resolve the lead time for ONE document from its type's override and its
 * organization's setting. A value outside the range (which the CHECK should
 * make impossible) falls through to the next rung rather than producing a
 * window of 0 or 10,000 days: a corrupt number must not silence or flood.
 */
export function resolveRenewalAlertLead(
  typeLeadDays: number | null | undefined,
  tenantLeadDays: number | null | undefined,
): ResolvedRenewalAlertLead {
  if (usable(typeLeadDays)) return { days: typeLeadDays, source: 'document_type' };
  if (usable(tenantLeadDays)) return { days: tenantLeadDays, source: 'tenant' };
  return { days: DEFAULT_RENEWAL_ALERT_LEAD_DAYS, source: 'default' };
}

export type ParsedLeadDays = { ok: true; value: number | null } | { ok: false; error: string };

/**
 * Validate a lead time from a request body. `null` is a real answer ("inherit"
 * / "use the default"); a missing, fractional, stringly or out-of-range value
 * is refused rather than coerced, because a setting that decides when
 * customers' suppliers get chased should not be set by accident.
 */
export function parseRenewalAlertLeadDays(input: unknown): ParsedLeadDays {
  if (input === null) return { ok: true, value: null };
  if (typeof input !== 'number' || !Number.isInteger(input)) {
    return { ok: false, error: 'renewal_alert_lead_days must be a whole number of days, or null to inherit' };
  }
  if (input < MIN_RENEWAL_ALERT_LEAD_DAYS || input > MAX_RENEWAL_ALERT_LEAD_DAYS) {
    return {
      ok: false,
      error: `renewal_alert_lead_days must be between ${MIN_RENEWAL_ALERT_LEAD_DAYS} and ${MAX_RENEWAL_ALERT_LEAD_DAYS}`,
    };
  }
  return { ok: true, value: input };
}

/** "90 days (document type)" style wording for chips, emails and tooltips. */
export function renewalAlertLeadSourceLabel(source: RenewalAlertLeadSource): string {
  switch (source) {
    case 'document_type':
      return 'document type';
    case 'tenant':
      return 'organization setting';
    default:
      return 'system default';
  }
}
