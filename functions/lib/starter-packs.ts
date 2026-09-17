/**
 * Applying a starter pack from inside the portal.
 *
 * `bin/lib/starter-packs.mjs` compiles a pack JSON into idempotent SQL for
 * `bin/create-tenant`. That path is a shell script run by us. This one is the
 * setup wizard's screen 1, run by a customer's own admin against their own
 * tenant, and it has to produce THE SAME ROWS — same tables, same deterministic
 * ids, same `INSERT OR IGNORE` posture — or a tenant seeded through the wizard
 * and a tenant seeded from the CLI would diverge on their primary keys and every
 * later re-run would double up.
 *
 * WHY THIS IS A SECOND IMPLEMENTATION RATHER THAN A SHARED ONE. The .mjs is
 * deliberately dependency-free and emits SQL as STRINGS with values inlined
 * through `sqlQuote`, because it feeds `wrangler d1 execute --file`. Nothing
 * inside a Worker should be interpolating values into SQL text when D1 takes
 * bound parameters, so this file binds. `tests/unit/starter-packs.test.ts`
 * asserts the two produce the same ids and the same statement count, which is
 * the property that actually matters; the statement text is not the contract.
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
import { defaultRenewalSettingForTypeName } from '../../shared/renewalPeriod';

/** Same slug rule as `slugify` in bin/lib/starter-packs.mjs and the vocabulary APIs. */
export function slugify(text: string): string {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * The deterministic row id. IDENTICAL to `packRowId` in
 * bin/lib/starter-packs.mjs — that is the whole point: re-running a pack that
 * the CLI already applied must collide on the primary key and do nothing, not
 * insert a duplicate under a fresh UUID.
 */
export function packRowId(prefix: string, tenantSlug: string, slug: string): string {
  return `${prefix}_${slugify(tenantSlug)}_${slug}`;
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

/** One prepared statement plus the section it counts toward. */
interface Tagged {
  section: keyof StarterPackApplyCounts;
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
 * Build the statements a pack contributes for one tenant, in dependency order.
 *
 * Order is load-bearing and mirrors the CLI's: `owner_labels` first (it has no
 * `id`; its key is `(tenant_id, owner_key)` and `document_types.default_owner`
 * only means something once the department exists), then the vocabularies, then
 * every junction that needs two of them to resolve.
 */
export function starterPackStatements(
  db: D1Database,
  pack: StarterPack,
  tenantId: string,
  tenantSlug: string,
): Tagged[] {
  const out: Tagged[] = [];
  const push = (section: keyof StarterPackApplyCounts, stmt: D1PreparedStatement) =>
    out.push({ section, stmt });

  for (const owner of pack.owner_labels) {
    push(
      'owner_labels',
      db
        .prepare(
          `INSERT OR IGNORE INTO owner_labels (tenant_id, owner_key, owner_label)
           VALUES (?, ?, ?)`,
        )
        .bind(tenantId, owner.owner_key, owner.label),
    );
  }

  for (const dt of pack.document_types) {
    // The renewal setting (0096/0097) is NAMED, not left to the column
    // defaults. Omitting it wrote every type as `inherit`/NULL — annual — and
    // the 0096/0097 backfills only ever ran against the rows that existed at
    // migration time, so a tenant seeded afterwards got a Certificate of
    // Analysis proposed an annual renewal. Same helper as POST
    // /api/document-types and as the CLI compiler.
    const renewal = defaultRenewalSettingForTypeName(dt.name);
    push(
      'document_types',
      db
        .prepare(
          `INSERT OR IGNORE INTO document_types
             (id, tenant_id, name, slug, description, default_owner, renewal_policy, renewal_interval_months)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          packRowId('dt', tenantSlug, dt.slug),
          tenantId,
          dt.name,
          dt.slug,
          dt.description,
          dt.owner,
          renewal.policy,
          renewal.interval_months,
        ),
    );
  }

  for (const req of pack.requirements) {
    push(
      'requirements',
      db
        .prepare(
          `INSERT OR IGNORE INTO requirements
             (id, tenant_id, slug, name, description, checklist, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          packRowId('req', tenantSlug, req.slug),
          tenantId,
          req.slug,
          req.name,
          req.description,
          req.checklist,
          req.sort_order,
        ),
    );
  }

  for (const ct of pack.claim_types) {
    push(
      'claim_types',
      db
        .prepare(
          `INSERT OR IGNORE INTO claim_types
             (id, tenant_id, slug, name, description, subject_grain, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          packRowId('clm', tenantSlug, ct.slug),
          tenantId,
          ct.slug,
          ct.name,
          ct.description,
          ct.subject_grain,
          ct.sort_order,
        ),
    );
  }

  for (const rule of pack.claim_rules) {
    const emit = (reqSlug: string, isRequired: number) =>
      push(
        'claim_rules',
        db
          .prepare(
            `INSERT OR IGNORE INTO claim_type_requirements
               (id, tenant_id, claim_type_id, requirement_id, is_required, notes)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            `ctr_${slugify(tenantSlug)}_${rule.claim}__${reqSlug}`,
            tenantId,
            packRowId('clm', tenantSlug, rule.claim),
            packRowId('req', tenantSlug, reqSlug),
            isRequired,
            rule.notes,
          ),
      );
    for (const reqSlug of rule.requires) emit(reqSlug, 1);
    for (const reqSlug of rule.recommends) emit(reqSlug, 0);
  }

  // The default that makes an approved document mean something (0100). After
  // both document_types and requirements, because both FKs must resolve.
  for (const dt of pack.document_types) {
    for (const reqSlug of dt.closes) {
      push(
        'document_type_requirements',
        db
          .prepare(
            `INSERT OR IGNORE INTO document_type_requirements
               (id, tenant_id, document_type_id, requirement_id, source)
             VALUES (?, ?, ?, ?, 'pack')`,
          )
          .bind(
            `dtr_${slugify(tenantSlug)}_${dt.slug}__${reqSlug}`,
            tenantId,
            packRowId('dt', tenantSlug, dt.slug),
            packRowId('req', tenantSlug, reqSlug),
          ),
      );
    }
  }

  // Type-level extraction guidance (0098). INSERT OR IGNORE collides on both
  // the deterministic id and that table's UNIQUE(tenant_id, document_type_id),
  // so guidance somebody has edited is never overwritten by a re-run.
  for (const dt of pack.document_types) {
    if (!dt.extraction_instructions) continue;
    push(
      'extraction_instructions',
      db
        .prepare(
          `INSERT OR IGNORE INTO document_type_extraction_instructions
             (id, tenant_id, document_type_id, instructions)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(
          packRowId('dtei', tenantSlug, dt.slug),
          tenantId,
          packRowId('dt', tenantSlug, dt.slug),
          dt.extraction_instructions,
        ),
    );
  }

  for (const test of pack.spec_tests) {
    push(
      'spec_tests',
      db
        .prepare(
          `INSERT OR IGNORE INTO spec_tests (id, tenant_id, name, aliases, default_unit, notes)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          packRowId('spt', tenantSlug, test.slug),
          tenantId,
          test.name,
          JSON.stringify(test.aliases),
          test.default_unit,
          test.notes,
        ),
    );
  }

  for (const test of pack.spec_tests) {
    const limit = test.limit;
    if (!limit) continue;
    // All three scope columns are written as literal NULLs because "tenant-wide"
    // IS the claim: 0086's expression index COALESCEs them so exactly one
    // default can exist per analyte, and `resolveSpecLimits` scores an all-NULL
    // row as the least specific match — the one that works on day one, before a
    // single supplier or product exists.
    push(
      'spec_limits',
      db
        .prepare(
          `INSERT OR IGNORE INTO spec_limits
             (id, tenant_id, spec_test_id, supplier_id, document_type_id, product_id,
              operator, value_min, value_max, unit, severity, criticality, notes)
           VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          packRowId('spl', tenantSlug, test.slug),
          tenantId,
          packRowId('spt', tenantSlug, test.slug),
          limit.operator,
          limit.value_min,
          limit.value_max,
          limit.unit ?? test.default_unit,
          limit.severity,
          limit.criticality,
          limit.notes,
        ),
    );
  }

  // Both sides of the module decision are written, not only the off ones: a
  // missing row means "whatever the code default is today", and the pack made a
  // DECISION. Recording it means a later change to a module's `defaultEnabled`
  // cannot silently move a tenant whose pack had already answered.
  for (const key of pack.modules.default_on) {
    push(
      'tenant_modules',
      db
        .prepare(`INSERT OR IGNORE INTO tenant_modules (tenant_id, module_key, enabled) VALUES (?, ?, 1)`)
        .bind(tenantId, key),
    );
  }
  for (const key of pack.modules.default_off) {
    push(
      'tenant_modules',
      db
        .prepare(`INSERT OR IGNORE INTO tenant_modules (tenant_id, module_key, enabled) VALUES (?, ?, 0)`)
        .bind(tenantId, key),
    );
  }

  return out;
}

/**
 * Apply a pack to a tenant and report what was actually inserted.
 *
 * Run as one `db.batch()`, which D1 wraps in a transaction: a pack that fails
 * halfway would otherwise leave a tenant with requirements but no document
 * types, and screen 1 would then render as "already seeded" over a half-empty
 * vocabulary.
 */
export async function applyStarterPack(
  db: D1Database,
  pack: StarterPack,
  tenantId: string,
  tenantSlug: string,
): Promise<StarterPackApplyResult> {
  const tagged = starterPackStatements(db, pack, tenantId, tenantSlug);
  if (tagged.length === 0) return { pack: pack.pack, counts: emptyCounts(), inserted: 0 };

  const before = await sectionCensus(db, tenantId);
  await db.batch(tagged.map((t) => t.stmt));
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
