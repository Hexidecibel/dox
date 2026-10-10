/**
 * D1 side of the duplicate-concept check (shared/duplicateConcept.ts is the
 * pure half) and of the "slugs do not change" rule, for the three vocabulary
 * routes: /api/document-types, /api/requirements, /api/claim-types.
 *
 * WHICH PACK IS "THE ORGANISATION'S PACK". The packs its ledger names
 * (`tenant_packs`, migration 0141), plus the pack its setup wizard chose
 * (`tenant_setup_runs.pack`) for an organisation that has not been baselined
 * yet. NOT the default pack as a fallback: an organisation that never took a
 * pack must be able to call a document type "Certificate of Analysis" without
 * being told it duplicates a pack it has never seen. (`resolveTenantPack` in
 * requirement-derivation.ts does fall back, because it answers a different
 * question: which packets to OFFER.)
 */

import { getStarterPack, type StarterPack } from './starterPacks.generated';
import {
  describeDuplicateConcept,
  findDuplicateConcept,
  type ConceptPackItem,
  type DuplicateConcept,
} from '../../shared/duplicateConcept';

export type ConceptVocabulary = 'document_types' | 'requirements' | 'claim_types';

const NOUN: Record<ConceptVocabulary, string> = {
  document_types: 'document type',
  requirements: 'requirement',
  claim_types: 'claim type',
};

/** The packs an organisation is on: its ledger, else its setup run. */
export async function loadTenantPacks(db: D1Database, tenantId: string): Promise<StarterPack[]> {
  const names = new Set<string>();
  const ledger = await db
    .prepare('SELECT DISTINCT pack FROM tenant_packs WHERE tenant_id = ?')
    .bind(tenantId)
    .all<{ pack: string }>();
  for (const r of ledger.results ?? []) names.add(r.pack);
  if (names.size === 0) {
    const runs = await db
      .prepare('SELECT DISTINCT pack FROM tenant_setup_runs WHERE tenant_id = ? AND pack IS NOT NULL')
      .bind(tenantId)
      .all<{ pack: string }>();
    for (const r of runs.results ?? []) names.add(r.pack);
  }
  const packs: StarterPack[] = [];
  for (const name of [...names].sort()) {
    const pack = getStarterPack(name);
    if (pack) packs.push(pack);
  }
  return packs;
}

function packConceptItems(packs: readonly StarterPack[], vocabulary: ConceptVocabulary): ConceptPackItem[] {
  const out: ConceptPackItem[] = [];
  for (const pack of packs) {
    for (const item of pack[vocabulary]) {
      out.push({ pack: pack.pack, name: item.name, slug: item.slug, aliases: item.aliases ?? [] });
    }
  }
  return out;
}

export interface DuplicateConceptHit {
  duplicate: DuplicateConcept;
  /** The sentence the 409 carries and the screens show. */
  message: string;
}

/**
 * Compare a proposed name with everything the organisation already calls
 * something in that vocabulary, and with its pack. Null = no duplicate.
 */
export async function checkDuplicateConcept(
  db: D1Database,
  opts: {
    tenantId: string;
    vocabulary: ConceptVocabulary;
    name: string;
    slug: string;
    /** A rename: the row being renamed. */
    excludeId?: string | null;
  },
  // A create compares the slug as well as the name; a rename does not (the
  // slug is the row's own). Derived, so no route can forget to ask.
): Promise<DuplicateConceptHit | null> {
  const rows = await db
    .prepare(`SELECT id, name, slug, active FROM ${opts.vocabulary} WHERE tenant_id = ?`)
    .bind(opts.tenantId)
    .all<{ id: string; name: string; slug: string; active: number | null }>();
  const packs = await loadTenantPacks(db, opts.tenantId);
  const duplicate = findDuplicateConcept({
    name: opts.name,
    slug: opts.slug,
    excludeId: opts.excludeId ?? null,
    compareSlug: !opts.excludeId,
    rows: (rows.results ?? []).map((r) => ({ id: r.id, name: r.name, slug: r.slug, active: r.active !== 0 })),
    packItems: packConceptItems(packs, opts.vocabulary),
  });
  if (!duplicate) return null;
  return { duplicate, message: describeDuplicateConcept(NOUN[opts.vocabulary], opts.name, duplicate) };
}

/** The 409 every vocabulary route answers a duplicate with. */
export function duplicateConceptResponse(hit: DuplicateConceptHit): Response {
  return new Response(
    JSON.stringify({ error: hit.message, code: 'duplicate_concept', duplicate: hit.duplicate }),
    { status: 409, headers: { 'Content-Type': 'application/json' } },
  );
}

/**
 * SLUGS DO NOT CHANGE (decision C-154). A slug is how a starter-pack update,
 * a supplier packet, the classifier and a saved link find a row; it is set once,
 * at create. A PUT that sends the slug the row already has is fine (an editor
 * that posts every field); any other value is refused, in words.
 */
export function slugChangeRefusal(sent: unknown, current: string): Response | null {
  if (sent === undefined || sent === null) return null;
  if (String(sent) === current) return null;
  return new Response(
    JSON.stringify({
      error:
        `A slug does not change after it is created. This one is "${current}" and stays that: ` +
        'starter-pack updates, supplier packets and saved links find the row by it. Change the name freely.',
      code: 'slug_immutable',
    }),
    { status: 400, headers: { 'Content-Type': 'application/json' } },
  );
}
