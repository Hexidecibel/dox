/**
 * SupplierListImport — upload goes straight to a dry run, the preview leads
 * with unusable rows and flagged requirements, and only "Apply" writes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const importList = vi.fn();
const imports = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    supplierList: {
      import: (...a: unknown[]) => importList(...a),
      imports: (...a: unknown[]) => imports(...a),
    },
  },
}));

import SupplierListImport, { importSummary } from './SupplierListImport';
import type { SupplierListImportResponse } from '../../shared/types';

const counts = {
  rows_total: 3, rows_accepted: 2, rows_rejected: 1, suppliers_listed: 2, suppliers_matched: 1, suppliers_created: 1,
  suppliers_not_approved: 0, products_matched: 0, products_unmatched: 1, claims_unmatched: 1, requirements_added: 5,
  requirements_adopted_unconfirmed: 2, requirements_refreshed: 0, requirements_tier_changed: 1, requirements_kept_person_set: 1, requirements_held_unconfirmed: 0,
  requirements_newly_flagged: 1, requirements_still_flagged: 0,
};

const PREVIEW: SupplierListImportResponse = {
  dry_run: true,
  run_id: null,
  pack: 'fsqa',
  file_name: 'list.csv',
  counts,
  suppliers: [
    {
      supplier_key: 'sup_1', supplier_id: 'sup_1', supplier_name: 'Darigold, Inc.', supplier_match: 'matched', approved: true,
      categories: ['ingredient'], products: ['0801 Butter'], contact_emails: [],
      lines: [
        { requirement_slug: 'letter-of-guarantee', requirement_name: 'Letter of Guarantee on file', tier: 'required', action: 'add', from_tier: null, existing_source: null, because: ['"rbst-free" claim on 0801 Butter'] },
      ],
    },
  ],
  flagged: [
    { row_id: 'r9', supplier_id: 'sup_2', supplier_name: 'Andersen Dairy', requirement_slug: 'kosher-certificate', requirement_name: 'Kosher Certificate on file', tier: 'required', already_flagged: false },
  ],
  rows: [
    { line: 4, status: 'rejected', supplier_name: 'Blank Co', supplier_id: null, supplier_match: 'unresolved', category: 'ingredient', approved: null, product_label: null, product_id: null, product_name_matched: null, claims_matched: [], claims_unmatched: [], problems: ['Approved is blank. Enter Y or N.'], warnings: [] },
  ],
  unmatched: [
    { line: 4, kind: 'row', value: 'Blank Co', reason: 'Approved is blank. Enter Y or N.' },
    { line: 2, kind: 'claim', value: 'vegan', reason: '"vegan" is not a claim type in this tenant, so nothing was derived for it.' },
  ],
  rule_problems: [],
  unrecognized_headers: [],
  rules: { baseline: ['certificate-of-insurance'], category_packets: {}, product_spec_sheet: 'spec-sheet' },
};

beforeEach(() => {
  importList.mockReset();
  imports.mockReset();
  imports.mockResolvedValue({ imports: [] });
});

describe('SupplierListImport', () => {
  it('uploads to a dry run, shows problems and flags first, and applies only on request', async () => {
    const user = userEvent.setup();
    const onApplied = vi.fn();
    importList.mockResolvedValueOnce(PREVIEW).mockResolvedValueOnce({ ...PREVIEW, dry_run: false, run_id: 'run_1' });
    render(<SupplierListImport onApplied={onApplied} />);

    const file = new File(['Supplier name,Supplier category,Approved (Y/N)\nA,ingredient,Y\n'], 'list.csv', { type: 'text/csv' });
    await user.upload(screen.getByTestId('supplier-list-file'), file);

    await waitFor(() => expect(importList).toHaveBeenCalledTimes(1));
    expect(importList.mock.calls[0][0]).toMatchObject({ dry_run: true, file_name: 'list.csv', csv: expect.stringContaining('Supplier name') });
    expect(await screen.findByText(/nothing has been written yet/)).toBeInTheDocument();
    expect(screen.getByText(/1 row could not be used/)).toBeInTheDocument();
    expect(screen.getByText(/Line 4 \(Blank Co\): Approved is blank/)).toBeInTheDocument();
    expect(screen.getByText(/"vegan" is not a claim type/)).toBeInTheDocument();
    expect(screen.getByText(/will be flagged for review, not deleted/)).toBeInTheDocument();
    expect(screen.getByText(/Andersen Dairy: Kosher Certificate on file \(required\)/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Apply this list' }));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    expect(importList.mock.calls[1][0]).toMatchObject({ dry_run: false, file_name: 'list.csv' });
    expect(await screen.findByText(/Imported list.csv/)).toBeInTheDocument();
  });

  it('summarises counts in words', () => {
    expect(importSummary(PREVIEW)).toBe(
      '2 suppliers (1 matched, 1 new) · 5 requirements to add · 2 unconfirmed confirmed by the list · 1 tier change · 1 kept as a person set them · 1 no longer on the list (flagged)',
    );
  });
});
