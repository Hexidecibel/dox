/**
 * Screen 6's failure states, rendered.
 *
 * `demoTrace.test.ts` proves WHEN each state is reached; this proves what a
 * person actually sees when it is, because the sentence is the feature. A demo
 * that reaches `worker_silent` correctly and then renders a spinner has failed
 * in exactly the way that matters — this is the last screen somebody evaluating
 * the product looks at, and "it just sat there" is what they will remember.
 *
 * Four paths, all of them ones a real demo hits:
 *   worker down        the command to start it, and no retry button (there is
 *                      nothing to retry — the item was never touched)
 *   extraction error   the worker's own message, and a Retry that calls the
 *                      endpoint built for getting past the retry cap
 *   timeout            we stopped watching, and the document is not lost
 *   skip               always available, completes the run, records why
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WORKER_SILENT_MS, DEMO_TIMEOUT_MS } from './demoTrace';
import type { ProcessingQueueItem, TenantSetupRun } from '../../lib/types';
import type { SetupStepProps } from './stepProps';

const process_ = vi.fn();
const queueGet = vi.fn();
const reprocess = vi.fn();
const applyPacket = vi.fn();

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'org_admin', tenant_id: 't1' }, isSuperAdmin: false }),
}));

// The readiness list has its own tests and its own loader; stubbing it keeps
// this file about the demo rather than about nine unrelated endpoints.
vi.mock('../../components/SetupReadinessList', () => ({
  SetupReadinessList: () => null,
  buildReadinessItems: () => [],
  loadReadinessSnapshot: () => Promise.resolve({}),
}));

vi.mock('../../lib/api', () => ({
  api: {
    processing: { process: (...a: unknown[]) => process_(...a) },
    queue: {
      get: (...a: unknown[]) => queueGet(...a),
      reprocess: (...a: unknown[]) => reprocess(...a),
    },
    starterPacks: { applyPacket: (...a: unknown[]) => applyPacket(...a) },
    // The three side reads. Rejecting is the honest default for a test that is
    // not about them: a failed side read must produce NO trace line, which is
    // itself the behaviour under test everywhere else in this suite.
    documentTypeRequirements: { list: () => Promise.reject(new Error('not under test')) },
    documentTypeInstructions: { get: () => Promise.reject(new Error('not under test')) },
    documentTypes: { list: () => Promise.reject(new Error('not under test')) },
    ownerRoutes: { list: () => Promise.reject(new Error('not under test')) },
  },
}));

import { StepDemo, StatePanel } from './StepDemo';

function queueItem(over: Partial<ProcessingQueueItem> = {}): ProcessingQueueItem {
  return {
    id: 'q1',
    tenant_id: 't1',
    document_type_id: null,
    file_r2_key: 'k',
    file_name: 'coa.pdf',
    file_size: 10,
    mime_type: 'application/pdf',
    extracted_text: null,
    ai_fields: null,
    ai_confidence: null,
    confidence_score: null,
    confidence: null,
    product_names: null,
    supplier: null,
    supplier_id: null,
    document_type_guess: null,
    status: 'pending',
    processing_status: 'queued',
    error_message: null,
    checksum: null,
    tables: null,
    summary: null,
    reviewed_by: null,
    reviewed_at: null,
    created_by: null,
    created_at: '2026-09-03T00:00:00Z',
    template_id: null,
    auto_ingested: 0,
    source: null,
    source_detail: null,
    output_kind: 'coa',
    origin_kind: null,
    ai_records: null,
    source_id: null,
    connector_run_id: null,
    vlm_extracted_fields: null,
    vlm_extracted_tables: null,
    vlm_confidence: null,
    vlm_error: null,
    vlm_model: null,
    vlm_duration_ms: null,
    vlm_extracted_at: null,
    text_model: null,
    text_page_sources: null,
    learned_field_hints: null,
    uncertainty: null,
    ...over,
  };
}

const run: TenantSetupRun = {
  id: 'run1',
  tenant_id: 't1',
  status: 'draft',
  current_step: 6,
  pack: 'fsqa',
  state: {},
  applied: {},
  started_by: 'u1',
  started_at: '2026-09-03T00:00:00Z',
  updated_at: '2026-09-03T00:00:00Z',
  completed_at: null,
  completed_by: null,
};

function props(over: Partial<SetupStepProps> = {}): SetupStepProps {
  return {
    run,
    tenantId: 't1',
    catalog: null,
    pack: null,
    preSeeded: null,
    patchState: vi.fn(),
    refreshRun: vi.fn().mockResolvedValue(undefined),
    goToStep: vi.fn(),
    setNextIntercept: vi.fn(),
    finish: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

/** Put a file through the drop zone and wait for the first poll to land. */
async function upload(container: HTMLElement) {
  process_.mockResolvedValue({ items: [{ id: 'q1', file_name: 'coa.pdf' }] });
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  // fireEvent rather than userEvent.upload: the input is deliberately hidden
  // behind a styled button, and this test is about what happens AFTER the file
  // is chosen, not about the file picker.
  fireEvent.change(input, { target: { files: [new File(['x'], 'coa.pdf')] } });
  await waitFor(() => expect(queueGet).toHaveBeenCalled());
}

