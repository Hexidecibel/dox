/**
 * D1 side of requirement derivation (shared/requirementDerivation.ts is the
 * pure half): load a tenant's vocabulary, apply packets to named suppliers,
 * and the worklist's confirm/remove.
 *
 * Every write here is GUARDED IN SQL by the provenance it expects, not only by
 * the plan computed a moment earlier: an adopt is `... WHERE source IS NULL`, a
 * refresh or flag is `... WHERE source = 'derived'`. A person who re-tiers a
 * row between the preview and the apply therefore wins even against a stale
 * plan — the rule "a person's row is never overwritten" holds at the database,
 * not just in the planner.
 */

import { generateId, logAudit } from './db';
import { BadRequestError, NotFoundError } from './permissions';
import { getStarterPack, DEFAULT_STARTER_PACK, type StarterPack } from './starterPacks.generated';
import {
  planPacketApply,
  type ExistingApplicability,
  type PacketChange,
  type ClaimRuleDefinition,
} from '../../shared/requirementDerivation';
import type {
  BulkApplyPacketResponse,
  PacketPreviewLine,
  PacketPreviewSupplier,
  SupplierRequirementSource,
  SupplierRequirementTier,
} from '../../shared/types';

export interface RequirementVocab {
  /** Active requirements by slug. */
  bySlug: Map<string, { id: string; name: string }>;
  /** Every requirement by id, active or not — for naming existing rows. */
  byId: Map<string, { slug: string; name: string }>;
}

export async function loadRequirementVocab(db: D1Database, tenantId: string): Promise<RequirementVocab> {
  const res = await db
    .prepare('SELECT id, slug, name, active FROM requirements WHERE tenant_id = ?')
    .bind(tenantId)
    .all<{ id: string; slug: string; name: string; active: number }>();
  const bySlug = new Map<string, { id: string; name: string }>();
  const byId = new Map<string, { slug: string; name: string }>();
  for (const r of res.results ?? []) {
    byId.set(r.id, { slug: r.slug, name: r.name });
    if (r.active === 1) bySlug.set(r.slug, { id: r.id, name: r.name });
  }
  return { bySlug, byId };
}

export async function loadExistingApplicability(
  db: D1Database,
  tenantId: string,
  supplierIds?: readonly string[],
): Promise<ExistingApplicability[]> {
  const res = await db
    .prepare(
      `SELECT sr.id, sr.supplier_id, r.slug AS requirement_slug, sr.tier, sr.source,
              sr.packet_slug, sr.review_flag
         FROM supplier_requirements sr
         JOIN requirements r ON r.id = sr.requirement_id
        WHERE sr.tenant_id = ?`,
    )
    .bind(tenantId)
    .all<ExistingApplicability>();
  const rows = res.results ?? [];
  if (!supplierIds) return rows;
  const wanted = new Set(supplierIds);
  return rows.filter((r) => wanted.has(r.supplier_id));
}

export async function loadClaimVocab(
  db: D1Database,
  tenantId: string,
): Promise<{
  claimTypes: Array<{ id: string; slug: string; name: string }>;
  claimRules: ClaimRuleDefinition[];
}> {
  const [types, rules] = await Promise.all([
    db
      .prepare('SELECT id, slug, name FROM claim_types WHERE tenant_id = ? AND active = 1')
      .bind(tenantId)
      .all<{ id: string; slug: string; name: string }>(),
    db
      .prepare(
        `SELECT ct.slug AS claim_slug, r.slug AS requirement_slug, ctr.is_required
           FROM claim_type_requirements ctr
           JOIN claim_types ct ON ct.id = ctr.claim_type_id
           JOIN requirements r ON r.id = ctr.requirement_id
          WHERE ctr.tenant_id = ? AND ct.active = 1`,
      )
      .bind(tenantId)
      .all<{ claim_slug: string; requirement_slug: string; is_required: number }>(),
  ]);
  return {
    claimTypes: types.results ?? [],
    claimRules: (rules.results ?? []).map((r) => ({
      claim_slug: r.claim_slug,
      requirement_slug: r.requirement_slug,
      is_required: r.is_required === 1,
    })),
  };
}

