import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../lib/api', () => {
  const query = vi.fn();
  const savedList = vi.fn().mockResolvedValue({ saved_searches: [] });
  const savedCreate = vi.fn();
  const savedDelete = vi.fn();
  const savedUpdate = vi.fn();
  return {
    api: {
      search: {
        query,
        saved: { list: savedList, create: savedCreate, update: savedUpdate, delete: savedDelete },
      },
    },
    __mocks: { query, savedList, savedCreate, savedDelete, savedUpdate },
  };
});

import * as apiModule from '../../lib/api';
import { DocumentSearchPanel } from './DocumentSearchPanel';
import type { SearchQuery } from '../../../shared/searchQuery';
const mocks = (apiModule as unknown as {
  __mocks: {
    query: ReturnType<typeof vi.fn>;
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
  labels: {},
  clauses: [],
  scope_summary: null,
  coverage: 'unconstrained',
  facets: {
    supplier: [{ value: 's_acme', label: 'Acme', count: 1 }, { value: 's_beta', label: 'Beta', count: 2 }],
    document_type: [{ value: 't_coa', label: 'COA', count: 1 }],
    product: [{ value: 'p_butter', label: 'Butter', count: 1 }],
    status: [{ value: 'active', label: 'Active', count: 1 }],
    uploaded: [{ value: 'within:30', label: 'Last 30 days', count: 1 }],
  },
  stats: { statements: 7, round_trips: 1, candidates: 0, scan_fallback: false },
};

const lastQuery = (): SearchQuery => mocks.query.mock.calls[mocks.query.mock.calls.length - 1][0].query;

describe('DocumentSearchPanel', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.savedList.mockReset().mockResolvedValue({ saved_searches: [] });
    mocks.savedCreate.mockReset();
    window.localStorage.clear();
  });

  it('fires the initial search on mount with facets and interpretation on', async () => {
    mocks.query.mockResolvedValue(SAMPLE_RESULT);
    render(wrap(<DocumentSearchPanel />));
    await waitFor(() => expect(mocks.query).toHaveBeenCalled());
    const body = mocks.query.mock.calls[0][0];
    expect(body.query.text).toBe('');
    expect(body.facets).toBe(true);
    expect(body.interpret).toBe(true);
  });

  it('renders results and the facet groups from the response', async () => {
    mocks.query.mockResolvedValue(SAMPLE_RESULT);
    render(wrap(<DocumentSearchPanel />, '/?q=acme'));
    expect(await screen.findByText('Acme COA')).toBeInTheDocument();
    expect(screen.getByText('Supplier')).toBeInTheDocument();
    // The status facet is populated now (it was always empty).
    expect(screen.getByText('Status')).toBeInTheDocument();
  });

  it('hydrates from the URL, including an old-style URL', async () => {
    mocks.query.mockResolvedValue(SAMPLE_RESULT);
    render(wrap(<DocumentSearchPanel />, '/?q=darigold&supplier=s_acme,s_beta&product=p_butter&date=last_30d'));
    expect((screen.getByPlaceholderText(/Search/) as HTMLInputElement).value).toBe('darigold');
    await waitFor(() => expect(mocks.query).toHaveBeenCalled());
    const q = lastQuery();
    expect(q.text).toBe('darigold');
    expect(q.clauses.map((c) => [c.field, c.values])).toEqual([
      ['supplier', ['s_acme', 's_beta']],
      ['product', ['p_butter']],
      ['uploaded', ['30']],
    ]);
  });

  it('I1: multi-select sends EVERY value, and each facet adds to the others', async () => {
    mocks.query.mockResolvedValue(SAMPLE_RESULT);
    const user = userEvent.setup();
    render(wrap(<DocumentSearchPanel />, '/?q=foo'));
    await screen.findByText('Acme COA');

    const facetOption = (label: string) => screen.getAllByText(label).find((el) => el.closest('.MuiAccordion-root'))!;
    await user.click(facetOption('Acme'));
    await waitFor(() => expect(lastQuery().clauses).toHaveLength(1));
    await user.click(facetOption('Beta'));
    await user.click(facetOption('Butter'));
    await user.click(facetOption('COA'));
    await user.click(facetOption('Last 30 days'));
    await user.click(facetOption('Active'));

    await waitFor(() => expect(lastQuery().clauses).toHaveLength(5));
    const q = lastQuery();
    expect(q.clauses.map((c) => [c.field, c.op, c.values])).toEqual([
      ['supplier', 'in', ['s_acme', 's_beta']],
      ['product', 'in', ['p_butter']],
      ['document_type', 'in', ['t_coa']],
      ['uploaded', 'within', ['30']],
      ['status', 'in', ['active']],
    ]);
    expect(q.text).toBe('foo');
  });

  it('an identifying answer is shown as coverage, with the "nothing covers" statement', async () => {
    mocks.query.mockResolvedValue({
      ...SAMPLE_RESULT,
      documents: [],
      total: 0,
      coverage: 'none',
      constraints: [{ id: 'd1', kind: 'po', label: 'PO K555000', raw: 'K555000', value: 'K555000', fields: [], source: 'query_text' }],
      dropped_constraints: [],
      coverage_summary: 'No document on file covers PO K555000.',
      unreviewed_candidates: [],
    });
    render(wrap(<DocumentSearchPanel />, '/?q=PO%20K555000'));
    expect(await screen.findByTestId('no-coverage-banner')).toHaveTextContent('No document on file covers PO K555000.');
    expect(screen.getByTestId('documents-coverage-answer')).toBeInTheDocument();
  });

  it('shows error when the API rejects', async () => {
    mocks.query.mockRejectedValue(new Error('500 Server Error'));
    render(wrap(<DocumentSearchPanel />, '/?q=foo'));
    expect(await screen.findByText('500 Server Error')).toBeInTheDocument();
  });
});
