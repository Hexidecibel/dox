import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../lib/api', () => {
  const searchV2 = vi.fn();
  const savedList = vi.fn().mockResolvedValue({ saved_searches: [] });
  const savedCreate = vi.fn();
  const savedDelete = vi.fn();
  const savedUpdate = vi.fn();
  return {
    api: {
      documents: { searchV2 },
      search: {
        saved: { list: savedList, create: savedCreate, update: savedUpdate, delete: savedDelete },
      },
    },
    __mocks: { searchV2, savedList, savedCreate, savedDelete, savedUpdate },
  };
});

import * as apiModule from '../../lib/api';
import { DocumentSearchPanel } from './DocumentSearchPanel';
const mocks = (apiModule as unknown as {
  __mocks: {
    searchV2: ReturnType<typeof vi.fn>;
    savedList: ReturnType<typeof vi.fn>;
    savedCreate: ReturnType<typeof vi.fn>;
    savedDelete: ReturnType<typeof vi.fn>;
    savedUpdate: ReturnType<typeof vi.fn>;
  };
}).__mocks;

const wrap = (ui: React.ReactNode, initial = '/') => (
  <MemoryRouter initialEntries={[initial]}>{ui}</MemoryRouter>
);

const SAMPLE_RESULT = {
  documents: [
    { id: 'd_1', title: 'Acme COA', supplier_name: 'Acme', document_type_name: 'COA' },
  ],
  total: 1,
  limit: 20,
  offset: 0,
  facets: {
    supplier: [{ value: 's_acme', label: 'Acme', count: 1 }],
    doc_type: [{ value: 't_coa', label: 'COA', count: 1 }],
    product: [],
    date_bucket: [],
  },
};

describe('DocumentSearchPanel', () => {
  beforeEach(() => {
    mocks.searchV2.mockReset();
    mocks.savedList.mockReset().mockResolvedValue({ saved_searches: [] });
    mocks.savedCreate.mockReset();
    window.localStorage.clear();
  });

  it('fires the initial search on mount with empty q', async () => {
    mocks.searchV2.mockResolvedValue(SAMPLE_RESULT);
    render(wrap(<DocumentSearchPanel />));
    await waitFor(() => expect(mocks.searchV2).toHaveBeenCalled());
    const args = mocks.searchV2.mock.calls[0][0];
    expect(args.q).toBe('');
    expect(args.facets).toBe(true);
  });

  it('renders results and supplier facet from the API response', async () => {
    mocks.searchV2.mockResolvedValue(SAMPLE_RESULT);
    render(wrap(<DocumentSearchPanel />, '/?q=acme'));
    expect(await screen.findByText('Acme COA')).toBeInTheDocument();
    expect(screen.getByText('Supplier')).toBeInTheDocument();
  });

  it('hydrates state from the URL q param', async () => {
    mocks.searchV2.mockResolvedValue(SAMPLE_RESULT);
    render(wrap(<DocumentSearchPanel />, '/?q=darigold'));
    const input = screen.getByPlaceholderText(/Search/);
    expect((input as HTMLInputElement).value).toBe('darigold');
    await waitFor(() => expect(mocks.searchV2).toHaveBeenCalled());
    const calls = mocks.searchV2.mock.calls;
    const lastArgs = calls[calls.length - 1][0];
    expect(lastArgs.q).toBe('darigold');
  });

  it('changing supplier facet refetches with the supplier_id filter', async () => {
    mocks.searchV2.mockResolvedValue(SAMPLE_RESULT);
    const user = userEvent.setup();
    render(wrap(<DocumentSearchPanel />, '/?q=foo'));
    await screen.findByText('Acme COA');
    mocks.searchV2.mockClear();

    // Click the Acme facet option in the sidebar.
    const sidebarAcme = screen.getAllByText('Acme').find((el) => el.closest('.MuiAccordion-root'));
    expect(sidebarAcme).toBeTruthy();
    await user.click(sidebarAcme!);

    await waitFor(() => expect(mocks.searchV2).toHaveBeenCalled());
    const lastCallArgs = mocks.searchV2.mock.calls[mocks.searchV2.mock.calls.length - 1][0];
    expect(lastCallArgs.supplier_id).toBe('s_acme');
  });

  it('shows error when the API rejects', async () => {
    mocks.searchV2.mockRejectedValue(new Error('500 Server Error'));
    render(wrap(<DocumentSearchPanel />, '/?q=foo'));
    expect(await screen.findByText('500 Server Error')).toBeInTheDocument();
  });
});
