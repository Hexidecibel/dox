/**
 * SupplierRequirementsEditor — the behaviours that are load-bearing rather than
 * cosmetic.
 *
 * Two of them are the whole reason the screen exists:
 *
 *   1. A supplier with nothing attached must read as "nothing set up yet", in
 *      warning colours, and must NOT read as "nothing outstanding". That is the
 *      false-clean failure `SupplierRequirementGaps` already guards against on
 *      the same page, and the two surfaces have to agree.
 *   2. The required/recommended tier has to be changeable from the row itself.
 *      The gap report counts required and ignores recommended, so a tier buried
 *      in a dialog is a tier nobody adjusts — and everything-required is how a
 *      gap report gets muted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const listSupplierRequirements = vi.fn();
const listRequirements = vi.fn();
const updateSupplierRequirement = vi.fn();
const detachSupplierRequirement = vi.fn();
const attachSupplierRequirement = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    supplierRequirements: {
      list: (...args: unknown[]) => listSupplierRequirements(...args),
      update: (...args: unknown[]) => updateSupplierRequirement(...args),
      detach: (...args: unknown[]) => detachSupplierRequirement(...args),
      attach: (...args: unknown[]) => attachSupplierRequirement(...args),
    },
    requirements: {
      list: (...args: unknown[]) => listRequirements(...args),
    },
  },
}));

import SupplierRequirementsEditor, {
  groupByChecklist,
  orderAttached,
  tierCounts,
  TierToggle,
} from './SupplierRequirementsEditor';
import type { ApiSupplierRequirement } from '../lib/types';

function row(over: Partial<ApiSupplierRequirement>): ApiSupplierRequirement {
  return {
    id: 'sr_1',
    tenant_id: 't1',
    supplier_id: 'sup_1',
    requirement_id: 'req_1',
    tier: 'required',
    notes: null,
    created_at: '2026-01-01',
    created_by: null,
    updated_at: '2026-01-01',
    updated_by: null,
    requirement_name: 'Letter of Guarantee',
    requirement_slug: 'letter-of-guarantee',
    requirement_checklist: 'SOP 110',
    requirement_active: 1,
    ...over,
  };
}

const VOCAB = [
  {
    id: 'req_1',
    tenant_id: 't1',
    slug: 'letter-of-guarantee',
    name: 'Letter of Guarantee',
    description: null,
    checklist: 'SOP 110',
    sort_order: 0,
    active: 1,
    created_at: '',
    updated_at: '',
  },
  {
    id: 'req_2',
    tenant_id: 't1',
    slug: 'allergen-matrix',
    name: 'Allergen Matrix',
    description: null,
    checklist: null,
    sort_order: 0,
    active: 1,
    created_at: '',
    updated_at: '',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  listRequirements.mockResolvedValue({ requirements: VOCAB });
  listSupplierRequirements.mockResolvedValue({
    supplierRequirements: [],
    total: 0,
    limit: 200,
    offset: 0,
  });
});

describe('ordering and counting helpers', () => {
  it('puts required before recommended — the set the gap report actually counts', () => {
    const ordered = orderAttached([
      row({ id: 'a', tier: 'recommended', requirement_name: 'A' }),
      row({ id: 'b', tier: 'required', requirement_name: 'Z' }),
    ]);
    expect(ordered.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('counts the two tiers separately', () => {
    expect(
      tierCounts([
        row({ id: 'a', tier: 'required' }),
        row({ id: 'b', tier: 'required' }),
        row({ id: 'c', tier: 'recommended' }),
      ]),
    ).toEqual({ required: 2, recommended: 1 });
  });

  it('groups by checklist and sinks the Ungrouped fallback to the bottom', () => {
    const groups = groupByChecklist([
      { checklist: null, name: 'loose' },
      { checklist: 'SOP 110', name: 'a' },
      { checklist: 'SOP 102.2', name: 'b' },
    ]);
    expect(groups.map((g) => g.checklist)).toEqual(['SOP 102.2', 'SOP 110', 'Ungrouped']);
  });
});

describe('TierToggle', () => {
  it('shows both tiers at once — neither is hidden behind the other', () => {
    render(<TierToggle tier="required" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Required' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recommended' })).toBeInTheDocument();
  });

  it('ignores a re-click on the active tier — there is no "no tier" state', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TierToggle tier="required" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Required' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('SupplierRequirementsEditor', () => {
  it('reads a supplier with nothing attached as NOT SET UP, never as compliant', async () => {
    render(<SupplierRequirementsEditor supplierId="sup_1" supplierName="Acme Dairy" />);

    expect(await screen.findByText('Nothing set up yet')).toBeInTheDocument();
    expect(
      screen.getByText(/nothing is being checked/i),
    ).toBeInTheDocument();
    // The distinction the whole panel turns on, emphasised in the copy.
    expect(screen.getByText('not').tagName).toBe('STRONG');
    expect(screen.getByText(/the same as compliant/i)).toBeInTheDocument();
  });

  it('says so plainly when the tenant has no checklist to draw from at all', async () => {
    listRequirements.mockResolvedValue({ requirements: [] });
    render(<SupplierRequirementsEditor supplierId="sup_1" supplierName="Acme Dairy" />);
    expect(await screen.findByText('No requirements to draw from')).toBeInTheDocument();
    // A different problem from "nobody configured this supplier", so a
    // different message — the fix is in Settings, not on this supplier.
    expect(screen.queryByText('Nothing set up yet')).not.toBeInTheDocument();
  });

  it('renders each attached item as a sentence and counts the tiers', async () => {
    listSupplierRequirements.mockResolvedValue({
      supplierRequirements: [
        row({ id: 'a', tier: 'required', requirement_name: 'Letter of Guarantee' }),
        row({ id: 'b', tier: 'recommended', requirement_name: 'Allergen Matrix' }),
      ],
      total: 2,
      limit: 200,
      offset: 0,
    });
    render(<SupplierRequirementsEditor supplierId="sup_1" supplierName="Acme Dairy" />);

    expect(await screen.findByText('Letter of Guarantee')).toBeInTheDocument();
    expect(screen.getByText('must provide')).toBeInTheDocument();
    expect(screen.getByText('should provide')).toBeInTheDocument();
    expect(screen.getByText(/Only required items are counted as gaps/i)).toBeInTheDocument();
  });

  it('changes tier straight from the row, without opening anything', async () => {
    const user = userEvent.setup();
    listSupplierRequirements.mockResolvedValue({
      supplierRequirements: [row({ id: 'sr_9', tier: 'required' })],
      total: 1,
      limit: 200,
      offset: 0,
    });
    updateSupplierRequirement.mockResolvedValue({ supplierRequirement: row({ id: 'sr_9' }) });

    render(<SupplierRequirementsEditor supplierId="sup_1" supplierName="Acme Dairy" />);
    await screen.findByText('Letter of Guarantee');

    await user.click(screen.getByRole('button', { name: 'Recommended' }));

    await waitFor(() =>
      expect(updateSupplierRequirement).toHaveBeenCalledWith('sr_9', { tier: 'recommended' }),
    );
  });

  it('detaching asks the API to remove the row, not to re-tier it', async () => {
    const user = userEvent.setup();
    listSupplierRequirements.mockResolvedValue({
      supplierRequirements: [row({ id: 'sr_9' })],
      total: 1,
      limit: 200,
      offset: 0,
    });
    detachSupplierRequirement.mockResolvedValue({ success: true });

    render(<SupplierRequirementsEditor supplierId="sup_1" supplierName="Acme Dairy" />);
    await screen.findByText('Letter of Guarantee');

    await user.click(screen.getByRole('button', { name: /Remove Letter of Guarantee/i }));
    await waitFor(() => expect(detachSupplierRequirement).toHaveBeenCalledWith('sr_9'));
  });

  it('only offers checklist items that are not already attached', async () => {
    const user = userEvent.setup();
    listSupplierRequirements.mockResolvedValue({
      supplierRequirements: [row({ id: 'sr_9', requirement_id: 'req_1' })],
      total: 1,
      limit: 200,
      offset: 0,
    });

    render(<SupplierRequirementsEditor supplierId="sup_1" supplierName="Acme Dairy" />);
    await screen.findByText('Letter of Guarantee');

    await user.click(screen.getByRole('button', { name: /Add requirements/i }));

    expect(await screen.findByRole('checkbox', { name: 'Allergen Matrix' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Letter of Guarantee' })).not.toBeInTheDocument();
  });

  it('attaches the picked items at the chosen tier', async () => {
    const user = userEvent.setup();
    attachSupplierRequirement.mockResolvedValue({ supplierRequirement: row({}) });

    render(<SupplierRequirementsEditor supplierId="sup_1" supplierName="Acme Dairy" />);
    await screen.findByText('Nothing set up yet');

    await user.click(screen.getByRole('button', { name: /Add requirements/i }));
    await user.click(await screen.findByRole('checkbox', { name: 'Allergen Matrix' }));
    // The tier is chosen in the dialog too, so a batch of advisory items does
    // not have to be added as required and then downgraded one by one.
    await user.click(screen.getByRole('button', { name: 'Recommended' }));
    await user.click(screen.getByRole('button', { name: /^Add 1 as recommended$/i }));

    await waitFor(() =>
      expect(attachSupplierRequirement).toHaveBeenCalledWith(
        expect.objectContaining({
          supplier_id: 'sup_1',
          requirement_id: 'req_2',
          tier: 'recommended',
        }),
      ),
    );
  });
});
