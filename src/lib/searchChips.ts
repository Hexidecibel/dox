/**
 * How a clause reads on its chip (search redesign Phase 2).
 *
 * A chip says in words how the text was read — `production date · Sep 2 ·
 * any year`, `lot · 10426203 · sublot 03`, `PO · K555000 · on file as a PO
 * printed on a document`, `“5 gal bag” · could mean 2 products`, `mentions ·
 * “butter”` — so a person can see at a glance what the search is actually
 * asking before trusting its answer. Three parts: a small key, the value, and
 * a short note. Pure, so the words are tested without rendering.
 */

import type { Clause } from '../../shared/searchQuery';
import { SEARCH_FIELDS, STATUS_LABELS, UPLOADED_BUCKETS } from '../../shared/searchFields';
import { describeSpanValues, findQueryDates, formatIsoHuman, sinceWords } from '../../shared/searchDates';

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
import type { SearchConstraint, SearchDateRole } from '../../shared/types';

export interface ChipParts {
  /** The small label before the value ("production date", "PO", "not supplier"). */
  key: string;
  value: string;
  /** Short note after the value ("any year", "could mean 2 products"). */
  note?: string;
  /** Identifiers are shown in a monospaced face. */
  mono?: boolean;
}

const ROLE_KEY: Record<SearchDateRole, string> = {
  production: 'production date',
  code: 'code date',
  expiration: 'best-by date',
  ship: 'ship date',
  uploaded: 'uploaded',
  any: 'date',
};

/** "Sep 2" / "Sep 2, 2026" / "Sep 2 (any year)" */
export function chipDate(v: string): { text: string; anyYear: boolean } {
  const md = /^--(\d{2})-(\d{2})$/.exec(v);
  if (md) return { text: `${MONTH_SHORT[Number(md[1]) - 1] ?? md[1]} ${Number(md[2])}`, anyYear: true };
  return { text: /^\d{4}-\d{2}-\d{2}$/.test(v) ? formatIsoHuman(v) : v, anyYear: false };
}

function orList(xs: string[]): string {
  if (xs.length <= 1) return xs[0] ?? '—';
  return `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`;
}

/** First sentence, trimmed to a chip's width. */
function shortNote(note: string | null | undefined, max = 60): string | undefined {
  if (!note) return undefined;
  const first = note.split(/(?<=[.;])\s/)[0].replace(/[.;]$/, '').trim();
  if (!first) return undefined;
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

export function chipParts(c: Clause, labels: Record<string, string> = {}, constraint?: SearchConstraint | null): ChipParts {
  const def = SEARCH_FIELDS[c.field];
  const named = c.values.map((v) => labels[v] ?? (c.field === 'status' ? STATUS_LABELS[v] ?? v : v));
  switch (c.field) {
    case 'supplier':
    case 'document_type':
    case 'product':
    case 'status': {
      const key = `${c.exclude ? 'not ' : ''}${def.label.toLowerCase()}`;
      if (c.field === 'product' && c.ambiguous && c.values.length > 1) {
        return { key: 'product', value: `“${c.raw ?? orList(named)}”`, note: `could mean ${c.values.length} products` };
      }
      return { key, value: orList(named), note: c.source === 'ai' ? undefined : shortNote(c.note) };
    }
    case 'uploaded': {
      const bucket = UPLOADED_BUCKETS.find((b) => b.value === `${c.op}:${c.values[0]}`);
      if (bucket) return { key: 'uploaded', value: bucket.label.toLowerCase() };
      if (c.op === 'within') return { key: 'uploaded', value: `last ${c.values[0]} days` };
      if (c.op === 'older_than') return { key: 'uploaded', value: `over ${c.values[0]} days ago` };
      break;
    }
    case 'text':
      return { key: 'mentions', value: `“${c.values.join(' ')}”`, note: c.source === 'typed' && c.note ? shortNote(c.note) : undefined };
    case 'lot': {
      const v = c.values[0] ?? '';
      if (c.op === 'starts') return { key: 'lot starts with', value: v, mono: true, note: shortNote(c.note, 70) ?? 'every lot beginning with it' };
      return { key: 'lot', value: c.sublot ? `${v} · sublot ${c.sublot}` : v, mono: true, note: shortNote(c.note) };
    }
    case 'po':
    case 'invoice':
    case 'order':
    case 'identifier': {
      const key = c.field === 'po' ? 'PO' : c.field === 'identifier' ? 'number' : c.field;
      return { key, value: c.values[0] ?? '', mono: true, note: shortNote(c.note ?? constraint?.note ?? null) };
    }
    default:
      break;
  }
  // Dates.
  const role: SearchDateRole = c.field === 'date' ? (c.role ?? 'any') : def.role ?? 'any';
  const key = ROLE_KEY[role];
  const [a, b] = c.values.map(chipDate);
  let value = a?.text ?? '—';
  const span = c.op === 'between' && c.values[1] ? describeSpanValues(c.values[0], c.values[1]) : null;
  if (span) value = span.text;
  else if (c.op === 'between' && b) value = `${a.text} – ${b.text}`;
  else if (c.op === 'before') value = `before ${a.text}`;
  else if (c.op === 'after') value = sinceWords(c.values[0]) ?? `after ${a.text}`;
  return { key, value, note: a?.anyYear ? 'any year' : undefined };
}

/** The whole chip as one sentence, for aria-labels and tooltips. */
export function chipSentence(p: ChipParts): string {
  return [p.key, p.value, p.note].filter(Boolean).join(' · ');
}

/**
 * A date typed into the clause editor, as a clause value: `2026-09-02`, or
 * `--09-02` for a day in any year (only where the field allows it). Accepts
 * what the omnibox accepts ("Sep 2", "9/2/26", "2026-09-02"). Null when it
 * does not read as exactly one date.
 */
export function parseDateInput(input: string, allowYearless: boolean): string | null {
  const s = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^--\d{2}-\d{2}$/.test(s)) return allowYearless ? s : null;
  const hits = findQueryDates(s, allowYearless ? { allowYearless: () => true } : {});
  if (hits.length !== 1) return null;
  const d = hits[0].date;
  if (d.kind === 'day') return d.iso;
  if (d.kind !== 'month_day') return null;
  return allowYearless ? `--${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : null;
}

/** A clause date value as the editor shows it ("Sep 2" / "Sep 2, 2026"). */
export function dateInputText(v: string | undefined): string {
  if (!v) return '';
  return chipDate(v).text;
}

/** What kind of reading this is, for the chip's badge and the editor's header. */
export function sourceWords(c: Clause): string {
  switch (c.source) {
    case 'ai': return '✦ AI reading';
    case 'detected': return 'Read from your words';
    case 'typed': return 'Your words';
    case 'facet': return 'Filter';
    case 'saved': return 'From a saved search';
    default: return 'Added';
  }
}
