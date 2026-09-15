/**
 * DecideArrivalDialog — the three things that make a decision defensible.
 *
 *   1. ACCEPT IS UNAVAILABLE UNTIL THE FILE IS APPROVED, and the dialog says so
 *      and points at the Review Queue. The server refuses it with a 409 too; a
 *      form that let someone type a note and then bounced would teach people
 *      the rule is a bug.
 *   2. What the supplier claimed, and is still open, is pre-ticked. Anything
 *      already settled is not.
 *   3. The two notes go to the two fields the server keeps apart: the reason
 *      the supplier reads, and the internal note they never see.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DecideArrivalDialog } from './DecideArrivalDialog';
import type { RequestArrival, RequestArrivalClaim } from '../lib/types';

function claim(over: Partial<RequestArrivalClaim>): RequestArrivalClaim {
  return {
    claim_id: 'c1',
    line_id: 'line_1',
    claimed_line_id: 'line_1',
    line_name: 'Allergen Statement',
    line_kind: 'requirement',
    requirement_id: 'req_a',
    tier: 'required',
    line_status: 'received',
    line_accepted_document_id: null,
    claimed_by: 'supplier',
    added_by_name: null,
    decision: null,
    decision_document_id: null,
    decided_at: null,
    decided_by_name: null,
    decided_elsewhere: false,
    ...over,
  };
}

function arrival(over: Partial<RequestArrival> = {}): RequestArrival {
  return {
    id: 'up_1',
    tenant_id: 't1',
    supplier_id: 'sup_1',
    supplier_name: 'Andersen Dairy',
    request_id: 'req_v1',
    root_request_id: 'req_v1',
    current_request_id: 'req_v1',
    current_request_status: 'issued',
    request_title: 'Annual supplier documentation',
    file_name: 'allergen-2026.pdf',
    file_size: 1024,
    mime_type: 'application/pdf',
    uploaded_at: '2026-09-10 09:00:00',
    uploader_label: null,
    queue_id: 'q_1',
    document_id: null,
    document_title: null,
    documents: [],
    pipeline_state: 'awaiting_approval',
    rejection_reason: null,
    rejection_note: null,
    processing_error: null,
    spec: null,
    claims: [
      claim({}),
      claim({
        claim_id: 'c2',
        line_id: 'line_2',
        claimed_line_id: 'line_2',
        line_name: 'Kosher Letter',
        requirement_id: 'req_b',
        line_status: 'accepted',
        decision: 'accepted',
      }),
    ],
    pending_count: 1,
    ...over,
  };
}

function renderDialog(a: RequestArrival, onSubmit = vi.fn().mockResolvedValue(undefined)) {
  const onOpenQueueItem = vi.fn();
  render(
    <DecideArrivalDialog
      open
      arrival={a}
      lines={[
        { id: 'line_1', name: 'Allergen Statement', status: 'received' },
        { id: 'line_2', name: 'Kosher Letter', status: 'accepted' },
        { id: 'line_3', name: 'Organic Certificate', status: 'not_started' },
      ]}
      onClose={() => {}}
      onSubmit={onSubmit}
      onOpenQueueItem={onOpenQueueItem}
    />,
  );
  return { onSubmit, onOpenQueueItem };
}

describe('DecideArrivalDialog', () => {
  it('disables Accept until the file is approved, says why, and links to the Review Queue', async () => {
    const user = userEvent.setup();
    const { onOpenQueueItem } = renderDialog(arrival());

    expect(screen.getByRole('radio', { name: /Accept/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /Send back/ })).toBeChecked();
    expect(screen.getByText('Accepting needs an approved document')).toBeInTheDocument();
    expect(screen.getByText(/Available once the file is approved/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Approve it in the Review Queue' }));
    expect(onOpenQueueItem).toHaveBeenCalledWith('q_1');
  });

  it('enables Accept once a document is linked, and accepts the open claim only', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog(
      arrival({
        pipeline_state: 'document_linked',
        document_id: 'doc_1',
        document_title: 'Allergen Statement 2026',
        documents: [{ id: 'doc_1', title: 'Allergen Statement 2026' }],
      }),
    );

    expect(screen.getByRole('radio', { name: /Accept/ })).toBeEnabled();
    expect(screen.getByRole('radio', { name: /Accept/ })).toBeChecked();
    // Pre-ticked: the open supplier claim, not the one already accepted.
    expect(screen.getByRole('checkbox', { name: 'Allergen Statement' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Kosher Letter' })).not.toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Accept 1 requirement' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toEqual({
      decisions: [{ line_id: 'line_1', decision: 'accepted' }],
    });
  });

  it('keeps the supplier-facing reason and the internal note in their own fields', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog(arrival());

    await user.type(
      screen.getByLabelText(/What the supplier needs to fix/),
      'This is the 2023 statement.',
    );
    await user.type(screen.getByLabelText(/Internal note/), 'Third time');
    await user.click(screen.getByRole('button', { name: 'Send 1 requirement back' }));

    expect(onSubmit.mock.calls[0][0]).toEqual({
      decisions: [
        {
          line_id: 'line_1',
          decision: 'needs_attention',
          attention_reason: 'This is the 2023 statement.',
          status_note: 'Third time',
        },
      ],
    });
  });

  it('can add a requirement the supplier did not tick', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog(arrival());

    await user.click(screen.getByLabelText('Add a requirement this file also covers'));
    await user.click(await screen.findByRole('option', { name: 'Organic Certificate' }));
    expect(screen.getByRole('checkbox', { name: 'Organic Certificate' })).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Send 2 requirements back' }));
    const lineIds = onSubmit.mock.calls[0][0].decisions.map((d: { line_id: string }) => d.line_id);
    expect(lineIds).toEqual(['line_1', 'line_3']);
  });
});