/**
 * The same, for the two tests that run on a fake clock.
 *
 * `waitFor` is unusable there: it polls on a REAL interval while the component
 * is waiting on promises the fake clock never advances, so under a loaded suite
 * it times out at a second even though nothing is wrong. `advanceTimersByTimeAsync`
 * flushes the microtask queue between timers, which is exactly what an upload →
 * poll → setState chain needs, and `act` makes React commit the result.
 */
async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function uploadOnFakeClock(container: HTMLElement) {
  process_.mockResolvedValue({ items: [{ id: 'q1', file_name: 'coa.pdf' }] });
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['x'], 'coa.pdf')] } });
  await settle();
  expect(queueGet).toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StepDemo — the whole screen', () => {
  it('sends the file through the same door Import uses, with no document type', async () => {
    queueGet.mockResolvedValue({ item: queueItem() });
    const { container } = render(<StepDemo {...props()} />);
    await upload(container);

    // POST /api/documents/process — one file, the tenant, and nothing else.
    // Naming a document type would skip the classification the trace exists to
    // show, and a wizard-only intake path would prove only that the wizard
    // works.
    expect(process_).toHaveBeenCalledWith([expect.any(File)], 't1');
    expect(process_.mock.calls[0]).toHaveLength(2);
  });

  it('offers "Finish without the demo" before a file is ever chosen', async () => {
    const finish = vi.fn().mockResolvedValue(undefined);
    render(<StepDemo {...props({ finish })} />);

    // Present in the empty state — a way out that only appears once you are
    // stuck has already failed the person who needed it.
    await userEvent.click(screen.getByRole('button', { name: /finish without the demo/i }));
    expect(finish).toHaveBeenCalledWith({ demo_skipped: true });
  });

  it('completes the run without demo_skipped when the demo was actually watched', async () => {
    const finish = vi.fn().mockResolvedValue(undefined);
    render(<StepDemo {...props({ finish })} />);
    await userEvent.click(screen.getByRole('button', { name: /^finish setup$/i }));
    expect(finish).toHaveBeenCalledWith();
  });

  it('names the worker and its start command once nothing picks the file up', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      queueGet.mockResolvedValue({ item: queueItem({ processing_status: 'queued' }) });
      const { container } = render(<StepDemo {...props()} />);
      await uploadOnFakeClock(container);

      // Before the threshold this must NOT accuse a worker that polls every 30s.
      expect(screen.queryByText(/extraction worker is not running/i)).toBeNull();

      await settle(WORKER_SILENT_MS + 2_000);

      expect(screen.getByText(/the extraction worker is not running/i)).toBeInTheDocument();
      expect(screen.getByText('bin/process-worker-start')).toBeInTheDocument();
      // No retry: there is nothing to retry, and a button that does nothing is
      // how somebody concludes the product is broken.
      expect(screen.queryByRole('button', { name: /^retry$/i })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the worker’s own error and retries through the reprocess endpoint', async () => {
    queueGet.mockResolvedValue({
      item: queueItem({
        processing_status: 'error',
        error_message: 'Qwen call failed: Qwen HTTP 502: upstream connect error',
      }),
    });
    reprocess.mockResolvedValue({ success: true });

    const { container } = render(<StepDemo {...props()} />);
    await upload(container);

    await waitFor(() =>
      expect(screen.getByText(/extraction failed \(model cold start\)/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Qwen HTTP 502/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    // POST /api/queue/:id/reprocess — the endpoint that zeroes `attempts` past
    // the worker's own retry cap, which is exactly where a cold-start 502
    // leaves the row.
    await waitFor(() => expect(reprocess).toHaveBeenCalledWith('q1'));
  });

  it('does not call the cold start a cold start when it was not one', async () => {
    queueGet.mockResolvedValue({
      item: queueItem({ processing_status: 'error', error_message: 'PDF has no text layer' }),
    });
    const { container } = render(<StepDemo {...props()} />);
    await upload(container);

    await waitFor(() => expect(screen.getByText(/^Extraction failed$/i)).toBeInTheDocument());
    expect(screen.queryByText(/cold start/i)).toBeNull();
    // The retry is still offered — misclassifying costs a worse sentence, never
    // a dead end.
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('stops watching after the timeout and says the document is not lost', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      queueGet.mockResolvedValue({ item: queueItem({ processing_status: 'processing' }) });
      const { container } = render(<StepDemo {...props()} />);
      await uploadOnFakeClock(container);

      await settle(DEMO_TIMEOUT_MS + 2_000);
      expect(screen.getByText(/gave up waiting after 5 minutes/i)).toBeInTheDocument();
      expect(screen.getByText(/still in the review queue/i)).toBeInTheDocument();

      // Polling has stopped. Anything else is a page that quietly keeps hitting
      // D1 for the rest of the day.
      const callsAtGiveUp = queueGet.mock.calls.length;
      await settle(60_000);
      expect(queueGet.mock.calls.length).toBe(callsAtGiveUp);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the escape hatch available in a failure state', async () => {
    const finish = vi.fn().mockResolvedValue(undefined);
    queueGet.mockResolvedValue({
      item: queueItem({ processing_status: 'error', error_message: 'boom' }),
    });
    const { container } = render(<StepDemo {...props({ finish })} />);
    await upload(container);

    await waitFor(() => expect(screen.getByText(/extraction failed/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /finish without the demo/i }));
    expect(finish).toHaveBeenCalledWith({ demo_skipped: true });
  });

  it('resumes the row this run already dropped, with the clock it really started on', async () => {
    // The wizard's premise is that an interruption never costs you your place.
    // The last screen would be the one place that still did.
    const created = new Date(Date.now() - DEMO_TIMEOUT_MS - 60_000).toISOString();
    queueGet.mockResolvedValue({
      item: queueItem({ processing_status: 'queued', created_at: created }),
    });

    render(
      <StepDemo
        {...props({ run: { ...run, state: { demo_queue_id: 'q1' } } })}
      />,
    );

    await waitFor(() => expect(queueGet).toHaveBeenCalledWith('q1'));
    // The clock restarts from `created_at`, so an hour-old abandoned upload
    // lands on the honest answer rather than pretending the wait just began.
    await waitFor(() => expect(screen.getByText(/gave up waiting/i)).toBeInTheDocument());
  });

  it('falls back to the drop zone when the remembered row is gone', async () => {
    queueGet.mockRejectedValue(new Error('Not found'));
    render(
      <StepDemo {...props({ run: { ...run, state: { demo_queue_id: 'vanished' } } })} />,
    );

    await waitFor(() => expect(queueGet).toHaveBeenCalled());
    // Nothing is broken here — there is just nothing to resume.
    expect(screen.getByText(/drop a document in/i)).toBeInTheDocument();
    expect(screen.queryByText(/could not be sent/i)).toBeNull();
  });

  it('reports an upload that never produced a queue row, without blaming the worker', async () => {
    process_.mockRejectedValue(new Error('File type not supported'));
    const { container } = render(<StepDemo {...props()} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'coa.zip')] } });

    await waitFor(() =>
      expect(screen.getByText(/the file could not be sent/i)).toBeInTheDocument(),
    );
    expect(screen.getByText('File type not supported')).toBeInTheDocument();
    expect(screen.queryByText(/extraction worker/i)).toBeNull();
  });
});

