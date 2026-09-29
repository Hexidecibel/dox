import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActiveFilterChips } from './ActiveFilterChips';
import type { SearchQuery } from '../../../shared/searchQuery';

const q = (clauses: SearchQuery['clauses']): SearchQuery => ({ v: 1, text: 'foo', clauses, view: { entity: 'documents' } });

function deleteChip(text: string) {
  const chip = screen.getByText(text).closest('.MuiChip-root') as HTMLElement;
  return chip.querySelector('.MuiChip-deleteIcon') as HTMLElement;
}

describe('ActiveFilterChips', () => {
  it('renders nothing when the query has no clauses', () => {
    const { container } = render(<ActiveFilterChips query={q([])} facets={{}} onChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names values from the server labels, then the facets, then falls back to the id', () => {
    render(
      <ActiveFilterChips
        query={q([{ id: 'c1', field: 'supplier', op: 'in', values: ['s1', 's2', 'unknown'], source: 'facet' }])}
        labels={{ s2: 'Beta Creamery' }}
        facets={{ supplier: [{ value: 's1', label: 'Acme', count: 1 }] }}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText('Supplier: Acme')).toBeInTheDocument();
    expect(screen.getByText('Supplier: Beta Creamery')).toBeInTheDocument();
    expect(screen.getByText('Supplier: unknown')).toBeInTheDocument();
  });

  it('deleting one value drops only that value', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ActiveFilterChips
        query={q([
          { id: 'c1', field: 'supplier', op: 'in', values: ['s1', 's2'], source: 'facet' },
          { id: 'c2', field: 'product', op: 'in', values: ['p1'], source: 'facet' },
        ])}
        facets={{ supplier: [{ value: 's1', label: 'Acme', count: 1 }, { value: 's2', label: 'Beta', count: 1 }] }}
        onChange={onChange}
      />,
    );
    await user.click(deleteChip('Supplier: Acme'));
    const next: SearchQuery = onChange.mock.calls[0][0];
    expect(next.clauses.map((c) => [c.field, c.values])).toEqual([['supplier', ['s2']], ['product', ['p1']]]);
  });

  it('deleting the last value removes the clause', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ActiveFilterChips
        query={q([{ id: 'c1', field: 'supplier', op: 'in', values: ['s1'], source: 'facet' }])}
        facets={{ supplier: [{ value: 's1', label: 'Acme', count: 1 }] }}
        onChange={onChange}
      />,
    );
    await user.click(deleteChip('Supplier: Acme'));
    expect(onChange.mock.calls[0][0].clauses).toEqual([]);
  });

  it('an upload window and an identifying clause are one chip each, in words', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ActiveFilterChips
        query={q([
          { id: 'c1', field: 'uploaded', op: 'within', values: ['30'], source: 'facet' },
          { id: 'c2', field: 'production_date', op: 'on', values: ['2026-09-02'], source: 'builder' },
        ])}
        facets={{}}
        onChange={onChange}
      />,
    );
    expect(screen.getByText('Uploaded: last 30 days')).toBeInTheDocument();
    await user.click(deleteChip('Production date Sep 2, 2026'));
    expect(onChange.mock.calls[0][0].clauses.map((c: { field: string }) => c.field)).toEqual(['uploaded']);
  });
});
