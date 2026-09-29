import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

vi.mock('../../lib/api', () => {
  const interpret = vi.fn();
  const universal = vi.fn();
  return { api: { search: { interpret, universal } }, __mocks: { interpret, universal } };
});

import * as apiModule from '../../lib/api';
import { CommandPalette } from './CommandPalette';
import { AnswerCard } from './AnswerCard';
import { chipParts } from '../../lib/searchChips';

const mocks = (apiModule as unknown as { __mocks: { interpret: ReturnType<typeof vi.fn>; universal: ReturnType<typeof vi.fn> } }).__mocks;

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{`${loc.pathname}${loc.search}`}</div>;
}

const EMPTY_UNIVERSAL = {
  documents: { total: 0, results: [] }, suppliers: { total: 1, results: [{ id: 'S1', name: 'Darigold, Inc.' }] }, products: { total: 0, results: [] },
  doc_types: { total: 0, results: [] }, orders: { total: 0, results: [] }, customers: { total: 0, results: [] }, bundles: { total: 0, results: [] },
};

function renderPalette() {
  const onClose = vi.fn();
  render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Routes>
        <Route path="*" element={<><CommandPalette open onClose={onClose} modKey="Ctrl " /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  );
  return onClose;
}

beforeEach(() => {
  window.localStorage.clear();
  mocks.interpret.mockReset().mockResolvedValue({ clauses: [{ id: 'd1', field: 'lot', op: 'starts', values: ['104'], source: 'detected' }], residual: '', labels: {} });
  mocks.universal.mockReset().mockResolvedValue(EMPTY_UNIVERSAL);
});

describe('CommandPalette (⌘K / Ctrl-K)', () => {
  it('shows how the words will read, and Enter searches on /search', async () => {
    const user = userEvent.setup();
    const onClose = renderPalette();
    await user.type(screen.getByTestId('palette-input'), 'lot 104');
    expect(await screen.findByText(/reads as lot starts with · 104/)).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByTestId('where')).toHaveTextContent('/search?q=lot+104');
  });

  it('Ctrl+Enter hands the words to the AI', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.type(screen.getByTestId('palette-input'), 'what came in last week');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(screen.getByTestId('where')).toHaveTextContent('ai=1');
  });

  it('arrows move to a supplier, which opens search filtered to it', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.type(screen.getByTestId('palette-input'), 'dari');
    await screen.findByText('Darigold, Inc.');
    // Search, Ask AI, then the supplier.
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('f=supplier.in%3AS1'));
  });
});

describe('AnswerCard', () => {
  it('nothing covers: says so first, and names the nearest as NOT the answer', () => {
    render(
      <AnswerCard
        coverage="none"
        coverage_summary="No document on file covers production date Sep 2. Searched within: Supplier: Darigold."
        documents={[{ id: 'n', title: 'Butter COA', match_status: 'candidate_not_matching' }]}
      />,
    );
    const card = screen.getByTestId('no-coverage-banner');
    expect(card).toHaveTextContent('Nothing covers');
    expect(card).toHaveTextContent('No document on file covers production date Sep 2.');
    expect(screen.getByTestId('answer-scope')).toHaveTextContent('Searched within: Supplier: Darigold.');
    expect(screen.getByTestId('answer-nearest')).toHaveTextContent('It does not answer the question.');
  });

  it('an ambiguous product: counts per product, nothing picked, one click to choose', async () => {
    const onPick = vi.fn();
    render(
      <AnswerCard
        coverage="covered"
        documents={[]}
        ambiguous={{ phrase: '5 gal bag', countNoun: 'covering or likely', onPick, candidates: [{ id: 'P1', label: 'Cream 5 gal bag', count: 2 }, { id: 'P2', label: 'H&H 5 gal bag', count: 0 }] }}
      />,
    );
    const card = screen.getByTestId('ambiguous-coverage-banner');
    expect(card).toHaveTextContent('“5 gal bag” fits 2 products. Nothing was picked.');
    expect(card).toHaveTextContent('2 covering or likely');
    await userEvent.click(screen.getByTestId('answer-pick-P2'));
    expect(onPick).toHaveBeenCalledWith('P2');
  });
});

describe('chip words', () => {
  it('reads each kind of clause the way a person would say it', () => {
    expect(chipParts({ id: 'c', field: 'production_date', op: 'on', values: ['--09-02'], source: 'detected' })).toEqual({ key: 'production date', value: 'Sep 2', note: 'any year' });
    expect(chipParts({ id: 'c', field: 'lot', op: 'is', values: ['10426203'], sublot: '03', source: 'detected' })).toMatchObject({ key: 'lot', value: '10426203 · sublot 03', mono: true });
    expect(chipParts({ id: 'c', field: 'supplier', op: 'in', values: ['S1'], exclude: true, source: 'facet' }, { S1: 'Darigold' })).toMatchObject({ key: 'not supplier', value: 'Darigold' });
    expect(chipParts({ id: 'c', field: 'product', op: 'in', values: ['A', 'B'], ambiguous: true, raw: '5 gal bag', source: 'ai' })).toMatchObject({ value: '“5 gal bag”', note: 'could mean 2 products' });
    expect(chipParts({ id: 'c', field: 'text', op: 'contains', values: ['butter'], source: 'typed' })).toMatchObject({ key: 'mentions', value: '“butter”' });
  });
});
