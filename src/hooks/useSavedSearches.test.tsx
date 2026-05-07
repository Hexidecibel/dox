import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSavedSearches } from './useSavedSearches';

vi.mock('../lib/api', () => {
  const list = vi.fn();
  const create = vi.fn();
  const update = vi.fn();
  const del = vi.fn();
  return {
    api: {
      search: {
        saved: { list, create, update, delete: del },
      },
    },
    __mocks: { list, create, update, del },
  };
});

import * as apiModule from '../lib/api';
const mocks = (apiModule as unknown as { __mocks: { list: any; create: any; update: any; del: any } }).__mocks;

const ROW = (over: Partial<{ id: string; name: string }> = {}) => ({
  id: over.id ?? 'ss_1',
  user_id: 'u_1',
  tenant_id: 't_1',
  name: over.name ?? 'My search',
  query: { q: 'foo' },
  scope: 'personal' as const,
  created_at: '2026-05-01T00:00:00Z',
  updated_at: '2026-05-01T00:00:00Z',
});

describe('useSavedSearches', () => {
  beforeEach(() => {
    mocks.list.mockReset();
    mocks.create.mockReset();
    mocks.update.mockReset();
    mocks.del.mockReset();
  });

  it('loads saved searches on mount', async () => {
    mocks.list.mockResolvedValue({ saved_searches: [ROW()] });
    const { result } = renderHook(() => useSavedSearches());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.saved).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it('captures load errors', async () => {
    mocks.list.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useSavedSearches());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('boom');
    expect(result.current.saved).toEqual([]);
  });

  it('create prepends the new row to the list', async () => {
    mocks.list.mockResolvedValue({ saved_searches: [ROW({ id: 'ss_1', name: 'old' })] });
    mocks.create.mockResolvedValue({ saved_search: ROW({ id: 'ss_2', name: 'new' }) });
    const { result } = renderHook(() => useSavedSearches());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.create({ name: 'new', query: { q: 'foo' } });
    });
    expect(result.current.saved.map((s) => s.id)).toEqual(['ss_2', 'ss_1']);
  });

  it('update replaces the row by id', async () => {
    mocks.list.mockResolvedValue({ saved_searches: [ROW({ id: 'ss_1', name: 'old' })] });
    mocks.update.mockResolvedValue({ saved_search: ROW({ id: 'ss_1', name: 'updated' }) });
    const { result } = renderHook(() => useSavedSearches());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.update('ss_1', { name: 'updated' });
    });
    expect(result.current.saved[0].name).toBe('updated');
  });

  it('remove drops the row by id', async () => {
    mocks.list.mockResolvedValue({
      saved_searches: [ROW({ id: 'ss_1' }), ROW({ id: 'ss_2' })],
    });
    mocks.del.mockResolvedValue({ success: true });
    const { result } = renderHook(() => useSavedSearches());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.remove('ss_1');
    });
    expect(result.current.saved.map((s) => s.id)).toEqual(['ss_2']);
  });

  it('refresh re-fetches the server list', async () => {
    mocks.list.mockResolvedValueOnce({ saved_searches: [] });
    const { result } = renderHook(() => useSavedSearches());
    await waitFor(() => expect(result.current.loading).toBe(false));
    mocks.list.mockResolvedValueOnce({ saved_searches: [ROW()] });
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.saved).toHaveLength(1);
  });
});
