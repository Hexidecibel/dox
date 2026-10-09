/**
 * The Holds page (migration 0139): what is on hold, why, and the release.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../contexts/TenantContext', () => ({
  useTenant: () => ({ selectedTenantId: null }),
}));
vi.mock('../lib/api', () => {
  const m = { list: vi.fn(), release: vi.fn(), retryFailure: vi.fn() };
  return { api: { holds: m }, __mocks: m };
});

import * as apiModule from '../lib/api';
import { Holds } from './Holds';
import { HOLDS_CHANGED } from '../lib/holds';
import type { ApiDocumentHold, HoldsListResponse } from '../../shared/types';

const mocks = (apiModule as unknown as { __mocks: Record<'list' | 'release' | 'retryFailure', ReturnType<typeof vi.fn>> }).__mocks;

function hold(over: Partial<ApiDocumentHold> = {}): ApiDocumentHold {
  return {
    id: 'h1',
    lot_id: 'l1',
    lot_label: '5501',
    reason: 'Critical result out of spec: Coliform 40 CFU/g (limit <=10 CFU/g).',
    source: 'spec_critical',
    placed_at: '2026-10-08 10:00:00',
    document_id: 'd1',
    document_title: 'Cream COA lot 5501',
    document_type_name: 'Certificate of Analysis',
    supplier_id: 's1',
    supplier_name: 'Northfield Creamery',
    product_names: ['Heavy Cream'],
    document_version: 1,
    detail: { test: 'Coliform', value: '40', unit: 'CFU/g', limit: '<=10 CFU/g', location: 'Table 1, row 3', why: null },
    placed_by: null,
    placed_by_name: null,
    active: true,
    released_by: null,
    released_by_name: null,
    released_at: null,
    release_reason: null,
    ...over,
  };
}

const list = (over: Partial<HoldsListResponse> = {}): HoldsListResponse => ({
  holds: [hold(), hold({ id: 'h2', document_id: 'd2', document_title: 'Butter COA', lot_id: null, lot_label: null, source: 'person', reason: 'Customer complaint under review', placed_by: 'u1', placed_by_name: 'Dana Reid', detail: null })],
  total: 2,
  truncated: false,
  can_release: true,
  failures: [],
  can_place: true,
  ...over,
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <Holds />
    </MemoryRouter>,
  );

beforeEach(() => {
  mocks.list.mockReset();
  mocks.release.mockReset();
  mocks.retryFailure.mockReset();
  mocks.list.mockResolvedValue(list());
  mocks.release.mockResolvedValue({ hold: hold({ active: false }) });
  window.localStorage.clear();
});

describe('Holds page', () => {
  it('lists what is on hold: the certificate, the lot, where the hold came from, and why', async () => {
    renderPage();
    const rows = await screen.findAllByTestId('hold-row');
    expect(rows).toHaveLength(2);
    expect(screen.getByTestId('holds-count')).toHaveTextContent('(2)');
    expect(mocks.list).toHaveBeenCalledWith({ tenant_id: undefined, state: 'active', source: undefined });

    expect(rows[0]).toHaveTextContent('Cream COA lot 5501');
    expect(rows[0]).toHaveTextContent('Lot 5501');
    expect(rows[0]).toHaveTextContent('Critical result out of spec');
    expect(rows[0]).toHaveTextContent('Northfield Creamery · Certificate of Analysis · Heavy Cream');
    expect(rows[0]).toHaveTextContent('Placed by the portal at approval');
    expect(rows[0]).toHaveTextContent('Table 1, row 3');
    expect(within(rows[0]).getByRole('link', { name: 'Cream COA lot 5501' })).toHaveAttribute('href', '/documents/d1');

    expect(rows[1]).toHaveTextContent('Whole certificate');
    expect(rows[1]).toHaveTextContent('Placed by Dana Reid');
    expect(within(rows[1]).getByTestId('hold-row-reason')).toHaveTextContent('Customer complaint under review');
  });

  it('says what a hold does, in plain words', async () => {
    renderPage();
    await screen.findAllByTestId('hold-row');
    expect(screen.getByText(/cannot be sent on an order, in a ZIP, by link, in a bundle or read with an API key/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing here reaches a warehouse system/)).toBeInTheDocument();
  });

  it('releasing needs a reason, reloads the list and tells the rail', async () => {
    const heard = vi.fn();
    window.addEventListener(HOLDS_CHANGED, heard);
    renderPage();
    const rows = await screen.findAllByTestId('hold-row');
    await userEvent.click(within(rows[0]).getByTestId('hold-row-release-button'));
    const dialog = screen.getByTestId('hold-reason-dialog');
    expect(dialog).toHaveTextContent('Cream COA lot 5501, lot 5501');
    expect(screen.getByTestId('hold-confirm')).toBeDisabled();
    await userEvent.type(screen.getByTestId('hold-reason'), 'Retest came back at 4 CFU/g');
    await userEvent.click(screen.getByTestId('hold-confirm'));

    await waitFor(() => expect(mocks.release).toHaveBeenCalledWith('h1', 'Retest came back at 4 CFU/g'));
    expect(await screen.findByTestId('holds-notice')).toHaveTextContent('Released the hold on Cream COA lot 5501. It can be sent again.');
    expect(heard).toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    window.removeEventListener(HOLDS_CHANGED, heard);
  });

  it("a refused release stays in the dialog with the server's words", async () => {
    mocks.release.mockRejectedValue(new Error('This hold has already been released.'));
    renderPage();
    const rows = await screen.findAllByTestId('hold-row');
    await userEvent.click(within(rows[0]).getByTestId('hold-row-release-button'));
    await userEvent.type(screen.getByTestId('hold-reason'), 'Clean');
    await userEvent.click(screen.getByTestId('hold-confirm'));
    expect(await screen.findByTestId('hold-dialog-error')).toHaveTextContent('already been released');
    expect(screen.queryByTestId('holds-notice')).toBeNull();
  });

  it('somebody who cannot release sees the list and no button, and is told who can', async () => {
    mocks.list.mockResolvedValue(list({ can_release: false }));
    renderPage();
    await screen.findAllByTestId('hold-row');
    expect(screen.queryByTestId('hold-row-release-button')).toBeNull();
    expect(screen.getByTestId('holds-who-releases')).toHaveTextContent('QA or an administrator releases a hold.');
  });

  it('the filters ask the server: released holds show who released them and why', async () => {
    renderPage();
    await screen.findAllByTestId('hold-row');
    mocks.list.mockResolvedValue(
      list({
        holds: [hold({ active: false, released_by: 'u2', released_by_name: 'Quinn Lee', released_at: '2026-10-09 09:00:00', release_reason: 'Retest clean' })],
        total: 1,
      }),
    );
    await userEvent.click(screen.getByTestId('holds-state-released'));
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith({ tenant_id: undefined, state: 'released', source: undefined }));
    const row = await screen.findByTestId('hold-row');
    expect(within(row).getByTestId('hold-row-release')).toHaveTextContent('Released by Quinn Lee');
    expect(within(row).getByTestId('hold-row-release')).toHaveTextContent('Retest clean');
    expect(screen.queryByTestId('hold-row-release-button')).toBeNull();

    await userEvent.click(screen.getByRole('combobox', { name: 'Placed by' }));
    await userEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Zero-tolerance sample too small' }));
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith({ tenant_id: undefined, state: 'released', source: 'zero_tolerance' }));
  });

  it('a hold that should have been placed and was not is on top, with a retry (C-087)', async () => {
    mocks.list.mockResolvedValue(
      list({
        failures: [{ id: 'f1', document_id: 'd7', document_title: 'Butter COA lot 88', document_version: 1, created_at: '2026-10-08 10:00:00', error: 'D1_ERROR', holds: [{ source: 'spec_critical', reason: 'Critical result out of spec: Coliform 40 CFU/g.' }] }],
      }),
    );
    mocks.retryFailure.mockResolvedValue({ placed: 1, already_held: 0, released: [], message: 'Butter COA lot 88 is now on hold.' });
    const heard = vi.fn();
    window.addEventListener(HOLDS_CHANGED, heard);
    renderPage();
    const box = await screen.findByTestId('holds-failures');
    expect(box).toHaveTextContent('A hold should have been placed and was not.');
    expect(box).toHaveTextContent('It is NOT on hold and can be sent until somebody retries.');
    const row = within(box).getByTestId('holds-failure-row');
    expect(within(row).getByRole('link', { name: 'Butter COA lot 88' })).toHaveAttribute('href', '/documents/d7');
    expect(row).toHaveTextContent('Critical result out of spec: Coliform 40 CFU/g.');
    await userEvent.click(within(row).getByTestId('holds-failure-retry'));
    await waitFor(() => expect(mocks.retryFailure).toHaveBeenCalledWith('f1'));
    expect(await screen.findByTestId('holds-notice')).toHaveTextContent('Butter COA lot 88 is now on hold.');
    expect(heard).toHaveBeenCalled();
    window.removeEventListener(HOLDS_CHANGED, heard);
  });

  it('a retry of a hold that was placed and since RELEASED says so, and does not claim the certificate is on hold (C-092)', async () => {
    mocks.list.mockResolvedValue(
      list({ failures: [{ id: 'f1', document_id: 'd7', document_title: 'Butter COA lot 88', document_version: 1, created_at: '', error: null, holds: [{ source: 'spec_critical', reason: 'Critical result out of spec.' }] }] }),
    );
    const message = 'This hold was placed and later released by Quinn Lee on 2026-10-07; nothing was placed. Butter COA lot 88 is not on hold for that result.';
    mocks.retryFailure.mockResolvedValue({ placed: 0, already_held: 0, released: [{ reason: 'x', released_by_name: 'Quinn Lee', released_at: '2026-10-07 09:30:00' }], message });
    renderPage();
    await userEvent.click(await screen.findByTestId('holds-failure-retry'));
    const notice = await screen.findByTestId('holds-notice');
    expect(notice).toHaveTextContent(message);
    expect(notice).not.toHaveTextContent('is now on hold');
  });

  it('says what a lot hold covers and what it does not', async () => {
    renderPage();
    await screen.findAllByTestId('hold-row');
    expect(screen.getByText(/covers every certificate of that lot from the same supplier, whatever product name each/)).toBeInTheDocument();
    expect(screen.getByText(/does not cover another supplier's lot with the same number, or a different sublot/)).toBeInTheDocument();
  });

  it('with no failures there is no such notice, and a read-only account gets no retry', async () => {
    const first = renderPage();
    await screen.findAllByTestId('hold-row');
    expect(screen.queryByTestId('holds-failures')).toBeNull();
    first.unmount();
    mocks.list.mockResolvedValue(
      list({ can_place: false, failures: [{ id: 'f1', document_id: 'd7', document_title: 'Butter COA', document_version: 1, created_at: '', error: null, holds: [] }] }),
    );
    renderPage();
    expect(await screen.findByTestId('holds-failures')).toBeInTheDocument();
    expect(screen.queryByTestId('holds-failure-retry')).toBeNull();
  });

  it('nothing on hold is said plainly, and a cut-off list says so', async () => {
    mocks.list.mockResolvedValue(list({ holds: [], total: 0 }));
    const first = renderPage();
    expect(await screen.findByText('Nothing is on hold')).toBeInTheDocument();
    first.unmount();

    mocks.list.mockResolvedValue(list({ total: 412, truncated: true }));
    renderPage();
    expect(await screen.findByTestId('holds-truncated')).toHaveTextContent('Showing the first 2 of 412');
  });
});
