/**
 * How typed text reads, asked of the tenant's own data in ONE batch — without
 * running the search (search redesign Phase 2, `POST /api/search/interpret`).
 *
 * The omnibox commits what it read on Enter, and the command palette previews
 * the reading as you type. Both need the answer `runSearch` gives in
 * `interpreted`, but neither needs the corpus judged, so this asks only the
 * detection questions: which of the typed numbers are on file as document keys,
 * which lot keys bear on the lot-shaped tokens, which WMS orders carry the
 * numbers as an order number or a customer PO, and — when a lot was typed after
 * the word "lot" — what the declared lot formats say a prefix is.
 *
 * The reading is the SAME pure `resolveDetections` the search path runs, so a
 * chip previewed here is the chip the search will judge.
 */

import { describeClause } from '../../../shared/searchQuery';
import {
  resolveDetections,
  scanHasCandidates,
  scanNorms,
  scanOrderValues,
  scanText,
  type DetectionHits,
} from '../../../shared/searchInterpret';
import { customerPoSpellings, foldCustomerPo, IDENTIFIER_KEY_KINDS } from '../../../shared/searchKeys';
import { normalizeLotNumber } from '../../../shared/lotNormalize';
import type { LotSchemeSpec } from '../../../shared/lotScheme';
import type { SearchInterpretResponse, SearchKeyKind } from '../../../shared/types';
import { structuredScheme } from '../search-coverage';

/** The longest text read; a paste of a whole email is not a search. */
export const INTERPRET_MAX_CHARS = 500;

function ph(n: number): string {
  return Array(n).fill('?').join(',');
}

export async function interpretQueryText(db: D1Database, tenantId: string, rawText: string): Promise<SearchInterpretResponse> {
  const text = rawText.replace(/\s+/g, ' ').trim().slice(0, INTERPRET_MAX_CHARS);
  if (!text) return { clauses: [], residual: '', labels: {} };
  const scan = scanText(text);
  if (!scanHasCandidates(scan)) return { clauses: [], residual: text, labels: {} };

  const stmts: D1PreparedStatement[] = [];
  const idx: Partial<Record<'keys' | 'lots' | 'schemes' | 'orders', number>> = {};
  const add = (k: keyof typeof idx, st: D1PreparedStatement) => {
    idx[k] = stmts.push(st) - 1;
  };

  const norms = scanNorms(scan);
  if (norms.length) {
    const kinds = [...IDENTIFIER_KEY_KINDS, 'lot'];
    add('keys', db.prepare(
      `SELECT DISTINCT kind, value_norm FROM document_search_keys
        WHERE tenant_id = ? AND kind IN (${ph(kinds.length)}) AND value_norm IN (${ph(norms.length)})`,
    ).bind(tenantId, ...kinds, ...norms));
  }
  if (scan.lotTokens.length) {
    const conds: string[] = [];
    const binds: string[] = [];
    for (const t of scan.lotTokens) {
      const n = normalizeLotNumber(t.norm);
      conds.push('(lot_key >= ? AND lot_key < ?)');
      binds.push(n, `${n}~`);
      for (const cut of [1, 2, 3]) {
        if (n.length - cut >= 6) {
          conds.push('lot_key = ?');
          binds.push(n.slice(0, -cut));
        }
      }
    }
    add('lots', db.prepare(`SELECT DISTINCT lot_key, lot_number FROM lots WHERE tenant_id = ? AND (${conds.join(' OR ')}) LIMIT 200`).bind(tenantId, ...binds));
  }
  if (scan.lotTokens.some((t) => t.explicit)) {
    add('schemes', db.prepare(
      `SELECT sls.supplier_id, s.name AS supplier_name, sls.spec, sls.version
         FROM supplier_lot_schemes sls JOIN suppliers s ON s.id = sls.supplier_id
        WHERE sls.tenant_id = ? ORDER BY sls.version DESC`,
    ).bind(tenantId));
  }
  const ov = scanOrderValues(scan).slice(0, 30);
  if (ov.length) {
    const pov = [...new Set(ov.map(foldCustomerPo).filter(Boolean))].slice(0, 3).flatMap(customerPoSpellings).slice(0, 60);
    add('orders', db.prepare(
      `SELECT o.order_number, o.po_number FROM orders o
        WHERE o.tenant_id = ? AND o.staged_at IS NULL
          AND (o.order_number IN (${ph(ov.length)})${pov.length ? ` OR o.po_number IN (${ph(pov.length)})` : ''})
        LIMIT 20`,
    ).bind(tenantId, ...ov, ...pov));
  }

  const results = stmts.length ? await db.batch(stmts) : [];
  const rows = <T>(k: keyof typeof idx): T[] => (idx[k] === undefined ? [] : ((results[idx[k]!]?.results ?? []) as T[]));

  const lotRows = rows<{ lot_key: string; lot_number: string }>('lots');
  const lotSchemes: Array<{ supplier_name: string; spec: LotSchemeSpec }> = [];
  const seen = new Set<string>();
  for (const r of rows<{ supplier_id: string; supplier_name: string; spec: string | null }>('schemes')) {
    if (seen.has(r.supplier_id)) continue;
    seen.add(r.supplier_id);
    const spec = structuredScheme(r.spec);
    if (spec) lotSchemes.push({ supplier_name: r.supplier_name, spec });
  }
  const hits: DetectionHits = {
    keys: new Map(),
    lotKeys: lotRows.map((r) => r.lot_key),
    lotNumbers: lotRows.map((r) => normalizeLotNumber(r.lot_number)),
    lotSchemes,
    orders: rows<{ order_number: string; po_number: string | null }>('orders'),
  };
  for (const r of rows<{ kind: string; value_norm: string }>('keys')) {
    const set = hits.keys.get(r.value_norm) ?? new Set<SearchKeyKind>();
    set.add(r.kind as SearchKeyKind);
    hits.keys.set(r.value_norm, set);
  }
  const det = resolveDetections(scan, hits);
  const labels: Record<string, string> = {};
  for (const c of det.clauses) labels[c.id] = describeClause(c);
  return { clauses: det.clauses, residual: det.residual, labels };
}
