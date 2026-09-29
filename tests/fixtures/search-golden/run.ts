/**
 * Run a question through the REAL search endpoints, in-worker: the same
 * handlers the Pages Functions router calls, with a user on `context.data`.
 */

import { env } from 'cloudflare:test';
import { onRequestPost as queryHandler } from '../../../functions/api/search/query';
import { onRequestPost as interpretHandler } from '../../../functions/api/search/interpret';
import type { Clause, SearchQuery } from '../../../shared/searchQuery';
import type { SearchInterpretResponse, SearchQueryResponse } from '../../../shared/types';

export type TestUser = { id: string; role: string; tenant_id: string | null };

function ctx(path: string, body: unknown, user: TestUser): any {
  return {
    request: new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    env, data: { user }, params: {},
    waitUntil: () => {}, passThroughOnException: () => {}, next: async () => new Response(null), functionPath: path,
  };
}

export interface Asked {
  status: number;
  interpretStatus: number;
  body: SearchQueryResponse & { error?: string };
  interpreted: SearchInterpretResponse | null;
}

/** POST /api/search/interpret (when there is text) and POST /api/search/query, as `user`. */
export async function ask(user: TestUser, q: string, clauses: Clause[] = [], tenantId?: string): Promise<Asked> {
  let interpreted: SearchInterpretResponse | null = null;
  let interpretStatus = 0;
  if (q.trim()) {
    const ir = await interpretHandler(ctx('/api/search/interpret', { text: q, ...(tenantId ? { tenant_id: tenantId } : {}) }, user));
    interpretStatus = ir.status;
    if (ir.status === 200) interpreted = (await ir.json()) as SearchInterpretResponse;
  }
  const query: SearchQuery = { v: 1, text: q, clauses, view: { entity: 'documents' } };
  const res = await queryHandler(ctx('/api/search/query', { query, interpret: true, limit: 200, ...(tenantId ? { tenant_id: tenantId } : {}) }, user));
  return { status: res.status, interpretStatus, body: (await res.json()) as Asked['body'], interpreted };
}

/** The ids a response places in each band. */
export function bands(body: SearchQueryResponse): { covering: string[]; likely: string[]; nearby: string[]; all: string[] } {
  const docs = body.documents ?? [];
  const by = (s: string) => docs.filter((d) => d.match_status === s).map((d) => d.id).sort();
  return {
    covering: by('covering'),
    likely: by('likely_covering'),
    nearby: by('candidate_not_matching'),
    all: docs.map((d) => d.id),
  };
}

/** Does "produced in april" read as a production-date clause yet? (the parallel reader branch) */
export async function monthPhrasesSupported(user: TestUser): Promise<boolean> {
  const r = await ask(user, 'produced in april');
  return !!r.interpreted?.clauses.some((c) => c.field === 'date' || c.field === ('production_date' as never));
}

/** Do product words read as a product chip yet? (the parallel reader branch) */
export async function productWordsSupported(user: TestUser): Promise<boolean> {
  const r = await ask(user, 'unsalted butter');
  return !!r.interpreted?.clauses.some((c) => c.field === 'product');
}
