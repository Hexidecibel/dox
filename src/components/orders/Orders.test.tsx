/**
 * The order screens a person builds and sends from (migration 0134).
 *
 * What these pin is what AJ ruled must be VISIBLE before anything goes:
 *   - a production date the portal holds with doubt is never printed plainly;
 *   - the review screen shows the split, the link, the whole-certificate and
 *     the lines that will not be sent, exactly as the server planned them;
 *   - a send that did not all go says which emails failed and resends those.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../lib/api', () => {
  const sendPreview = vi.fn();
  const send = vi.fn();
  const resendFailed = vi.fn();
  const updateItem = vi.fn().mockResolvedValue({ success: true });
  const removeItem = vi.fn().mockResolvedValue({ success: true });
  const create = vi.fn();
  const customersList = vi.fn().mockResolvedValue({ customers: [] });
  return {
    api: {
      orders: { sendPreview, send, resendFailed, updateItem, removeItem, create },
      customers: { list: customersList },
      lotMatches: { resolve: vi.fn() },
    },
    __mocks: { sendPreview, send, resendFailed, updateItem, removeItem, create, customersList },
  };
});

import * as apiModule from '../../lib/api';
import { OrderLines } from './OrderLines';
import { SendOrderDialog } from './SendOrderDialog';
import { OrderSendHistory } from './OrderSendHistory';
import { NewOrderDialog } from './NewOrderDialog';
import { describePickResult } from './AddToOrderDialog';
import type { ApiOrderItem, OrderSendPreview, OrderSendSummary } from '../../../shared/types';

const mocks = (apiModule as unknown as { __mocks: Record<string, ReturnType<typeof vi.fn>> }).__mocks;
const wrap = (ui: React.ReactNode) => <MemoryRouter>{ui}</MemoryRouter>;

function line(over: Partial<ApiOrderItem> = {}): ApiOrderItem {
  return {
    id: 'l1',
    order_id: 'o1',
    product_id: null,
    product_name: 'Heavy Cream 40%',
    product_code: '10286',
    quantity: 4,
    lot_number: '10426203-03',
    lot_matched: 1,
    coa_document_id: 'd1',
    match_confidence: null,
    created_at: '2026-10-06 10:00:00',
    lot_id: 'lot1',
    coa_match_status: 'matched',
    coa_document_title: 'Cream certificate',
    coa_document_status: 'active',
    coa_file_size: 320000,
    coa_original: 'not_split',
    picked_by: 'u1',
    picked_by_name: 'Dana Reid',
    lot_row_number: '10426203',
    sub_lot_code: '03',
    production_date_state: 'stated',
    production_date_label: 'Jul 22, 2026',
    production_date_note: null,
    ...over,
  };
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.updateItem.mockResolvedValue({ success: true });
  mocks.removeItem.mockResolvedValue({ success: true });
  mocks.customersList.mockResolvedValue({ customers: [] });
});

describe('OrderLines', () => {
  const props = { orderId: 'o1', suggestions: [], canEdit: true, compact: false, onChanged: vi.fn(), onOpenDocument: vi.fn() };

  it('shows product, lot, production date, certificate and who picked it', () => {
    render(wrap(<OrderLines {...props} items={[line()]} />));
    const row = screen.getByTestId('order-line');
    expect(within(row).getByText('Heavy Cream 40%')).toBeInTheDocument();
    expect(within(row).getByText('10426203 / 03')).toBeInTheDocument();
    expect(within(row).getByTestId('line-production-date')).toHaveAttribute('data-state', 'stated');
    expect(within(row).getByText('Jul 22, 2026')).toBeInTheDocument();
    expect(within(row).getByText('Cream certificate')).toBeInTheDocument();
    expect(within(row).getByText('Dana Reid')).toBeInTheDocument();
  });

  it('a line whose certificate is on hold says it will not be sent, and why (migration 0139)', () => {
    const first = render(wrap(<OrderLines {...props} items={[line()]} />));
    expect(screen.queryByTestId('order-line-hold')).toBeNull();
    first.unmount();

    render(
      wrap(
        <OrderLines
          {...props}
          items={[
            line({
              coa_hold: { id: 'h1', document_id: 'd1', lot_id: 'lot1', lot_label: '10426203 / 03', reason: 'Retest pending', source: 'person', placed_at: '2026-10-08 10:00:00' },
            }),
          ]}
        />,
      ),
    );
    const chip = screen.getByTestId('order-line-hold');
    expect(chip).toHaveTextContent('On hold: will not be sent');
    expect(chip).toHaveAttribute('title', 'On hold (lot 10426203 / 03): Retest pending. QA or an administrator releases a hold.');
  });

  it('marks a date held with doubt instead of printing it as fact', () => {
    render(
      wrap(
        <OrderLines
          {...props}
          items={[
            line({ id: 'a', production_date_state: 'decoded', production_date_label: 'Jul 31, 2026 (from the lot code)', production_date_note: 'Decoded from the lot code.' }),
            line({ id: 'b', production_date_state: 'ambiguous', production_date_label: '03/04/2026', production_date_note: 'Reads more than one way.' }),
            line({ id: 'c', production_date_state: 'none', production_date_label: null }),
          ]}
        />,
      ),
    );
    const cells = screen.getAllByTestId('line-production-date');
    expect(cells.map((c) => c.getAttribute('data-state'))).toEqual(['decoded', 'ambiguous', 'none']);
    expect(cells[0]).toHaveTextContent('from the lot code');
    // Ambiguous shows what was printed, and never a resolved day.
    expect(cells[1]).toHaveTextContent('03/04/2026');
    expect(cells[2]).toHaveTextContent('Not on file');
  });

  it('says whether the whole certificate is on file for a per-lot page', () => {
    render(
      wrap(
        <OrderLines
          {...props}
          items={[line({ id: 'a', coa_original: 'on_file' }), line({ id: 'b', coa_original: 'missing' }), line({ id: 'c', coa_document_status: 'archived' })]}
        />,
      ),
    );
    expect(screen.getByText('Whole certificate on file')).toBeInTheDocument();
    expect(screen.getByText('Per-lot page only')).toBeInTheDocument();
    expect(screen.getByText(/Document archived: will not be sent/)).toBeInTheDocument();
  });

  it('takes a certificate off a line, and offers nothing to a read-only account', async () => {
    const onChanged = vi.fn();
    const { rerender } = render(wrap(<OrderLines {...props} onChanged={onChanged} items={[line()]} />));
    await userEvent.click(screen.getByTestId('line-remove-certificate'));
    expect(mocks.updateItem).toHaveBeenCalledWith('o1', 'l1', { coa_document_id: null });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());

    rerender(wrap(<OrderLines {...props} canEdit={false} items={[line()]} />));
    expect(screen.queryByTestId('line-remove-certificate')).not.toBeInTheDocument();
    expect(screen.queryByTestId('line-remove')).not.toBeInTheDocument();
  });

  it('a line filled by accepting a suggestion says so rather than naming nobody', () => {
    render(wrap(<OrderLines {...props} items={[line({ picked_by: null, picked_by_name: null })]} />));
    expect(screen.getByText('Accepted match')).toBeInTheDocument();
  });
});

function plan(over: Partial<OrderSendPreview> = {}): OrderSendPreview {
  const file = (key: string, part: number, extra: Record<string, unknown> = {}) => ({
    key,
    file_name: `Darigold-Inc_Certificate-of-Analysis_${key}_1.pdf`,
    bytes: 7 * 1024 * 1024,
    delivery: 'attachment' as const,
    source: 'document' as const,
    part_number: part,
    document_ids: [key],
    document_title: 'Certificate of Analysis - Darigold, Inc.',
    supplier_name: 'Darigold, Inc.',
    document_type_name: 'Certificate of Analysis',
    lot_label: '10426203 / 03',
    lines: [{ order_item_id: `l-${key}`, product_name: 'Heavy Cream 40%', product_code: null, lot_label: '10426203 / 03', production_date_label: 'Jul 22, 2026', production_date_state: 'stated' as const }],
    notes: [],
    ...extra,
  });
  return {
    order: { id: 'o1', order_number: 'SO-77', po_number: 'PO-9', ship_date: '2026-10-12', customer_id: 'c1', customer_name: 'Blue Heron Bakery' },
    recipient: 'qa@blueheron.example',
    recipients: ['qa@blueheron.example'],
    recipient_source: 'customer_email',
    recipients_over_cap: 0,
    item_requirements: [],
    from_name: 'Medosweet Farms via SupDox',
    reply_to: 'dana@medosweet.example',
    default_subject: 'Medosweet Farms: documents for order SO-77 (PO PO-9)',
    email_configured: true,
    files: [
      file('a', 1),
      file('b', 1, { source: 'original', notes: ['One certificate covers 2 lines of this order. It is attached once, whole.'] }),
      file('c', 2, { delivery: 'link', notes: ['At 16 MB this file is too large to attach. It goes as a link in the first email; the link does not expire and can be revoked.'] }),
    ],
    parts: [
      { part_number: 1, subject: 'Medosweet Farms: documents for order SO-77 (PO PO-9) (1 of 2)', bytes: 14 * 1024 * 1024, file_count: 2 },
      { part_number: 2, subject: 'Medosweet Farms: documents for order SO-77 (PO PO-9) (2 of 2)', bytes: 7 * 1024 * 1024, file_count: 1 },
    ],
    part_count: 2,
    total_bytes: 21 * 1024 * 1024,
    lines_not_sent: [{ order_item_id: 'x', product_name: 'Butter', lot_number: '555', reason: 'No document on this line.' }],
    warnings: ['These files do not fit in one email. They will go as 2 emails, numbered "1 of 2" onward.'],
    blocked: null,
    limits: { max_part_bytes: 15 * 1024 * 1024, max_parts: 10 },
    fingerprint: 'fp-123',
    ...over,
  };
}

describe('SendOrderDialog', () => {
  it('shows the split, the whole certificate, the link and what will not be sent -- before sending', async () => {
    mocks.sendPreview.mockResolvedValue(plan());
    render(wrap(<SendOrderDialog open orderId="o1" onClose={vi.fn()} onSent={vi.fn()} onFailed={vi.fn()} />));

    const parts = await screen.findAllByTestId('send-part');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toHaveTextContent('Email 1 of 2');
    expect(parts[1]).toHaveTextContent('Email 2 of 2');
    expect(screen.getAllByTestId('send-file-row')).toHaveLength(3);
    // Each file names the product, lot and production date of its line.
    expect(parts[0]).toHaveTextContent('Heavy Cream 40% · Lot 10426203 / 03 · Produced Jul 22, 2026');
    expect(screen.getByText('Whole certificate')).toBeInTheDocument();
    expect(screen.getByText('Sent as a link')).toBeInTheDocument();
    expect(screen.getByText(/the link does not expire/)).toBeInTheDocument();
    expect(screen.getByTestId('send-lines-not-sent')).toHaveTextContent('Butter · Lot 555 — No document on this line.');
    expect(screen.getByText(/They will go as 2 emails/)).toBeInTheDocument();
    // Who it comes from, where replies go, and that the uploaded name stays in.
    expect(screen.getByText(/Sent as “Medosweet Farms via SupDox”\. Replies go to dana@medosweet\.example/)).toBeInTheDocument();
    expect(screen.getByTestId('send-order-recipients')).toHaveValue('qa@blueheron.example');
    expect(screen.getByTestId('send-order-confirm')).toHaveTextContent('Send 2 emails');
  });

  it('starts with the customer\'s COA contacts and shows what the customer asks for, a missing certificate as a warning only', async () => {
    mocks.sendPreview.mockResolvedValue(
      plan({
        recipients: ['qa@blueheron.example', 'buyer@blueheron.example'],
        recipient_source: 'coa_contacts',
        warnings: ['This customer requires a COA for Butter, and that line has no certificate to send. Nothing stops the send; add the certificate first if it should go with it.'],
        item_requirements: [
          {
            order_item_id: 'l-a', product_id: 'p1', product_name: 'Heavy Cream 40%', lot_label: '10426203 / 03',
            coa_required: 'yes', must_show: 'lot number', timing: 'with the shipment',
            summary: 'COA required - must show lot number - with the shipment',
            delivery_contact: { name: 'Dee', email: 'lab@blueheron.example' }, document_on_line: true, missing: false,
          },
          {
            order_item_id: 'x', product_id: 'p2', product_name: 'Butter', lot_label: '555',
            coa_required: 'yes', must_show: null, timing: null, summary: 'COA required',
            delivery_contact: null, document_on_line: false, missing: true,
          },
        ],
      }),
    );
    render(wrap(<SendOrderDialog open orderId="o1" onClose={vi.fn()} onSent={vi.fn()} onFailed={vi.fn()} />));

    expect(await screen.findByTestId('send-order-recipients')).toHaveValue('qa@blueheron.example, buyer@blueheron.example');
    expect(screen.getByText(/The contacts marked as receiving COAs for Blue Heron Bakery/)).toBeInTheDocument();
    expect(screen.getByTestId('send-requirement')).toHaveTextContent(
      'Heavy Cream 40% · Lot 10426203 / 03 — COA required - must show lot number - with the shipment · to Dee',
    );
    expect(screen.getByTestId('send-requirement-missing')).toHaveTextContent('Butter · Lot 555 — COA required · no certificate on this line');
    expect(screen.getByText(/Nothing stops the send/)).toBeInTheDocument();
    // A warning, never a block: the button is live.
    expect(screen.getByTestId('send-order-confirm')).toBeEnabled();
  });

  it('sends what was reviewed: the edited address, the message and the plan fingerprint', async () => {
    mocks.sendPreview.mockResolvedValue(plan());
    const result = { send: { recipients: ['buyer@blueheron.example'], status: 'sent' }, sent: true, order_status: 'delivered' };
    mocks.send.mockResolvedValue(result);
    const onSent = vi.fn();
    const user = userEvent.setup();
    render(wrap(<SendOrderDialog open orderId="o1" onClose={vi.fn()} onSent={onSent} onFailed={vi.fn()} />));

    const to = await screen.findByTestId('send-order-recipients');
    await user.clear(to);
    await user.type(to, 'buyer@blueheron.example');
    await user.type(screen.getByTestId('send-order-message'), 'For your delivery.');
    await user.click(screen.getByTestId('send-order-confirm'));

    expect(mocks.send).toHaveBeenCalledWith('o1', {
      recipients: ['buyer@blueheron.example'],
      subject: 'Medosweet Farms: documents for order SO-77 (PO PO-9)',
      message: 'For your delivery.',
      fingerprint: 'fp-123',
    });
    await waitFor(() => expect(onSent).toHaveBeenCalledWith(result));
  });

  it('cannot send a blocked order, with no address, or with email unconfigured', async () => {
    mocks.sendPreview.mockResolvedValue(
      plan({ blocked: { code: 'too_many_parts', message: 'These files need 11 emails, and one send is split into at most 10.' } }),
    );
    const { unmount } = render(wrap(<SendOrderDialog open orderId="o1" onClose={vi.fn()} onSent={vi.fn()} onFailed={vi.fn()} />));
    expect(await screen.findByTestId('send-blocked')).toHaveTextContent('11 emails');
    expect(screen.getByTestId('send-order-confirm')).toBeDisabled();
    unmount();

    mocks.sendPreview.mockResolvedValue(plan({ recipient: null, recipients: [], recipient_source: 'none' }));
    const second = render(wrap(<SendOrderDialog open orderId="o1" onClose={vi.fn()} onSent={vi.fn()} onFailed={vi.fn()} />));
    expect(await screen.findByText(/No address is on file for this customer/)).toBeInTheDocument();
    expect(screen.getByTestId('send-order-confirm')).toBeDisabled();
    second.unmount();

    mocks.sendPreview.mockResolvedValue(plan({ email_configured: false }));
    render(wrap(<SendOrderDialog open orderId="o1" onClose={vi.fn()} onSent={vi.fn()} onFailed={vi.fn()} />));
    expect(await screen.findByText(/Email is not configured/)).toBeInTheDocument();
    expect(screen.getByTestId('send-order-confirm')).toBeDisabled();
  });

  it('a refused send shows why and reloads the plan as it now stands', async () => {
    mocks.sendPreview.mockResolvedValue(plan());
    mocks.send.mockRejectedValue(new Error('This order changed after you reviewed it, so nothing was sent.'));
    const onFailed = vi.fn();
    render(wrap(<SendOrderDialog open orderId="o1" onClose={vi.fn()} onSent={vi.fn()} onFailed={onFailed} />));
    await userEvent.click(await screen.findByTestId('send-order-confirm'));
    expect(await screen.findByText(/changed after you reviewed it/)).toBeInTheDocument();
    expect(mocks.sendPreview).toHaveBeenCalledTimes(2);
    expect(onFailed).toHaveBeenCalled();
  });
});

function sendRecord(over: Partial<OrderSendSummary> = {}): OrderSendSummary {
  return {
    id: 's1',
    order_id: 'o1',
    order_number: 'SO-77',
    customer_name: 'Blue Heron Bakery',
    status: 'partial',
    created_at: '2026-10-06 12:00:00',
    sent_by_id: 'u1',
    sent_by_name: 'Dana Reid',
    sent_by_email: 'dana@medosweet.example',
    recipients: ['qa@blueheron.example'],
    subject: 'Documents for order SO-77',
    message: null,
    part_count: 2,
    parts: [
      { part_number: 1, ok: true, status: 200, error: null, sent_at: '2026-10-06T12:00:01Z', attempts: 1 },
      { part_number: 2, ok: false, status: 500, error: 'provider said no', sent_at: null, attempts: 1 },
    ],
    files: [
      { position: 0, file_name: 'A_1.pdf', bytes: 1000, part_number: 1, delivery: 'attachment', source: 'original', document_id: 'd1', document_ids: ['d1', 'd2'], document_title: 'COA', lot_label: '1 / 01', sent_ok: true },
      { position: 1, file_name: 'B_2.pdf', bytes: 1000, part_number: 2, delivery: 'attachment', source: 'document', document_id: 'd3', document_ids: ['d3'], document_title: 'COA', lot_label: null, sent_ok: false },
    ],
    can_resend: true,
    ...over,
  };
}

describe('OrderSendHistory', () => {
  it('says what left, to whom and how, and which email did not go', () => {
    render(wrap(<OrderSendHistory sends={[sendRecord()]} />));
    const card = screen.getByTestId('order-send-card');
    expect(card).toHaveTextContent('Partly sent');
    expect(card).toHaveTextContent('To qa@blueheron.example');
    expect(card).toHaveTextContent('by Dana Reid');
    expect(card).toHaveTextContent('A_1.pdf');
    expect(card).toHaveTextContent('attached · the whole certificate');
    expect(card).toHaveTextContent('1 of 2 emails did not go');
    expect(card).toHaveTextContent('Email 2: provider said no');
    // An attachment cannot be recalled, and the screen says so.
    expect(screen.getByText(/Attachments cannot be recalled/)).toBeInTheDocument();
  });

  it('resends only through the resend endpoint, and only for someone who may', async () => {
    mocks.resendFailed.mockResolvedValue({});
    const onChanged = vi.fn();
    const { rerender } = render(wrap(<OrderSendHistory sends={[sendRecord()]} onChanged={onChanged} />));
    await userEvent.click(screen.getByTestId('order-send-resend'));
    expect(mocks.resendFailed).toHaveBeenCalledWith('o1', 's1');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());

    rerender(wrap(<OrderSendHistory sends={[sendRecord({ can_resend: false })]} />));
    expect(screen.queryByTestId('order-send-resend')).not.toBeInTheDocument();

    rerender(wrap(<OrderSendHistory sends={[sendRecord({ status: 'sent', parts: [{ part_number: 1, ok: true, status: 200, error: null, sent_at: 'x', attempts: 1 }], part_count: 1 })]} />));
    expect(screen.queryByTestId('order-send-resend')).not.toBeInTheDocument();
  });

  it('names the order on the Sent documents page, and a link file says it does not expire', () => {
    const s = sendRecord({ status: 'sent' });
    s.files[1] = { ...s.files[1], delivery: 'link', sent_ok: true };
    s.parts[1] = { ...s.parts[1], ok: true, error: null };
    render(wrap(<OrderSendHistory sends={[s]} showOrder />));
    expect(screen.getByRole('link', { name: 'SO-77' })).toHaveAttribute('href', '/orders/o1');
    expect(screen.getByTestId('order-send-card')).toHaveTextContent('sent as a link that does not expire');
  });

  it('renders nothing when nothing was sent', () => {
    const { container } = render(wrap(<OrderSendHistory sends={[]} />));
    expect(container).toBeEmptyDOMElement();
  });
});

describe('NewOrderDialog', () => {
  it('creates the order with the typed customer name, PO and ship date', async () => {
    mocks.create.mockResolvedValue({ order: { id: 'o9', order_number: 'SO-9', customer_name: 'Walk-in Foods' } });
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(wrap(<NewOrderDialog open tenantId="t1" onClose={vi.fn()} onCreated={onCreated} />));

    expect(screen.getByTestId('new-order-create')).toBeDisabled();
    await user.type(screen.getByTestId('new-order-customer'), 'Walk-in Foods');
    await user.type(screen.getByTestId('new-order-number'), 'SO-9');
    await user.type(screen.getByTestId('new-order-po'), 'PO-44');
    await user.type(screen.getByTestId('new-order-ship-date'), '2026-10-12');
    await user.click(screen.getByTestId('new-order-create'));

    expect(mocks.create).toHaveBeenCalledWith({
      order_number: 'SO-9',
      po_number: 'PO-44',
      customer_id: undefined,
      customer_name: 'Walk-in Foods',
      ship_date: '2026-10-12',
      tenant_id: 't1',
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'o9', order_number: 'SO-9', customer_name: 'Walk-in Foods' }));
  });

  it('shows a refusal (an order number already in use) and stays open', async () => {
    mocks.create.mockRejectedValue(new Error('Order SO-9 already exists. Open it, or use a different order number.'));
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(wrap(<NewOrderDialog open onClose={vi.fn()} onCreated={onCreated} />));
    await user.type(screen.getByTestId('new-order-number'), 'SO-9');
    await user.click(screen.getByTestId('new-order-create'));
    expect(await screen.findByText(/already exists/)).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
  });
});

describe('describePickResult', () => {
  it('counts what was added, what was already there and what was refused', () => {
    expect(
      describePickResult('SO-1', {
        results: [
          { document_id: 'a', order_item_id: '1', outcome: 'added', lot_id: null, lot_number: null },
          { document_id: 'a', order_item_id: '2', outcome: 'filled', lot_id: null, lot_number: null },
          { document_id: 'b', order_item_id: '3', outcome: 'already_on_order', lot_id: null, lot_number: null },
        ],
        refused: [{ document_id: 'c', reason: 'This document is archived.' }],
      }),
    ).toBe('2 lines added to order SO-1; 1 already on it; 1 document was not added (This document is archived.).');
  });
});
