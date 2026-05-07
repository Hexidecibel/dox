import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FacetOption } from './FacetOption';

describe('FacetOption', () => {
  it('renders label and count', () => {
    render(
      <FacetOption value="acme" label="Acme Foods" count={42} selected={false} onToggle={() => {}} />,
    );
    expect(screen.getByText('Acme Foods')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('formats count with locale separators', () => {
    render(
      <FacetOption value="x" label="X" count={12345} selected={false} onToggle={() => {}} />,
    );
    expect(screen.getByText('12,345')).toBeInTheDocument();
  });

  it('checkbox reflects `selected`', () => {
    const { rerender } = render(
      <FacetOption value="x" label="X" count={1} selected={false} onToggle={() => {}} />,
    );
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    rerender(
      <FacetOption value="x" label="X" count={1} selected={true} onToggle={() => {}} />,
    );
    expect(screen.getByRole('checkbox')).toBeChecked();
  });

  it('clicking the row fires onToggle with the value', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <FacetOption value="acme" label="Acme" count={1} selected={false} onToggle={onToggle} />,
    );
    await user.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalledWith('acme');
  });

  it('keyboard activation toggles', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <FacetOption value="acme" label="Acme" count={1} selected={false} onToggle={onToggle} />,
    );
    const row = screen.getByRole('button');
    row.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onToggle).toHaveBeenCalledTimes(2);
  });
});
