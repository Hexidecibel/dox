/**
 * Applying a starter pack from inside the portal.
 *
 * `bin/lib/starter-packs.mjs` compiles a pack JSON into idempotent SQL for
 * `bin/create-tenant`. That path is a shell script run by us. This one is the
 * setup wizard's screen 1, run by a customer's own admin against their own
 * tenant, and it has to produce THE SAME ROWS.
 *
 * IT IS NO LONGER A SECOND IMPLEMENTATION (migration 0141). Until then this
 * file and the .mjs each wrote out every INSERT by hand, one binding values and
 * one inlining them, with a test pinning that their row ids and statement
 * counts agreed. Both now take their statements from `packApplyStatements` in
 * `shared/packItems.ts` -- written once, with `?` placeholders. This file binds
 * them; the CLI inlines them (`inlineSql`). There is nothing left to drift.
 *
 * WHAT CHANGED ABOUT THE ROWS, and why (decisions C-158..C-161):
 *
 *   a parent is found by `(tenant_id, slug)`, never by a computed id.
 *       A junction row used to name its parents as
 *       `packRowId(prefix, TENANT SLUG, slug)`. INSERT OR IGNORE swallows a
 *       unique conflict and nothing else, so a tenant holding a pack slug
 *       under any other id (a hand-made row, an old seed, or a tenant whose
 *       slug a super admin had changed) ignored the vocabulary insert and then
 *       failed the WHOLE batch on the junction's foreign key. Now the row that
 *       is really there is ADOPTED and everything hangs off it.
 *       `tests/api/starter-pack-adoption.test.ts` failed on every case before.
 *
 *   every item is LEDGERED (`pack_applied_items`), and the organisation's pack
 *   version is stamped (`tenant_packs`).
 *       What the pack wrote is the base of the three-way comparison a later
 *       roll-forward makes (`shared/packRollForward.ts`). A row the pack
 *       ADOPTED is recorded with the columns that were not the pack's marked
 *       "origin unknown", so they are never overwritten on a guess.
 *
 *   an item the ledger already knows is never inserted again.
 *       Re-applying used to put back a junction row a person had deleted.
 *
 * THE PACK DATA IS ALREADY NORMALIZED. `npm run build:packs` runs `normalizePack`
 * before writing `starterPacks.generated.ts`, so slugs, sort orders and
 * `owner_key`s are filled in and validated at build time. This file does not
 * re-validate; a pack that fails validation never reaches the bundle.
 *
 * WHAT IT DELIBERATELY DOES NOT WRITE — the same four as the CLI, for the same
 * reasons, restated because the wizard is where somebody would be tempted:
 *
 *   supplier_requirements   a packet is applied to ONE supplier at a time. The
 *                           live tenant's checklist is uniform-and-wrong because
 *                           six items were bulk-written across 21 suppliers.
 *   owner_routes            a route needs a real recipient. Screen 3 collects
 *                           them from a human; a placeholder route sends an
 *                           alert nowhere WITHOUT reporting a gap.
 *   tenants.extraction_context  a whole-block replacement, not a row — an
 *                           `INSERT OR IGNORE` equivalent does not exist for it.
 *   naming_templates        the table does not exist (created 0014, dropped 0018).
 */

import type { StarterPack } from './starterPacks.generated';
import {
  packApplyStatements,
  packHeldVocabularyQuery,
  packLooksSeeded,
  packVocabularySlugs,
  packRowId as sharedPackRowId,
  packSlugify,
  type PackSection,
  type PackStatement,
} from '../../shared/packItems';

/** Same slug rule as `slugify` in bin/lib/starter-packs.mjs and the vocabulary APIs. */
export function slugify(text: string): string {
  return packSlugify(text);
}

/**
 * The id a pack gives a row IT inserts. It is NOT how a row is found: lookups
 * are by `(tenant_id, slug)`, so a tenant whose slug has changed, or a row a
 * person made under the same slug, resolves all the same.
 */
export function packRowId(prefix: string, tenantSlug: string, slug: string): string {
  return sharedPackRowId(prefix, tenantSlug, slug);
}

/**
 * How many rows each section INSERTED, on this run.
 *
 * NOT `meta.changes`. That was the obvious implementation and it is wrong here:
 * `document_types` carries FTS reindex triggers (migrations 0054 and 0055), so
 * inserting 27 rows reports 246 changes — the trigger's writes are counted too.
 * A number that inflates by an order of magnitude on exactly one section is
 * worse than no number, because it reads as plausible.
 *
 * So the count is a CENSUS: the tenant's rows per table before, and after. It
 * is exact, trigger-proof, and answers the question screen 1 actually asks —
 * "did applying this add anything, or was it all already there".
 *
 * A second application of the same pack therefore reports zeros across the
 * board, which is the honest answer and the one screen 1 shows.
 */
