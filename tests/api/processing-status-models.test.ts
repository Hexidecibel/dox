/**
 * GET /api/admin/processing-status — resolved tag -> model mapping.
 *
 * Why this block exists at all: `advertisedModels` proves the router answered,
 * not that we are running on the model we WANTED. Each semantic tag is an
 * ordered preference chain, and silently dropping to a lower entry is a real
 * quality event — a stale router hostname once put production on a
 * lower-precision backend for an extended period with nothing alerting,
 * because the degradation was visible only in worker logs.
 *
 * Contract under test:
 *   1. Every tag in MODEL_CHAINS appears with the model it would use now.
 *   2. Top-of-chain everywhere -> degraded=false.
 *   3. Only a lower entry advertised -> that tag AND the top-level flag go
 *      degraded, and the response still names what was preferred.
 *   4. A chain with nothing available is reported (source='unavailable'),
 *      never thrown — a dead backend must not 500 the status page.
 *   5. The probe is cheap: all tags share ONE cached /v1/models lookup.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData } from '../helpers/db';
import { onRequestGet as processingStatus } from '../../functions/api/admin/processing-status';
import { MODEL_CHAINS, invalidateModelCache } from '../../functions/lib/models';
import type { ProcessingStatusResponse } from '../../shared/types';

const db = env.DB;
const QWEN_URL = 'https://router.test';

beforeAll(async () => {
  await seedTestData(db);
}, 30_000);

/** Stub the router: /v1/models returns `ids`, /running 404s. */
function stubRouter(ids: string[] | 'fail') {
  const calls = { models: 0 };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/v1/models')) {
      calls.models++;
      if (ids === 'fail') throw new Error('connection refused');
      return new Response(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id })) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/running')) return new Response('not found', { status: 404 });
    throw new Error(`unexpected fetch: ${url}`);
  });
  return calls;
}

async function getStatus(): Promise<ProcessingStatusResponse> {
  const request = new Request('http://localhost/api/admin/processing-status');
  const res = await processingStatus({
    request,
    env: { ...env, QWEN_URL },
    data: { user: { id: 'user-super-admin', role: 'super_admin', tenant_id: null } },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/admin/processing-status',
  } as unknown as Parameters<typeof processingStatus>[0]);
  expect(res.status).toBe(200);
  return (await res.json()) as ProcessingStatusResponse;
}

beforeEach(() => {
  invalidateModelCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  invalidateModelCache();
});

describe('processing-status — models block', () => {
  it('reports every tag with its resolved model, undegraded on a healthy router', async () => {
    // Advertise the top choice of every chain.
    const tops = Object.values(MODEL_CHAINS).map((chain) => chain[0]);
    stubRouter([...new Set(tops)]);

    const body = await getStatus();

    expect(body.models.degraded).toBe(false);
    expect(body.models.tags.map((t) => t.tag).sort()).toEqual(Object.keys(MODEL_CHAINS).sort());
    for (const t of body.models.tags) {
      expect(t.model).toBe(t.preferred);
      expect(t.degraded).toBe(false);
      expect(t.source).toBe('health');
      expect(t.error).toBeNull();
    }
  });

  it('flags degradation when a tag falls back to a lower chain entry', async () => {
    // `best` has >1 entry; advertise only its LAST one.
    const bestChain = MODEL_CHAINS.best;
    expect(bestChain.length).toBeGreaterThan(1);
    const fallback = bestChain[bestChain.length - 1];
    // Keep every other tag RESOLVABLE (so nothing throws and the assertions
    // below are about degradation, not unavailability) while making sure
    // best's top choice is not advertised — note the chains deliberately share
    // entries, so "advertise the other tags' tops" would smuggle it back in.
    const others = Object.entries(MODEL_CHAINS)
      .filter(([tag]) => tag !== 'best')
      .map(([, chain]) => chain.find((m) => m !== bestChain[0]))
      .filter((m): m is string => !!m);
    stubRouter([...new Set([fallback, ...others])]);

    const body = await getStatus();

    const best = body.models.tags.find((t) => t.tag === 'best')!;
    expect(best.model).toBe(fallback);
    expect(best.preferred).toBe(bestChain[0]);
    expect(best.degraded).toBe(true);
    expect(best.chain).toEqual(bestChain);
    // One degraded tag is enough to raise the top-level flag.
    expect(body.models.degraded).toBe(true);
  });

  it('reports an entirely-unavailable chain instead of 500ing the page', async () => {
    stubRouter(['something-nobody-asked-for']);

    const body = await getStatus();

    expect(body.models.degraded).toBe(true);
    for (const t of body.models.tags) {
      expect(t.source).toBe('unavailable');
      expect(t.model).toBeNull();
      expect(t.error).toBeTruthy();
    }
    // The rest of the page still rendered.
    expect(body.queue).toBeDefined();
    expect(body.checkedAt).toBeTruthy();
  });

  it('treats an unreachable router as unknown, not empty', async () => {
    stubRouter('fail');

    const body = await getStatus();

    expect(body.qwen.reachable).toBe(false);
    for (const t of body.models.tags) {
      // Availability unknown -> attempt the top preference, do not hard-fail.
      expect(t.source).toBe('unverified');
      expect(t.model).toBe(t.preferred);
      expect(t.degraded).toBe(false);
    }
    expect(body.models.degraded).toBe(false);
  });

  it('does not become a health-check storm — all tags share one cached lookup', async () => {
    const tops = Object.values(MODEL_CHAINS).map((chain) => chain[0]);
    const calls = stubRouter([...new Set(tops)]);

    await getStatus();

    // One probe from probeQwen + at most one from the resolver (which then
    // serves the remaining tags from its ~60s cache).
    expect(calls.models).toBeLessThanOrEqual(2);
  });
});
