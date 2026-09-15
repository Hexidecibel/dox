/**
 * Suppliers on watch — a passed review-by is flagged, never hidden, and the
 * panel groups a supplier's limits and required analytes together.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ReviewByCell, SupplierWatchPanel } from './SupplierWatchPanel';

const listLimits = vi.fn();
const listRequired = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    specLimits: { list: (...a: unknown[]) => listLimits(...a), update: vi.fn(), remove: vi.fn() },
    specRequiredAnalytes: {
      list: (...a: unknown[]) => listRequired(...a),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    },
    specTests: { list: async () => ({ specTests: [{ id: 'st', name: 'Coliform', aliases: [] }] }) },
    suppliers: { list: async () => ({ suppliers: [{ id: 'sup', name: 'Andersen Dairy Inc.' }] }) },
    documentTypes: { list: async () => ({ documentTypes: [{ id: 'dt', name: 'Certificate of Analysis' }] }) },
  },
}));

beforeEach(() => {
  listLimits.mockResolvedValue({
    specLimits: [
      { id: 'l_company', spec_test_id: 'st', supplier_id: null, operator: '<=', value_max: 10, unit: 'CFU/g', test_name: 'Coliform' },
      {
        id: 'l_watch',
        spec_test_id: 'st',
        supplier_id: 'sup',
        supplier_name: 'Andersen Dairy Inc.',
        operator: '<=',
        value_max: 1,
        unit: 'CFU/g',
        test_name: 'Coliform',
        review_by: '2026-09-01',
      },
    ],
  });
  listRequired.mockResolvedValue({
    requiredAnalytes: [
      {
        id: 'ra',
        supplier_id: 'sup',
        supplier_name: 'Andersen Dairy Inc.',
        document_type_id: 'dt',
        document_type_name: 'Certificate of Analysis',
        spec_test_id: 'st',
        test_name: 'E. coli',
        effective_from: null,
        review_by: '2026-12-31',
        reason: 'Sanitation watch',
      },
    ],
  });
});

describe('ReviewByCell', () => {
  it('shows the date inside the period and the ended flag after it', () => {
    const { rerender } = render(<ReviewByCell reviewBy="2026-09-01" asOf="2026-09-01" />);
    expect(screen.getByText('Review by 2026-09-01')).toBeTruthy();
    rerender(<ReviewByCell reviewBy="2026-09-01" asOf="2026-09-02" />);
    expect(screen.getByText('Watch period ended 2026-09-01 — review')).toBeTruthy();
  });
});

describe('SupplierWatchPanel', () => {
  it('lists only supplier-scoped rules, grouped, with the overdue one flagged', async () => {
    render(
      <MemoryRouter>
        <SupplierWatchPanel asOf="2026-09-15" />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByTestId('supplier-watch-panel')).toBeTruthy());
    expect(screen.getByText('Andersen Dairy Inc.')).toBeTruthy();
    expect(screen.getByText('Supplier limit')).toBeTruthy();
    expect(screen.getByText('Required analyte')).toBeTruthy();
    // The company-wide limit is not a watch and is not listed.
    expect(screen.getAllByText(/Limit ≤/)).toHaveLength(1);
    expect(screen.getByTestId('watch-ended').textContent).toContain('2026-09-01');
    expect(screen.getByText('1 past review-by')).toBeTruthy();
  });
});
