/**
 * shared/renewalLeadTime.ts — the precedence ladder and the input guard.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RENEWAL_ALERT_LEAD_DAYS,
  parseRenewalAlertLeadDays,
  resolveRenewalAlertLead,
} from '../../shared/renewalLeadTime';
import { classifyDaysUntil, DEFAULT_WINDOW_DAYS } from '../../functions/lib/expirations';

describe('resolveRenewalAlertLead', () => {
  it('prefers the document type, then the tenant, then the default', () => {
    expect(resolveRenewalAlertLead(90, 30)).toEqual({ days: 90, source: 'document_type' });
    expect(resolveRenewalAlertLead(null, 30)).toEqual({ days: 30, source: 'tenant' });
    expect(resolveRenewalAlertLead(undefined, null)).toEqual({ days: 60, source: 'default' });
    expect(DEFAULT_RENEWAL_ALERT_LEAD_DAYS).toBe(60);
  });

  it('lets a corrupt stored value fall through rather than silence or flood', () => {
    expect(resolveRenewalAlertLead(0, 30)).toEqual({ days: 30, source: 'tenant' });
    expect(resolveRenewalAlertLead(10_000, null)).toEqual({ days: 60, source: 'default' });
    expect(resolveRenewalAlertLead(45.5, 400)).toEqual({ days: 60, source: 'default' });
  });

  it('keeps the dashboard default and the alert default the same number', () => {
    expect(DEFAULT_WINDOW_DAYS).toBe(DEFAULT_RENEWAL_ALERT_LEAD_DAYS);
  });
});

describe('parseRenewalAlertLeadDays', () => {
  it('accepts whole days in range, and null as "inherit"', () => {
    expect(parseRenewalAlertLeadDays(7)).toEqual({ ok: true, value: 7 });
    expect(parseRenewalAlertLeadDays(365)).toEqual({ ok: true, value: 365 });
    expect(parseRenewalAlertLeadDays(null)).toEqual({ ok: true, value: null });
  });

  it('refuses anything a person did not clearly mean', () => {
    for (const bad of [6, 366, 30.5, '30', undefined, true, NaN]) {
      expect(parseRenewalAlertLeadDays(bad).ok).toBe(false);
    }
  });
});

describe('classifyDaysUntil at the edge of a lead time', () => {
  it('is expiring ON the lead day and current the day before it', () => {
    expect(classifyDaysUntil('hard_expiry', 30, 30)).toBe('expiring');
    expect(classifyDaysUntil('hard_expiry', 31, 30)).toBe('current');
    expect(classifyDaysUntil('renewal_application', -1, 30)).toBe('overdue');
    expect(classifyDaysUntil('keep_current', 5, 30)).toBe('current');
  });
});
