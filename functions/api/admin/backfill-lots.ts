/**
 * POST /api/admin/backfill-lots
 *
 * One-time, idempotent admin backfill that walks existing `documents` rows
 * and lifts their lot information out of `primary_metadata` (JSON) into the
 * entity-graph (lots / document_lots), then runs the order↔COA matcher.
 *
 * Why: lot extraction shipped after most COAs were already processed, so the
 * graph only has a handful of lots while ~285 documents still carry a usable
 * `lot_number` (often with `code_date` / `expiration_date`) in their
 * primary_metadata blob. Until those are promoted into the graph, the
 * order↔COA matcher finds nothing for them. Backfilling lights up the real
 * linkage immediately (a COA with lot "6141" binds to the order line shipped
 * as lot 6141).
 *
 * Auth: super_admin only — system-wide maintenance op.
 *
 * Scope / batching:
 *   - `?tenant_id=` optional filter; absent = all tenants.
 *   - `?limit=` (default 200) + `?offset=` for batched runs that stay under
 *     D1/CPU limits. Deterministic ordering by id keeps offset paging stable.
 *
 * Idempotency: relies entirely on the existing upsert helpers —
 * `attachLotToCoaDocument` → `findOrCreateLot` collapses by (tenant, product,
 * normalized lot_key) and `document_lots` has ON CONFLICT(document_id, lot_id)
 * DO NOTHING. Re-running creates no new lots or links.
 *
 * Per-document failures are captured into `errors[]` and skipped — a single
 * bad row never aborts the batch.
 *
 * Returns JSON counts so an operator can drive successive batches:
 *   { documents_scanned, lots_created, links_created, orders_linked,
 *     skipped, errors }
 */

import { requireRole, errorToResponse } from '../../lib/permissions';
import { logAudit, getClientIp } from '../../lib/db';
import { attachLotToCoaDocument } from '../../lib/entities/matching';
import type { Env, User } from '../../lib/types';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

interface DocRow {
  id: string;
  tenant_id: string;
  supplier_id: string | null;
  primary_metadata: string | null;
}

interface BackfillResult {
  documents_scanned: number;
  lots_created: number;
  links_created: number;
  orders_linked: number;
  skipped: number;
  errors: Array<{ document_id: string; error: string }>;
}

/**
 * Pull a non-empty string value from a parsed metadata object for the first
 * matching key (case-insensitive). Returns null when absent/blank.
 */
