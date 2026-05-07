import { useEffect, useRef, useState } from 'react';
import { useDebouncedValue } from './useDebouncedValue';

/**
 * Generic debounced server-search hook for facet-style autocompletes
 * (suppliers, products, customers, doc-types).
 *
 * Wraps any "give me a `?search=` slice" function with:
 *   - 300ms input debounce (via `useDebouncedValue`).
 *   - Race-protection: a stale request that resolves *after* a newer
 *     one is silently dropped.
 *   - Loading + error state.
 *
 * Consumers feed it a `fetcher` typed `(query: string) => Promise<T[]>`
 * so callers stay free to project / shape the results however they want.
 * The MUI `Autocomplete` pattern at `src/components/ProductLinker.tsx`
 * is the visual prior art.
 */
export interface UseEntityAutocompleteOptions {
  /** Debounce delay (ms). Default 300. */
  delayMs?: number;
  /**
   * Don't fire a fetch when the trimmed input is shorter than this.
   * Default 0 (fire on every change, including the empty-string load).
   */
  minLength?: number;
  /**
   * If true (default), fire a fetch with `''` on initial mount so the
   * dropdown can show recently-used / top-N rows before the user types.
   */
  fetchOnMount?: boolean;
}

export interface UseEntityAutocompleteResult<T> {
  query: string;
  setQuery: (q: string) => void;
  results: T[];
  loading: boolean;
  error: string | null;
}

export function useEntityAutocomplete<T>(
  fetcher: (query: string) => Promise<T[]>,
  options: UseEntityAutocompleteOptions = {},
): UseEntityAutocompleteResult<T> {
  const { delayMs = 300, minLength = 0, fetchOnMount = true } = options;

  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query, delayMs);

  const [results, setResults] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tracks the latest invocation; older ones are discarded on resolve.
  const reqIdRef = useRef(0);
  const hasFetchedRef = useRef(false);

  useEffect(() => {
    const trimmed = debounced.trim();
    if (!fetchOnMount && !hasFetchedRef.current && trimmed.length === 0) {
      // Defer the initial empty-string fetch until the user types.
      return;
    }
    if (trimmed.length < minLength) {
      setResults([]);
      setLoading(false);
      return;
    }

    const id = ++reqIdRef.current;
    hasFetchedRef.current = true;
    setLoading(true);
    setError(null);

    fetcher(trimmed)
      .then((rows) => {
        if (id !== reqIdRef.current) return;
        setResults(rows);
      })
      .catch((e: unknown) => {
        if (id !== reqIdRef.current) return;
        setError(e instanceof Error ? e.message : 'Search failed');
        setResults([]);
      })
      .finally(() => {
        if (id !== reqIdRef.current) return;
        setLoading(false);
      });
  }, [debounced, fetcher, minLength, fetchOnMount]);

  return { query, setQuery, results, loading, error };
}
