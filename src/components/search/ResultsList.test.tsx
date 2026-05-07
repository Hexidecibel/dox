import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResultsList } from './ResultsList';

describe('ResultsList', () => {
  it('shows the result count when not loading', () => {
    render(
      <ResultsList
        results={[{ id: '1' }, { id: '2' }]}
        total={142}
        page={1}
        pageSize={20}
        loading={false}
        onPageChange={() => {}}
        renderItem={(item) => <div key={item.id}>row {item.id}</div>}
      />,
    );
    expect(screen.getByText('142 results')).toBeInTheDocument();
  });

  it('uses singular "result" when total is 1', () => {
    render(
      <ResultsList
        results={[{ id: '1' }]}
        total={1}
        page={1}
        pageSize={20}
        loading={false}
        onPageChange={() => {}}
        renderItem={() => null}
      />,
    );
    expect(screen.getByText('1 result')).toBeInTheDocument();
  });

  it('shows a spinner when loading and no results yet', () => {
    render(
      <ResultsList
        results={[]}
        total={0}
        page={1}
        pageSize={20}
        loading={true}
        onPageChange={() => {}}
        renderItem={() => null}
      />,
    );
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('renders empty state when there are zero results and no error', () => {
    render(
      <ResultsList
        results={[]}
        total={0}
        page={1}
        pageSize={20}
        loading={false}
        onPageChange={() => {}}
        emptyTitle="Nothing found"
        emptyDescription="Adjust filters."
        renderItem={() => null}
      />,
    );
    expect(screen.getByText('Nothing found')).toBeInTheDocument();
  });

  it('renders error and skips empty state', () => {
    render(
      <ResultsList
        results={[]}
        total={0}
        page={1}
        pageSize={20}
        loading={false}
        error="Server is on fire"
        onPageChange={() => {}}
        emptyTitle="Nothing found"
        renderItem={() => null}
      />,
    );
    expect(screen.getByText('Server is on fire')).toBeInTheDocument();
    expect(screen.queryByText('Nothing found')).not.toBeInTheDocument();
  });

  it('shows pagination when total > pageSize and emits onPageChange', async () => {
    const onPageChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ResultsList
        results={[{ id: '1' }]}
        total={50}
        page={1}
        pageSize={20}
        loading={false}
        onPageChange={onPageChange}
        renderItem={() => null}
      />,
    );
    // MUI renders one button per page; click "page 2".
    const page2 = screen.getByRole('button', { name: /Go to page 2/i });
    await user.click(page2);
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it('hides pagination when total fits on one page', () => {
    render(
      <ResultsList
        results={[{ id: '1' }]}
        total={5}
        page={1}
        pageSize={20}
        loading={false}
        onPageChange={() => {}}
        renderItem={() => null}
      />,
    );
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
});
