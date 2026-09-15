/**
 * IntakeDuplicateNotes — what a reviewer is told about a file that arrived
 * byte-identical to one already here (migration 0107).
 *
 *   1. A card whose exact file was rejected before says when and why, so a
 *      resend is judged knowingly rather than approved blind.
 *   2. A waiting card says the same file also came in, and from where.
 *   3. "Review anyway" is one click, and a sent row stops offering it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { IntakeDuplicate, QueueIntakeHistory } from '../../shared/types';

const listDuplicates = vi.fn();
const reviewAnyway = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    intakeDuplicates: {
      list: (...args: unknown[]) => listDuplicates(...args),
      reviewAnyway: (...args: unknown[]) => reviewAnyway(...args),
    },
  },
}));

import { IntakeHistoryAlerts, ReceivedAgainList, intakeSourceLabel } from './IntakeDuplicateNotes';

function history(over: Partial<QueueIntakeHistory> = {}): QueueIntakeHistory {
  return { also_received: [], previously_rejected: null, identical_documents: [], sent_anyway: null, ...over };
}

function dup(over: Partial<IntakeDuplicate> = {}): IntakeDuplicate {
  return {
    id: 'dup_1',
    tenant_id: 't1',
    checksum: 'abc',
    match_kind: 'already_approved',
    matched_document_id: 'doc_1',
    matched_document_title: '042026-14OLY 2.5-Gal COA',
    matched_queue_id: 'q_1',
    matched_queue_file_name: 'COA.pdf',
    matched_queue_status: 'approved',
    source: 'email',
    source_detail: JSON.stringify({ sender: 'coa@edaleen.example', subject: 'FW: COA' }),
    source_id: null,
    connector_run_id: null,
    request_upload_id: null,
    file_name: 'COA.pdf',
    file_size: 100,
    mime_type: 'application/pdf',
    received_at: '2026-09-14 10:20:00',
    created_by: null,
    created_by_name: null,
    queue_id: null,
    overridden_by: null,
    overridden_by_name: null,
    overridden_at: null,
    ...over,
  };
}

beforeEach(() => {
  listDuplicates.mockReset();
  reviewAnyway.mockReset();
});

describe('IntakeHistoryAlerts', () => {
  it('says when and why this exact file was rejected before', () => {
    render(
      <MemoryRouter>
        <IntakeHistoryAlerts
          history={history({
            previously_rejected: {
              queue_id: 'q_old',
              file_name: 'sales.pdf',
              rejected_at: '2026-09-01 12:00:00',
              rejection_reason: 'sales_sheet',
              rejection_note: null,
            },
          })}
        />
      </MemoryRouter>,
    );
    const alert = screen.getByTestId('intake-previously-rejected');
    expect(alert.textContent).toMatch(/This exact file was rejected on .* for /);
    expect(alert.textContent?.toLowerCase()).toContain('sales sheet');
  });

  it('says the same file also arrived, and from whom', () => {
    render(
      <MemoryRouter>
        <IntakeHistoryAlerts
          history={history({
            also_received: [
              {
                id: 'd1',
                source: 'email',
                source_detail: JSON.stringify({ sender: 'coa@edaleen.example' }),
                file_name: 'COA.pdf',
                received_at: '2026-09-14 10:20:00',
                queue_id: null,
              },
            ],
          })}
        />
      </MemoryRouter>,
    );
    const alert = screen.getByTestId('intake-also-received');
    expect(alert.textContent).toContain('from email (coa@edaleen.example)');
    expect(alert.textContent).toContain('no second card was made');
  });

  it('renders nothing when there is nothing to say', () => {
    const { container } = render(
      <MemoryRouter>
        <IntakeHistoryAlerts history={history()} />
      </MemoryRouter>,
    );
    expect(container.textContent).toBe('');
  });
});

describe('ReceivedAgainList', () => {
  it('sends a file for review anyway in one click and stops offering it', async () => {
    listDuplicates.mockResolvedValue({ duplicates: [dup()], total: 1, open_count: 1, limit: 200, offset: 0 });
    reviewAnyway.mockResolvedValue({
      duplicate: dup({ queue_id: 'q_new', overridden_by_name: 'AJ', overridden_at: '2026-09-15 08:00:00' }),
      queue_id: 'q_new',
    });
    render(
      <MemoryRouter>
        <ReceivedAgainList />
      </MemoryRouter>,
    );
    const row = await screen.findByTestId('received-again-dup_1');
    expect(row.textContent).toContain('042026-14OLY 2.5-Gal COA');
    await userEvent.click(screen.getByRole('button', { name: 'Review anyway' }));
    expect(reviewAnyway).toHaveBeenCalledWith('dup_1');
    // The "Not reviewed" view drops it once sent.
    await waitFor(() => expect(screen.queryByTestId('received-again-dup_1')).toBeNull());
  });
});

describe('intakeSourceLabel', () => {
  it('names the doors in plain words', () => {
    expect(intakeSourceLabel('request_link')).toBe('a supplier request link');
    expect(intakeSourceLabel('import')).toBe('an upload');
  });
});
