/**
 * Compare two semver strings (major.minor.patch). Returns:
 *   -1 if a < b
 *    0 if a === b
 *    1 if a > b
 *
 * Tolerates leading 'v' and ignores any pre-release/build suffix after a '-' or '+'.
 * Non-numeric segments compare as 0.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

function parse(v: string): [number, number, number] {
  const stripped = v.replace(/^v/i, '').split(/[-+]/, 1)[0];
  const parts = stripped.split('.');
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const n = Number(parts[i]);
    out[i] = Number.isFinite(n) ? n : 0;
  }
  return out;
}
