import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FacetSidebar } from './FacetSidebar';
import type { FacetCount } from '../../../shared/types';

const SUPPLIERS: FacetCount[] = [
  { value: 's1', label: 'Acme', count: 5 },
  { value: 's2', label: 'Beta', count: 3 },
];

describe('FacetSidebar', () => {
  it('renders an empty hint when no facets are present', () => {
    render(<FacetSidebar state={{ q: 'foo' }} facets={{}} onChange={() => {}} />);
    expect(screen.getByText('Run a search to see filter options.')).toBeInTheDocument();
  });

  it('renders facets in a stable order', () => {
    render(
      <FacetSidebar
        state={{ q: 'foo' }}
        facets={{ supplier: SUPPLIERS, status: [{ value: 'active', label: 'Active', count: 8 }] }}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText('Supplier')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
  });

  it('forwards multi-facet selection changes as a patch', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <FacetSidebar
        state={{ q: 'foo', supplier: ['s1'] }}
        facets={{ supplier: SUPPLIERS }}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByText('Beta'));
    expect(onChange).toHaveBeenCalledWith({ supplier: ['s1', 's2'] });
  });

  it('emits `undefined` when the last selection is cleared', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <FacetSidebar
        state={{ q: 'foo', supplier: ['s1'] }}
        facets={{ supplier: SUPPLIERS }}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByText('Acme'));
    expect(onChange).toHaveBeenCalledWith({ supplier: undefined });
  });

  it('Clear button emits a sweeping facet-clear patch', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <FacetSidebar
        state={{ q: 'foo', supplier: ['s1'], doc_type: ['t1'] }}
        facets={{ supplier: SUPPLIERS }}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    const patch = onChange.mock.calls[0][0];
    expect(patch.supplier).toBeUndefined();
    expect(patch.doc_type).toBeUndefined();
    expect(patch.product).toBeUndefined();
    expect(patch.status).toBeUndefined();
    expect(patch.date).toBeUndefined();
  });

  it('treats date as a single-select bucket', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <FacetSidebar
        state={{ q: 'foo' }}
        facets={{
          date: [
            { value: 'last_7d', label: 'Last 7 days', count: 4 },
            { value: 'last_30d', label: 'Last 30 days', count: 12 },
          ],
        }}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByText('Last 30 days'));
    expect(onChange).toHaveBeenCalledWith({ date: 'last_30d' });
  });
});
