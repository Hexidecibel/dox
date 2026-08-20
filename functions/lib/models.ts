// Centralized model selection for the qwen-llm router.
//
// Each semantic tag maps to an ORDERED PREFERENCE CHAIN (best first) rather
// than a single model name. Backends flap — a GPU box goes away, another one
// is always on — so the resolver asks the router which models actually have a
// healthy upstream and picks the best chain entry that is currently served.
//
// Design rules:
//   * Nothing here encodes WHICH physical box serves what. Resolution is
//     driven entirely by what `GET /v1/models` advertises, so a machine coming
//     or going needs no config change.
//   * Availability beats purity: if the health probe itself fails we still
//     attempt the chain (top preference first) instead of hard-failing.
//   * Degradation is never silent: dropping to a lower preference logs a
//     WARNING naming what was wanted and what was used, and the worker records
//     the served model id on every result body.
//   * Only when NOTHING in a chain is available do we fail loudly.
//
// Router contract (verified live):
//   GET  /v1/models            -> { data: [{ id }] } — healthy upstreams ONLY.
//   POST /v1/chat/completions  -> error "unknown model: X"                (unregistered)
//                              -> error "no healthy upstream for model X" (backend down)
//                              -> success `model` field carries the TRUE served id
//                                 including quantization, e.g.
//                                 "unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q5_K_M".
//
// Override at runtime via env vars: QWEN_MODEL_BEST, QWEN_MODEL_FAST,
// QWEN_MODEL_VISION. An explicit override PINS that exact model and bypasses
// chain resolution entirely (staging/dev pinning, or forcing a quantization).

export type ModelTag = 'best' | 'fast' | 'vision';

export type ModelEnv = { [k: string]: string | undefined } | undefined;

// KEEP IN SYNC with bin/lib/models.js (the CommonJS mirror). The
// tests/unit/models.test.ts "mirror" suite compares these blocks textually.
export const MODEL_CHAINS: Record<ModelTag, string[]> = {
  // Ordered best-first. Every entry must be a name the router knows; the
  // resolver picks the first one with a healthy upstream.
  //
  // POLICY (2026-08-13): doc extraction runs on the DGX Spark or AJ's Mac mini
  // and NOWHERE ELSE. Both chains below are exhaustively those two hosts. The
  // three names that used to live here were dropped on OPERATIONAL grounds, not
  // quality grounds -- each one was a machine that can disappear under you:
  //
  //   * `Qwen3-6-35B-A3B-turbo` -- the router narrowed turbo to [windows], and
  //     `windows` is the owner's GAMING PC. It gets paused mid-game and powered
  //     down at will. With it as turbo's only upstream, one client with no
  //     backoff drew 49,258 failed requests in 6 hours. Whether an extraction
  //     succeeds must not depend on whether somebody is playing a game.
  //   * `Qwen3-8B` -- the 3080 in that same gaming PC. Same box, same problem;
  //     it was never an independent fallback, just the first one wearing a hat.
  //   * `Qwen3-6-35B-A3B` -- the local CPU 35B on Hexinas. It pins ~38GB of RAM
  //     and every core, and on 2026-07-11 it starved the Plex transcoder badly
  //     enough that Plex read as broken to everyone in the house. As the tail of
  //     a chain that made the WORST case of a routine extraction "take down the
  //     media server", which is not a fallback, it is an outage. Removed, not
  //     demoted -- a last resort you must never reach is just a loaded gun.
  //
  // What remains is one family on two hosts running the SAME weights:
  // Qwen3.6-35B-A3B-UD-Q8_K_XL, the fidelity bake-off winner, byte-identical on
  // the Spark and the Mac. Fidelity therefore no longer discriminates between
  // them -- both are Q8, either satisfies MIN_BEST_QUANT -- so ORDER IS PURE
  // LATENCY. The Spark leads because it measured faster than the Mac at every
  // stage on those same weights (prefill 2.3x, decode 1.25x, end-to-end 1.11x,
  // accuracy within noise), and because it is dox's own machine.
  //
  // Host-pinned names are what make any of this sayable. `-turbo` could never
  // express WHICH weights answered, which is how production ran on the losing Q4
  // for months behind a stale Tailscale hostname. `-spark-q8` and `-mac-q8` each
  // name exactly one box and one quantization, so a degradation shows up in the
  // served model string instead of hiding inside a pool.
  best: [
    'Qwen3-6-35B-A3B-spark-q8',  // DGX Spark, Q8 - dox's own machine, fastest.
    'Qwen3-6-35B-A3B-mac-q8',    // Mac mini, byte-identical Q8, kept warm.
  ],
  // `fast` = LATENCY-first (teach interview, NL search - a human is waiting).
  // This chain used to be [turbo, Qwen3-8B], which is to say it was hosted
  // ENTIRELY on the gaming PC: both entries were the same machine, so its two
  // links failed together and `fast` had no fallback at all, only the look of
  // one. It now leads with the Spark, which serves this same family and beat the
  // Mac at every stage, so the latency-first tag gets the latency-best host.
  //
  // The Mac sits behind it rather than nothing: for a human staring at a
  // spinner, a slower answer beats an error, and the Mac is configured ttl:0
  // (never idle-unloads), so failing over to it has no ~38GB cold-load cliff.
  fast: [
    'Qwen3-6-35B-A3B-spark-q8',  // DGX Spark - fastest measured host, Q8.
    'Qwen3-6-35B-A3B-mac-q8',    // Mac mini, always warm - slower, but an answer.
  ],
  // UNCHANGED, deliberately. This is the local CPU 7B, NOT the 35B that starved
  // Plex, and the router's own comment defends its home: "Vision is small and
  // infrequent; the CPU is the right home for it" -- on a GPU box a vision
  // request would evict the resident 35B and the next text request would evict
  // vision back, thrashing a model swap per image. It is the one path left in
  // this file that is neither Spark nor Mac; flagged for the owner to override
  // rather than changed unasked.
  vision: [
    'qwen2.5-vl-7b',          // image-aware extraction.
  ],
};

