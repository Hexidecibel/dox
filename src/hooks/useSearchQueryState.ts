import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { EMPTY_QUERY, queriesEqual, type SearchQuery } from '../../shared/searchQuery';
import { decodeDocumentsQuery, encodeDocumentsQuery } from '../lib/searchUrl';

/**
 * Two-way bind the one query model (shared/searchQuery.ts) to the URL.
 *
 * The URL is the state: `query` is decoded on every render (old
 * `supplier=…&doc_type=…` links decode to the same clauses) and `setQuery`
 * writes the canonical encoding. A change that encodes to the same URL writes
 * nothing, so there is no empty history entry.
 */
export interface UseSearchQueryStateResult {
  query: SearchQuery;
  setQuery: (next: SearchQuery | ((prev: SearchQuery) => SearchQuery), options?: { replace?: boolean }) => void;
}

export function useSearchQueryState(): UseSearchQueryStateResult {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = useMemo(() => decodeDocumentsQuery(searchParams), [searchParams]);

  const setQuery = useCallback<UseSearchQueryStateResult['setQuery']>(
    (next, options) => {
      setSearchParams(
        (prev) => {
          const current = decodeDocumentsQuery(prev);
          const target = typeof next === 'function' ? next(current) : next;
          if (queriesEqual(current, target)) return prev;
          return encodeDocumentsQuery(target);
        },
        { replace: options?.replace ?? false },
      );
    },
    [setSearchParams],
  );

  return { query, setQuery };
}

export { EMPTY_QUERY };
