import { generateId, logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  NotFoundError,
  errorToResponse,
} from '../../lib/permissions';
import { packRowId } from '../../lib/starter-packs';
import { getStarterPack } from '../../lib/starterPacks.generated';
import { findOrCreateSupplier, ImplausibleSupplierNameError } from '../../lib/suppliers';
import { getRunById, stampApplied } from '../../lib/tenant-setup';
import type { Env, User } from '../../lib/types';
import type {
  ApplyRequirementPacketRequest,
  ApplyRequirementPacketResponse,
  TenantSetupRun,
} from '../../../shared/types';

/**
 * POST /api/starter-packs/apply-packet — ONE packet, ONE named supplier.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THERE IS NO APPLY-TO-ALL, AND THERE MUST NEVER BE ONE
 * ═══════════════════════════════════════════════════════════════════════════
 * `supplier_requirements` is the LEFT side of every gap report: a row there
 * does not sit in a table, it asserts an obligation and then reports the
 * supplier as failing to meet it. The live tenant's checklist is
 * uniform-and-wrong because six items were bulk-written across 21 existing
 * suppliers in one retroactive pass — every supplier owing exactly the same
 * things, none of it chosen.
 *
 * So this endpoint takes ONE supplier, by id or by name, and there is no shape
 * in the request that can mean "all of them". That is a property of the API and
 * not of the UI on top of it: a bulk endpoint would be called by a convenience
 * button somebody adds six months from now, and the damage is not visible until
 * a customer reads their own gap report.
 *
 * (2026-09-15: the admin screens gained POST /api/supplier-requirements/
 * apply-packet, which takes SEVERAL suppliers — but each one named by id,
 * capped, previewed by default, and unable to change any row a person or the
 * verified supplier list set. It still has no shape that means "all of them".)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PROVENANCE IS WRITTEN, BECAUSE A WRONG DEFAULT HAS TO BE FINDABLE
 * ═══════════════════════════════════════════════════════════════════════════
 * Every row lands with `source = 'packet'` and the `packet_slug` that produced
 * it (migration 0102). A packet is a GUESS about what a kind of supplier owes;
 * it will sometimes be wrong, and "which suppliers got the Ingredient Supplier
 * packet" must be one query rather than an archaeology exercise. The columns
 * are nullable and pre-existing rows keep NULL — see the migration for why
 * stamping them 'human' would have been a lie.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NEVER OVERWRITES AN EXISTING ROW
 * ═══════════════════════════════════════════════════════════════════════════
 * `INSERT OR IGNORE` against 0087's `UNIQUE(tenant_id, supplier_id,
 * requirement_id)`. A supplier already carrying a line item keeps whatever tier
 * and notes a human gave it — including a `recommended` somebody deliberately
 * downgraded from this same packet's `required`. Applying a packet twice is a
 * no-op that honestly reports zeros, exactly as re-applying a pack does.
 *
 * A requirement slug the tenant has no row for is REPORTED, not skipped
 * silently: it means the pack and the tenant have diverged, and the supplier's
 * checklist is quieter than the packet promised.
 *
 * Role: super_admin, org_admin — the same tier that owns
 * /api/supplier-requirements, because this writes that table.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface AttachOutcome {
  attached: { required: number; recommended: number };
  unknown: string[];
}

/**
 * Write one packet's rows for one supplier.
 *
 * Requirement ids are resolved the way the pack wrote them — the deterministic
 * `packRowId('req', tenantSlug, slug)` — and then CONFIRMED to exist against
 * this tenant. Both halves matter: deriving the id avoids a join per slug, and
 * the existence check is what turns "the pack names a requirement this tenant
 * never seeded" into a reported divergence instead of an FK error 400 that
 * takes the whole call down.
 */
