/**
 * Renewal alert lead time UI (migration 0111).
 *
 *   1. The organization panel shows what a change would do BEFORE saving
 *      (the read-only preview), and saves exactly the chosen number.
 *   2. A custom value out of range cannot be saved.
 *   3. The Renewals page defaults its look-ahead to the tenant's lead time,
 *      says the look-ahead is a view filter, and "Send alert now" never sends
 *      the look-ahead to the server.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { RenewalAlertLeadTimeResponse, RenewalLeadTimePreview } from '../../shared/types';

const getLead = vi.fn();
const putLead = vi.fn();
const previewLead = vi.fn();
const listExp = vi.fn();
const notifyExp = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    expirations: {
      list: (...a: unknown[]) => listExp(...a),
      notify: (...a: unknown[]) => notifyExp(...a),
      leadTime: {
        get: (...a: unknown[]) => getLead(...a),
        put: (...a: unknown[]) => putLead(...a),
        preview: (...a: unknown[]) => previewLead(...a),
      },
    },
  },
}));
vi.mock('../contexts/TenantContext', () => ({
  useTenant: () => ({ selectedTenantId: null, tenants: [] }),
}));

import { RenewalLeadTimePanel, describeLeadTimePreview } from './RenewalLeadTime';
import { Expirations } from '../pages/Expirations';

function setting(over: Partial<RenewalAlertLeadTimeResponse> = {}): RenewalAlertLeadTimeResponse {
  return {
    tenant_id: 't1',
    lead_days: null,
    effective: { days: 60, source: 'default' },
    default_lead_days: 60,
    min_lead_days: 7,
    max_lead_days: 365,
    presets: [30, 60, 90],
    updated_at: null,
    updated_by: null,
    updated_by_name: null,
    document_type_overrides: [{ id: 'dt1', name: 'Audit Certificate', lead_days: 120, updated_at: null }],
    ...over,
  };
}

function previewResult(over: Partial<RenewalLeadTimePreview> = {}): RenewalLeadTimePreview {
  return {
    as_of: '2026-09-15',
    scope: 'tenant',
    document_type_id: null,
    proposed_lead_days: 90,
    current_tenant_lead: { days: 60, source: 'default' },
    proposed_tenant_lead: { days: 90, source: 'tenant' },
    current_alerting_count: 2,
    proposed_alerting_count: 5,
    newly_entering_count: 3,
    newly_entering_would_send_count: 2,
    leaving_count: 0,
    lead_changed_count: 12,
    newly_entering: [
      { id: 'a', title: 'Organic Certificate', owner: 'QA', primary_category_name: null, renewal_due_date: '2026-12-01', days_until: 77, status: 'expiring', alert_lead_days: 90, alert_lead_source: 'tenant', current_alert_lead_days: 60, next_run_decision: 'first' },
    ],
    leaving: [],
    ...over,
  };
}

async function pickOption(label: string, optionText: RegExp) {
  fireEvent.mouseDown(screen.getByRole('combobox', { name: label }));
  const listbox = await screen.findByRole('listbox');
  fireEvent.click(within(listbox).getByText(optionText));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('describeLeadTimePreview', () => {
  it('says how many enter, how many are emailed, and how many stay quiet', () => {
    expect(describeLeadTimePreview(previewResult())).toBe(
      'At the next run: 3 documents would newly enter the warning window (2 would be emailed to their owners; 1 already emailed in the last week stay quiet).',
    );
    expect(describeLeadTimePreview(previewResult({ newly_entering_count: 0, newly_entering_would_send_count: 0, leaving_count: 1 }))).toBe(
      'At the next run: 1 document would leave it until it comes closer to due.',
    );
  });
});

describe('RenewalLeadTimePanel', () => {
  it('previews a change before saving, then saves the chosen number', async () => {
    getLead.mockResolvedValue(setting());
    previewLead.mockResolvedValue(previewResult());
    putLead.mockResolvedValue(setting({ lead_days: 90, effective: { days: 90, source: 'tenant' }, updated_at: '2026-09-15 10:00:00', updated_by_name: 'Org Admin' }));

    render(<RenewalLeadTimePanel tenantId="t1" />);
    expect(await screen.findByText(/Audit Certificate \(120 days\)/)).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    await pickOption('Warn owners', /^90 days before$/);
    const note = await screen.findByTestId('lead-time-preview', {}, { timeout: 2000 });
    expect(note).toHaveTextContent('3 documents would newly enter the warning window');
    expect(note).toHaveTextContent('Organic Certificate');
    expect(previewLead).toHaveBeenCalledWith({ leadDays: 90, documentTypeId: undefined, tenantId: 't1' });
    expect(putLead).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putLead).toHaveBeenCalledWith({ lead_days: 90, tenantId: 't1' }));
    expect(await screen.findByText(/Owners are now warned 90 days before/)).toBeInTheDocument();
  });

  it('will not save a custom value outside 7-365', async () => {
    getLead.mockResolvedValue(setting());
    render(<RenewalLeadTimePanel tenantId="t1" />);
    await screen.findByText(/Audit Certificate/);

    await pickOption('Warn owners', /Custom/);
    const box = screen.getByLabelText('Days before due');
    fireEvent.change(box, { target: { value: '400' } });
    expect(await screen.findByText(/A whole number from 7 to 365/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.change(box, { target: { value: '45' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
  });
});

describe('Renewals page look-ahead', () => {
  it('defaults to the tenant lead time, calls itself a view filter, and never sends it with Send alert now', async () => {
    const row = {
      id: 'd1', title: 'Plant Licence', primary_category_name: null, owner: 'QA', renewal_type: 'hard_expiry',
      renewal_due_date: '2026-10-01', status: 'expiring', days_until: 16,
      alert_lead_days: 90, alert_lead_source: 'document_type', alert_status: 'expiring',
    };
    // Mailed under its type's 120 days, but Current in a 45-day view.
    const farRow = {
      ...row, id: 'd2', title: 'Audit Certificate', days_until: 100, renewal_due_date: '2026-12-24',
      status: 'current', alert_status: 'expiring', alert_lead_days: 120,
    };
    listExp.mockResolvedValue({
      rows: [row, farRow],
      summary: { total: 1, alerting: 1, by_status: { current: 0, expiring: 1, expired: 0, overdue: 0, stale: 0 }, by_renewal_type: {} },
      window_days: 45,
      as_of: '2026-09-15',
      tenant_lead: { days: 45, source: 'tenant' },
    });
    notifyExp.mockResolvedValue({ sent: false, recipients: [], document_count: 0, alerting_count: 1, suppressed_count: 1, groups: [], unrouted: { count: 0, owner_labels: [], documents: [], notified: [], notice_sent: false }, tenant_lead: { days: 45, source: 'tenant' }, reason: 'all_suppressed' });

    render(
      <MemoryRouter>
        <Expirations />
      </MemoryRouter>,
    );

    const note = await screen.findByTestId('lead-time-note');
    expect(note).toHaveTextContent('The look-ahead only changes this view');
    expect(note).toHaveTextContent('Owners are emailed 45 days before');
    expect(listExp).toHaveBeenCalledWith({ tenantId: undefined, windowDays: undefined });
    expect(screen.getByRole('combobox', { name: /Look-ahead/ })).toHaveTextContent('45 days (alert lead time)');
    expect(screen.getByText(/warned 90d ahead \(type\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /All tracked/ }));
    expect(await screen.findByTestId('in-warning-window')).toHaveTextContent('owner being warned');

    fireEvent.click(screen.getByRole('button', { name: /Send alert now/ }));
    await waitFor(() => expect(notifyExp).toHaveBeenCalledTimes(1));
    expect(notifyExp.mock.calls[0][0]).toEqual({ tenantId: undefined });
  });
});
