import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FacetSidebar } from './FacetSidebar';
import type { FacetCount } from '../../../shared/types';
import type { SearchQuery } from '../../../shared/searchQuery';

const SUPPLIERS: FacetCount[] = [
  { value: 's1', label: 'Acme', count: 5 },
  { value: 's2', label: 'Beta', count: 3 },
];

const q = (clauses: SearchQuery['clauses'] = [], text = 'foo'): SearchQuery => ({ v: 1, text, clauses, view: { entity: 'documents' } });

describe('FacetSidebar', () => {
  it('renders an empty hint when no facets are present', () => {
    render(<FacetSidebar query={q()} facets={{}} onChange={() => {}} />);
    expect(screen.getByText('Run a search to see filter options.')).toBeInTheDocument();
  });

  it('renders facets in a stable order', () => {
    render(
      <FacetSidebar
        query={q()}
        facets={{ supplier: SUPPLIERS, status: [{ value: 'active', label: 'Active', count: 8 }] }}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText('Supplier')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
  });

  it('ticking a second supplier extends that clause and leaves every other clause alone', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <FacetSidebar
        query={q([
          { id: 'c1', field: 'supplier', op: 'in', values: ['s1'], source: 'facet' },
          { id: 'c2', field: 'product', op: 'in', values: ['butter'], source: 'facet' },
        ])}
        facets={{ supplier: SUPPLIERS }}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByText('Beta'));
    const next: SearchQuery = onChange.mock.calls[0][0];
    expect(next.clauses.map((c) => [c.field, c.values])).toEqual([['supplier', ['s1', 's2']], ['product', ['butter']]]);
    expect(next.text).toBe('foo');
  });

  it('unticking the last value removes the clause, not the others', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <FacetSidebar
        query={q([
          { id: 'c1', field: 'supplier', op: 'in', values: ['s1'], source: 'facet' },
          { id: 'c2', field: 'document_type', op: 'in', values: ['t1'], source: 'facet' },
        ])}
        facets={{ supplier: SUPPLIERS }}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByText('Acme'));
    const next: SearchQuery = onChange.mock.calls[0][0];
    expect(next.clauses.map((c) => c.field)).toEqual(['document_type']);
  });

  it('Clear drops every scope clause but keeps identifying ones and the text', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <FacetSidebar
        query={q([
          { id: 'c1', field: 'supplier', op: 'in', values: ['s1'], source: 'facet' },
          { id: 'c2', field: 'lot', op: 'is', values: ['10426203'], source: 'builder' },
        ])}
        facets={{ supplier: SUPPLIERS }}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    const next: SearchQuery = onChange.mock.calls[0][0];
    expect(next.clauses.map((c) => c.field)).toEqual(['lot']);
    expect(next.text).toBe('foo');
  });

  it('uploaded is single-select, and the value it sends IS the clause', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <FacetSidebar
        query={q([{ id: 'c1', field: 'uploaded', op: 'within', values: ['7'], source: 'facet' }])}
        facets={{
          uploaded: [
            { value: 'within:7', label: 'Last 7 days', count: 4 },
            { value: 'within:30', label: 'Last 30 days', count: 12 },
          ],
        }}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByText('Last 30 days'));
    const next: SearchQuery = onChange.mock.calls[0][0];
    expect(next.clauses).toEqual([{ id: 'c1', field: 'uploaded', op: 'within', values: ['30'], source: 'facet' }]);
  });
});
