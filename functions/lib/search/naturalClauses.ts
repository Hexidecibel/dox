/**
 * The AI's reading of a question, as clauses of the one query model (search
 * redesign Phase 2).
 *
 * `POST /api/documents/search/natural` has always turned a question into
 * coverage constraints (`constraintsFromParsedQuery` + the product identifier
 * graph + WMS orders). The workspace needs the same reading as CHIPS a person
 * can see, edit and reject, so this maps each constraint onto the clause that
 * asks the same thing — every one `source: 'ai'`, carrying the reason it was
 * read that way in `note` (including "the question says X, so X is checked").
 *
 * Nothing is widened or invented on the way:
 *   - a supplier or document type the tenant does not have stays the person's
 *     words (a text clause that says so), never the nearest name;
 *   - a product phrase that fits several products becomes ONE clause listing
 *     every candidate with `ambiguous: true` — the answer is shown per product
 *     and nothing is picked;
 *   - a constraint with no clause equivalent is returned in `dropped` with the
 *     reason, and the page shows it beside the chips.
 */

import type { SearchConstraint, SearchDateRole, SearchDroppedConstraint } from '../../../shared/types';
import type { Clause } from '../../../shared/searchQuery';
import { validateClause, type FieldKey } from '../../../shared/searchFields';

export interface NaturalClauseContext {
  suppliers: Array<{ id: string; name: string }>;
  documentTypes: Array<{ id: string; slug: string; name: string }>;
}

const DATE_FIELD: Record<SearchDateRole, FieldKey> = {
  production: 'production_date',
  code: 'code_date',
  expiration: 'best_by_date',
  ship: 'date',
  any: 'date',
  uploaded: 'uploaded',
};

const METADATA_FIELD: Record<string, FieldKey> = {
  po_number: 'po',
  po: 'po',
  purchase_order: 'po',
  customer_po: 'po',
  invoice_number: 'invoice',
  invoice: 'invoice',
  order_number: 'order',
  document_number: 'identifier',
  certificate_number: 'identifier',
  customer_item_number: 'identifier',
  product_code: 'identifier',
  shipment_number: 'identifier',
};

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function joinNotes(...notes: Array<string | null | undefined>): string | null {
  const out = notes.map((n) => (n ?? '').trim()).filter(Boolean);
  return out.length ? out.join(' ') : null;
}

type Draft = Omit<Clause, 'id' | 'source'>;

function textDraft(words: string, note: string): Draft {
  return { field: 'text', op: 'contains', values: [words], raw: words, note };
}

function dateDraft(c: SearchConstraint): Draft | null {
  const role = c.role ?? 'any';
  const field = DATE_FIELD[role];
  const base = { field, raw: c.raw, ...(field === 'date' ? { role } : {}) } as const;
  if (c.month_day) {
    if (field === 'uploaded') return null;
    const md = `--${String(c.month_day.month).padStart(2, '0')}-${String(c.month_day.day).padStart(2, '0')}`;
    return { ...base, op: 'on', values: [md] };
  }
  const from = c.date_from ?? null;
  const to = c.date_to ?? null;
  if (from && to && from === to) return { ...base, op: 'on', values: [from] };
  if (from && to) return { ...base, op: 'between', values: [from, to] };
  // Ranges from the parser are inclusive; before / after are strict.
  if (from) return { ...base, op: 'after', values: [addDays(from, -1)] };
  if (to) return { ...base, op: 'before', values: [addDays(to, 1)] };
  return null;
}

