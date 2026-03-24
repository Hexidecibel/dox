/**
 * Computes a before/after diff for changed fields only.
 * Returns null if nothing changed.
 */
export function computeDiff(
  before: Record<string, any>,
  after: Record<string, any>,
  fields: string[]
): Record<string, { from: any; to: any }> | null {
  const changes: Record<string, { from: any; to: any }> = {};
  for (const field of fields) {
    const oldVal = before[field] ?? null;
    const newVal = after[field] ?? null;
    // Normalize for comparison (stringify arrays/objects)
    const oldStr = typeof oldVal === 'object' ? JSON.stringify(oldVal) : String(oldVal ?? '');
    const newStr = typeof newVal === 'object' ? JSON.stringify(newVal) : String(newVal ?? '');
    if (oldStr !== newStr) {
      changes[field] = { from: oldVal, to: newVal };
    }
  }
  return Object.keys(changes).length > 0 ? changes : null;
}
