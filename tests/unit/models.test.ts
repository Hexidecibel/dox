/**
 * Model resolution tests — functions/lib/models.ts + its bin/lib/models.js mirror.
 *
 * Why this exists: backends flap. One GPU host comes and goes, another is
 * always on. The router (`QWEN_URL`) only advertises models with a HEALTHY
 * upstream on GET /v1/models, and rejects a chat call for anything else with
 * either "unknown model: X" (unregistered) or "no healthy upstream for model
 * X" (registered, backend down). Before preference chains existed, the `best`
 * tag pointed at a single name that was dead whenever that box was off — every
 * extraction failed instead of degrading.
 *
 * The contract under test:
 *   1. A tag resolves to the FIRST chain entry the router advertises.
 *   2. Dropping to a lower entry is a degradation and is LOGGED, never silent.
 *   3. Nothing in the chain available -> throw, naming the chain.
 *   4. A health-probe failure does NOT hard-fail; we attempt the chain.
 *   5. QWEN_MODEL_<TAG> pins an exact model and bypasses resolution.
 *   6. The lookup is cached (~60s) and can be invalidated on request failure.
 *   7. The CJS mirror the worker uses declares the SAME chains as the TS
 *      canonical the Pages functions use — worker and Pages request the same
 *      model for the same tag.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MODEL_CHAINS,
  chainFor,
  modelFor,
  resolveModel,
  healthyModels,
  invalidateModelCache,
  noteServedModel,
  isModelUnavailableError,
} from '../../functions/lib/models';
// Raw source of the CommonJS mirror — the workers pool cannot `require` CJS
// (and cannot eval), so the sync check is textual.
import modelsMirrorSource from '../../bin/lib/models.js?raw';
import canonicalSource from '../../functions/lib/models.ts?raw';
import processWorkerSource from '../../bin/process-worker?raw';

const ENV = { QWEN_URL: 'https://router.test', QWEN_SECRET: 'secret' };

/** Stub GET /v1/models with a fixed id list. Returns the call counter. */
function stubHealth(ids: string[] | 'fail') {
  const calls = { count: 0, auth: [] as (string | null)[] };
  const mock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
    if (url.includes('/v1/models')) {
      calls.count++;
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      calls.auth.push(headers.get('Authorization'));
      if (ids === 'fail') throw new Error('connection refused');
      return new Response(JSON.stringify({ object: 'list', data: ids.map(id => ({ id })) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  vi.stubGlobal('fetch', mock);
  return calls;
}

beforeEach(() => {
  invalidateModelCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  invalidateModelCache();
});

// Order-dependent behavior tests read the chain rather than hardcoding names, so
// a deliberate reordering does not produce a wall of false failures. The chains'
// intended CONTENT and ORDER are locked separately, in 'preference chains' below.
const PREFERRED = MODEL_CHAINS.best[0];
const FALLBACK = MODEL_CHAINS.best[1];

describe('preference chains', () => {
  it('orders `best` by QUANTIZATION (accuracy-first), not by speed', () => {
    // Extraction is batch + human-reviewed, so fidelity beats latency. The
    // Q4-vs-Q8 bake-off is the evidence: same page, same prompt, Q4 returned
    // ZERO per-sublot records and Q8 returned all four. The '-turbo' backend
    // (RTX 4090) serves Q4_K_M and must therefore sit LAST — it is the
    // availability floor, never the preferred extraction model.
    expect(MODEL_CHAINS.best.length).toBeGreaterThanOrEqual(2);
    expect(MODEL_CHAINS.best[0]).toBe('Qwen3-6-35B-A3B');
    expect(MODEL_CHAINS.best.at(-1)).toBe('Qwen3-6-35B-A3B-turbo');
  });

  it('orders `fast` by LATENCY — the 4090 leads where a human is waiting', () => {
    expect(MODEL_CHAINS.fast[0]).toBe('Qwen3-6-35B-A3B-turbo');
    expect(MODEL_CHAINS.fast).toContain('Qwen3-8B');
  });

  it('keeps vision working as a single-entry chain', () => {
    expect(MODEL_CHAINS.vision).toEqual(['qwen2.5-vl-7b']);
  });

  it('modelFor stays a working sync export returning the top preference', () => {
    expect(modelFor('best')).toBe(MODEL_CHAINS.best[0]);
    expect(modelFor('fast')).toBe(MODEL_CHAINS.fast[0]);
    expect(modelFor('vision')).toBe('qwen2.5-vl-7b');
  });

  it('does not hardcode a physical host in the chain values', () => {
    // Resolution must be driven by what the router advertises, so a box coming
    // or going needs no config change. Model NAMES only, no urls/ips.
    for (const chain of Object.values(MODEL_CHAINS)) {
      for (const entry of chain) {
        expect(entry).not.toMatch(/https?:|\d+\.\d+\.\d+\.\d+|:\d{4}/);
      }
    }
  });
});

describe('resolveModel — health-aware resolution', () => {
  it('picks the first chain entry the router advertises', async () => {
    stubHealth([PREFERRED, FALLBACK, 'qwen2.5-vl-7b']);
    const res = await resolveModel('best', ENV);
    expect(res.model).toBe(PREFERRED);
    expect(res.degraded).toBe(false);
    expect(res.source).toBe('health');
  });

  it('degrades to the next tier when the top choice has no healthy upstream', async () => {
    // The live case for `best`: the always-on host is down, so extraction drops
    // to the 4090's Q4 rather than failing — availability floor, loudly logged.
    stubHealth([FALLBACK, 'qwen2.5-vl-7b']);
    const res = await resolveModel('best', ENV);
    expect(res.model).toBe(FALLBACK);
    expect(res.preferred).toBe(PREFERRED);
    expect(res.degraded).toBe(true);
    expect(res.candidates).toEqual([FALLBACK]);
  });

  it('NEVER degrades silently — logs a warning naming wanted and used', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubHealth([FALLBACK]);
    await resolveModel('best', ENV);
    expect(warn).toHaveBeenCalled();
    const msg = warn.mock.calls.map(c => String(c[0])).join('\n');
    expect(msg).toMatch(/DEGRADED/);
    expect(msg).toContain(PREFERRED); // wanted
    expect(msg).toContain(FALLBACK);  // used
  });

  it('throws, naming the chain, when NOTHING in it is available', async () => {
    stubHealth(['some-unrelated-model']);
    await expect(resolveModel('best', ENV)).rejects.toThrow(/No available model for tag "best"/);
    invalidateModelCache();
    stubHealth(['some-unrelated-model']);
    await expect(resolveModel('best', ENV)).rejects.toThrow(
      new RegExp(`${PREFERRED} > ${FALLBACK}`),
    );
  });

  it('throws when the router advertises nothing at all', async () => {
    stubHealth([]);
    await expect(resolveModel('vision', ENV)).rejects.toThrow(/No available model for tag "vision"/);
  });

  it('falls back to attempting the chain when the health probe itself fails', async () => {
    // Availability is the requirement — a probe failure must not take the
    // pipeline down. We return the top preference and hand back the whole
    // chain as candidates so a retry loop can walk it.
    stubHealth('fail');
    const res = await resolveModel('best', ENV);
    expect(res.source).toBe('unverified');
    expect(res.model).toBe(PREFERRED);
    expect(res.candidates).toEqual([PREFERRED, FALLBACK]);
    expect(res.degraded).toBe(false);
  });

  it('sends the router secret as a bearer token on the probe', async () => {
    const calls = stubHealth([PREFERRED]);
    await resolveModel('best', ENV);
    expect(calls.auth[0]).toBe('Bearer secret');
  });
});

describe('resolveModel — env override precedence', () => {
  it('QWEN_MODEL_<TAG> pins the exact model and bypasses chain resolution', async () => {
    const calls = stubHealth([PREFERRED]);
    const res = await resolveModel('best', { ...ENV, QWEN_MODEL_BEST: 'pinned-model:Q8_0' });
    expect(res.model).toBe('pinned-model:Q8_0');
    expect(res.source).toBe('override');
    expect(res.degraded).toBe(false);
    // No health round-trip at all — the override is authoritative.
    expect(calls.count).toBe(0);
  });

  it('an override wins even when the router says it is unavailable', async () => {
    stubHealth([FALLBACK]);
    const res = await resolveModel('best', { ...ENV, QWEN_MODEL_BEST: 'not-advertised' });
    expect(res.model).toBe('not-advertised');
  });

  it('an empty override is ignored (falls back to the chain)', async () => {
    stubHealth([PREFERRED]);
    const res = await resolveModel('best', { ...ENV, QWEN_MODEL_BEST: '   ' });
    expect(res.model).toBe(PREFERRED);
    expect(res.source).toBe('health');
  });

  it('chainFor collapses to the single pinned entry under an override', () => {
    expect(chainFor('best', { QWEN_MODEL_BEST: 'x' })).toEqual(['x']);
    expect(chainFor('best')).toEqual(MODEL_CHAINS.best);
  });

  it('modelFor honors the override too (sync path unchanged)', () => {
    expect(modelFor('fast', { QWEN_MODEL_FAST: 'tiny' })).toBe('tiny');
  });
});

describe('health lookup caching', () => {
  it('reuses the cached answer instead of probing on every call', async () => {
    const calls = stubHealth([PREFERRED]);
    await resolveModel('best', ENV);
    await resolveModel('best', ENV);
    await resolveModel('fast', ENV).catch(() => {});
    expect(calls.count).toBe(1);
  });

  it('coalesces concurrent probes into one round-trip', async () => {
    const calls = stubHealth([PREFERRED]);
    await Promise.all([healthyModels(ENV), healthyModels(ENV), healthyModels(ENV)]);
    expect(calls.count).toBe(1);
  });

  it('re-resolves immediately after invalidation (request failure path)', async () => {
    const first = stubHealth([PREFERRED]);
    expect((await resolveModel('best', ENV)).model).toBe(PREFERRED);
    expect(first.count).toBe(1);

    // The 4090 drops mid-run: the call fails, the caller invalidates, and the
    // very next resolution must see the new reality — not wait out the TTL.
    invalidateModelCache(ENV);
    stubHealth([FALLBACK]);
    expect((await resolveModel('best', ENV)).model).toBe(FALLBACK);
  });

  it('force re-probes without an explicit invalidation', async () => {
    const calls = stubHealth([PREFERRED]);
    await resolveModel('best', ENV);
    await resolveModel('best', ENV, { force: true });
    expect(calls.count).toBe(2);
  });

  it('caches per router url', async () => {
    const calls = stubHealth([PREFERRED]);
    await resolveModel('best', ENV);
    await resolveModel('best', { ...ENV, QWEN_URL: 'https://other.test' });
    expect(calls.count).toBe(2);
  });
});

describe('noteServedModel — recording what actually served', () => {
  it('returns the served id, which carries the quantization', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const served = noteServedModel(
      'best',
      'Qwen3-6-35B-A3B',
      'unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q5_K_M',
    );
    expect(served).toBe('unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q5_K_M');
  });

  it('logs requested vs served so a swapped backend is traceable', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    noteServedModel('best', 'Qwen3-6-35B-A3B', 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q5_K_M');
    const msg = log.mock.calls.map(c => String(c[0])).join('\n');
    expect(msg).toContain('requested="Qwen3-6-35B-A3B"');
    expect(msg).toContain('served="unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q5_K_M"');
  });

  it('falls back to the requested id when the response omits model', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(noteServedModel('fast', 'Qwen3-8B', undefined)).toBe('Qwen3-8B');
    expect(noteServedModel('fast', 'Qwen3-8B', null)).toBe('Qwen3-8B');
  });
});

describe('isModelUnavailableError', () => {
  it('recognizes both router rejection modes', () => {
    expect(isModelUnavailableError('no healthy upstream for model Qwen3-6-35B-A3B-turbo')).toBe(true);
    expect(isModelUnavailableError('unknown model: Qwen3-6-35B-A3B-turbo')).toBe(true);
    expect(isModelUnavailableError('context length exceeded')).toBe(false);
    expect(isModelUnavailableError(undefined)).toBe(false);
  });
});

describe('worker/Pages parity — bin/lib/models.js mirrors functions/lib/models.ts', () => {
  /** Pull the MODEL_CHAINS object literal out of a source file. */
  function extractChains(src: string): string {
    const m = src.match(/MODEL_CHAINS[^=]*=\s*\{([\s\S]*?)\n\};/);
    expect(m, 'MODEL_CHAINS literal not found').toBeTruthy();
    return m![1].replace(/\s+/g, ' ').trim();
  }

  it('declares byte-identical chain literals in both copies', () => {
    // The worker and the Pages functions must request the SAME model for the
    // same tag — otherwise extraction quality silently diverges by surface.
    expect(extractChains(modelsMirrorSource)).toBe(extractChains(canonicalSource));
  });

  it('keeps the "mirror, sync by hand" header accurate', () => {
    expect(modelsMirrorSource).toMatch(/CommonJS mirror of functions\/lib\/models\.ts, kept in sync by hand/);
    expect(modelsMirrorSource).toMatch(/KEEP IN SYNC with functions\/lib\/models\.ts/);
    expect(canonicalSource).toMatch(/KEEP IN SYNC with bin\/lib\/models\.js/);
  });

  it('exports the same resolver surface from both copies', () => {
    for (const fn of ['chainFor', 'modelFor', 'resolveModel', 'invalidateModelCache', 'noteServedModel']) {
      expect(modelsMirrorSource).toContain(fn);
    }
  });

  it('stays plain CommonJS (no TS syntax, no ESM) so plain-node can require it', () => {
    expect(modelsMirrorSource).toContain('module.exports');
    expect(modelsMirrorSource).not.toMatch(/^\s*(import|export)\s/m);
    expect(modelsMirrorSource).not.toMatch(/:\s*(string|number|boolean)\[?\]?\s*[=;,)]/);
  });
});

