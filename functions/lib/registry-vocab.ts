/**
 * Shared helpers for the per-tenant registry VOCABULARY admin surface
 * (migration 0080): `requirements` (layer 2 — what a document SATISFIES),
 * `claim_types` (layer 3 — what a document TRIGGERS) and the
 * `claim_type_requirements` mapping between them.
 *
 * The vocabularies are ROWS, never code: aiming the platform at a new vertical
 * (finance, cannabis, pharma) is a configuration exercise. Nothing in this
 * module knows anything food-specific — the domain content lives in
 * `starter-packs/*.json` and is seeded by `bin/create-tenant --pack <name>`.
 *
 * Link-level operations (a DOCUMENT asserting a requirement/claim) belong in
 * `registry.ts`; this module is strictly about the vocabulary + the config
 * that relates the two vocabularies.
 */

import { generateId } from './db';
import { BadRequestError } from './permissions';
import { validateFacetIds } from './registry';

/** Slugify a vocabulary name the same way document_types does. */
export function slugifyVocab(text: string): string {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * A single claim -> requirement mapping as accepted by the editor.
 * `is_required` 1 = the claim makes this requirement mandatory (it becomes a
 * GAP when unmet); 0 = advisory only.
 */
export interface ClaimRuleInput {
  requirement_id: string;
  is_required?: number | boolean;
  notes?: string | null;
}

/**
 * Parse the `requirements` array a mapping-editor save posts. Accepts bare
 * requirement ids (the common "just tick the boxes" case) or full objects, so
 * a checkbox UI and a richer importer can post to the same endpoint.
 */
export function parseClaimRules(raw: unknown, field = 'requirements'): ClaimRuleInput[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new BadRequestError(`${field} must be an array`);
  }
  const rules: ClaimRuleInput[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const id = entry.trim();
      if (id) rules.push({ requirement_id: id });
      continue;
    }
    if (!entry || typeof entry !== 'object') {
      throw new BadRequestError(
        `${field} entries must be requirement ids or objects with requirement_id`,
      );
    }
    const obj = entry as Record<string, unknown>;
    const id =
      typeof obj.requirement_id === 'string'
        ? obj.requirement_id.trim()
        : typeof obj.id === 'string'
          ? (obj.id as string).trim()
          : '';
    if (!id) throw new BadRequestError(`${field} entries must have a requirement_id`);
    const rule: ClaimRuleInput = { requirement_id: id };
    if (obj.is_required !== undefined) {
      const v = obj.is_required;
      if (typeof v === 'boolean') rule.is_required = v ? 1 : 0;
      else if (v === 0 || v === 1 || v === '0' || v === '1') rule.is_required = Number(v);
      else throw new BadRequestError(`${field}: is_required must be 0 or 1`);
    }
    if (typeof obj.notes === 'string') rule.notes = obj.notes;
    rules.push(rule);
  }
  return rules;
}

/**
 * REPLACE the requirement set a claim type opens.
 *
 * This is the write half of the client's "conditional triggers" config —
 * "Organic requires an Organic Certificate", entered once and reused by every
 * document that claims Organic. Gap detection (P4) reads it back through
 * `requirementsOpenedByClaims`.
 *
 * Both sides are validated against the SAME tenant via the P1 lib validator, so
 * a mapping can never straddle tenants (the denormalized tenant_id column on
 * claim_type_requirements exists to keep gap queries single-join; it must not
 * be allowed to disagree with either parent).
 */
export async function syncClaimTypeRequirements(
  db: D1Database,
  tenantId: string,
  claimTypeId: string,
  rules: ClaimRuleInput[],
): Promise<void> {
  await validateFacetIds(db, 'claim', tenantId, [claimTypeId]);
  await validateFacetIds(
    db,
    'requirement',
    tenantId,
    rules.map((r) => r.requirement_id),
  );

  await db
    .prepare('DELETE FROM claim_type_requirements WHERE claim_type_id = ? AND tenant_id = ?')
    .bind(claimTypeId, tenantId)
    .run();

  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.requirement_id)) continue;
    seen.add(rule.requirement_id);
    await db
      .prepare(
        `INSERT OR IGNORE INTO claim_type_requirements
           (id, tenant_id, claim_type_id, requirement_id, is_required, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        generateId(),
        tenantId,
        claimTypeId,
        rule.requirement_id,
        rule.is_required === 0 ? 0 : 1,
        rule.notes ?? null,
      )
      .run();
  }
}

/**
 * Read the mapping config back with both vocabularies joined in, ordered the
 * way the tenant configured them. `claimTypeId` narrows to one claim.
 */
export async function listClaimTypeRequirements(
  db: D1Database,
  tenantId: string,
  claimTypeId?: string,
): Promise<Record<string, unknown>[]> {
  const params: string[] = [tenantId];
  let where = 'ctr.tenant_id = ?';
  if (claimTypeId) {
    where += ' AND ctr.claim_type_id = ?';
    params.push(claimTypeId);
  }
  const rows = await db
    .prepare(
      `SELECT ctr.*,
              ct.name AS claim_type_name, ct.slug AS claim_type_slug,
              r.name  AS requirement_name, r.slug AS requirement_slug,
              r.checklist AS checklist
         FROM claim_type_requirements ctr
         JOIN claim_types  ct ON ct.id = ctr.claim_type_id
         JOIN requirements r  ON r.id  = ctr.requirement_id
        WHERE ${where}
        ORDER BY ct.sort_order, ct.name, r.sort_order, r.name`,
    )
    .bind(...params)
    .all<Record<string, unknown>>();
  return rows.results;
}

/**
 * Resolve which tenant a vocabulary write targets, matching the document-types
 * convention: a super_admin must name the tenant explicitly, everyone else is
 * pinned to their own.
 */
export function resolveWriteTenant(
  user: { role: string; tenant_id: string | null },
  bodyTenantId: string | undefined,
): string {
  if (user.role === 'super_admin') {
    if (!bodyTenantId) throw new BadRequestError('tenant_id is required for super_admin');
    return bodyTenantId;
  }
  return user.tenant_id!;
}