describe('StepDemo — the closing action', () => {
  const pack = {
    pack: 'fsqa',
    label: 'Food Safety',
    description: '',
    sections: [],
    owner_labels: [],
    total_rows: 0,
    modules: { default_on: [], default_off: [] },
    teach: null,
    packets: [
      {
        name: 'Approved Supplier Baseline',
        slug: 'baseline',
        description: null,
        default: true,
        requirements: ['a', 'b'],
        recommends: ['c'],
      },
      {
        name: 'Ingredient Supplier',
        slug: 'ingredient-supplier',
        description: null,
        default: false,
        requirements: ['d'],
        recommends: [],
      },
    ],
  };

  it('names ONE supplier in the button, and never offers an apply-to-all', async () => {
    queueGet.mockResolvedValue({
      item: queueItem({ processing_status: 'ready', supplier: 'Darigold' }),
    });
    applyPacket.mockResolvedValue({
      pack: 'fsqa',
      packet: 'baseline',
      packet_name: 'Approved Supplier Baseline',
      supplier_id: 's1',
      supplier_name: 'Darigold',
      supplier_created: true,
      attached: { required: 2, recommended: 1 },
      unknown_requirements: [],
      run: null,
    });

    const { container } = render(<StepDemo {...props({ pack })} />);
    await upload(container);

    const button = await screen.findByRole('button', {
      name: /apply the approved supplier baseline packet to darigold/i,
    });
    // The one thing that must never exist anywhere on this screen.
    expect(screen.queryByRole('button', { name: /all suppliers|apply to all/i })).toBeNull();

    await userEvent.click(button);
    await waitFor(() =>
      expect(applyPacket).toHaveBeenCalledWith({
        pack: 'fsqa',
        packet: 'baseline',
        supplierName: 'Darigold',
        tenantId: 't1',
      }),
    );
    expect(await screen.findByText(/applied to darigold/i)).toBeInTheDocument();
  });
});

describe('StatePanel', () => {
  it('renders nothing for the states that are not problems', () => {
    for (const state of [
      { kind: 'idle' },
      { kind: 'uploading' },
      { kind: 'queued' },
      { kind: 'extracting' },
      { kind: 'ready' },
    ] as const) {
      const { container } = render(
        <StatePanel state={state} retrying={false} onRetry={vi.fn()} onRestart={vi.fn()} />,
      );
      expect(container).toBeEmptyDOMElement();
    }
  });

  it('tells a queued timeout and a stalled one apart', () => {
    const { rerender } = render(
      <StatePanel
        state={{ kind: 'timed_out', lastStatus: 'queued' }}
        retrying={false}
        onRetry={vi.fn()}
        onRestart={vi.fn()}
      />,
    );
    expect(screen.getByText(/ever picked the file up/i)).toBeInTheDocument();

    rerender(
      <StatePanel
        state={{ kind: 'timed_out', lastStatus: 'processing' }}
        retrying={false}
        onRetry={vi.fn()}
        onRestart={vi.fn()}
      />,
    );
    expect(screen.getByText(/has not finished with it/i)).toBeInTheDocument();
  });
});
