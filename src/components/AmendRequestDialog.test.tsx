/**
 * AmendRequestDialog — the two things that make an amendment an amendment.
 *
 *   1. A stated reason is mandatory. `amendRequest` refuses one without, and a
 *      dialog that let the request go and surfaced the 400 afterwards would
 *      teach people that the field is decorative.
 *   2. `lines` is OMITTED unless somebody explicitly asks to change what is
 *      being asked for. The server reads an absent `lines` as "keep the
 *      previous composition verbatim" and a present one as a wholesale
 *      replacement — so sending the current set back unchanged would look
 *      identical and would not be.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AmendRequestDialog } from './AmendRequestDialog';
import type { DocumentRequestDetail } from '../lib/types';

const REQUEST = {
  id: 'req_1',
  tenant_id: 't1',
  supplier_id: 'sup_1',
  root_request_id: 'req_1',
  version: 2,
  supersedes_id: null,
  superseded_at: null,
  amendment_reason: null,
  reissue_of_request_id: null,
  origin: 'manual',
  origin_ref: null,
  title: 'Annual approval packet',
  intro: null,
  due_date: '2026-10-01',
  assigned_to: null,
  status: 'issued',
  issued_at: '2026-09-01 10:00:00',
  closed_at: null,
  cancelled_at: null,
  created_at: '2026-09-01 09:00:00',
  created_by: 'u1',
  updated_at: '2026-09-01 10:00:00',
  updated_by: 'u1',
  supplier_name: 'Country Morning Farms',
  assigned_to_name: null,
  lines: [
    {
      id: 'line_1',
      tenant_id: 't1',
      request_id: 'req_1',
      line_kind: 'requirement',
      requirement_id: 'req_a',
      name: 'Allergen Matrix',
      explanation: null,
      acceptable_formats: null,
      criteria: null,
      owner: null,
      tier: 'required',
      status: 'under_review',
      status_note: null,
      status_changed_at: null,
      status_changed_by: null,
      sort_order: 0,
      created_at: '',
      created_by: null,
      updated_at: '',
      updated_by: null,
      requirement_name: 'Allergen Matrix',
      requirement_slug: 'allergen-matrix',
      requirement_checklist: 'SOP 102.2',
      closure: [],
    },
  ],
  counts: {
    total: 1,
    typed: 1,
    free_text: 0,
    required: 1,
    recommended: 0,
    by_status: {
      not_started: 0,
      received: 0,
      under_review: 1,
      accepted: 0,
      needs_attention: 0,
    },
  },
  routing: null,
  history: [],
} as unknown as DocumentRequestDetail;

function renderDialog(onSubmit = vi.fn().mockResolvedValue(undefined)) {
  render(
    <AmendRequestDialog
      open
      request={REQUEST}
      vocab={[{ id: 'req_a', name: 'Allergen Matrix', checklist: 'SOP 102.2' }]}
      assignees={[]}
      onClose={() => {}}
      onSubmit={onSubmit}
    />,
  );
  return onSubmit;
}

describe('AmendRequestDialog', () => {
  it('says this replaces the version the supplier is holding, and names the next one', () => {
    renderDialog();
    expect(screen.getByText('This replaces what the supplier is holding')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Issue version 3' })).toBeInTheDocument();
  });

  it('points at re-issue for the other operation rather than blurring them', () => {
    renderDialog();
    expect(screen.getByText(/Re-issue/)).toBeInTheDocument();
  });

  it('refuses to submit without a stated reason', async () => {
    const user = userEvent.setup();
    const onSubmit = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Issue version 3' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/Say what changed/)).toBeInTheDocument();
  });

  it('omits `lines` when only the header changed — the due-date amendment', async () => {
    const user = userEvent.setup();
    const onSubmit = renderDialog();
    await user.type(screen.getByLabelText(/What changed, and why/), 'Deadline moved');
    await user.click(screen.getByRole('button', { name: 'Issue version 3' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const body = onSubmit.mock.calls[0][0];
    expect(body.amendment_reason).toBe('Deadline moved');
    // The distinction the server actually reads: absent, not an identical copy.
    expect('lines' in body).toBe(false);
  });

  it('sends the whole line set only when the composition is deliberately changed', async () => {
    const user = userEvent.setup();
    const onSubmit = renderDialog();
    await user.type(screen.getByLabelText(/What changed, and why/), 'Adding the LOG');
    await user.click(screen.getByRole('checkbox', { name: 'Also change what is being asked for' }));
    await user.click(screen.getByRole('button', { name: 'Issue version 3' }));

    const body = onSubmit.mock.calls[0][0];
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]).toMatchObject({
      line_kind: 'requirement',
      requirement_id: 'req_a',
    });
  });
});
