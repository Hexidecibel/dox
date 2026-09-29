/**
 * A deterministic sample of a tenant's approved documents WITH what search can
 * find them by — their lot rows (and each row's production-date provenance),
 * the identifiers they print, the products they are linked to and the plain
 * names those products go by — plus VERIFIED negatives: a day next to a real
 * one on which the tenant holds no lot, a lot spelling nobody holds, and a real
 * lot paired with a supplier that holds no lot of that key.
 *
 * Read by GET /api/search/eval-sample (bin/eval-search) and by the examples
 * builder. Tenant-scoped in every statement; the shape is an allow-list
 * (`EvalSample` in shared/searchProbes.ts) — no metadata blob, no text, no user.
 */

import { normalizeLotNumber } from '../../../shared/lotNormalize';
import type { LotSchemeSpec } from '../../../shared/lotScheme';
import { lotPrefixNote } from '../../../shared/searchInterpret';
import { seededShuffle, shiftDay, type EvalSample, type SampleDoc, type SampleKey, type SampleLot } from '../../../shared/searchProbes';
import type { SearchKeyKind } from '../../../shared/types';
import { structuredScheme } from '../search-coverage';

/** Candidate documents one sample draws from (most recent first by id order is irrelevant: it is shuffled). */
const POOL_CAP = 5000;
const CHUNK = 80;
export const SAMPLE_MAX = 200;

const KEY_KINDS: SearchKeyKind[] = ['supplier_po', 'invoice_number', 'document_number', 'certificate_number'];

function ph(n: number): string {
  return Array(n).fill('?').join(',');
}

