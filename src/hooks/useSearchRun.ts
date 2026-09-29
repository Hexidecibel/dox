import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { queryKey, type SearchQuery } from '../../shared/searchQuery';
import type { SearchQueryResponse } from '../../shared/types';

/**
 * Runs the one search query (POST /api/search/query) for the workspace.
 *
 *   - ABORT: a newer query abandons the request still in flight, so a slow
 *     answer to what was typed three keystrokes ago never lands on the page.
 *   - DE-DUPE: a query identical to the one already in flight (same canonical
 *     `queryKey`, tenant and page) is not sent twice.
 *   - A short-lived answer cache: going back to a query answered in the last
 *     30 seconds is instant and costs no request.
 *
 * The caller debounces the typed text; everything else (chips, facets, pages)
 * is sent at once.
 */
export interface SearchRunResult {
  data: SearchQueryResponse | null;
  /** The text the current `data` answered (the box text it was read from). */
  answeredText: string | null;
  loading: boolean;
  error: string | null;
}

const CACHE_MS = 30_000;
const CACHE_MAX = 20;

export function useSearchRun(opts: {
  query: SearchQuery;
  tenantId?: string;
  enabled: boolean;
  limit: number;
  offset: number;
}): SearchRunResult {
  const { query, tenantId, enabled, limit, offset } = opts;
  const [state, setState] = useState<SearchRunResult>({ data: null, answeredText: null, loading: false, error: null });
  const inflight = useRef<{ key: string; controller: AbortController } | null>(null);
  const cache = useRef(new Map<string, { at: number; data: SearchQueryResponse }>());

  const key = enabled ? `${queryKey(query)}|${tenantId ?? ''}|${limit}|${offset}` : null;

  useEffect(() => {
    if (!key) {
      inflight.current?.controller.abort();
      inflight.current = null;
      setState({ data: null, answeredText: null, loading: false, error: null });
      return;
    }
    if (inflight.current?.key === key) return; // the same search is already on its way
    const hit = cache.current.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      inflight.current?.controller.abort();
      inflight.current = null;
      setState({ data: hit.data, answeredText: query.text.trim(), loading: false, error: null });
      return;
    }
    inflight.current?.controller.abort();
    const controller = new AbortController();
    inflight.current = { key, controller };
    setState((s) => ({ ...s, loading: true, error: null }));
    const sentText = query.text.trim();
    api.search
      .query(
        {
          query: { ...query, view: { entity: 'documents', ...(query.view.sort ? { sort: query.view.sort } : {}) } },
          tenant_id: tenantId,
          limit,
          offset,
          facets: true,
          interpret: true,
        },
        controller.signal,
      )
      .then((res) => {
        if (controller.signal.aborted) return;
        cache.current.set(key, { at: Date.now(), data: res });
        if (cache.current.size > CACHE_MAX) cache.current.delete(cache.current.keys().next().value as string);
        setState({ data: res, answeredText: sentText, loading: false, error: null });
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setState({ data: null, answeredText: null, loading: false, error: e instanceof Error ? e.message : 'Search failed' });
      })
      .finally(() => {
        if (inflight.current?.controller === controller) inflight.current = null;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the canonical input
  }, [key]);

  useEffect(() => () => inflight.current?.controller.abort(), []);

  return state;
}
