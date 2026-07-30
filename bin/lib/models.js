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
  // `best` = ACCURACY-first (batch extraction; a human reviews every result, so
  // fidelity beats latency). Ordered by QUANTIZATION, not by speed. The Q4-vs-Q8
  // bake-off is why: on the same COA page with the same prompt, Q4 returned ZERO
  // per-sublot records (sublots trapped in table headers) while Q8 returned all
  // four. Quantization is correctness here, not a tuning knob.
  //
  // NOTE the '-turbo' backend (RTX 4090) serves Q4_K_M — it is the FAST tier, not
  // the good one; 24GB cannot hold this model at Q8. It sits LAST so extraction
  // never silently lands on the quant that failed the bake-off.
  //
  // When a Q8 backend is registered on the always-on host, add its router name at
  // the HEAD of this chain — the resolver will auto-promote it the moment it is
  // advertised, with no other change.
  best: [
    'Qwen3-6-35B-A3B',        // Q5_K_M on the always-on host — best fidelity served today.
    'Qwen3-6-35B-A3B-turbo',  // Q4_K_M on the RTX 4090 — availability floor only.
  ],
  // `fast` = LATENCY-first (teach interview, NL search — a human is waiting).
  // The 4090 is genuinely excellent here, which is what it should be used for.
  fast: [
    'Qwen3-6-35B-A3B-turbo',  // ~100 tok/s on the RTX 4090 when it is up.
    'Qwen3-8B',               // 3080 fallback.
  ],
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
function noteServedModel(tag, requested, served) {
  const actual = served && String(served).trim() ? String(served).trim() : requested;
  const key = `served:${tag}`;
  const prev = lastWarn.get(key);
  const now = Date.now();
  if (prev && prev.key === actual && now - prev.at < WARN_REPEAT_MS) return actual;
  lastWarn.set(key, { key: actual, at: now });
  console.log(`[models] tag="${tag}" requested="${requested}" served="${actual}"`);
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
  isModelUnavailableError,
};
