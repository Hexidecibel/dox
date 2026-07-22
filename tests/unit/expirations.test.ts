/**
 * Unit tests for the renewal engine's pure status computation
 * (functions/lib/expirations.ts). No DB / HTTP — drives computeStatus,
 * resolveDueDate, and addMonths directly across all four renewal_types.
 *
 * asOf is pinned so the window math is deterministic.
 */

import { describe, it, expect } from 'vitest';
import {
  computeStatus,
  resolveDueDate,
  addMonths,
  daysBetween,
  isAlertStatus,
  type RenewalInput,
} from '../../functions/lib/expirations';

const AS_OF = '2026-07-22';
const WINDOW = 60;

function input(partial: Partial<RenewalInput>): RenewalInput {
  return {
    renewal_type: null,
    renewal_due_date: null,
    renewal_interval_months: null,
    meta_expiration_date: null,
    meta_effective_date: null,
    ...partial,
  };
}

describe('computeStatus — hard_expiry (drop-dead date)', () => {
  it('due in the past → expired', () => {
    const r = computeStatus(input({ renewal_type: 'hard_expiry', renewal_due_date: '2026-06-01' }), AS_OF, WINDOW);
    expect(r.status).toBe('expired');
    expect(r.days_until).toBeLessThan(0);
  });
  it('due within the window → expiring', () => {
    const r = computeStatus(input({ renewal_type: 'hard_expiry', renewal_due_date: '2026-08-01' }), AS_OF, WINDOW);
    expect(r.status).toBe('expiring');
    expect(r.days_until).toBe(10);
  });
  it('due beyond the window → current', () => {
    const r = computeStatus(input({ renewal_type: 'hard_expiry', renewal_due_date: '2027-01-01' }), AS_OF, WINDOW);
    expect(r.status).toBe('current');
  });
});

describe('computeStatus — renewal_application (application-due, past = overdue not expired)', () => {
  it('due in the past → overdue (NOT expired)', () => {
    const r = computeStatus(input({ renewal_type: 'renewal_application', renewal_due_date: '2026-06-01' }), AS_OF, WINDOW);
    expect(r.status).toBe('overdue');
  });
  it('due within the window → expiring', () => {
    const r = computeStatus(input({ renewal_type: 'renewal_application', renewal_due_date: '2026-08-01' }), AS_OF, WINDOW);
    expect(r.status).toBe('expiring');
  });
  it('due beyond the window → current', () => {
    const r = computeStatus(input({ renewal_type: 'renewal_application', renewal_due_date: '2027-03-01' }), AS_OF, WINDOW);
    expect(r.status).toBe('current');
  });
});

describe('computeStatus — review_cycle (interval-derived next review)', () => {
  it('derives next review from effective_date + interval → expiring', () => {
    const r = computeStatus(
      input({ renewal_type: 'review_cycle', meta_effective_date: '2026-06-01', renewal_interval_months: 2 }),
      AS_OF, WINDOW,
    );
    expect(r.due_date).toBe('2026-08-01');
    expect(r.status).toBe('expiring');
  });
  it('interval-derived date in the past → overdue', () => {
    const r = computeStatus(
      input({ renewal_type: 'review_cycle', meta_effective_date: '2025-01-01', renewal_interval_months: 6 }),
      AS_OF, WINDOW,
    );
    expect(r.due_date).toBe('2025-07-01');
    expect(r.status).toBe('overdue');
  });
  it('explicit renewal_due_date overrides the interval computation', () => {
    const r = computeStatus(
      input({
        renewal_type: 'review_cycle',
        renewal_due_date: '2027-01-01',
        meta_effective_date: '2020-01-01',
        renewal_interval_months: 6,
      }),
      AS_OF, WINDOW,
    );
    expect(r.due_date).toBe('2027-01-01');
    expect(r.status).toBe('current');
  });
});

describe('computeStatus — keep_current (never alerts)', () => {
  it('recent date → current, never expiring even if within window', () => {
    // A date 21 days in the past is well inside the window, but keep_current
    // must not flag it.
    const r = computeStatus(input({ renewal_type: 'keep_current', renewal_due_date: '2026-07-01' }), AS_OF, WINDOW);
    expect(r.status).toBe('current');
    expect(isAlertStatus(r.status!)).toBe(false);
  });
  it('very old date → stale (still never alerts)', () => {
    const r = computeStatus(input({ renewal_type: 'keep_current', renewal_due_date: '2025-01-01' }), AS_OF, WINDOW);
    expect(r.status).toBe('stale');
    expect(isAlertStatus(r.status!)).toBe(false);
  });
  it('future date → current, never expiring', () => {
    const r = computeStatus(input({ renewal_type: 'keep_current', renewal_due_date: '2026-08-01' }), AS_OF, WINDOW);
    expect(r.status).toBe('current');
  });
});

describe('computeStatus — null/unknown renewal_type (bare legacy expiry)', () => {
  it('treats a bare primary_metadata expiration as a hard drop-dead date → expired', () => {
    const r = computeStatus(input({ renewal_type: null, meta_expiration_date: '2026-06-01' }), AS_OF, WINDOW);
    expect(r.status).toBe('expired');
  });
  it('no resolvable date at all → status null (excluded)', () => {
    const r = computeStatus(input({ renewal_type: 'hard_expiry' }), AS_OF, WINDOW);
    expect(r.status).toBeNull();
    expect(r.due_date).toBeNull();
  });
});

describe('resolveDueDate precedence', () => {
  it('canonical renewal_due_date wins over metadata', () => {
    expect(resolveDueDate(input({ renewal_due_date: '2027-05-05', meta_expiration_date: '2026-01-01' }))).toBe('2027-05-05');
  });
  it('falls back to primary_metadata expiration when canonical is null', () => {
    expect(resolveDueDate(input({ meta_expiration_date: '2026-01-01' }))).toBe('2026-01-01');
  });
  it('strips a time component to a bare date', () => {
    expect(resolveDueDate(input({ renewal_due_date: '2027-05-05T12:00:00Z' }))).toBe('2027-05-05');
  });
});

describe('addMonths + daysBetween', () => {
  it('clamps the day to the last valid day of the target month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
  });
  it('rolls the year over', () => {
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
  });
  it('counts whole days, signed', () => {
    expect(daysBetween('2026-07-22', '2026-08-01')).toBe(10);
    expect(daysBetween('2026-07-22', '2026-07-01')).toBe(-21);
  });
});
