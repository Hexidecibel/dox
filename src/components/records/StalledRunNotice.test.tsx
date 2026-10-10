/**
 * A stalled workflow run is REPORTED by the server and acted on by a person
 * (decision C-151): the run view shows why it stopped, with Resume only when
 * the server says it can be continued without guessing, and Cancel always.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const resume = vi.fn();
const cancel = vi.fn();
vi.mock('../../lib/recordsApi', () => ({
  recordsApi: { workflowRuns: { resume: (id: string) => resume(id), cancel: (id: string) => cancel(id) } },
}));

import { StalledRunNotice } from './WorkflowRunVisualization';
import type { RecordWorkflowRun } from '../../../shared/types';

const run = (extra: Partial<RecordWorkflowRun>): RecordWorkflowRun => ({
  id: 'run-1',
  tenant_id: 't',
  workflow_id: 'w',
  sheet_id: 's',
  row_id: 'r',
  status: 'in_progress',
  current_step_id: 's1',
  triggered_by_user_id: null,
  started_at: null,
  completed_at: null,
  created_at: '',
  ...extra,
});

beforeEach(() => {
  resume.mockReset();
  cancel.mockReset();
});

describe('StalledRunNotice', () => {
  it('draws nothing for a run that is not stalled', () => {
    const { container } = render(<StalledRunNotice run={run({})} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('a resumable run: the reason, Resume and Cancel; Resume calls the resume route and reads again', async () => {
    resume.mockResolvedValue({ success: true, action: 'moved' });
    const onChanged = vi.fn();
    render(<StalledRunNotice run={run({ stalled: true, resumable: true, stalled_reason: '"QA" was approved, and the workflow did not move on.' })} onChanged={onChanged} />);
    expect(screen.getByText('This workflow has stopped moving.')).toBeInTheDocument();
    expect(screen.getByText('"QA" was approved, and the workflow did not move on.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel this run' })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Resume' }));
    expect(resume).toHaveBeenCalledWith('run-1');
    expect(cancel).not.toHaveBeenCalled();
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('a run that cannot be resumed offers Cancel ONLY', async () => {
    cancel.mockResolvedValue({ success: true });
    const onChanged = vi.fn();
    render(
      <StalledRunNotice
        run={run({ stalled: true, resumable: false, stalled_reason: '"QA" was skipped, not decided. A skipped step is never treated as an approval.' })}
        onChanged={onChanged}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel this run' }));
    expect(cancel).toHaveBeenCalledWith('run-1');
    expect(resume).not.toHaveBeenCalled();
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('a refused resume shows the server\'s sentence and reads the run again', async () => {
    resume.mockRejectedValue(new Error('Somebody is already resuming this run. Look again in a moment.'));
    const onChanged = vi.fn();
    render(<StalledRunNotice run={run({ stalled: true, resumable: true, stalled_reason: 'x' })} onChanged={onChanged} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Resume' }));
    expect(await screen.findByTestId('stalled-run-error')).toHaveTextContent('Somebody is already resuming this run.');
    expect(onChanged).toHaveBeenCalled();
  });
});
