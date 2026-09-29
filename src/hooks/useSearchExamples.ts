/**
 * The "Try" chips: examples built from THIS tenant's documents
 * (GET /api/search/examples), each verified server-side before it is offered.
 *
 * Falls back to `fallback` (the static chips) when the tenant has nothing on
 * file (`examples: []`). Shows NO examples when a super_admin has not chosen
 * an organization (not asked; the endpoint would say 400) or when the request
 * fails — an example row is a convenience and never an error on the page.
 */

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { SearchExample } from '../../shared/types';

export interface SearchExamplesState {
  examples: SearchExample[];
  /** True when the examples came from this tenant (not the static fallback). */
  fromTenant: boolean;
}

export function useSearchExamples(tenantId: string | undefined, enabled: boolean, fallback: string[]): SearchExamplesState {
  const [state, setState] = useState<{ key: string; examples: SearchExample[]; failed: boolean } | null>(null);
  const key = `${tenantId ?? ''}`;

  useEffect(() => {
    if (!enabled) return;
    const c = new AbortController();
    api.search
      .examples(tenantId, c.signal)
      .then((r) => {
        if (!c.signal.aborted) setState({ key, examples: Array.isArray(r?.examples) ? r.examples : [], failed: false });
      })
      .catch(() => {
        if (!c.signal.aborted) setState({ key, examples: [], failed: true });
      });
    return () => c.abort();
  }, [tenantId, enabled, key]);

  const current = enabled && state && state.key === key ? state : null;
  // Not asked, still loading, or failed: no row, rather than one tenant's chips flashing on another's page.
  if (!current || current.failed) return { examples: [], fromTenant: false };
  if (current.examples.length) return { examples: current.examples, fromTenant: true };
  return { examples: fallback.map((text) => ({ text, kind: 'lot_exact' as const })), fromTenant: false };
}
