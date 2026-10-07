/**
 * Approved items (migration 0135): the list keeps APPROVAL and SUPPLIED as two
 * columns, marks private label as a label, and offers a decision only to an
 * admin.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ApprovedItem, ApprovedItemsResponse } from '../../../shared/types';

const listItems = vi.fn();
const listSuppliers = vi.fn();
const updateLink = vi.fn();
let role: 'org_admin' | 'user' = 'org_admin';

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', role, tenant_id: 't1' },
    isSuperAdmin: false,
    isAdmin: role === 'org_admin',
  }),
}));
vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ selectedTenantId: null }),
}));
vi.mock('../../lib/api', () => ({
  api: {
    approvedItems: { list: (...args: unknown[]) => listItems(...args) },
    suppliers: {
      list: (...args: unknown[]) => listSuppliers(...args),
      facilities: { list: vi.fn() },
    },
    supplierProducts: { update: (...args: unknown[]) => updateLink(...args) },
  },
}));

import { ApprovedItems } from './ApprovedItems';

function item(over: Partial<ApprovedItem>): ApprovedItem {
  return {
    link_id: 'l1',
    product_id: 'p1',
    product_name: 'Whole Milk',
    product_active: true,
    our_sku: '30417',
    supplier_id: 's1',
    supplier_name: 'Acme Creamery',
    facility: null,
    approval_status: 'approved',
    approval_source: 'initial',
    approval_decided_at: null,
    approval_decided_by: null,
    approval_decided_by_name: null,
    approval_note: null,
    supplied: true,
    discontinued_at: null,
    link_source: 'admin',
    brand_owner: null,
    producer: null,
    plant_code: null,
    private_label: false,
    ...over,
  };
}

const RESPONSE: ApprovedItemsResponse = {
  items: [
    item({ brand_owner: 'Northwind Foods', producer: 'Acme Creamery', private_label: true }),
    item({
      link_id: 'l2',
      product_id: 'p2',
      product_name: 'Heavy Cream',
      our_sku: null,
      facility: { id: 'f1', name: 'Lynden Plant', plant_code: '53-104', active: true },
      approval_status: 'not_approved',
      approval_source: 'person',
      approval_decided_by_name: 'Dana Reyes',
      approval_decided_at: '2026-10-01 12:00:00',
      approval_note: 'Failed the 2026 audit',
      supplied: false,
      discontinued_at: '2026-09-01 00:00:00',
    }),
  ],
  total: 2,
  counts: { approved: 1, pending: 3, not_approved: 1 },
  limit: 50,
  offset: 0,
};

const renderPage = () =>
  render(
    <MemoryRouter>
      <ApprovedItems />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  role = 'org_admin';
  listItems.mockResolvedValue(RESPONSE);
  listSuppliers.mockResolvedValue({ suppliers: [{ id: 's1', name: 'Acme Creamery' }], total: 1 });
  updateLink.mockResolvedValue({ link: {} });
});

describe('ApprovedItems', () => {
  it('shows approval and supplied as two separate facts on every row', async () => {
    renderPage();
    const rows = await screen.findAllByTestId('approved-item-row');
    expect(rows).toHaveLength(2);

    expect(rows[0]).toHaveTextContent('Whole Milk');
    expect(rows[0]).toHaveTextContent('30417');
    expect(within(rows[0]).getByTestId('item-approval-chip')).toHaveTextContent('Approved');
    expect(rows[0]).toHaveTextContent('Currently supplied');
    expect(rows[0]).toHaveTextContent('No facility recorded');
    expect(within(rows[0]).getByTestId('private-label-chip')).toBeInTheDocument();

    // Not approved AND no longer supplied: both said, neither hides the other.
    expect(within(rows[1]).getByTestId('item-approval-chip')).toHaveTextContent('Not approved');
    expect(rows[1]).toHaveTextContent('No longer supplied');
    expect(rows[1]).toHaveTextContent('Failed the 2026 audit');
    expect(rows[1]).toHaveTextContent('Dana Reyes, 2026-10-01');
    expect(rows[1]).toHaveTextContent('Lynden Plant (53-104)');
    expect(within(rows[1]).queryByTestId('private-label-chip')).not.toBeInTheDocument();
  });

  it('counts each status on its tab and filters by it', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId('approved-item-row');
    expect(screen.getByTestId('approved-items-tab-all')).toHaveTextContent('All (5)');
    expect(screen.getByTestId('approved-items-tab-pending')).toHaveTextContent('Pending (3)');
    expect(screen.getByTestId('approved-items-tab-not_approved')).toHaveTextContent('Not approved (1)');

    await user.click(screen.getByTestId('approved-items-tab-pending'));
    await waitFor(() => expect(listItems).toHaveBeenLastCalledWith(expect.objectContaining({ approval: 'pending', offset: 0 })));
  });

  it('an admin decides from the row; the list reloads', async () => {
    const user = userEvent.setup();
    renderPage();
    const rows = await screen.findAllByTestId('approved-item-row');
    const before = listItems.mock.calls.length;
    await user.click(within(rows[1]).getByTestId('item-approval-chip'));
    await user.click(screen.getByText('Approve'));
    expect(updateLink).toHaveBeenCalledWith('s1', 'p2', { approval_status: 'approved' });
    await waitFor(() => expect(listItems.mock.calls.length).toBeGreaterThan(before));
  });

  it('a plain user reads the list and is offered no decision', async () => {
    role = 'user';
    const user = userEvent.setup();
    renderPage();
    const rows = await screen.findAllByTestId('approved-item-row');
    await user.click(within(rows[0]).getByTestId('item-approval-chip'));
    expect(screen.queryByText('Approve')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Set facility/ })).not.toBeInTheDocument();
  });

  it('an empty list says how an item gets here', async () => {
    listItems.mockResolvedValue({ items: [], total: 0, counts: { approved: 0, pending: 0, not_approved: 0 }, limit: 50, offset: 0 });
    renderPage();
    expect(await screen.findByText('No items linked to a supplier yet')).toBeInTheDocument();
  });
});
