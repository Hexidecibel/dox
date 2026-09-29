/**
 * Scope clauses (supplier, type, product, status, uploaded) as SQL over
 * `documents d` — and the SAME rules as a JS predicate over a loaded subject.
 *
 * Two forms because two paths need them: the scope/text path filters in SQL
 * (one batch: the page plus every facet), while the coverage path loads its
 * candidates unfiltered and applies scope in memory, so each facet's counts
 * can leave out that facet's own selection (sticky exclusion) without a second
 * judging pass. `tests/api/search-query-compose.test.ts` pins that the two
 * agree on every clause.
 *
 * Rules:
 *   - clauses AND together; values inside one clause OR together;
 *   - an `exclude` clause keeps every document EXCEPT its values (a document
 *     with no supplier is not "from supplier X", so it stays);
 *   - with no status clause, only active documents are searched (as before);
 *     'deleted' is never searchable;
 *   - product = linked through document_products OR through a linked lot row's
 *     product (a split COA is linked only that way);
 *   - uploaded dates compare at DAY granularity on `created_at`, which holds
 *     both `YYYY-MM-DD HH:MM:SS` and ISO `…T…Z` spellings — a day-start string
 *     bound sorts correctly against both.
 */

import type { Clause } from '../../../shared/searchQuery';
import type { FieldKey } from '../../../shared/searchFields';
import { SEARCH_FIELDS, STATUS_VALUES } from '../../../shared/searchFields';

export interface ScopeAttrs {
  supplier_id: string | null;
  document_type_id: string | null;
  product_ids: string[];
  status: string | null;
  created_at: string | null;
}

export interface CompiledScope {
  clauses: Clause[];
  /** The day uploaded-date windows count back from (UTC). */
  today: string;
}

export function dayOffset(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export function compileScope(allClauses: Clause[], now: Date = new Date()): CompiledScope {
  return {
    clauses: allClauses.filter((c) => SEARCH_FIELDS[c.field].class === 'scope'),
    today: now.toISOString().slice(0, 10),
  };
}

/** [lower-inclusive, upper-exclusive] day bounds for an uploaded clause. */
export function uploadedBounds(c: Clause, today: string): { from: string | null; to: string | null } {
  const [a, b] = c.values;
  switch (c.op) {
    case 'within': return { from: dayOffset(today, -Number(a)), to: null };
    case 'older_than': return { from: null, to: dayOffset(today, -Number(a)) };
    case 'on': return { from: a, to: dayOffset(a, 1) };
    case 'between': return { from: a, to: dayOffset(b ?? a, 1) };
    case 'before': return { from: null, to: a };
    case 'after': return { from: dayOffset(a, 1), to: null };
    default: return { from: null, to: null };
  }
}

function placeholders(n: number): string {
  return Array(n).fill('?').join(',');
}

function clauseSql(c: Clause, today: string): { sql: string; params: unknown[] } {
  const vals = c.values;
  const inList = (col: string) => (c.exclude
    ? { sql: `(${col} IS NULL OR ${col} NOT IN (${placeholders(vals.length)}))`, params: vals }
    : { sql: `${col} IN (${placeholders(vals.length)})`, params: vals });
  switch (c.field) {
    case 'supplier': return inList('d.supplier_id');
    case 'document_type': return inList('d.document_type_id');
    case 'status': return inList('d.status');
    case 'product': {
      const p = placeholders(vals.length);
      const has = `(EXISTS (SELECT 1 FROM document_products dp WHERE dp.document_id = d.id AND dp.product_id IN (${p}))
         OR EXISTS (SELECT 1 FROM document_lots dl JOIN lots l ON l.id = dl.lot_id WHERE dl.document_id = d.id AND l.product_id IN (${p})))`;
      return { sql: c.exclude ? `NOT ${has}` : has, params: [...vals, ...vals] };
    }
    case 'uploaded': {
      const { from, to } = uploadedBounds(c, today);
      const parts: string[] = [];
      const params: unknown[] = [];
      if (from) { parts.push('d.created_at >= ?'); params.push(from); }
      if (to) { parts.push('d.created_at < ?'); params.push(to); }
      return { sql: parts.length ? parts.join(' AND ') : '1 = 1', params };
    }
    default:
      return { sql: '1 = 1', params: [] };
  }
}

/**
 * The WHERE conjunction over `documents d` for a tenant. `except` leaves out a
 * field's INCLUDE clauses (its facet selection); its exclude clauses stay.
 */
export function scopeWhere(scope: CompiledScope, tenantId: string, except?: FieldKey): { sql: string; params: unknown[] } {
  const parts: string[] = ['d.tenant_id = ?'];
  const params: unknown[] = [tenantId];
  const hasStatus = scope.clauses.some((c) => c.field === 'status' && !c.exclude);
  if (!hasStatus || except === 'status') {
    // Default: active only. The status facet itself counts every searchable status.
    if (except === 'status') {
      parts.push(`d.status IN (${placeholders(STATUS_VALUES.length)})`);
      params.push(...STATUS_VALUES);
    } else {
      parts.push("d.status = 'active'");
    }
  }
  for (const c of scope.clauses) {
    if (except && c.field === except && !c.exclude) continue;
    const s = clauseSql(c, scope.today);
    parts.push(s.sql);
    params.push(...s.params);
  }
  if (hasStatus) {
    // Never 'deleted', whatever a status clause says.
    parts.push("d.status != 'deleted'");
  }
  return { sql: parts.join(' AND '), params };
}

function clauseHolds(c: Clause, a: ScopeAttrs, today: string): boolean {
  const vals = new Set(c.values);
  const inList = (v: string | null) => (c.exclude ? v === null || !vals.has(v) : v !== null && vals.has(v));
  switch (c.field) {
    case 'supplier': return inList(a.supplier_id);
    case 'document_type': return inList(a.document_type_id);
    case 'status': return inList(a.status);
    case 'product': {
      const any = a.product_ids.some((p) => vals.has(p));
      return c.exclude ? !any : any;
    }
    case 'uploaded': {
      if (!a.created_at) return false;
      const { from, to } = uploadedBounds(c, today);
      if (from && a.created_at < from) return false;
      if (to && a.created_at >= to) return false;
      return true;
    }
    default:
      return true;
  }
}

/** The JS mirror of `scopeWhere` (tenant already applied by the caller). */
export function scopeHolds(scope: CompiledScope, a: ScopeAttrs, except?: FieldKey): boolean {
  const hasStatus = scope.clauses.some((c) => c.field === 'status' && !c.exclude);
  if (a.status === 'deleted') return false;
  if (except === 'status') {
    if (!(STATUS_VALUES as readonly string[]).includes(a.status ?? '')) return false;
  } else if (!hasStatus && a.status !== 'active') {
    return false;
  }
  for (const c of scope.clauses) {
    if (except && c.field === except && !c.exclude) continue;
    if (!clauseHolds(c, a, scope.today)) return false;
  }
  return true;
}
