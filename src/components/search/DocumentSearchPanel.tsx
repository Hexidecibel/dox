import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Box, Stack } from '@mui/material';
import { SearchBar } from './SearchBar';
import { FacetSidebar } from './FacetSidebar';
import { ActiveFilterChips } from './ActiveFilterChips';
import { SortMenu } from './SortMenu';
import { ResultsList } from './ResultsList';
import { ResultCardDocument } from './ResultCardDocument';
import { CoverageResults } from './CoverageResults';
import { SavedSearchesDialog } from './SavedSearchesDialog';
import { useSearchQueryState } from '../../hooks/useSearchQueryState';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useRecentSearches } from '../../hooks/useRecentSearches';
import { useSavedSearches } from '../../hooks/useSavedSearches';
import { api } from '../../lib/api';
import {
  EMPTY_QUERY,
  queryKey,
  savedPayloadToQuery,
  type SearchQuery,
} from '../../../shared/searchQuery';
import type { FacetField } from '../../../shared/searchFields';
import type {
  FacetCount,
  SearchQueryResponse,
  SearchSort,
  UniversalSearchDocument,
} from '../../../shared/types';

/**
 * The Documents search panel, on the one query model (search redesign
 * Phase 1).
 *
 * EVERY clause reaches the server. The panel used to send only the first
 * supplier and the first type, never the product or status, and the server
 * ignored the date it did send — so supplier A → butter → COA → September
 * narrowed on supplier A alone (AJ's I1). It now sends the whole query to
 * POST /api/search/query, where supplier, type, product, status and upload
 * date all compose, in any order, with facet counts over the narrowed set.
 *
 * And the screen answers the question it is asked (I3): typing a lot, a
 * production date, a PO or an invoice here comes back as the coverage answer
 * — covering, likely, nearby, "no document on file covers …" — rather than
 * the nearest text hits with nothing saying none of them is the answer.
 *
 * `syncToUrl` (default true): the URL is the state, so deep links and the
 * back button work; an embedded use can pass false and keep state locally.
 */
const PAGE_SIZE = 20;
/** Keystrokes inside this window are one search. */
const DEBOUNCE_MS = 250;

export interface DocumentSearchPanelProps {
  syncToUrl?: boolean;
  /** Optional tenant override for super_admin context. */
  tenantId?: string;
  /**
   * Optional override for clicking a result row. Defaults to navigating
   * to /documents/:id via React Router.
   */
  onOpen?: (doc: UniversalSearchDocument) => void;
}

const EMPTY_RESPONSE: Pick<SearchQueryResponse, 'documents' | 'total' | 'labels'> & Partial<SearchQueryResponse> = {
  documents: [],
  total: 0,
  labels: {},
};