describe('bin/process-worker — resolver wiring', () => {
  it('requires the resolver, not just the sync modelFor', () => {
    expect(processWorkerSource).toMatch(/resolveModel/);
    expect(processWorkerSource).toMatch(/require\('\.\/lib\/models'\)/);
  });

  it('resolves the best tag per call instead of hardcoding a model name', () => {
    expect(processWorkerSource).toMatch(/pickModel\('best', failedModels\)/);
    expect(processWorkerSource).toMatch(/resolveModel\(tag, process\.env/);
    // No literal model names in the request bodies.
    expect(processWorkerSource).not.toMatch(/model: 'Qwen3-6-35B/);
  });

  it('re-resolves on retry rather than waiting out the health TTL', () => {
    expect(processWorkerSource).toMatch(/force: failedModels\.size > 0/);
    expect(processWorkerSource).toMatch(/invalidateModelCache\(process\.env\)/);
  });

  it('walks DOWN the chain when the router rejects a model outright', () => {
    // Covers the case where /v1/models is unreachable or stale but
    // /v1/chat/completions still answers "no healthy upstream for model X".
    expect(processWorkerSource).toMatch(/async function pickModel\(tag, failedModels\)/);
    expect(processWorkerSource).toMatch(/failedModels\.add\(requestedModel\)/);
    expect(processWorkerSource).toMatch(/isModelUnavailableError\(err\.message\)/);
  });

  it('records the served text model on the result body (vlm_model convention)', () => {
    expect(processWorkerSource).toMatch(/resultBody\.text_model = servedTextModel/);
    expect(processWorkerSource).toMatch(/noteServedModel\('best'/);
  });

  it('preflights every tag it will use at startup', () => {
    expect(processWorkerSource).toMatch(/async function preflightModels\(\)/);
    expect(processWorkerSource).toMatch(/preflightModels\(\)\s*\n\s*\.then/);
    // Degrading is fine; a dead chain is not.
    expect(processWorkerSource).toMatch(/DEGRADED — wanted/);
    expect(processWorkerSource).toMatch(/refusing to start/);
  });
});