/**
 * Which starter pack's packets a tenant's admin screens offer.
 *
 * The pack the tenant's setup wizard last chose, else the default pack. An
 * explicit override wins (a super_admin configuring a tenant seeded from the
 * CLI, which leaves no setup run behind).
 */
export async function resolveTenantPack(
  db: D1Database,
  tenantId: string,
  override?: string | null,
): Promise<StarterPack> {
  if (override) {
    const pack = getStarterPack(override);
    if (!pack) throw new NotFoundError(`Unknown starter pack: ${override}`);
    return pack;
  }
  const row = await db
    .prepare(
      `SELECT pack FROM tenant_setup_runs
        WHERE tenant_id = ? AND pack IS NOT NULL
        ORDER BY updated_at DESC LIMIT 1`,
    )
    .bind(tenantId)
    .first<{ pack: string }>();
  const pack = getStarterPack(row?.pack ?? DEFAULT_STARTER_PACK) ?? getStarterPack(DEFAULT_STARTER_PACK);
  if (!pack) throw new NotFoundError('No starter pack is available');
  return pack;
}

/** The cap on suppliers per packet call. Named suppliers, not a tenant sweep. */
export const PACKET_SUPPLIER_CAP = 200;

export async function applyPacketToSuppliers(
  db: D1Database,
  opts: {
    tenantId: string;
    pack: StarterPack;
    packetSlug: string;
    supplierIds: readonly string[];
    dryRun: boolean;
    replaceUnconfirmed: boolean;
    actorId: string;
    ip: string | null;
  },
): Promise<BulkApplyPacketResponse> {
  const packet = opts.pack.requirement_packets.find((p) => p.slug === opts.packetSlug);
  if (!packet) throw new NotFoundError(`Unknown packet "${opts.packetSlug}" in pack "${opts.pack.pack}"`);

  const ids = [...new Set(opts.supplierIds.map((s) => String(s).trim()).filter(Boolean))];
  if (ids.length === 0) throw new BadRequestError('supplier_ids must name at least one supplier');
  if (ids.length > PACKET_SUPPLIER_CAP) {
    throw new BadRequestError(`At most ${PACKET_SUPPLIER_CAP} suppliers per call`);
  }

  const supplierNames = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const res = await db
      .prepare(
        `SELECT id, name FROM suppliers WHERE tenant_id = ? AND id IN (${chunk.map(() => '?').join(',')})`,
      )
      .bind(opts.tenantId, ...chunk)
      .all<{ id: string; name: string }>();
    for (const r of res.results ?? []) supplierNames.set(r.id, r.name);
  }
  const missing = ids.filter((id) => !supplierNames.has(id));
  if (missing.length > 0) {
    throw new BadRequestError(`Invalid supplier for this tenant: ${missing.join(', ')}`);
  }

  const vocab = await loadRequirementVocab(db, opts.tenantId);
  const existing = await loadExistingApplicability(db, opts.tenantId, ids);
  const { changes, unknownRequirements } = planPacketApply({
    supplierIds: ids,
    packet,
    existing,
    knownRequirementSlugs: new Set(vocab.bySlug.keys()),
    replaceUnconfirmed: opts.replaceUnconfirmed,
  });

  const suppliers: PacketPreviewSupplier[] = ids.map((id) => ({
    supplier_id: id,
    supplier_name: supplierNames.get(id) ?? id,
    lines: [],
    counts: { add: 0, adopt_unconfirmed: 0, already_present: 0, remove_unconfirmed: 0, tier_kept_different: 0 },
  }));
  const byId = new Map(suppliers.map((s) => [s.supplier_id, s]));
  const nameOf = (slug: string) => vocab.bySlug.get(slug)?.name ?? slug;
  const idOf = (slug: string) => vocab.bySlug.get(slug)?.id ?? null;

  for (const ch of changes) {
    const s = byId.get(ch.supplier_id)!;
    s.lines.push(previewLine(ch, nameOf, idOf));
    s.counts[ch.kind] += 1;
    if (ch.kind === 'already_present' && ch.tier !== ch.packet_tier) s.counts.tier_kept_different += 1;
  }
  const totals = { add: 0, adopt_unconfirmed: 0, already_present: 0, remove_unconfirmed: 0 };
  for (const ch of changes) totals[ch.kind] += 1;

  if (!opts.dryRun) {
    const stmts: D1PreparedStatement[] = [];
    for (const ch of changes) {
      if (ch.kind === 'add') {
        stmts.push(
          db
            .prepare(
              `INSERT OR IGNORE INTO supplier_requirements
                 (id, tenant_id, supplier_id, requirement_id, tier, source, packet_slug, created_by, updated_by)
               VALUES (?, ?, ?, ?, ?, 'packet', ?, ?, ?)`,
            )
            .bind(generateId(), opts.tenantId, ch.supplier_id, idOf(ch.slug), ch.tier, packet.slug, opts.actorId, opts.actorId),
        );
      } else if (ch.kind === 'adopt_unconfirmed') {
        stmts.push(
          db
            .prepare(
              `UPDATE supplier_requirements
                  SET tier = ?, source = 'packet', packet_slug = ?, review_flag = NULL, review_flagged_at = NULL,
                      updated_at = datetime('now'), updated_by = ?
                WHERE id = ? AND tenant_id = ? AND source IS NULL`,
            )
            .bind(ch.tier, packet.slug, opts.actorId, ch.row_id, opts.tenantId),
        );
      } else if (ch.kind === 'remove_unconfirmed') {
        stmts.push(
          db
            .prepare('DELETE FROM supplier_requirements WHERE id = ? AND tenant_id = ? AND source IS NULL')
            .bind(ch.row_id, opts.tenantId),
        );
      }
    }
    for (let i = 0; i < stmts.length; i += 100) {
      await db.batch(stmts.slice(i, i + 100));
    }
    for (const s of suppliers) {
      if (s.counts.add + s.counts.adopt_unconfirmed + s.counts.remove_unconfirmed === 0) continue;
      await logAudit(
        db,
        opts.actorId,
        opts.tenantId,
        'requirement_packet.apply',
        'supplier',
        s.supplier_id,
        JSON.stringify({
          pack: opts.pack.pack,
          packet: packet.slug,
          supplier_name: s.supplier_name,
          from: 'admin',
          replace_unconfirmed: opts.replaceUnconfirmed,
          added: s.lines.filter((l) => l.action === 'add').map((l) => ({ slug: l.requirement_slug, tier: l.tier })),
          adopted_unconfirmed: s.lines
            .filter((l) => l.action === 'adopt_unconfirmed')
            .map((l) => ({ slug: l.requirement_slug, from_tier: l.from_tier, tier: l.tier })),
          removed_unconfirmed: s.lines
            .filter((l) => l.action === 'remove_unconfirmed')
            .map((l) => ({ slug: l.requirement_slug, tier: l.from_tier })),
          unknown_requirements: unknownRequirements,
        }),
        opts.ip,
      );
    }
  }

  return {
    dry_run: opts.dryRun,
    pack: opts.pack.pack,
    packet: packet.slug,
    packet_name: packet.name,
    suppliers,
    totals,
    unknown_requirements: unknownRequirements,
  };
}

