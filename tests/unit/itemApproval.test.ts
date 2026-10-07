/**
 * The pure rules behind approved items, facilities and a customer's COA
 * requirements (migration 0135): the private-label flag, the facility key, the
 * approval plan an import and a person share, and the two things an order
 * review reads from the customer's record.
 */
import { describe, it, expect } from 'vitest';
import {
  describeApprovalSource,
  describeCustomerRequirement,
  isItemApprovalStatus,
  isPrivateLabel,
  normalizeFacilityName,
} from '../../shared/itemApproval';
import { missingRequirementWarning, planItemRequirements, planOrderRecipients } from '../../shared/orderSend';
import { planApprovalDecision } from '../../functions/lib/item-approval';
import type { CustomerItemRequirement } from '../../shared/types';

describe('isPrivateLabel', () => {
  it('needs both parties recorded and different', () => {
    expect(isPrivateLabel('Northwind Foods', 'Acme Creamery')).toBe(true);
    expect(isPrivateLabel('Acme Creamery', 'Acme Creamery')).toBe(false);
  });

  it('ignores case and spaces', () => {
    expect(isPrivateLabel('Acme  Creamery', ' ACME CREAMERY ')).toBe(false);
    expect(isPrivateLabel('AcmeCreamery', 'acme creamery')).toBe(false);
  });

  it('one of them missing is "not known", which is not private label', () => {
    expect(isPrivateLabel('Northwind Foods', null)).toBe(false);
    expect(isPrivateLabel(null, 'Acme Creamery')).toBe(false);
    expect(isPrivateLabel('   ', 'Acme Creamery')).toBe(false);
    expect(isPrivateLabel(undefined, undefined)).toBe(false);
  });
});

describe('normalizeFacilityName', () => {
  it('folds case and collapses whitespace, and nothing else', () => {
    expect(normalizeFacilityName('  Lynden   PLANT ')).toBe('lynden plant');
    expect(normalizeFacilityName('Lynden Plant #2')).toBe('lynden plant #2');
    expect(normalizeFacilityName(null)).toBe('');
  });
});

describe('approval vocabulary', () => {
  it('is closed', () => {
    expect(['approved', 'pending', 'not_approved'].every(isItemApprovalStatus)).toBe(true);
    expect(isItemApprovalStatus('rejected')).toBe(false);
    expect(isItemApprovalStatus(null)).toBe(false);
  });

  it('never words the backfill as a person\'s sign-off', () => {
    expect(describeApprovalSource('initial')).not.toMatch(/person/i);
    expect(describeApprovalSource('person')).toMatch(/person/i);
    expect(describeApprovalSource(null)).toBe('Not decided yet');
  });
});

describe('planApprovalDecision', () => {
  const row = (status: 'approved' | 'pending' | 'not_approved', source: 'initial' | 'person' | 'import' | null, note: string | null = null) => ({
    approval_status: status,
    approval_source: source,
    approval_note: note,
  });

  it('not approved needs a note, from anyone', () => {
    expect(() => planApprovalDecision(row('approved', 'initial'), { status: 'not_approved', source: 'person' })).toThrow(/note/);
    expect(() => planApprovalDecision(row('approved', 'initial'), { status: 'not_approved', note: '  ', source: 'import' })).toThrow(/note/);
  });

  it('an import never overrides a person, to agree or to disagree', () => {
    expect(planApprovalDecision(row('not_approved', 'person', 'audit'), { status: 'approved', source: 'import' })).toMatchObject({
      write: false,
      kept: 'person_decided',
    });
    expect(planApprovalDecision(row('approved', 'person'), { status: 'approved', source: 'import' })).toMatchObject({
      write: false,
      kept: 'person_decided',
    });
  });

  it('an import that agrees with what is on file does not restamp it', () => {
    expect(planApprovalDecision(row('approved', 'initial'), { status: 'approved', source: 'import' })).toMatchObject({ write: false, kept: 'same' });
    expect(planApprovalDecision(row('pending', null), { status: 'approved', source: 'import' })).toMatchObject({ write: true });
    expect(planApprovalDecision(row('approved', 'import'), { status: 'not_approved', note: 'list says N', source: 'import' })).toMatchObject({ write: true });
  });

  it('a person re-affirming an initial or imported answer makes it theirs', () => {
    expect(planApprovalDecision(row('approved', 'initial'), { status: 'approved', source: 'person' })).toMatchObject({ write: true });
    expect(planApprovalDecision(row('approved', 'import'), { status: 'approved', source: 'person' })).toMatchObject({ write: true });
    expect(planApprovalDecision(row('approved', 'person'), { status: 'approved', source: 'person' })).toMatchObject({ write: false, kept: 'same' });
    // The same status with a different note is a change.
    expect(planApprovalDecision(row('not_approved', 'person', 'a'), { status: 'not_approved', note: 'b', source: 'person' })).toMatchObject({ write: true, note: 'b' });
  });
});

