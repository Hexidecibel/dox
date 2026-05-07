import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchBar } from './SearchBar';

describe('SearchBar', () => {
  it('emits onChange on each keystroke', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SearchBar value="" onChange={onChange} />);
    const input = screen.getByPlaceholderText(/search documents/i);
    await user.type(input, 'a');
    expect(onChange).toHaveBeenCalledWith('a');
  });

  it('Enter submits the current value', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<SearchBar value="darigold" onChange={() => {}} onSubmit={onSubmit} />);
    const input = screen.getByPlaceholderText(/search documents/i);
    input.focus();
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('darigold');
  });

  it('shows the AI toggle when onAiToggle is provided', async () => {
    const onAiToggle = vi.fn();
    const user = userEvent.setup();
    render(<SearchBar value="" onChange={() => {}} aiMode={false} onAiToggle={onAiToggle} />);
    const toggle = screen.getByLabelText('ai mode');
    await user.click(toggle);
    expect(onAiToggle).toHaveBeenCalledWith(true);
  });

  it('shows the saved-searches button when onSavedClick is provided', async () => {
    const onSavedClick = vi.fn();
    const user = userEvent.setup();
    render(<SearchBar value="" onChange={() => {}} onSavedClick={onSavedClick} />);
    await user.click(screen.getByLabelText('saved searches'));
    expect(onSavedClick).toHaveBeenCalledOnce();
  });

  it('hides the recent button when there are no recent searches', () => {
    render(<SearchBar value="" onChange={() => {}} recent={[]} />);
    expect(screen.queryByLabelText('recent searches')).not.toBeInTheDocument();
  });

  it('opens the recent popover and picks a value', async () => {
    const onRecentPick = vi.fn();
    const user = userEvent.setup();
    render(
      <SearchBar
        value=""
        onChange={() => {}}
        recent={['darigold', 'cheese']}
        onRecentPick={onRecentPick}
      />,
    );
    await user.click(screen.getByLabelText('recent searches'));
    await user.click(screen.getByText('darigold'));
    expect(onRecentPick).toHaveBeenCalledWith('darigold');
  });
});
