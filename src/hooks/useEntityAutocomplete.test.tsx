import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEntityAutocomplete } from './useEntityAutocomplete';

// Promise.resolve() flushes one microtask round; React state updates
// resolved by an awaited promise inside the hook need at least one of
// these to land. Two are belt-and-braces — covers the
// .then().finally() chain in the hook.
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useEntityAutocomplete', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires an initial empty-string fetch on mount by default', async () => {
    const fetcher = vi.fn().mockResolvedValue([{ id: '1' }]);
    const { result } = renderHook(() => useEntityAutocomplete(fetcher, { delayMs: 100 }));
    // Debounce window must elapse before the initial fetch fires.
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    await flushMicrotasks();
    expect(fetcher).toHaveBeenCalledWith('');
    expect(result.current.results).toEqual([{ id: '1' }]);
  });

  it('does not fetch on mount when fetchOnMount=false', async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    renderHook(() => useEntityAutocomplete(fetcher, { delayMs: 100, fetchOnMount: false }));
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('debounces typing — only the final value triggers a fetch', async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const { result } = renderHook(() => useEntityAutocomplete(fetcher, { delayMs: 200, fetchOnMount: false }));

    act(() => result.current.setQuery('a'));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => result.current.setQuery('ab'));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => result.current.setQuery('abc'));
    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('abc');
  });

  it('respects minLength', async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const { result } = renderHook(() =>
      useEntityAutocomplete(fetcher, { delayMs: 100, minLength: 2, fetchOnMount: false }),
    );
    act(() => result.current.setQuery('a'));
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(fetcher).not.toHaveBeenCalled();

    act(() => result.current.setQuery('ab'));
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(fetcher).toHaveBeenCalledWith('ab');
  });

  it('drops stale responses (race protection)', async () => {
    const resolvers: Array<(rows: { id: string }[]) => void> = [];
    const fetcher = vi.fn().mockImplementation(
      () => new Promise<{ id: string }[]>((resolve) => resolvers.push(resolve)),
    );
    const { result } = renderHook(() =>
      useEntityAutocomplete(fetcher, { delayMs: 50, fetchOnMount: false }),
    );

    act(() => result.current.setQuery('first'));
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    act(() => result.current.setQuery('second'));
    await act(async () => {
      vi.advanceTimersByTime(50);
    });

    // Resolve the SECOND request first.
    await act(async () => {
      resolvers[1]([{ id: 'second' }]);
    });
    expect(result.current.results).toEqual([{ id: 'second' }]);

    // Then resolve the stale FIRST request — should be ignored.
    await act(async () => {
      resolvers[0]([{ id: 'first' }]);
    });
    expect(result.current.results).toEqual([{ id: 'second' }]);
  });

  it('captures fetch errors', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('500'));
    const { result } = renderHook(() =>
      useEntityAutocomplete(fetcher, { delayMs: 50, fetchOnMount: true }),
    );
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    await flushMicrotasks();
    expect(result.current.error).toBe('500');
    expect(result.current.results).toEqual([]);
  });
});
