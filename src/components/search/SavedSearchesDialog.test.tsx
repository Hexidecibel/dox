import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SavedSearchesDialog } from './SavedSearchesDialog';
import type { SavedSearch } from '../../../shared/types';

const ROW = (over: Partial<SavedSearch> = {}): SavedSearch => ({
  id: over.id ?? 'ss_1',
  user_id: 'u_1',
  tenant_id: 't_1',
  name: over.name ?? 'My search',
  query: over.query ?? { q: 'darigold' },
  scope: 'personal',
  created_at: '2026-05-01T00:00:00Z',
  updated_at: '2026-05-01T00:00:00Z',
});

describe('SavedSearchesDialog', () => {
  it('renders the empty hint when nothing saved', () => {
    render(
      <SavedSearchesDialog
        open
        onClose={() => {}}
        currentState={{ q: 'foo' }}
        saved={[]}
        onSave={async () => {}}
        onLoad={() => {}}
        onDelete={async () => {}}
      />,
    );
    expect(screen.getByText(/none yet/i)).toBeInTheDocument();
  });

  it('Save button is disabled until a name is typed', () => {
    render(
      <SavedSearchesDialog
        open
        onClose={() => {}}
        currentState={{ q: 'foo' }}
        saved={[]}
        onSave={async () => {}}
        onLoad={() => {}}
        onDelete={async () => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('Saving fires onSave with the trimmed name', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <SavedSearchesDialog
        open
        onClose={() => {}}
        currentState={{ q: 'foo' }}
        saved={[]}
        onSave={onSave}
        onLoad={() => {}}
        onDelete={async () => {}}
      />,
    );
    const input = screen.getByPlaceholderText(/Pending COAs/);
    await user.type(input, '  Q4 specs  ');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith('Q4 specs');
  });

  it('captures save errors', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('UNIQUE failed'));
    const user = userEvent.setup();
    render(
      <SavedSearchesDialog
        open
        onClose={() => {}}
        currentState={{ q: 'foo' }}
        saved={[]}
        onSave={onSave}
        onLoad={() => {}}
        onDelete={async () => {}}
      />,
    );
    await user.type(screen.getByPlaceholderText(/Pending COAs/), 'dup');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('UNIQUE failed')).toBeInTheDocument();
  });

  it('clicking a saved row loads and closes', async () => {
    const onLoad = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    const row = ROW({ name: 'Acme', query: { q: 'acme' } });
    render(
      <SavedSearchesDialog
        open
        onClose={onClose}
        currentState={{ q: '' }}
        saved={[row]}
        onSave={async () => {}}
        onLoad={onLoad}
        onDelete={async () => {}}
      />,
    );
    await user.click(screen.getByText('Acme'));
    expect(onLoad).toHaveBeenCalledWith(row);
    expect(onClose).toHaveBeenCalled();
  });

  it('per-row delete fires onDelete with the id', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <SavedSearchesDialog
        open
        onClose={() => {}}
        currentState={{ q: '' }}
        saved={[ROW({ id: 'ss_1', name: 'foo' })]}
        onSave={async () => {}}
        onLoad={() => {}}
        onDelete={onDelete}
      />,
    );
    await user.click(screen.getByLabelText('delete foo'));
    expect(onDelete).toHaveBeenCalledWith('ss_1');
  });
});
