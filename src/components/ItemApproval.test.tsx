/**
 * The screens migration 0135 adds: the approval and facility controls, the
 * Supplier > Facilities tab, and the two customer panels.
 *
 * What they have to get right is small and specific:
 *   - an approval that nobody decided never reads as a person's sign-off;
 *   - "not approved" cannot be saved without a note;
 *   - a read-only account is offered nothing to change;
 *   - "no facility recorded" and "no contact" are said in words, not left as
 *     an empty table to be read as "fine".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../lib/api', () => {
  const updateLink = vi.fn();
  const facilitiesList = vi.fn();
  const facilitiesCreate = vi.fn();
  const facilitiesRemove = vi.fn();
  const contactsList = vi.fn();
  const contactsCreate = vi.fn();
  const requirementsList = vi.fn();
  const approvedList = vi.fn();
  const productsUpdate = vi.fn();
  return {
    api: {
      supplierProducts: { update: updateLink },
      suppliers: { facilities: { list: facilitiesList, create: facilitiesCreate, remove: facilitiesRemove, update: vi.fn() } },
      customers: {
        contacts: { list: contactsList, create: contactsCreate, update: vi.fn(), remove: vi.fn() },
        itemRequirements: { list: requirementsList, create: vi.fn(), update: vi.fn(), remove: vi.fn() },
      },
      approvedItems: { list: approvedList },
      products: { update: productsUpdate, list: vi.fn() },
    },
    __mocks: {
      updateLink, facilitiesList, facilitiesCreate, facilitiesRemove, contactsList, contactsCreate,
      requirementsList, approvedList, productsUpdate,
    },
  };
});

import * as apiModule from '../lib/api';
import { ItemApprovalControl, ItemFacilityControl } from './ItemApproval';
import SupplierFacilitiesPanel from './SupplierFacilitiesPanel';
import CustomerContactsPanel from './CustomerContactsPanel';
import CustomerItemRequirementsPanel from './CustomerItemRequirementsPanel';
import ProductAttributionPanel from './ProductAttributionPanel';
import type { ApiProduct } from '../lib/types';

const mocks = (apiModule as unknown as { __mocks: Record<string, ReturnType<typeof vi.fn>> }).__mocks;

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.updateLink.mockResolvedValue({ link: {} });
  mocks.approvedList.mockResolvedValue({ items: [], total: 0, counts: { approved: 0, pending: 0, not_approved: 0 }, limit: 200, offset: 0 });
});

describe('ItemApprovalControl', () => {
  const base = { supplierId: 's1', productId: 'p1', productName: 'Whole Milk', onChanged: vi.fn() };

  it('an approval nobody decided is outlined and says so; a person\'s is filled', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ItemApprovalControl {...base} status="approved" source="initial" canEdit={false} />);
    const chip = screen.getByTestId('item-approval-chip');
    expect(chip).toHaveTextContent('Approved');
    expect(chip.className).toContain('MuiChip-outlined');
    await user.hover(chip);
    expect(await screen.findByText('On file when approvals were introduced')).toBeInTheDocument();

    rerender(<ItemApprovalControl {...base} status="approved" source="person" canEdit={false} />);
    expect(screen.getByTestId('item-approval-chip').className).toContain('MuiChip-filled');
  });

  it('a link with nothing recorded reads pending', () => {
    render(<ItemApprovalControl {...base} status={null} source={null} canEdit={false} />);
    expect(screen.getByTestId('item-approval-chip')).toHaveTextContent('Pending');
  });

  it('a read-only account gets the chip and no menu', async () => {
    const user = userEvent.setup();
    render(<ItemApprovalControl {...base} status="pending" source={null} canEdit={false} />);
    await user.click(screen.getByTestId('item-approval-chip'));
    expect(screen.queryByText('Approve')).not.toBeInTheDocument();
  });

  it('approves in one click', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    render(<ItemApprovalControl {...base} onChanged={onChanged} status="pending" source={null} canEdit />);
    await user.click(screen.getByTestId('item-approval-chip'));
    await user.click(screen.getByText('Approve'));
    expect(mocks.updateLink).toHaveBeenCalledWith('s1', 'p1', { approval_status: 'approved' });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('not approved cannot be saved without a note, and sends it', async () => {
    const user = userEvent.setup();
    render(<ItemApprovalControl {...base} status="approved" source="initial" canEdit />);
    await user.click(screen.getByTestId('item-approval-chip'));
    await user.click(screen.getByText('Mark not approved…'));

    const confirm = screen.getByRole('button', { name: 'Mark not approved' });
    expect(confirm).toBeDisabled();
    expect(screen.getByText(/does not change whether\s+the item is currently supplied/)).toBeInTheDocument();
    await user.type(screen.getByTestId('item-approval-note'), 'Failed the 2026 audit');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(mocks.updateLink).toHaveBeenCalledWith('s1', 'p1', {
      approval_status: 'not_approved',
      approval_note: 'Failed the 2026 audit',
    });
  });

  it('shows the server\'s refusal instead of closing', async () => {
    const user = userEvent.setup();
    mocks.updateLink.mockRejectedValue(new Error('Marking an item not approved needs a note saying why'));
    render(<ItemApprovalControl {...base} status="approved" source="initial" canEdit />);
    await user.click(screen.getByTestId('item-approval-chip'));
    await user.click(screen.getByText('Mark not approved…'));
    await user.type(screen.getByTestId('item-approval-note'), 'x');
    await user.click(screen.getByRole('button', { name: 'Mark not approved' }));
    expect(await screen.findByText(/needs a note saying why/)).toBeInTheDocument();
  });
});

describe('ItemFacilityControl', () => {
  const base = { supplierId: 's1', productId: 'p1', productName: 'Whole Milk', onChanged: vi.fn() };
  const facility = (over: Record<string, unknown>) => ({
    id: 'f1', supplier_id: 's1', name: 'Lynden Plant', plant_code: '53-104', notes: null, active: true, item_count: 0,
    created_at: '', updated_at: '', ...over,
  });

  it('says "No facility recorded" and offers a read-only account nothing', () => {
    render(<ItemFacilityControl {...base} facilityId={null} facilityName={null} canEdit={false} />);
    expect(screen.getByText('No facility recorded')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers the supplier\'s facilities in use, and a retired one only to the item that has it', async () => {
    const user = userEvent.setup();
    mocks.facilitiesList.mockResolvedValue({
      supplier: { id: 's1', name: 'Acme' },
      facilities: [facility({}), facility({ id: 'f2', name: 'Old Plant', plant_code: null, active: false })],
    });
    render(<ItemFacilityControl {...base} facilityId={null} facilityName={null} canEdit />);
    await user.click(screen.getByRole('button', { name: 'Set facility for Whole Milk' }));
    await user.click(await screen.findByRole('combobox'));
    const options = within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['No facility recorded', 'Lynden Plant (53-104)']);

    await user.click(screen.getByText('Lynden Plant (53-104)'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocks.updateLink).toHaveBeenCalledWith('s1', 'p1', { facility_id: 'f1' });
  });
});

describe('SupplierFacilitiesPanel', () => {
  it('with none, says every item counts toward the whole supplier', async () => {
    mocks.facilitiesList.mockResolvedValue({ supplier: { id: 's1', name: 'Acme Creamery' }, facilities: [] });
    render(<SupplierFacilitiesPanel supplierId="s1" supplierName="Acme Creamery" canEdit />);
    expect(await screen.findByTestId('no-facilities')).toHaveTextContent('Every item counts toward the whole supplier');
    expect(screen.getByText(/Nothing is read off a\s+certificate/)).toBeInTheDocument();
  });

  it('adds one, and says how many items lost their facility when one is removed', async () => {
    const user = userEvent.setup();
    const row = {
      id: 'f1', supplier_id: 's1', name: 'Lynden Plant', plant_code: '53-104', notes: null, active: true, item_count: 2,
      created_at: '', updated_at: '',
    };
    mocks.facilitiesList.mockResolvedValue({ supplier: { id: 's1', name: 'Acme Creamery' }, facilities: [] });
    mocks.facilitiesCreate.mockResolvedValue({ supplier: { id: 's1', name: 'Acme Creamery' }, facilities: [row], facility: row });
    mocks.facilitiesRemove.mockResolvedValue({ supplier: { id: 's1', name: 'Acme Creamery' }, facilities: [], cleared_items: 2 });
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);

    render(<SupplierFacilitiesPanel supplierId="s1" supplierName="Acme Creamery" canEdit />);
    await user.click(await screen.findByRole('button', { name: 'Add facility' }));
    await user.type(screen.getByLabelText(/^Name/), 'Lynden Plant');
    await user.type(screen.getByLabelText(/^Plant code/), '53-104');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocks.facilitiesCreate).toHaveBeenCalledWith('s1', { name: 'Lynden Plant', plant_code: '53-104', notes: null });
    expect(await screen.findByText('Lynden Plant')).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Remove Lynden Plant', hidden: true }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('2 items will go back to "no facility recorded"'));
    expect(await screen.findByText(/2 items now have no facility recorded/)).toBeInTheDocument();
  });

  it('a read-only account sees the list and no buttons', async () => {
    mocks.facilitiesList.mockResolvedValue({ supplier: { id: 's1', name: 'Acme' }, facilities: [] });
    render(<SupplierFacilitiesPanel supplierId="s1" supplierName="Acme" canEdit={false} />);
    await screen.findByTestId('no-facilities');
    expect(screen.queryByRole('button', { name: 'Add facility' })).not.toBeInTheDocument();
  });
});

describe('CustomerContactsPanel', () => {
  it('with nobody marked, says which address an order send starts with', async () => {
    mocks.contactsList.mockResolvedValue({
      customer: { id: 'c1', name: 'Blue Heron Foods', email: 'general@blueheron.example' },
      contacts: [],
    });
    render(<CustomerContactsPanel customerId="c1" customerName="Blue Heron Foods" canEdit />);
    expect(await screen.findByTestId('no-coa-recipients')).toHaveTextContent(
      "starts with the customer's own address, general@blueheron.example",
    );
  });

  it('marks who receives COAs, and adds a contact as a recipient by default', async () => {
    const user = userEvent.setup();
    const contact = {
      id: 'k1', customer_id: 'c1', name: 'Quinn', email: 'qa@blueheron.example', role: 'QA', is_primary: true,
      coa_recipient: true, created_at: '', updated_at: '',
    };
    const customer = { id: 'c1', name: 'Blue Heron Foods', email: null };
    mocks.contactsList.mockResolvedValue({ customer, contacts: [contact] });
    mocks.contactsCreate.mockResolvedValue({ customer, contacts: [contact], contact });
    render(<CustomerContactsPanel customerId="c1" customerName="Blue Heron Foods" canEdit />);

    expect(await screen.findByText('Receives COAs')).toBeInTheDocument();
    expect(screen.getByText('Primary')).toBeInTheDocument();
    expect(screen.queryByTestId('no-coa-recipients')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add contact' }));
    await user.type(screen.getByLabelText(/^Email/), 'buyer@blueheron.example');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocks.contactsCreate).toHaveBeenCalledWith('c1', {
      name: null,
      email: 'buyer@blueheron.example',
      role: null,
      is_primary: false,
      coa_recipient: true,
    });
  });
});

describe('CustomerItemRequirementsPanel', () => {
  it('lists what the customer needs per item, in its own words', async () => {
    mocks.requirementsList.mockResolvedValue({
      customer: { id: 'c1', name: 'Blue Heron Foods' },
      requirements: [
        {
          id: 'r1', customer_id: 'c1', product_id: 'p1', product_name: 'Whole Milk', product_active: true,
          coa_required: 'yes', must_show: 'lot number and best-by date', timing: 'with the shipment',
          delivery_contact_id: 'k1', delivery_contact: { id: 'k1', name: 'Dee', email: 'lab@blueheron.example' },
          source: 'admin', notes: null, created_at: '', updated_at: '',
        },
        {
          id: 'r2', customer_id: 'c1', product_id: 'p2', product_name: 'Butter', product_active: true,
          coa_required: 'on_request', must_show: null, timing: null, delivery_contact_id: null, delivery_contact: null,
          source: 'admin', notes: null, created_at: '', updated_at: '',
        },
      ],
    });
    render(<CustomerItemRequirementsPanel customerId="c1" customerName="Blue Heron Foods" tenantId="t1" canEdit={false} />);
    expect(await screen.findByText('Whole Milk')).toBeInTheDocument();
    expect(screen.getByText('COA required')).toBeInTheDocument();
    expect(screen.getByText('lot number and best-by date')).toBeInTheDocument();
    expect(screen.getByText('Dee')).toBeInTheDocument();
    expect(screen.getByText('COA on request')).toBeInTheDocument();
    expect(screen.getByText(/Nothing is stopped by it/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add requirement' })).not.toBeInTheDocument();
  });

  it('with none, says so', async () => {
    mocks.requirementsList.mockResolvedValue({ customer: { id: 'c1', name: 'Blue Heron Foods' }, requirements: [] });
    render(<CustomerItemRequirementsPanel customerId="c1" customerName="Blue Heron Foods" tenantId="t1" canEdit />);
    expect(await screen.findByTestId('no-item-requirements')).toBeInTheDocument();
  });
});

describe('ProductAttributionPanel', () => {
  const product = (over: Partial<ApiProduct> = {}): ApiProduct =>
    ({
      id: 'p1', tenant_id: 't1', name: 'Whole Milk', slug: 'whole-milk', description: null, active: 1,
      created_at: '', updated_at: '', brand_owner: null, producer: null, plant_code: null, ...over,
    }) as ApiProduct;
  const wrap = (ui: React.ReactNode) => <MemoryRouter>{ui}</MemoryRouter>;

  it('shows what is recorded, and marks private label only when both parties are known and differ', async () => {
    const { rerender } = render(wrap(<ProductAttributionPanel product={product({ brand_owner: 'Northwind Foods' })} canEdit onSaved={vi.fn()} />));
    expect(screen.getByText('Northwind Foods')).toBeInTheDocument();
    expect(screen.getAllByText('Not recorded')).toHaveLength(2);
    expect(screen.queryByTestId('private-label-chip')).not.toBeInTheDocument();

    rerender(wrap(<ProductAttributionPanel product={product({ brand_owner: 'Northwind Foods', producer: 'Acme Creamery' })} canEdit onSaved={vi.fn()} />));
    expect(screen.getByTestId('private-label-chip')).toBeInTheDocument();

    rerender(wrap(<ProductAttributionPanel product={product({ brand_owner: 'Acme  Creamery', producer: 'ACME CREAMERY' })} canEdit onSaved={vi.fn()} />));
    expect(screen.queryByTestId('private-label-chip')).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.approvedList).toHaveBeenCalled());
  });

  it('edits the three fields that had an API and no screen', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const saved = product({ brand_owner: 'Northwind Foods', producer: 'Acme Creamery', plant_code: '53-104' });
    mocks.productsUpdate.mockResolvedValue({ product: saved });
    render(wrap(<ProductAttributionPanel product={product()} canEdit onSaved={onSaved} />));

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.type(screen.getByLabelText('Brand owner'), 'Northwind Foods');
    await user.type(screen.getByLabelText('Producer'), 'Acme Creamery');
    await user.type(screen.getByLabelText('Plant code'), '53-104');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocks.productsUpdate).toHaveBeenCalledWith('p1', {
      brand_owner: 'Northwind Foods',
      producer: 'Acme Creamery',
      plant_code: '53-104',
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
  });

  it('lists the suppliers of the item with their approval, and offers a read-only account no Edit', async () => {
    mocks.approvedList.mockResolvedValue({
      items: [
        {
          link_id: 'l1', product_id: 'p1', product_name: 'Whole Milk', product_active: true, our_sku: null,
          supplier_id: 's1', supplier_name: 'Acme Creamery', facility: { id: 'f1', name: 'Lynden Plant', plant_code: null, active: true },
          approval_status: 'not_approved', approval_source: 'person', approval_decided_at: null, approval_decided_by: null,
          approval_decided_by_name: null, approval_note: 'On hold', supplied: false, discontinued_at: '2026-08-01',
          link_source: 'admin', brand_owner: null, producer: null, plant_code: null, private_label: false,
        },
      ],
      total: 1, counts: { approved: 0, pending: 0, not_approved: 1 }, limit: 200, offset: 0,
    });
    render(wrap(<ProductAttributionPanel product={product()} canEdit={false} onSaved={vi.fn()} />));
    expect(await screen.findByText('Acme Creamery')).toBeInTheDocument();
    expect(screen.getByText('Lynden Plant')).toBeInTheDocument();
    expect(screen.getByTestId('item-approval-chip')).toHaveTextContent('Not approved');
    // Approval and "supplied" are separate columns.
    expect(screen.getByText('No longer supplied')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });
});
