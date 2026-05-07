import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecentSearchesList } from './RecentSearchesList';

describe('RecentSearchesList', () => {
  it('shows empty hint when no entries', () => {
    render(<RecentSearchesList recent={[]} onPick={() => {}} />);
    expect(screen.getByText(/no recent searches/i)).toBeInTheDocument();
  });

  it('lists recent queries newest-first', () => {
    render(<RecentSearchesList recent={['a', 'b', 'c']} onPick={() => {}} />);
    const items = screen.getAllByRole('button').filter((el) => el.textContent && /^[abc]$/.test(el.textContent));
    expect(items[0]).toHaveTextContent('a');
    expect(items[1]).toHaveTextContent('b');
    expect(items[2]).toHaveTextContent('c');
  });

  it('clicking an entry fires onPick', async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(<RecentSearchesList recent={['darigold']} onPick={onPick} />);
    await user.click(screen.getByText('darigold'));
    expect(onPick).toHaveBeenCalledWith('darigold');
  });

  it('per-row remove fires onRemove', async () => {
    const onRemove = vi.fn();
    const user = userEvent.setup();
    render(
      <RecentSearchesList recent={['darigold']} onPick={() => {}} onRemove={onRemove} />,
    );
    await user.click(screen.getByLabelText('remove darigold'));
    expect(onRemove).toHaveBeenCalledWith('darigold');
  });

  it('Clear all fires onClear', async () => {
    const onClear = vi.fn();
    const user = userEvent.setup();
    render(
      <RecentSearchesList recent={['x']} onPick={() => {}} onClear={onClear} />,
    );
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});
