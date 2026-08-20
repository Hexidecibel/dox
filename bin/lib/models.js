// CommonJS mirror of functions/lib/models.ts, kept in sync by hand.
//
// process-worker is plain Node JS (no TS compile step) so it cannot
// `require` the .ts canonical. When MODEL_CHAINS, the resolver behavior, or
// the override convention changes in functions/lib/models.ts, update this
// file too. tests/unit/models.test.ts compares the MODEL_CHAINS block in the
// two files textually and asserts the worker requests the same tag as the
// Cloudflare Pages functions (see also extraction-prompt / extraction-pdf).
//
// Behavior summary (full rationale lives in functions/lib/models.ts):
//   * Tags map to ORDERED preference chains, best first.
//   * resolveModel() picks the best chain entry that GET /v1/models says has a
//     healthy upstream, caching that answer ~60s.
//   * Probe failure => attempt the chain anyway (availability wins).
//   * Nothing in the chain available => throw, naming the chain.
//   * QWEN_MODEL_<TAG> pins an exact model and bypasses chain resolution.

// KEEP IN SYNC with functions/lib/models.ts (the canonical TS copy). The
// tests/unit/models.test.ts "mirror" suite compares these blocks textually.
const MODEL_CHAINS = {
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

const DEFAULT_QWEN_URL = 'http://127.0.0.1:9600';
const HEALTH_TTL_MS = 60_000;
const HEALTH_FAIL_TTL_MS = 15_000;
const HEALTH_TIMEOUT_MS = 5_000;
const WARN_REPEAT_MS = 10 * 60_000;

const healthCache = new Map();
const lastWarn = new Map();

function baseUrlOf(env) {
  return ((env && env.QWEN_URL) || DEFAULT_QWEN_URL).replace(/\/+$/, '');
}

function overrideFor(tag, env) {
  const v = env && env[`QWEN_MODEL_${tag.toUpperCase()}`];
  return v && String(v).trim() ? String(v).trim() : undefined;
}

function chainFor(tag, env) {
  const override = overrideFor(tag, env);
  if (override) return [override];
  return MODEL_CHAINS[tag].slice();
}

/** Synchronous top preference — kept working so nothing breaks. */
function modelFor(tag, env) {
  return chainFor(tag, env)[0];
}

function invalidateModelCache(env) {
  if (env === undefined) {
    healthCache.clear();
    lastWarn.clear();
    return;
  }
  healthCache.delete(baseUrlOf(env));
}

async function probeHealthyModels(baseUrl, secret) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/v1/models`, {
      method: 'GET',
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body || !Array.isArray(body.data)) return null;
    return body.data
      .map((m) => (m && typeof m.id === 'string' ? m.id : null))
      .filter((id) => !!id);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function healthyModels(env, opts) {
  const baseUrl = baseUrlOf(env);
  const now = Date.now();
  const cached = healthCache.get(baseUrl);

  if (opts && opts.force) {
    healthCache.delete(baseUrl);
  } else if (cached) {
    if (cached.inflight) return cached.inflight;
    const ttl = cached.ids === null ? HEALTH_FAIL_TTL_MS : HEALTH_TTL_MS;
    if (now - cached.at < ttl) return cached.ids;
  }

  const inflight = probeHealthyModels(baseUrl, env && env.QWEN_SECRET)
    .then((ids) => {
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

function describeChain(chain) {
  return chain.join(' > ');
}

function warnIfDegraded(res) {
  if (!res.degraded) return;
  const key = `${res.preferred}->${res.model}`;
  const prev = lastWarn.get(res.tag);
  const now = Date.now();
  if (prev && prev.key === key && now - prev.at < WARN_REPEAT_MS) return;
  lastWarn.set(res.tag, { key, at: now });
  console.warn(
    `[models] DEGRADED tag="${res.tag}": wanted "${res.preferred}" but it has no healthy upstream; ` +
    `using "${res.model}". chain: ${describeChain(res.chain)}. ` +
    `router advertises: ${(res.available || []).join(', ') || '(none)'}`
  );
}

/**
 * Resolve a tag to the best model actually available right now.
 * See functions/lib/models.ts for the full contract.
 */
async function resolveModel(tag, env, opts) {
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
    return {
      tag, model: preferred, preferred, chain, candidates: chain.slice(),
      degraded: false, source: 'unverified', available: null,
    };
  }

  const live = chain.filter((m) => available.includes(m));
  if (live.length === 0) {
    throw new Error(
      `No available model for tag "${tag}". Tried chain: ${describeChain(chain)}. ` +
      `Router at ${baseUrlOf(env)} advertises: ${available.join(', ') || '(none)'}. ` +
      `Bring a backend up, or pin one with QWEN_MODEL_${tag.toUpperCase()}.`
    );
  }

  const resolution = {
    tag, model: live[0], preferred, chain, candidates: live,
    degraded: live[0] !== preferred, source: 'health', available,
  };
  warnIfDegraded(resolution);
  return resolution;
}

/**
 * Record what the router ACTUALLY served (the chat response's `model` field
 * carries the true id INCLUDING quantization). Returns the id to persist.
 */
// Lowest quantization the `best` tag may run on. Q8 won the fidelity bake-off;
// Q4 lost it. KEEP IN SYNC with functions/lib/models.ts.
const MIN_BEST_QUANT = 8;

// Pull the quantization out of a served model name, e.g.
// `Qwen3.6-35B-A3B-UD-Q8_K_XL.gguf` -> 8, `...-UD-Q4_K_M.gguf` -> 4. Null when
// the name carries no quant marker. Anchored on a non-letter so it cannot match
// the `Q` in `Qwen`.
function quantOf(model) {
  if (!model) return null;
  const m = /(?:^|[^a-z])q(\d+)/i.exec(String(model));
  return m ? Number(m[1]) : null;
}

function noteServedModel(tag, requested, served) {
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
  // model string ever knew, and we merely logged it at info level.
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

function isModelUnavailableError(message) {
  if (!message) return false;
  return /no healthy upstream for model|unknown model/i.test(message);
}

module.exports = {
  MODEL_CHAINS,
  chainFor,
  modelFor,
  resolveModel,
  healthyModels,
  invalidateModelCache,
  noteServedModel,
  quantOf,
  MIN_BEST_QUANT,
  isModelUnavailableError,
};
