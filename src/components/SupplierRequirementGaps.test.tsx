/**
 * SupplierRequirementGaps — the per-product half (migration 0123).
 *
 * Load-bearing: a supplier whose products have nothing set up reads AMBER, in
 * the same words as the supplier-level warning, never green; a per-product
 * requirement reads "N of M products"; a document that names no product is
 * listed as closing nothing; and a supplier with no per-product requirement
 * shows no per-product grid at all (the gate).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { computeSupplierGap, EMPTY_CLASSIFICATION_COUNTS } from '../../shared/requirementGap';
import type { SupplierGapInput } from '../../shared/requirementGap';
import SupplierRequirementGaps from './SupplierRequirementGaps';

function mockGap(input: SupplierGapInput) {
  const gap = computeSupplierGap(input);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ gaps: [gap] }), { status: 200 })),
  );
  return gap;
}

const base: SupplierGapInput = {
  supplier_id: 'sup-1',
  supplier_name: 'Country Morning Farms',
  applicability: [],
  claimOpened: [],
  closures: [],
  documentCount: 2,
  classification: { ...EMPTY_CLASSIFICATION_COUNTS, classified: 2 },
};

const product = (product_id: string, name: string) => ({
  product_id,
  name,
  source: 'admin',
  identified: true,
  nothing_owed: null,
});

function renderPanel() {
  return render(
    <MemoryRouter>
      <SupplierRequirementGaps supplierId="sup-1" />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SupplierRequirementGaps — per product', () => {
  it('reads amber when a product has nothing set up, and names it', async () => {
    mockGap({
      ...base,
      products: [product('p-milk', 'MS WHOLE'), product('p-lid', 'LID 38MM')],
      productOverrides: [
        {
          requirement_id: 'r-label',
          name: 'Product Label',
          slug: 'product-label',
          checklist: null,
          sort_order: 0,
          scope: 'product',
          product_id: 'p-milk',
          mode: 'add',
          tier: 'required',
          reason: null,
        },
      ],
      closures: [
        { requirement_id: 'r-label', document_id: 'd-1', document_title: 'Label', confirmed_at: null },
      ],
      productLinks: [{ document_id: 'd-1', product_id: 'p-milk' }],
    });
    renderPanel();
    expect(await screen.findByText('Some products have nothing set up')).toBeTruthy();
    expect(screen.getAllByText('Nothing set up').length).toBeGreaterThan(0);
    expect(screen.getAllByText('LID 38MM').length).toBeGreaterThan(0);
    expect(screen.queryByText(/closed by a confirmed document\.$/)).toBeNull();
  });

  it('shows "N of M products" and lists a document that names no product', async () => {
    mockGap({
      ...base,
      applicability: [
        {
          requirement_id: 'r-spec',
          name: 'Specification Sheet',
          slug: 'spec-sheet',
          checklist: null,
          sort_order: 0,
          scope: 'product',
          tier: 'required',
        },
      ],
      products: [product('p-milk', 'MS WHOLE'), product('p-cream', 'HEAVY CREAM')],
      closures: [
        { requirement_id: 'r-spec', document_id: 'd-1', document_title: 'Spec - Whole', confirmed_at: null },
        { requirement_id: 'r-spec', document_id: 'd-2', document_title: 'Spec - who knows', confirmed_at: null },
      ],
      productLinks: [{ document_id: 'd-1', product_id: 'p-milk' }],
    });
    renderPanel();
    expect(await screen.findByText('1 of 2 products')).toBeTruthy();
    expect(screen.getByText(/Confirmed, but for which product\?/)).toBeTruthy();
    expect(screen.getByText('Spec - who knows')).toBeTruthy();
    expect(screen.getByText('per product')).toBeTruthy();
  });

  it('a supplier on supplier scope only shows no per-product grid', async () => {
    mockGap({
      ...base,
      applicability: [
        {
          requirement_id: 'r-coi',
          name: 'Certificate of Insurance',
          slug: 'coi',
          checklist: null,
          sort_order: 0,
          tier: 'required',
        },
      ],
      products: [product('p-milk', 'MS WHOLE')],
      closures: [{ requirement_id: 'r-coi', document_id: 'd-1', document_title: 'COI', confirmed_at: null }],
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText(/closed by a confirmed document/)).toBeTruthy());
    expect(screen.queryByText(/Per product/)).toBeNull();
    expect(screen.queryByText('Nothing set up')).toBeNull();
  });
});