function previewLine(
  ch: PacketChange,
  nameOf: (slug: string) => string,
  idOf: (slug: string) => string | null,
): PacketPreviewLine {
  const base = { requirement_id: idOf(ch.slug), requirement_slug: ch.slug, requirement_name: nameOf(ch.slug) };
  switch (ch.kind) {
    case 'add':
      return { ...base, action: 'add', tier: ch.tier, from_tier: null, packet_tier: ch.tier, existing_source: null };
    case 'adopt_unconfirmed':
      return { ...base, action: 'adopt_unconfirmed', tier: ch.tier, from_tier: ch.from_tier, packet_tier: ch.tier, existing_source: null };
    case 'already_present':
      return {
        ...base,
        action: 'already_present',
        tier: ch.tier,
        from_tier: ch.tier,
        packet_tier: ch.packet_tier,
        existing_source: ch.source as SupplierRequirementSource | null,
      };
    case 'remove_unconfirmed':
      return {
        ...base,
        action: 'remove_unconfirmed',
        tier: ch.tier as SupplierRequirementTier,
        from_tier: ch.tier,
        packet_tier: null,
        existing_source: null,
      };
  }
}

/**
 * The worklist's bulk actions.
 *
 * confirm  stamps source 'human' and clears any review flag — "a person looked
 *          at this and it stands". Works on unconfirmed seed rows and on
 *          derived rows flagged as no longer on the verified list.
 * remove   the existing detach semantics: a hard DELETE (0087 — nothing
 *          references an applicability row), with an audit row carrying the
 *          whole row so the removal is reconstructable. Only rows that NEED
 *          review can be removed this way (unconfirmed or flagged); a person's
 *          row is removed one at a time from the editor, deliberately.
 */
