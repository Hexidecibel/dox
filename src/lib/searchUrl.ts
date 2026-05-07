/**
 * URL <-> SearchState codec for Document Search v2 (Phase 5).
 *
 * Single source of truth for how `SearchState` is serialized to a query
 * string. Both `<DocumentSearchPanel syncToUrl>` and the saved-search
 * payload go through here so a saved-search → URL → state round-trip
 * never drifts.
 *
 * URL spec (from the plan, Phase 6):
 *   /documents?q=darigold&supplier=acme&doc_type=coa,sds&date=last_30d&sort=newest&page=2
 *   /search?q=butter&type=all
 *   /search?q=butter&type=orders&customer=cust_123&status=pending
 *
 * Empty / default values are dropped from the URL so the canonical form
 * stays compact — `?q=foo` is preferred over `?q=foo&page=1&type=all`.
 */
import type {
  SearchDateBucket,
  SearchSort,
  SearchState,
  UniversalSearchType,
} from '../../shared/types';

const SORT_VALUES: SearchSort[] = ['relevance', 'newest', 'oldest', 'name'];
const DATE_VALUES: SearchDateBucket[] = [
  'any',
  'last_7d',
  'last_30d',
  'last_90d',
  'last_365d',
];
const TYPE_VALUES: UniversalSearchType[] = [
  'all',
  'documents',
  'orders',
  'customers',
  'bundles',
];

const MULTI_KEYS = ['supplier', 'doc_type', 'product', 'status', 'customer'] as const;
type MultiKey = (typeof MULTI_KEYS)[number];

function splitMulti(value: string | null): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function isOneOf<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  if (!value) return undefined;
  return (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

/** Decode a URLSearchParams (or string) into a SearchState. */
export function decodeSearchState(input: URLSearchParams | string): SearchState {
  const params =
    typeof input === 'string' ? new URLSearchParams(input) : input;

  const state: SearchState = { q: (params.get('q') ?? '').trim() };

  const type = isOneOf<UniversalSearchType>(params.get('type'), TYPE_VALUES);
  if (type) state.type = type;

  for (const key of MULTI_KEYS) {
    const parts = splitMulti(params.get(key));
    if (parts) state[key] = parts;
  }

  const date = isOneOf<SearchDateBucket>(params.get('date'), DATE_VALUES);
  if (date && date !== 'any') state.date = date;

  const sort = isOneOf<SearchSort>(params.get('sort'), SORT_VALUES);
  if (sort && sort !== 'relevance') state.sort = sort;

  const rawPage = params.get('page');
  if (rawPage) {
    const n = Number.parseInt(rawPage, 10);
    if (Number.isFinite(n) && n > 1) state.page = n;
  }

  return state;
}

/**
 * Encode SearchState back to URLSearchParams. Defaults and empties are
 * dropped so the URL stays clean. Multi-value facets are joined with
 * `,` to match the deep-link spec.
 */
export function encodeSearchState(state: SearchState): URLSearchParams {
  const params = new URLSearchParams();

  if (state.q && state.q.trim() !== '') params.set('q', state.q.trim());
  if (state.type && state.type !== 'documents') params.set('type', state.type);

  for (const key of MULTI_KEYS) {
    const arr = state[key as MultiKey];
    if (arr && arr.length > 0) params.set(key, arr.join(','));
  }

  if (state.date && state.date !== 'any') params.set('date', state.date);
  if (state.sort && state.sort !== 'relevance') params.set('sort', state.sort);
  if (state.page && state.page > 1) params.set('page', String(state.page));

  return params;
}

/** True if two states would serialize to the same URL. */
export function searchStatesEqual(a: SearchState, b: SearchState): boolean {
  return encodeSearchState(a).toString() === encodeSearchState(b).toString();
}

/** True if any non-`q` facet/filter is active. Used to gate "Clear filters". */
export function hasActiveFilters(state: SearchState): boolean {
  for (const key of MULTI_KEYS) {
    const arr = state[key as MultiKey];
    if (arr && arr.length > 0) return true;
  }
  if (state.date && state.date !== 'any') return true;
  if (state.sort && state.sort !== 'relevance') return true;
  return false;
}
