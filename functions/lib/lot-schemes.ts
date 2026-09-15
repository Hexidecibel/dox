/**
 * A supplier's declared lot format, read and written (migration 0109).
 *
 * The rules live in shared/lotScheme.ts (pure). This module is the D1 side:
 * which declaration is in force for a supplier, the append-only write, and the
 * read-only "how many lots on file fit" preview the admin page shows.
 *
 * Resolution: the highest `supplier_lot_schemes.version` for the supplier; with
 * none, the 0075 `suppliers.lot_scheme` enum mapped onto an equivalent spec, so
 * an undeclared supplier keys byte-identically to before. Every read is scoped
 * by tenant as well as supplier id.
 */

import type { D1Database } from '@cloudflare/workers-types';
import { generateId } from './db';
import {
  legacyResolvedScheme,
  validateLotSchemeSpec,
  type LotFitRow,
  type LotSchemeSpec,
  type ResolvedLotScheme,
} from '../../shared/lotScheme';

export { previewLotFit, type LotFitPreview, type LotFitRow } from '../../shared/lotScheme';

export interface LotSchemeVersionRow {
  id: string;
  supplier_id: string;
  version: number;
  spec: LotSchemeSpec;
  source: 'admin' | 'seed';
  note: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
}

interface RawVersionRow {
  id: string;
  supplier_id: string;
  version: number;
  spec: string;
  source: 'admin' | 'seed';
  note: string | null;
  created_by: string | null;
  created_by_name?: string | null;
  created_at: string;
}

function parseRow(r: RawVersionRow): LotSchemeVersionRow | null {
  let spec: unknown;
  try {
    spec = JSON.parse(r.spec);
  } catch {
    return null;
  }
  // A stored row that no longer validates is not silently run: it resolves to
  // nothing and the supplier falls back to the legacy behaviour.
  const v = validateLotSchemeSpec(spec);
  if (!v.ok) return null;
  return {
    id: r.id,
    supplier_id: r.supplier_id,
    version: Number(r.version),
    spec: v.spec,
    source: r.source,
    note: r.note ?? null,
    created_by: r.created_by ?? null,
    created_by_name: r.created_by_name ?? null,
    created_at: r.created_at,
  };
}

/**
 * The lot format in force for one supplier. Never throws: a missing supplier,
 * a database that predates 0109, or an unreadable row all resolve to the legacy
 * 'auto' behaviour, because a lookup hiccup must never block an approval.
 */
export async function loadResolvedLotScheme(
  db: D1Database,
  tenantId: string,
  supplierId: string | null | undefined,
): Promise<ResolvedLotScheme> {
  if (!supplierId) return legacyResolvedScheme('auto');
  let supplier: { name: string; lot_scheme: string | null } | null = null;
  try {
    supplier = await db
      .prepare('SELECT name, lot_scheme FROM suppliers WHERE id = ? AND tenant_id = ?')
      .bind(supplierId, tenantId)
      .first<{ name: string; lot_scheme: string | null }>();
  } catch {
    return legacyResolvedScheme('auto');
  }
  if (!supplier) return legacyResolvedScheme('auto');
  try {
    const row = await db
      .prepare(
        `SELECT id, supplier_id, version, spec, source, note, created_by, created_at
           FROM supplier_lot_schemes
          WHERE tenant_id = ? AND supplier_id = ?
          ORDER BY version DESC LIMIT 1`,
      )
      .bind(tenantId, supplierId)
      .first<RawVersionRow>();
    const parsed = row ? parseRow(row) : null;
    if (parsed) {
      return {
        source: 'declared',
        spec: parsed.spec,
        scheme_id: parsed.id,
        version: parsed.version,
        supplier_name: supplier.name,
        legacy: legacyResolvedScheme(supplier.lot_scheme).legacy,
      };
    }
  } catch {
    // Pre-0109 database: no declarations table.
  }
  return legacyResolvedScheme(supplier.lot_scheme, supplier.name);
}

/** Every declaration for a supplier, newest first. */
export async function listLotSchemeVersions(
  db: D1Database,
  tenantId: string,
  supplierId: string,
): Promise<LotSchemeVersionRow[]> {
  const res = await db
    .prepare(
      `SELECT sls.id, sls.supplier_id, sls.version, sls.spec, sls.source, sls.note, sls.created_by,
              u.name AS created_by_name, sls.created_at
         FROM supplier_lot_schemes sls
         LEFT JOIN users u ON u.id = sls.created_by
        WHERE sls.tenant_id = ? AND sls.supplier_id = ?
        ORDER BY sls.version DESC`,
    )
    .bind(tenantId, supplierId)
    .all<RawVersionRow>();
  return (res.results ?? []).map(parseRow).filter((r): r is LotSchemeVersionRow => r !== null);
}

