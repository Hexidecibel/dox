import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../lib/api', () => {
  const universal = vi.fn();
  return {
    api: { search: { universal } },
    __mocks: { universal },
  };
});

import * as apiModule from '../../lib/api';
import { UniversalSearchPanel } from './UniversalSearchPanel';
const mocks = (apiModule as unknown as {
  __mocks: { universal: ReturnType<typeof vi.fn> };
}).__mocks;

const RESPONSE = {
  documents: { total: 142, results: [{ id: 'd1', title: 'Doc A' }] },
  suppliers: { total: 3, results: [] },
  products: { total: 5, results: [] },
  doc_types: { total: 1, results: [] },
  orders: { total: 18, results: [{ id: 'o1', order_number: 'SO-1' }] },
  customers: { total: 2, results: [{ id: 'c1', name: 'Sysco' }] },
  bundles: { total: 0, results: [] },
};

const wrap = (ui: React.ReactNode, initial = '/') => (
  <MemoryRouter initialEntries={[initial]}>{ui}</MemoryRouter>
);

describe('UniversalSearchPanel', () => {
  beforeEach(() => {
    mocks.universal.mockReset();
    window.localStorage.clear();
  });

  it('does not fetch on empty q', () => {
    render(wrap(<UniversalSearchPanel />));
    expect(mocks.universal).not.toHaveBeenCalled();
    expect(
      screen.getByText('Type to search across documents, orders, customers, and bundles.'),
    ).toBeInTheDocument();
  });

  it('fetches on q change and renders sectioned results on All tab', async () => {
    mocks.universal.mockResolvedValue(RESPONSE);
    render(wrap(<UniversalSearchPanel />, '/?q=butter&type=all'));
    await waitFor(() => expect(mocks.universal).toHaveBeenCalled());
    expect(await screen.findByText('Doc A')).toBeInTheDocument();
    expect(screen.getByText('SO-1')).toBeInTheDocument();
    expect(screen.getByText('Sysco')).toBeInTheDocument();
    // The "Bundles" label still appears as a tab, but no Bundle section
    // heading should render in the All tab body when total is 0.
    const bundleSectionHeading = screen
      .queryAllByText('Bundles')
      .filter((el) => el.tagName === 'H6' || el.closest('.MuiTypography-subtitle1'));
    expect(bundleSectionHeading).toHaveLength(0);
  });

  it('clicking "See all" on a section flips to that tab', async () => {
    mocks.universal.mockResolvedValue(RESPONSE);
    const user = userEvent.setup();
    render(wrap(<UniversalSearchPanel />, '/?q=butter&type=all'));
    await screen.findByText('Doc A');
    await user.click(screen.getAllByRole('button', { name: /see all/i })[0]);
    // After flip, the orders / customers sections should be gone.
    await waitFor(() => {
      expect(screen.queryByText('Sysco')).not.toBeInTheDocument();
    });
  });

  it('hydrates from URL ?q + ?type', async () => {
    mocks.universal.mockResolvedValue(RESPONSE);
    render(wrap(<UniversalSearchPanel />, '/?q=foo&type=orders'));
    expect((screen.getByPlaceholderText(/Search/) as HTMLInputElement).value).toBe('foo');
    await waitFor(() => expect(mocks.universal).toHaveBeenCalled());
    const args = mocks.universal.mock.calls[0][0];
    expect(args.q).toBe('foo');
    // Orders tab should render only orders.
    await screen.findByText('SO-1');
    expect(screen.queryByText('Doc A')).not.toBeInTheDocument();
  });

  it('captures errors', async () => {
    mocks.universal.mockRejectedValue(new Error('500'));
    render(wrap(<UniversalSearchPanel />, '/?q=foo'));
    expect(await screen.findByText('500')).toBeInTheDocument();
  });
});
