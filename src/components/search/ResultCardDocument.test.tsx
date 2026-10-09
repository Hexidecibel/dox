import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ResultCardDocument } from './ResultCardDocument';
import type { UniversalSearchDocument } from '../../../shared/types';

const wrap = (ui: React.ReactNode) => (
  <MemoryRouter>{ui}</MemoryRouter>
);

const BASE: UniversalSearchDocument = {
  id: 'd_1',
  title: 'Acme COA April 2026',
  description: 'Certificate of analysis for batch 1234',
  supplier_name: 'Acme',
  document_type_name: 'COA',
  created_at: '2026-04-30T00:00:00Z',
};

describe('ResultCardDocument', () => {
  it('renders title, supplier, and doc type', () => {
    render(wrap(<ResultCardDocument doc={BASE} />));
    expect(screen.getByText('Acme COA April 2026')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('COA')).toBeInTheDocument();
  });

  it('renders the extracted_text snippet when present (with mark)', () => {
    render(
      wrap(
        <ResultCardDocument
          doc={{
            ...BASE,
            snippet_extracted: 'lot <mark>1234</mark> tested at 99%',
          }}
        />,
      ),
    );
    expect(screen.getByText('1234').tagName.toLowerCase()).toBe('mark');
  });

  it('renders the supplier snippet inside the chip when provided', () => {
    render(
      wrap(
        <ResultCardDocument
          doc={{ ...BASE, snippet_supplier: '<mark>Acme</mark> Foods Co.' }}
        />,
      ),
    );
    expect(screen.getByText('Acme').tagName.toLowerCase()).toBe('mark');
  });

  it('falls back to "(untitled)" when title and snippet are missing', () => {
    render(wrap(<ResultCardDocument doc={{ id: 'd_1' }} />));
    expect(screen.getByText('(untitled)')).toBeInTheDocument();
  });

  it('forwards onOpen with the doc', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(wrap(<ResultCardDocument doc={BASE} onOpen={onOpen} />));
    await user.click(screen.getByText('Acme COA April 2026'));
    expect(onOpen).toHaveBeenCalledWith(BASE);
  });

  it('says a certificate is on hold, and says nothing when it is not (migration 0139)', () => {
    const first = render(wrap(<ResultCardDocument doc={BASE} />));
    expect(screen.queryByTestId('result-hold-chip')).toBeNull();
    first.unmount();

    render(
      wrap(
        <ResultCardDocument
          doc={{
            ...BASE,
            active_hold: { id: 'h1', lot_id: 'l1', lot_label: '5501', reason: 'Retest pending', source: 'person', placed_at: '2026-10-08 10:00:00' },
          }}
        />,
      ),
    );
    const chip = screen.getByTestId('result-hold-chip');
    expect(chip).toHaveTextContent('On hold');
    expect(chip).toHaveAttribute('title', 'On hold (lot 5501): Retest pending');
  });
});
