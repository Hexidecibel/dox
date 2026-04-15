/**
 * Pure helpers for the file-first wizard's schema-review step.
 *
 * Extracted into a non-JSX module so they can be imported by unit tests
 * running under the Workers-pool vitest runner (which only picks up
 * `tests/**\/*.test.ts`, not .tsx).
 *
 * All helpers accept and return fresh `ConnectorFieldMappings` objects — the
 * caller's state is never mutated.
 */

import type { DetectedField } from '../../types/connectorSchema';
import {
  CORE_FIELD_DEFINITIONS,
  TARGET_EXTENDED,
  TARGET_IGNORE,
  isCoreFieldKey,
  toSnakeCase,
  type ConnectorFieldMappings,
  type CoreFieldKey,
} from './doxFields';

export const ACCEPT_AI_THRESHOLD = 0.7;

/**
 * Deep-clone a ConnectorFieldMappings. structuredClone is safe — no
 * functions, symbols, or DOM references in the shape.
 */
function cloneMappings(m: ConnectorFieldMappings): ConnectorFieldMappings {
  return structuredClone(m);
}

/**
 * Remove the given source-label from every core.source_labels list and from
 * every extended[] entry. Used when re-homing a detected column onto a new
 * target.
 */
export function removeSourceFromMappings(
  m: ConnectorFieldMappings,
  sourceName: string,
): ConnectorFieldMappings {
  const out = cloneMappings(m);
  for (const def of CORE_FIELD_DEFINITIONS) {
    const core = out.core[def.key];
    if (!core) continue;
    core.source_labels = core.source_labels.filter((label) => label !== sourceName);
  }
  out.extended = out.extended
    .map((e) => ({
      ...e,
      source_labels: e.source_labels.filter((label) => label !== sourceName),
    }))
    .filter((e) => e.source_labels.length > 0);
  return out;
}

/**
 * Apply the user's "Map to: X" selection for a single detected field.
 *  - target = CoreFieldKey: add source to that core's source_labels and enable it.
 *  - target = '__extended__': append/update an extended entry keyed on
 *    `extendedKey` (defaults to snake_case of the source name).
 *  - target = '__ignore__': just remove the source from everything.
 */
export function applyTargetToMappings(
  m: ConnectorFieldMappings,
  field: DetectedField,
  target: string,
  opts: { extendedKey?: string; extendedLabel?: string; formatHint?: string } = {},
): ConnectorFieldMappings {
  const out = removeSourceFromMappings(m, field.name);

  if (target === TARGET_IGNORE) {
    return out;
  }

  if (isCoreFieldKey(target)) {
    const core = out.core[target as CoreFieldKey];
    if (!core) return out;
    if (!core.source_labels.includes(field.name)) {
      core.source_labels.push(field.name);
    }
    core.enabled = true;
    if (opts.formatHint !== undefined) {
      core.format_hint = opts.formatHint;
    }
    return out;
  }

  if (target === TARGET_EXTENDED) {
    const key = (opts.extendedKey && toSnakeCase(opts.extendedKey)) || toSnakeCase(field.name);
    if (!key) return out;
    const coreKeys = new Set<string>(CORE_FIELD_DEFINITIONS.map((d) => d.key));
    if (coreKeys.has(key)) return out;
    const label =
      opts.extendedLabel && opts.extendedLabel.trim() ? opts.extendedLabel.trim() : field.name;
    const formatHint =
      opts.formatHint ??
      (field.sample_values[0] ? `e.g. ${field.sample_values[0]}` : undefined);

    const existing = out.extended.find((e) => e.key === key);
    if (existing) {
      if (!existing.source_labels.includes(field.name)) {
        existing.source_labels.push(field.name);
      }
      if (label) existing.label = label;
      if (formatHint !== undefined) existing.format_hint = formatHint;
    } else {
      out.extended.push({
        key,
        label,
        source_labels: [field.name],
        format_hint: formatHint,
      });
    }
    return out;
  }

  return out;
}

/**
 * Inspect the current mappings to figure out which target a given detected
 * column is currently bound to. Returns the TARGET_IGNORE sentinel if the
 * source label isn't found anywhere.
 */
export function currentTargetFor(
  m: ConnectorFieldMappings,
  sourceName: string,
): { target: string; extendedKey?: string } {
  for (const def of CORE_FIELD_DEFINITIONS) {
    const core = m.core[def.key];
    if (core?.source_labels.includes(sourceName)) {
      return { target: def.key };
    }
  }
  for (const ext of m.extended) {
    if (ext.source_labels.includes(sourceName)) {
      return { target: TARGET_EXTENDED, extendedKey: ext.key };
    }
  }
  return { target: TARGET_IGNORE };
}

/**
 * Accept every AI suggestion with confidence >= threshold. Walks the
 * detected_fields list and calls applyTargetToMappings with the candidate.
 */
export function acceptAllHighConfidenceSuggestions(
  m: ConnectorFieldMappings,
  fields: DetectedField[],
  threshold: number = ACCEPT_AI_THRESHOLD,
): ConnectorFieldMappings {
  let next = cloneMappings(m);
  for (const f of fields) {
    const candidate = f.candidate_target;
    const confidence = f.confidence ?? 0;
    if (!candidate || confidence < threshold) continue;
    next = applyTargetToMappings(next, f, candidate);
  }
  return next;
}
