import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SortMenu } from './SortMenu';

describe('SortMenu', () => {
  it('shows the current sort label on the button', () => {
    render(<SortMenu value="newest" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: /Sort: Newest first/ })).toBeInTheDocument();
  });

  it('opens menu and emits onChange when an option is picked', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SortMenu value="relevance" onChange={onChange} />);
    await user.click(screen.getByRole('button'));
    await user.click(screen.getByRole('menuitem', { name: 'Newest first' }));
    expect(onChange).toHaveBeenCalledWith('newest');
  });

  it('hides excluded options', async () => {
    const user = userEvent.setup();
    render(<SortMenu value="relevance" onChange={() => {}} exclude={['name']} />);
    await user.click(screen.getByRole('button'));
    expect(screen.queryByRole('menuitem', { name: 'Name (A→Z)' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Newest first' })).toBeInTheDocument();
  });
});
