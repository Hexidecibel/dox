/**
 * Public form pick-lists are OFF unless the form builder opts a field in
 * (decision C-120).
 *
 *   - the builder shows the switch on a customer / supplier / product field
 *     only, off by default, with a plain warning once it is on;
 *   - the public page draws a pick-list only for a field marked `picker`, and
 *     a text box for every other one -- even when a list of that kind arrived
 *     for a different field of the form.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../lib/recordsApi', () => ({ recordsApi: {}, publicFormsApi: {} }));
vi.mock('../../lib/api', () => ({ api: {} }));

import { FieldRow } from './FormBuilder';
import { FieldStep } from '../../components/forms/PublicFormRenderer';
import type { ApiRecordColumn, PublicFormFieldDef, RecordFormFieldConfig } from '../../../shared/types';

function column(type: ApiRecordColumn['type'], label: string): ApiRecordColumn {
  return {
    id: `col-${label}`,
    sheet_id: 'sheet',
    tenant_id: 'tenant',
    key: label.toLowerCase(),
    label,
    type,
    config: null,
    required: 0,
    is_title: 0,
    display_order: 0,
    width: null,
    archived: 0,
    created_at: '',
    updated_at: '',
  };
}

function row(col: ApiRecordColumn, field: Partial<RecordFormFieldConfig>, onChange = vi.fn()) {
  render(
    <FieldRow
      column={col}
      field={{ column_id: col.id, position: 0, ...field }}
      isFirst
      isLast
      onMove={() => {}}
      onChange={onChange}
      onRemove={() => {}}
    />,
  );
  return onChange;
}

describe('the form builder: publishing a list is a switch somebody turns on', () => {
  it('is off for a supplier field that says nothing, and says what off means', () => {
    row(column('supplier_ref', 'Supplier'), {});
    const toggle = screen.getByRole('checkbox', { name: 'Let people pick from your list of suppliers' });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/people type a name and it is saved as text for you to match/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('List is public')).toBeNull();
  });

  it('turning it on asks for public_picker: true', async () => {
    const onChange = row(column('customer_ref', 'Customer'), {});
    await userEvent.setup().click(screen.getByRole('checkbox', { name: 'Let people pick from your list of customers' }));
    expect(onChange).toHaveBeenCalledWith({ public_picker: true });
  });

  it('once on, warns in plain words that the list is readable by anyone with the link', () => {
    row(column('product_ref', 'Product'), { public_picker: true });
    expect(screen.getByRole('checkbox', { name: 'Let people pick from your list of products' })).toBeChecked();
    const warning = screen.getByRole('alert');
    expect(warning.textContent).toContain("Anyone who has this form's link can read the names of all your active products");
    expect(warning.textContent).toContain('without signing in');
    expect(screen.getByText('List is public')).toBeInTheDocument();
  });

  it('a field that is not a customer, supplier or product has no such switch', () => {
    row(column('text', 'Notes'), { public_picker: true });
    expect(screen.queryByRole('checkbox', { name: /Let people pick/ })).toBeNull();
    expect(screen.queryByText('List is public')).toBeNull();
  });
});

describe('the public page: a pick-list only where the field opted in', () => {
  const options = { supplier: [{ id: 'sup-1', name: 'Alpha Dairy' }] };
  const field = (extra: Partial<PublicFormFieldDef>): PublicFormFieldDef => ({
    key: 'supplier',
    type: 'supplier_ref',
    label: 'Supplier',
    required: false,
    position: 0,
    ...extra,
  });

  it('a field without the opt-in is a text box, even when a supplier list came with the form', async () => {
    const onChange = vi.fn();
    render(
      <FieldStep field={field({})} value="" onChange={onChange} onSubmit={() => {}} isMobile={false} accent="#1A365D" entityOptions={options} />,
    );
    expect(screen.queryByRole('combobox')).toBeNull();
    const input = screen.getByPlaceholderText('Enter name');
    await userEvent.setup().type(input, 'A');
    // What is typed is the value: text, never an id.
    expect(onChange).toHaveBeenCalledWith('A');
  });

  it('a field with the opt-in is a pick-list', () => {
    render(
      <FieldStep field={field({ picker: true })} value={null} onChange={() => {}} onSubmit={() => {}} isMobile={false} accent="#1A365D" entityOptions={options} />,
    );
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });
});