async function attachPacket(
  db: D1Database,
  tenantId: string,
  tenantSlug: string,
  supplierId: string,
  packetSlug: string,
  tiers: ReadonlyArray<{ tier: 'required' | 'recommended'; slugs: readonly string[] }>,
  actorId: string,
): Promise<AttachOutcome> {
  const outcome: AttachOutcome = { attached: { required: 0, recommended: 0 }, unknown: [] };

  for (const { tier, slugs } of tiers) {
    for (const slug of slugs) {
      const requirementId = packRowId('req', tenantSlug, slug);
      const exists = await db
        .prepare('SELECT id FROM requirements WHERE id = ? AND tenant_id = ?')
        .bind(requirementId, tenantId)
        .first<{ id: string }>();
      if (!exists) {
        if (!outcome.unknown.includes(slug)) outcome.unknown.push(slug);
        continue;
      }

      // Counted by census rather than by `meta.changes`, for the same reason
      // `applyStarterPack` does: a row that already existed is IGNOREd and must
      // report as zero, and nothing in a caller's summary should say "attached
      // 4" when it attached none.
      const before = await db
        .prepare(
          `SELECT id FROM supplier_requirements
            WHERE tenant_id = ? AND supplier_id = ? AND requirement_id = ?`,
        )
        .bind(tenantId, supplierId, requirementId)
        .first<{ id: string }>();
      if (before) continue;

      await db
        .prepare(
          `INSERT OR IGNORE INTO supplier_requirements
             (id, tenant_id, supplier_id, requirement_id, tier, source, packet_slug,
              created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, 'packet', ?, ?, ?)`,
        )
        .bind(
          generateId(),
          tenantId,
          supplierId,
          requirementId,
          tier,
          packetSlug,
          actorId,
          actorId,
        )
        .run();

      outcome.attached[tier] += 1;
    }
  }

  return outcome;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const body = (await context.request
      .json()
      .catch(() => ({}))) as ApplyRequirementPacketRequest;

    const tenantId =
      user.role === 'super_admin' ? (body.tenant_id ?? user.tenant_id) : user.tenant_id;
    if (!tenantId) throw new BadRequestError('tenant_id is required');
    requireTenantAccess(user, tenantId);

    const packName = String(body.pack ?? '').trim();
    if (!packName) throw new BadRequestError('pack is required');
    const pack = getStarterPack(packName);
    if (!pack) throw new NotFoundError(`Unknown starter pack: ${packName}`);

    const packetSlug = String(body.packet ?? '').trim();
    if (!packetSlug) throw new BadRequestError('packet is required');
    const packet = pack.requirement_packets.find((p) => p.slug === packetSlug);
    if (!packet) {
      throw new NotFoundError(`Unknown packet "${packetSlug}" in pack "${packName}"`);
    }

    const suppliedId = String(body.supplier_id ?? '').trim();
    const suppliedName = String(body.supplier_name ?? '').trim();
    // Exactly one. Naming both is not a convenience to resolve by precedence —
    // it means the caller does not know which supplier it is talking about, and
    // this endpoint's entire discipline is that the supplier is named.
    if (suppliedId && suppliedName) {
      throw new BadRequestError('Send supplier_id or supplier_name, not both');
    }
    if (!suppliedId && !suppliedName) {
      throw new BadRequestError('supplier_id or supplier_name is required');
    }

    const tenant = await context.env.DB.prepare('SELECT id, slug FROM tenants WHERE id = ?')
      .bind(tenantId)
      .first<{ id: string; slug: string | null }>();
    if (!tenant) throw new NotFoundError('Tenant not found');
    if (!tenant.slug) {
      throw new BadRequestError(
        'This tenant has no slug, and a pack row id is derived from it. Set a slug first.',
      );
    }

    let supplierId: string;
    let supplierCreated = false;
    if (suppliedId) {
      const row = await context.env.DB.prepare(
        'SELECT id FROM suppliers WHERE id = ? AND tenant_id = ?',
      )
        .bind(suppliedId, tenantId)
        .first<{ id: string }>();
      if (!row) throw new BadRequestError('Invalid supplier for this tenant');
      supplierId = row.id;
    } else {
      // The SAME resolver the approve path uses, deliberately: a spelling that
      // matches an existing supplier attaches to it and records the alias,
      // rather than forking a near-duplicate that then owns half a checklist.
      let resolved;
      try {
        resolved = await findOrCreateSupplier(context.env.DB, tenantId, suppliedName, {
          userId: user.id,
          ip: getClientIp(context.request),
        });
      } catch (err) {
        // The junk filter fires on names that came out of an image letterhead
        // as "C2#" — a real and recurring extraction defect. Surfaced as a 400
        // naming the value rather than the 500 that /api/suppliers/
        // lookup-or-create still returns, because the caller here is a person
        // watching a demo who can retype it.
        if (err instanceof ImplausibleSupplierNameError) {
          throw new BadRequestError(
            `"${suppliedName}" does not look like a supplier name. Type the supplier's name to attach the packet.`,
          );
        }
        throw err;
      }
      supplierId = resolved.id;
      supplierCreated = resolved.created;
    }

    const supplier = await context.env.DB.prepare(
      'SELECT id, name FROM suppliers WHERE id = ?',
    )
      .bind(supplierId)
      .first<{ id: string; name: string }>();
    if (!supplier) throw new NotFoundError('Supplier not found');

    const outcome = await attachPacket(
      context.env.DB,
      tenantId,
      tenant.slug,
      supplierId,
      packet.slug,
      [
        { tier: 'required', slugs: packet.requirements },
        { tier: 'recommended', slugs: packet.recommends },
      ],
      user.id,
    );

    let run: TenantSetupRun | null = null;
    if (body.run_id) {
      const target = await getRunById(context.env.DB, body.run_id);
      // A run id belonging to another tenant is skipped rather than rejected:
      // the rows above were written against the tenant the caller is entitled
      // to, and only the bookkeeping is refused. Same rule as
      // /api/starter-packs/apply.
      if (target && target.tenant_id === tenantId) {
        run = await stampApplied(context.env.DB, body.run_id, 'packet', {
          pack: pack.pack,
          packet: packet.slug,
          packet_name: packet.name,
          supplier_id: supplierId,
          supplier_name: supplier.name,
          applied_at: new Date().toISOString(),
          attached: { ...outcome.attached },
        });
      }
    }

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'requirement_packet.apply',
      'supplier',
      supplierId,
      JSON.stringify({
        pack: pack.pack,
        packet: packet.slug,
        supplier_name: supplier.name,
        supplier_created: supplierCreated,
        attached: outcome.attached,
        unknown_requirements: outcome.unknown,
      }),
      getClientIp(context.request),
    );

    const response: ApplyRequirementPacketResponse = {
      pack: pack.pack,
      packet: packet.slug,
      packet_name: packet.name,
      supplier_id: supplierId,
      supplier_name: supplier.name,
      supplier_created: supplierCreated,
      attached: outcome.attached,
      unknown_requirements: outcome.unknown,
      run,
    };
    return json(response);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('requirement packet apply error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