describe('describeCustomerRequirement', () => {
  it('says only what was recorded', () => {
    expect(describeCustomerRequirement({ coa_required: 'yes' })).toBe('COA required');
    expect(describeCustomerRequirement({ coa_required: 'yes', must_show: 'lot number', timing: 'with the shipment' })).toBe(
      'COA required - must show lot number - with the shipment',
    );
    expect(describeCustomerRequirement({ coa_required: 'no', must_show: '  ' })).toBe('No COA needed');
    expect(describeCustomerRequirement({ coa_required: 'on_request', timing: 'within 2 days' })).toBe('COA on request - within 2 days');
  });
});

describe('planOrderRecipients', () => {
  const cap = 10;

  it('with no contact at all, the customer\'s own address -- the pre-0135 answer', () => {
    expect(planOrderRecipients({ coaContacts: [], deliveryContacts: [], customerEmail: 'qa@x.example', cap })).toEqual({
      recipients: ['qa@x.example'],
      source: 'customer_email',
      over_cap: 0,
    });
    expect(planOrderRecipients({ coaContacts: [], deliveryContacts: [], customerEmail: null, cap })).toEqual({
      recipients: [],
      source: 'none',
      over_cap: 0,
    });
  });

  it('COA contacts in the order given, then delivery contacts, each address once', () => {
    const plan = planOrderRecipients({
      coaContacts: [{ email: 'qa@x.example' }, { email: 'buyer@x.example' }],
      deliveryContacts: [{ email: 'QA@X.example' }, { email: 'lab@x.example' }],
      customerEmail: 'general@x.example',
      cap,
    });
    expect(plan).toEqual({ recipients: ['qa@x.example', 'buyer@x.example', 'lab@x.example'], source: 'coa_contacts', over_cap: 0 });
  });

  it('counts what the cap leaves off', () => {
    const plan = planOrderRecipients({
      coaContacts: Array.from({ length: 13 }, (_, i) => ({ email: `p${i}@x.example` })),
      deliveryContacts: [],
      customerEmail: null,
      cap,
    });
    expect(plan.recipients).toHaveLength(10);
    expect(plan.over_cap).toBe(3);
  });
});

describe('planItemRequirements', () => {
  const req = (productId: string, over: Partial<CustomerItemRequirement> = {}): CustomerItemRequirement => ({
    id: `r-${productId}`,
    customer_id: 'c',
    product_id: productId,
    product_name: `Item ${productId}`,
    product_active: true,
    coa_required: 'yes',
    must_show: null,
    timing: null,
    delivery_contact_id: null,
    delivery_contact: null,
    source: 'admin',
    notes: null,
    created_at: '',
    updated_at: '',
    ...over,
  });
  const line = (id: string, productId: string | null) => ({ order_item_id: id, product_id: productId, product_name: null, lot_label: null });

  it('a line with no product, or an item with no requirement, gets no row', () => {
    const rows = planItemRequirements([line('l1', null), line('l2', 'other')], new Map([['milk', req('milk')]]), new Set());
    expect(rows).toEqual([]);
    expect(missingRequirementWarning(rows)).toBeNull();
  });

  it('missing only when required AND nothing on that line will be sent', () => {
    const requirements = new Map([
      ['milk', req('milk')],
      ['cream', req('cream')],
      ['butter', req('butter', { coa_required: 'on_request' })],
      ['salt', req('salt', { coa_required: 'no' })],
    ]);
    const rows = planItemRequirements(
      [line('l1', 'milk'), line('l2', 'cream'), line('l3', 'butter'), line('l4', 'salt'), line('l5', 'cream')],
      requirements,
      new Set(['l1']),
    );
    expect(rows.map((r) => [r.order_item_id, r.missing])).toEqual([
      ['l1', false],
      ['l2', true],
      ['l3', false],
      ['l4', false],
      ['l5', true],
    ]);
    // The item is named once however many of its lines are short.
    const warning = missingRequirementWarning(rows)!;
    expect(warning).toContain('Item cream');
    expect(warning.match(/Item cream/g)).toHaveLength(1);
    expect(warning).toContain('2 of those lines');
  });
});
