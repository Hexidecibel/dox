import { requireTenantAccess, BadRequestError, errorToResponse } from '../../lib/permissions';
import { normalizeSupplierName } from '../../lib/suppliers';
import type { Env, User } from '../../lib/types';

interface SupplierRowLite {
  id: string;
  name: string;
  slug: string;
  aliases: string | null;
}

interface ClusterSupplier {
  id: string;
  name: string;
  slug: string;
  doc_count: number;
}

interface Cluster {
  reason: 'normalized' | 'similar';
  suppliers: ClusterSupplier[];
}

function tokenize(normalized: string): Set<string> {
  return new Set(normalized.split(/\s+/).filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * GET /api/suppliers/duplicates
 *
 * Conservatively surface candidate duplicate clusters for a tenant. Two kinds:
 *   - reason 'normalized': suppliers that collapse to the same normalized name.
 *   - reason 'similar': pairs where one normalized name is a strict prefix of
 *     the other, OR token-Jaccard >= 0.6.
 *
 * These are SUGGESTIONS ONLY — nothing is auto-merged. Sorted by total doc_count
 * descending.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);

    let tenantId = url.searchParams.get('tenant_id');
    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }
    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }
    requireTenantAccess(user, tenantId);

    const res = await context.env.DB.prepare(
      'SELECT id, name, slug, aliases FROM suppliers WHERE tenant_id = ? AND active = 1'
    )
      .bind(tenantId)
      .all<SupplierRowLite>();
    const suppliers = res.results ?? [];

    // Per-supplier document counts (single grouped query).
    const countRes = await context.env.DB.prepare(
      'SELECT supplier_id, COUNT(*) as c FROM documents WHERE tenant_id = ? AND supplier_id IS NOT NULL GROUP BY supplier_id'
    )
      .bind(tenantId)
      .all<{ supplier_id: string; c: number }>();
    const docCounts = new Map<string, number>();
    for (const row of countRes.results ?? []) {
      docCounts.set(row.supplier_id, row.c);
    }

    const lite = suppliers.map((s) => ({
      ...s,
      normalized: normalizeSupplierName(s.name),
      tokens: tokenize(normalizeSupplierName(s.name)),
      doc_count: docCounts.get(s.id) ?? 0,
    }));

    const toClusterSupplier = (s: (typeof lite)[number]): ClusterSupplier => ({
      id: s.id,
      name: s.name,
      slug: s.slug,
      doc_count: s.doc_count,
    });

    const clusters: Cluster[] = [];
    // Track which suppliers landed in a 'normalized' cluster so we don't also
    // re-report the same exact set as 'similar'.
    const inNormalizedCluster = new Set<string>();

    // 1. Exact-normalized clusters.
    const byNormalized = new Map<string, typeof lite>();
    for (const s of lite) {
      if (!s.normalized) continue;
      const arr = byNormalized.get(s.normalized) ?? [];
      arr.push(s);
      byNormalized.set(s.normalized, arr);
    }
    for (const arr of byNormalized.values()) {
      if (arr.length > 1) {
        for (const s of arr) inNormalizedCluster.add(s.id);
        clusters.push({ reason: 'normalized', suppliers: arr.map(toClusterSupplier) });
      }
    }

    // 2. 'similar' pairs: strict prefix OR token-Jaccard >= 0.6. Skip pairs
    //    whose normalized names are identical (those are 'normalized' already).
    for (let i = 0; i < lite.length; i++) {
      for (let j = i + 1; j < lite.length; j++) {
        const a = lite[i];
        const b = lite[j];
        if (!a.normalized || !b.normalized) continue;
        if (a.normalized === b.normalized) continue;

        const shorter = a.normalized.length <= b.normalized.length ? a.normalized : b.normalized;
        const longer = a.normalized.length <= b.normalized.length ? b.normalized : a.normalized;
        const prefixHit =
          longer.startsWith(shorter) &&
          (longer[shorter.length] === ' ' || longer[shorter.length] === undefined);

        const jac = jaccard(a.tokens, b.tokens);

        if (prefixHit || jac >= 0.6) {
          clusters.push({ reason: 'similar', suppliers: [toClusterSupplier(a), toClusterSupplier(b)] });
        }
      }
    }

    // Sort by total doc_count desc.
    clusters.sort((x, y) => {
      const sx = x.suppliers.reduce((acc, s) => acc + s.doc_count, 0);
      const sy = y.suppliers.reduce((acc, s) => acc + s.doc_count, 0);
      return sy - sx;
    });

    return new Response(JSON.stringify({ clusters }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Supplier duplicates error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
