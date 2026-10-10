/**
 * Settings > Starter pack.
 *
 * What the screen must get right is small and specific:
 *   - it says which version the organisation is on and which is available;
 *   - a preview is a DRY RUN, and nothing is written until Apply;
 *   - a kept value shows BOTH values, and only a tick sends it in `accept`;
 *   - an organisation with no record is told so instead of being shown "v1";
 *   - a row somebody edited between preview and apply is reported, not hidden.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PackRollForwardResponse, TenantPackStatusResponse } from '../../lib/types';

const status = vi.fn();
const rollForward = vi.fn();

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'org_admin', tenant_id: 't1' } }),
}));
vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ selectedTenantId: 't1' }),
}));
vi.mock('../../lib/api', () => ({
  api: {
    starterPacks: {
      status: (...args: unknown[]) => status(...args),
      rollForward: (...args: unknown[]) => rollForward(...args),
    },
  },
}));

import { StarterPackSettings, fieldLabel, showValue } from './StarterPackSettings';

const ON_V1: TenantPackStatusResponse = {
  tenant_id: 't1',
  not_ledgered: null,
  packs: [
    {
      pack: 'fsqa',
      label: 'Food Safety & Quality Assurance',
      version: 1,
      available_version: 2,
      update_available: true,
      applied_at: '2026-10-01 10:00:00',
      applied_by_name: 'Pat Admin',
      source: 'apply',
      history: [],
    },
  ],
};

const SUMMARY = {
  inserted: 1,
  adopted: 0,
  updated: 1,
  fields_updated: 1,
  kept: 1,
  needs_person: 1,
  conflicts: 1,
  parent_missing: 0,
  gone: 1,
  removed_from_pack: 1,
  customised: 0,
  unchanged: 100,
  writes: 5,
};

function plan(over: Partial<PackRollForwardResponse> = {}): PackRollForwardResponse {
  return {
    dry_run: true,
    tenant_id: 't1',
    pack: 'fsqa',
    label: 'Food Safety & Quality Assurance',
    from_version: 1,
    to_version: 2,
    ledgered: true,
    up_to_date: false,
    summary: SUMMARY,
    not_applied: [],
    items: [
      {
        kind: 'requirement',
        key: 'pack-size',
        label: 'Pack Size',
        noun: 'requirement',
        row_id: 'r1',
        outcome: 'update',
        news: true,
        fields: [{ field: 'description', action: 'update', reason: 'pack_wrote', base: 'old', current: 'old', target: 'new wording' }],
      },
      {
        kind: 'requirement',
        key: 'gtin',
        label: 'GTIN / UPC',
        noun: 'requirement',
        row_id: 'r2',
        outcome: 'keep',
        news: true,
        fields: [{ field: 'description', action: 'keep', reason: 'edited', base: 'pack v1 text', current: 'OUR wording', target: 'pack v2 text' }],
      },
      {
        kind: 'document_type',
        key: 'process-flow-diagram',
        label: 'Process Flow Diagram',
        noun: 'document type',
        row_id: 'd1',
        outcome: 'keep',
        news: true,
        fields: [{ field: 'sharing_rule', action: 'needs_person', reason: 'loosens', base: 'qa', current: 'qa', target: 'free' }],
      },
      { kind: 'requirement', key: 'questionnaire', label: 'Supplier Questionnaire', noun: 'requirement', row_id: null, outcome: 'insert', news: true, fields: [] },
      {
        kind: 'requirement',
        key: 'lot-code-key',
        label: 'Lot Coding Explanation',
        noun: 'requirement',
        row_id: null,
        outcome: 'conflict',
        news: true,
        fields: [],
        conflict: { id: 'x', name: 'Lot Code Key', slug: 'our-lot-code-key', active: true },
      },
      { kind: 'requirement', key: 'shelf-life', label: 'Shelf Life', noun: 'requirement', row_id: 'r9', outcome: 'inactive', news: true, fields: [] },
      { kind: 'claim_type', key: 'made-in-usa', label: 'Made in USA', noun: 'claim', row_id: 'c1', outcome: 'removed_from_pack', news: true, fields: [] },
      { kind: 'document_type', key: 'business-license', label: 'Business License', noun: 'document type', row_id: null, outcome: 'absent', news: false, fields: [] },
    ],
    ...over,
  };
}

beforeEach(() => {
  status.mockReset();
  rollForward.mockReset();
});

describe('StarterPackSettings', () => {
  it('says which version the organisation is on and which is available', async () => {
    status.mockResolvedValue(ON_V1);
    render(<StarterPackSettings />);
    expect(
      await screen.findByText('This organisation is on Food Safety & Quality Assurance version 1'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Version 2 is available\./)).toBeInTheDocument();
    expect(rollForward).not.toHaveBeenCalled();
  });

  it('previews as a dry run, groups by outcome, and shows both values for a kept one', async () => {
    status.mockResolvedValue(ON_V1);
    rollForward.mockResolvedValue(plan());
    render(<StarterPackSettings />);
    await userEvent.click(await screen.findByRole('button', { name: 'Preview version 2' }));

    await waitFor(() => expect(rollForward).toHaveBeenCalledWith({ tenantId: 't1', pack: 'fsqa', dryRun: true }));
    expect(await screen.findByText('This is a preview. Nothing has been changed.')).toBeInTheDocument();

    const updates = within(screen.getByTestId('group-update'));
    expect(updates.getByText('Pack Size')).toBeInTheDocument();
    expect(updates.getByText('new wording')).toBeInTheDocument();

    const kept = within(screen.getByTestId('group-keep'));
    expect(kept.getByText('OUR wording')).toBeInTheDocument();
    expect(kept.getByText('pack v2 text')).toBeInTheDocument();
    expect(kept.getByText(/The pack had written: pack v1 text/)).toBeInTheDocument();

    expect(within(screen.getByTestId('group-needs-person')).getByText('Process Flow Diagram')).toBeInTheDocument();
    expect(within(screen.getByTestId('group-insert')).getByText('Supplier Questionnaire')).toBeInTheDocument();
    expect(within(screen.getByTestId('group-conflict')).getByText(/You have "Lot Code Key" \(our-lot-code-key\)/)).toBeInTheDocument();
    expect(within(screen.getByTestId('group-inactive')).getByText('Shelf Life')).toBeInTheDocument();
    // Something the organisation does not have is offered, never added unasked.
    const gone = within(screen.getByTestId('group-gone'));
    expect(gone.getByText('Business License')).toBeInTheDocument();
    expect(gone.getByRole('checkbox', { name: 'Add Business License' })).not.toBeChecked();
    expect(within(screen.getByTestId('group-removed')).getByText('Made in USA')).toBeInTheDocument();
  });

  it('sends only what was ticked in accept, and only on Apply', async () => {
    status.mockResolvedValue(ON_V1);
    rollForward.mockResolvedValueOnce(plan());
    render(<StarterPackSettings />);
    await userEvent.click(await screen.findByRole('button', { name: 'Preview version 2' }));
    await screen.findByTestId('group-keep');

    await userEvent.click(screen.getByRole('checkbox', { name: "Use the pack's Description for GTIN / UPC" }));
    expect(rollForward).toHaveBeenCalledTimes(1);

    rollForward.mockResolvedValueOnce(
      plan({
        dry_run: false,
        not_applied: [{ kind: 'requirement', key: 'pack-size', label: 'Pack Size', reason: 'changed_since_preview' }],
      }),
    );
    status.mockResolvedValue({ ...ON_V1, packs: [{ ...ON_V1.packs[0], version: 2, update_available: false }] });
    await userEvent.click(screen.getByRole('button', { name: 'Apply version 2' }));

    await waitFor(() =>
      expect(rollForward).toHaveBeenLastCalledWith({
        tenantId: 't1',
        pack: 'fsqa',
        dryRun: false,
        accept: [{ kind: 'requirement', key: 'gtin', field: 'description' }],
      }),
    );
    const done = within(await screen.findByTestId('pack-applied'));
    expect(done.getByText('Now on Food Safety & Quality Assurance version 2')).toBeInTheDocument();
    // An edit made in between is said, not swallowed.
    expect(done.getByText(/somebody changed it after the preview/)).toBeInTheDocument();
    expect(await screen.findByText(/It is on the latest version\./)).toBeInTheDocument();
  });

  it('tells an organisation with no record what that means', async () => {
    status.mockResolvedValue({ tenant_id: 't1', packs: [], not_ledgered: { pack: 'fsqa' } });
    render(<StarterPackSettings />);
    const notice = within(await screen.findByTestId('pack-not-ledgered'));
    expect(notice.getByText('This organisation has no starter-pack record')).toBeInTheDocument();
    expect(notice.getByText(/its setup chose the "fsqa" pack/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Preview/ })).not.toBeInTheDocument();
  });

  it('says an empty value is empty and names columns in words', () => {
    expect(showValue(null)).toBe('(empty)');
    expect(showValue('')).toBe('(empty)');
    expect(showValue(0)).toBe('0');
    expect(fieldLabel('sharing_rule')).toBe('Sharing rule');
    expect(fieldLabel('some_new_column')).toBe('some_new_column');
  });
});
