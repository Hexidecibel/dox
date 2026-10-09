/**
 * The document order screens (migration 0138).
 *
 * What these pin is what a person must be able to SEE and what they must not
 * be offered:
 *   - a document line shows the item, supplier, plant, type, the document, its
 *     rule as it stands now and what a send would do, in the server's words;
 *   - the private-label advisory is on the line and on the send review;
 *   - the add dialog lists one row per item AND supplier, previews what
 *     resolves before adding, and names what was refused;
 *   - the send review shows the three groups: goes now, waits for QA, will
 *     not go;
 *   - a read-only account builds and is not offered Send;
 *   - Release and Refuse are offered only to a person who may, and a refusal
 *     needs a note.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

let reader = false;

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', role: reader ? 'reader' : 'user', tenant_id: 't1' },
    isAdmin: false,
    isSuperAdmin: false,
    isReader: reader,
  }),
}));
vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ selectedTenantId: null }),
}));
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig<typeof import('react-router-dom')>();
  return { ...actual, useParams: () => ({ id: 'o1' }) };
});

vi.mock('../../lib/api', () => {
  const m = {
    get: vi.fn(),
    sendPreview: vi.fn(),
    send: vi.fn(),
    resendFailed: vi.fn(),
    addDocuments: vi.fn(),
    removeDocument: vi.fn(),
    refreshDocument: vi.fn(),
    releaseDocuments: vi.fn(),
    refuseDocument: vi.fn(),
    giveBackDocument: vi.fn(),
    approvedList: vi.fn(),
    typesList: vi.fn(),
    pending: vi.fn(),
  };
  return {
    api: {
      orders: {
        get: m.get,
        sendPreview: m.sendPreview,
        send: m.send,
        resendFailed: m.resendFailed,
        addDocuments: m.addDocuments,
        removeDocument: m.removeDocument,
        refreshDocument: m.refreshDocument,
        releaseDocuments: m.releaseDocuments,
        refuseDocument: m.refuseDocument,
        giveBackDocument: m.giveBackDocument,
        addItems: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        updateItem: vi.fn(),
        removeItem: vi.fn(),
      },
      approvedItems: { list: m.approvedList },
      documentTypes: { list: m.typesList },
      orderDocuments: { pending: m.pending },
      lotMatches: { resolve: vi.fn() },
      customers: { list: vi.fn().mockResolvedValue({ customers: [] }) },
    },
    __mocks: m,
  };
});

import * as apiModule from '../../lib/api';
import { OrderDocumentLines } from './OrderDocumentLines';
import { AddOrderDocumentsDialog } from './AddOrderDocumentsDialog';
import { SendOrderDialog } from './SendOrderDialog';
import { OrderSendHistory } from './OrderSendHistory';
import { OrderDetail } from '../../pages/OrderDetail';
import { OrdersWaitingForQa } from '../../pages/OrdersWaitingForQa';
import type {
  ApiOrderDocument,
  ApprovedItem,
  OrderDocumentProposal,
  OrderSendDocumentLine,
  OrderSendPreview,
  OrderSendSummary,
  PendingOrderDocument,
} from '../../../shared/types';

const mocks = (apiModule as unknown as { __mocks: Record<string, ReturnType<typeof vi.fn>> }).__mocks;
const wrap = (ui: React.ReactNode) => <MemoryRouter>{ui}</MemoryRouter>;

const ADVISORY = "This document is the producer's own and names Northfield Creamery. The item is sold under Harbor Pantry, so the customer will see who makes it.";

function docLine(over: Partial<ApiOrderDocument> = {}): ApiOrderDocument {
  return {
    id: 'dl1',
    order_id: 'o1',
    product_id: 'p1',
    product_name: 'Cream Cheese 3 lb',
    supplier_id: 's1',
    supplier_name: 'Northfield Creamery',
    facility: { id: 'f1', name: 'Plant 2', plant_code: '55-1234' },
    document_type_id: 't-spec',
    document_type_name: 'Spec Sheet',
    document_id: 'd1',
    document_title: 'Cream cheese specification',
    document_status: 'active',
    version_number: 1,
    resolution: 'found',
    resolution_note: null,
    document_due_date: null,
    resolved_at: '2026-10-08 10:00:00',
    rule_at_resolve: 'free',
    sharing_rule: 'free',
    hold: null,
    release_status: 'none',
    pending_send_id: null,
    pending_at: null,
    pending_requested_by_name: null,
    pending_recipients: [],
    document_approved_at: '2026-06-01 09:00:00',
    release_stuck: false,
    decided_by_name: null,
    decided_at: null,
    decision_note: null,
    qa_notified_at: null,
    last_sent_at: null,
    added_by: 'u1',
    added_by_name: 'Dana Reid',
    created_at: '2026-10-08 10:00:00',
    private_label: false,
    advisory: null,
    stale: false,
    stale_note: null,
    disposition: 'goes_now',
    disposition_reason: null,
    disposition_text: 'Goes now, on a link that works for 30 days.',
    delivery: 'link',
    ...over,
  };
}

beforeEach(() => {
  reader = false;
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.removeDocument.mockResolvedValue({ success: true });
  mocks.refreshDocument.mockResolvedValue({ changed: true, document: null });
  mocks.refuseDocument.mockResolvedValue({ success: true });
  mocks.giveBackDocument.mockResolvedValue({ success: true });
  mocks.releaseDocuments.mockResolvedValue({ released: ['dl1'], refused: [], sends: [], order_status: 'pending' });
  mocks.typesList.mockResolvedValue({ documentTypes: [] });
  mocks.approvedList.mockResolvedValue({ items: [], total: 0, counts: { approved: 0, pending: 0, not_approved: 0 }, limit: 100, offset: 0 });
});

// ---------------------------------------------------------------------------
// The Documents section
// ---------------------------------------------------------------------------

describe('OrderDocumentLines', () => {
  const props = { orderId: 'o1', canBuild: true, canRelease: false, onChanged: vi.fn(), onOpenDocument: vi.fn() };

  it('shows the item, supplier and plant, type, document, rule and what a send would do', () => {
    render(wrap(<OrderDocumentLines {...props} documents={[docLine()]} />));
    const row = screen.getByTestId('order-document-line');
    expect(within(row).getByText('Cream Cheese 3 lb')).toBeInTheDocument();
    expect(within(row).getByText('Northfield Creamery')).toBeInTheDocument();
    expect(within(row).getByText('Plant 2 (55-1234)')).toBeInTheDocument();
    expect(within(row).getByText('Spec Sheet')).toBeInTheDocument();
    expect(within(row).getByText('Cream cheese specification')).toBeInTheDocument();
    expect(within(row).getByTestId('order-document-rule')).toHaveTextContent('Send freely');
    expect(within(row).getByTestId('order-document-status')).toHaveTextContent('Goes now');
    expect(within(row).getByText('Goes now, on a link that works for 30 days.')).toBeInTheDocument();
    expect(row).toHaveAttribute('data-disposition', 'goes_now');
  });

  it('says each state in a word: waiting, missing, expired, locked, refused, released, refresh needed', () => {
    render(
      wrap(
        <OrderDocumentLines
          {...props}
          documents={[
            docLine({ id: 'a', sharing_rule: 'qa', release_status: 'pending_qa', disposition: 'waits_for_qa' }),
            docLine({ id: 'b', document_id: null, document_title: null, sharing_rule: null, resolution: 'missing', disposition: 'will_not_go', disposition_reason: 'missing' }),
            docLine({ id: 'c', resolution: 'expired', document_due_date: '2026-03-01', disposition: 'will_not_go', disposition_reason: 'expired' }),
            docLine({ id: 'd', sharing_rule: 'locked', disposition: 'will_not_go', disposition_reason: 'locked' }),
            docLine({ id: 'e', sharing_rule: 'qa', release_status: 'refused', disposition: 'will_not_go', disposition_reason: 'refused', disposition_text: 'QA refused this document for this order: Wrong revision.' }),
            docLine({ id: 'f', sharing_rule: 'qa', release_status: 'released', decided_by_name: 'Quinn Lee', disposition: 'will_not_go', disposition_reason: 'already_released' }),
            docLine({ id: 'g', document_id: null, sharing_rule: null, stale: true, stale_note: 'A document is on file now. Refresh this line to use it.', disposition: 'will_not_go', disposition_reason: 'stale' }),
          ]}
        />,
      ),
    );
    expect(screen.getAllByTestId('order-document-status').map((c) => c.textContent)).toEqual([
      'Waiting for QA',
      'Missing',
      'Expired',
      'Locked',
      'Refused by QA',
      'Released by QA',
      'Refresh needed',
    ]);
    expect(screen.getAllByText('Nothing on file')).toHaveLength(2);
    expect(screen.getByText('Expired Mar 1, 2026')).toBeInTheDocument();
    expect(screen.getByText(/Wrong revision\./)).toBeInTheDocument();
    expect(screen.getByText('Released by Quinn Lee')).toBeInTheDocument();
    expect(screen.getByTestId('order-document-stale')).toHaveTextContent('Refresh this line to use it');
  });

  it('a line whose document is on hold says so, with the reason (migration 0139)', () => {
    render(
      wrap(
        <OrderDocumentLines
          {...props}
          documents={[
            docLine({
              id: 'h',
              disposition: 'will_not_go',
              disposition_reason: 'held',
              disposition_text: 'On hold: Supplier withdrew this statement. It can go once QA or an administrator releases the hold.',
              hold: { id: 'h1', document_id: 'd1', lot_id: null, lot_label: null, reason: 'Supplier withdrew this statement', source: 'person', placed_at: '2026-10-08 10:00:00' },
            }),
          ]}
        />,
      ),
    );
    expect(screen.getByTestId('order-document-status')).toHaveTextContent('On hold');
    expect(screen.getByTestId('order-document-line')).toHaveTextContent('On hold: Supplier withdrew this statement.');
  });

  it('carries the private-label advisory on the line', () => {
    render(wrap(<OrderDocumentLines {...props} documents={[docLine({ private_label: true, advisory: ADVISORY })]} />));
    expect(screen.getByTestId('order-document-advisory')).toHaveTextContent('names Northfield Creamery');
  });

  it('removes and refreshes through the API, and offers neither when the order cannot be built on', async () => {
    const onChanged = vi.fn();
    const { rerender } = render(wrap(<OrderDocumentLines {...props} onChanged={onChanged} documents={[docLine()]} />));
    await userEvent.click(screen.getByTestId('order-document-refresh'));
    expect(mocks.refreshDocument).toHaveBeenCalledWith('o1', 'dl1');
    await userEvent.click(screen.getByTestId('order-document-remove'));
    expect(mocks.removeDocument).toHaveBeenCalledWith('o1', 'dl1');
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));

    rerender(wrap(<OrderDocumentLines {...props} canBuild={false} documents={[docLine()]} />));
    expect(screen.queryByTestId('order-document-refresh')).not.toBeInTheDocument();
    expect(screen.queryByTestId('order-document-remove')).not.toBeInTheDocument();
  });

  const WAITING = {
    sharing_rule: 'qa' as const,
    release_status: 'pending_qa' as const,
    disposition: 'waits_for_qa' as const,
    pending_send_id: 'send-1',
    pending_at: '2026-10-08 11:00:00',
    pending_requested_by_name: 'Dana Reid',
    pending_recipients: ['buyer@harborbakery.example'],
  };

  it('offers Release and Refuse only to a person who may, and only on a waiting line', async () => {
    const waiting = docLine(WAITING);
    const { rerender } = render(wrap(<OrderDocumentLines {...props} documents={[waiting]} />));
    expect(screen.queryByTestId('order-document-release')).not.toBeInTheDocument();
    expect(screen.queryByTestId('order-document-refuse')).not.toBeInTheDocument();

    rerender(wrap(<OrderDocumentLines {...props} canRelease documents={[docLine()]} />));
    expect(screen.queryByTestId('order-document-release')).not.toBeInTheDocument();

    rerender(wrap(<OrderDocumentLines {...props} canRelease documents={[waiting]} />));
    await userEvent.click(screen.getByTestId('order-document-release'));
    // Nothing is released by the first click: QA is shown exactly what it is.
    expect(mocks.releaseDocuments).not.toHaveBeenCalled();
    const candidate = await screen.findByTestId('release-candidate');
    expect(candidate).toHaveTextContent('Cream cheese specification');
    expect(candidate).toHaveTextContent('Spec Sheet · version 1 · approved');
    expect(candidate).toHaveTextContent('For Cream Cheese 3 lb · Northfield Creamery');
    expect(candidate).toHaveTextContent('Asked by Dana Reid');
    expect(within(candidate).getByTestId('release-candidate-recipients')).toHaveTextContent('Goes to buyer@harborbakery.example');

    await userEvent.click(screen.getByTestId('release-confirm'));
    // The release carries what was on the screen, not just the line id.
    expect(mocks.releaseDocuments).toHaveBeenCalledWith('o1', [
      { id: 'dl1', document_id: 'd1', version_number: 1, pending_send_id: 'send-1' },
    ]);
  });

  it('a release that did not finish is never worded as sent, and can be released again or put back', async () => {
    const stuck = docLine({ ...WAITING, release_status: 'releasing', release_stuck: true, disposition_text: 'A release of this document did not finish.' });
    const { rerender } = render(wrap(<OrderDocumentLines {...props} canRelease documents={[stuck]} />));
    expect(screen.getByTestId('order-document-status')).toHaveTextContent('Release did not finish');
    expect(screen.getByTestId('order-document-status')).not.toHaveTextContent('Sent');
    expect(screen.getByTestId('order-document-release')).toHaveTextContent('Release again');
    expect(screen.queryByTestId('order-document-refuse')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('order-document-give-back'));
    expect(mocks.giveBackDocument).toHaveBeenCalledWith('o1', 'dl1');

    // One in progress offers nothing.
    rerender(wrap(<OrderDocumentLines {...props} canRelease documents={[docLine({ ...WAITING, release_status: 'releasing', release_stuck: false })]} />));
    expect(screen.getByTestId('order-document-status')).toHaveTextContent('Being released');
    expect(screen.queryByTestId('order-document-release')).not.toBeInTheDocument();
    expect(screen.queryByTestId('order-document-give-back')).not.toBeInTheDocument();
  });

  it('nobody is offered remove or refresh on a line in the middle of a release, and a reader not on a refused one', () => {
    const { rerender } = render(
      wrap(<OrderDocumentLines {...props} canRelease documents={[docLine({ ...WAITING, release_status: 'releasing', release_stuck: true })]} />),
    );
    expect(screen.queryByTestId('order-document-remove')).not.toBeInTheDocument();
    expect(screen.queryByTestId('order-document-refresh')).not.toBeInTheDocument();

    const refused = docLine({ ...WAITING, release_status: 'refused', disposition: 'will_not_go', disposition_reason: 'refused' });
    rerender(wrap(<OrderDocumentLines {...props} readOnly documents={[refused]} />));
    expect(screen.queryByTestId('order-document-remove')).not.toBeInTheDocument();
    // Somebody who may send still can.
    rerender(wrap(<OrderDocumentLines {...props} documents={[refused]} />));
    expect(screen.getByTestId('order-document-remove')).toBeInTheDocument();
  });

  it('a read-only account is not offered remove or refresh on a line that is waiting or released', () => {
    render(
      wrap(
        <OrderDocumentLines
          {...props}
          readOnly
          documents={[docLine({ id: 'a' }), docLine({ ...WAITING, id: 'b' }), docLine({ ...WAITING, id: 'c', release_status: 'released' })]}
        />,
      ),
    );
    expect(screen.getAllByTestId('order-document-remove')).toHaveLength(1);
    expect(screen.getAllByTestId('order-document-refresh')).toHaveLength(1);
  });

  it('a refusal needs a note before it can be sent', async () => {
    const user = userEvent.setup();
    render(
      wrap(
        <OrderDocumentLines
          {...props}
          canRelease
          documents={[docLine(WAITING)]}
        />,
      ),
    );
    await user.click(screen.getByTestId('order-document-refuse'));
    expect(screen.getByTestId('order-document-refuse-confirm')).toBeDisabled();
    await user.type(screen.getByTestId('order-document-refuse-note'), 'Superseded. Ask for the 2026 plan.');
    await user.click(screen.getByTestId('order-document-refuse-confirm'));
    expect(mocks.refuseDocument).toHaveBeenCalledWith('o1', 'dl1', 'Superseded. Ask for the 2026 plan.', {
      document_id: 'd1',
      pending_send_id: 'send-1',
    });
  });

  it('releases several waiting documents of one order in one act', async () => {
    const waiting = (id: string) => docLine({ ...WAITING, id, document_id: `doc-${id}` });
    render(wrap(<OrderDocumentLines {...props} canRelease documents={[waiting('a'), waiting('b'), docLine({ id: 'c' })]} />));
    await userEvent.click(screen.getByTestId('order-documents-release-all'));
    expect(await screen.findAllByTestId('release-candidate')).toHaveLength(2);
    await userEvent.click(screen.getByTestId('release-confirm'));
    expect(mocks.releaseDocuments).toHaveBeenCalledTimes(1);
    expect(mocks.releaseDocuments).toHaveBeenCalledWith('o1', [
      { id: 'a', document_id: 'doc-a', version_number: 1, pending_send_id: 'send-1' },
      { id: 'b', document_id: 'doc-b', version_number: 1, pending_send_id: 'send-1' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Add documents for items
// ---------------------------------------------------------------------------

function approved(over: Partial<ApprovedItem>): ApprovedItem {
  return {
    link_id: 'l1',
    product_id: 'p1',
    product_name: 'Heavy Cream 40%',
    product_active: true,
    our_sku: '30417',
    supplier_id: 's1',
    supplier_name: 'Northfield Creamery',
    facility: null,
    approval_status: 'approved',
    approval_source: 'initial',
    approval_decided_at: null,
    approval_decided_by: null,
    approval_decided_by_name: null,
    approval_note: null,
    supplied: true,
    discontinued_at: null,
    link_source: 'admin',
    brand_owner: null,
    producer: null,
    plant_code: null,
    private_label: false,
    ...over,
  };
}

function proposal(over: Partial<OrderDocumentProposal> = {}): OrderDocumentProposal {
  return {
    product_id: 'p1',
    product_name: 'Heavy Cream 40%',
    supplier_id: 's1',
    supplier_name: 'Northfield Creamery',
    document_type_id: 't-spec',
    document_type_name: 'Spec Sheet',
    resolution: 'found',
    resolution_note: null,
    document_id: 'd1',
    document_title: 'Heavy cream specification',
    document_due_date: null,
    sharing_rule: 'free',
    private_label: false,
    advisory: null,
    outcome: 'would_add',
    ...over,
  };
}

describe('AddOrderDocumentsDialog', () => {
  const TYPES = { documentTypes: [{ id: 't-spec', name: 'Spec Sheet', supplier_id: null }, { id: 't-haccp', name: 'HACCP Plan', supplier_id: null }, { id: 't-own', name: 'Lakeshore Process Flow', supplier_id: 's-other' }] };

  it('lists one row per item AND supplier, from the approved pairs only', async () => {
    mocks.typesList.mockResolvedValue(TYPES);
    mocks.approvedList.mockResolvedValue({
      items: [approved({}), approved({ link_id: 'l2', supplier_id: 's2', supplier_name: 'Lakeshore Dairy Cooperative', private_label: true })],
      total: 2, counts: { approved: 2, pending: 0, not_approved: 0 }, limit: 100, offset: 0,
    });
    render(wrap(<AddOrderDocumentsDialog open orderId="o1" onClose={vi.fn()} onAdded={vi.fn()} />));

    const rows = await screen.findAllByTestId('add-documents-item');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Heavy Cream 40% (30417)');
    expect(rows[0]).toHaveTextContent('Northfield Creamery');
    expect(rows[1]).toHaveTextContent('Lakeshore Dairy Cooperative · Private label');
    expect(mocks.approvedList).toHaveBeenCalledWith(expect.objectContaining({ approval: 'approved' }));
    // Another supplier's own type is not offered until one of its items is picked.
    expect(screen.getByText('Spec Sheet')).toBeInTheDocument();
    expect(screen.queryByText('Lakeshore Process Flow')).not.toBeInTheDocument();
    // Nothing chosen yet: nothing to look up.
    expect(screen.getByTestId('add-documents-preview-button')).toBeDisabled();
  });

  it('searches the approved list on the server', async () => {
    const user = userEvent.setup();
    render(wrap(<AddOrderDocumentsDialog open orderId="o1" onClose={vi.fn()} onAdded={vi.fn()} />));
    await user.type(screen.getByTestId('add-documents-search'), 'cream cheese');
    await waitFor(() => expect(mocks.approvedList).toHaveBeenCalledWith(expect.objectContaining({ q: 'cream cheese', approval: 'approved' })));
  });

  it('shows what resolves BEFORE adding, names what is refused, and then adds exactly that', async () => {
    mocks.typesList.mockResolvedValue(TYPES);
    mocks.approvedList.mockResolvedValue({
      items: [approved({}), approved({ link_id: 'l2', supplier_id: 's2', supplier_name: 'Lakeshore Dairy Cooperative' })],
      total: 2, counts: { approved: 2, pending: 0, not_approved: 0 }, limit: 100, offset: 0,
    });
    const dryRun = {
      dry_run: true,
      lines: [
        proposal(),
        proposal({ document_type_id: 't-haccp', document_type_name: 'HACCP Plan', resolution: 'missing', document_id: null, document_title: null, sharing_rule: null }),
        proposal({ supplier_id: 's2', supplier_name: 'Lakeshore Dairy Cooperative', resolution: 'expired', sharing_rule: 'qa', advisory: ADVISORY }),
      ],
      refused: [{ product_id: 'p9', supplier_id: 's2', product_name: 'Butter', supplier_name: 'Lakeshore Dairy Cooperative', reason: 'This item is waiting for approval from this supplier.' }],
    };
    mocks.addDocuments.mockResolvedValueOnce(dryRun).mockResolvedValueOnce({ ...dryRun, dry_run: false });
    const onAdded = vi.fn();
    const user = userEvent.setup();
    render(wrap(<AddOrderDocumentsDialog open orderId="o1" onClose={vi.fn()} onAdded={onAdded} />));

    for (const row of await screen.findAllByTestId('add-documents-item')) await user.click(row);
    const typeBoxes = screen.getAllByTestId('add-documents-type');
    await user.click(typeBoxes[0]);
    await user.click(typeBoxes[1]);
    await user.click(screen.getByTestId('add-documents-preview-button'));

    const expectedBody = {
      items: [{ product_id: 'p1', supplier_id: 's1' }, { product_id: 'p1', supplier_id: 's2' }],
      document_type_ids: ['t-spec', 't-haccp'],
    };
    expect(mocks.addDocuments).toHaveBeenNthCalledWith(1, 'o1', { ...expectedBody, dry_run: true });

    const previewRows = await screen.findAllByTestId('add-documents-preview-row');
    expect(previewRows).toHaveLength(3);
    expect(previewRows[0]).toHaveTextContent('Found');
    expect(previewRows[0]).toHaveTextContent('Send freely');
    expect(previewRows[1]).toHaveTextContent('Nothing on file');
    expect(previewRows[2]).toHaveTextContent('Expired');
    expect(previewRows[2]).toHaveTextContent('Needs QA approval');
    expect(previewRows[2]).toHaveTextContent('names Northfield Creamery');
    expect(screen.getByTestId('add-documents-refused')).toHaveTextContent('Butter · Lakeshore Dairy Cooperative: This item is waiting for approval');

    await user.click(screen.getByTestId('add-documents-confirm'));
    expect(mocks.addDocuments).toHaveBeenNthCalledWith(2, 'o1', expectedBody);
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
  });
});

// ---------------------------------------------------------------------------
// The three groups on the send review
// ---------------------------------------------------------------------------

function planLine(over: Partial<OrderSendDocumentLine> = {}): OrderSendDocumentLine {
  return {
    order_document_id: 'dl1',
    product_name: 'Cream Cheese 3 lb',
    supplier_name: 'Northfield Creamery',
    facility_name: 'Plant 2',
    document_type_name: 'Spec Sheet',
    document_id: 'd1',
    document_title: 'Cream cheese specification',
    sharing_rule: 'free',
    reason: null,
    text: 'Goes now, on a link that works for 30 days.',
    delivery: 'link',
    advisory: null,
    stale_note: null,
    notifies_qa: false,
    ...over,
  };
}

function documentPlan(over: Partial<OrderSendPreview> = {}): OrderSendPreview {
  return {
    order: { id: 'o1', order_number: 'DO-41', po_number: null, ship_date: null, customer_id: 'c1', customer_name: 'Harbor Bakery' },
    recipient: 'buyer@harborbakery.example',
    recipients: ['buyer@harborbakery.example'],
    recipient_source: 'customer_email',
    recipients_over_cap: 0,
    item_requirements: [],
    from_name: 'Test Corp via SupDox',
    reply_to: 'dana@example.com',
    default_subject: 'Test Corp: documents for order DO-41',
    email_configured: true,
    files: [
      {
        key: 'doclink:d1', file_name: 'Northfield-Creamery_Spec-Sheet_1.pdf', bytes: 64000, delivery: 'link', source: 'document',
        part_number: 1, document_ids: ['d1'], document_title: 'Spec Sheet - Northfield Creamery', supplier_name: 'Northfield Creamery',
        document_type_name: 'Spec Sheet', lot_label: null, lines: [], notes: [], link_days: 30,
        document_lines: [{ order_document_id: 'dl1', product_name: 'Cream Cheese 3 lb', supplier_name: 'Northfield Creamery', document_type_name: 'Spec Sheet' }],
      },
    ],
    parts: [{ part_number: 1, subject: 'Test Corp: documents for order DO-41', bytes: 0, file_count: 1 }],
    part_count: 1,
    total_bytes: 64000,
    lines_not_sent: [
      { order_item_id: 'x', product_name: 'Butter', lot_number: '555', reason: 'No document on this line.' },
      { order_item_id: '', order_document_id: 'dl3', product_name: 'Cream Cheese 3 lb', lot_number: null, reason: 'Locked. This document does not leave the organization.', sharing_refusal: 'locked' },
    ],
    documents: {
      goes_now: [planLine({ advisory: ADVISORY })],
      waits_for_qa: [planLine({ order_document_id: 'dl2', document_type_name: 'HACCP Plan', document_title: 'Hazard plan', sharing_rule: 'qa', text: 'Needs QA approval. It is held for QA, and mailed to the same addresses once QA releases it.', notifies_qa: true })],
      will_not_go: [
        planLine({ order_document_id: 'dl3', document_type_name: 'W-9', document_title: 'Tax form', sharing_rule: 'locked', reason: 'locked', text: 'Locked. This document does not leave the organization.' }),
        planLine({ order_document_id: 'dl4', document_type_name: 'Kosher Certificate', document_id: null, document_title: null, sharing_rule: null, reason: 'missing', text: 'No approved document of this type is on file for this item and supplier. QA is told when the order is sent.', notifies_qa: true }),
      ],
      link_days: 30,
      only_asks_qa: false,
    },
    warnings: [],
    blocked: null,
    limits: { max_part_bytes: 15 * 1024 * 1024, max_parts: 10 },
    fingerprint: 'fp-docs',
    ...over,
  };
}

describe('SendOrderDialog with document lines', () => {
  it('shows the three groups: goes now, waits for QA, will not go, each with its reason', async () => {
    mocks.sendPreview.mockResolvedValue(documentPlan());
    render(wrap(<SendOrderDialog open orderId="o1" onClose={vi.fn()} onSent={vi.fn()} onFailed={vi.fn()} />));

    const goes = await screen.findByTestId('send-documents-goes-now');
    expect(goes).toHaveTextContent('Goes now (1)');
    expect(goes).toHaveTextContent('Spec Sheet');
    expect(goes).toHaveTextContent('Send freely');
    // The private-label advisory is in the review, for the sender.
    expect(within(goes).getByTestId('send-document-advisory')).toHaveTextContent('names Northfield Creamery');

    const waits = screen.getByTestId('send-documents-waits');
    expect(waits).toHaveTextContent('Waits for QA (1)');
    expect(waits).toHaveTextContent('HACCP Plan');
    expect(waits).toHaveTextContent('Needs QA approval');

    const wont = screen.getByTestId('send-documents-will-not-go');
    expect(wont).toHaveTextContent('Will not go (2)');
    expect(wont).toHaveTextContent('Locked. This document does not leave the organization.');
    expect(wont).toHaveTextContent('No approved document of this type is on file');

    // The file on the link says which link, and it is not the non-expiring one.
    expect(screen.getByTestId('send-file-row')).toHaveTextContent('On the 30-day link');
    expect(screen.queryByText('Sent as a link')).not.toBeInTheDocument();
    expect(screen.getByText(/one link that works for 30 days/)).toBeInTheDocument();
    // The COA "Not sent" list keeps the COA line only: nothing is printed twice.
    expect(screen.getByTestId('send-lines-not-sent')).toHaveTextContent('Not sent (1)');
    expect(screen.getByTestId('send-order-confirm')).toHaveTextContent('Send');
    expect(screen.getByTestId('send-order-confirm')).toBeEnabled();
  });

  it('lines on hold get their own group, COA lines and document lines together, each with the reason', async () => {
    const base = documentPlan();
    mocks.sendPreview.mockResolvedValue(
      documentPlan({
        lines_not_sent: [
          ...base.lines_not_sent,
          {
            order_item_id: 'y', product_name: 'Heavy Cream', lot_number: '5501', document_id: 'd9',
            reason: 'On hold (lot 5501): Critical result out of spec: Coliform 40 CFU/g.', sharing_refusal: 'held',
            hold: { id: 'h1', document_id: 'd9', lot_id: 'l1', lot_label: '5501', reason: 'Critical result out of spec: Coliform 40 CFU/g.', source: 'spec_critical', placed_at: '2026-10-08 10:00:00' },
          },
          {
            order_item_id: '', order_document_id: 'dl5', product_name: 'Cream Cheese 3 lb', lot_number: null, document_type_name: 'Allergen Statement',
            reason: 'On hold: Supplier withdrew this statement. It can go once QA or an administrator releases the hold.', sharing_refusal: 'held',
          },
        ],
        documents: {
          ...base.documents!,
          will_not_go: [
            ...base.documents!.will_not_go,
            planLine({ order_document_id: 'dl5', document_type_name: 'Allergen Statement', reason: 'held', text: 'On hold: Supplier withdrew this statement. It can go once QA or an administrator releases the hold.' }),
          ],
        },
      }),
    );
    render(wrap(<SendOrderDialog open orderId="o1" onClose={vi.fn()} onSent={vi.fn()} onFailed={vi.fn()} />));

    const held = await screen.findByTestId('send-lines-on-hold');
    expect(held).toHaveTextContent('On hold (2)');
    expect(held).toHaveTextContent('QA or an administrator releases a hold');
    const lines = within(held).getAllByTestId('send-line-on-hold');
    expect(lines[0]).toHaveTextContent('Heavy Cream · Lot 5501: On hold (lot 5501): Critical result out of spec: Coliform 40 CFU/g.');
    expect(lines[1]).toHaveTextContent('Cream Cheese 3 lb · Allergen Statement: On hold: Supplier withdrew this statement.');

    // Nothing is printed twice: the held COA line is not under "Not sent",
    // and the held document line is not under "Will not go".
    expect(screen.getByTestId('send-lines-not-sent')).toHaveTextContent('Not sent (1)');
    expect(screen.getByTestId('send-lines-not-sent')).not.toHaveTextContent('Heavy Cream');
    const wont = screen.getByTestId('send-documents-will-not-go');
    expect(wont).toHaveTextContent('Will not go (2)');
    expect(wont).not.toHaveTextContent('Allergen Statement');
  });

  it('with nothing on hold there is no hold group at all', async () => {
    mocks.sendPreview.mockResolvedValue(documentPlan());
    render(wrap(<SendOrderDialog open orderId="o1" onClose={vi.fn()} onSent={vi.fn()} onFailed={vi.fn()} />));
    await screen.findByTestId('send-documents-goes-now');
    expect(screen.queryByTestId('send-lines-on-hold')).toBeNull();
  });

  it('says so when the send reaches nobody yet and only asks QA', async () => {
    mocks.sendPreview.mockResolvedValue(
      documentPlan({
        files: [],
        parts: [],
        part_count: 0,
        lines_not_sent: [],
        documents: { ...documentPlan().documents!, goes_now: [], only_asks_qa: true },
      }),
    );
    render(wrap(<SendOrderDialog open orderId="o1" onClose={vi.fn()} onSent={vi.fn()} onFailed={vi.fn()} />));
    expect(await screen.findByTestId('send-only-asks-qa')).toHaveTextContent('Nothing reaches the customer with this send');
    expect(screen.queryByTestId('send-documents-goes-now')).not.toBeInTheDocument();
    expect(screen.queryByTestId('send-part')).not.toBeInTheDocument();
    expect(screen.getByTestId('send-order-confirm')).toHaveTextContent('Ask QA');
    expect(screen.getByTestId('send-order-confirm')).toBeEnabled();
  });

  it('an order of COAs alone shows no document groups', async () => {
    mocks.sendPreview.mockResolvedValue(documentPlan({ documents: undefined }));
    render(wrap(<SendOrderDialog open orderId="o1" onClose={vi.fn()} onSent={vi.fn()} onFailed={vi.fn()} />));
    await screen.findByTestId('send-file-row');
    expect(screen.queryByTestId('send-documents')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

describe('OrderSendHistory with document orders', () => {
  function record(over: Partial<OrderSendSummary> = {}): OrderSendSummary {
    return {
      id: 's1', order_id: 'o1', order_number: 'DO-41', customer_name: 'Harbor Bakery', status: 'sent',
      created_at: '2026-10-08 12:00:00', sent_by_id: 'u2', sent_by_name: 'Quinn Lee', sent_by_email: 'quinn@example.com',
      recipients: ['buyer@harborbakery.example'], subject: 'Documents for order DO-41 - additional documents', message: null,
      part_count: 1, parts: [{ part_number: 1, ok: true, status: 200, error: null, sent_at: 'x', attempts: 1 }],
      files: [{ position: 0, file_name: 'Hazard-plan_1.pdf', bytes: 1000, part_number: 1, delivery: 'link', source: 'document', document_id: 'd2', document_ids: ['d2'], document_title: 'HACCP Plan', lot_label: null, sent_ok: true, link_days: 30, order_document_ids: ['dl2'] }],
      can_resend: false,
      kind: 'qa_release',
      ...over,
    };
  }

  it('a QA release names who released it and says the link runs out', () => {
    render(wrap(<OrderSendHistory sends={[record()]} />));
    const card = screen.getByTestId('order-send-card');
    expect(card).toHaveAttribute('data-kind', 'qa_release');
    expect(card).toHaveTextContent('Released by QA');
    expect(card).toHaveTextContent('released by Quinn Lee');
    expect(card).toHaveTextContent('sent on a link that works for 30 days');
    expect(card).not.toHaveTextContent('does not expire');
  });

  it('a send that only asked QA does not read as though something was sent', () => {
    render(wrap(<OrderSendHistory sends={[record({ kind: 'qa_request', part_count: 0, parts: [], files: [] })]} />));
    const card = screen.getByTestId('order-send-card');
    expect(card).toHaveTextContent('Asked QA');
    expect(card).not.toHaveTextContent('Sent');
    expect(screen.getByTestId('order-send-qa-request')).toHaveTextContent('Nothing was sent to the customer');
  });

  it('a release whose outcome was never recorded says exactly that, not "sent" and not "not sent"', () => {
    render(
      wrap(
        <OrderSendHistory
          sends={[record({ status: 'partial', parts: [{ part_number: 1, ok: false, status: 0, error: 'The email was handed to the mail provider and its outcome was not recorded. This release did not finish.', sent_at: null, attempts: 1 }] })]}
        />,
      ),
    );
    const card = screen.getByTestId('order-send-card');
    expect(card).toHaveTextContent('Release did not finish');
    expect(card).toHaveTextContent('it is not known whether the email reached the customer');
    expect(card).not.toHaveTextContent('Released by QA');
    expect(screen.queryByTestId('order-send-resend')).not.toBeInTheDocument();
  });

  it('a send in which nothing left reads "Withdrawn, nothing sent", never "Sent", and offers no resend', () => {
    const r = record({
      kind: 'send', status: 'failed', outcome: 'withdrawn', can_resend: false,
      parts: [{ part_number: 1, ok: false, status: 0, error: null, sent_at: null, attempts: 2, withdrawn: true, note: 'Nothing was left to send in this email, so no email was sent.' }],
    });
    r.files[0] = { ...r.files[0], sent_ok: false, not_sent_reason: 'Hazard-plan_1.pdf was not sent again: its line was taken off the order.' };
    render(wrap(<OrderSendHistory sends={[r]} />));
    expect(screen.getByTestId('order-send-chip')).toHaveTextContent('Withdrawn, nothing sent');
    expect(screen.getByTestId('order-send-chip')).not.toHaveTextContent(/^Sent$/);
    expect(screen.getByTestId('order-send-withdrawn')).toHaveTextContent('No email left on this send');
    expect(screen.queryByTestId('order-send-resend')).not.toBeInTheDocument();
    // It did not "fail": nothing says the customer may still get it on a retry.
    expect(screen.queryByText('Nothing reached the customer.')).not.toBeInTheDocument();
  });

  it('some emails went and the rest were withdrawn: said as that, with nothing left to resend', () => {
    const r = record({
      kind: 'send', status: 'partial', outcome: 'sent_rest_withdrawn', can_resend: false, part_count: 2,
      parts: [
        { part_number: 1, ok: true, status: 200, error: null, sent_at: 'x', attempts: 1 },
        { part_number: 2, ok: false, status: 0, error: null, sent_at: null, attempts: 2, withdrawn: true },
      ],
    });
    render(wrap(<OrderSendHistory sends={[r]} />));
    expect(screen.getByTestId('order-send-chip')).toHaveTextContent('Partly sent, the rest withdrawn');
    expect(screen.getByTestId('order-send-withdrawn')).toHaveTextContent('There is nothing left to resend');
    expect(screen.queryByTestId('order-send-resend')).not.toBeInTheDocument();
  });

  it('a release somebody else put back mid-flight says who, and is not "Released"', () => {
    const error = 'The email was sent, but Org Admin put this release back while it was going out, and its link was withdrawn. The customer holds a link that no longer opens. The documents are waiting for QA again.';
    render(
      wrap(
        <OrderSendHistory
          sends={[record({ status: 'failed', parts: [{ part_number: 1, ok: false, status: 200, error, sent_at: 'x', attempts: 1, code: 'undone', undone_by_name: 'Org Admin' }] })]}
        />,
      ),
    );
    const card = screen.getByTestId('order-send-card');
    expect(screen.getByTestId('order-send-chip')).toHaveTextContent('Release undone');
    expect(card).toHaveTextContent('Org Admin put this release back');
    expect(card).not.toHaveTextContent('Released by QA');
    // Not the plain "did not go" wording: the email DID go.
    expect(card).not.toHaveTextContent('The release email did not go');
  });

  it('a file a resend left out says why', () => {
    const r = record({ kind: 'send' });
    r.files[0] = { ...r.files[0], sent_ok: false, not_sent_reason: 'Hazard-plan_1.pdf was not sent again: QA has since refused it for this order.' };
    render(wrap(<OrderSendHistory sends={[r]} />));
    expect(screen.getByTestId('order-send-file-withdrawn')).toHaveTextContent('QA has since refused it for this order');
  });

  it('a failed release says the documents wait again, and offers no resend', () => {
    render(
      wrap(
        <OrderSendHistory
          sends={[record({ status: 'failed', parts: [{ part_number: 1, ok: false, status: 500, error: 'provider said no', sent_at: null, attempts: 1 }] })]}
        />,
      ),
    );
    expect(screen.getByTestId('order-send-card')).toHaveTextContent('The documents are waiting for QA again');
    expect(screen.queryByTestId('order-send-resend')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The order page: a reader builds and does not send
// ---------------------------------------------------------------------------

describe('OrderDetail', () => {
  const order = {
    id: 'o1', order_number: 'DO-41', po_number: null, customer_name: 'Harbor Bakery', customer_number: null, customer_id: null,
    status: 'pending', item_count: 0, matched_count: 0, connector_id: null, connector_run_id: null, connector_name: null,
    source_data: null, staged_at: null, created_at: '2026-10-08 10:00:00', updated_at: '2026-10-08 10:00:00',
  };

  it('a read-only account sees Build and is not offered Send', async () => {
    reader = true;
    mocks.get.mockResolvedValue({ order, items: [], suggestions: [], sends: [], documents: [docLine()], can_release_qa: false });
    render(wrap(<OrderDetail />));

    expect(await screen.findByTestId('order-add-documents')).toBeInTheDocument();
    expect(screen.getByTestId('order-document-line')).toBeInTheDocument();
    expect(screen.getByTestId('order-document-remove')).toBeInTheDocument();
    expect(screen.getByTestId('order-reader-builds')).toHaveTextContent('Sending it is done by somebody with a sending account');
    expect(screen.queryByTestId('order-review-send')).not.toBeInTheDocument();
    expect(screen.queryByTestId('order-add-coas')).not.toBeInTheDocument();
    expect(screen.queryByTestId('order-document-release')).not.toBeInTheDocument();
  });

  it('an order with only document lines can be reviewed and sent by someone who may', async () => {
    mocks.get.mockResolvedValue({ order, items: [], suggestions: [], sends: [], documents: [docLine()], can_release_qa: false });
    render(wrap(<OrderDetail />));
    expect(await screen.findByTestId('order-review-send')).toBeEnabled();
    expect(screen.getByTestId('order-add-documents')).toBeInTheDocument();
  });

  it('with nothing on the order there is nothing to review', async () => {
    mocks.get.mockResolvedValue({ order, items: [], suggestions: [], sends: [], documents: [], can_release_qa: false });
    render(wrap(<OrderDetail />));
    expect(await screen.findByTestId('order-review-send')).toBeDisabled();
    expect(screen.getByTestId('order-documents-empty')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Waiting for QA
// ---------------------------------------------------------------------------

describe('OrdersWaitingForQa', () => {
  function pendingLine(over: Partial<PendingOrderDocument> = {}): PendingOrderDocument {
    return {
      id: 'dl2', order_id: 'o1', order_number: 'DO-41', customer_name: 'Harbor Bakery',
      product_name: 'Cream Cheese 3 lb', supplier_name: 'Northfield Creamery', facility_name: 'Plant 2',
      document_type_name: 'HACCP Plan', document_id: 'd2', document_title: 'Hazard plan', document_status: 'active',
      version_number: 3, document_approved_at: '2026-06-01 09:00:00', pending_send_id: 'send-9', release_status: 'pending_qa', stuck: false,
      hold: null,
      sharing_rule: 'qa', requested_by_name: 'Dana Reid', requested_at: '2026-10-08 11:00:00',
      recipients: ['buyer@harborbakery.example'], private_label: false, advisory: null, releasable: true, blocked_reason: null,
      earlier_refusals: [],
      ...over,
    };
  }

  it('lists what is waiting by order, with the count, who asked and who it goes to', async () => {
    mocks.pending.mockResolvedValue({
      can_release: true,
      count: 3,
      lines: [
        pendingLine(),
        pendingLine({ id: 'dl5', document_type_name: 'Letter of Guarantee', document_title: 'Guarantee letter' }),
        pendingLine({ id: 'dl6', document_type_name: 'Audit Certificate', sharing_rule: 'locked', releasable: false, blocked_reason: 'The document is locked now. Nobody releases a locked document.' }),
      ],
    });
    render(wrap(<OrdersWaitingForQa />));

    expect(await screen.findByTestId('waiting-count')).toHaveTextContent('(3)');
    const card = screen.getByTestId('waiting-order');
    expect(card).toHaveTextContent('Order DO-41');
    expect(card).toHaveTextContent('for Harbor Bakery');
    expect(card).toHaveTextContent('Asked by Dana Reid');
    expect(card).toHaveTextContent('goes to buyer@harborbakery.example');
    expect(screen.getAllByTestId('waiting-line')).toHaveLength(3);
    // A document that can no longer be released says why and has no live button.
    expect(screen.getByTestId('waiting-blocked')).toHaveTextContent('locked now');
    expect(screen.getAllByTestId('waiting-release')[2]).toBeDisabled();

    // Each line shows the version and approval date of the document a release would send.
    expect(screen.getAllByTestId('waiting-document-facts')[0]).toHaveTextContent('Version 3 · approved');

    // Released together, the releasable ones go in one call -- after a look at
    // exactly what is being approved, and carrying it.
    mocks.releaseDocuments.mockResolvedValue({ released: ['dl2', 'dl5'], refused: [], sends: [], order_status: 'pending' });
    await userEvent.click(screen.getByTestId('waiting-release-all'));
    expect(mocks.releaseDocuments).not.toHaveBeenCalled();
    const candidates = await screen.findAllByTestId('release-candidate');
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toHaveTextContent('Hazard plan');
    expect(candidates[0]).toHaveTextContent('HACCP Plan · version 3 · approved');
    expect(candidates[0]).toHaveTextContent('Asked by Dana Reid');
    expect(candidates[0]).toHaveTextContent('Goes to buyer@harborbakery.example');
    await userEvent.click(screen.getByTestId('release-confirm'));
    expect(mocks.releaseDocuments).toHaveBeenCalledTimes(1);
    expect(mocks.releaseDocuments).toHaveBeenCalledWith('o1', [
      { id: 'dl2', document_id: 'd2', version_number: 3, pending_send_id: 'send-9' },
      { id: 'dl5', document_id: 'd2', version_number: 3, pending_send_id: 'send-9' },
    ]);
    expect(await screen.findByText(/Released 2 documents in one email/)).toBeInTheDocument();
    // The list is read again afterwards, whatever happened.
    expect(mocks.pending.mock.calls.length).toBeGreaterThan(1);
  });

  it('refusing needs a note', async () => {
    mocks.pending.mockResolvedValue({ can_release: true, count: 1, lines: [pendingLine()] });
    const user = userEvent.setup();
    render(wrap(<OrdersWaitingForQa />));
    await user.click(await screen.findByTestId('waiting-refuse'));
    expect(screen.getByTestId('waiting-refuse-confirm')).toBeDisabled();
    await user.type(screen.getByTestId('waiting-refuse-note'), 'Not this revision.');
    await user.click(screen.getByTestId('waiting-refuse-confirm'));
    expect(mocks.refuseDocument).toHaveBeenCalledWith('o1', 'dl2', 'Not this revision.', {
      document_id: 'd2',
      pending_send_id: 'send-9',
    });
  });

  it('an earlier refusal of the same ask on the same order is shown on the list and in the release dialog', async () => {
    mocks.pending.mockResolvedValue({
      can_release: true,
      count: 1,
      lines: [pendingLine({ earlier_refusals: [{ by_name: 'Quinn Lee', at: '2026-10-07 09:00:00', note: 'Superseded. Use the 2026 plan.', document_id: 'd2' }] })],
    });
    render(wrap(<OrdersWaitingForQa />));
    const before = await screen.findByTestId('waiting-earlier-refusal');
    expect(before).toHaveTextContent('Refused before on this order by Quinn Lee');
    expect(before).toHaveTextContent('Superseded. Use the 2026 plan.');
    await userEvent.click(screen.getByTestId('waiting-release'));
    expect(await screen.findByTestId('release-earlier-refusal')).toHaveTextContent('Superseded. Use the 2026 plan.');
  });

  it('a line that changed since the list was opened is said, and the list reloads', async () => {
    mocks.pending.mockResolvedValue({ can_release: true, count: 1, lines: [pendingLine()] });
    mocks.releaseDocuments.mockRejectedValue(new Error('This document line changed since you opened it, so nothing was released. Reload the list and look at it again.'));
    render(wrap(<OrdersWaitingForQa />));
    await userEvent.click(await screen.findByTestId('waiting-release'));
    await userEvent.click(await screen.findByTestId('release-confirm'));
    expect(await screen.findByText(/changed since you opened it/)).toBeInTheDocument();
    await waitFor(() => expect(mocks.pending.mock.calls.length).toBeGreaterThan(1));
  });

  it('more than one release carries is refused on the screen before anything is asked', async () => {
    const many = Array.from({ length: 51 }, (_, i) => pendingLine({ id: `l${i}` }));
    mocks.pending.mockResolvedValue({ can_release: true, count: 51, lines: many });
    render(wrap(<OrdersWaitingForQa />));
    await userEvent.click(await screen.findByTestId('waiting-release-all'));
    expect(await screen.findByTestId('release-too-many')).toHaveTextContent('at most 50 documents');
    expect(screen.getByTestId('release-confirm')).toBeDisabled();
    expect(mocks.releaseDocuments).not.toHaveBeenCalled();
  });

  it('a release that did not finish is shown as that, with Release again and Put back', async () => {
    mocks.pending.mockResolvedValue({ can_release: true, count: 1, lines: [pendingLine({ release_status: 'releasing', stuck: true })] });
    render(wrap(<OrdersWaitingForQa />));
    expect(await screen.findByTestId('waiting-releasing')).toHaveTextContent('did not finish');
    expect(screen.getByTestId('waiting-releasing')).toHaveTextContent('not been recorded as sent');
    expect(screen.getByTestId('waiting-release')).toHaveTextContent('Release again');
    expect(screen.getByTestId('waiting-refuse')).toBeDisabled();
    await userEvent.click(screen.getByTestId('waiting-give-back'));
    expect(mocks.giveBackDocument).toHaveBeenCalledWith('o1', 'dl2');
  });

  it('tells somebody who cannot release that it is not theirs to do, and offers no button', async () => {
    mocks.pending.mockResolvedValue({ can_release: false, count: 0, lines: [] });
    render(wrap(<OrdersWaitingForQa />));
    expect(await screen.findByTestId('waiting-not-a-releaser')).toBeInTheDocument();
    expect(screen.queryByTestId('waiting-release')).not.toBeInTheDocument();
  });
});