export interface ModelResolution {
  tag: ModelTag;
  /** The model to send in the request body. */
  model: string;
  /** The chain's first choice — what we WANTED. */
  preferred: string;
  /** The full preference chain considered. */
  chain: string[];
  /**
   * Ordered models still worth trying for this tag, best first. Callers with a
   * retry loop can walk this on a "no healthy upstream" error. When the health
   * probe failed this is the whole chain (attempt in order); when it succeeded
   * it is the chain filtered to what the router advertises.
   */
  candidates: string[];
  /** True when `model` is not the chain's first choice. */
  degraded: boolean;
  /** How we arrived at `model`. */
  source: 'override' | 'health' | 'unverified';
  /** Model ids the router advertised, or null when the probe failed. */
  available: string[] | null;
}

const DEFAULT_QWEN_URL = 'http://127.0.0.1:9600';

/** How long a successful /v1/models answer is trusted. */
const HEALTH_TTL_MS = 60_000;
/** Shorter TTL after a failed probe so we recover fast without hammering. */
const HEALTH_FAIL_TTL_MS = 15_000;
/** Probe timeout — this sits in front of every LLM call, keep it snappy. */
const HEALTH_TIMEOUT_MS = 5_000;
/** Re-log a persistent degradation at most this often. */
const WARN_REPEAT_MS = 10 * 60_000;

interface HealthEntry {
  ids: string[] | null;
  at: number;
  inflight?: Promise<string[] | null>;
}

const healthCache = new Map<string, HealthEntry>();
const lastWarn = new Map<string, { key: string; at: number }>();

function baseUrlOf(env: ModelEnv): string {
  return (env?.QWEN_URL || DEFAULT_QWEN_URL).replace(/\/+$/, '');
}

function overrideFor(tag: ModelTag, env: ModelEnv): string | undefined {
  const v = env?.[`QWEN_MODEL_${tag.toUpperCase()}`];
  return v && v.trim() ? v.trim() : undefined;
}