export interface StarterPackApplyCounts {
  owner_labels: number;
  document_types: number;
  requirements: number;
  claim_types: number;
  claim_rules: number;
  document_type_requirements: number;
  extraction_instructions: number;
  spec_tests: number;
  spec_limits: number;
  tenant_modules: number;
}

export interface StarterPackApplyResult {
  pack: string;
  counts: StarterPackApplyCounts;
  /** Sum of the above — "37 rows added" for the summary line. */
  inserted: number;
}

/** One prepared statement plus the section it counts toward ('ledger' = bookkeeping). */
interface Tagged {
  section: PackSection | 'ledger';
  stmt: D1PreparedStatement;
}

/**
 * Which table each section lives in. Every one of them carries `tenant_id`, so
 * the census is one `COUNT(*) WHERE tenant_id = ?` per row of this map.
 *
 * `claim_rules` is the one section whose name is not its table: a pack's rule
 * ("this claim needs these requirements") expands into several
 * `claim_type_requirements` rows, and the count reports the rows, because that
 * is what was written.
 */
const SECTION_TABLES: Record<keyof StarterPackApplyCounts, string> = {
  owner_labels: 'owner_labels',
  document_types: 'document_types',
  requirements: 'requirements',
  claim_types: 'claim_types',
  claim_rules: 'claim_type_requirements',
  document_type_requirements: 'document_type_requirements',
  extraction_instructions: 'document_type_extraction_instructions',
  spec_tests: 'spec_tests',
  spec_limits: 'spec_limits',
  tenant_modules: 'tenant_modules',
};

const SECTION_KEYS = Object.keys(SECTION_TABLES) as Array<keyof StarterPackApplyCounts>;

function emptyCounts(): StarterPackApplyCounts {
  return {
    owner_labels: 0,
    document_types: 0,
    requirements: 0,
    claim_types: 0,
    claim_rules: 0,
    document_type_requirements: 0,
    extraction_instructions: 0,
    spec_tests: 0,
    spec_limits: 0,
    tenant_modules: 0,
  };
}

/**
 * How many rows the tenant currently holds in each pack-writable table.
 *
 * One batch, so it is a single round trip. Not wrapped in the same transaction
 * as the writes on purpose: this is a report, and a report that could roll the
 * seeding back would be a strange thing to own.
 */
export async function sectionCensus(
  db: D1Database,
  tenantId: string,
): Promise<StarterPackApplyCounts> {
  const counts = emptyCounts();
  const results = await db.batch<{ n: number }>(
    SECTION_KEYS.map((key) =>
      db.prepare(`SELECT COUNT(*) AS n FROM ${SECTION_TABLES[key]} WHERE tenant_id = ?`).bind(tenantId),
    ),
  );
  SECTION_KEYS.forEach((key, i) => {
    counts[key] = Number(results[i]?.results?.[0]?.n ?? 0);
  });
  return counts;
}

/**
 * An apply that must not happen, with the reason in words. `status` is the
 * HTTP answer the route gives it.
 */
export class StarterPackApplyRefused extends Error {
  readonly status = 409;
  constructor(
    readonly code: 'roll_forward_required' | 'baseline_required',
    message: string,
    readonly detail: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'StarterPackApplyRefused';
  }
}

/**
 * WHO AN APPLY IS REFUSED FOR. Two organisations, and nobody else:
 *
 *   on ANOTHER VERSION of this pack (`roll_forward_required`). A new version
 *       is previewed and rolled forward; applying it would insert every item it
 *       added with no preview and no conflict check.
 *
 *   SEEDED, AND NEVER RECORDED (`baseline_required`): no `tenant_packs` row,
 *       yet it holds at least half of the pack's document types, requirements
 *       and claim types by slug. It was set up before the ledger existed. An
 *       apply would put back whatever it had deleted on purpose and ledger
 *       every row as though the apply had written it -- the guess
 *       `bin/baseline-pack-ledger` exists to avoid. That script is its way in.
 *
 * An organisation with nothing, or with a few rows of its own that happen to
 * share a pack slug, applies: its rows are adopted.
 */
