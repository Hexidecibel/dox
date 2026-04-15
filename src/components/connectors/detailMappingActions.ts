/**
 * Pure reducer helpers for the ConnectorDetail page's inline field-mapping
 * editor. Extracted so they can be unit-tested under the Workers-pool vitest
 * runner (which doesn't render JSX). Parallels `fieldMappingActions.ts`
 * (which powers the wizard's detected-column flow) but operates on the
 * mappings directly — no DetectedField involved — because the detail page
 * edits an existing v2 config without a freshly-uploaded sample.
 */

import {
  CORE_FIELD_DEFINITIONS,
  type ConnectorFieldMappings,
  type CoreFieldKey,
  type FieldMappingExtended,
} from './doxFields';

function cloneMappings(m: ConnectorFieldMappings): ConnectorFieldMappings {
  return structuredClone(m);
}

/**
 * Normalize a free-form array of strings into a deduped, trimmed list.
 * Dedupe is case-insensitive but preserves the first-seen casing so chips
 * don't jitter as the user edits the list.
 */
export function normalizeSourceLabelList(input: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Patch a core field entry — toggles enabled flag, replaces source_labels,
 * or updates format_hint. Unspecified keys are left alone. Returns a fresh
 * mapping.
 */
export function updateCoreField(
  mappings: ConnectorFieldMappings,
  key: CoreFieldKey,
  patch: { enabled?: boolean; source_labels?: string[]; format_hint?: string },
): ConnectorFieldMappings {
  const out = cloneMappings(mappings);
  const cur = out.core[key];
  if (!cur) return out;
  if (patch.enabled !== undefined) cur.enabled = patch.enabled;
  if (patch.source_labels !== undefined) cur.source_labels = normalizeSourceLabelList(patch.source_labels);
  if (patch.format_hint !== undefined) cur.format_hint = patch.format_hint;
  return out;
}

/**
 * Patch an extended field entry at the given index. Leaves out-of-bound
 * indexes untouched.
 */
export function updateExtendedField(
  mappings: ConnectorFieldMappings,
  index: number,
  patch: Partial<FieldMappingExtended>,
): ConnectorFieldMappings {
  const out = cloneMappings(mappings);
  const cur = out.extended[index];
  if (!cur) return out;
  out.extended[index] = {
    ...cur,
    ...patch,
    source_labels:
      patch.source_labels !== undefined
        ? normalizeSourceLabelList(patch.source_labels)
        : cur.source_labels,
  };
  return out;
}

/**
 * Delete an extended field by index. Out-of-bound indexes return the
 * mapping unchanged.
 */
export function deleteExtendedField(
  mappings: ConnectorFieldMappings,
  index: number,
): ConnectorFieldMappings {
  if (index < 0 || index >= mappings.extended.length) return cloneMappings(mappings);
  const out = cloneMappings(mappings);
  out.extended.splice(index, 1);
  return out;
}

/**
 * Append a new blank extended field. Picks a unique snake_case key by
 * appending an incrementing suffix to `base` until a free slot is found,
 * so repeated clicks on "Add extended field" don't collide.
 */
export function appendBlankExtendedField(
  mappings: ConnectorFieldMappings,
  base: string = 'extra_field',
  label: string = 'Extra field',
): ConnectorFieldMappings {
  const taken = new Set(mappings.extended.map((e) => e.key));
  // Core keys must also be avoided.
  for (const def of CORE_FIELD_DEFINITIONS) taken.add(def.key);

  let candidate = base;
  let counter = 2;
  while (taken.has(candidate)) {
    candidate = `${base}_${counter}`;
    counter++;
  }

  const out = cloneMappings(mappings);
  out.extended.push({
    key: candidate,
    label,
    source_labels: [],
    format_hint: undefined,
  });
  return out;
}
