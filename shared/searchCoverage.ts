/**
 * Coverage-aware search: does THIS document cover what was asked, or is it only
 * nearby?
 *
 * The client's rule (AJ Conner, Any-Field COA Retrieval, D6 / R9): "A confident
 * wrong answer is worse than a null." Search used to return the nearest thing it
 * could find and present it as an answer — a code date of 7/31 for a production
 * date of 7/31, a lot 1042620 prefix hitting ten different lots, a sibling
 * certificate carrying the whole bundle's text. So when a query states
 * something a document must BE, that statement becomes a CONSTRAINT, and every
 * result is checked against the document's OWN structured fields:
 *
 *   covering                every constraint verified on this document
 *   candidate_not_matching  nearby, with the failed constraint named in words
 *   unreviewed_candidate    a Review Queue item — never covering, however good
 *
 * Nothing here decides anything for a person: covering means "the fields we hold
 * say so", and the checks carry which field and where it came from so the
 * person can defend (or refuse) the answer.
 *
 * WHAT IS NOT A MATCH, ON PURPOSE:
 *   - a date under a different role (a code date is not a production date);
 *   - a stored date that reads two ways (02/07/2026) — it is reported as
 *     unverifiable, not guessed;
 *   - a field holding several values (a collapsed multi-lot record) — it names
 *     the values and asks the person to confirm;
 *   - a lot the query only prefixes.
 *
 * Pure. Retrieval (what gets checked) is functions/lib/search-coverage.ts.
 */

import type {
  SearchCheckOutcome,
  SearchConstraint,
  SearchConstraintCheck,
  SearchCoverage,
  SearchDateRole,
  SearchDroppedConstraint,
  SearchFieldProvenance,
  SearchMatchedLot,
  SearchMatchStatus,
} from './types';
import {
  daysBetween,
  findQueryDates,
  formatIsoHuman,
  formatMonthDay,
  inferDocumentDateOrder,
  readStoredDates,
  type DateOrder,
  type QueryDate,
  type StoredDateReading,
} from './searchDates';
import { normalizeLotNumber, normalizeSubLotCode } from './lotNormalize';

// ===========================================================================
// Field vocabulary
// ===========================================================================

/**
 * The metadata keys each date role is read from. `production` includes the
 * manufacture and pack spellings; `code_date` is its own role because a COA can
 * print both and they are weeks apart (Andersen's 2026 layout).
 */
export const DATE_ROLE_FIELDS: Record<Exclude<SearchDateRole, 'any' | 'uploaded'>, string[]> = {
  production: [
    'production_date', 'mfg_date', 'manufacture_date', 'manufacturing_date',
    'date_of_manufacture', 'prod_date', 'pack_date', 'packed_date', 'packaging_date',
  ],
  code: ['code_date'],
  expiration: [
    'expiration_date', 'exp_date', 'best_by', 'best_before', 'use_by', 'sell_by',
    'document_expires_on',
  ],
  ship: ['ship_date', 'shipping_date', 'date_shipped'],
};

/** Columns on `documents` that also carry a role, recorded by the portal. */
const SYSTEM_DATE_FIELDS: Record<string, SearchDateRole> = {
  renewal_due_date: 'expiration',
  created_at: 'uploaded',
};

const FIELD_LABELS: Record<string, string> = {
  production_date: 'production date',
  mfg_date: 'manufacture date',
  manufacture_date: 'manufacture date',
  manufacturing_date: 'manufacture date',
  date_of_manufacture: 'manufacture date',
  prod_date: 'production date',
  pack_date: 'pack date',
  packed_date: 'pack date',
  packaging_date: 'pack date',
  code_date: 'code date',
  expiration_date: 'expiration date',
  exp_date: 'expiration date',
  best_by: 'best-by date',
  best_before: 'best-before date',
  use_by: 'use-by date',
  sell_by: 'sell-by date',
  document_expires_on: 'document expiry date',
  renewal_due_date: 'renewal due date',
  ship_date: 'ship date',
  shipping_date: 'ship date',
  date_shipped: 'ship date',
  created_at: 'upload date',
  lot: 'lot',
  supplier: 'supplier',
  product: 'product',
  document_type: 'document type',
  text: 'document text',
  po_number: 'PO number',
  order_number: 'order number',
  product_code: 'product code',
};

export const ROLE_LABELS: Record<SearchDateRole, string> = {
  production: 'production date',
  code: 'code date',
  expiration: 'expiration date',
  ship: 'ship date',
  uploaded: 'upload date',
  any: 'date',
};

function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;
}

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field.replace(/_/g, ' ');
}

export function roleFields(role: SearchDateRole): string[] {
  if (role === 'uploaded') return ['created_at'];
  if (role === 'any') {
    return [
      ...DATE_ROLE_FIELDS.production, ...DATE_ROLE_FIELDS.code,
      ...DATE_ROLE_FIELDS.expiration, ...DATE_ROLE_FIELDS.ship,
    ];
  }
  const fields = [...DATE_ROLE_FIELDS[role]];
  if (role === 'expiration') fields.push('renewal_due_date');
  return fields;
}

export function roleOfField(field: string): SearchDateRole | null {
  if (SYSTEM_DATE_FIELDS[field]) return SYSTEM_DATE_FIELDS[field];
  for (const [role, fields] of Object.entries(DATE_ROLE_FIELDS)) {
    if (fields.includes(field)) return role as SearchDateRole;
  }
  return null;
}

/** Two weeks either side of the asked day counts as "nearby" for a candidate. */
export const NEAR_DATE_DAYS = 14;

// ===========================================================================
// Subjects — the one shape a document or a queue record is checked in
// ===========================================================================

export interface SubjectLot {
  lot_id?: string | null;
  lot_number: string;
  sub_lot_code: string;
  lot_key: string;
  provenance: SearchFieldProvenance;
  /** Migration 0106 — the row's own production date and where it came from. */
  production_date?: string | null;
  production_date_raw?: string | null;
  production_date_source?: 'extracted' | 'extracted_code_date_legacy' | 'reviewer' | null;
  production_date_status?: 'resolved' | 'ambiguous' | 'unparseable' | 'conflict' | null;
}

export interface CoverageSubject {
  id: string;
  supplier_name: string | null;
  supplier_aliases: string[];
  document_type_slug: string | null;
  document_type_name: string | null;
  /** Linked product records. */
  product_names: string[];
  /** primary_metadata over extended_metadata (tables removed). */
  metadata: Record<string, unknown>;
  /** Linked lot records (document_lots → lots). Metadata lots are derived here. */
  lots: SubjectLot[];
  created_at: string | null;
  renewal_due_date: string | null;
  /** Did the free-text part of the query hit this document? null = not asked. */
  text_match: boolean | null;
  /**
   * Judged as ONE lot row: `lots` holds exactly that row, a row production date
   * outranks the document's metadata, and metadata lots count only when they
   * refine that row. Set by `evaluateSubject`, never by retrieval.
   */
  row_scoped?: boolean;
}

// ===========================================================================
// Query-text constraint extraction (instant search)
// ===========================================================================

