import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const authState = vi.hoisted(() => ({ user: null as null | { role: string; tenant_id?: string | null } }));
vi.mock('../../contexts/AuthContext', () => ({
  useOptionalAuth: () => (authState.user ? { user: authState.user } : null),
}));

vi.mock('../../lib/api', () => {
  const query = vi.fn();
  const savedList = vi.fn().mockResolvedValue({ saved_searches: [] });
  const savedCreate = vi.fn();
  return {
    api: {
      search: {
        query,
        interpret: vi.fn(),
        examples: vi.fn().mockResolvedValue({ examples: [], as_of: '2026-09-29' }),
        natural: vi.fn(),
        universal: vi.fn().mockResolvedValue(null),
        saved: { list: savedList, create: savedCreate, update: vi.fn(), delete: vi.fn() },
      },
      customers: { list: vi.fn().mockResolvedValue({ customers: [{ id: 'c1', name: 'Harbor Seafood Co', customer_number: 'C-100' }] }) },
      documents: { getWithVersion: vi.fn().mockResolvedValue({ document: {}, currentVersion: null }) },
      documentExports: { downloadZip: vi.fn(), send: vi.fn() },
    },
    __mocks: { query, savedList, savedCreate },
  };
});

import * as apiModule from '../../lib/api';
import { SearchWorkspace } from './SearchWorkspace';
import { FilterBuilder } from './FilterBuilder';
import { AdvancedFacetRail } from './AdvancedFacetRail';
import { AdvancedResults } from './AdvancedResults';
import type { Clause, SearchQuery } from '../../../shared/searchQuery';
import type { SearchQueryResponse } from '../../../shared/types';

const mocks = (apiModule as unknown as { __mocks: { query: ReturnType<typeof vi.fn>; savedList: ReturnType<typeof vi.fn>; savedCreate: ReturnType<typeof vi.fn> } }).__mocks;
const wrap = (ui: React.ReactNode, initial = '/') => <MemoryRouter initialEntries={[initial]}>{ui}</MemoryRouter>;

const q = (clauses: Clause[], view: SearchQuery['view'] = { entity: 'documents', mode: 'advanced' }): SearchQuery => ({ v: 1, text: '', clauses, view });

const RESPONSE = {
  documents: [
    { id: 'cov', title: 'Butter COA', supplier_name: 'Cascade', document_type_name: 'COA', created_at: '2026-06-01', match_status: 'covering' },
    { id: 'lik', title: 'Legacy COA', supplier_name: 'Cascade', document_type_name: 'COA', created_at: '2026-06-01', match_status: 'likely_covering' },
    { id: 'near', title: 'Nearby COA', supplier_name: 'Cascade', document_type_name: 'COA', created_at: '2026-06-01', match_status: 'candidate_not_matching' },
  ],
  total: 3,
  limit: 25,
  offset: 0,
  labels: { s_cascade: 'Cascade' },
  clauses: [],
  scope_summary: null,
  coverage: 'covered',
  coverage_summary: '1 document on file covers lot 20726107.',
  constraints: [],
  dropped_constraints: [],
  unreviewed_candidates: [],
  facets: {
    supplier: [{ value: 's_cascade', label: 'Cascade', count: 2 }],
    spec_verdict: [{ value: 'out_of_spec', label: 'Out of spec', count: 1 }, { value: 'none', label: 'No results judged', count: 1 }],
    owner: [{ value: 'QA', label: 'QA', count: 2 }],
  },
  columns: {
    cov: { products: ['BTR BULK'], lots: ['20726107 · 03'], production: '2026-04-17', code_best_by: null, renewal_due: null, renewal_state: 'does_not_renew', spec_verdict: 'out_of_spec', classification: 'classified', owner: 'QA', intake_source: 'email', approved: '2026-09-26 10:00:00', document_number: null, certificate_number: null, po: 'K 145273', shelf_life: null },
  },
  groups: {
    entity: 'suppliers',
    rows: [{ key: 's_cascade', label: 'Cascade', detail: null, href: '/admin/suppliers/s_cascade', document_count: 2, covering_count: 1, likely_count: 1, document_ids: ['cov', 'lik'] }],
    total: 1,
    capped: false,
  },
  stats: { statements: 9, round_trips: 3, candidates: 3, scan_fallback: false },
} as unknown as SearchQueryResponse;

beforeEach(() => {
  mocks.query.mockReset();
  mocks.savedList.mockReset().mockResolvedValue({ saved_searches: [] });
  mocks.savedCreate.mockReset();
  authState.user = null;
  window.localStorage.clear();
});

