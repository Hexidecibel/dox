/**
 * RequirementsWorklist — rows needing a person, with the reason in words and
 * bulk confirm / remove.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const listAll = vi.fn();
const review = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    supplierRequirements: {
      listAll: (...a: unknown[]) => listAll(...a),
      review: (...a: unknown[]) => review(...a),
      packets: vi.fn().mockResolvedValue({ pack: 'fsqa', pack_label: 'FSQA', packets: [] }),
      applyPacket: vi.fn(),
    },
  },
}));

import RequirementsWorklist, { worklistReason } from './RequirementsWorklist';
import type { ApiSupplierRequirement } from '../lib/types';

function row(over: Partial<ApiSupplierRequirement>): ApiSupplierRequirement {
  return {
    id: 'sr_1', tenant_id: 't1', supplier_id: 'sup_1', requirement_id: 'req_1', tier: 'required', notes: null,
    created_at: '', created_by: null, updated_at: '', updated_by: null, source: null, review_flag: null,
    requirement_name: 'W-9 on file', supplier_name: 'Alpha Dairy', ...over,
  };
}

beforeEach(() => {
  listAll.mockReset();
  review.mockReset();
});

describe('RequirementsWorklist', () => {
  it('explains each row and confirms the selection', async () => {
    const user = userEvent.setup();
    listAll.mockResolvedValue([
      row({ id: 'a' }),
      row({ id: 'b', source: 'derived', review_flag: 'not_on_verified_list', requirement_name: 'Kosher Certificate on file' }),
    ]);
    review.mockResolvedValue({ action: 'confirm', applied: 2, not_found: [] });
    const onChanged = vi.fn();
    render(<RequirementsWorklist onChanged={onChanged} />);

    expect(await screen.findByText('Set by the initial bulk seed — not confirmed')).toBeInTheDocument();
    expect(screen.getByText('No longer on the verified supplier list — review')).toBeInTheDocument();
    expect(listAll).toHaveBeenCalledWith({ tenant_id: undefined, review: 'any' });

    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    await user.click(screen.getByLabelText('Select all for Alpha Dairy'));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(review).toHaveBeenCalledWith({ action: 'confirm', ids: ['a', 'b'], tenant_id: undefined }));
    expect(await screen.findByText('Confirmed 2 requirements.')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it('asks before removing', async () => {
    const user = userEvent.setup();
    listAll.mockResolvedValue([row({ id: 'a' })]);
    review.mockResolvedValue({ action: 'remove', applied: 1, not_found: [] });
    render(<RequirementsWorklist />);
    await user.click(await screen.findByLabelText('Select W-9 on file for Alpha Dairy'));
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(review).not.toHaveBeenCalled();
    const buttons = await screen.findAllByRole('button', { name: 'Remove' });
    await user.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(review).toHaveBeenCalledWith({ action: 'remove', ids: ['a'], tenant_id: undefined }));
  });

  it('says so when nothing needs review', async () => {
    listAll.mockResolvedValue([]);
    render(<RequirementsWorklist />);
    expect(await screen.findByText(/Nothing needs review/)).toBeInTheDocument();
    expect(worklistReason({ source: 'human', review_flag: null })).toBe('Needs review');
  });
});
