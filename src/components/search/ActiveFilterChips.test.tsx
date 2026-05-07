import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActiveFilterChips } from './ActiveFilterChips';

describe('ActiveFilterChips', () => {
  it('renders nothing when state has no facets', () => {
    const { container } = render(
      <ActiveFilterChips state={{ q: 'foo' }} facets={{}} onChange={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('uses label from facets when available, falls back to value', () => {
    render(
      <ActiveFilterChips
        state={{ q: 'foo', supplier: ['s1', 'unknown'] }}
        facets={{ supplier: [{ value: 's1', label: 'Acme', count: 1 }] }}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText('Supplier: Acme')).toBeInTheDocument();
    expect(screen.getByText('Supplier: unknown')).toBeInTheDocument();
  });

  it('delete drops the single value from its array', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ActiveFilterChips
        state={{ q: 'foo', supplier: ['s1', 's2'] }}
        facets={{ supplier: [{ value: 's1', label: 'Acme', count: 1 }, { value: 's2', label: 'Beta', count: 1 }] }}
        onChange={onChange}
      />,
    );
    // Use the chip's delete (X) button.
    const acmeChip = screen.getByText('Supplier: Acme').closest('.MuiChip-root') as HTMLElement;
    const deleteIcon = acmeChip.querySelector('.MuiChip-deleteIcon') as HTMLElement;
    await user.click(deleteIcon);
    expect(onChange).toHaveBeenCalledWith({ supplier: ['s2'] });
  });

  it('delete clears the array when last value removed', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ActiveFilterChips
        state={{ q: 'foo', supplier: ['s1'] }}
        facets={{ supplier: [{ value: 's1', label: 'Acme', count: 1 }] }}
        onChange={onChange}
      />,
    );
    const chip = screen.getByText('Supplier: Acme').closest('.MuiChip-root') as HTMLElement;
    const deleteIcon = chip.querySelector('.MuiChip-deleteIcon') as HTMLElement;
    await user.click(deleteIcon);
    expect(onChange).toHaveBeenCalledWith({ supplier: undefined });
  });

  it('renders date as a single chip and clears via undefined', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ActiveFilterChips
        state={{ q: 'foo', date: 'last_30d' }}
        facets={{ date: [{ value: 'last_30d', label: 'Last 30 days', count: 0 }] }}
        onChange={onChange}
      />,
    );
    const chip = screen.getByText('Date: Last 30 days').closest('.MuiChip-root') as HTMLElement;
    const deleteIcon = chip.querySelector('.MuiChip-deleteIcon') as HTMLElement;
    await user.click(deleteIcon);
    expect(onChange).toHaveBeenCalledWith({ date: undefined });
  });
});