const ROLE_BEFORE: Array<{ role: SearchDateRole; re: RegExp }> = [
  { role: 'production', re: /\b(?:production|produced|prod\.?|manufactur(?:e|ed|ing)|mfg\.?|mfd\.?|made|pack(?:ed|ing|aged)?)(?:\s+(?:date|dt|day))?(?:\s+(?:on|of))?\s*[:#-]?\s*$/i },
  { role: 'code', re: /\bcode(?:\s+(?:date|dt))?\s*[:#-]?\s*$/i },
  { role: 'expiration', re: /\b(?:exp(?:iry|iration|ires|iring)?\.?|best[\s-]*(?:by|before|if\s+used\s+by)|use[\s-]*by|sell[\s-]*by)(?:\s+(?:date|dt|on))?\s*[:#-]?\s*$/i },
  { role: 'ship', re: /\bship(?:ped|ping)?(?:\s+(?:date|dt|on))?\s*[:#-]?\s*$/i },
  { role: 'any', re: /\bdated?\s*[:#-]?\s*$/i },
];

const ROLE_AFTER: Array<{ role: SearchDateRole; re: RegExp }> = [
  { role: 'production', re: /^\s*(?:production|prod|manufacture|mfg|pack)\s+date\b/i },
  { role: 'code', re: /^\s*code\s+date\b/i },
  { role: 'expiration', re: /^\s*(?:expiration|expiry|exp|best[\s-]by)\s+date\b/i },
  { role: 'ship', re: /^\s*ship(?:ping)?\s+date\b/i },
];

export interface LotToken {
  raw: string;
  norm: string;
  /** Preceded by "lot" / "batch" — a lot by declaration, not by resemblance. */
  explicit: boolean;
  start: number;
  end: number;
  /** Base and sublot typed apart ("10426203 03", "lot 10426203 sublot 03"). */
  parts?: { base: string; sub: string };
}

export interface QueryTextParse {
  dates: Array<{ role: SearchDateRole; date: QueryDate; start: number; end: number; roleSpan: [number, number] | null }>;
  lotTokens: LotToken[];
}

/**
 * Find role-dated phrases and lot-shaped tokens in a typed query. Pure and
 * cheap — it decides whether the query needs the constraint path at all.
 */
export function parseQueryText(q: string): QueryTextParse {
  const text = q;
  const roleWindowBefore = (idx: number): { role: SearchDateRole; start: number } | null => {
    const windowStart = Math.max(0, idx - 40);
    const before = text.slice(windowStart, idx);
    for (const r of ROLE_BEFORE) {
      const m = r.re.exec(before);
      if (m) return { role: r.role, start: windowStart + m.index };
    }
    return null;
  };

  const hits = findQueryDates(text, {
    allowYearless: (idx) => {
      const r = roleWindowBefore(idx);
      return r !== null && r.role !== 'any';
    },
  });

  const dates: QueryTextParse['dates'] = [];
  for (const h of hits) {
    const end = h.index + h.length;
    let role: SearchDateRole = 'any';
    let roleSpan: [number, number] | null = null;
    const before = roleWindowBefore(h.index);
    if (before) {
      role = before.role;
      roleSpan = [before.start, h.index];
    } else {
      const after = text.slice(end, end + 30);
      for (const r of ROLE_AFTER) {
        const m = r.re.exec(after);
        if (m) {
          role = r.role;
          roleSpan = [end, end + m[0].length];
          break;
        }
      }
    }
    dates.push({ role, date: h.date, start: h.index, end, roleSpan });
  }

  const taken = dates.flatMap((d) => [[d.start, d.end], ...(d.roleSpan ? [d.roleSpan] : [])]);
  const lotTokens: LotToken[] = [];
  const tokenRe = /[A-Za-z0-9][A-Za-z0-9\-./#]*/g;
  let m: RegExpExecArray | null;
  const all: Array<{ raw: string; start: number; end: number }> = [];
  while ((m = tokenRe.exec(text)) !== null) {
    all.push({ raw: m[0].replace(/[.\-/]+$/, ''), start: m.index, end: m.index + m[0].length });
  }
  for (let i = 0; i < all.length; i++) {
    const t = all[i];
    if (taken.some(([s, e]) => t.start < e && t.end > s)) continue;
    const prev = i > 0 ? all[i - 1].raw.toLowerCase() : '';
    const explicit = /^(lot|lot#|batch|sublot)$/.test(prev) || /^lot#?\d/i.test(t.raw);
    const norm = normalizeLotNumber(t.raw);
    const digits = (norm.match(/\d/g) || []).length;
    if (norm.length < 5 || digits < 4) continue;
    // "lot 10426203 sublot 03" / "lot 10426203 03" — base and sublot typed apart.
    let raw = t.raw;
    let end = t.end;
    let composed = norm;
    let parts: { base: string; sub: string } | undefined;
    const next = all[i + 1];
    const next2 = all[i + 2];
    // "10426203 03" with no "lot" in front: a long all-digit lot followed by
    // exactly two digits is AJ's own spaced shape (R2), and a two-digit number
    // that close to a lot number is its sublot — nothing else in a COA search
    // is typed that way.
    const spacedSublot = /^\d{8,}$/.test(norm) && !!next && /^\d{2}$/.test(next.raw)
      && /^\s+$/.test(text.slice(t.end, next.start));
    if (explicit && next && /^(sublot|sub-lot|sub)$/i.test(next.raw) && next2 && /^[A-Za-z0-9]{1,3}$/.test(next2.raw)) {
      parts = { base: norm, sub: normalizeSubLotCode(next2.raw) };
      composed = norm + parts.sub;
      raw = `${t.raw} sublot ${next2.raw}`;
      end = next2.end;
      i += 2;
    } else if ((explicit || spacedSublot) && next && /^\d{2}$/.test(next.raw)) {
      parts = { base: norm, sub: next.raw };
      composed = norm + next.raw;
      raw = `${t.raw} ${next.raw}`;
      end = next.end;
      i += 1;
    }
    lotTokens.push({ raw, norm: composed, explicit, start: t.start, end, ...(parts ? { parts } : {}) });
  }

  return { dates, lotTokens };
}

/**
 * Words that phrase a request rather than describe a document. "COA" is here
 * because "COA for lot 1042620303" asks for the certificate covering that lot —
 * requiring the word "COA" to appear in the document's text would turn the one
 * covering certificate into a non-match over a word most certificates never
 * print. It is not turned into a document-type constraint either: that would be
 * inventing a constraint from an abbreviation.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'for', 'of', 'on', 'with', 'and', 'or', 'in', 'to', 'from',
  'date', 'dated', 'lot', 'lot#', 'batch', 'sublot', 'please', 'find', 'show', 'me', 'get',
  'need', 'send', 'coa', 'coas',
]);

/** What is left of the query once the constraint phrases are cut out of it. */
export function residualText(q: string, spans: Array<[number, number]>): string {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [s, e] of sorted) {
    if (s > pos) out += q.slice(pos, s);
    out += ' ';
    pos = Math.max(pos, e);
  }
  out += q.slice(pos);
  return out
    .split(/\s+/)
    .map((w) => w.replace(/^[,;:]+|[,;:]+$/g, ''))
    .filter((w) => w && !STOP_WORDS.has(w.toLowerCase()))
    .join(' ');
}

// ===========================================================================
// Constraint builders
// ===========================================================================

export function dateConstraintLabel(role: SearchDateRole, date: QueryDate | { from: string | null; to: string | null }): string {
  const roleLabel = ROLE_LABELS[role];
  if ('kind' in date) {
    return date.kind === 'day'
      ? `${roleLabel} ${formatIsoHuman(date.iso)}`
      : `${roleLabel} ${formatMonthDay(date.month, date.day)} (any year)`;
  }
  if (date.from && date.to && date.from === date.to) return `${roleLabel} ${formatIsoHuman(date.from)}`;
  if (date.from && date.to) return `${roleLabel} between ${formatIsoHuman(date.from)} and ${formatIsoHuman(date.to)}`;
  if (date.from) return `${roleLabel} on or after ${formatIsoHuman(date.from)}`;
  if (date.to) return `${roleLabel} on or before ${formatIsoHuman(date.to)}`;
  return roleLabel;
}

export function makeDateConstraint(
  id: string,
  role: SearchDateRole,
  date: QueryDate,
  source: SearchConstraint['source'],
): SearchConstraint {
  const fields = roleFields(role);
  const noAnyRoleNote = role === 'any'
    ? 'No date role was given, so this matches any date printed on a document (production, code, expiration, ship). Say "production date" or "expiry" to narrow it.'
    : null;
  const note = [date.note, noAnyRoleNote].filter(Boolean).join(' ') || null;
  return {
    id,
    kind: 'date',
    label: dateConstraintLabel(role, date),
    raw: date.raw,
    value: date.kind === 'day' ? date.iso : `--${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`,
    fields,
    role,
    date_from: date.kind === 'day' ? date.iso : null,
    date_to: date.kind === 'day' ? date.iso : null,
    month_day: date.kind === 'month_day' ? { month: date.month, day: date.day } : null,
    source,
    note,
  };
}

export function makeDateRangeConstraint(
  id: string,
  role: SearchDateRole,
  from: string | null,
  to: string | null,
  raw: string,
  source: SearchConstraint['source'],
): SearchConstraint {
  return {
    id,
    kind: 'date',
    label: dateConstraintLabel(role, { from, to }),
    raw,
    value: `${from ?? ''}..${to ?? ''}`,
    fields: roleFields(role),
    role,
    date_from: from,
    date_to: to,
    month_day: null,
    source,
    note: null,
  };
}

export function formatLot(norm: string, sub?: string): string {
  return sub ? `${norm}-${sub}` : norm;
}

export function makeLotConstraint(
  id: string,
  token: { raw: string; norm: string; parts?: { base: string; sub: string } },
  source: SearchConstraint['source'],
): SearchConstraint {
  const parts = token.parts && token.parts.base && token.parts.sub ? token.parts : null;
  return {
    id,
    kind: 'lot',
    label: parts ? `lot ${parts.base} · sublot ${parts.sub}` : `lot ${token.raw.replace(/^lot\s*#?\s*/i, '')}`,
    raw: token.raw,
    value: token.norm,
    fields: ['lot'],
    lot_parts: parts,
    source,
    note: null,
  };
}

/**
 * A lot given as two separate inputs (AJ A3). The base and the sublot are
 * matched as parts; `value` carries their concatenation only so the prefix and
 * near-sublot rules keep working. Returns null when the base normalizes to
 * nothing.
 */
export function makeStructuredLotConstraint(id: string, base: string, sub: string | null | undefined): SearchConstraint | null {
  const b = normalizeLotNumber(base);
  if (!b) return null;
  const s = normalizeSubLotCode(sub ?? '');
  const raw = s ? `${base.trim()} sublot ${String(sub).trim()}` : base.trim();
  return {
    ...makeLotConstraint(id, { raw, norm: b + s, parts: s ? { base: b, sub: s } : undefined }, 'structured'),
    label: s ? `lot ${b} · sublot ${s}` : `lot ${b}`,
  };
}

// ===========================================================================
// Checks
// ===========================================================================

const OUTCOME_RANK: Record<SearchCheckOutcome, number> = {
  match: 9,
  likely: 8,
  multiple_values: 7,
  ambiguous: 6,
  near: 5,
  partial_lot: 4,
  role_mismatch: 3,
  unverified: 2,
  mismatch: 1,
  missing: 0,
};

function better(a: SearchConstraintCheck | null, b: SearchConstraintCheck): SearchConstraintCheck {
  if (!a) return b;
  return OUTCOME_RANK[b.outcome] > OUTCOME_RANK[a.outcome] ? b : a;
}

function normWords(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, ' ')
    .replace(/\b(inc|llc|l l c|co|corp|corporation|company|ltd|limited|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normAlnum(s: string): string {
  return String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function metaString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/** Lot identities a subject holds: its linked lot records, then its extracted fields. */
export function subjectLotIdentities(s: CoverageSubject): Array<{ base: string; sub: string; key: string; display: string; provenance: SearchFieldProvenance }> {
  const out: Array<{ base: string; sub: string; key: string; display: string; provenance: SearchFieldProvenance }> = [];
  const seen = new Set<string>();
  const push = (lotNumber: string, subRaw: string, key: string, provenance: SearchFieldProvenance) => {
    const base = normalizeLotNumber(lotNumber);
    if (!base) return;
    const sub = normalizeSubLotCode(subRaw);
    const id = `${base}|${sub}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ base, sub, key: normAlnum(key || base + sub), display: formatLot(base, sub), provenance });
  };
  for (const l of s.lots) push(l.lot_number, l.sub_lot_code, l.lot_key, l.provenance);
  const rowBases = s.row_scoped ? new Set(s.lots.map((l) => normalizeLotNumber(l.lot_number))) : null;
  const md = s.metadata;
  const metaLot = metaString(md.lot_number) ?? metaString(md.lot_code) ?? metaString(md.lot);
  if (metaLot) {
    const sub = metaString(md.sub_lot_number) ?? metaString(md.sub_lot_code) ?? metaString(md.sublot) ?? '';
    const parts = metaLot.split(/[,;]|\s{2,}/).map((p) => p.trim()).filter(Boolean);
    for (const p of parts) {
      // Judging one lot row: the document's other lots are not this row's.
      if (rowBases && !rowBases.has(normalizeLotNumber(p))) continue;
      push(p, parts.length === 1 ? sub : '', '', 'extracted');
    }
  }
  // A linked lot record that stored only the base while the extraction recorded
  // the sublot is the same lot, told less precisely — keep the precise one.
  return out.filter((i) => i.sub || !out.some((o) => o !== i && o.base === i.base && o.sub));
}

export function checkLot(c: SearchConstraint, s: CoverageSubject): SearchConstraintCheck {
  const ids = subjectLotIdentities(s);
  const base = { constraint_id: c.id, field: 'lot', field_label: 'lot' } as const;
  if (ids.length === 0) {
    return { ...base, outcome: 'missing', value: null, provenance: null, message: 'No lot is recorded on this document.' };
  }
  const n = c.value;
  const many = ids.length > 1 ? ` (one of ${ids.length} lots on this document)` : '';
  let best: SearchConstraintCheck | null = null;
  const parts = c.lot_parts ?? null;
  for (const id of ids) {
    const composite = id.base + id.sub;
    const common = { ...base, value: id.display, provenance: id.provenance };
    if (parts) {
      // Two inputs: base against base, sublot against sublot (R2). A record that
      // stored only the composite ("1042620303", no sublot) is the same lot
      // written the WMS way, and says so.
      if (id.sub && id.base === parts.base && id.sub === parts.sub) {
        best = better(best, { ...common, outcome: 'match', message: `Lot ${id.base} sublot ${id.sub} is on this document${many}.` });
        continue;
      }
      if (!id.sub && id.base === parts.base + parts.sub) {
        best = better(best, {
          ...common,
          outcome: 'match',
          message: `Lot ${id.base} is on this document${many} — recorded as one number, which is lot ${parts.base} sublot ${parts.sub} written together.`,
        });
        continue;
      }
      if (id.sub && id.base === parts.base) {
        best = better(best, {
          ...common,
          outcome: 'near',
          message: `This document is lot ${id.base} sublot ${id.sub} — the same lot, a different sublot than ${parts.sub}.`,
        });
        continue;
      }
      if (!id.sub && id.base === parts.base) {
        best = better(best, {
          ...common,
          outcome: 'partial_lot',
          message: `This document records lot ${id.base} with no sublot, so sublot ${parts.sub} can't be verified.`,
        });
        continue;
      }
      best = better(best, { ...common, outcome: 'mismatch', message: `Lot on this document is ${id.display}, not lot ${parts.base} sublot ${parts.sub}.` });
      continue;
    }
    if (n === composite || n === id.key) {
      best = better(best, { ...common, outcome: 'match', message: `Lot ${id.display} is on this document${many}.` });
    } else if (n === id.base && id.sub) {
      best = better(best, { ...common, outcome: 'match', message: `Lot ${id.base} is on this document as sublot ${id.sub}${many}.` });
    } else if (id.sub && n.length === composite.length && n.startsWith(id.base)) {
      best = better(best, {
        ...common,
        outcome: 'near',
        message: `This document is lot ${id.display} — the same lot, a different sublot than ${formatLot(id.base, n.slice(id.base.length))}.`,
      });
    } else if (!id.sub && n.startsWith(id.base) && n.length - id.base.length <= 3) {
      best = better(best, {
        ...common,
        outcome: 'partial_lot',
        message: `This document records lot ${id.base} with no sublot, so sublot ${n.slice(id.base.length)} can't be verified.`,
      });
    } else if (composite.startsWith(n) && n.length >= 5) {
      best = better(best, {
        ...common,
        outcome: 'partial_lot',
        message: `Partial lot match: this document is lot ${id.display}; ${c.raw} is only the start of it.`,
      });
    } else {
      best = better(best, { ...common, outcome: 'mismatch', message: `Lot on this document is ${id.display}, not ${c.raw}.` });
    }
  }
  if (best && best.outcome === 'mismatch' && ids.length > 1) {
    best = { ...best, value: ids.map((i) => i.display).join(', '), message: `Lots on this document are ${ids.map((i) => i.display).join(', ')} — none is ${c.raw}.` };
  }
  return best!;
}

interface DateHitEval {
  field: string;
  raw: string;
  reading: StoredDateReading;
  provenance: SearchFieldProvenance;
  lot_row?: boolean;
  row_status?: SubjectLot['production_date_status'];
}

interface DateValue {
  field: string;
  value: string;
  provenance: SearchFieldProvenance;
  /** Read from the lot row (0106) rather than the document's metadata. */
  lot_row?: boolean;
  row_status?: SubjectLot['production_date_status'];
}

/** The one lot row a row-scoped subject is judged on, when it states a production date. */
function rowProduction(s: CoverageSubject): SubjectLot | null {
  if (!s.row_scoped || s.lots.length !== 1) return null;
  const l = s.lots[0];
  return l.production_date_status ? l : null;
}

function subjectDateValues(s: CoverageSubject, fields: string[]): DateValue[] {
  const out: DateValue[] = [];
  const row = rowProduction(s);
  for (const f of fields) {
    // A lot row that states its production date answers for every production
    // spelling in the metadata: it is the same statement, for this row alone.
    if (row && DATE_ROLE_FIELDS.production.includes(f)) {
      if (f !== 'production_date') continue;
      const value = row.production_date ?? row.production_date_raw;
      if (!value) continue;
      const source = row.production_date_source ?? 'extracted';
      out.push({
        field: f,
        value,
        provenance: source === 'extracted' ? 'extracted' : source,
        lot_row: true,
        row_status: row.production_date_status,
      });
      continue;
    }
    if (f === 'created_at') {
      if (s.created_at) out.push({ field: f, value: s.created_at.slice(0, 10), provenance: 'system' });
      continue;
    }
    if (f === 'renewal_due_date') {
      if (s.renewal_due_date) out.push({ field: f, value: s.renewal_due_date, provenance: 'system' });
      continue;
    }
    const v = metaString(s.metadata[f]);
    if (v) out.push({ field: f, value: v, provenance: 'extracted' });
  }
  return out;
}

function inConstraint(c: SearchConstraint, isoDate: string): boolean {
  if (c.month_day) {
    return parseInt(isoDate.slice(5, 7), 10) === c.month_day.month && parseInt(isoDate.slice(8, 10), 10) === c.month_day.day;
  }
  if (c.date_from && isoDate < c.date_from) return false;
  if (c.date_to && isoDate > c.date_to) return false;
  return true;
}

/** Distance in days from a stored date to a single-day constraint, or null. */
function distanceTo(c: SearchConstraint, isoDate: string): number | null {
  if (c.month_day) {
    const y = parseInt(isoDate.slice(0, 4), 10);
    const target = `${y}-${String(c.month_day.month).padStart(2, '0')}-${String(c.month_day.day).padStart(2, '0')}`;
    return Math.abs(daysBetween(target, isoDate));
  }
  if (c.date_from && c.date_to && c.date_from === c.date_to) return Math.abs(daysBetween(c.date_from, isoDate));
  return null;
}

function describeReading(r: StoredDateReading): string {
  if (r.kind === 'exact') return r.raw === r.iso ? formatIsoHuman(r.iso) : `${r.raw} (${formatIsoHuman(r.iso)})`;
  return `${r.raw}, which could be ${formatIsoHuman(r.mdy)} or ${formatIsoHuman(r.dmy)}`;
}

export function checkDate(c: SearchConstraint, s: CoverageSubject, order: DateOrder | null): SearchConstraintCheck {
  const role = c.role ?? 'any';
  const asked = c.label;
  const base = { constraint_id: c.id } as const;
  const evaluate = (fields: string[]) => {
    const hits: DateHitEval[] = [];
    const unparsed: DateValue[] = [];
    for (const v of subjectDateValues(s, fields)) {
      const readings = readStoredDates(v.value, v.field === 'created_at' ? null : order);
      if (readings.length === 0) unparsed.push(v);
      for (const r of readings) {
        hits.push({ field: v.field, raw: v.value, reading: r, provenance: v.provenance, lot_row: v.lot_row, row_status: v.row_status });
      }
    }
    return { hits, unparsed };
  };

  const own = evaluate(c.fields);
  let best: SearchConstraintCheck | null = null;

  // Group by field so "several dates in one field" is recognised as such.
  const byField = new Map<string, DateHitEval[]>();
  for (const h of own.hits) byField.set(h.field, [...(byField.get(h.field) ?? []), h]);

  for (const [field, hits] of byField) {
    const label = fieldLabel(field);
    const provenance = hits[0].provenance;
    const rawValue = hits[0].raw;
    const common = { ...base, field, field_label: label, value: rawValue, provenance };
    const onThis = hits[0].lot_row ? 'this lot row' : 'this document';
    const matching = hits.filter((h) => h.reading.kind === 'exact' && inConstraint(c, h.reading.iso));
    const ambiguousMatching = hits.filter((h) => h.reading.kind === 'ambiguous' && h.reading.readings.some((iso) => inConstraint(c, iso)));
    const distinctDays = new Set(hits.map((h) => (h.reading.kind === 'exact' ? h.reading.iso : h.reading.raw)));

    if (matching.length > 0 && distinctDays.size === 1) {
      const r = matching[0].reading as Extract<StoredDateReading, { kind: 'exact' }>;
      const how = r.order && r.raw !== r.iso
        ? ` (read as ${r.order === 'mdy' ? 'month/day' : 'day/month'} because this document writes its other dates that way)`
        : '';
      if (provenance === 'extracted_code_date_legacy') {
        // Not verified: the value is right, its ROLE was inferred from the page
        // by the backfill. Shown as likely, for a person to confirm.
        best = better(best, {
          ...common,
          outcome: 'likely',
          message: `The ${label} on ${onThis} is ${formatIsoHuman(r.iso)} — read from the document's code date field (older extraction), which the page prints under its production date label. Open the certificate to confirm before using it.`,
        });
      } else {
        best = better(best, { ...common, outcome: 'match', message: `The ${label} on ${onThis} is ${formatIsoHuman(r.iso)}${how}.` });
      }
    } else if (matching.length > 0 || ambiguousMatching.length > 0) {
      if (hits[0].row_status === 'conflict') {
        best = better(best, {
          ...common,
          outcome: 'multiple_values',
          message: `Certificates on file state different production dates for this lot (${rawValue}); one of them is the date asked for — confirm which is right.`,
        });
      } else if (distinctDays.size > 1) {
        best = better(best, {
          ...common,
          outcome: 'multiple_values',
          message: `This document lists several ${label}s (${rawValue}); one of them is the date asked for — confirm which lot it belongs to.`,
        });
      } else {
        const r = ambiguousMatching[0].reading;
        best = better(best, {
          ...common,
          outcome: 'ambiguous',
          message: `The ${label} on this document is written ${describeReading(r)} — it can't be verified as ${asked}.`,
        });
      }
    } else {
      // Not a match — nearby (same role) or plainly different.
      let nearest: number | null = null;
      for (const h of hits) {
        const isos = h.reading.kind === 'exact' ? [h.reading.iso] : h.reading.readings;
        for (const iso of isos) {
          const d = distanceTo(c, iso);
          if (d !== null && (nearest === null || d < nearest)) nearest = d;
        }
      }
      const shown = hits.length === 1 ? describeReading(hits[0].reading) : rawValue;
      const msg = `The ${label} on ${onThis} is ${shown}; you asked for ${asked}.`;
      best = better(best, {
        ...common,
        outcome: nearest !== null && nearest <= NEAR_DATE_DAYS ? 'near' : 'mismatch',
        message: msg,
        distance_days: nearest,
      });
    }
  }

  if (best && best.outcome !== 'mismatch') return best;
  // A near or mismatched row date still answers the question for this row:
  // the document's code date is not consulted as a production date then.
  if (best && own.hits.some((h) => h.lot_row)) return best;

  if (!best && own.unparsed.length > 0) {
    const u = own.unparsed[0];
    return {
      ...base, outcome: 'unverified', field: u.field, field_label: fieldLabel(u.field), value: u.value, provenance: u.provenance,
      message: `The ${fieldLabel(u.field)} on this document is "${u.value}", which isn't a date that can be compared.`,
    };
  }

  // The asked date under a DIFFERENT role — the West Point case: a code date of
  // 7/31 is not a production date of 7/31, and must never read as one.
  if (role !== 'any' && role !== 'uploaded') {
    const otherFields = roleFields('any').filter((f) => !c.fields.includes(f));
    const other = evaluate(otherFields);
    const hit = other.hits.find((h) => (h.reading.kind === 'exact' ? inConstraint(c, h.reading.iso) : false));
    if (hit) {
      const label = fieldLabel(hit.field);
      const legacy = role === 'production' && hit.field === 'code_date'
        ? ' Older extractions sometimes stored a production date as the code date — open the document to check which it is.'
        : '';
      return {
        ...base, outcome: 'role_mismatch', field: hit.field, field_label: label, value: hit.raw, provenance: hit.provenance,
        message: `This document's ${label} is ${formatIsoHuman((hit.reading as Extract<StoredDateReading, { kind: 'exact' }>).iso)}, but you asked for the ${ROLE_LABELS[role]} — ${withArticle(label)} is not ${withArticle(ROLE_LABELS[role])}.${legacy}`,
      };
    }
  }

  if (best) return best;
  return {
    ...base, outcome: 'missing', field: c.fields[0] ?? null, field_label: ROLE_LABELS[role], value: null, provenance: null,
    message: `No ${ROLE_LABELS[role]} is recorded on this document.`,
  };
}

export function checkSupplier(c: SearchConstraint, s: CoverageSubject): SearchConstraintCheck {
  const want = normWords(c.value);
  const base = { constraint_id: c.id, field: 'supplier', field_label: 'supplier' } as const;
  const candidates: Array<{ name: string; provenance: SearchFieldProvenance }> = [];
  if (s.supplier_name) candidates.push({ name: s.supplier_name, provenance: 'linked_record' });
  for (const a of s.supplier_aliases) candidates.push({ name: a, provenance: 'linked_record' });
  const metaSupplier = metaString(s.metadata.supplier_name);
  if (metaSupplier) candidates.push({ name: metaSupplier, provenance: 'extracted' });
  if (candidates.length === 0) {
    return { ...base, outcome: 'missing', value: null, provenance: null, message: 'No supplier is recorded on this document.' };
  }
  for (const cand of candidates) {
    const have = normWords(cand.name);
    if (want && have && (have.includes(want) || want.includes(have))) {
      return { ...base, outcome: 'match', value: s.supplier_name ?? cand.name, provenance: cand.provenance, message: `Supplier on this document is ${s.supplier_name ?? cand.name}.` };
    }
  }
  const shown = s.supplier_name ?? metaSupplier ?? candidates[0].name;
  return { ...base, outcome: 'mismatch', value: shown, provenance: candidates[0].provenance, message: `Supplier on this document is ${shown}, not ${c.raw}.` };
}

export function checkProduct(c: SearchConstraint, s: CoverageSubject): SearchConstraintCheck {
  const base = { constraint_id: c.id, field: 'product', field_label: 'product' } as const;
  const terms = c.value.split(PRODUCT_VALUE_SEP).map(normWords).filter(Boolean);
  const names: Array<{ name: string; provenance: SearchFieldProvenance }> = [
    ...s.product_names.map((n) => ({ name: n, provenance: 'linked_record' as const })),
  ];
  const metaProduct = metaString(s.metadata.product_name);
  if (metaProduct) names.push({ name: metaProduct, provenance: 'extracted' });
  if (names.length === 0) {
    return { ...base, outcome: 'missing', value: null, provenance: null, message: 'No product is recorded on this document.' };
  }
  for (const n of names) {
    const have = normWords(n.name);
    if (terms.some((t) => have.includes(t) || t.includes(have))) {
      return { ...base, outcome: 'match', value: n.name, provenance: n.provenance, message: `Product on this document is ${n.name}.` };
    }
  }
  return {
    ...base, outcome: 'mismatch', value: names[0].name, provenance: names[0].provenance,
    message: `Product on this document is ${names.map((n) => n.name).join(', ')}, not ${c.raw}.`,
  };
}

export function checkDocumentType(c: SearchConstraint, s: CoverageSubject): SearchConstraintCheck {
  const base = { constraint_id: c.id, field: 'document_type', field_label: 'document type' } as const;
  if (!s.document_type_slug && !s.document_type_name) {
    return { ...base, outcome: 'missing', value: null, provenance: null, message: 'This document has no document type.' };
  }
  const want = c.value.toLowerCase();
  const ok = s.document_type_slug?.toLowerCase() === want || s.document_type_name?.toLowerCase() === want;
  const shown = s.document_type_name ?? s.document_type_slug;
  return ok
    ? { ...base, outcome: 'match', value: shown, provenance: 'linked_record', message: `This document is a ${shown}.` }
    : { ...base, outcome: 'mismatch', value: shown, provenance: 'linked_record', message: `This document is a ${shown}, not a ${c.raw}.` };
}

export function checkMetadata(c: SearchConstraint, s: CoverageSubject): SearchConstraintCheck {
  const field = c.fields[0];
  const label = fieldLabel(field);
  const base = { constraint_id: c.id, field, field_label: label } as const;
  const v = metaString(s.metadata[field]);
  if (!v) {
    return { ...base, outcome: 'missing', value: null, provenance: null, message: `No ${label} is recorded on this document.` };
  }
  const contains = c.match === 'contains';
  const have = normAlnum(v);
  const want = normAlnum(c.value);
  const ok = contains ? have.includes(want) : have === want;
  return ok
    ? { ...base, outcome: 'match', value: v, provenance: 'extracted', message: `The ${label} on this document is ${v}.` }
    : { ...base, outcome: 'mismatch', value: v, provenance: 'extracted', message: `The ${label} on this document is ${v}, not ${c.raw}.` };
}

export function checkText(c: SearchConstraint, s: CoverageSubject): SearchConstraintCheck {
  const base = { constraint_id: c.id, field: 'text', field_label: 'document text', value: null, provenance: 'extracted' as const };
  return s.text_match
    ? { ...base, outcome: 'match', message: `This document mentions "${c.raw}".` }
    : { ...base, outcome: 'mismatch', message: `This document doesn't mention "${c.raw}".` };
}

export function checkConstraint(c: SearchConstraint, s: CoverageSubject, order: DateOrder | null): SearchConstraintCheck {
  switch (c.kind) {
    case 'lot': return checkLot(c, s);
    case 'date': return checkDate(c, s, order);
    case 'supplier': return checkSupplier(c, s);
    case 'product': return c.fields[0] === 'product_code' ? checkMetadata(c, s) : checkProduct(c, s);
    case 'document_type': return checkDocumentType(c, s);
    case 'metadata': return checkMetadata(c, s);
    case 'text': return checkText(c, s);
  }
}

/** The date order a subject's own dates prove (see searchDates.inferDocumentDateOrder). */
export function subjectDateOrder(s: CoverageSubject): DateOrder | null {
  const values = roleFields('any').map((f) => s.metadata[f]).filter((v) => v != null);
  return inferDocumentDateOrder(values);
}

// ===========================================================================
// Classification
// ===========================================================================

export interface SubjectVerdict {
  status: Exclude<SearchMatchStatus, 'unreviewed_candidate'>;
  /** The lot row this verdict was reached on, when the subject has lot rows. */
  lot: SubjectLot | null;
  checks: SearchConstraintCheck[];
  reason: string | null;
  /** Does this subject belong in the result list at all? */
  eligible: boolean;
  /** Higher = closer to what was asked. */
  score: number;
}

const RELEVANT: ReadonlySet<SearchCheckOutcome> = new Set([
  'match', 'likely', 'near', 'role_mismatch', 'ambiguous', 'partial_lot', 'multiple_values',
]);

export function isIdentifying(c: SearchConstraint): boolean {
  return c.kind === 'lot' || c.kind === 'date';
}

const STATUS_RANK: Record<SubjectVerdict['status'], number> = {
  covering: 2,
  likely_covering: 1,
  candidate_not_matching: 0,
};

/**
 * Judge a subject. A document with lot rows is judged ROW BY ROW (AJ R1): each
 * row with the document's shared fields, the best row wins, and the verdict
 * names it — so a four-lot certificate covers "lot 10426203 sublot 03, produced
 * Jul 22" only when ONE row is both, never by pairing one row's lot with
 * another row's date.
 */
export function evaluateSubject(
  s: CoverageSubject,
  constraints: SearchConstraint[],
  dropped: SearchDroppedConstraint[],
  opts: { inPool?: boolean } = {},
): SubjectVerdict {
  if (s.lots.length === 0 || s.row_scoped) return evaluateOne(s, constraints, dropped, opts);
  let best: SubjectVerdict | null = null;
  for (const lot of s.lots) {
    const v = evaluateOne({ ...s, lots: [lot], row_scoped: true }, constraints, dropped, opts);
    if (!best || STATUS_RANK[v.status] > STATUS_RANK[best.status]
      || (STATUS_RANK[v.status] === STATUS_RANK[best.status] && v.score > best.score)) {
      best = v;
    }
  }
  const verdict = best!;
  // No row matched a lot constraint on a several-lot document: name every lot
  // on it, not just the one the ranking happened to keep.
  if (s.lots.length > 1 && verdict.status === 'candidate_not_matching') {
    let changed = false;
    const checks = verdict.checks.map((ch) => {
      const c = constraints.find((x) => x.id === ch.constraint_id);
      if (!c || c.kind !== 'lot' || ch.outcome !== 'mismatch') return ch;
      changed = true;
      return checkLot(c, s);
    });
    if (changed) {
      const failing = checks.filter((c) => c.outcome !== 'match');
      return { ...verdict, checks, reason: failing.length ? failing.map((c) => c.message).join(' ') : null };
    }
  }
  return verdict;
}

function evaluateOne(
  s: CoverageSubject,
  constraints: SearchConstraint[],
  dropped: SearchDroppedConstraint[],
  opts: { inPool?: boolean },
): SubjectVerdict {
  const order = subjectDateOrder(s);
  const checks = constraints.map((c) => checkConstraint(c, s, order));
  for (const [i, d] of dropped.entries()) {
    checks.push({
      constraint_id: `dropped:${i}`,
      outcome: 'unverified',
      field: null,
      field_label: null,
      value: null,
      provenance: null,
      message: `"${d.label}" couldn't be checked: ${d.reason}`,
    });
  }
  const allMatch = checks.length > 0 && checks.every((c) => c.outcome === 'match');
  const identifying = constraints.filter(isIdentifying);
  const identifyingRelevant = checks.some(
    (ch) => identifying.some((c) => c.id === ch.constraint_id) && RELEVANT.has(ch.outcome),
  );
  const textMatched = checks.some((ch) => ch.field === 'text' && ch.outcome === 'match');
  const eligible = opts.inPool === true
    || textMatched
    || (identifying.length > 0 ? identifyingRelevant : checks.some((ch) => ch.outcome === 'match'));
  const likely = !allMatch && checks.length > 0 && checks.every((c) => c.outcome === 'match' || c.outcome === 'likely');
  let score = 0;
  for (const ch of checks) {
    score += ch.outcome === 'match' ? 100
      : ch.outcome === 'likely' ? 90
      : ch.outcome === 'multiple_values' || ch.outcome === 'ambiguous' ? 80
        : ch.outcome === 'near' ? 50 + Math.max(0, NEAR_DATE_DAYS - (ch.distance_days ?? NEAR_DATE_DAYS))
          : ch.outcome === 'partial_lot' ? 40
            : ch.outcome === 'role_mismatch' ? 30 : 0;
  }
  const failing = checks.filter((c) => c.outcome !== 'match');
  return {
    status: allMatch ? 'covering' : likely ? 'likely_covering' : 'candidate_not_matching',
    lot: s.row_scoped && s.lots.length === 1 ? s.lots[0] : null,
    checks,
    reason: failing.length ? failing.map((c) => c.message).join(' ') : null,
    eligible: allMatch || likely || eligible,
    score,
  };
}

/** The response shape of a verdict's lot row, with the row document's own quantity and weight. */
export function matchedLotOf(v: SubjectVerdict, s: CoverageSubject): SearchMatchedLot | null {
  const l = v.lot;
  if (!l) return null;
  const single = s.lots.length === 1;
  return {
    lot_id: l.lot_id ?? null,
    lot_number: l.lot_number,
    sub_lot_code: l.sub_lot_code,
    lot_key: l.lot_key,
    production_date: l.production_date ?? null,
    production_date_raw: l.production_date_raw ?? null,
    production_date_source: l.production_date_source ?? null,
    production_date_status: l.production_date_status ?? null,
    // Quantity and weight are printed per row: they belong to the row only when
    // this document IS that row (a split certificate), never borrowed otherwise.
    quantity: single ? metaString(s.metadata.quantity) : null,
    net_weight: single ? metaString(s.metadata.net_weight) : null,
  };
}

export function coverageFor(
  constraints: SearchConstraint[],
  dropped: SearchDroppedConstraint[],
  coveringCount: number,
  likelyCount = 0,
): SearchCoverage {
  if (constraints.length === 0 && dropped.length === 0) return 'unconstrained';
  if (dropped.length > 0) return 'none';
  if (coveringCount > 0) return 'covered';
  return likelyCount > 0 ? 'likely' : 'none';
}

/**
 * The one line the page leads with. Written from the reader's side and naming
 * what was asked, because "no results" and "no document on file covers
 * production date Jul 31, 2026" are different answers to a customer.
 */
export function coverageSummary(
  constraints: SearchConstraint[],
  dropped: SearchDroppedConstraint[],
  coveringCount: number,
  likelyCount = 0,
): string | null {
  if (constraints.length === 0 && dropped.length === 0) return null;
  const docType = constraints.find((c) => c.kind === 'document_type');
  const noun = docType ? docType.raw : 'document';
  const asked = constraints.filter((c) => c.kind !== 'document_type').map((c) => c.label);
  const what = asked.length ? asked.join(', ') : (docType ? `document type ${docType.raw}` : 'this search');
  if (dropped.length > 0) {
    return `No ${noun} on file can be confirmed to cover ${what}: ${dropped.map((d) => `"${d.label}"`).join(', ')} couldn't be applied.`;
  }
  if (coveringCount === 0 && likelyCount > 0) {
    return `No ${noun} on file is confirmed to cover ${what}. ${likelyCount} likely ${likelyCount === 1 ? 'does' : 'do'}, on a production date an older extraction filed as the code date — open ${likelyCount === 1 ? 'it' : 'each one'} to confirm.`;
  }
  if (coveringCount === 0) return `No ${noun} on file covers ${what}.`;
  return `${coveringCount} ${noun}${coveringCount === 1 ? '' : 's'} on file cover${coveringCount === 1 ? 's' : ''} ${what}.`;
}

// ===========================================================================
// Natural-language parse → constraints
// ===========================================================================

/** Separator between the any-of product names held in one constraint value. */
export const PRODUCT_VALUE_SEP = '\u001f';

function addDays(isoDate: string, n: number): string {
  const t = Date.parse(`${isoDate}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function parseIsoDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const hits = findQueryDates(String(value));
  if (hits.length !== 1) return null;
  const d = hits[0].date;
  return d.kind === 'day' ? d.iso : null;
}

const LOT_FIELDS = new Set(['lot_number', 'lot', 'lot_code', 'batch_number']);

export interface ParsedQueryLike {
  document_type_slug: string | null;
  product_names: string[];
  supplier_name: string | null;
  date_from: string | null;
  date_to: string | null;
  date_role?: SearchDateRole | null;
  metadata_filters: Array<{ field: string; operator: string; value: string }>;
  expiration_filter: { operator: string; date1: string; date2?: string } | null;
}

/**
 * Turn the LLM's structured reading of a question into constraints, and say
 * out loud whatever could not be applied. Two rules the old loosen-and-retry
 * ladder broke:
 *
 *   1. NOTHING IS SILENTLY LOOSENED. A constraint that cannot be applied goes
 *      into `dropped`, and a search with a dropped constraint cannot report
 *      coverage — `coverageFor` returns 'none'.
 *   2. THE QUESTION'S OWN WORDS OUTRANK THE MODEL'S READING OF THEM. A date the
 *      person typed next to "produced" is a production date, whatever role the
 *      model filed it under, and the day they typed is the day.
 */
export function constraintsFromParsedQuery(
  parsed: ParsedQueryLike,
  rawQuery: string,
  ctx: { documentTypes: Array<{ slug: string; name: string }>; today: string },
): { constraints: SearchConstraint[]; dropped: SearchDroppedConstraint[] } {
  const constraints: SearchConstraint[] = [];
  const dropped: SearchDroppedConstraint[] = [];
  let n = 0;
  const nextId = () => `c${++n}`;

  if (parsed.supplier_name && parsed.supplier_name.trim()) {
    const name = parsed.supplier_name.trim();
    constraints.push({ id: nextId(), kind: 'supplier', label: `supplier ${name}`, raw: name, value: name, fields: ['supplier'], source: 'ai_parse' });
  }

  const products = (parsed.product_names || []).map((p) => String(p).trim()).filter(Boolean);
  if (products.length > 0) {
    constraints.push({
      id: nextId(), kind: 'product', label: `product ${products.join(' or ')}`, raw: products.join(' or '),
      value: products.join(PRODUCT_VALUE_SEP), fields: ['product'], source: 'ai_parse',
    });
  }

  if (parsed.document_type_slug) {
    const slug = parsed.document_type_slug;
    const dt = ctx.documentTypes.find((t) => t.slug === slug || t.name.toLowerCase() === slug.toLowerCase());
    if (dt) {
      constraints.push({ id: nextId(), kind: 'document_type', label: `document type ${dt.name}`, raw: dt.name, value: dt.slug, fields: ['document_type'], source: 'ai_parse' });
    } else {
      dropped.push({ kind: 'document_type', label: `document type ${slug}`, raw: slug, reason: 'there is no document type by that name in this workspace.' });
    }
  }

  for (const f of parsed.metadata_filters || []) {
    const field = String(f.field || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
    const value = String(f.value ?? '').trim();
    const op = f.operator;
    if (!field || !value) {
      dropped.push({ kind: 'metadata', label: `${f.field} ${op} ${f.value}`, raw: String(f.value ?? ''), reason: 'the filter had no field or value.' });
      continue;
    }
    const role = roleOfField(field);
    if (role) {
      const iso = parseIsoDay(value);
      if (!iso) {
        dropped.push({ kind: 'date', label: `${fieldLabel(field)} ${value}`, raw: value, reason: 'that value is not a date that can be compared.' });
        continue;
      }
      if (op === 'gt') constraints.push(makeDateRangeConstraint(nextId(), role, addDays(iso, 1), null, value, 'ai_parse'));
      else if (op === 'lt') constraints.push(makeDateRangeConstraint(nextId(), role, null, addDays(iso, -1), value, 'ai_parse'));
      else constraints.push(makeDateRangeConstraint(nextId(), role, iso, iso, value, 'ai_parse'));
      continue;
    }
    if (LOT_FIELDS.has(field)) {
      if (op === 'gt' || op === 'lt') {
        dropped.push({ kind: 'lot', label: `lot ${op === 'gt' ? 'after' : 'before'} ${value}`, raw: value, reason: 'lots have no order to compare.' });
        continue;
      }
      const norm = normalizeLotNumber(value);
      if (!norm) {
        dropped.push({ kind: 'lot', label: `lot ${value}`, raw: value, reason: 'that is not a lot number.' });
        continue;
      }
      constraints.push(makeLotConstraint(nextId(), { raw: value, norm }, 'ai_parse'));
      continue;
    }
    if (field === 'supplier_name' || field === 'supplier') {
      constraints.push({ id: nextId(), kind: 'supplier', label: `supplier ${value}`, raw: value, value, fields: ['supplier'], source: 'ai_parse' });
      continue;
    }
    if (field === 'product_name' || field === 'product') {
      constraints.push({ id: nextId(), kind: 'product', label: `product ${value}`, raw: value, value, fields: ['product'], source: 'ai_parse' });
      continue;
    }
    if (op === 'gt' || op === 'lt') {
      dropped.push({
        kind: 'metadata',
        label: `${fieldLabel(field)} ${op === 'gt' ? 'greater than' : 'less than'} ${value}`,
        raw: value,
        reason: `${fieldLabel(field)} can't be compared as a number.`,
      });
      continue;
    }
    constraints.push({
      id: nextId(), kind: field === 'product_code' ? 'product' : 'metadata',
      label: `${fieldLabel(field)} ${op === 'contains' ? 'contains ' : ''}${value}`,
      raw: value, value, fields: [field], match: op === 'contains' ? 'contains' : 'equals', source: 'ai_parse',
    });
  }

  if (parsed.date_from || parsed.date_to) {
    // A parser that predates date_role meant upload time; keep that meaning.
    const role: SearchDateRole = parsed.date_role ?? 'uploaded';
    const from = parseIsoDay(parsed.date_from);
    const to = parseIsoDay(parsed.date_to);
    const raw = `${parsed.date_from ?? ''}..${parsed.date_to ?? ''}`;
    if ((parsed.date_from && !from) || (parsed.date_to && !to)) {
      dropped.push({ kind: 'date', label: `${ROLE_LABELS[role]} ${raw}`, raw, reason: 'the dates could not be read.' });
    } else {
      constraints.push(makeDateRangeConstraint(nextId(), role, from, to, raw, 'ai_parse'));
    }
  }

  if (parsed.expiration_filter) {
    const ef = parsed.expiration_filter;
    const d1 = parseIsoDay(ef.date1);
    const d2 = parseIsoDay(ef.date2 ?? null);
    const raw = `${ef.operator} ${ef.date1}${ef.date2 ? ` ${ef.date2}` : ''}`;
    if (!d1 || (ef.operator === 'between' && !d2)) {
      dropped.push({ kind: 'date', label: `expiring ${raw}`, raw, reason: 'the dates could not be read.' });
    } else if (ef.operator === 'before') {
      // "Expiring before X" has always meant not yet expired, and due by X.
      constraints.push(makeDateRangeConstraint(nextId(), 'expiration', ctx.today, d1, raw, 'ai_parse'));
    } else if (ef.operator === 'after') {
      constraints.push(makeDateRangeConstraint(nextId(), 'expiration', d1, null, raw, 'ai_parse'));
    } else if (ef.operator === 'between') {
      constraints.push(makeDateRangeConstraint(nextId(), 'expiration', d1, d2, raw, 'ai_parse'));
    } else {
      dropped.push({ kind: 'date', label: `expiring ${raw}`, raw, reason: `"${ef.operator}" is not a comparison this search supports.` });
    }
  }

  // The question's own words: a role-dated phrase overrides the model.
  const typed = parseQueryText(rawQuery).dates.filter((d) => d.role !== 'any');
  for (const t of typed) {
    const tc = makeDateConstraint('pending', t.role, t.date, 'query_text');
    const sameRole = constraints.find((c) => c.kind === 'date' && c.role === t.role);
    const agrees = !!sameRole && (
      (tc.month_day !== null && tc.month_day !== undefined && !!sameRole.date_from && sameRole.date_from === sameRole.date_to
        && parseInt(sameRole.date_from.slice(5, 7), 10) === tc.month_day.month
        && parseInt(sameRole.date_from.slice(8, 10), 10) === tc.month_day.day)
      || (!!tc.date_from && sameRole.date_from === tc.date_from && sameRole.date_to === tc.date_to)
    );
    if (agrees) {
      // The model resolved a year the person did not type; the typed reading
      // (any year) is what was asked, so keep the model's only if it agrees
      // exactly on a full date.
      if (tc.month_day) {
        const idx = constraints.indexOf(sameRole!);
        constraints[idx] = { ...tc, id: sameRole!.id };
      }
      continue;
    }
    const conflicting = constraints.findIndex((c) => c.kind === 'date' && (
      c.role === t.role
      || (!!tc.date_from && c.date_from === tc.date_from && c.date_to === tc.date_to)
    ));
    const typedPhrase = rawQuery.slice(t.roleSpan ? Math.min(t.roleSpan[0], t.start) : t.start, t.end).trim();
    if (conflicting >= 0) {
      const replaced = constraints[conflicting];
      const note = `The AI read this as "${replaced.label}"; the question says "${typedPhrase}", so that is what is checked.`;
      constraints[conflicting] = { ...tc, id: replaced.id, note: [tc.note, note].filter(Boolean).join(' ') };
    } else {
      constraints.push({ ...tc, id: nextId() });
    }
  }

  return { constraints, dropped };
}