function chunks<T>(xs: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

async function inChunks<R>(db: D1Database, ids: string[], build: (chunk: string[]) => D1PreparedStatement): Promise<R[]> {
  if (!ids.length) return [];
  const res = await db.batch(chunks(ids).map(build));
  return res.flatMap((r) => (r.results ?? []) as R[]);
}

export interface SampleOptions {
  n: number;
  seed: string;
}

export async function loadEvalSample(db: D1Database, tenantId: string, opts: SampleOptions): Promise<EvalSample> {
  const n = Math.min(Math.max(Math.floor(opts.n) || 0, 1), SAMPLE_MAX);
  const pool = await db.prepare(
    `SELECT d.id FROM documents d
      WHERE d.tenant_id = ? AND d.status = 'active'
        AND (EXISTS (SELECT 1 FROM document_lots dl WHERE dl.document_id = d.id)
             OR EXISTS (SELECT 1 FROM document_search_keys k WHERE k.document_id = d.id AND k.tenant_id = d.tenant_id))
      ORDER BY d.id LIMIT ${POOL_CAP}`,
  ).bind(tenantId).all<{ id: string }>();
  const ids = seededShuffle((pool.results ?? []).map((r) => r.id), `${tenantId}|${opts.seed}`).slice(0, n);
  const empty: EvalSample = { tenant_id: tenantId, seed: opts.seed, n, docs: [], negatives: { days: [], lots: [], wrong_supplier: [] }, lot_prefixes: [] };
  if (!ids.length) return empty;

  // --- the documents and what hangs off them (one batch per kind of row) ---------
  const docRows = await inChunks<{ id: string; title: string; supplier_id: string | null; supplier_name: string | null; type_name: string | null; type_slug: string | null; printed_product: string | null }>(
    db, ids, (c) => db.prepare(
      `SELECT d.id, d.title, d.supplier_id, s.name AS supplier_name, dt.name AS type_name, dt.slug AS type_slug,
              json_extract(CASE WHEN json_valid(d.primary_metadata) THEN d.primary_metadata ELSE '{}' END, '$.product_name') AS printed_product
         FROM documents d
         LEFT JOIN suppliers s ON s.id = d.supplier_id
         LEFT JOIN document_types dt ON dt.id = d.document_type_id
        WHERE d.tenant_id = ? AND d.id IN (${ph(c.length)})`,
    ).bind(tenantId, ...c),
  );
  const lotRows = await inChunks<SampleLot & { document_id: string }>(db, ids, (c) => db.prepare(
    `SELECT dl.document_id, l.lot_number, COALESCE(l.sub_lot_code, '') AS sub_lot_code, l.lot_key, l.production_date, l.production_date_source
       FROM document_lots dl JOIN lots l ON l.id = dl.lot_id
      WHERE l.tenant_id = ? AND dl.document_id IN (${ph(c.length)})
      ORDER BY dl.document_id, l.lot_key`,
  ).bind(tenantId, ...c));
  const keyRows = await inChunks<SampleKey & { document_id: string }>(db, ids, (c) => db.prepare(
    `SELECT document_id, kind, value_raw FROM document_search_keys
      WHERE tenant_id = ? AND kind IN (${ph(KEY_KINDS.length)}) AND document_id IN (${ph(c.length)})
      ORDER BY document_id, kind, value_raw`,
  ).bind(tenantId, ...KEY_KINDS, ...c));
  const productRows = await inChunks<{ document_id: string; id: string; name: string }>(db, ids, (c) => db.prepare(
    `SELECT DISTINCT x.document_id, p.id, p.name FROM (
        SELECT document_id, product_id FROM document_products WHERE document_id IN (${ph(c.length)})
        UNION
        SELECT dl.document_id, l.product_id FROM document_lots dl JOIN lots l ON l.id = dl.lot_id
         WHERE dl.document_id IN (${ph(c.length)}) AND l.product_id IS NOT NULL
      ) x JOIN products p ON p.id = x.product_id AND p.tenant_id = ?`,
  ).bind(...c, ...c, tenantId));
  const productIds = [...new Set(productRows.map((r) => r.id))];
  const identRows = await inChunks<{ product_id: string; value: string }>(db, productIds, (c) => db.prepare(
    `SELECT product_id, value FROM product_identifiers
      WHERE tenant_id = ? AND kind IN ('alias', 'supplier_name') AND confirmed = 1 AND product_id IN (${ph(c.length)})
      ORDER BY product_id, value`,
  ).bind(tenantId, ...c));

  const byDoc = <T extends { document_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.document_id, [...(m.get(r.document_id) ?? []), r]);
    return m;
  };
  const lotsBy = byDoc(lotRows);
  const keysBy = byDoc(keyRows);
  const prodBy = byDoc(productRows);
  const names = new Map<string, string[]>();
  for (const r of identRows) names.set(r.product_id, [...(names.get(r.product_id) ?? []), r.value]);

  const order = new Map(ids.map((id, i) => [id, i]));
  const docs: SampleDoc[] = docRows
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((d) => ({
      id: d.id,
      title: d.title,
      supplier_id: d.supplier_id,
      supplier_name: d.supplier_name,
      document_type_name: d.type_name,
      document_type_slug: d.type_slug,
      printed_product: typeof d.printed_product === 'string' ? d.printed_product : null,
      lots: (lotsBy.get(d.id) ?? []).map(({ document_id: _d, ...l }) => l),
      keys: (keysBy.get(d.id) ?? []).map(({ kind, value_raw }) => ({ kind, value_raw })),
      products: (prodBy.get(d.id) ?? []).map((p) => ({ id: p.id, name: p.name, names: names.get(p.id) ?? [] })),
    }));

  return { ...empty, docs, ...(await negativesAndPrefixes(db, tenantId, docs, opts.seed)) };
}

