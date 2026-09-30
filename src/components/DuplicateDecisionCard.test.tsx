/**
 * DuplicateDecisionCard (migration 0132) -- the words and the order the owner
 * asked for: "You already have this: <title>, <supplier>, approved <date>",
 * why it matched, then Replace existing (becomes vN+1) [default] · Keep as a
 * new document · Discard, with "v1–vN stay in version history" under Replace.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { DuplicateDecisionCard } from './DuplicateDecisionCard';
import type { DuplicateProposal } from '../../shared/types';

const proposal: DuplicateProposal = {
  basis: 'document_number',
  reason: 'Same supplier and document type, and the same document number (SPEC114), in a different file: a newer revision.',
  matched_value: 'SPEC114',
  document_id: 'doc_1',
  document_title: 'Butter spec',
  supplier_name: 'Darigold Inc',
  document_type_name: 'Specification Sheet',
  approved_at: '2026-09-01T12:00:00Z',
  current_version: 2,
  next_version: 3,
  documents: [{ id: 'doc_1', title: 'Butter spec', current_version: 2, lot_keys: [] }],
  intake_duplicate_id: null,
};

function renderCard(over: Partial<Parameters<typeof DuplicateDecisionCard>[0]> = {}) {
  const onChange = vi.fn();
  const onDiscard = vi.fn();
  render(
    <MemoryRouter>
      <DuplicateDecisionCard proposal={proposal} value="replace" onChange={onChange} onDiscard={onDiscard} {...over} />
    </MemoryRouter>,
  );
  return { onChange, onDiscard };
}

describe('DuplicateDecisionCard', () => {
  it('names what we already have, why, and offers the three choices in order', () => {
    renderCard();
    expect(screen.getByText(/You already have this:/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Butter spec' }).getAttribute('href')).toBe('/documents/doc_1');
    expect(screen.getByText(/Darigold Inc/)).toBeTruthy();
    expect(screen.getByText(/same document number \(SPEC114\)/)).toBeTruthy();
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    expect(buttons).toEqual(['Replace existing (becomes v3)', 'Keep as a new document', 'Discard']);
    expect(screen.getByText('v1–v2 stay in version history')).toBeTruthy();
    expect(screen.getByTestId('duplicate-replace').getAttribute('aria-pressed')).toBe('true');
  });

  it('reports the choice, and Discard as its own action', async () => {
    const { onChange, onDiscard } = renderCard();
    await userEvent.click(screen.getByTestId('duplicate-keep'));
    expect(onChange).toHaveBeenCalledWith('keep_both');
    await userEvent.click(screen.getByTestId('duplicate-discard'));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('disables Replace with the reason when it cannot apply', () => {
    renderCard({ replaceDisabledReason: 'This approval makes one document per product.' });
    expect((screen.getByTestId('duplicate-replace') as HTMLButtonElement).disabled).toBe(true);
  });
});
