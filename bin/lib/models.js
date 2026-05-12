// CommonJS mirror of functions/lib/models.ts, kept in sync by hand.
//
// process-worker is plain Node JS (no TS compile step) so it cannot
// `require` the .ts canonical. When DEFAULT or the override convention
// changes in functions/lib/models.ts, update this file too. The
// extraction-prompt / extraction-pdf test suite asserts the worker
// requests the same tag as the Cloudflare Pages functions.

const DEFAULT = {
  best:   'Qwen3-6-35B-A3B-turbo',
  fast:   'Qwen3-8B',
  vision: 'qwen2.5-vl-7b',
};

function modelFor(tag, env) {
  const overrideKey = `QWEN_MODEL_${tag.toUpperCase()}`;
  if (env && env[overrideKey]) return env[overrideKey];
  return DEFAULT[tag];
}

module.exports = { modelFor };