export async function reviewSupplierRequirements(
  db: D1Database,
  opts: { tenantId: string; action: 'confirm' | 'remove'; ids: readonly string[]; actorId: string; ip: string | null },
): Promise<{ applied: number; not_found: string[] }> {
  const ids = [...new Set(opts.ids.map((s) => String(s).trim()).filter(Boolean))];
  if (ids.length === 0) throw new BadRequestError('ids must name at least one row');
  if (ids.length > 500) throw new BadRequestError('At most 500 rows per call');

  const rows: Array<Record<string, unknown> & { id: string }> = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const res = await db
      .prepare(
        `SELECT sr.*, r.slug AS requirement_slug, s.name AS supplier_name
           FROM supplier_requirements sr
           JOIN requirements r ON r.id = sr.requirement_id
           JOIN suppliers s ON s.id = sr.supplier_id
          WHERE sr.tenant_id = ? AND sr.id IN (${chunk.map(() => '?').join(',')})`,
      )
      .bind(opts.tenantId, ...chunk)
      .all<Record<string, unknown> & { id: string }>();
    rows.push(...(res.results ?? []));
  }
  const found = new Set(rows.map((r) => r.id));
  const notFound = ids.filter((id) => !found.has(id));

  const eligible = rows.filter((r) => r.source === null || r.review_flag !== null);
  if (opts.action === 'remove' && eligible.length !== rows.length) {
    throw new BadRequestError(
      'Only unconfirmed or flagged rows can be removed from the worklist. Remove a confirmed row from the supplier\'s requirements.',
    );
  }

  let applied = 0;
  // A confirm naming a row that needs no review is a no-op, not an error: the
  // page may hold a stale selection, and converting a derived row the list
  // still supports into a 'human' one would take it out of the list's hands.
  for (const row of eligible) {
    if (opts.action === 'confirm') {
      const res = await db
        .prepare(
          `UPDATE supplier_requirements
              SET source = 'human', review_flag = NULL, review_flagged_at = NULL,
                  updated_at = datetime('now'), updated_by = ?
            WHERE id = ? AND tenant_id = ?`,
        )
        .bind(opts.actorId, row.id, opts.tenantId)
        .run();
      if ((res.meta?.changes ?? 0) > 0) applied++;
      await logAudit(
        db,
        opts.actorId,
        opts.tenantId,
        'supplier_requirement_confirmed',
        'supplier_requirement',
        row.id,
        JSON.stringify({
          supplier_id: row.supplier_id,
          supplier_name: row.supplier_name,
          requirement_slug: row.requirement_slug,
          tier: row.tier,
          previous_source: row.source,
          previous_review_flag: row.review_flag,
        }),
        opts.ip,
      );
    } else {
      const res = await db
        .prepare(
          `DELETE FROM supplier_requirements
            WHERE id = ? AND tenant_id = ? AND (source IS NULL OR review_flag IS NOT NULL)`,
        )
        .bind(row.id, opts.tenantId)
        .run();
      if ((res.meta?.changes ?? 0) > 0) applied++;
      await logAudit(
        db,
        opts.actorId,
        opts.tenantId,
        'supplier_requirement_deleted',
        'supplier_requirement',
        row.id,
        JSON.stringify({
          reason: row.source === null ? 'worklist_unconfirmed' : 'worklist_not_on_verified_list',
          supplier_id: row.supplier_id,
          supplier_name: row.supplier_name,
          requirement_id: row.requirement_id,
          requirement_slug: row.requirement_slug,
          tier: row.tier,
          source: row.source,
          packet_slug: row.packet_slug,
          derivation_run_id: row.derivation_run_id,
          review_flag: row.review_flag,
          created_at: row.created_at,
        }),
        opts.ip,
      );
    }
  }
  return { applied, not_found: notFound };
}
