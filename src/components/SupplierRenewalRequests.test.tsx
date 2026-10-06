/**
 * Renewals > Supplier requests, and Supplier > Contacts (migration 0133).
 *
 *   1. The review dialog shows everything that will leave -- To, Subject,
 *      Message, and the link block -- and the link block is NOT an input.
 *   2. "Approve and send" posts exactly the edited subject and body; nothing
 *      is sent by opening the dialog.
 *   3. A caller who may not approve sees the draft and no send button.
 *   4. A supplier with no document contact cannot be sent to, and the screen
 *      says why; documents nothing was drafted for are listed with the reason.
 *   5. An organization with no contacts and no drafts gets no new section.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type {
  RenewalRequestItem,
  RenewalRequestListResponse,
  RenewalRequestSend,
  SupplierContactsResponse,
} from '../../shared/types';

const listRequests = vi.fn();
const approve = vi.fn();
const skip = vi.fn();
const listContacts = vi.fn();
const createContact = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    renewalRequests: {
      list: (...a: unknown[]) => listRequests(...a),
      approve: (...a: unknown[]) => approve(...a),
      skip: (...a: unknown[]) => skip(...a),
    },
    suppliers: {
      contacts: {
        list: (...a: unknown[]) => listContacts(...a),
        create: (...a: unknown[]) => createContact(...a),
      },
    },
  },
}));

import { SupplierRenewalRequests } from './SupplierRenewalRequests';
import SupplierContactsPanel from './SupplierContactsPanel';

const LINK_BLOCK = 'Upload the document here (no login needed):\n[the secure upload link is added here when the email is sent]';

function send(over: Partial<RenewalRequestSend> = {}): RenewalRequestSend {
  return {
    id: 'send1',
    stage: 'window_open',
    status: 'pending',
    draft_subject: 'Renewal request: Certificate of Insurance',
    draft_body: 'Hello Dana,\n\nPlease send the current version.',
    approver_user_id: 'u1',
    approver_name: 'Pat Buyer',
    approver_via: 'owner_route',
    drafted_at: '2026-07-10 13:00:00',
    approved_by: null,
    approved_by_name: null,
    approved_at: null,
    sent_at: null,
    sent_to: null,
    sent_subject: null,
    sent_body: null,
    skipped_by_name: null,
    skipped_at: null,
    failure: null,
    ...over,
  };
}

function request(over: Partial<RenewalRequestItem> = {}): RenewalRequestItem {
  return {
    id: 'cycle1',
    document: { id: 'doc1', title: 'Acme COI' },
    supplier: { id: 'sup1', name: 'Acme Supplier' },
    due_date: '2026-09-01',
    status: 'open',
    status_reason: null,
    escalated_at: null,
    closed_at: null,
    request_id: null,
    contact: { name: 'Dana Reyes', email: 'docs@acme.example' },
    sends: [send()],
    waiting_send_id: 'send1',
    can_approve: true,
    emails_sent: 0,
    ...over,
  };
}

function response(over: Partial<RenewalRequestListResponse> = {}): RenewalRequestListResponse {
  return {
    requests: [request()],
    not_drafted: { no_supplier: [], no_contact: [], past_escalation: [] },
    link_block_preview: LINK_BLOCK,
    email_configured: true,
    escalate_after_days: 21,
    ...over,
  };
}

function renderSection() {
  return render(
    <MemoryRouter>
      <SupplierRenewalRequests />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Renewals > Supplier requests', () => {
  it('shows the whole message before it is sent; the link block is not editable', async () => {
    listRequests.mockResolvedValue(response());
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: 'Review and send' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByTestId('review-to').textContent).toBe('Dana Reyes <docs@acme.example>');
    expect((within(dialog).getByLabelText('Subject') as HTMLInputElement).value).toBe(
      'Renewal request: Certificate of Insurance',
    );
    expect((within(dialog).getByLabelText('Message') as HTMLTextAreaElement).value).toContain('Hello Dana,');

    const block = within(dialog).getByTestId('review-link-block');
    expect(block.textContent).toContain('Upload the document here');
    // Plain text on the page, not a field somebody could clear.
    expect(block.querySelector('input, textarea')).toBeNull();
    expect(within(dialog).getByText(/cannot be edited or removed/)).toBeTruthy();

    // Opening and reading sends nothing.
    expect(approve).not.toHaveBeenCalled();
  });

  it('approve posts exactly the edited subject and body', async () => {
    listRequests.mockResolvedValue(response());
    approve.mockResolvedValue({
      sent: true,
      request: request({ waiting_send_id: null, emails_sent: 1, sends: [send({ status: 'sent', sent_to: 'docs@acme.example' })] }),
    });
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: 'Review and send' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Subject'), { target: { value: 'New certificate please' } });
    fireEvent.change(within(dialog).getByLabelText('Message'), { target: { value: 'Hi Dana, please send it.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and send' }));

    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith('cycle1', 'send1', {
        subject: 'New certificate please',
        body: 'Hi Dana, please send it.',
      }),
    );
    expect(await screen.findByText('Sent to docs@acme.example.')).toBeTruthy();
    // It moved out of "waiting" without a reload.
    expect(screen.queryByRole('button', { name: 'Review and send' })).toBeNull();
    expect(screen.getByText('Waiting on the supplier')).toBeTruthy();
  });

  it('a refused send keeps the dialog open with the reason', async () => {
    listRequests.mockResolvedValue(response());
    approve.mockRejectedValue(new Error('mailbox unavailable'));
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Review and send' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and send' }));
    expect(await within(dialog).findByText('mailbox unavailable')).toBeTruthy();
  });

  it('someone who may not approve can read the draft but not send or skip it', async () => {
    listRequests.mockResolvedValue(response({ requests: [request({ can_approve: false })] }));
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: 'View draft' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/waiting for Pat Buyer/)).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Approve and send' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).queryByRole('button', { name: 'Skip this one' })).toBeNull();
    expect((within(dialog).getByLabelText('Message') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('cannot send with no document contact, and lists what was not drafted and why', async () => {
    listRequests.mockResolvedValue(
      response({
        requests: [request({ contact: null })],
        not_drafted: {
          no_contact: [
            { document_id: 'd2', title: 'Beta kosher letter', due_date: '2026-08-15', days_until: 20, supplier_id: 's2', supplier_name: 'Beta Foods' },
          ],
          no_supplier: [
            { document_id: 'd3', title: 'Our FDA registration', due_date: '2026-08-20', days_until: 25, supplier_id: null, supplier_name: null },
          ],
          past_escalation: [],
        },
      }),
    );
    renderSection();

    const notDrafted = await screen.findByTestId('supplier-requests-not-drafted');
    expect(notDrafted.textContent).toContain('2 documents');
    expect(notDrafted.textContent).toContain('Beta kosher letter');
    expect(notDrafted.textContent).toContain('No document contact on file');
    expect(notDrafted.textContent).toContain('Our FDA registration');
    expect(notDrafted.textContent).toContain('nobody to ask');

    fireEvent.click(screen.getByRole('button', { name: 'Review and send' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('review-no-contact')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Approve and send' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows what was sent, verbatim, and says when reminders have stopped', async () => {
    listRequests.mockResolvedValue(
      response({
        requests: [
          request({
            status: 'escalated',
            status_reason: 'no_response',
            waiting_send_id: null,
            emails_sent: 1,
            sends: [
              send({
                status: 'sent',
                sent_to: 'docs@acme.example',
                sent_subject: 'Renewal request',
                sent_body: 'Hello Dana,\n\nUpload the document here (no login needed):\nhttps://x.example/r/abc',
                approved_by_name: 'Pat Buyer',
              }),
            ],
          }),
        ],
      }),
    );
    renderSection();

    expect(await screen.findByText('Escalated — reminders stopped')).toBeTruthy();
    expect(screen.getByText(/1 of 4 sent/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'What was sent' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('https://x.example/r/abc');
    expect(dialog.textContent).toContain('approved by Pat Buyer');
  });

  it('renders nothing for an organization with no drafts and nothing to report', async () => {
    listRequests.mockResolvedValue(response({ requests: [] }));
    const { container } = renderSection();
    await waitFor(() => expect(listRequests).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('[data-testid="supplier-requests"]')).toBeNull());
    expect(screen.queryByText('Supplier requests')).toBeNull();
  });
});

describe('Supplier > Contacts', () => {
  const empty: SupplierContactsResponse = {
    supplier: { id: 'sup1', name: 'Acme Supplier' },
    contacts: [],
    document_contact: null,
  };

  it('says so when there is no document contact, and the first one added is it', async () => {
    listContacts.mockResolvedValue(empty);
    createContact.mockResolvedValue({
      ...empty,
      contacts: [
        {
          id: 'c1', supplier_id: 'sup1', name: 'Dana Reyes', email: 'docs@acme.example', role: null, priority: null,
          is_document_contact: true, active: true, source: 'admin', created_at: '', updated_at: '',
        },
      ],
      document_contact: {
        id: 'c1', supplier_id: 'sup1', name: 'Dana Reyes', email: 'docs@acme.example', role: null, priority: null,
        is_document_contact: true, active: true, source: 'admin', created_at: '', updated_at: '',
      },
    });
    render(<SupplierContactsPanel supplierId="sup1" supplierName="Acme Supplier" canEdit />);

    expect((await screen.findByTestId('no-document-contact')).textContent).toContain('No document contact on file');

    fireEvent.click(screen.getByRole('button', { name: 'Add contact' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Email/), { target: { value: 'docs@acme.example' } });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Dana Reyes' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(createContact).toHaveBeenCalledWith('sup1', {
        name: 'Dana Reyes',
        email: 'docs@acme.example',
        role: null,
        is_document_contact: true,
      }),
    );
    expect(await screen.findByText('Document requests')).toBeTruthy();
    expect(screen.queryByTestId('no-document-contact')).toBeNull();
  });

  it('is read-only for someone who cannot edit', async () => {
    listContacts.mockResolvedValue(empty);
    render(<SupplierContactsPanel supplierId="sup1" supplierName="Acme Supplier" canEdit={false} />);
    await screen.findByTestId('no-document-contact');
    expect(screen.queryByRole('button', { name: 'Add contact' })).toBeNull();
  });
});
