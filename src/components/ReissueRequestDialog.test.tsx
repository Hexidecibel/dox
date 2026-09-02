/**
 * ReissueRequestDialog — the counterpart to AmendRequestDialog, tested for the
 * things that keep the two apart.
 *
 * A re-issue starts a NEW ask at version 1 on its own root, resets line
 * progress and lands as a draft; the source is not touched. The deadline
 * therefore starts BLANK rather than inheriting the old one — a renewal that
 * silently carried last year's date would be issued overdue.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReissueRequestDialog } from './ReissueRequestDialog';
import type { DocumentRequestDetail } from '../lib/types';

const REQUEST = {
  id: 'req_1',
  supplier_id: 'sup_1',
  version: 1,
  title: 'Annual approval packet',
  intro: 'Ahead of your review.',
  due_date: '2025-10-01',
  assigned_to: null,
  status: 'closed',
  supplier_name: 'Country Morning Farms',
  assigned_to_name: null,
  lines: [],
  counts: {
    total: 3,
    typed: 3,
    free_text: 0,
    required: 3,
    recommended: 0,
    by_status: {
      not_started: 0,
      received: 0,
      under_review: 0,
      accepted: 3,
      needs_attention: 0,
    },
  },
  routing: null,
  history: [],
} as unknown as DocumentRequestDetail;

const SUPPLIERS = [
  { id: 'sup_1', name: 'Country Morning Farms' },
  { id: 'sup_2', name: 'Cascade Dairy' },
];

function renderDialog(onSubmit = vi.fn().mockResolvedValue(undefined)) {
  render(
    <ReissueRequestDialog
      open
      request={REQUEST}
      suppliers={SUPPLIERS}
      assignees={[]}
      onClose={() => {}}
      onSubmit={onSubmit}
    />,
  );
  return onSubmit;
}

describe('ReissueRequestDialog', () => {
  it('says plainly that this is a new ask, not a correction', () => {
    renderDialog();
    expect(screen.getByText('This is a new ask, not a correction')).toBeInTheDocument();
    // And names the other operation, so the wrong one is a decision rather
    // than an accident.
    expect(screen.getByText('Amend')).toBeInTheDocument();
  });

  it('produces a draft, and says so on the button', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Create draft' })).toBeInTheDocument();
  });

  it('starts the deadline blank rather than inheriting last year’s', () => {
    renderDialog();
    expect(screen.getByLabelText('Deadline')).toHaveValue('');
  });

  it('submits the same supplier by default — the common case is a renewal', async () => {
    const user = userEvent.setup();
    const onSubmit = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ supplier_id: 'sup_1', title: 'Annual approval packet' }),
    );
  });
});