describe('FilterBuilder — clause rows ARE the query', () => {
  it('renders one row per clause; a row that does not apply to the mode is greyed and kept', () => {
    const clauses: Clause[] = [
      { id: 'c1', field: 'supplier', op: 'in', values: ['s_cascade'], source: 'facet' },
      { id: 'c2', field: 'owner', op: 'in', values: ['QA'], source: 'builder' },
    ];
    render(<FilterBuilder query={q(clauses, { entity: 'suppliers', mode: 'advanced' })} labels={{ s_cascade: 'Cascade' }} facets={RESPONSE.facets!} onChange={() => {}} notApplied={['c2']} entity="suppliers" />);
    expect(screen.getByTestId('filter-row-0')).toBeInTheDocument();
    expect(screen.getByTestId('filter-na-1')).toHaveTextContent("Doesn't apply to suppliers");
    expect(screen.queryByTestId('filter-na-0')).toBeNull();
  });

  it('a row the server skipped because Orders is off for this person says THAT, not "doesn\'t apply to documents"', () => {
    const clauses: Clause[] = [{ id: 'c1', field: 'order', op: 'is', values: ['1650438'], source: 'builder' }];
    render(<FilterBuilder query={q(clauses)} labels={{}} facets={{}} onChange={() => {}} notApplied={['c1']} modulesNotApplied={['fulfillment']} entity="documents" />);
    expect(screen.getByTestId('filter-na-0')).toHaveTextContent('orders and customers are not part of your access');
    expect(screen.getByTestId('filter-na-0')).not.toHaveTextContent("Doesn't apply to");
  });

  it('an identifying field cannot be excluded (the Exclude segment is disabled)', () => {
    render(<FilterBuilder query={q([{ id: 'c1', field: 'lot', op: 'is', values: ['20726107'], source: 'builder' }])} labels={{}} facets={{}} onChange={() => {}} notApplied={[]} entity="documents" />);
    expect(screen.getByTestId('filter-exclude-0')).toBeDisabled();
  });

  it('Exclude on a scope row sends the same clause with exclude set', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<FilterBuilder query={q([{ id: 'c1', field: 'owner', op: 'in', values: ['QA'], source: 'builder' }])} labels={{}} facets={RESPONSE.facets!} onChange={onChange} notApplied={[]} entity="documents" />);
    await user.click(screen.getByTestId('filter-exclude-0'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ clauses: [expect.objectContaining({ field: 'owner', values: ['QA'], exclude: true })] }));
  });

  it('Add filter makes a draft that is not sent until it has a value', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<FilterBuilder query={q([])} labels={{}} facets={RESPONSE.facets!} onChange={onChange} notApplied={[]} entity="documents" />);
    await user.click(screen.getByTestId('add-filter'));
    expect(screen.getByText('Choose a value to apply this filter.')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('filter-values'));
    await user.click(await screen.findByRole('option', { name: /Cascade/ }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ clauses: [expect.objectContaining({ field: 'supplier', op: 'in', values: ['s_cascade'] })] }));
  });
});

describe('AdvancedFacetRail — live counts, x excludes', () => {
  it('ticking a value adds it to that field\'s clause; x on the row excludes it instead', async () => {
    const onChange = vi.fn();
    render(<AdvancedFacetRail query={q([])} facets={RESPONSE.facets!} onChange={onChange} />);
    const qa = screen.getByTestId('facet-owner').querySelector('[data-value="QA"]') as HTMLElement;
    fireEvent.click(qa);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ clauses: [expect.objectContaining({ field: 'owner', values: ['QA'] })] }));
    qa.focus();
    fireEvent.keyDown(qa, { key: 'x' });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ clauses: [expect.objectContaining({ field: 'owner', values: ['QA'], exclude: true })] }));
  });

  it('an excluded value is struck through and offers to stop excluding', () => {
    render(<AdvancedFacetRail query={q([{ id: 'c1', field: 'owner', op: 'in', values: ['QA'], exclude: true, source: 'facet' }])} facets={RESPONSE.facets!} onChange={() => {}} />);
    expect(screen.getByLabelText('Stop excluding QA')).toBeInTheDocument();
  });

  it('says how far a count moved when the filters change', () => {
    const { rerender } = render(<AdvancedFacetRail query={q([])} facets={RESPONSE.facets!} onChange={() => {}} />);
    rerender(<AdvancedFacetRail query={q([])} facets={{ ...RESPONSE.facets!, owner: [{ value: 'QA', label: 'QA', count: 5 }] }} onChange={() => {}} />);
    expect(within(screen.getByTestId('facet-owner')).getByText('+3')).toBeInTheDocument();
  });
});

