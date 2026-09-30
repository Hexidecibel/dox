/**
 * Rules table F6 on the review card: the warning is shown in words, and
 * "Reject as sales sheet" opens the reject dialog with the preset reason
 * already chosen (still changeable). Without the banner the dialog opens on
 * nothing, as before.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SalesSheetWarningBanner } from './SalesSheetWarningBanner';
import RejectQueueItemDialog from './RejectQueueItemDialog';

const warning = {
  likely_sales_sheet: true as const,
  marketing_evidence: ['Typical values are for information only and are not specifications'],
  message: 'This may be a sales sheet, not a specification: it carries no revision, issue or effective date.',
};

describe('SalesSheetWarningBanner', () => {
  it('renders nothing without a warning', () => {
    const { container } = render(<SalesSheetWarningBanner warning={null} />);
    expect(container.textContent).toBe('');
  });

  it('says what it saw and offers the one-click reject', async () => {
    const onReject = vi.fn();
    render(<SalesSheetWarningBanner warning={warning} onRejectAsSalesSheet={onReject} />);
    expect(screen.getByTestId('sales-sheet-warning').textContent).toContain('no revision, issue or effective date');
    await userEvent.click(screen.getByRole('button', { name: /reject as sales sheet/i }));
    expect(onReject).toHaveBeenCalledTimes(1);
  });
});

describe('RejectQueueItemDialog suggestedReason', () => {
  it('pre-selects the reason a labelled button chose', () => {
    render(<RejectQueueItemDialog open suggestedReason="sales_sheet" onClose={() => {}} onConfirm={() => {}} />);
    expect((screen.getByRole('radio', { name: /sales sheet, not a spec sheet/i }) as HTMLInputElement).checked).toBe(true);
  });

  it('opens on nothing otherwise', () => {
    render(<RejectQueueItemDialog open onClose={() => {}} onConfirm={() => {}} />);
    for (const r of screen.getAllByRole('radio')) expect((r as HTMLInputElement).checked).toBe(false);
  });
});