export class LotSchemeValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join(' '));
  }
}

/**
 * Append a declaration. Validates first; a spec identical to the one in force
 * writes nothing (`unchanged: true`), so saving twice does not mint versions.
 */
export async function declareLotScheme(
  db: D1Database,
  args: {
    tenantId: string;
    supplierId: string;
    spec: unknown;
    source: 'admin' | 'seed';
    note?: string | null;
    userId?: string | null;
  },
): Promise<{ row: LotSchemeVersionRow; previous: LotSchemeVersionRow | null; unchanged: boolean }> {
  const v = validateLotSchemeSpec(args.spec);
  if (!v.ok) throw new LotSchemeValidationError(v.errors);
  const versions = await listLotSchemeVersions(db, args.tenantId, args.supplierId);
  const previous = versions[0] ?? null;
  if (previous && JSON.stringify(previous.spec) === JSON.stringify(v.spec)) {
    return { row: previous, previous, unchanged: true };
  }
  const maxRow = await db
    .prepare('SELECT MAX(version) AS v FROM supplier_lot_schemes WHERE supplier_id = ?')
    .bind(args.supplierId)
    .first<{ v: number | null }>();
  const version = Number(maxRow?.v ?? 0) + 1;
  const id = generateId();
  const note = args.note == null ? null : String(args.note).trim().slice(0, 1000) || null;
  await db
    .prepare(
      `INSERT INTO supplier_lot_schemes (id, tenant_id, supplier_id, version, spec, source, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, args.tenantId, args.supplierId, version, JSON.stringify(v.spec), args.source, note, args.userId ?? null)
    .run();
  const row: LotSchemeVersionRow = {
    id,
    supplier_id: args.supplierId,
    version,
    spec: v.spec,
    source: args.source,
    note,
    created_by: args.userId ?? null,
    created_by_name: null,
    created_at: new Date().toISOString(),
  };
  return { row, previous, unchanged: false };
}

/** The lots on file for a supplier — the preview's input. Read-only. */
export async function loadSupplierLotsForFit(db: D1Database, tenantId: string, supplierId: string, limit = 5000): Promise<LotFitRow[]> {
  const res = await db
    .prepare(
      `SELECT id AS lot_id, lot_number, sub_lot_code, lot_key, production_date, production_date_source
         FROM lots WHERE tenant_id = ? AND supplier_id = ?
        ORDER BY lot_key LIMIT ?`,
    )
    .bind(tenantId, supplierId, limit)
    .all<LotFitRow>();
  return res.results ?? [];
}

/**
 * The declared lot format that applies to an ORDER / SHIPMENT line, reached
 * through the line's product: `products.supplier_id`, else the one supplier in
 * `product_suppliers`. Returns null unless exactly one supplier is found AND it
 * has a declared structured format — the order side has no supplier of its own,
 * and a guessed supplier's format silently mis-keying a lot is worse than the
 * historical concat, which is what null means to the caller.
 */
export function orderSideSchemeResolver(db: D1Database, tenantId: string) {
  const cache = new Map<string, ResolvedLotScheme | null>();
  return async (productId: string | null | undefined): Promise<ResolvedLotScheme | null> => {
    if (!productId) return null;
    if (cache.has(productId)) return cache.get(productId) ?? null;
    let resolved: ResolvedLotScheme | null = null;
    try {
      const direct = await db
        .prepare('SELECT supplier_id FROM products WHERE id = ? AND tenant_id = ?')
        .bind(productId, tenantId)
        .first<{ supplier_id: string | null }>();
      let supplierId = direct?.supplier_id ?? null;
      if (!supplierId) {
        const links = await db
          .prepare('SELECT DISTINCT supplier_id FROM product_suppliers WHERE product_id = ? AND tenant_id = ? LIMIT 2')
          .bind(productId, tenantId)
          .all<{ supplier_id: string }>();
        const ids = (links.results ?? []).map((r) => r.supplier_id);
        supplierId = ids.length === 1 ? ids[0] : null;
      }
      if (supplierId) {
        const scheme = await loadResolvedLotScheme(db, tenantId, supplierId);
        resolved = scheme.source === 'declared' && scheme.spec.kind === 'structured' ? scheme : null;
      }
    } catch {
      resolved = null;
    }
    cache.set(productId, resolved);
    return resolved;
  };
}
