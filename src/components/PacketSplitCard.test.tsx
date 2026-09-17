/**
 * PacketSplitCard — the question a reviewer answers before reading any field.
 *
 *   1. It ASKS, in words, and says how sure it is. Nothing happens on render.
 *   2. Each of the three actions does exactly one thing and nothing else.
 *   3. "Adjust" edits the ranges before confirming, and the confirmed ranges
 *      are the edited ones — that is the difference between this and a
 *      take-it-or-leave-it split.
 *   4. Once a file is split its card stops asking and shows what it became,
 *      including that the container itself is not approved.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { QueuePacketView } from '../../shared/types';

const packet = vi.fn();
const packetSplit = vi.fn();
const packetDismiss = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    queue: {
      packet: (...args: unknown[]) => packet(...args),
      packetSplit: (...args: unknown[]) => packetSplit(...args),
      packetDismiss: (...args: unknown[]) => packetDismiss(...args),
    },
  },
}));

import { PacketSplitCard, PacketChip } from './PacketSplitCard';

function view(over: Partial<QueuePacketView> = {}): QueuePacketView {
  return {
    queue_id: 'q1',
    proposal: {
      looksLikePacket: true,
      confidence: 0.95,
      confidence_band: 'high',
      method: 'index',
      page_count: 6,
      declined: null,
      uncovered_pages: [6],
      notes: ['Page 2 lists 3 documents with page numbers — the file says what is in it.'],
      parts: [
        { pages: [1, 2], label: null, evidence: 'front matter', preview: 'Cover letter' },
        { pages: [3, 3], label: 'Letter of Guarantee', evidence: 'index entry 1', preview: 'LETTER OF GUARANTEE' },
        { pages: [4, 5], label: 'Allergen Statement', evidence: 'index entry 2', preview: 'ALLERGEN STATEMENT' },
      ],
    },
    dismissed_at: null,
    split_at: null,
    split_method: null,
    part_count: null,
    parent: null,
    part_of_pages: null,
    part_index: null,
    part_label: null,
    children: [],
    ...over,
  };
}

beforeEach(() => {
  packet.mockReset();
  packetSplit.mockReset();
  packetDismiss.mockReset();
  packetSplit.mockResolvedValue({ parent_id: 'q1', method: 'index', children: [] });
  packetDismiss.mockResolvedValue({ dismissed: true });
});

describe('it asks, and nothing happens on its own', () => {
  it('names the count, the confidence and every proposed range', async () => {
    packet.mockResolvedValue(view());
    render(<PacketSplitCard queueId="q1" />);

    expect(await screen.findByText(/This looks like 3 documents in one file/)).toBeTruthy();
    expect(screen.getByText(/high confidence/)).toBeTruthy();
    expect(screen.getByText(/Read off the file's own index page\./)).toBeTruthy();
    const table = screen.getByTestId('packet-parts');
    expect(within(table).getByText('pages 1-2')).toBeTruthy();
    expect(within(table).getByText('page 3')).toBeTruthy();
    expect(within(table).getByText('Letter of Guarantee')).toBeTruthy();
    // ...and a page no part covers is said out loud rather than absorbed.
    expect(screen.getByText(/would be in no part/)).toBeTruthy();
    expect(packetSplit).not.toHaveBeenCalled();
    expect(packetDismiss).not.toHaveBeenCalled();
  });

  it('a low-confidence layout proposal says so instead of looking decisive', async () => {
    packet.mockResolvedValue(
      view({
        proposal: {
          ...view().proposal!,
          method: 'heuristic',
          confidence: 0.3,
          confidence_band: 'low',
          notes: ['No index page, and the layout signals disagree.'],
        },
      }),
    );
    render(<PacketSplitCard queueId="q1" />);
    expect(await screen.findByText(/coarse/)).toBeTruthy();
    expect(screen.getByText(/low confidence/)).toBeTruthy();
  });

  it('says nothing at all when there is nothing to ask', async () => {
    packet.mockResolvedValue(view({ proposal: null }));
    const { container } = render(<PacketSplitCard queueId="q1" />);
    await waitFor(() => expect(packet).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="packet-proposal"]')).toBeNull();
  });

  it('a dismissed file is not asked about again', async () => {
    packet.mockResolvedValue(view({ dismissed_at: '2026-09-17 10:00:00' }));
    render(<PacketSplitCard queueId="q1" />);
    expect(await screen.findByTestId('packet-dismissed-note')).toBeTruthy();
    expect(screen.queryByTestId('packet-proposal')).toBeNull();
  });
});

describe('the three actions', () => {
  it('Split confirms the proposal as it stands — no ranges sent', async () => {
    packet.mockResolvedValue(view());
    const onSplit = vi.fn();
    render(<PacketSplitCard queueId="q1" onSplit={onSplit} />);
    await userEvent.click(await screen.findByRole('button', { name: /Split into 3 documents/ }));
    await waitFor(() => expect(packetSplit).toHaveBeenCalledWith('q1', undefined));
    expect(onSplit).toHaveBeenCalled();
  });

  it('Adjust merges two parts, and the confirmed ranges are the EDITED ones', async () => {
    packet.mockResolvedValue(view());
    render(<PacketSplitCard queueId="q1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Adjust' }));
    await userEvent.click(screen.getByRole('button', { name: /merge part 2 into the one above/ }));
    await userEvent.click(screen.getByRole('button', { name: /Split into 2 documents/ }));
    await waitFor(() => expect(packetSplit).toHaveBeenCalled());
    expect(packetSplit.mock.calls[0][1]).toEqual([
      { pages: [1, 3], label: null },
      { pages: [4, 5], label: 'Allergen Statement' },
    ]);
  });

  it('Adjust drops a part, and the dropped pages are simply not asked for', async () => {
    packet.mockResolvedValue(view());
    render(<PacketSplitCard queueId="q1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Adjust' }));
    await userEvent.click(screen.getByRole('button', { name: /drop part 1/ }));
    await userEvent.click(screen.getByRole('button', { name: /Split into 2 documents/ }));
    await waitFor(() => expect(packetSplit).toHaveBeenCalled());
    expect(packetSplit.mock.calls[0][1]).toEqual([
      { pages: [3, 3], label: 'Letter of Guarantee' },
      { pages: [4, 5], label: 'Allergen Statement' },
    ]);
  });

  it('"Back to the proposal" throws the edit away without splitting anything', async () => {
    packet.mockResolvedValue(view());
    render(<PacketSplitCard queueId="q1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Adjust' }));
    await userEvent.click(screen.getByRole('button', { name: /drop part 1/ }));
    await userEvent.click(screen.getByRole('button', { name: /Back to the proposal/ }));
    expect(screen.getByRole('button', { name: /Split into 3 documents/ })).toBeTruthy();
    expect(packetSplit).not.toHaveBeenCalled();
  });

  it('"Not a packet" dismisses and splits nothing', async () => {
    packet.mockResolvedValue(view());
    render(<PacketSplitCard queueId="q1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Not a packet' }));
    await waitFor(() => expect(packetDismiss).toHaveBeenCalledWith('q1'));
    expect(packetSplit).not.toHaveBeenCalled();
  });

  it('a failed split says why and leaves the card asking', async () => {
    packet.mockResolvedValue(view());
    packetSplit.mockRejectedValue(new Error('Part 2 could not be cut out of the PDF'));
    render(<PacketSplitCard queueId="q1" />);
    await userEvent.click(await screen.findByRole('button', { name: /Split into 3 documents/ }));
    expect(await screen.findByText(/could not be cut out/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Split into 3 documents/ })).toBeTruthy();
  });
});

describe('after the split', () => {
  it('the container says it is not itself approved, and lists its parts', async () => {
    packet.mockResolvedValue(
      view({
        split_at: '2026-09-17 10:00:00',
        split_method: 'index',
        part_count: 3,
        children: [
          { id: 'c1', file_name: 'a.pdf', pages: [1, 2], part_index: 0, label: null, status: 'pending', processing_status: 'queued', document_type_id: null, document_type_name: null },
          { id: 'c2', file_name: 'b.pdf', pages: [3, 3], part_index: 1, label: 'Letter of Guarantee', status: 'approved', processing_status: 'ready', document_type_id: 'dt1', document_type_name: 'Letter of Guarantee' },
          { id: 'c3', file_name: 'c.pdf', pages: [4, 5], part_index: 2, label: 'Allergen Statement', status: 'pending', processing_status: 'ready', document_type_id: null, document_type_name: null },
        ],
      }),
    );
    render(<PacketSplitCard queueId="q1" />);
    const note = await screen.findByTestId('packet-container-note');
    expect(within(note).getByText(/Split into 3 documents — this file is not itself approved/)).toBeTruthy();
    expect(within(note).getByText(/1 of 3 decided so far/)).toBeTruthy();
    expect(within(note).getByText('pages 4-5')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Split into/ })).toBeNull();
  });

  it('a PART says which file and which pages it came from, and that its siblings are unaffected', async () => {
    packet.mockResolvedValue(
      view({
        proposal: null,
        parent: { id: 'q0', file_name: 'packet-fdlw-2026.pdf' },
        part_of_pages: [4, 5],
        part_index: 2,
        part_label: 'Allergen Statement',
      }),
    );
    render(<PacketSplitCard queueId="q1" />);
    const note = await screen.findByTestId('packet-part-note');
    expect(within(note).getByText(/pages 4-5 of/)).toBeTruthy();
    expect(within(note).getByText('packet-fdlw-2026.pdf')).toBeTruthy();
    // The index's label is offered as a hint and explicitly not as a verdict.
    expect(within(note).getByText(/hint, not a classification/)).toBeTruthy();
    expect(within(note).getByText(/does not affect the others/)).toBeTruthy();
  });
});

describe('PacketChip — the one-glance signal on the collapsed row', () => {
  it('says how many documents a waiting file looks like', () => {
    render(<PacketChip item={{ packet_proposal: JSON.stringify(view().proposal) }} />);
    expect(screen.getByText('Looks like 3 documents')).toBeTruthy();
  });

  it('says nothing on an ordinary upload, or on one already called not-a-packet', () => {
    const { container, rerender } = render(<PacketChip item={{}} />);
    expect(container.textContent).toBe('');
    rerender(
      <PacketChip
        item={{ packet_proposal: JSON.stringify(view().proposal), packet_dismissed_at: '2026-09-17 10:00:00' }}
      />,
    );
    expect(container.textContent).toBe('');
  });

  it('marks a container and a part differently', () => {
    const { rerender } = render(<PacketChip item={{ packet_split_at: 'x', packet_part_count: 26 }} />);
    expect(screen.getByText('Split into 26')).toBeTruthy();
    rerender(<PacketChip item={{ packet_parent_id: 'q0', packet_pages: '[17,18]' }} />);
    expect(screen.getByText('Part · pages 17-18')).toBeTruthy();
  });

  it('an unparseable proposal column costs the row nothing', () => {
    const { container } = render(<PacketChip item={{ packet_proposal: '{not json' }} />);
    expect(container.textContent).toBe('');
  });
});
