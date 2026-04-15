/**
 * Open-ended field-mapping types + helpers.
 *
 * Single source of truth shared between the React wizard (frontend, wave 2)
 * and the connector pipeline (backend, wave 1). Keep this file PURE — no
 * DB access, no fetch, no side effects — so the exact same code runs in a
 * Worker and in the browser.
 *
 * Shape v2 (current):
 *
 *   {
 *     version: 2,
 *     core: {
 *       order_number:    { enabled: true,  source_labels: ['Order #', 'SO'], format_hint: 'SO-12345' },
 *       customer_number: { enabled: true,  source_labels: ['Cust #'],        format_hint: 'K00123' },
 *       ...
 *     },
 *     extended: [
 *       { key: 'ship_date', label: 'Ship Date', source_labels: ['Ship Date'], format_hint: 'YYYY-MM-DD' },
 *       ...
 *     ],
 *   }
 *
 * Legacy v1 shapes handled by normalizeFieldMappings():
 *  - `{}` (empty) — defaults applied
 *  - `{ order_number: true, customer_number: true }` — AI-mode checkboxes
 *  - `{ 'Source Col': 'order_number', 'Other Col': 'customer_name' }` — CSV manual map
 *
 * order_number is the one non-optional core field — any config that disables
 * it fails validation.
 */

export interface FieldMappingCore {
  /** Whether this canonical field is in scope for this connector. */
  enabled: boolean;
  /**
   * Possible column headers / labels in the source that should be mapped
   * onto this canonical field. Case-insensitive, whitespace/punctuation-stripped
   * comparison at match time. Multiple entries allowed for alias support.
   */
  source_labels: string[];
  /** Human-readable example value to feed the Qwen prompt ("e.g. K00123"). */
  format_hint?: string;
}

export interface FieldMappingExtended {
  /** snake_case key used in extended_metadata JSON. Must be unique per connector. */
  key: string;
  /** Human-readable label shown in the wizard (defaults to the key). */
  label: string;
  /** Source column header aliases. Same matching rules as FieldMappingCore.source_labels. */
  source_labels: string[];
  /** Optional example/format hint forwarded to the AI prompt. */
  format_hint?: string;
}

export type CoreFieldKey =
  | 'order_number'
  | 'customer_number'
  | 'customer_name'
  | 'po_number'
  | 'product_name'
  | 'product_code'
  | 'quantity'
  | 'lot_number';

export interface ConnectorFieldMappings {
  /** Version marker — bumped whenever the shape changes so readers can migrate. */
  version: 2;
  core: Record<CoreFieldKey, FieldMappingCore>;
  extended: FieldMappingExtended[];
}

// =============================================================================
// Canonical core-field catalog
// =============================================================================

export interface CoreFieldDefinition {
  key: CoreFieldKey;
  label: string;
  required: boolean;
  /** Default alias list — common header names to pre-populate a new mapping with. */
  default_source_labels: string[];
  /** Default format hint used to seed the AI prompt if the user hasn't entered one. */
  default_format_hint: string;
  description: string;
}

