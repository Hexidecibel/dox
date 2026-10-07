import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const authState = vi.hoisted(() => ({ user: null as null | { role: string } }));
vi.mock('../../contexts/AuthContext', () => ({
  useOptionalAuth: () => (authState.user ? { user: authState.user } : null),
}));

vi.mock('../../lib/api', () => {
  const examples = vi.fn().mockResolvedValue({ examples: [], as_of: '2026-09-29' });
  const query = vi.fn();
  const interpret = vi.fn();
  const natural = vi.fn();
  const universal = vi.fn().mockResolvedValue(null);
  const savedList = vi.fn().mockResolvedValue({ saved_searches: [] });
  const getWithVersion = vi.fn().mockResolvedValue({ document: {}, currentVersion: null });
  return {
    api: {
      search: {
        query,
        interpret,
        examples,
        natural,
        universal,
        saved: { list: savedList, create: vi.fn(), update: vi.fn(), delete: vi.fn() },
      },
      documents: { getWithVersion },
      documentExports: { downloadZip: vi.fn(), send: vi.fn() },
    },
    __mocks: { query, interpret, natural, universal, savedList, examples },
  };
});

import * as apiModule from '../../lib/api';
import { SearchWorkspace } from './SearchWorkspace';
import type { SearchQuery } from '../../../shared/searchQuery';

const mocks = (apiModule as unknown as {
  __mocks: {
    query: ReturnType<typeof vi.fn>;
    interpret: ReturnType<typeof vi.fn>;
    natural: ReturnType<typeof vi.fn>;
    universal: ReturnType<typeof vi.fn>;
    savedList: ReturnType<typeof vi.fn>;
    examples: ReturnType<typeof vi.fn>;
  };
}).__mocks;

const wrap = (ui: React.ReactNode, initial = '/') => <MemoryRouter initialEntries={[initial]}>{ui}</MemoryRouter>;