export async function starterPackApplyRefusal(
  db: D1Database,
  pack: StarterPack,
  tenantId: string,
): Promise<StarterPackApplyRefused | null> {
  const stamp = await db
    .prepare('SELECT MAX(version) AS version FROM tenant_packs WHERE tenant_id = ? AND pack = ?')
    .bind(tenantId, pack.pack)
    .first<{ version: number | null }>();
  const onVersion = stamp?.version === null || stamp?.version === undefined ? null : Number(stamp.version);

  if (onVersion !== null) {
    if (onVersion === pack.version) return null;
    return new StarterPackApplyRefused(
      'roll_forward_required',
      `This organisation is on version ${onVersion} of the ${pack.label} pack, and this is version ${pack.version}. ` +
        'A new version is not applied here: preview it and roll forward on Settings > Starter pack, ' +
        'which shows what would change and keeps what you have changed.',
      { version: onVersion, available_version: pack.version },
    );
  }

  const q = packHeldVocabularyQuery(pack, tenantId);
  const held = Number((await db.prepare(q.sql).bind(...q.params).first<{ held: number }>())?.held ?? 0);
  const total = packVocabularySlugs(pack).total;
  if (!packLooksSeeded(held, total)) return null;
  return new StarterPackApplyRefused(
    'baseline_required',
    `This organisation already holds ${held} of the ${total} document types, requirements and claims of the ${pack.label} pack, ` +
      'and has no record of having taken it: it was set up before pack versions existed. ' +
      'Applying the pack now would put back anything it removed on purpose and record every row as freshly written. ' +
      'Nothing was changed. An operator records what is there first, with bin/baseline-pack-ledger (it changes none of your rows); ' +
      'updates then come through Settings > Starter pack.',
    { held, total },
  );
}

function bindStatement(db: D1Database, statement: PackStatement): Tagged {
  return { section: statement.section, stmt: db.prepare(statement.sql).bind(...statement.params) };
}

/**
 * The statements a pack contributes for one tenant: the version stamp (the
 * gate every other statement requires), every row insert in dependency order
 * (departments, the vocabularies, then every junction that needs two of them),
 * then one ledger entry per item.
 *
 * `appliedBy` is recorded on the ledger; null when nobody is signed in.
 */
export function starterPackStatements(
  db: D1Database,
  pack: StarterPack,
  tenantId: string,
  tenantSlug: string,
  appliedBy: string | null = null,
): Tagged[] {
  const { rows, ledger } = packApplyStatements(pack, { tenantId, tenantSlug, source: 'apply', appliedBy });
  return [...rows, ...ledger].map((s) => bindStatement(db, s));
}

/**
 * Apply a pack to a tenant and report what was actually inserted.
 *
 * TWO TRANSACTIONS, in this order. The ROWS run as one `db.batch()`: a pack
 * that fails halfway would otherwise leave a tenant with requirements but no
 * document types, and screen 1 would then render as "already seeded" over a
 * half-empty vocabulary. The LEDGER runs as a second batch. It is separate
 * because it is separable: if it fails, the organisation is seeded and merely
 * unledgered, and applying again writes it (every row insert is then ignored
 * and every ledger entry lands). One batch of twice the size would have made
 * the seeding itself depend on bookkeeping that only a later version reads.
 */
export async function applyStarterPack(
  db: D1Database,
  pack: StarterPack,
  tenantId: string,
  tenantSlug: string,
  appliedBy: string | null = null,
): Promise<StarterPackApplyResult> {
  // The same two refusals the SQL enforces (for the CLI, which cannot ask
  // first), asked here so a caller gets a REASON instead of "0 rows added".
  const refusal = await starterPackApplyRefusal(db, pack, tenantId);
  if (refusal) throw refusal;

  const { rows, ledger } = packApplyStatements(pack, { tenantId, tenantSlug, source: 'apply', appliedBy });

  const before = await sectionCensus(db, tenantId);
  await db.batch(rows.map((s) => bindStatement(db, s).stmt));
  await db.batch(ledger.map((s) => bindStatement(db, s).stmt));
  const after = await sectionCensus(db, tenantId);

  const counts = emptyCounts();
  let inserted = 0;
  for (const key of SECTION_KEYS) {
    // Clamped at zero: a concurrent delete during the batch would otherwise
    // report a negative "inserted", which is not a thing.
    const delta = Math.max(0, after[key] - before[key]);
    counts[key] = delta;
    inserted += delta;
  }
  return { pack: pack.pack, counts, inserted };
}
