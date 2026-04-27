/**
 * Pure helpers for the Phase 3.5 "needs your eyes" sort + uncertainty surface.
 *
 * The Review Queue UI sorts fields into three buckets keyed off the worker's
 * uncertainty payload (Record<field_key, 0..1>):
 *   - high (>= 0.7): top of the list, with a yellow "needs your eyes" badge
 *   - medium (0.4 <= u < 0.7): interleaved beneath the high band, no badge
 *   - low (< 0.4): collapsed under a "looks good" accordion
 *
 * Extracted out of ReviewQueue.tsx so the bucketing logic is unit-testable
 * in isolation.
 */

export type UncertaintyBand = 'high' | 'medium' | 'low';

export interface FieldOrderEntry {
  key: string;
  band: UncertaintyBand;
  uncertainty: number;
}

const HIGH_THRESHOLD = 0.7;
const MEDIUM_THRESHOLD = 0.4;

export function bandFor(uncertainty: number | undefined): UncertaintyBand {
  if (uncertainty == null || Number.isNaN(uncertainty)) return 'low';
  if (uncertainty >= HIGH_THRESHOLD) return 'high';
  if (uncertainty >= MEDIUM_THRESHOLD) return 'medium';
  return 'low';
}

/**
 * Sort field keys by uncertainty band, then by uncertainty score descending
 * within each band, then alphabetically as a stable tie-breaker. Missing
 * uncertainty entries default to 0 (low band).
 */
export function sortFieldsByUncertainty(
  fieldKeys: string[],
  uncertainty: Record<string, number> | null | undefined
): FieldOrderEntry[] {
  const u = uncertainty ?? {};
  const entries: FieldOrderEntry[] = fieldKeys.map(key => {
    const score = typeof u[key] === 'number' ? u[key] : 0;
    return { key, band: bandFor(score), uncertainty: score };
  });
  const bandRank: Record<UncertaintyBand, number> = { high: 0, medium: 1, low: 2 };
  entries.sort((a, b) => {
    const bandDiff = bandRank[a.band] - bandRank[b.band];
    if (bandDiff !== 0) return bandDiff;
    if (a.uncertainty !== b.uncertainty) return b.uncertainty - a.uncertainty;
    return a.key.localeCompare(b.key);
  });
  return entries;
}

export function partitionByBand(
  entries: FieldOrderEntry[]
): { high: FieldOrderEntry[]; medium: FieldOrderEntry[]; low: FieldOrderEntry[] } {
  const out = { high: [] as FieldOrderEntry[], medium: [] as FieldOrderEntry[], low: [] as FieldOrderEntry[] };
  for (const e of entries) out[e.band].push(e);
  return out;
}