export const CORE_FIELD_DEFINITIONS: readonly CoreFieldDefinition[] = [
  {
    key: 'order_number',
    label: 'Order Number',
    required: true,
    default_source_labels: ['order_number', 'order no', 'order #', 'order', 'so', 'so #', 'sales order', 'invoice'],
    default_format_hint: 'e.g. SO-12345, ORD-2026-001, 1784767',
    description: 'Primary order identifier (distinct from customer_number).',
  },
  {
    key: 'customer_number',
    label: 'Customer Number',
    required: false,
    default_source_labels: ['customer_number', 'customer no', 'customer #', 'customer id', 'cust #', 'cust no', 'customer', 'cust'],
    default_format_hint: 'e.g. K00123, P000456',
    description: 'Customer account identifier.',
  },
  {
    key: 'customer_name',
    label: 'Customer Name',
    required: false,
    default_source_labels: ['customer_name', 'customer', 'name', 'business name', 'company', 'account name'],
    default_format_hint: 'Business name (no trailing digits — those are usually column spillover)',
    description: 'Customer business name.',
  },
  {
    key: 'po_number',
    label: 'PO Number',
    required: false,
    default_source_labels: ['po_number', 'po', 'po #', 'p.o.', 'purchase order'],
    default_format_hint: 'e.g. PO-98765',
    description: 'Purchase order reference. Only populate if the source explicitly labels a column as PO / Purchase Order.',
  },
  {
    key: 'product_name',
    label: 'Product Name',
    required: false,
    default_source_labels: ['product_name', 'product', 'description', 'item', 'item description'],
    default_format_hint: 'Product description',
    description: 'Product description or line item name.',
  },
  {
    key: 'product_code',
    label: 'Product Code',
    required: false,
    default_source_labels: ['product_code', 'sku', 'item code', 'part number', 'product id'],
    default_format_hint: 'SKU or item code',
    description: 'Product SKU / item code.',
  },
  {
    key: 'quantity',
    label: 'Quantity',
    required: false,
    default_source_labels: ['quantity', 'qty', 'amount', 'units'],
    default_format_hint: 'Numeric quantity',
    description: 'Line item quantity.',
  },
  {
    key: 'lot_number',
    label: 'Lot Number',
    required: false,
    default_source_labels: ['lot_number', 'lot', 'lot #', 'batch', 'batch number'],
    default_format_hint: 'e.g. LOT-456',
    description: 'Lot / batch identifier on the line item.',
  },
];

export const CORE_FIELD_KEYS: readonly CoreFieldKey[] = CORE_FIELD_DEFINITIONS.map(f => f.key);

// =============================================================================
// Defaults + normalization
// =============================================================================

/**
 * Build an empty-but-sensible v2 config. ALL core fields are enabled with
 * their canonical default source-label alias list — this is the "zero-config"
 * shape the parser uses when a legacy v1 config or an empty-object is passed
 * in, so standard CSV headers ("order_number", "po_number", "quantity", etc.)
 * still map correctly without the user ticking any checkboxes.
 *
 * The wizard CAN disable individual core fields, but the default config does
 * not pre-disable anything.
 */
export function defaultFieldMappings(): ConnectorFieldMappings {
  const core = {} as Record<CoreFieldKey, FieldMappingCore>;
  for (const def of CORE_FIELD_DEFINITIONS) {
    core[def.key] = {
      enabled: true,
      source_labels: [...def.default_source_labels],
      format_hint: def.default_format_hint,
    };
  }
  return { version: 2, core, extended: [] };
}

