import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CoverageResults } from './CoverageResults';
import { ExportSelectionBar } from './ExportSelectionBar';
import { SendExportDialog } from './SendExportDialog';
import type { SearchSelection } from './SelectableResult';
import type { UniversalSearchDocument } from '../../../shared/types';

const wrap = (ui: React.ReactNode) => <MemoryRouter>{ui}</MemoryRouter>;

function selection(over: Partial<SearchSelection> = {}): SearchSelection {
  return {
    selectedIds: new Set<string>(),
    includedAnyway: new Set<string>(),
    onToggle: vi.fn(),
    onIncludeAnyway: vi.fn(),
    onSelectMany: vi.fn(),
    ...over,
  };
}

const covering: UniversalSearchDocument = {
  id: 'cov1',
  title: 'Darigold Cream COA',
  match_status: 'covering',
  match_checks: [],
} as unknown as UniversalSearchDocument;

const nearby: UniversalSearchDocument = {
  id: 'near1',
  title: 'West Point Butter',
  match_status: 'candidate_not_matching',
  match_checks: [],
} as unknown as UniversalSearchDocument;

describe('selecting search results for export', () => {
  it('a covering result is selectable directly', async () => {
    const sel = selection();
    render(wrap(<CoverageResults coverage="covered" coverage_summary="1 covering." documents={[covering]} selection={sel} />));

    const box = screen.getByTestId('select-cov1');
    await userEvent.click(box);
    expect(sel.onToggle).toHaveBeenCalledWith(covering);
  });

  it('a NEARBY result has no checkbox until it is explicitly included', async () => {
    const sel = selection();
    render(wrap(<CoverageResults coverage="none" coverage_summary="Nothing covers it." documents={[nearby]} selection={sel} />));

    expect(screen.queryByTestId('select-near1')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('include-anyway-near1'));
    expect(sel.onIncludeAnyway).toHaveBeenCalledWith(nearby);
  });

  it('once included, the nearby result shows a checkbox like any other', () => {
    const sel = selection({ includedAnyway: new Set(['near1']), selectedIds: new Set(['near1']) });
    render(wrap(<CoverageResults coverage="none" coverage_summary="Nothing covers it." documents={[nearby]} selection={sel} />));
    expect(screen.getByTestId('select-near1')).toBeChecked();
  });

  it('offers a select-all for the covering set only', async () => {
    const sel = selection();
    render(
      wrap(
        <CoverageResults
          coverage="none"
          coverage_summary="Mixed."
          documents={[covering, nearby]}
          selection={sel}
        />,
      ),
    );
    await userEvent.click(screen.getByTestId('select-all-covering'));
    expect(sel.onSelectMany).toHaveBeenCalledWith([covering]);
  });

  it('renders no selection affordance at all when export is off', () => {
    render(wrap(<CoverageResults coverage="covered" coverage_summary="1 covering." documents={[covering]} />));
    expect(screen.queryByTestId('select-cov1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('select-all-covering')).not.toBeInTheDocument();
  });
});

describe('ExportSelectionBar', () => {
  it('is invisible until something is selected', () => {
    const { container } = render(
      <ExportSelectionBar count={0} onDownload={vi.fn()} onSend={vi.fn()} onClear={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('counts the selection and offers both ways out', async () => {
    const onDownload = vi.fn();
    const onSend = vi.fn();
    render(<ExportSelectionBar count={3} onDownload={onDownload} onSend={onSend} onClear={vi.fn()} />);

    const bar = screen.getByTestId('export-selection-bar');
    expect(within(bar).getByText('3 selected')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('export-download'));
    await userEvent.click(screen.getByTestId('export-send'));
    expect(onDownload).toHaveBeenCalled();
    expect(onSend).toHaveBeenCalled();
  });

  it('shows a refusal without losing the selection', () => {
    render(
      <ExportSelectionBar
        count={2}
        error="That selection is 61 MB and the limit for one export is 40 MB."
        onDownload={vi.fn()}
        onSend={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(screen.getByText(/the limit for one export is 40 MB/)).toBeInTheDocument();
    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });
});

describe('SendExportDialog', () => {
  const docs = [covering, nearby];

  it('says what the recipient gets, and who replies reach', () => {
    render(
      <SendExportDialog
        open
        documents={docs}
        senderName="Dana Reid"
        senderEmail="dana@medosweet.example"
        onClose={vi.fn()}
        onSend={vi.fn()}
      />,
    );
    expect(screen.getByText(/one link that expires in 30 days — not/)).toBeInTheDocument();
    expect(screen.getByText(/replies going to dana@medosweet.example/)).toBeInTheDocument();
    expect(screen.getByText(/Darigold Cream COA, West Point Butter/)).toBeInTheDocument();
  });

  it('cannot send without a recipient, and passes the on-behalf-of through', async () => {
    const onSend = vi.fn();
    render(
      <SendExportDialog
        open
        documents={docs}
        senderName="Dana Reid"
        senderEmail="dana@medosweet.example"
        onClose={vi.fn()}
        onSend={onSend}
      />,
    );

    expect(screen.getByTestId('export-send-confirm')).toBeDisabled();
    await userEvent.type(screen.getByTestId('export-recipients'), 'buyer@customer.example');
    await userEvent.type(screen.getByTestId('export-on-behalf-of'), 'Marco in Sales');
    await userEvent.click(screen.getByTestId('export-send-confirm'));

    expect(onSend).toHaveBeenCalledWith({
      recipients: 'buyer@customer.example',
      onBehalfOf: 'Marco in Sales',
      message: '',
    });
  });
});
