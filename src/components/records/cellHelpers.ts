/**
 * Pure helpers for the Records grid: cell value formatting, dropdown
 * palette, ref-id extraction. Kept separate from the React components so
 * they are testable and shareable between desktop / mobile renderers.
 */

import type {
  ApiRecordColumn,
  RecordColumnConfig,
  RecordColumnDateConfig,
  RecordColumnDropdownConfig,
  RecordColumnDropdownOption,
  RecordColumnNumberConfig,
  RecordRowData,
} from '../../../shared/types';

/** Parse JSON cell payload, falling back to {} on malformed input. */
export function parseRowData(json: string | null | undefined): RecordRowData {
  if (!json) return {};
  if (typeof json === 'object') return json as RecordRowData;
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as RecordRowData) : {};
  } catch {
    return {};
  }
}

/**
 * Stable palette for dropdown chips. We pick by option index so a given
 * column's "approved" option always renders the same color. Hand-tuned
 * to read on light backgrounds without being noisy. 8 colors keeps the
 * picker compact; columns with more options cycle.
 */
export const DROPDOWN_PALETTE: { bg: string; fg: string; border: string }[] = [
  { bg: 'rgba(26, 54, 93, 0.10)',  fg: '#1A365D', border: 'rgba(26, 54, 93, 0.30)' },   // navy
  { bg: 'rgba(46, 125, 50, 0.10)', fg: '#1B5E20', border: 'rgba(46, 125, 50, 0.30)' },  // green
  { bg: 'rgba(237, 108, 2, 0.10)', fg: '#874100', border: 'rgba(237, 108, 2, 0.30)' },  // amber
  { bg: 'rgba(211, 47, 47, 0.10)', fg: '#9A1F1F', border: 'rgba(211, 47, 47, 0.30)' },  // red
  { bg: 'rgba(123, 31, 162, 0.10)', fg: '#4A148C', border: 'rgba(123, 31, 162, 0.30)' }, // purple
  { bg: 'rgba(2, 136, 209, 0.10)', fg: '#01579B', border: 'rgba(2, 136, 209, 0.30)' },  // sky
  { bg: 'rgba(96, 125, 139, 0.10)', fg: '#37474F', border: 'rgba(96, 125, 139, 0.30)' }, // slate
  { bg: 'rgba(216, 67, 21, 0.10)', fg: '#A82E0A', border: 'rgba(216, 67, 21, 0.30)' },  // brick
];

export function paletteForOption(index: number): { bg: string; fg: string; border: string } {
  return DROPDOWN_PALETTE[index % DROPDOWN_PALETTE.length];
}

/** Resolve a dropdown column's options. Tolerant of missing config. */
export function dropdownOptions(column: ApiRecordColumn): RecordColumnDropdownOption[] {
  const cfg = parseConfig(column) as RecordColumnDropdownConfig | undefined;
  return cfg?.options ?? [];
}

export function parseConfig(column: ApiRecordColumn): RecordColumnConfig | undefined {
  if (!column.config) return undefined;
  if (typeof column.config === 'object') return column.config as RecordColumnConfig;
  try {
    return JSON.parse(column.config as unknown as string) as RecordColumnConfig;
  } catch {
    return undefined;
  }
}

/** Format an arbitrary value for read-only cell rendering. */
export function formatCellValue(column: ApiRecordColumn, value: unknown): string {
  if (value == null || value === '') return '';
  switch (column.type) {
    case 'number':
    case 'currency':
    case 'percent': {
      const num = typeof value === 'number' ? value : Number(value);
      if (Number.isNaN(num)) return String(value);
      const cfg = parseConfig(column) as RecordColumnNumberConfig | undefined;
      const precision = cfg?.precision ?? (column.type === 'percent' ? 1 : 2);
      const opts: Intl.NumberFormatOptions = {
        minimumFractionDigits: precision,
        maximumFractionDigits: precision,
      };
      if (column.type === 'currency') {
        opts.style = 'currency';
        opts.currency = cfg?.currency_code ?? 'USD';
      } else if (column.type === 'percent') {
        opts.style = 'percent';
      }
      try {
        return new Intl.NumberFormat(undefined, opts).format(num);
      } catch {
        return num.toString();
      }
    }
    case 'date':
    case 'datetime': {
      if (typeof value !== 'string' && !(value instanceof Date)) return String(value);
      const d = value instanceof Date ? value : new Date(value);
      if (isNaN(d.getTime())) return String(value);
      const cfg = parseConfig(column) as RecordColumnDateConfig | undefined;
      const includeTime = column.type === 'datetime' || cfg?.include_time;
      try {
        return d.toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          ...(includeTime ? { hour: 'numeric', minute: '2-digit' } : {}),
        });
      } catch {
        return d.toISOString();
      }
    }
    case 'checkbox':
      return value ? 'Yes' : 'No';
    case 'dropdown_single':
      return typeof value === 'string' ? value : '';
    case 'dropdown_multi':
      if (Array.isArray(value)) return value.join(', ');
      return typeof value === 'string' ? value : '';
    default:
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      try {
        return JSON.stringify(value);
      } catch {
        return '';
      }
  }
}

/** Best-effort label for an entity-ref cell. Tolerates string/object/array. */
export function refLabel(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const labels = value.map((v) => refLabel(v)).filter(Boolean);
    return labels.length ? labels.join(', ') : null;
  }
  if (typeof value === 'object') {
    const o = value as { name?: unknown; label?: unknown; id?: unknown };
    if (typeof o.name === 'string') return o.name;
    if (typeof o.label === 'string') return o.label;
    if (typeof o.id === 'string') return o.id;
  }
  return null;
}

/** Extract a single id from one entity-ref item, or null if absent. */
export function refId(item: unknown): string | null {
  if (item == null) return null;
  if (typeof item === 'string') return item;
  if (typeof item === 'object') {
    const o = item as { id?: unknown };
    if (typeof o.id === 'string' && o.id.length > 0) return o.id;
  }
  return null;
}

/** Extract id(s) from an entity-ref cell payload, regardless of shape. */
export function refIds(value: unknown): string[] {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const v of arr) {
    if (typeof v === 'string') {
      out.push(v);
    } else if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') {
      out.push((v as { id: string }).id);
    }
  }
  return out;
}

/**
 * Pick the 2-3 secondary columns to display on a mobile card. Prefer
 * dropdowns and dates over long text; never include the title column.
 */
export function pickMobileSecondaryColumns(columns: ApiRecordColumn[], max = 3): ApiRecordColumn[] {
  const nonTitle = columns.filter((c) => c.is_title !== 1);
  const ranked = nonTitle
    .map((c) => ({
      column: c,
      score: mobileColumnScore(c),
    }))
    .sort((a, b) => b.score - a.score || a.column.display_order - b.column.display_order);
  return ranked.slice(0, max).map((r) => r.column);
}

function mobileColumnScore(c: ApiRecordColumn): number {
  switch (c.type) {
    case 'dropdown_single':
      return 5;
    case 'date':
    case 'datetime':
      return 4;
    case 'supplier_ref':
    case 'product_ref':
    case 'customer_ref':
    case 'document_ref':
    case 'record_ref':
    case 'contact':
      return 4;
    case 'number':
    case 'currency':
    case 'percent':
      return 3;
    case 'checkbox':
      return 2;
    case 'text':
      return 2;
    case 'long_text':
      return 0; // long text is too tall for the card
    default:
      return 1;
  }
}
