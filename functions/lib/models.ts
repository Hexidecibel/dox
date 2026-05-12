// Centralized model selection for the qwen-llm router.
// Each tag maps to a concrete model name; call sites use semantic tags
// instead of hardcoding model names.
//
// Override at runtime via env vars: QWEN_MODEL_BEST, QWEN_MODEL_FAST, QWEN_MODEL_VISION.
// Useful for staging/dev to swap to a cheaper model without redeploying.

export type ModelTag = 'best' | 'fast' | 'vision';

const DEFAULT: Record<ModelTag, string> = {
  best:   'Qwen3-6-35B-A3B-turbo',  // 35B MoE on AJ's RTX 4090, ~100 tok/s. Reserved for this project.
  fast:   'Qwen3-8B',                // 8B on Cushbox 3080, ~32 tok/s. Latency-sensitive paths.
  vision: 'qwen2.5-vl-7b',           // VL on Ubuntu CPU. Image-aware extraction.
};

export function modelFor(tag: ModelTag, env?: { [k: string]: string | undefined }): string {
  const overrideKey = `QWEN_MODEL_${tag.toUpperCase()}`;
  return env?.[overrideKey] ?? DEFAULT[tag];
}
