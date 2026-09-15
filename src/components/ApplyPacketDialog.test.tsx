/**
 * ApplyPacketDialog — the apply button only exists behind a preview of the
 * exact packet and options on screen, and a person's differing tier is shown
 * as kept.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const packets = vi.fn();
const applyPacket = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    supplierRequirements: {
      packets: (...a: unknown[]) => packets(...a),
      applyPacket: (...a: unknown[]) => applyPacket(...a),
    },
  },
}));

import ApplyPacketDialog, { describePacketLine } from './ApplyPacketDialog';
import type { BulkApplyPacketResponse } from '../../shared/types';

const PREVIEW: BulkApplyPacketResponse = {
  dry_run: true,
  pack: 'fsqa',
  packet: 'ingredient-supplier',
  packet_name: 'Ingredient Supplier',
  unknown_requirements: [],
  totals: { add: 1, adopt_unconfirmed: 1, already_present: 1, remove_unconfirmed: 0 },
  suppliers: [
    {
      supplier_id: 'sup_a',
      supplier_name: 'Alpha Dairy',
      counts: { add: 1, adopt_unconfirmed: 1, already_present: 1, remove_unconfirmed: 0, tier_kept_different: 1 },
      lines: [
        { requirement_id: 'r1', requirement_slug: 'micro-limits', requirement_name: 'Microbiological Limits', action: 'add', tier: 'required', from_tier: null, packet_tier: 'required', existing_source: null },
        { requirement_id: 'r2', requirement_slug: 'haccp-plan', requirement_name: 'HACCP Plan on file', action: 'adopt_unconfirmed', tier: 'required', from_tier: 'recommended', packet_tier: 'required', existing_source: null },
        { requirement_id: 'r3', requirement_slug: 'spec-sheet', requirement_name: 'Specification Sheet on file', action: 'already_present', tier: 'recommended', from_tier: 'recommended', packet_tier: 'required', existing_source: 'human' },
      ],
    },
  ],
};

beforeEach(() => {
  packets.mockReset();
  applyPacket.mockReset();
  packets.mockResolvedValue({
    pack: 'fsqa',
    pack_label: 'FSQA',
    packets: [
      { slug: 'baseline', name: 'Approved Supplier Baseline', description: null, requirements: ['a'], recommends: [] },
      { slug: 'ingredient-supplier', name: 'Ingredient Supplier', description: 'Food ingredients', requirements: ['b', 'c'], recommends: ['d'] },
    ],
  });
});

describe('ApplyPacketDialog', () => {
  it('previews first, then applies exactly what was previewed', async () => {
    const user = userEvent.setup();
    const onApplied = vi.fn();
    applyPacket.mockResolvedValueOnce(PREVIEW).mockResolvedValueOnce({ ...PREVIEW, dry_run: false });
    render(
      <ApplyPacketDialog open onClose={() => {}} suppliers={[{ id: 'sup_a', name: 'Alpha Dairy' }]} onApplied={onApplied} />,
    );

    await user.click(await screen.findByLabelText(/Ingredient Supplier/));
    const apply = screen.getByRole('button', { name: 'Apply' });
    expect(apply).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(applyPacket).toHaveBeenLastCalledWith(
      expect.objectContaining({ packet: 'ingredient-supplier', supplier_ids: ['sup_a'], dry_run: true, replace_unconfirmed: false }),
    );
    expect(await screen.findByText(/Kept as recommended \(set by a person\); the packet says required/)).toBeInTheDocument();
    expect(screen.getByText(/Unconfirmed row changes recommended → required/)).toBeInTheDocument();

    // Changing an option invalidates the preview.
    await user.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled());

    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    expect(applyPacket).toHaveBeenLastCalledWith(expect.objectContaining({ dry_run: false, packet: 'ingredient-supplier' }));
  });

  it('describes a removal and a matching existing row in words', () => {
    expect(
      describePacketLine({ requirement_id: null, requirement_slug: 'w9', requirement_name: 'W-9', action: 'remove_unconfirmed', tier: 'required', from_tier: 'required', packet_tier: null, existing_source: null }),
    ).toBe('Unconfirmed required row removed — the packet does not name it');
    expect(
      describePacketLine({ requirement_id: null, requirement_slug: 'x', requirement_name: 'X', action: 'already_present', tier: 'required', from_tier: 'required', packet_tier: 'required', existing_source: 'derived' }),
    ).toBe('Already required, from the verified supplier list');
  });
});