function draftFor(c: SearchConstraint, ctx: NaturalClauseContext): Draft | { dropped: string } {
  switch (c.kind) {
    case 'supplier': {
      const want = norm(c.value);
      const exact = ctx.suppliers.filter((s) => norm(s.name) === want);
      const loose = exact.length ? exact : ctx.suppliers.filter((s) => norm(s.name).startsWith(want) || want.startsWith(norm(s.name)));
      if (loose.length === 1) return { field: 'supplier', op: 'in', values: [loose[0].id], raw: c.raw };
      return textDraft(c.raw, loose.length > 1
        ? `The AI named the supplier "${c.raw}", which fits ${loose.length} suppliers — kept as your words; pick one from the filters.`
        : `The AI named the supplier "${c.raw}", and no supplier by that name is on file — kept as your words.`);
    }
    case 'document_type': {
      const dt = ctx.documentTypes.find((t) => t.slug === c.value || norm(t.name) === norm(c.value));
      if (dt) return { field: 'document_type', op: 'in', values: [dt.id], raw: c.raw };
      return { dropped: 'there is no document type by that name in this workspace.' };
    }
    case 'product': {
      const res = c.product_resolution;
      if (res && res.candidates.length === 1) {
        const k = res.candidates[0];
        return { field: 'product', op: 'in', values: [k.product_id], raw: res.phrase, note: k.explanation };
      }
      if (res && res.candidates.length > 1) {
        return {
          field: 'product', op: 'in', values: res.candidates.map((k) => k.product_id), raw: res.phrase, ambiguous: true,
          note: `"${res.phrase}" could mean ${res.candidates.length} products. Nothing was picked — the answer is shown for each; choose one.`,
        };
      }
      return textDraft(c.raw, `The AI named "${c.raw}", which does not resolve to one product on file — kept as your words.`);
    }
    case 'date': {
      const d = dateDraft(c);
      return d ?? { dropped: 'that date cannot be a filter here.' };
    }
    case 'lot': {
      if (c.match === 'prefix') return { field: 'lot', op: 'starts', values: [c.value], raw: c.raw };
      if (c.lot_parts) return { field: 'lot', op: 'is', values: [c.lot_parts.base], sublot: c.lot_parts.sub, raw: c.raw };
      return { field: 'lot', op: 'is', values: [c.raw || c.value], raw: c.raw };
    }
    case 'order':
      return { field: 'order', op: 'is', values: [c.order?.order_number ?? c.value], raw: c.raw };
    case 'po':
      return { field: 'po', op: 'is', values: [c.raw || c.value], raw: c.raw };
    case 'invoice':
      return { field: 'invoice', op: 'is', values: [c.raw || c.value], raw: c.raw };
    case 'identifier':
      return { field: 'identifier', op: 'is', values: [c.raw || c.value], raw: c.raw };
    case 'metadata': {
      const key = (c.fields[0] ?? '').toLowerCase();
      const field = METADATA_FIELD[key];
      if (field && c.match !== 'contains') return { field, op: 'is', values: [c.value], raw: c.raw };
      return textDraft(c.value, `The AI read "${c.label}"; that is not a search field, so it is matched as text.`);
    }
    case 'text':
      return textDraft(c.value, 'The AI kept these words as text.');
    default:
      return { dropped: 'that is not something a search clause can ask.' };
  }
}

/**
 * Constraints (from the natural-language parser) -> clauses. `dropped` keeps
 * the parser's own dropped list and adds anything that could not be a clause.
 */
export function constraintsToAiClauses(
  constraints: SearchConstraint[],
  parserDropped: SearchDroppedConstraint[],
  ctx: NaturalClauseContext,
): { clauses: Clause[]; dropped: SearchDroppedConstraint[] } {
  const clauses: Clause[] = [];
  const dropped: SearchDroppedConstraint[] = [...parserDropped];
  for (const c of constraints) {
    const d = draftFor(c, ctx);
    if ('dropped' in d) {
      dropped.push({ kind: c.kind, label: c.label, raw: c.raw, reason: d.dropped });
      continue;
    }
    const clause: Clause = {
      ...d,
      id: `a${clauses.length + 1}`,
      source: 'ai',
      note: joinNotes(d.note, c.note),
    };
    const err = validateClause(clause);
    if (err) {
      dropped.push({ kind: c.kind, label: c.label, raw: c.raw, reason: err });
      continue;
    }
    clauses.push(clause);
  }
  return { clauses, dropped };
}