/**
 * The preference chain for a tag. An env override collapses it to a single
 * pinned entry.
 */
export function chainFor(tag: ModelTag, env?: ModelEnv): string[] {
  const override = overrideFor(tag, env);
  if (override) return [override];
  return [...MODEL_CHAINS[tag]];
}

/**
 * Synchronous top preference. Kept as a working export so anything that cannot
 * await (or does not care) keeps functioning exactly as before. Prefer
 * `resolveModel()` — this one cannot know what is actually up.
 */
export function modelFor(tag: ModelTag, env?: ModelEnv): string {
  return chainFor(tag, env)[0];
}

/** Drop cached health (and warn dedup). Call after a request failure. */
export function invalidateModelCache(env?: ModelEnv): void {
  if (env === undefined) {
    healthCache.clear();
    lastWarn.clear();
    return;
  }
  healthCache.delete(baseUrlOf(env));
}

async function probeHealthyModels(baseUrl: string, secret?: string): Promise<string[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/v1/models`, {
      method: 'GET',
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json() as { data?: Array<{ id?: string }> };
    if (!body || !Array.isArray(body.data)) return null;
    const ids = body.data
      .map(m => (m && typeof m.id === 'string' ? m.id : null))
      .filter((id): id is string => !!id);
    return ids;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Model ids with a healthy upstream, cached briefly. Returns null when the
 * probe failed (caller then treats availability as unknown, not empty).
 */
export async function healthyModels(env?: ModelEnv, opts?: { force?: boolean }): Promise<string[] | null> {
  const baseUrl = baseUrlOf(env);
  const now = Date.now();
  const cached = healthCache.get(baseUrl);

  if (opts?.force) {
    healthCache.delete(baseUrl);
  } else if (cached) {
    if (cached.inflight) return cached.inflight;
    const ttl = cached.ids === null ? HEALTH_FAIL_TTL_MS : HEALTH_TTL_MS;
    if (now - cached.at < ttl) return cached.ids;
  }

  const inflight = probeHealthyModels(baseUrl, env?.QWEN_SECRET)
    .then(ids => {
      healthCache.set(baseUrl, { ids, at: Date.now() });
      return ids;
    })
    .catch(() => {
      healthCache.set(baseUrl, { ids: null, at: Date.now() });
      return null;
    });

  healthCache.set(baseUrl, { ids: null, at: now, inflight });
  return inflight;
}

function describeChain(chain: string[]): string {
  return chain.join(' > ');
}

/**
 * Emit the degradation WARNING. Deduped per (tag -> chosen model) so a steady
 * state does not spam, but re-logged every WARN_REPEAT_MS so a long-running
 * worker keeps saying it is degraded.
 */
function warnIfDegraded(res: ModelResolution): void {
  if (!res.degraded) return;
  const key = `${res.preferred}->${res.model}`;
  const prev = lastWarn.get(res.tag);
  const now = Date.now();
  if (prev && prev.key === key && now - prev.at < WARN_REPEAT_MS) return;
  lastWarn.set(res.tag, { key, at: now });
  console.warn(
    `[models] DEGRADED tag="${res.tag}": wanted "${res.preferred}" but it has no healthy upstream; ` +
    `using "${res.model}". chain: ${describeChain(res.chain)}. ` +
    `router advertises: ${(res.available || []).join(', ') || '(none)'}`,
  );
}

/**
 * Resolve a tag to the best model that is actually available right now.
 *
 * Precedence:
 *   1. QWEN_MODEL_<TAG> override — pins that exact model, no health lookup.
 *   2. First chain entry advertised by GET /v1/models (cached ~60s).
 *   3. Health probe failed -> top preference, unverified, full chain returned
 *      as `candidates` so a retry loop can walk it.
 * Throws only when the probe succeeded and NOTHING in the chain is available.
 */
export async function resolveModel(
  tag: ModelTag,
  env?: ModelEnv,
  opts?: { force?: boolean },
): Promise<ModelResolution> {
  const chain = chainFor(tag, env);
  const preferred = chain[0];
  const override = overrideFor(tag, env);

  if (override) {
    return {
      tag, model: override, preferred: override, chain, candidates: [override],
      degraded: false, source: 'override', available: null,
    };
  }

  const available = await healthyModels(env, opts);

  if (available === null) {
    // Health unknown — availability is the requirement, so attempt the chain.
    return {
      tag, model: preferred, preferred, chain, candidates: [...chain],
      degraded: false, source: 'unverified', available: null,
    };
  }

  const live = chain.filter(m => available.includes(m));
  if (live.length === 0) {
    throw new Error(
      `No available model for tag "${tag}". Tried chain: ${describeChain(chain)}. ` +
      `Router at ${baseUrlOf(env)} advertises: ${available.join(', ') || '(none)'}. ` +
      `Bring a backend up, or pin one with QWEN_MODEL_${tag.toUpperCase()}.`,
    );
  }

  const resolution: ModelResolution = {
    tag, model: live[0], preferred, chain, candidates: live,
    degraded: live[0] !== preferred, source: 'health', available,
  };
  warnIfDegraded(resolution);
  return resolution;
}

/**
 * Record what the router ACTUALLY served. The chat response's `model` field
 * carries the true id including quantization (e.g.
 * "unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q5_K_M"). A past grading pass was scored
 * against the wrong quantization because a backend swapped underneath us —
 * quantization materially changes extraction correctness, so every call notes
 * it and the worker persists it on the result body.
 *
 * Returns the served id (or the requested one when the response omitted it),
 * which is what callers should store.
 */
/**
 * Lowest quantization the `best` tag may run on before we complain. Q8 won the
 * fidelity bake-off; Q4 lost it.
 */
export const MIN_BEST_QUANT = 8;

/**
 * Pull the quantization out of a served model name, e.g.
 * `Qwen3.6-35B-A3B-UD-Q8_K_XL.gguf` -> 8, `...-UD-Q4_K_M.gguf` -> 4.
 * Returns null when the name carries no quant marker (nothing to judge).
 *
 * Anchored on a non-letter so it cannot match the `Q` in `Qwen`.
 */
export function quantOf(model?: string | null): number | null {
  if (!model) return null;
  const m = /(?:^|[^a-z])q(\d+)/i.exec(String(model));
  return m ? Number(m[1]) : null;
}

export function noteServedModel(tag: ModelTag, requested: string, served?: string | null): string {
  const actual = served && String(served).trim() ? String(served).trim() : requested;
  const key = `served:${tag}`;
  const prev = lastWarn.get(key);
  const now = Date.now();
  if (prev && prev.key === actual && now - prev.at < WARN_REPEAT_MS) return actual;
  lastWarn.set(key, { key: actual, at: now });
  console.log(`[models] tag="${tag}" requested="${requested}" served="${actual}"`);

  // THE SILENT-DEGRADATION GUARD.
  //
  // Production ran on Q4 for MONTHS and nothing said so. The chain resolver
  // could not see it: it asked the router for a name the router reported
  // healthy, and the router quietly served whichever upstream answered — after
  // a stale Tailscale hostname took the Q8 Mac out of reach. Only the served
  // model string ever knew, and we merely logged it at info level among
  // thousands of other lines.
  //
  // The served name is the ONE piece of ground truth about which weights
  // answered, so judge it here rather than trusting the requested name.
  if (tag === 'best') {
    const q = quantOf(actual);
    if (q !== null && q < MIN_BEST_QUANT) {
      console.warn(
        `[models] QUANT DEGRADED: tag="best" requested="${requested}" served="${actual}" ` +
        `(Q${q} < Q${MIN_BEST_QUANT}). Extraction is running on the quantization that LOST ` +
        `the fidelity bake-off. The preferred upstream is probably unreachable — check the ` +
        `router's health view and the served model, not the hostname.`
      );
    }
  }
  return actual;
}

/** True when a chat error means the model name was rejected by the router. */
export function isModelUnavailableError(message?: string | null): boolean {
  if (!message) return false;
  return /no healthy upstream for model|unknown model/i.test(message);
}