describe('AdvancedResults — modes, columns, 0115 gates', () => {
  const selection = () => ({ selectedIds: new Set<string>(), includedAnyway: new Set<string>(), onToggle: vi.fn(), onIncludeAnyway: vi.fn(), onSelectMany: vi.fn() });

  it('a covering row has a checkbox; a likely or nearby one needs Include anyway', () => {
    render(wrap(<AdvancedResults data={RESPONSE} query={q([])} onQuery={() => {}} selection={selection()} onActivate={() => {}} activeId={null} />));
    expect(screen.getByTestId('select-cov')).toBeInTheDocument();
    expect(screen.getByTestId('include-anyway-lik')).toBeInTheDocument();
    expect(screen.getByTestId('include-anyway-near')).toBeInTheDocument();
    expect(screen.getByText('Likely · confirm')).toBeInTheDocument();
  });

  it('shows the chosen columns, and the chooser writes them into the view', async () => {
    const onQuery = vi.fn();
    const user = userEvent.setup();
    render(wrap(<AdvancedResults data={RESPONSE} query={q([], { entity: 'documents', mode: 'advanced', columns: ['title', 'spec_verdict', 'intake_source'] })} onQuery={onQuery} onActivate={() => {}} activeId={null} />));
    const table = screen.getByTestId('advanced-table');
    expect(within(table).getByText('Spec result')).toBeInTheDocument();
    expect(within(table).getByText('Out of spec')).toBeInTheDocument();
    expect(within(table).getByText('Email')).toBeInTheDocument();
    await user.click(screen.getByTestId('column-chooser'));
    await user.click(screen.getByTestId('column-owner'));
    expect(onQuery).toHaveBeenCalledWith(expect.objectContaining({ view: expect.objectContaining({ columns: ['title', 'spec_verdict', 'owner', 'intake_source'] }) }));
  });

  it('switching the result mode keeps every clause; Show documents narrows back to Documents', async () => {
    const onQuery = vi.fn();
    const user = userEvent.setup();
    const clauses: Clause[] = [{ id: 'c1', field: 'lot', op: 'is', values: ['20726107'], source: 'builder' }];
    const { rerender } = render(wrap(<AdvancedResults data={RESPONSE} query={q(clauses)} onQuery={onQuery} onActivate={() => {}} activeId={null} />));
    await user.click(screen.getByTestId('result-mode-suppliers'));
    expect(onQuery).toHaveBeenLastCalledWith(expect.objectContaining({ clauses, view: expect.objectContaining({ entity: 'suppliers' }) }));
    rerender(wrap(<AdvancedResults data={RESPONSE} query={q(clauses, { entity: 'suppliers', mode: 'advanced' })} onQuery={onQuery} onActivate={() => {}} activeId={null} />));
    expect(screen.getByTestId('group-table-suppliers')).toHaveTextContent('1 · 1');
    await user.click(screen.getByTestId('group-show-s_cascade'));
    const next = onQuery.mock.calls[onQuery.mock.calls.length - 1][0] as SearchQuery;
    expect(next.view.entity).toBe('documents');
    expect(next.clauses.map((c) => c.field)).toEqual(['lot', 'supplier']);
  });
});

describe('SearchWorkspace — Easy ↔ Advanced', () => {
  it('`a` switches to Advanced (mode in the URL state), which asks for every facet', async () => {
    mocks.query.mockResolvedValue(RESPONSE);
    render(wrap(<SearchWorkspace surface="documents" syncToUrl={false} />));
    await waitFor(() => expect(mocks.query).toHaveBeenCalled());
    expect(mocks.query.mock.calls[0][0].facet_fields).toEqual(['supplier', 'document_type', 'product', 'status', 'uploaded']);
    fireEvent.keyDown(document, { key: 'a' });
    expect(await screen.findByTestId('filter-builder')).toBeInTheDocument();
    expect(screen.getByTestId('advanced-facets')).toBeInTheDocument();
    await waitFor(() => expect(mocks.query.mock.calls[mocks.query.mock.calls.length - 1][0].facet_fields).toBeUndefined());
    fireEvent.keyDown(document, { key: 'a' });
    await waitFor(() => expect(screen.queryByTestId('filter-builder')).toBeNull());
  });

  it('an org_admin can save the view shared with the organization', async () => {
    authState.user = { role: 'org_admin', tenant_id: 't1' };
    mocks.query.mockResolvedValue(RESPONSE);
    mocks.savedCreate.mockResolvedValue({ saved_search: { id: 'v1', name: 'QA', query: {}, scope: 'shared', user_id: 'u', tenant_id: 't1', created_at: '', updated_at: '' } });
    const user = userEvent.setup();
    render(wrap(<SearchWorkspace surface="documents" syncToUrl={false} tenantId="t1" />));
    await waitFor(() => expect(mocks.query).toHaveBeenCalled());
    fireEvent.keyDown(document, { key: 'a' });
    await user.click(screen.getByText('Saved searches'));
    await user.type(screen.getByPlaceholderText(/Pending COAs/), 'QA view');
    await user.click(screen.getByLabelText(/Share with the organization/));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocks.savedCreate).toHaveBeenCalledWith(expect.objectContaining({ name: 'QA view', scope: 'shared', query: expect.objectContaining({ view: expect.objectContaining({ mode: 'advanced' }) }) }));
  });
});
