import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { SearchState } from '../../shared/types';
import {
  decodeSearchState,
  encodeSearchState,
  searchStatesEqual,
} from '../lib/searchUrl';

/**
 * Two-way bind a `SearchState` to react-router's `useSearchParams`.
 *
 * - `state` is derived from the URL on every render.
 * - `setState` accepts a partial patch (or a full state) and merges it
 *   onto the current state before re-encoding to the URL. Passing
 *   `{ q: '' }` and dropping all filters resets to a clean URL.
 * - `replace` controls whether the URL change pushes a new history
 *   entry (the default — so back-button works) or replaces the current
 *   one (use for keystroke updates if you ever wire `q` directly).
 *
 * State changes that round-trip to the same URL are skipped to avoid
 * unnecessary history entries.
 */
export type SearchStatePatch = Partial<SearchState>;

export interface UseSearchParamsStateResult {
  state: SearchState;
  setState: (patch: SearchStatePatch | SearchState, options?: { replace?: boolean }) => void;
  reset: () => void;
}

export function useSearchParamsState(): UseSearchParamsStateResult {
  const [searchParams, setSearchParams] = useSearchParams();

  const state = useMemo(() => decodeSearchState(searchParams), [searchParams]);

  const setState = useCallback(
    (patch: SearchStatePatch | SearchState, options?: { replace?: boolean }) => {
      setSearchParams(
        (prev) => {
          // Decode fresh from the params object react-router hands us so
          // concurrent setState calls don't clobber each other's patches.
          const current = decodeSearchState(prev);
          const next: SearchState = { ...current, ...patch };
          if (searchStatesEqual(current, next)) return prev;
          return encodeSearchState(next);
        },
        { replace: options?.replace ?? false },
      );
    },
    [setSearchParams],
  );

  const reset = useCallback(() => {
    setSearchParams(new URLSearchParams(), { replace: false });
  }, [setSearchParams]);

  return { state, setState, reset };
}
