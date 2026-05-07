import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FacetGroup } from './FacetGroup';
import type { FacetCount } from '../../../shared/types';

const SAMPLE: FacetCount[] = [
  { value: 'a', label: 'Acme', count: 5 },
  { value: 'b', label: 'Beta', count: 3 },
  { value: 'c', label: 'Citrus', count: 2 },
];

describe('FacetGroup', () => {
  it('renders title and all options', () => {
    render(
      <FacetGroup title="Supplier" options={SAMPLE} selected={[]} onChange={() => {}} />,
    );
    expect(screen.getByText('Supplier')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('Citrus')).toBeInTheDocument();
  });

  it('toggling an unselected option ADDs it to the selection', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <FacetGroup
        title="Supplier"
        options={SAMPLE}
        selected={['a']}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByText('Beta'));
    expect(onChange).toHaveBeenCalledWith(['a', 'b']);
  });

  it('toggling a selected option REMOVES it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <FacetGroup
        title="Supplier"
        options={SAMPLE}
        selected={['a', 'b']}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByText('Acme'));
    expect(onChange).toHaveBeenCalledWith(['b']);
  });

  it('shows "N selected" badge when at least one chip is checked', () => {
    render(
      <FacetGroup
        title="Supplier"
        options={SAMPLE}
        selected={['a', 'c']}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });

  it('truncates past initialLimit with a Show more button', async () => {
    const many: FacetCount[] = Array.from({ length: 20 }, (_, i) => ({
      value: `v${i}`,
      label: `Option ${i}`,
      count: i,
    }));
    const user = userEvent.setup();
    render(
      <FacetGroup
        title="Supplier"
        options={many}
        selected={[]}
        onChange={() => {}}
        initialLimit={5}
      />,
    );
    expect(screen.getByText('Option 0')).toBeInTheDocument();
    expect(screen.queryByText('Option 6')).not.toBeInTheDocument();

    await user.click(screen.getByText('Show 15 more'));
    expect(screen.getByText('Option 6')).toBeInTheDocument();
  });

  it('renders an empty hint when no options', () => {
    render(
      <FacetGroup title="Supplier" options={[]} selected={[]} onChange={() => {}} />,
    );
    expect(screen.getByText('No options.')).toBeInTheDocument();
  });
});