export function DocumentSearchPanel({ syncToUrl = true, tenantId, onOpen }: DocumentSearchPanelProps) {
  const urlBound = useSearchQueryState();
  const [localQuery, setLocalQuery] = useState<SearchQuery>(EMPTY_QUERY);

  const query: SearchQuery = syncToUrl ? urlBound.query : localQuery;
  const setQuery = useCallback(
    (next: SearchQuery, options?: { replace?: boolean }) => {
      if (syncToUrl) urlBound.setQuery(next, options);
      else setLocalQuery(next);
    },
    [syncToUrl, urlBound],
  );

  const [snap, setSnap] = useState<typeof EMPTY_RESPONSE>(EMPTY_RESPONSE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const debouncedText = useDebouncedValue(query.text, DEBOUNCE_MS);
  const recent = useRecentSearches();
  const saved = useSavedSearches();
  const [savedOpen, setSavedOpen] = useState(false);

  const page = query.view.page ?? 1;
  const sort: SearchSort = query.view.sort ?? 'relevance';

  // The query as it is sent: the typed text debounced, everything else live.
  const sent = useMemo<SearchQuery>(() => ({ ...query, text: debouncedText }), [query, debouncedText]);
  const fetchKey = `${queryKey(sent)}|${tenantId ?? ''}`;

  // In flight: the key being fetched and the controller that can abandon it.
  const inflight = useRef<{ key: string; controller: AbortController } | null>(null);

  useEffect(() => {
    if (inflight.current?.key === fetchKey) return; // the same search is already on its way
    inflight.current?.controller.abort();
    const controller = new AbortController();
    inflight.current = { key: fetchKey, controller };
    setLoading(true);
    setError(null);
    api.search
      .query(
        {
          query: { ...sent, view: { entity: 'documents', ...(sent.view.sort ? { sort: sent.view.sort } : {}) } },
          tenant_id: tenantId,
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
          facets: true,
          interpret: true,
        },
        controller.signal,
      )
      .then((res) => {
        if (controller.signal.aborted) return;
        setSnap(res);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : 'Search failed');
        setSnap(EMPTY_RESPONSE);
      })
      .finally(() => {
        if (inflight.current?.controller === controller) {
          inflight.current = null;
          setLoading(false);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchKey is the canonical input
  }, [fetchKey]);

  useEffect(() => () => inflight.current?.controller.abort(), []);

  const handleSubmit = useCallback(
    (q: string) => {
      const trimmed = q.trim();
      if (trimmed) recent.push(trimmed);
      setQuery({ ...query, text: trimmed, view: { ...query.view, page: undefined } });
    },
    [recent, setQuery, query],
  );

  const handleSaveCurrent = useCallback(
    async (name: string) => {
      // The v1 AST is stored as is; old saved searches still load (savedPayloadToQuery).
      await saved.create({ name, query: query as unknown as Record<string, unknown> });
    },
    [saved, query],
  );

  const handleLoadSaved = useCallback(
    (s: { query: Record<string, unknown> }) => {
      // Saved searches are absolute: replace, never merge.
      setQuery(savedPayloadToQuery(s.query));
    },
    [setQuery],
  );

  const facets = (snap.facets ?? {}) as Partial<Record<FacetField, FacetCount[]>>;
  const coverageAnswer = !!snap.coverage && snap.coverage !== 'unconstrained';

  return (
    <Box>
      <SearchBar
        value={query.text}
        onChange={(q) => setQuery({ ...query, text: q, view: { ...query.view, page: undefined } }, { replace: true })}
        onSubmit={handleSubmit}
        recent={recent.recent}
        onRecentPick={(q) => setQuery({ ...query, text: q, view: { ...query.view, page: undefined } })}
        onRecentRemove={recent.remove}
        onRecentClear={recent.clear}
        onSavedClick={() => setSavedOpen(true)}
      />
      <ActiveFilterChips query={query} facets={facets} labels={snap.labels} onChange={setQuery} />
      {!!snap.keys_pending && (
        <Alert severity="info" sx={{ mb: 1.5 }}>
          {snap.keys_pending} document{snap.keys_pending === 1 ? ' is' : 's are'} still being indexed for PO, invoice and date search, so
          this answer also checked every document in the current filters directly.
        </Alert>
      )}
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems="flex-start">
        <FacetSidebar query={query} facets={facets} onChange={setQuery} loading={loading} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {coverageAnswer ? (
            <Box data-testid="documents-coverage-answer">
              <CoverageResults
                documents={snap.documents ?? []}
                coverage={snap.coverage}
                constraints={snap.constraints}
                dropped_constraints={snap.dropped_constraints}
                coverage_summary={snap.coverage_summary}
                unreviewed_candidates={snap.unreviewed_candidates}
                coverage_scan_truncated={snap.coverage_scan_truncated}
              />
            </Box>
          ) : (
            <ResultsList
              results={snap.documents}
              total={snap.total}
              page={page}
              pageSize={PAGE_SIZE}
              loading={loading}
              error={error}
              onPageChange={(p) => setQuery({ ...query, view: { ...query.view, page: p > 1 ? p : undefined } })}
              header={
                <SortMenu
                  value={sort}
                  onChange={(next) => setQuery({ ...query, view: { ...query.view, sort: next === 'relevance' ? undefined : next, page: undefined } })}
                />
              }
              renderItem={(doc) => <ResultCardDocument key={String(doc.id)} doc={doc} onOpen={onOpen} />}
            />
          )}
          {coverageAnswer && error && <Alert severity="error">{error}</Alert>}
        </Box>
      </Stack>
      <SavedSearchesDialog
        open={savedOpen}
        onClose={() => setSavedOpen(false)}
        currentState={{ q: query.text }}
        currentPreview={queryKey(query)}
        saved={saved.saved}
        onSave={handleSaveCurrent}
        onLoad={handleLoadSaved}
        onDelete={saved.remove}
      />
    </Box>
  );
}