const BASE = {
  documents: [{ id: 'd_1', title: 'Acme COA', supplier_name: 'Acme', document_type_name: 'COA' }],
  total: 1,
  limit: 25,
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

/** A lot answer: one covering certificate (two lots on it), one likely, one nearby. */
const LOT_ANSWER = {
  ...BASE,
  total: 3,
  coverage: 'covered',
  coverage_summary: '1 document on file covers lot 10426203 · sublot 03.',
  interpreted: {
    clauses: [{ id: 'd1', field: 'lot', op: 'is', values: ['10426203'], sublot: '03', source: 'detected', raw: 'lot 10426203-03' }],
    residual: 'butter',
  },
  constraints: [{ id: 'd1', kind: 'lot', label: 'lot 10426203 · sublot 03', raw: '10426203-03', value: '1042620303', fields: [], source: 'query_text' }],
  dropped_constraints: [],
  unreviewed_candidates: [],
  documents: [
    {
      id: 'cov', title: 'Darigold Butter COA', match_status: 'covering', match_checks: [],
      matched_lot: { lot_id: 'l2', lot_number: '10426203', sub_lot_code: '03', lot_key: '1042620303', production_date: '2026-07-22', production_date_raw: null, production_date_source: 'extracted', production_date_status: 'resolved', quantity: null, net_weight: null },
      doc_lots: [
        { lot_number: '10426203', sub_lot_code: '02', lot_key: '1042620302', production_date: null, production_date_source: null },
        { lot_number: '10426203', sub_lot_code: '03', lot_key: '1042620303', production_date: '2026-07-22', production_date_source: 'extracted' },
      ],
    },
    { id: 'lik', title: 'Legacy COA', match_status: 'likely_covering', match_checks: [{ constraint_id: 'd1', outcome: 'likely', message: 'Read from an older code date — confirm it.' }] },
    { id: 'near', title: 'Nearby COA', match_status: 'candidate_not_matching', match_checks: [] },
  ],
};

const lastBody = () => mocks.query.mock.calls[mocks.query.mock.calls.length - 1][0];
const lastQuery = (): SearchQuery => lastBody().query;

beforeEach(() => {
  mocks.query.mockReset();
  mocks.interpret.mockReset();
  mocks.natural.mockReset();
  mocks.universal.mockReset().mockResolvedValue(null);
  mocks.savedList.mockReset().mockResolvedValue({ saved_searches: [] });
  mocks.examples.mockReset().mockResolvedValue({ examples: [], as_of: '2026-09-29' });
  authState.user = null;
  window.localStorage.clear();
});

describe('SearchWorkspace — one surface for /documents and /search', () => {
  it('/documents lists everything on mount, with facets and interpretation on', async () => {
    mocks.query.mockResolvedValue(BASE);
    render(wrap(<SearchWorkspace surface="documents" />));
    await waitFor(() => expect(mocks.query).toHaveBeenCalled());
    expect(lastBody()).toMatchObject({ facets: true, interpret: true, query: { text: '' } });
    expect(await screen.findByText('Acme COA')).toBeInTheDocument();
    expect(screen.getByText('Supplier')).toBeInTheDocument();
  });

  it('/search asks nothing until something is typed, and leads with a Ready card', async () => {
    render(wrap(<SearchWorkspace surface="search" />));
    expect(screen.getByTestId('answer-ready')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 300));
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('hydrates from the URL, including an old-style URL', async () => {
    mocks.query.mockResolvedValue(BASE);
    render(wrap(<SearchWorkspace surface="documents" />, '/?q=darigold&supplier=s_acme,s_beta&product=p_butter&date=last_30d'));
    expect((screen.getByTestId('omnibox-input') as HTMLInputElement).value).toBe('darigold');
    await waitFor(() => expect(mocks.query).toHaveBeenCalled());
    expect(lastQuery().clauses.map((c) => [c.field, c.values])).toEqual([
      ['supplier', ['s_acme', 's_beta']],
      ['product', ['p_butter']],
      ['uploaded', ['30']],
    ]);
  });

  it('I1: multi-select sends EVERY value, and each facet adds to the others', async () => {
    mocks.query.mockResolvedValue(BASE);
    const user = userEvent.setup();
    render(wrap(<SearchWorkspace surface="documents" />, '/?q=foo'));
    await screen.findByText('Acme COA');
    const facetOption = (label: string) => screen.getAllByText(label).find((el) => el.closest('.MuiAccordion-root'))!;
    await user.click(facetOption('Acme'));
    await waitFor(() => expect(lastQuery().clauses).toHaveLength(1));
    await user.click(facetOption('Beta'));
    await user.click(facetOption('Butter'));
    await waitFor(() => expect(lastQuery().clauses).toHaveLength(2));
    expect(lastQuery().clauses.map((c) => [c.field, c.values])).toEqual([
      ['supplier', ['s_acme', 's_beta']],
      ['product', ['p_butter']],
    ]);
    expect(lastQuery().text).toBe('foo');
  });
});

describe('the omnibox: live chips, Enter, the editor, rejection', () => {
  it('shows the server reading as live chips, and Enter keeps them as the query', async () => {
    mocks.query.mockResolvedValue(LOT_ANSWER);
    const user = userEvent.setup();
    render(wrap(<SearchWorkspace surface="search" />));
    await user.type(screen.getByTestId('omnibox-input'), 'butter lot 10426203-03');
    await waitFor(() => expect(mocks.query).toHaveBeenCalled());
    const chips = await screen.findByTestId('omnibox-chips');
    await waitFor(() => expect(within(chips).getAllByText('10426203 · sublot 03').length).toBeGreaterThan(0));
    expect(chips.querySelector('[data-live="1"][data-field="lot"]')).not.toBeNull();

    // The answer card leads, before any result band.
    expect(await screen.findByTestId('covered-banner')).toHaveTextContent('1 document on file covers lot 10426203 · sublot 03.');

    mocks.query.mockResolvedValue({ ...LOT_ANSWER, interpreted: undefined });
    await user.keyboard('{Enter}');
    await waitFor(() => expect(lastQuery().text).toBe(''));
    expect(lastQuery().clauses.map((c) => [c.field, c.source])).toEqual([
      ['lot', 'detected'],
      ['text', 'typed'],
    ]);
    expect(mocks.interpret).not.toHaveBeenCalled(); // the reading on screen was the one kept
    expect((screen.getByTestId('omnibox-input') as HTMLInputElement).value).toBe('');
  });

  it('Enter before the server answered asks /api/search/interpret, never guesses', async () => {
    mocks.query.mockReturnValue(new Promise(() => {}));
    mocks.interpret.mockResolvedValue({ clauses: [{ id: 'd1', field: 'po', op: 'is', values: ['4500123'], source: 'detected', raw: '4500123' }], residual: '', labels: {} });
    const user = userEvent.setup();
    render(wrap(<SearchWorkspace surface="search" />));
    await user.type(screen.getByTestId('omnibox-input'), '4500123{Enter}');
    await waitFor(() => expect(mocks.interpret).toHaveBeenCalledWith({ text: '4500123', tenant_id: undefined }));
    await waitFor(() => expect(screen.getByTestId('clause-chip-c1')).toHaveAttribute('data-field', 'po'));
  });

  it('chip → editor → change the date role → the search re-runs with it', async () => {
    mocks.query.mockResolvedValue(BASE);
    const user = userEvent.setup();
    render(wrap(<SearchWorkspace surface="search" />, '/?f=production_date.on;src=detected;raw=produced%20Sep%202:--09-02'));
    await waitFor(() => expect(mocks.query).toHaveBeenCalled());
    await user.click(screen.getByTestId('clause-chip-c1'));
    const editor = await screen.findByTestId('clause-editor');
    expect(within(editor).getByTestId('clause-editor-source')).toHaveTextContent('Read from your words');
    await user.click(within(editor).getByTestId('date-role-code_date'));
    await waitFor(() => expect(lastQuery().clauses[0]).toMatchObject({ field: 'code_date', op: 'on', values: ['--09-02'] }));
  });

  it('rejecting a detection makes it the person\'s words, and it is not re-read', async () => {
    mocks.query.mockResolvedValue(BASE);
    const user = userEvent.setup();
    render(wrap(<SearchWorkspace surface="search" />, '/?f=lot.starts;src=detected;raw=lot%20104:104'));
    await waitFor(() => expect(mocks.query).toHaveBeenCalled());
    await user.click(screen.getByTestId('clause-chip-c1'));
    await user.click(await screen.findByTestId('clause-as-text'));
    await waitFor(() => expect(lastQuery().clauses).toEqual([
      expect.objectContaining({ field: 'text', values: ['lot 104'], source: 'typed' }),
    ]));
    // The box stays empty: nothing is put back where it would be read again.
    expect(lastQuery().text).toBe('');
  });

  it('the × on a live chip rejects just that reading', async () => {
    mocks.query.mockResolvedValue(LOT_ANSWER);
    const user = userEvent.setup();
    render(wrap(<SearchWorkspace surface="search" />));
    await user.type(screen.getByTestId('omnibox-input'), 'butter lot 10426203-03');
    const chips = await screen.findByTestId('omnibox-chips');
    // The server's reading, not the browser's optimistic one.
    await waitFor(() => expect(chips.querySelector('[data-live="1"][data-field="lot"]:not([data-pending])')).not.toBeNull());
    const lotChip = chips.querySelector('[data-live="1"][data-field="lot"]') as HTMLElement;
    await user.click(within(lotChip).getByRole('button', { name: /Remove/ }));
    await waitFor(() => expect(lastQuery().clauses.map((c) => [c.field, c.values[0], c.source])).toEqual([
      ['text', 'lot 10426203-03', 'typed'],
      ['text', 'butter', 'typed'],
    ]));
  });
});

describe('✦ Ask AI', () => {
  it('is explicit, and its reading comes back as chips marked as the AI\'s', async () => {
    mocks.query.mockResolvedValue(BASE);
    mocks.natural.mockResolvedValue({
      parsed_query: { intent_summary: 'Darigold COAs produced early September' },
      clauses: [
        { id: 'a1', field: 'supplier', op: 'in', values: ['s_dg'], source: 'ai' },
        { id: 'a2', field: 'production_date', op: 'between', values: ['2026-09-01', '2026-09-10'], source: 'ai', raw: 'early September', note: 'The question says "early September".' },
      ],
      ai_dropped: [],
      results: [],
      total: 0,
    });
    const user = userEvent.setup();
    render(wrap(<SearchWorkspace surface="search" />));
    await user.type(screen.getByTestId('omnibox-input'), 'darigold certificates from early september');
    expect(mocks.natural).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('ask-ai'));
    await waitFor(() => expect(mocks.natural).toHaveBeenCalledWith('darigold certificates from early september', undefined, expect.objectContaining({ clausesOnly: true })));
    await waitFor(() => expect(lastQuery().clauses.map((c) => c.source)).toEqual(['ai', 'ai']));
    expect(lastQuery().text).toBe('');
    const chip = await screen.findByTestId('clause-chip-c2');
    expect(chip).toHaveAttribute('data-source', 'ai');
    expect(chip).toHaveAccessibleName(/AI reading/);
    await user.click(chip);
    expect(await screen.findByTestId('clause-editor-note')).toHaveTextContent('The question says "early September".');
    expect(screen.getByTestId('ai-notice')).toHaveTextContent('Darigold COAs produced early September');
  });

  it('⌘/Ctrl+Enter in the box asks the AI', async () => {
    mocks.query.mockResolvedValue(BASE);
    mocks.natural.mockResolvedValue({ parsed_query: { intent_summary: '' }, clauses: [], results: [], total: 0 });
    const user = userEvent.setup();
    render(wrap(<SearchWorkspace surface="search" />));
    await user.type(screen.getByTestId('omnibox-input'), 'what came in');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(mocks.natural).toHaveBeenCalled());
  });
});

