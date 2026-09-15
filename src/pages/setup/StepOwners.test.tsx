/**
 * Screen 3's sentence states the tenant's RESOLVED renewal alert lead time
 * (migration 0111), not the fixed default: type override -> organization
 * setting -> 60.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/api', () => ({ api: { expirations: { leadTime: { get: vi.fn() } } } }));
vi.mock('../../components/OwnerRoutingPanel', () => ({ default: () => null }));

import { leadDaysPhrase, ownerSentence } from './StepOwners';

describe('StepOwners lead-time sentence', () => {
  it('a brand-new tenant (nothing stored) reads the default', () => {
    expect(
      ownerSentence(['3rd Party Audit Certificate'], 'QA', { tenantLeadDays: null, typeOverrides: {} }),
    ).toBe('When a 3rd Party Audit Certificate is 60 days from expiring, QA gets the email.');
  });

  it("uses the organization's setting", () => {
    expect(
      ownerSentence(['Certificate of Insurance'], 'Insurance', { tenantLeadDays: 90, typeOverrides: {} }),
    ).toBe('When a Certificate of Insurance is 90 days from expiring, Insurance gets the email.');
  });

  it('a per-type override wins, and a spread across types is stated as a range', () => {
    const lead = { tenantLeadDays: 30, typeOverrides: { '3rd party audit certificate': 120 } };
    expect(leadDaysPhrase(['3rd Party Audit Certificate'], lead)).toBe('120 days');
    expect(leadDaysPhrase(['3rd Party Audit Certificate', 'Letter of Guarantee'], lead)).toBe(
      '30 to 120 days',
    );
  });

  it('falls back to a plain number when the lead-time read is unavailable', () => {
    expect(ownerSentence(['Spec Sheet'], 'QA', 60)).toBe(
      'When a Spec Sheet is 60 days from expiring, QA gets the email.',
    );
  });
});