function isCoreFieldKey(x: unknown): x is CoreFieldKey {
  return typeof x === 'string' && (CORE_FIELD_KEYS as readonly string[]).includes(x);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

/**
 * Turn anything we might find in the connectors.field_mappings column (v1,
 * v2, null, undefined, empty object, old CSV manual maps) into a fresh v2
 * ConnectorFieldMappings. NEVER throws — legacy shapes we can't interpret
 * fall back to defaults so GET on old connectors stays happy.
 */
export function normalizeFieldMappings(raw: unknown): ConnectorFieldMappings {
  // Null / undefined / string / empty -> defaults.
  if (raw == null) return defaultFieldMappings();
  if (typeof raw === 'string') {
    // Someone stored a JSON string — try to reparse.
    try {
      return normalizeFieldMappings(JSON.parse(raw));
    } catch {
      return defaultFieldMappings();
    }
  }
  if (!isRecord(raw)) return defaultFieldMappings();
  if (Object.keys(raw).length === 0) return defaultFieldMappings();

  // v2 detection: has numeric version + core object.
  if (raw.version === 2 && isRecord(raw.core)) {
    return upgradeV2Shape(raw);
  }

  // v1 shape A: `{ order_number: true, customer_number: true }` (AI-mode toggles)
  // v1 shape B: `{ order_number: 'order_number', customer_number: 'customer_number' }`
  //   (post-rename identity map from the AI flow — the frontend serializes
  //   the checkbox state this way today).
  const looksLikeAiToggles = Object.values(raw).every(
    v => typeof v === 'boolean' || (typeof v === 'string' && isCoreFieldKey(v)),
  ) && Object.keys(raw).every(k => isCoreFieldKey(k));

  if (looksLikeAiToggles) {
    const out = defaultFieldMappings();
    // Turn everything off first, then enable the keys the v1 config had.
    for (const def of CORE_FIELD_DEFINITIONS) {
      out.core[def.key].enabled = false;
    }
    for (const [key, val] of Object.entries(raw)) {
      if (!isCoreFieldKey(key)) continue;
      const enabled = typeof val === 'boolean' ? val : true;
      out.core[key].enabled = enabled;
    }
    return out;
  }

  // v1 shape C: manual CSV map — `{ 'Source Col Name': 'order_number', ... }`.
  // Values are core keys, keys are source column labels.
  const looksLikeManualMap = Object.entries(raw).every(
    ([, v]) => typeof v === 'string' && isCoreFieldKey(v),
  );

  if (looksLikeManualMap) {
    const out = defaultFieldMappings();
    // Turn everything off, then enable whichever core fields the map
    // referenced with the source label attached.
    for (const def of CORE_FIELD_DEFINITIONS) {
      out.core[def.key].enabled = false;
      out.core[def.key].source_labels = [];
    }
    for (const [sourceLabel, target] of Object.entries(raw)) {
      if (!isCoreFieldKey(target)) continue;
      out.core[target].enabled = true;
      if (!out.core[target].source_labels.includes(sourceLabel)) {
        out.core[target].source_labels.push(sourceLabel);
      }
      // Backfill format hint from the canonical default if empty.
      if (!out.core[target].format_hint) {
        const def = CORE_FIELD_DEFINITIONS.find(d => d.key === target);
        if (def) out.core[target].format_hint = def.default_format_hint;
      }
    }
    // order_number must always be on if it was implied by validation.
    return out;
  }

  // Unrecognized — fall back to defaults so we don't blow up.
  return defaultFieldMappings();
}

/**
 * Pull through a v2 shape, filling in any missing core keys / normalizing
 * the extended[] array. Tolerant of partially-populated configs that may
 * come from a UI mid-edit.
 */
function upgradeV2Shape(raw: Record<string, unknown>): ConnectorFieldMappings {
  const out = defaultFieldMappings();
  const rawCore = isRecord(raw.core) ? raw.core : {};
  for (const def of CORE_FIELD_DEFINITIONS) {
    const entry = rawCore[def.key];
    if (isRecord(entry)) {
      out.core[def.key] = {
        enabled: typeof entry.enabled === 'boolean' ? entry.enabled : out.core[def.key].enabled,
        source_labels: Array.isArray(entry.source_labels)
          ? entry.source_labels.filter((s): s is string => typeof s === 'string')
          : out.core[def.key].source_labels,
        format_hint: typeof entry.format_hint === 'string'
          ? entry.format_hint
          : out.core[def.key].format_hint,
      };
    }
  }

  const rawExtended = Array.isArray(raw.extended) ? raw.extended : [];
  const extended: FieldMappingExtended[] = [];
  for (const e of rawExtended) {
    if (!isRecord(e)) continue;
    if (typeof e.key !== 'string' || !e.key.trim()) continue;
    const key = e.key.trim();
    const label = typeof e.label === 'string' && e.label.trim() ? e.label.trim() : key;
    const source_labels = Array.isArray(e.source_labels)
      ? e.source_labels.filter((s): s is string => typeof s === 'string')
      : [];
    const format_hint = typeof e.format_hint === 'string' ? e.format_hint : undefined;
    extended.push({ key, label, source_labels, format_hint });
  }
  out.extended = extended;
  return out;
}

// =============================================================================
// Validation
// =============================================================================

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const SNAKE_CASE_RE = /^[a-z][a-z0-9_]*$/;

export function validateFieldMappings(m: ConnectorFieldMappings): ValidationResult {
  const errors: string[] = [];
  if (m.version !== 2) {
    errors.push('field_mappings.version must be 2');
  }
  if (!m.core || !isRecord(m.core)) {
    errors.push('field_mappings.core is missing');
    return { ok: false, errors };
  }

  const orderNumber = m.core.order_number;
  if (!orderNumber || !orderNumber.enabled) {
    errors.push('order_number must be enabled — it is the required identifier for every order');
  }

  for (const def of CORE_FIELD_DEFINITIONS) {
    const c = m.core[def.key];
    if (!c) continue;
    if (!Array.isArray(c.source_labels)) {
      errors.push(`core.${def.key}.source_labels must be an array`);
    }
  }

  const seenKeys = new Set<string>();
  for (let i = 0; i < m.extended.length; i++) {
    const e = m.extended[i];
    if (!e.key || !SNAKE_CASE_RE.test(e.key)) {
      errors.push(`extended[${i}].key must be snake_case (got "${e.key}")`);
    }
    if ((CORE_FIELD_KEYS as readonly string[]).includes(e.key)) {
      errors.push(`extended[${i}].key "${e.key}" collides with a core field — use a different name`);
    }
    if (seenKeys.has(e.key)) {
      errors.push(`extended[${i}].key "${e.key}" is duplicated`);
    }
    seenKeys.add(e.key);
    if (!Array.isArray(e.source_labels)) {
      errors.push(`extended[${i}].source_labels must be an array`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// =============================================================================
// Prompt composition helpers (for Qwen)
// =============================================================================

/**
 * Build the "Fields to extract" prompt fragment. Includes only enabled core
 * fields + all extended fields. Each line lists source aliases and the
 * format hint so the model knows what to look for.
 */
export function buildAiFieldsSection(m: ConnectorFieldMappings): string {
  const lines: string[] = ['Fields to extract:'];

  for (const def of CORE_FIELD_DEFINITIONS) {
    const c = m.core[def.key];
    if (!c || !c.enabled) continue;
    const aliasList = c.source_labels.length > 0 ? c.source_labels.join(', ') : '(no aliases — infer from context)';
    const hint = c.format_hint || def.default_format_hint;
    const reqTag = def.required ? ' [REQUIRED]' : '';
    lines.push(`- ${def.key}${reqTag}: ${def.description} Source labels: ${aliasList}. Format: ${hint}`);
  }

  if (m.extended.length > 0) {
    lines.push('');
    lines.push('Extended fields (return nested under "extended_metadata"):');
    for (const e of m.extended) {
      const aliasList = e.source_labels.length > 0 ? e.source_labels.join(', ') : '(no aliases — infer from context)';
      const hint = e.format_hint || '(free-form)';
      lines.push(`- ${e.key} (label: "${e.label}"): Source labels: ${aliasList}. Format: ${hint}`);
    }
  }

  return lines.join('\n');
}

/**
 * Build the "Return JSON in this exact format" block for the Qwen prompt.
 * The extended fields render as a nested `extended_metadata` object per
 * order, preserving the v2 shape on the wire.
 */
export function buildJsonShapeForPrompt(m: ConnectorFieldMappings): string {
  const corePairs: string[] = [];
  for (const def of CORE_FIELD_DEFINITIONS) {
    const c = m.core[def.key];
    if (!c || !c.enabled) continue;
    const isRequired = def.required;
    const type = def.key === 'quantity' ? 'number or null' : 'string or null';
    corePairs.push(`      "${def.key}": "${type}${isRequired ? ' (required)' : ''}"`);
  }

  if (m.extended.length > 0) {
    const extPairs = m.extended
      .map(e => `        "${e.key}": "string or null"`)
      .join(',\n');
    corePairs.push(`      "extended_metadata": {\n${extPairs}\n      }`);
  }

  return `Return JSON in this exact format:
{
  "orders": [
    {
${corePairs.join(',\n')}
    }
  ],
  "customers": [
    {
      "customer_number": "string",
      "name": "string",
      "email": "string or null",
      "contacts": [
        {"name": "string or null", "email": "string", "role": "string or null"}
      ]
    }
  ]
}`;
}