describe('cost: abort and de-dupe', () => {
  it('a newer query aborts the one in flight, and an identical one is not sent twice', async () => {
    const signals: AbortSignal[] = [];
    mocks.query.mockImplementation((_b: unknown, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise(() => {});
    });
    const view = render(wrap(<SearchWorkspace surface="documents" />));
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByTestId('omnibox-input'), { target: { value: 'butter' } });
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(2));
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    // Re-rendering with the same query sends nothing new.
    view.rerender(wrap(<SearchWorkspace surface="documents" />));
    await new Promise((r) => setTimeout(r, 350));
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it('keystrokes inside the debounce window are one search', async () => {
    mocks.query.mockResolvedValue(BASE);
    const user = userEvent.setup();
    render(wrap(<SearchWorkspace surface="search" />));
    await user.type(screen.getByTestId('omnibox-input'), 'unsalted');
    await waitFor(() => expect(mocks.query).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 350));
    expect(mocks.query.mock.calls.filter((c) => c[0].query.text === 'unsalted')).toHaveLength(1);
    expect(mocks.query.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe('bands and the 0115 gates, in the workspace', () => {
  it('covering has a checkbox, likely needs Include anyway, nearby is collapsed and labelled', async () => {
    mocks.query.mockResolvedValue(LOT_ANSWER);
    const user = userEvent.setup();
    render(wrap(<SearchWorkspace surface="search" enableExport />, '/?f=lot.is;sub=03:10426203'));
    expect(await screen.findByTestId('select-cov')).toBeInTheDocument();
    expect(screen.queryByTestId('select-lik')).not.toBeInTheDocument();
    expect(screen.getByTestId('include-anyway-lik')).toBeInTheDocument();
    // Nearby: collapsed until asked for, and never with a bare checkbox.
    expect(screen.queryByText('Nearby COA')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('nearby-toggle'));
    expect(await screen.findByText('Nearby COA')).toBeInTheDocument();
    expect(screen.queryByTestId('select-near')).not.toBeInTheDocument();
    expect(screen.getByTestId('include-anyway-near')).toBeInTheDocument();
  });

  it('marks the answering lot row and dims the other lots on the certificate', async () => {
    mocks.query.mockResolvedValue(LOT_ANSWER);
    render(wrap(<SearchWorkspace surface="search" />, '/?f=lot.is;sub=03:10426203'));
    const strip = await screen.findByTestId('lot-strip');
    const marked = strip.querySelectorAll('[data-answering="1"]');
    expect([...marked].map((m) => m.textContent)).toEqual(['10426203-03']);
    expect(within(strip).getByText('10426203-02')).not.toHaveAttribute('data-answering');
  });
});

describe('a selection action (migration 0134: Add to order)', () => {
  it('turns selection on by itself, keeps the Include-anyway gate, and runs with what was selected', async () => {
    mocks.query.mockResolvedValue(LOT_ANSWER);
    const onRun = vi.fn().mockResolvedValue('2 lines added to order SO-1.');
    const user = userEvent.setup();
    // No enableExport: a surface that only picks still gets checkboxes.
    render(wrap(<SearchWorkspace surface="search" selectionAction={{ label: 'Add to this order', only: true, testId: 'pick', onRun }} />, '/?f=lot.is;sub=03:10426203'));
    await user.click(await screen.findByTestId('select-cov'));
    // The likely result is still gated exactly as it is for export.
    expect(screen.queryByTestId('select-lik')).not.toBeInTheDocument();
    expect(screen.getByTestId('include-anyway-lik')).toBeInTheDocument();
    expect(screen.queryByTestId('export-download')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('pick'));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun.mock.calls[0][0].map((d: { id: string }) => d.id)).toEqual(['cov']);
    // Done: the notice shows and the selection clears.
    expect(await screen.findByText('2 lines added to order SO-1.')).toBeInTheDocument();
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
  });

  it('keeps the selection when the person backs out, and shows a refusal', async () => {
    mocks.query.mockResolvedValue(LOT_ANSWER);
    const onRun = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('This document is archived.'));
    const user = userEvent.setup();
    render(wrap(<SearchWorkspace surface="search" enableExport selectionAction={{ label: 'Add to order', testId: 'pick', onRun }} />, '/?f=lot.is;sub=03:10426203'));
    await user.click(await screen.findByTestId('select-cov'));
    // Beside ZIP and Send on a page that also exports.
    expect(screen.getByTestId('export-download')).toBeInTheDocument();

    await user.click(screen.getByTestId('pick'));
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    await user.click(screen.getByTestId('pick'));
    expect(await screen.findByText('This document is archived.')).toBeInTheDocument();
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });
});

describe('keyboard', () => {
  it('/ focuses the box; ↓ moves to a result; Space selects only where a checkbox exists', async () => {
    mocks.query.mockResolvedValue(LOT_ANSWER);
    const user = userEvent.setup();
    render(wrap(<SearchWorkspace surface="search" enableExport />, '/?f=lot.is;sub=03:10426203'));
    await screen.findByTestId('select-cov');
    (document.activeElement as HTMLElement)?.blur();
    await user.keyboard('/');
    expect(screen.getByTestId('omnibox-input')).toHaveFocus();
    (document.activeElement as HTMLElement).blur();

    await user.keyboard('{ArrowDown}');
    const rows = document.querySelectorAll('[data-nav-row]');
    expect(rows[0]).toHaveFocus();
    await user.keyboard(' ');
    expect(screen.getByTestId('select-cov')).toBeChecked();
    expect(screen.getByTestId('export-selection-bar')).toHaveTextContent('1 selected');

    await user.keyboard('{ArrowDown}');
    expect(rows[1]).toHaveFocus();
    await user.keyboard(' '); // the likely row has no checkbox until Include anyway
    expect(screen.getByTestId('export-selection-bar')).toHaveTextContent('1 selected');
  });

  it('globalShortcuts={false} leaves the page keys alone (the workspace inside a dialog)', async () => {
    mocks.query.mockResolvedValue(LOT_ANSWER);
    const user = userEvent.setup();
    render(wrap(<SearchWorkspace surface="search" enableExport globalShortcuts={false} />, '/?f=lot.is;sub=03:10426203'));
    await screen.findByTestId('select-cov');
    (document.activeElement as HTMLElement)?.blur();
    await user.keyboard('/');
    expect(screen.getByTestId('omnibox-input')).not.toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(document.querySelectorAll('[data-nav-row]')[0]).not.toHaveFocus();
    // And the legend that advertises them is gone with them.
    expect(screen.queryByTestId('keyboard-legend')).not.toBeInTheDocument();
  });

  it("Try shows the tenant's own examples, verified server-side, and a click asks it", async () => {
    mocks.examples.mockResolvedValue({
      as_of: '2026-09-29',
      examples: [
        { text: 'lot 20726135-02', kind: 'lot_dash' },
        { text: 'PO K145501', kind: 'supplier_po' },
        { text: 'butter produced May 14', kind: 'neg_adjacent_day', teaching: true, label: 'nothing on file — see how a near miss is shown' },
      ],
    });
    mocks.query.mockResolvedValue(LOT_ANSWER);
    render(wrap(<SearchWorkspace surface="search" tenantId="t1" />));
    const row = await screen.findByTestId('search-examples');
    expect(mocks.examples).toHaveBeenCalledWith('t1', expect.anything());
    expect(within(row).getByText('lot 20726135-02')).toBeInTheDocument();
    expect(within(row).queryByText('lot 10426203-03')).not.toBeInTheDocument();
    expect(within(row).getByText(/butter produced May 14 — nothing on file/)).toHaveAttribute('data-teaching', 'true');
    expect(screen.getByPlaceholderText('lot 20726135-02 · PO K145501')).toBeInTheDocument();
    await userEvent.click(within(row).getByText('PO K145501'));
    await waitFor(() => expect(mocks.query).toHaveBeenCalled());
    expect(lastQuery().text).toBe('PO K145501');
  });

  it('an empty tenant falls back to the static chips', async () => {
    render(wrap(<SearchWorkspace surface="search" tenantId="t1" />));
    const row = await screen.findByTestId('search-examples');
    expect(within(row).getByText('lot 20726114-02')).toBeInTheDocument();
  });

  it('a super_admin with no organization chosen gets no examples, and none are asked for', async () => {
    authState.user = { role: 'super_admin' };
    render(wrap(<SearchWorkspace surface="search" />));
    await new Promise((r) => setTimeout(r, 50));
    expect(mocks.examples).not.toHaveBeenCalled();
    expect(screen.queryByTestId('search-examples')).not.toBeInTheDocument();
  });

  it('a failed examples request shows no row rather than an error', async () => {
    mocks.examples.mockRejectedValue(new Error('tenant_id is required'));
    render(wrap(<SearchWorkspace surface="search" tenantId="t1" />));
    await waitFor(() => expect(mocks.examples).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('search-examples')).not.toBeInTheDocument();
  });
});
