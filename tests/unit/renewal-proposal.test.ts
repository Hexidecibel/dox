/**
 * Unit tests for the approval-time renewal decision
 * (functions/lib/renewal-proposal.ts).
 *
 * The behaviour worth guarding here is the distinction the whole feature rests
 * on: a reviewer who empties the field has ANSWERED, and a client that never
 * sent the field has not. Those two must never collapse into each other — one
 * means "this document does not renew", the other means "nobody looked".
 */

import { describe, it, expect } from 'vitest';
import {
  buildRenewalProposal,
  renewalDatesFromFields,
  resolveRenewalDecision,
  type TypeRenewalConfig,
} from '../../functions/lib/renewal-proposal';
import type { RenewalSnapshot } from '../../shared/types';

const COA_TYPE: TypeRenewalConfig = { renewal_policy: 'none', renewal_interval_months: null };
const ANNUAL_TYPE: TypeRenewalConfig = { renewal_policy: 'inherit', renewal_interval_months: null };
const SPEC_TYPE: TypeRenewalConfig = { renewal_policy: 'period', renewal_interval_months: 36 };

const USER = 'user-1';
const NOW = '2026-09-02T12:00:00.000Z';

function snapshotOf(json: string): RenewalSnapshot {
  return JSON.parse(json) as RenewalSnapshot;
}

describe('renewalDatesFromFields — which extracted dates the ladder may see', () => {
  it("reads document_expires_on and NEVER the product's expiration_date", () => {
    const dates = renewalDatesFromFields({
      expiration_date: '2026-09-15',
      document_expires_on: '2027-09-01',
      effective_date: '2026-01-01',
    });
    expect(dates.document_expires_on).toBe('2027-09-01');
    expect(dates.effective_date).toBe('2026-01-01');
    // The product date is not carried out of here under any name.
    expect(Object.values(dates)).not.toContain('2026-09-15');
  });

  it('a COA carrying only a product expiry yields no document expiry at all', () => {
    expect(renewalDatesFromFields({ expiration_date: '2026-09-15' })).toEqual({
      document_expires_on: null,
      effective_date: null,
    });
  });
});

describe('buildRenewalProposal', () => {
  it('proposes "does not renew" for a COA, whatever dates it prints', () => {
    const p = buildRenewalProposal(
      { expiration_date: '2026-09-15', effective_date: '2026-03-15' },
      COA_TYPE,
    );
    expect(p.rule).toBe('no_renewal_period');
    expect(p.due_date).toBeNull();
  });

  it("proposes the certificate's own printed expiry when it states one", () => {
    const p = buildRenewalProposal(
      { document_expires_on: '2027-09-01', effective_date: '2026-01-01' },
      ANNUAL_TYPE,
    );
    expect(p.due_date).toBe('2027-09-01');
    expect(p.rule).toBe('document_expiry');
  });

  it("proposes the type's period when the document states nothing", () => {
    const p = buildRenewalProposal({ effective_date: '2026-01-15' }, SPEC_TYPE);
    expect(p.due_date).toBe('2029-01-15');
    expect(p.rule).toBe('document_type_default');
    expect(p.period_months).toBe(36);
  });
});

describe('resolveRenewalDecision — accept, override, clear, or never asked', () => {
  it('no payload at all → no decision, so no renewal columns are written', () => {
    expect(resolveRenewalDecision(undefined, { effective_date: '2026-01-15' }, ANNUAL_TYPE, USER, NOW))
      .toBeNull();
    expect(resolveRenewalDecision(null, { effective_date: '2026-01-15' }, ANNUAL_TYPE, USER, NOW))
      .toBeNull();
  });

  it('confirming the proposed date is an ACCEPT', () => {
    const w = resolveRenewalDecision(
      { due_date: '2027-01-15' },
      { effective_date: '2026-01-15' },
      ANNUAL_TYPE,
      USER,
      NOW,
    );
    expect(w).not.toBeNull();
    expect(w!.decision).toBe('accepted');
    expect(w!.due_date).toBe('2027-01-15');
    expect(w!.decided_by).toBe(USER);
    expect(w!.decided_at).toBe(NOW);
  });

  it('a different date is an OVERRIDE, and both dates survive in the snapshot', () => {
    const w = resolveRenewalDecision(
      { due_date: '2028-06-30' },
      { effective_date: '2026-01-15' },
      ANNUAL_TYPE,
      USER,
      NOW,
    );
    expect(w!.decision).toBe('overridden');
    expect(w!.due_date).toBe('2028-06-30');
    const snap = snapshotOf(w!.snapshot);
    expect(snap.proposed_due_date).toBe('2027-01-15');
    expect(snap.confirmed_due_date).toBe('2028-06-30');
    expect(snap.rule).toBe('system_default_annual');
  });

  it('emptying a date we proposed is a CLEAR — a real answer, recorded as one', () => {
    const w = resolveRenewalDecision(
      { due_date: null },
      { effective_date: '2026-01-15' },
      ANNUAL_TYPE,
      USER,
      NOW,
    );
    expect(w).not.toBeNull();
    expect(w!.decision).toBe('cleared');
    expect(w!.due_date).toBeNull();
    // The date we would have imposed is preserved, so "what did we suggest?"
    // is still answerable after the fact.
    expect(snapshotOf(w!.snapshot).proposed_due_date).toBe('2027-01-15');
  });

  it('accepting a "does not renew" proposal is an ACCEPT, not a clear', () => {
    const w = resolveRenewalDecision(
      { due_date: null },
      { expiration_date: '2026-09-15', effective_date: '2026-03-15' },
      COA_TYPE,
      USER,
      NOW,
    );
    expect(w!.decision).toBe('accepted');
    expect(w!.due_date).toBeNull();
    expect(snapshotOf(w!.snapshot).rule).toBe('no_renewal_period');
  });

  it("freezes the type configuration, so a later edit cannot rewrite the decision", () => {
    // The limit_snapshot (0085) discipline: what the decision was judged
    // against is stored WITH the decision.
    const w = resolveRenewalDecision(
      { due_date: '2029-01-15' },
      { effective_date: '2026-01-15' },
      SPEC_TYPE,
      USER,
      NOW,
    );
    const snap = snapshotOf(w!.snapshot);
    expect(snap.type_renewal_policy).toBe('period');
    expect(snap.type_renewal_interval_months).toBe(36);
    expect(snap.anchor_date).toBe('2026-01-15');
    expect(snap.reason.length).toBeGreaterThan(0);
  });

  it('a product expiry in the submitted fields cannot become the proposal', () => {
    // The regression, at the approve boundary rather than in the resolver.
    const w = resolveRenewalDecision(
      { due_date: null },
      { expiration_date: '2026-09-15', effective_date: '2026-03-15' },
      COA_TYPE,
      USER,
      NOW,
    );
    expect(snapshotOf(w!.snapshot).proposed_due_date).toBeNull();
    expect(snapshotOf(w!.snapshot).proposed_due_date).not.toBe('2026-09-15');
  });

  it('strips a time component off whatever the client sent', () => {
    const w = resolveRenewalDecision(
      { due_date: '2027-01-15T00:00:00Z' },
      { effective_date: '2026-01-15' },
      ANNUAL_TYPE,
      USER,
      NOW,
    );
    expect(w!.due_date).toBe('2027-01-15');
    expect(w!.decision).toBe('accepted');
  });
});
