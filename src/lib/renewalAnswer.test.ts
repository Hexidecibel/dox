/**
 * The Review Queue's half of the renewal contract.
 *
 * The property under test is one distinction: an empty renewal box that MEANS
 * "this does not renew" versus an empty renewal box that means "we could not
 * work out a date and nobody has ruled". The server records the first as a
 * permanent decision (resolveRenewalExpiry tier 2) and must never be handed the
 * second.
 */

import { describe, it, expect } from 'vitest';
import { renewalAnswered, renewalAnswerPayload, renewalBoxValue } from './renewalAnswer';
import type { ResolvedRenewal } from '../../shared/renewalPeriod';

const RESOLVED: ResolvedRenewal = {
  due_date: '2027-01-15',
  rule: 'system_default_annual',
  period_months: 12,
  anchor_date: '2026-01-15',
  reason: 'Effective 2026-01-15 plus one year, the default when nothing else is set.',
};

const DOES_NOT_RENEW: ResolvedRenewal = {
  due_date: null,
  rule: 'no_renewal_period',
  period_months: null,
  anchor_date: null,
  reason: 'Documents of this type do not renew.',
};

const UNRESOLVABLE: ResolvedRenewal = {
  due_date: null,
  rule: 'unresolvable',
  period_months: 12,
  anchor_date: null,
  reason: 'Would renew after one year, but the document has no stated expiry and no effective date to count from.',
};

describe('renewalAnswered', () => {
  it('a pre-filled date left alone IS an answer — the reviewer agreed to it', () => {
    expect(renewalAnswered(RESOLVED, undefined)).toBe(true);
    expect(renewalAnswerPayload(RESOLVED, undefined)).toEqual({
      renewal: { due_date: '2027-01-15' },
    });
  });

  it('a "does not renew" proposal left alone IS an answer', () => {
    // A COA. The box is empty because the type says there is no cadence, which
    // is a statement the reviewer is agreeing with.
    expect(renewalAnswered(DOES_NOT_RENEW, undefined)).toBe(true);
    expect(renewalAnswerPayload(DOES_NOT_RENEW, undefined)).toEqual({
      renewal: { due_date: null },
    });
  });

  it('an UNRESOLVABLE proposal left alone is NOT an answer, and sends nothing', () => {
    // The defect: this used to send { due_date: null }, which was stored as
    // 'accepted' with no date and silenced the document forever.
    expect(renewalAnswered(UNRESOLVABLE, undefined)).toBe(false);
    expect(renewalAnswerPayload(UNRESOLVABLE, undefined)).toEqual({});
    expect(renewalAnswerPayload(UNRESOLVABLE, undefined).renewal).toBeUndefined();
  });

  it('an unresolvable proposal the reviewer DELIBERATELY cleared is an answer', () => {
    // They typed a date and deleted it again, or cleared the field outright:
    // '' is an edit, `undefined` is no edit, and the two are not the same.
    expect(renewalAnswered(UNRESOLVABLE, '')).toBe(true);
    expect(renewalAnswerPayload(UNRESOLVABLE, '')).toEqual({ renewal: { due_date: null } });
  });

  it('an unresolvable proposal the reviewer dated is an answer', () => {
    expect(renewalAnswerPayload(UNRESOLVABLE, '2027-04-01')).toEqual({
      renewal: { due_date: '2027-04-01' },
    });
  });

  it('clearing a date we DID propose stays an answer', () => {
    expect(renewalAnswerPayload(RESOLVED, '')).toEqual({ renewal: { due_date: null } });
  });

  it('an item with no proposal at all behaves as before', () => {
    expect(renewalAnswered(null, undefined)).toBe(true);
    expect(renewalAnswerPayload(null, undefined)).toEqual({ renewal: { due_date: null } });
  });
});

describe('renewalBoxValue', () => {
  it('shows the proposal until the reviewer touches it, then their edit', () => {
    expect(renewalBoxValue(RESOLVED, undefined)).toBe('2027-01-15');
    expect(renewalBoxValue(RESOLVED, '2028-02-02')).toBe('2028-02-02');
    expect(renewalBoxValue(RESOLVED, '')).toBe('');
    expect(renewalBoxValue(UNRESOLVABLE, undefined)).toBe('');
  });
});
