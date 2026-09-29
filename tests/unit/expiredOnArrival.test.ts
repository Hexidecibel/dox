/**
 * Expired on arrival (rules table G4, ruled 2026-09-27): "A certificate already
 * expired on arrival says so at review and counts as a gap, not as satisfying
 * the requirement."
 *
 * Pinned here: the pure rule (strictly before, calendar days, never a guess on
 * an unreadable date) and the gap engine's use of it (the document is listed,
 * does not close, and the requirement stays open with that reason).
 */

import { describe, it, expect } from 'vitest';
import {
  calendarDay,
  expiredOnArrival,
  expiredOnArrivalSentence,
} from '../../shared/expiredOnArrival';
import {
  computeSupplierGap,
  EMPTY_CLASSIFICATION_COUNTS,
  type ClosureRow,
  type SupplierGapInput,
} from '../../shared/requirementGap';

describe('calendarDay', () => {
  it('reads a day out of a date or a timestamp', () => {
    expect(calendarDay('2026-09-27')).toBe('2026-09-27');
    expect(calendarDay('2026-09-27 14:03:11')).toBe('2026-09-27');
    expect(calendarDay('2026-09-27T23:59:59Z')).toBe('2026-09-27');
  });

  it('refuses what is not a real calendar day', () => {
    expect(calendarDay('2026-02-31')).toBeNull();
    expect(calendarDay('09/27/2026')).toBeNull();
    expect(calendarDay('')).toBeNull();
    expect(calendarDay(null)).toBeNull();
    expect(calendarDay(20260927)).toBeNull();
  });
});

describe('expiredOnArrival', () => {
  it('finds a certificate that lapsed before it arrived', () => {
    const f = expiredOnArrival({ expires_on: '2026-04-23', arrived_at: '2026-09-17 10:00:00' });
    expect(f).toEqual({
      expires_on: '2026-04-23',
      arrived_on: '2026-09-17',
      days_expired: 147,
      arrival_basis: 'arrived_at',
    });
    expect(expiredOnArrivalSentence(f!)).toBe(
      "Expired on arrival: this document's own expiry is 2026-04-23, 147 days before it arrived on 2026-09-17"
    );
  });

  it('a certificate expiring ON its arrival day was valid that day', () => {
    expect(expiredOnArrival({ expires_on: '2026-09-17', arrived_at: '2026-09-17 23:00:00' })).toBeNull();
  });

  it('a current certificate is not flagged', () => {
    expect(expiredOnArrival({ expires_on: '2027-01-02', arrived_at: '2026-09-17' })).toBeNull();
  });

  it('falls back to created_at and says so', () => {
    const f = expiredOnArrival({ expires_on: '2026-01-01', arrived_at: null, created_at: '2026-02-01 08:00:00' });
    expect(f?.arrival_basis).toBe('created_at');
    expect(f?.days_expired).toBe(31);
  });

  it('prefers the recorded arrival over the creation day', () => {
    // Arrived before it lapsed, approved after: NOT expired on arrival.
    expect(
      expiredOnArrival({ expires_on: '2026-03-01', arrived_at: '2026-02-20', created_at: '2026-03-15' })
    ).toBeNull();
  });

  it('says nothing when either date is missing or unreadable — never "current"', () => {
    expect(expiredOnArrival({ expires_on: null, arrived_at: '2026-09-17' })).toBeNull();
    expect(expiredOnArrival({ expires_on: 'next spring', arrived_at: '2026-09-17' })).toBeNull();
    expect(expiredOnArrival({ expires_on: '2026-01-01' })).toBeNull();
  });
});

describe('the gap engine does not count a dead-on-arrival certificate', () => {
  const input = (closures: ClosureRow[]): SupplierGapInput => ({
    supplier_id: 'sup-1',
    supplier_name: 'Alpha Dairy',
    applicability: [
      { requirement_id: 'r-sqf', name: 'SQF Certificate', slug: 'sqf', checklist: null, sort_order: 0, tier: 'required' },
    ],
    claimOpened: [],
    closures,
    documentCount: closures.length,
    classification: { ...EMPTY_CLASSIFICATION_COUNTS, classified: closures.length },
  });
  const closure = (over: Partial<ClosureRow>): ClosureRow => ({
    requirement_id: 'r-sqf',
    document_id: 'doc-1',
    document_title: 'SQF Certificate 2025',
    confirmed_at: '2026-09-18T00:00:00Z',
    ...over,
  });

  it('leaves the requirement open, with the reason, and lists what was sent', () => {
    const gap = computeSupplierGap(
      input([closure({ expires_on: '2026-04-23', arrived_at: '2026-09-17 10:00:00' })])
    );
    expect(gap.status).toBe('open');
    expect(gap.counts.required).toEqual({ applicable: 1, satisfied: 0, open: 1 });
    const [item] = gap.open;
    expect(item.satisfied).toBe(false);
    expect(item.satisfied_by).toEqual([]);
    expect(item.gap_reason).toBe('expired_on_arrival');
    expect(item.not_counted).toHaveLength(1);
    expect(item.not_counted[0]).toMatchObject({ document_id: 'doc-1', reason: 'expired_on_arrival' });
    expect(item.summary).toBe(
      'SQF Certificate (required) — open; expired on arrival: SQF Certificate 2025 expired 2026-04-23, before it arrived on 2026-09-17'
    );
    expect(gap.caveats.map((c) => c.code)).toContain('expired_on_arrival');
  });

  it('a current certificate beside it still closes the requirement', () => {
    const gap = computeSupplierGap(
      input([
        closure({ expires_on: '2026-04-23', arrived_at: '2026-09-17' }),
        closure({ document_id: 'doc-2', document_title: 'SQF Certificate 2026', expires_on: '2027-04-23', arrived_at: '2026-09-20' }),
      ])
    );
    expect(gap.status).toBe('satisfied');
    const [item] = gap.applicable;
    expect(item.satisfied_by.map((d) => d.document_id)).toEqual(['doc-2']);
    expect(item.not_counted.map((d) => d.document_id)).toEqual(['doc-1']);
    expect(item.gap_reason).toBeNull();
    expect(gap.caveats.map((c) => c.code)).not.toContain('expired_on_arrival');
  });

  it('a closure with no expiry closes exactly as before', () => {
    const gap = computeSupplierGap(input([closure({})]));
    expect(gap.status).toBe('satisfied');
    expect(gap.applicable[0].not_counted).toEqual([]);
  });
});