function metaString(
  meta: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    for (const [k, v] of Object.entries(meta)) {
      if (k.toLowerCase() === key.toLowerCase() && v != null) {
        const s = String(v).trim();
        if (s !== '') return s;
      }
    }
  }
  return null;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin');

    const db = context.env.DB;
    const url = new URL(context.request.url);

    const tenantFilter = url.searchParams.get('tenant_id');
    const limitRaw = parseInt(url.searchParams.get('limit') ?? '', 10);
    const offsetRaw = parseInt(url.searchParams.get('offset') ?? '', 10);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(limitRaw, MAX_LIMIT)
        : DEFAULT_LIMIT;
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;

    // Candidate documents: anything carrying a lot_number in primary_metadata.
    // Skip soft-deleted docs. A cheap JSON guard in SQL keeps the scanned set
    // tight; we still re-validate / parse in JS. Deterministic order by id so
    // offset paging is stable across batches.
    const where: string[] = [
      "status != 'deleted'",
      'primary_metadata IS NOT NULL',
    ];
    const binds: (string | number)[] = [];
    if (tenantFilter) {
      where.push('tenant_id = ?');
      binds.push(tenantFilter);
    }

    const rows = await db
      .prepare(
        `SELECT id, tenant_id, supplier_id, primary_metadata
         FROM documents
         WHERE ${where.join(' AND ')}
         ORDER BY id ASC
         LIMIT ? OFFSET ?`
      )
      .bind(...binds, limit, offset)
      .all<DocRow>();

    const result: BackfillResult = {
      documents_scanned: 0,
      lots_created: 0,
      links_created: 0,
      orders_linked: 0,
      skipped: 0,
      errors: [],
    };

    for (const row of rows.results ?? []) {
      result.documents_scanned++;
      try {
        let meta: Record<string, unknown> | null = null;
        if (row.primary_metadata) {
          try {
            const parsed = JSON.parse(row.primary_metadata);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              meta = parsed as Record<string, unknown>;
            }
          } catch {
            // Unparseable metadata — nothing to backfill.
          }
        }
        if (!meta) {
          result.skipped++;
          continue;
        }

        const lotNumber = metaString(meta, 'lot_number', 'lot', 'lot_no');
        if (!lotNumber) {
          result.skipped++;
          continue;
        }

        const codeDate = metaString(meta, 'code_date');
        const expirationDate = metaString(
          meta,
          'expiration_date',
          'exp_date'
        );

        // Resolve the document's product (if any) via document_products. If a
        // doc is linked to multiple products we take the earliest-linked one;
        // findOrCreateLot collapses NULL-product lots, and a wrong-but-rare
        // multi-product case is a known acceptable edge for this backfill.
        const dp = await db
          .prepare(
            `SELECT product_id FROM document_products
             WHERE document_id = ?
             ORDER BY created_at ASC, product_id ASC
             LIMIT 1`
          )
          .bind(row.id)
          .first<{ product_id: string }>();
        const productId = dp?.product_id ?? null;

        // Snapshot graph state so we can attribute what this doc created.
        const beforeLots = await countLots(db, row.tenant_id);
        const beforeLinks = await countDocLinks(db, row.id);
        const beforeMatched = await countMatchedForDoc(db, row.id);

        const lotId = await attachLotToCoaDocument(db, row.tenant_id, {
          documentId: row.id,
          lotNumber,
          productId,
          supplierId: row.supplier_id ?? null,
          codeDate,
          expirationDate,
          source: 'backfill',
        });

        if (!lotId) {
          // lotNumber normalized to empty, or the helper swallowed an error.
          result.skipped++;
          continue;
        }

        const afterLots = await countLots(db, row.tenant_id);
        const afterLinks = await countDocLinks(db, row.id);
        const afterMatched = await countMatchedForDoc(db, row.id);

        result.lots_created += Math.max(0, afterLots - beforeLots);
        result.links_created += Math.max(0, afterLinks - beforeLinks);
        result.orders_linked += Math.max(0, afterMatched - beforeMatched);
      } catch (err) {
        result.errors.push({
          document_id: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    try {
      await logAudit(
        db,
        user.id,
        tenantFilter ?? null,
        'admin.backfill_lots.run',
        'system',
        null,
        JSON.stringify({
          tenant_filter: tenantFilter ?? null,
          limit,
          offset,
          documents_scanned: result.documents_scanned,
          lots_created: result.lots_created,
          links_created: result.links_created,
          orders_linked: result.orders_linked,
          skipped: result.skipped,
          errors: result.errors.length,
        }),
        getClientIp(context.request)
      );
    } catch (err) {
      console.warn(
        'backfill-lots: audit log failed:',
        err instanceof Error ? err.message : String(err)
      );
    }

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('backfill-lots error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

async function countLots(
  db: D1Database,
  tenantId: string
): Promise<number> {
  const r = await db
    .prepare('SELECT COUNT(*) AS c FROM lots WHERE tenant_id = ?')
    .bind(tenantId)
    .first<{ c: number }>();
  return Number(r?.c) || 0;
}

async function countDocLinks(
  db: D1Database,
  documentId: string
): Promise<number> {
  const r = await db
    .prepare('SELECT COUNT(*) AS c FROM document_lots WHERE document_id = ?')
    .bind(documentId)
    .first<{ c: number }>();
  return Number(r?.c) || 0;
}

async function countMatchedForDoc(
  db: D1Database,
  documentId: string
): Promise<number> {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM order_items
       WHERE coa_document_id = ? AND coa_match_status = 'matched'`
    )
    .bind(documentId)
    .first<{ c: number }>();
  return Number(r?.c) || 0;
}