async function negativesAndPrefixes(
  db: D1Database,
  tenantId: string,
  docs: SampleDoc[],
  seed: string,
): Promise<Pick<EvalSample, 'negatives' | 'lot_prefixes'>> {
  const withLot = docs.filter((d) => d.lots.length > 0);
  // Candidate absent lots: a sublot / suffix nobody printed.
  const absentCandidates = withLot.map((d) => {
    const l = d.lots[0];
    const tries = l.sub_lot_code
      ? ['98', '97', '96'].map((s) => ({ text: `${l.lot_number}-${s}`, norm: normalizeLotNumber(`${l.lot_number}${s}`) }))
      : ['9', '99', '999'].map((s) => ({ text: `${l.lot_number}${s}`, norm: normalizeLotNumber(`${l.lot_number}${s}`) }));
    return { doc: d, tries };
  });
  const lotNorms = [...new Set([...absentCandidates.flatMap((a) => a.tries.map((t) => t.norm)), ...withLot.map((d) => d.lots[0].lot_key)])].filter(Boolean);

  const [held, keyHeld, prodDays, keyDays, suppliers, schemes] = await db.batch([
    db.prepare(`SELECT lot_key, supplier_id FROM lots WHERE tenant_id = ? AND lot_key IN (${ph(lotNorms.length || 1)})`).bind(tenantId, ...(lotNorms.length ? lotNorms : [''])),
    db.prepare(
      `SELECT k.value_norm AS lot_key, d.supplier_id FROM document_search_keys k JOIN documents d ON d.id = k.document_id
        WHERE k.tenant_id = ? AND k.kind = 'lot' AND k.value_norm IN (${ph(lotNorms.length || 1)})`,
    ).bind(tenantId, ...(lotNorms.length ? lotNorms : [''])),
    db.prepare(`SELECT DISTINCT production_date AS day FROM lots WHERE tenant_id = ? AND production_date IS NOT NULL`).bind(tenantId),
    db.prepare(`SELECT DISTINCT value_date AS day FROM document_search_keys WHERE tenant_id = ? AND kind = 'production_date' AND value_date IS NOT NULL`).bind(tenantId),
    db.prepare(`SELECT id, name FROM suppliers WHERE tenant_id = ? AND active = 1 ORDER BY id LIMIT 500`).bind(tenantId),
    db.prepare(
      `SELECT sls.supplier_id, s.name AS supplier_name, sls.spec, sls.version FROM supplier_lot_schemes sls
         JOIN suppliers s ON s.id = sls.supplier_id WHERE sls.tenant_id = ? ORDER BY sls.version DESC`,
    ).bind(tenantId),
  ]);

  const holders = new Map<string, Set<string>>();
  for (const r of [...(held.results ?? []), ...(keyHeld.results ?? [])] as Array<{ lot_key: string; supplier_id: string | null }>) {
    const s = holders.get(r.lot_key) ?? new Set<string>();
    s.add(r.supplier_id ?? '');
    holders.set(r.lot_key, s);
  }
  const occupied = new Set([...(prodDays.results ?? []), ...(keyDays.results ?? [])].map((r) => String((r as { day: string }).day)));

  const days: EvalSample['negatives']['days'] = [];
  for (const d of docs) {
    const dated = d.lots.find((l) => l.production_date && /^\d{4}-\d{2}-\d{2}$/.test(l.production_date));
    if (!dated?.production_date) continue;
    const day = [-1, 1, -2, 2].map((k) => shiftDay(dated.production_date as string, k)).find((x) => !occupied.has(x));
    if (day) days.push({ doc_id: d.id, day });
  }

  const lots: EvalSample['negatives']['lots'] = [];
  for (const a of absentCandidates) {
    const t = a.tries.find((x) => x.norm && !holders.has(x.norm));
    if (t) lots.push({ doc_id: a.doc.id, lot: t.text });
  }

  const supplierList = (suppliers.results ?? []) as Array<{ id: string; name: string }>;
  const wrong: EvalSample['negatives']['wrong_supplier'] = [];
  for (const d of withLot) {
    const l = d.lots[0];
    const holding = holders.get(l.lot_key) ?? new Set<string>();
    const other = seededShuffle(supplierList, `${seed}|${d.id}`).find((s) => s.id !== d.supplier_id && !holding.has(s.id));
    if (other) wrong.push({ doc_id: d.id, lot: l.sub_lot_code ? `${l.lot_number}-${l.sub_lot_code}` : l.lot_number, supplier_id: other.id, supplier_name: other.name });
  }

  // Lot prefixes a declared format explains (the leading fixed-width segment).
  const specs = new Map<string, { supplier_name: string; spec: LotSchemeSpec }>();
  for (const r of (schemes.results ?? []) as Array<{ supplier_id: string; supplier_name: string; spec: string | null }>) {
    if (specs.has(r.supplier_id)) continue;
    const spec = structuredScheme(r.spec);
    if (spec) specs.set(r.supplier_id, { supplier_name: r.supplier_name, spec });
  }
  const prefixes: EvalSample['lot_prefixes'] = [];
  const seenPrefix = new Set<string>();
  for (const d of withLot) {
    const s = d.supplier_id ? specs.get(d.supplier_id) : undefined;
    if (!s || s.spec.kind !== 'structured') continue;
    const g = s.spec.segments?.[0];
    if (!g || g.kind !== 'digits' || !g.width) continue;
    const prefix = d.lots[0].lot_number.replace(/\D/g, '').slice(0, g.width);
    if (prefix.length !== g.width || seenPrefix.has(prefix)) continue;
    if (!lotPrefixNote(prefix, [s])) continue;
    seenPrefix.add(prefix);
    prefixes.push({ doc_id: d.id, prefix, supplier_name: s.supplier_name });
  }

  return { negatives: { days, lots, wrong_supplier: wrong }, lot_prefixes: prefixes };
}
