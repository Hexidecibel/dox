/**
 * Holds on the document page (migration 0139).
 *
 * The banner says the certificate cannot be sent and why; the lot that is held
 * is named; anybody who may edit is offered "Place hold"; only somebody the
 * server says may release is offered "Release hold"; and both need a reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../lib/api', () => {
  const m = { forDocument: vi.fn(), place: vi.fn(), release: vi.fn(), retryFailure: vi.fn() };
  return { api: { holds: m }, __mocks: m };
});

import * as apiModule from '../lib/api';
import { DocumentHolds } from './DocumentHolds';
import { HOLDS_CHANGED } from '../lib/holds';
import type { ApiDocumentHold, DocumentHoldsResponse } from '../../shared/types';

const mocks = (apiModule as unknown as { __mocks: Record<'forDocument' | 'place' | 'release' | 'retryFailure', ReturnType<typeof vi.fn>> }).__mocks;

function hold(over: Partial<ApiDocumentHold> = {}): ApiDocumentHold {
  return {
    id: 'h1',
    lot_id: 'l1',
    lot_label: '5501 / 03',
    reason: 'Customer complaint under review',
    source: 'person',
    placed_at: '2026-10-08 10:00:00',
    document_id: 'd1',
    document_title: 'Cream COA',
    document_type_name: 'Certificate of Analysis',
    supplier_id: 's1',
    supplier_name: 'Northfield Creamery',
    product_names: [],
    document_version: 1,
    detail: null,
    placed_by: 'u1',
    placed_by_name: 'Dana Reid',
    active: true,
    released_by: null,
    released_by_name: null,
    released_at: null,
    release_reason: null,
    ...over,
  };
}

function response(over: Partial<DocumentHoldsResponse> = {}): DocumentHoldsResponse {
  return {
    active: [],
    history: [],
    also_held_by: [],
    failures: [],
    lots: [
      { lot_id: 'l1', lot_number: '5501', sub_lot_code: '03', lot_label: '5501 / 03', hold: null },
      { lot_id: 'l2', lot_number: '5502', sub_lot_code: null, lot_label: '5502', hold: null },
    ],
    can_place: true,
    can_release: false,
    ...over,
  };
}

const held = (over: Partial<DocumentHoldsResponse> = {}) => {
  const h = hold();
  return response({
    active: [h],
    lots: [
      { lot_id: 'l1', lot_number: '5501', sub_lot_code: '03', lot_label: '5501 / 03', hold: { id: h.id, document_id: 'd1', lot_id: 'l1', lot_label: h.lot_label, reason: h.reason, source: 'person', placed_at: h.placed_at } },
      { lot_id: 'l2', lot_number: '5502', sub_lot_code: null, lot_label: '5502', hold: null },
    ],
    ...over,
  });
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.place.mockResolvedValue({ hold: hold() });
  mocks.release.mockResolvedValue({ hold: hold({ active: false }) });
});

describe('DocumentHolds', () => {
  it('a certificate with no hold says so, and offers Place hold to somebody who may', async () => {
    mocks.forDocument.mockResolvedValue(response());
    render(<DocumentHolds documentId="d1" />);
    expect(await screen.findByTestId('hold-none')).toHaveTextContent('Not on hold.');
    expect(screen.queryByTestId('hold-banner')).toBeNull();
    expect(screen.getByTestId('hold-place')).toBeInTheDocument();
  });

  it('a read-only account with nothing to see is shown nothing at all', async () => {
    mocks.forDocument.mockResolvedValue(response({ can_place: false }));
    const { container } = render(<DocumentHolds documentId="d1" />);
    await waitFor(() => expect(mocks.forDocument).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('the banner says it cannot be sent, names the lot and the reason, and who placed it', async () => {
    mocks.forDocument.mockResolvedValue(held());
    render(<DocumentHolds documentId="d1" />);
    const banner = await screen.findByTestId('hold-banner');
    expect(banner).toHaveTextContent('On hold. This certificate cannot be sent until the hold is released.');
    expect(banner).toHaveTextContent('It can still be opened here.');
    expect(banner).toHaveTextContent('Lot 5501 / 03: Customer complaint under review');
    expect(banner).toHaveTextContent('Placed by a person by Dana Reid');
    expect(screen.getByTestId('hold-lot-chip')).toHaveTextContent('Lot 5501 / 03 on hold');
    // Somebody who cannot release is told who can, and is not offered the button.
    expect(screen.queryByTestId('hold-release')).toBeNull();
    expect(screen.getByTestId('hold-who-releases')).toHaveTextContent('QA or an administrator releases a hold.');
  });

  it('an automatic hold says the portal placed it, and where on the page the result is', async () => {
    mocks.forDocument.mockResolvedValue(
      response({
        active: [
          hold({
            lot_id: null,
            lot_label: null,
            source: 'spec_critical',
            placed_by: null,
            placed_by_name: null,
            reason: 'Critical result out of spec: Coliform 40 CFU/g (limit <=10 CFU/g).',
            detail: { test: 'Coliform', value: '40', unit: 'CFU/g', limit: '<=10 CFU/g', location: 'Table 1, row 3', why: null },
          }),
        ],
      }),
    );
    render(<DocumentHolds documentId="d1" />);
    const banner = await screen.findByTestId('hold-banner');
    expect(banner).toHaveTextContent('Whole certificate: Critical result out of spec: Coliform 40 CFU/g');
    expect(banner).toHaveTextContent('Critical result out of spec on');
    expect(banner).toHaveTextContent('Table 1, row 3');
    expect(screen.getByTestId('hold-whole-chip')).toBeInTheDocument();
  });

  it('placing needs a reason, sends the chosen lot, and tells the page and the rail', async () => {
    mocks.forDocument.mockResolvedValue(response());
    const onChanged = vi.fn();
    const heard = vi.fn();
    window.addEventListener(HOLDS_CHANGED, heard);
    render(<DocumentHolds documentId="d1" onChanged={onChanged} />);
    await userEvent.click(await screen.findByTestId('hold-place'));

    const dialog = screen.getByTestId('hold-reason-dialog');
    expect(dialog).toHaveTextContent('It can still be opened in the portal.');
    // A file covering several lots says what holding one of them does.
    expect(dialog).toHaveTextContent('A hold on one lot stops the whole file');
    expect(screen.getByTestId('hold-confirm')).toBeDisabled();
    await userEvent.type(screen.getByTestId('hold-reason'), '   ');
    expect(screen.getByTestId('hold-confirm')).toBeDisabled();

    await userEvent.click(within(dialog).getByRole('combobox', { name: 'What is on hold' }));
    await userEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Lot 5502' }));
    await userEvent.type(screen.getByTestId('hold-reason'), 'Retest pending');
    await userEvent.click(screen.getByTestId('hold-confirm'));

    await waitFor(() => expect(mocks.place).toHaveBeenCalledWith('d1', { reason: 'Retest pending', lot_id: 'l2' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(heard).toHaveBeenCalled();
    expect(mocks.forDocument).toHaveBeenCalledTimes(2);
    window.removeEventListener(HOLDS_CHANGED, heard);
  });

  it('the whole certificate is the default, and a lot already held cannot be chosen again', async () => {
    mocks.forDocument.mockResolvedValue(held());
    render(<DocumentHolds documentId="d1" />);
    await userEvent.click(await screen.findByTestId('hold-place'));
    const dialog = screen.getByTestId('hold-reason-dialog');
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'What is on hold' }));
    expect(within(screen.getByRole('listbox')).getByRole('option', { name: 'Lot 5501 / 03 (already on hold)' })).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'The whole certificate' }));
    await userEvent.type(screen.getByTestId('hold-reason'), 'Whole file withdrawn');
    await userEvent.click(screen.getByTestId('hold-confirm'));
    await waitFor(() => expect(mocks.place).toHaveBeenCalledWith('d1', { reason: 'Whole file withdrawn', lot_id: null }));
  });

  it("the server's refusal is shown in the dialog, and nothing is announced", async () => {
    mocks.forDocument.mockResolvedValue(response());
    mocks.place.mockRejectedValue(new Error('That lot is already on hold. Release the hold that is there before placing another.'));
    const onChanged = vi.fn();
    render(<DocumentHolds documentId="d1" onChanged={onChanged} />);
    await userEvent.click(await screen.findByTestId('hold-place'));
    await userEvent.type(screen.getByTestId('hold-reason'), 'Again');
    await userEvent.click(screen.getByTestId('hold-confirm'));
    expect(await screen.findByTestId('hold-dialog-error')).toHaveTextContent('already on hold');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('Release is offered only to somebody who may, and needs a reason', async () => {
    mocks.forDocument.mockResolvedValue(held({ can_release: true }));
    const onChanged = vi.fn();
    render(<DocumentHolds documentId="d1" onChanged={onChanged} />);
    await userEvent.click(await screen.findByTestId('hold-release'));
    const dialog = screen.getByTestId('hold-reason-dialog');
    expect(dialog).toHaveTextContent('Release this hold');
    expect(dialog).toHaveTextContent('Lot 5501 / 03: Customer complaint under review');
    expect(screen.getByTestId('hold-confirm')).toBeDisabled();
    await userEvent.type(screen.getByTestId('hold-reason'), 'Complaint closed, lot unaffected');
    await userEvent.click(screen.getByTestId('hold-confirm'));
    await waitFor(() => expect(mocks.release).toHaveBeenCalledWith('h1', 'Complaint closed, lot unaffected'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('a file that prints a held lot of the same certificate says so, and names the certificate the hold is on', async () => {
    mocks.forDocument.mockResolvedValue(
      response({
        can_place: false,
        also_held_by: [{ id: 'h9', document_id: 'd2', document_title: 'Cream COA lot 5503', lot_id: 'l9', lot_label: '5503', reason: 'Critical result out of spec: Coliform 40 CFU/g.', source: 'spec_critical', placed_at: '2026-10-08 10:00:00' }],
      }),
    );
    render(
      <MemoryRouter>
        <DocumentHolds documentId="d1" />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('hold-carried-banner')).toHaveTextContent('a hold placed on another certificate covers it');
    const row = screen.getByTestId('hold-carried-row');
    expect(row).toHaveTextContent('Lot 5503: Critical result out of spec: Coliform 40 CFU/g.');
    // Lot 5503 is not one of this certificate's lots: the file prints it.
    expect(row).toHaveTextContent("This file also prints that lot's results. Held from Cream COA lot 5503");
    expect(within(row).getByRole('link', { name: 'Cream COA lot 5503' })).toHaveAttribute('href', '/documents/d2');
    expect(screen.queryByTestId('hold-none')).toBeNull();
    // Somebody who cannot release is offered no button.
    expect(screen.queryByTestId('hold-carried-release')).toBeNull();
  });

  it('a hold on a LOT this certificate carries, placed from another certificate, is shown and released from here (C-086)', async () => {
    mocks.forDocument.mockResolvedValue(
      response({
        can_release: true,
        also_held_by: [{ id: 'h7', document_id: 'd5', document_title: 'First scan of lot 5501', lot_id: 'l1', lot_label: '5501 / 03', reason: 'Retest pending', source: 'person', placed_at: '2026-10-08 10:00:00' }],
        lots: [
          { lot_id: 'l1', lot_number: '5501', sub_lot_code: '03', lot_label: '5501 / 03', hold: { id: 'h7', document_id: 'd5', document_title: 'First scan of lot 5501', lot_id: 'l1', lot_label: '5501 / 03', reason: 'Retest pending', source: 'person', placed_at: '2026-10-08 10:00:00' } },
        ],
      }),
    );
    const onChanged = vi.fn();
    render(
      <MemoryRouter>
        <DocumentHolds documentId="d1" onChanged={onChanged} />
      </MemoryRouter>,
    );
    const row = await screen.findByTestId('hold-carried-row');
    expect(row).toHaveTextContent('This lot is on hold. Held from First scan of lot 5501');
    expect(screen.getByTestId('hold-lot-chip')).toHaveAttribute('title', 'Held from First scan of lot 5501');
    // Releasing is one act on the hold, from whichever certificate it is seen on.
    await userEvent.click(screen.getByTestId('hold-carried-release'));
    await userEvent.type(screen.getByTestId('hold-reason'), 'Retest clean');
    await userEvent.click(screen.getByTestId('hold-confirm'));
    await waitFor(() => expect(mocks.release).toHaveBeenCalledWith('h7', 'Retest clean'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('a hold that should have been placed and was not says so, says the certificate is NOT held, and retries (C-087)', async () => {
    mocks.forDocument.mockResolvedValue(
      response({
        failures: [{ id: 'f1', document_id: 'd1', document_title: 'Cream COA', document_version: 1, created_at: '2026-10-08 10:00:00', error: 'D1_ERROR', holds: [{ source: 'spec_critical', reason: 'Critical result out of spec: Coliform 40 CFU/g (limit <=10 CFU/g).' }] }],
      }),
    );
    mocks.retryFailure.mockResolvedValue({ placed: 1, already_held: 0 });
    const onChanged = vi.fn();
    render(<DocumentHolds documentId="d1" onChanged={onChanged} />);
    const box = await screen.findByTestId('hold-failure');
    expect(box).toHaveTextContent('A hold should have been placed on this certificate and was not.');
    expect(box).toHaveTextContent('It is NOT on hold and can be sent until somebody retries.');
    expect(box).toHaveTextContent('Critical result out of spec: Coliform 40 CFU/g');
    await userEvent.click(screen.getByTestId('hold-failure-retry'));
    await waitFor(() => expect(mocks.retryFailure).toHaveBeenCalledWith('f1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('a retry that fails again says so and leaves the notice up; a read-only account gets no button', async () => {
    const failing = response({
      failures: [{ id: 'f1', document_id: 'd1', document_title: 'Cream COA', document_version: 1, created_at: '2026-10-08 10:00:00', error: null, holds: [{ source: 'spec_critical', reason: 'Critical result out of spec.' }] }],
    });
    mocks.forDocument.mockResolvedValue(failing);
    mocks.retryFailure.mockRejectedValue(new Error('The hold could not be placed. Nothing changed; try again, or place a hold by hand.'));
    const first = render(<DocumentHolds documentId="d1" />);
    await userEvent.click(await screen.findByTestId('hold-failure-retry'));
    expect(await screen.findByTestId('hold-failure-error')).toHaveTextContent('could not be placed');
    expect(screen.getByTestId('hold-failure')).toBeInTheDocument();
    first.unmount();

    mocks.forDocument.mockResolvedValue({ ...failing, can_place: false });
    render(<DocumentHolds documentId="d1" />);
    expect(await screen.findByTestId('hold-failure')).toBeInTheDocument();
    expect(screen.queryByTestId('hold-failure-retry')).toBeNull();
  });

  it('keeps the history: who released each hold, when and why', async () => {
    mocks.forDocument.mockResolvedValue(
      response({
        can_place: false,
        history: [hold({ id: 'h0', active: false, released_by: 'u2', released_by_name: 'Quinn Lee', released_at: '2026-10-09 09:00:00', release_reason: 'Retest came back clean' })],
      }),
    );
    render(<DocumentHolds documentId="d1" />);
    await userEvent.click(await screen.findByTestId('hold-history-toggle'));
    const row = screen.getByTestId('hold-history-row');
    expect(row).toHaveTextContent('Lot 5501 / 03: Customer complaint under review');
    expect(row).toHaveTextContent('Released by Quinn Lee');
    expect(row).toHaveTextContent('Retest came back clean');
    // Released is not on hold.
    expect(screen.queryByTestId('hold-banner')).toBeNull();
  });
});
