/**
 * What a starter pack WRITES, as data -- and the one SQL compiler both appliers use.
 *
 * Before migration 0141 there were two implementations of "apply a pack": the
 * CLI compiler (`bin/lib/starter-packs.mjs`, SQL text for `wrangler d1 execute
 * --file`) and the in-portal applier (`functions/lib/starter-packs.ts`, bound
 * parameters). A test pinned that they agreed on row ids and statement counts,
 * which is to say it pinned the two things that were easy to compare. This
 * module replaces both bodies: it emits `{ sql, params }` with `?`
 * placeholders, the portal binds them, and the CLI inlines them through
 * `inlineSql`. There is one implementation, so there is nothing to keep in step.
 *
 * `packItems` is the other half: every row a pack writes, as
 * `{ kind, key, fields }`, where `fields` is EXACTLY the column values the
 * pack writes (never an id, never a slug). The ledger (`pack_applied_items`)
 * stores that object, the roll-forward planner (`shared/packRollForward.ts`)
 * compares it three ways, and the version pin
 * (`tests/unit/starterPackVersions.test.ts`) hashes it -- so a change to a
 * name-derived default in code is a pack change too, and cannot ship without a
 * version.
 *
 * THREE RULES THE SQL HOLDS (decisions C-158..C-161):
 *
 *  1. A parent is resolved BY ITS NATURAL KEY, `(tenant_id, slug)` (or
 *     `(tenant_id, name)` for a lab test), never by a computed id. A row a
 *     person made by hand under a pack slug is therefore ADOPTED: the
 *     vocabulary insert is ignored on the unique key and every junction row
 *     hangs off the row that is really there. The old form named parents by
 *     `packRowId(prefix, tenantSlug, slug)` and failed the whole batch on a
 *     foreign key the moment those two disagreed.
 *
 *  2. The tenant SLUG is no longer load-bearing. It still seeds the id of a row
 *     this pack inserts (so existing tenants' ids are unchanged), but nothing
 *     is ever looked up by it, and an id already held by ANOTHER tenant (a
 *     freed slug taken by a new organisation) is replaced by one that carries
 *     the tenant id.
 *
 *  3. An item the ledger already knows is never inserted again. That is what
 *     lets "the tenant deleted it" stay true: re-applying a pack used to put a
 *     hard-deleted junction row straight back. And an organisation on another
 *     VERSION of the pack is not written to at all: a new version reaches it
 *     through the roll-forward, which previews first.
 *
 *  4. A SUPPLIER'S OWN document type (`supplier_id` set) is never the pack's
 *     row, even at the pack's slug. Nothing is hung off it, it is not
 *     ledgered, and a roll-forward reports it to a person instead of writing
 *     to it. The pack's type is organisation-wide.
 *
 * Dependency-free apart from the two name-match helpers, because this file is
 * compiled to `bin/lib/shared/packItems.js` for the CLI
 * (`npm run build:worker-shared`).
 */

import { defaultRenewalSettingForTypeName } from './renewalPeriod';
import { defaultSharingRuleForTypeName } from './sharingRule';

/** Same slug rule as the vocabulary APIs and `bin/lib/starter-packs.mjs`. */
export function packSlugify(text: string): string {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** The id a pack gives a row IT inserts. Never used to look a row up. */
export function packRowId(prefix: string, tenantSlug: string, slug: string): string {
  return `${prefix}_${packSlugify(tenantSlug)}_${slug}`;
}

export type PackValue = string | number | null;

export const PACK_ITEM_KINDS = [
  'owner_label',
  'document_type',
  'requirement',
  'claim_type',
  'claim_rule',
  'type_requirement',
  'extraction_instructions',
  'spec_test',
  'spec_limit',
  'module',
] as const;

export type PackItemKind = (typeof PACK_ITEM_KINDS)[number];

export function isPackItemKind(value: unknown): value is PackItemKind {
  return typeof value === 'string' && (PACK_ITEM_KINDS as readonly string[]).includes(value);
}

/** The section names `applyStarterPack` has always counted by. */
export type PackSection =
  | 'owner_labels'
  | 'document_types'
  | 'requirements'
  | 'claim_types'
  | 'claim_rules'
  | 'document_type_requirements'
  | 'extraction_instructions'
  | 'spec_tests'
  | 'spec_limits'
  | 'tenant_modules';

/** The part of a pack this module reads. Both the normalized pack the CLI holds
 *  and the generated `StarterPack` satisfy it. */
export interface PackLike {
  pack: string;
  version: number;
  document_types: ReadonlyArray<{
    name: string;
    slug: string;
    aliases?: readonly string[];
    description: string | null;
    owner: string | null;
    closes: readonly string[];
    extraction_instructions: string | null;
  }>;
  requirements: ReadonlyArray<{
    name: string;
    slug: string;
    aliases?: readonly string[];
    description: string | null;
    checklist: string | null;
    sort_order: number;
    scope: string;
  }>;
  claim_types: ReadonlyArray<{
    name: string;
    slug: string;
    aliases?: readonly string[];
    description: string | null;
    subject_grain: string;
    sort_order: number;
  }>;
  claim_rules: ReadonlyArray<{
    claim: string;
    requires: readonly string[];
    recommends: readonly string[];
    notes: string | null;
  }>;
  owner_labels: ReadonlyArray<{ label: string; owner_key: string }>;
  spec_tests: ReadonlyArray<{
    name: string;
    slug: string;
    aliases: readonly string[];
    default_unit: string | null;
    notes: string | null;
    limit: {
      operator: string;
      value_min: number | null;
      value_max: number | null;
      unit: string | null;
      severity: string;
      criticality: string;
      notes: string | null;
    } | null;
  }>;
  modules: { default_on: readonly string[]; default_off: readonly string[] };
}

export interface PackItem {
  kind: PackItemKind;
  /** Stable within (pack, kind): a slug, or `parent__child` for a junction. */
  key: string;
  /** What a person reads in a report. */
  label: string;
  /**
   * How the row is found when the ledger does not already name it. The slug
   * for a vocabulary row; the lab test's NAME for a test and its limit (that
   * table has no slug column); equal to `key` otherwise.
   */
  natural: string;
  /** Exactly the column values the pack writes. Column name -> value. */
  fields: Record<string, PackValue>;
  /** Items that must exist as rows before this one can. */
  parents: Array<{ kind: PackItemKind; key: string }>;
  /** Only the kinds that insert a row under a generated id carry these. */
  slug?: string;
  refs?: { document_type?: string; requirement?: string; claim_type?: string; spec_test?: string };
}

interface KindSpec {
  section: PackSection;
  table: string;
  /** What a person calls one of these. */
  noun: string;
  /** Column holding the row's identity for an UPDATE, beside tenant_id. */
  idColumn: string;
  /** Soft-delete column, when the table has one. */
  activeColumn: string | null;
  hasUpdatedAt: boolean;
  hasUpdatedBy: boolean;
  /**
   * Columns that are ONE setting. A member is only rolled forward when every
   * member may be: a limit's operator must not move without its bound, and a
   * renewal policy must not move without its months.
   */
  groups: string[][];
  /** All of a tenant's rows of this kind, keyed the way `PackItem.natural` is. */
  readSql: string;
}

export const PACK_KIND_SPECS: Record<PackItemKind, KindSpec> = {
  owner_label: {
    section: 'owner_labels',
    table: 'owner_labels',
    noun: 'department',
    idColumn: 'owner_key',
    activeColumn: 'active',
    hasUpdatedAt: true,
    hasUpdatedBy: false,
    groups: [],
    readSql: `SELECT owner_key AS natural_key, owner_key AS row_id, active AS active, owner_label
                FROM owner_labels WHERE tenant_id = ?`,
  },
  document_type: {
    section: 'document_types',
    table: 'document_types',
    noun: 'document type',
    idColumn: 'id',
    activeColumn: 'active',
    hasUpdatedAt: true,
    hasUpdatedBy: false,
    groups: [['renewal_policy', 'renewal_interval_months', 'renewal_window']],
    // `supplier_id` is read so a supplier's OWN type at a pack slug can be told
    // from the pack's organisation-wide one: it is reported, never adopted.
    readSql: `SELECT slug AS natural_key, id AS row_id, active AS active, supplier_id, name, description, default_owner,
                     renewal_policy, renewal_interval_months, renewal_window, sharing_rule
                FROM document_types WHERE tenant_id = ?`,
  },
  requirement: {
    section: 'requirements',
    table: 'requirements',
    noun: 'requirement',
    idColumn: 'id',
    activeColumn: 'active',
    hasUpdatedAt: true,
    hasUpdatedBy: false,
    groups: [],
    readSql: `SELECT slug AS natural_key, id AS row_id, active AS active, name, description, checklist,
                     sort_order, scope
                FROM requirements WHERE tenant_id = ?`,
  },
  claim_type: {
    section: 'claim_types',
    table: 'claim_types',
    noun: 'claim',
    idColumn: 'id',
    activeColumn: 'active',
    hasUpdatedAt: true,
    hasUpdatedBy: false,
    groups: [],
    readSql: `SELECT slug AS natural_key, id AS row_id, active AS active, name, description, subject_grain,
                     sort_order
                FROM claim_types WHERE tenant_id = ?`,
  },
  claim_rule: {
    section: 'claim_rules',
    table: 'claim_type_requirements',
    noun: 'claim rule',
    idColumn: 'id',
    activeColumn: null,
    hasUpdatedAt: false,
    hasUpdatedBy: false,
    groups: [],
    readSql: `SELECT ct.slug || '__' || r.slug AS natural_key, j.id AS row_id, 1 AS active, j.is_required, j.notes
                FROM claim_type_requirements j
                JOIN claim_types ct ON ct.id = j.claim_type_id
                JOIN requirements r ON r.id = j.requirement_id
               WHERE j.tenant_id = ?`,
  },
  type_requirement: {
    section: 'document_type_requirements',
    table: 'document_type_requirements',
    noun: 'type to requirement default',
    idColumn: 'id',
    activeColumn: null,
    hasUpdatedAt: false,
    hasUpdatedBy: false,
    groups: [],
    readSql: `SELECT dt.slug || '__' || r.slug AS natural_key, j.id AS row_id, 1 AS active
                FROM document_type_requirements j
                JOIN document_types dt ON dt.id = j.document_type_id
                JOIN requirements r ON r.id = j.requirement_id
               WHERE j.tenant_id = ? AND dt.supplier_id IS NULL`,
  },
  extraction_instructions: {
    section: 'extraction_instructions',
    table: 'document_type_extraction_instructions',
    noun: 'reading instructions',
    idColumn: 'id',
    activeColumn: null,
    hasUpdatedAt: true,
    hasUpdatedBy: true,
    groups: [],
    readSql: `SELECT dt.slug AS natural_key, e.id AS row_id, 1 AS active, e.instructions
                FROM document_type_extraction_instructions e
                JOIN document_types dt ON dt.id = e.document_type_id
               WHERE e.tenant_id = ? AND dt.supplier_id IS NULL`,
  },
  spec_test: {
    section: 'spec_tests',
    table: 'spec_tests',
    noun: 'lab test',
    idColumn: 'id',
    activeColumn: null,
    hasUpdatedAt: true,
    hasUpdatedBy: true,
    groups: [],
    readSql: `SELECT name AS natural_key, id AS row_id, 1 AS active, name, aliases, default_unit, notes
                FROM spec_tests WHERE tenant_id = ?`,
  },
  spec_limit: {
    section: 'spec_limits',
    table: 'spec_limits',
    noun: 'acceptance limit',
    idColumn: 'id',
    activeColumn: 'active',
    hasUpdatedAt: true,
    hasUpdatedBy: true,
    // The four columns `limitThresholdChanged` reads: one threshold.
    groups: [['operator', 'value_min', 'value_max', 'unit']],
    readSql: `SELECT t.name AS natural_key, l.id AS row_id, l.active AS active, l.operator, l.value_min,
                     l.value_max, l.unit, l.severity, l.criticality, l.notes, l.version
                FROM spec_limits l
                JOIN spec_tests t ON t.id = l.spec_test_id
               WHERE l.tenant_id = ?
                 AND l.supplier_id IS NULL AND l.document_type_id IS NULL AND l.product_id IS NULL`,
  },
  module: {
    section: 'tenant_modules',
    table: 'tenant_modules',
    noun: 'module',
    idColumn: 'module_key',
    activeColumn: null,
    hasUpdatedAt: true,
    hasUpdatedBy: true,
    groups: [],
    readSql: `SELECT module_key AS natural_key, module_key AS row_id, 1 AS active, enabled
                FROM tenant_modules WHERE tenant_id = ?`,
  },
};

/**
 * Every row the pack writes, in dependency order: departments, the three
 * vocabularies, then everything that needs two of them to resolve.
 */
export function packItems(pack: PackLike): PackItem[] {
  const out: PackItem[] = [];

  for (const owner of pack.owner_labels) {
    out.push({
      kind: 'owner_label',
      key: owner.owner_key,
      natural: owner.owner_key,
      label: owner.label,
      fields: { owner_label: owner.label },
      parents: [],
    });
  }

  for (const dt of pack.document_types) {
    // The renewal setting (0096/0097/0125) and the sharing rule (0137) are
    // NAMED, not left to the column defaults, and come from the same helpers
    // POST /api/document-types uses. They are part of what the pack wrote: a
    // later pack version, or a change to either helper, rolls forward through
    // the same three-way comparison as a description.
    const renewal = defaultRenewalSettingForTypeName(dt.name);
    out.push({
      kind: 'document_type',
      key: dt.slug,
      natural: dt.slug,
      slug: dt.slug,
      label: dt.name,
      fields: {
        name: dt.name,
        description: dt.description,
        default_owner: dt.owner,
        renewal_policy: renewal.policy,
        renewal_interval_months: renewal.interval_months,
        renewal_window: renewal.window === null ? null : JSON.stringify(renewal.window),
        sharing_rule: defaultSharingRuleForTypeName(dt.name),
      },
      parents: [],
    });
  }

  for (const req of pack.requirements) {
    out.push({
      kind: 'requirement',
      key: req.slug,
      natural: req.slug,
      slug: req.slug,
      label: req.name,
      fields: {
        name: req.name,
        description: req.description,
        checklist: req.checklist,
        sort_order: req.sort_order,
        scope: req.scope,
      },
      parents: [],
    });
  }

  for (const ct of pack.claim_types) {
    out.push({
      kind: 'claim_type',
      key: ct.slug,
      natural: ct.slug,
      slug: ct.slug,
      label: ct.name,
      fields: {
        name: ct.name,
        description: ct.description,
        subject_grain: ct.subject_grain,
        sort_order: ct.sort_order,
      },
      parents: [],
    });
  }

  const claimName = new Map(pack.claim_types.map((c) => [c.slug, c.name]));
  const reqName = new Map(pack.requirements.map((r) => [r.slug, r.name]));

  for (const rule of pack.claim_rules) {
    const emit = (reqSlug: string, isRequired: number) => {
      const key = `${rule.claim}__${reqSlug}`;
      out.push({
        kind: 'claim_rule',
        key,
        natural: key,
        label: `${claimName.get(rule.claim) ?? rule.claim} ${isRequired ? 'requires' : 'recommends'} ${reqName.get(reqSlug) ?? reqSlug}`,
        fields: { is_required: isRequired, notes: rule.notes },
        parents: [
          { kind: 'claim_type', key: rule.claim },
          { kind: 'requirement', key: reqSlug },
        ],
        refs: { claim_type: rule.claim, requirement: reqSlug },
      });
    };
    for (const reqSlug of rule.requires) emit(reqSlug, 1);
    for (const reqSlug of rule.recommends) emit(reqSlug, 0);
  }

  for (const dt of pack.document_types) {
    for (const reqSlug of dt.closes) {
      const key = `${dt.slug}__${reqSlug}`;
      out.push({
        kind: 'type_requirement',
        key,
        natural: key,
        label: `${dt.name} closes ${reqName.get(reqSlug) ?? reqSlug}`,
        fields: {},
        parents: [
          { kind: 'document_type', key: dt.slug },
          { kind: 'requirement', key: reqSlug },
        ],
        refs: { document_type: dt.slug, requirement: reqSlug },
      });
    }
  }

  for (const dt of pack.document_types) {
    if (!dt.extraction_instructions) continue;
    out.push({
      kind: 'extraction_instructions',
      key: dt.slug,
      natural: dt.slug,
      label: `Reading instructions for ${dt.name}`,
      fields: { instructions: dt.extraction_instructions },
      parents: [{ kind: 'document_type', key: dt.slug }],
      refs: { document_type: dt.slug },
    });
  }

  for (const test of pack.spec_tests) {
    out.push({
      kind: 'spec_test',
      key: test.slug,
      natural: test.name,
      slug: test.slug,
      label: test.name,
      fields: {
        name: test.name,
        aliases: JSON.stringify(test.aliases),
        default_unit: test.default_unit,
        notes: test.notes,
      },
      parents: [],
    });
  }

  for (const test of pack.spec_tests) {
    const limit = test.limit;
    if (!limit) continue;
    out.push({
      kind: 'spec_limit',
      key: test.slug,
      natural: test.name,
      slug: test.slug,
      label: `Limit for ${test.name}`,
      fields: {
        operator: limit.operator,
        value_min: limit.value_min,
        value_max: limit.value_max,
        unit: limit.unit ?? test.default_unit,
        severity: limit.severity,
        criticality: limit.criticality,
        notes: limit.notes,
      },
      parents: [{ kind: 'spec_test', key: test.slug }],
      refs: { spec_test: test.name },
    });
  }

  // Both sides of the module decision are written, not only the off ones: a
  // missing row means "whatever the code default is today", and the pack made a
  // DECISION.
  for (const key of pack.modules.default_on) {
    out.push({ kind: 'module', key, natural: key, label: key, fields: { enabled: 1 }, parents: [] });
  }
  for (const key of pack.modules.default_off) {
    out.push({ kind: 'module', key, natural: key, label: key, fields: { enabled: 0 }, parents: [] });
  }

  return out;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

export interface PackStatement {
  /** The section a ROW statement counts toward; 'ledger' for bookkeeping. */
  section: PackSection | 'ledger';
  sql: string;
  params: PackValue[];
}

export interface PackApplyContext {
  tenantId: string;
  tenantSlug: string;
  /** 'apply' (the portal), 'cli' (bin/create-tenant), 'roll_forward'. */
  source: string;
  appliedBy: string | null;
}

/** Accumulates SQL text and its parameters in the order they are written. */
class Sql {
  text = '';
  params: PackValue[] = [];
  add(text: string, ...params: PackValue[]): this {
    this.text += text;
    this.params.push(...params);
    return this;
  }
  /** `?, ?, ?` for a list of values. */
  values(values: PackValue[]): this {
    this.text += values.map(() => '?').join(', ');
    this.params.push(...values);
    return this;
  }
}

const ID_PREFIX: Partial<Record<PackItemKind, string>> = {
  document_type: 'dt',
  requirement: 'req',
  claim_type: 'clm',
  claim_rule: 'ctr',
  type_requirement: 'dtr',
  extraction_instructions: 'dtei',
  spec_test: 'spt',
  spec_limit: 'spl',
};

/** The id this pack would give the item's row. Null for the two keyed tables. */
export function packItemRowId(item: PackItem, tenantSlug: string): string | null {
  const prefix = ID_PREFIX[item.kind];
  if (!prefix) return null;
  return packRowId(prefix, tenantSlug, item.kind === 'spec_test' || item.kind === 'spec_limit' ? item.slug! : item.key);
}

/**
 * The id expression for an insert: the deterministic id, unless a row of
 * ANOTHER tenant already holds it. Ids are global primary keys and the
 * deterministic one is built from the tenant slug, which can be changed and
 * then taken by somebody else; without this the second holder's insert is
 * silently ignored and it ends up with no vocabulary at all.
 */
function idExpr(q: Sql, table: string, id: string, tenantId: string): void {
  q.add(
    `CASE WHEN EXISTS (SELECT 1 FROM ${table} WHERE id = ? AND tenant_id <> ?) THEN ? ELSE ? END`,
    id,
    tenantId,
    `${id}~${tenantId}`,
    id,
  );
}

/**
 * True when the organisation is ON RECORD as being on exactly this version of
 * the pack. `tenant_packs` is append-only history, so "the version it is on" is
 * the HIGHEST row, not any row. No row at all is NULL = ?, which is not true:
 * an apply writes nothing for an organisation with no stamp, and the stamp
 * (`packTenantStamp`, the FIRST statement of an apply) is only ever given to an
 * organisation that is not already seeded. Parameters: tenant, pack, version.
 */
const SAME_VERSION = `(SELECT MAX(version) FROM tenant_packs WHERE tenant_id = ? AND pack = ?) = ?`;

/**
 * The two things that stop an APPLY from writing:
 *
 *   the ledger already knows this item (rule 3), or
 *   the organisation is not on record as being on THIS VERSION of this pack.
 *
 * The second covers two organisations. One is on another version: without the
 * guard, applying v2 over a v1 organisation would quietly insert every item v2
 * added -- no preview, no conflict check -- and leave the version saying 1. The
 * other has the pack's rows and no record at all (seeded before the ledger
 * existed): it never gets a stamp from an apply (see `packTenantStamp`), so
 * nothing here writes for it, and what it deleted on purpose is not put back.
 */
function ledgerGuard(q: Sql, pack: string, version: number, item: PackItem, tenantId: string): void {
  q.add(
    `NOT EXISTS (SELECT 1 FROM pack_applied_items WHERE tenant_id = ? AND pack = ? AND kind = ? AND item_key = ?)` +
      ` AND ` +
      SAME_VERSION,
    tenantId,
    pack,
    item.kind,
    item.key,
    tenantId,
    pack,
    version,
  );
}

/**
 * The statement that INSERTS the item's row when nothing holds its natural
 * key. `guardVersion` (the pack version being applied) adds the two apply
 * guards -- never insert what the ledger already knows, and write nothing for
 * an organisation on another version; the roll-forward executor passes null
 * because it has already decided.
 */
export function packRowInsert(
  packName: string,
  item: PackItem,
  ctx: PackApplyContext,
  guardVersion: number | null,
): PackStatement {
  const spec = PACK_KIND_SPECS[item.kind];
  const q = new Sql();
  const t = ctx.tenantId;
  const f = item.fields;
  const id = packItemRowId(item, ctx.tenantSlug);
  const guard = (lead: string) => {
    if (guardVersion === null) return;
    q.add(lead);
    ledgerGuard(q, packName, guardVersion, item, t);
  };

  switch (item.kind) {
    case 'owner_label':
      q.add(`INSERT OR IGNORE INTO owner_labels (tenant_id, owner_key, owner_label) SELECT ?, ?, ?`, t, item.key, f.owner_label);
      guard(' WHERE ');
      break;

    case 'document_type':
      q.add(
        `INSERT OR IGNORE INTO document_types (id, tenant_id, name, slug, description, default_owner, renewal_policy, renewal_interval_months, renewal_window, sharing_rule) SELECT `,
      );
      idExpr(q, spec.table, id!, t);
      q.add(', ').values([
        t,
        f.name,
        item.slug!,
        f.description,
        f.default_owner,
        f.renewal_policy,
        f.renewal_interval_months,
        f.renewal_window,
        f.sharing_rule,
      ]);
      guard(' WHERE ');
      break;

    case 'requirement':
      q.add(`INSERT OR IGNORE INTO requirements (id, tenant_id, slug, name, description, checklist, sort_order, scope) SELECT `);
      idExpr(q, spec.table, id!, t);
      q.add(', ').values([t, item.slug!, f.name, f.description, f.checklist, f.sort_order, f.scope]);
      guard(' WHERE ');
      break;

    case 'claim_type':
      q.add(`INSERT OR IGNORE INTO claim_types (id, tenant_id, slug, name, description, subject_grain, sort_order) SELECT `);
      idExpr(q, spec.table, id!, t);
      q.add(', ').values([t, item.slug!, f.name, f.description, f.subject_grain, f.sort_order]);
      guard(' WHERE ');
      break;

    case 'claim_rule':
      q.add(`INSERT OR IGNORE INTO claim_type_requirements (id, tenant_id, claim_type_id, requirement_id, is_required, notes) SELECT `);
      idExpr(q, spec.table, id!, t);
      q.add(
        `, ?, ct.id, r.id, ?, ? FROM claim_types ct JOIN requirements r ON r.tenant_id = ct.tenant_id WHERE ct.tenant_id = ? AND ct.slug = ? AND r.slug = ?`,
        t,
        f.is_required,
        f.notes,
        t,
        item.refs!.claim_type!,
        item.refs!.requirement!,
      );
      guard(' AND ');
      break;

    case 'type_requirement':
      q.add(`INSERT OR IGNORE INTO document_type_requirements (id, tenant_id, document_type_id, requirement_id, source) SELECT `);
      idExpr(q, spec.table, id!, t);
      q.add(
        `, ?, dt.id, r.id, 'pack' FROM document_types dt JOIN requirements r ON r.tenant_id = dt.tenant_id WHERE dt.tenant_id = ? AND dt.supplier_id IS NULL AND dt.slug = ? AND r.slug = ?`,
        t,
        t,
        item.refs!.document_type!,
        item.refs!.requirement!,
      );
      guard(' AND ');
      break;

    case 'extraction_instructions':
      q.add(`INSERT OR IGNORE INTO document_type_extraction_instructions (id, tenant_id, document_type_id, instructions) SELECT `);
      idExpr(q, spec.table, id!, t);
      q.add(
        `, ?, dt.id, ? FROM document_types dt WHERE dt.tenant_id = ? AND dt.supplier_id IS NULL AND dt.slug = ?`,
        t,
        f.instructions,
        t,
        item.refs!.document_type!,
      );
      guard(' AND ');
      break;

    case 'spec_test':
      q.add(`INSERT OR IGNORE INTO spec_tests (id, tenant_id, name, aliases, default_unit, notes) SELECT `);
      idExpr(q, spec.table, id!, t);
      q.add(', ').values([t, f.name, f.aliases, f.default_unit, f.notes]);
      guard(' WHERE ');
      break;

    case 'spec_limit':
      // All three scope columns are literal NULLs because "tenant-wide" IS the
      // claim: 0086's expression index COALESCEs them so exactly one default
      // can exist per analyte.
      q.add(
        `INSERT OR IGNORE INTO spec_limits (id, tenant_id, spec_test_id, supplier_id, document_type_id, product_id, operator, value_min, value_max, unit, severity, criticality, notes) SELECT `,
      );
      idExpr(q, spec.table, id!, t);
      q.add(
        `, ?, st.id, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ? FROM spec_tests st WHERE st.tenant_id = ? AND st.name = ?`,
        t,
        f.operator,
        f.value_min,
        f.value_max,
        f.unit,
        f.severity,
        f.criticality,
        f.notes,
        t,
        item.refs!.spec_test!,
      );
      guard(' AND ');
      break;

    case 'module':
      q.add(`INSERT OR IGNORE INTO tenant_modules (tenant_id, module_key, enabled) SELECT ?, ?, ?`, t, item.key, f.enabled);
      guard(' WHERE ');
      break;
  }

  return { section: spec.section, sql: q.text, params: q.params };
}

/** `FROM ... WHERE ...` selecting the item's row as alias `x`, by natural key. */
function rowLocator(q: Sql, item: PackItem, tenantId: string): void {
  switch (item.kind) {
    case 'owner_label':
      q.add(`FROM owner_labels x WHERE x.tenant_id = ? AND x.owner_key = ?`, tenantId, item.key);
      break;
    case 'document_type':
      // A supplier's own type holding the slug is not the pack's row (rule 4).
      q.add(`FROM document_types x WHERE x.tenant_id = ? AND x.supplier_id IS NULL AND x.slug = ?`, tenantId, item.slug!);
      break;
    case 'requirement':
    case 'claim_type':
      q.add(`FROM ${PACK_KIND_SPECS[item.kind].table} x WHERE x.tenant_id = ? AND x.slug = ?`, tenantId, item.slug!);
      break;
    case 'claim_rule':
      q.add(
        `FROM claim_type_requirements x JOIN claim_types ct ON ct.id = x.claim_type_id JOIN requirements r ON r.id = x.requirement_id WHERE x.tenant_id = ? AND ct.slug = ? AND r.slug = ?`,
        tenantId,
        item.refs!.claim_type!,
        item.refs!.requirement!,
      );
      break;
    case 'type_requirement':
      q.add(
        `FROM document_type_requirements x JOIN document_types dt ON dt.id = x.document_type_id JOIN requirements r ON r.id = x.requirement_id WHERE x.tenant_id = ? AND dt.supplier_id IS NULL AND dt.slug = ? AND r.slug = ?`,
        tenantId,
        item.refs!.document_type!,
        item.refs!.requirement!,
      );
      break;
    case 'extraction_instructions':
      q.add(
        `FROM document_type_extraction_instructions x JOIN document_types dt ON dt.id = x.document_type_id WHERE x.tenant_id = ? AND dt.supplier_id IS NULL AND dt.slug = ?`,
        tenantId,
        item.refs!.document_type!,
      );
      break;
    case 'spec_test':
      q.add(`FROM spec_tests x WHERE x.tenant_id = ? AND x.name = ?`, tenantId, item.natural);
      break;
    case 'spec_limit':
      q.add(
        `FROM spec_limits x JOIN spec_tests st ON st.id = x.spec_test_id WHERE x.tenant_id = ? AND st.name = ? AND x.supplier_id IS NULL AND x.document_type_id IS NULL AND x.product_id IS NULL`,
        tenantId,
        item.natural,
      );
      break;
    case 'module':
      q.add(`FROM tenant_modules x WHERE x.tenant_id = ? AND x.module_key = ?`, tenantId, item.key);
      break;
  }
}

/** Why a column of a ledgered row does not hold the pack's value. */
export type PackDifferenceOrigin =
  /** It differed when the row was first ledgered: nobody knows who wrote it. */
  | 'unknown'
  /** The pack wrote it and the organisation changed it afterwards. */
  | 'edited';

/**
 * The statement that LEDGERS the item's row, whoever wrote it.
 *
 * `written` is always the pack's own values at this version. `differing` names
 * the columns where the row did not hold them at that moment, each marked
 * 'unknown' -- an adopted row is never assumed to have been pack-written, so
 * a later version will not overwrite those columns on a guess. Computed IN
 * SQL, against the row as it stands after the insert above, so the CLI (which
 * cannot read before it writes) records exactly what the portal does.
 *
 * INSERT OR IGNORE: an item already in the ledger keeps its entry. `guarded`
 * (an apply) also writes nothing for an organisation on another version of
 * the pack, for the same reason the row insert does not.
 */
export function packLedgerAdopt(
  packName: string,
  packVersion: number,
  item: PackItem,
  ctx: PackApplyContext,
  guarded = false,
): PackStatement {
  const spec = PACK_KIND_SPECS[item.kind];
  const q = new Sql();
  const fieldNames = Object.keys(item.fields);
  q.add(
    `INSERT OR IGNORE INTO pack_applied_items (tenant_id, pack, kind, item_key, row_id, pack_version, written, differing, state, source, applied_by) SELECT ?, ?, ?, ?, y.row_id, ?, ?, y.differing, CASE WHEN y.differing = '{}' THEN 'pack' ELSE 'differs' END, ?, ? FROM (SELECT x.${spec.idColumn} AS row_id, `,
    ctx.tenantId,
    packName,
    item.kind,
    item.key,
    packVersion,
    JSON.stringify(item.fields),
    ctx.source,
    ctx.appliedBy,
  );
  if (fieldNames.length === 0) {
    q.add(`'{}'`);
  } else {
    q.add(`'{' || rtrim(`);
    fieldNames.forEach((name, i) => {
      if (i > 0) q.add(' || ');
      // IS NOT is the null-safe comparison: NULL IS NOT NULL is false.
      q.add(`CASE WHEN x.${name} IS NOT ? THEN '"${name}":"unknown",' ELSE '' END`, item.fields[name]);
    });
    q.add(`, ',') || '}'`);
  }
  q.add(` AS differing `);
  rowLocator(q, item, ctx.tenantId);
  q.add(`) y`);
  if (guarded) {
    q.add(` WHERE ${SAME_VERSION}`, ctx.tenantId, packName, packVersion);
  }
  return { section: 'ledger', sql: q.text, params: q.params };
}

/** The slugs an organisation is recognised as "seeded from this pack" by. */
export function packVocabularySlugs(pack: PackLike): {
  document_types: string[];
  requirements: string[];
  claim_types: string[];
  total: number;
} {
  const document_types = pack.document_types.map((d) => d.slug);
  const requirements = pack.requirements.map((r) => r.slug);
  const claim_types = pack.claim_types.map((c) => c.slug);
  return { document_types, requirements, claim_types, total: document_types.length + requirements.length + claim_types.length };
}

/**
 * How many of the pack's document types, requirements and claim types the
 * organisation holds BY SLUG. One scalar subquery, three parameters per
 * vocabulary (the slugs travel as ONE JSON array each, so a large pack cannot
 * run into D1's bound-parameter limit). A supplier's own document type does not
 * count: it is not the pack's row.
 */
function heldVocabulary(q: Sql, pack: PackLike, tenantId: string): void {
  const v = packVocabularySlugs(pack);
  q.add(
    `((SELECT COUNT(*) FROM document_types WHERE tenant_id = ? AND supplier_id IS NULL AND slug IN (SELECT value FROM json_each(?)))` +
      ` + (SELECT COUNT(*) FROM requirements WHERE tenant_id = ? AND slug IN (SELECT value FROM json_each(?)))` +
      ` + (SELECT COUNT(*) FROM claim_types WHERE tenant_id = ? AND slug IN (SELECT value FROM json_each(?))))`,
    tenantId,
    JSON.stringify(v.document_types),
    tenantId,
    JSON.stringify(v.requirements),
    tenantId,
    JSON.stringify(v.claim_types),
  );
}

/**
 * EVIDENCE OF AN EARLIER SEEDING, whatever fraction of the pack is left. A SQL
 * boolean, true when the organisation has NO pack record of any kind and
 *
 *   holds a row AT ONE OF THIS PACK'S KEYS WHOSE ID HAS THE SHAPE A PACK GIVES
 *   the rows it inserts (`dt_...`, `req_...`, `clm_...`, `spt_...`): a row a
 *   person makes through the portal has a random hex id, never one of these; or
 *
 *   has a setup run that RECORDED APPLYING this pack (`applied.pack.name`). A
 *   run that merely chose a pack and has not applied it is not evidence.
 *
 * The 50% bar alone (`packLooksSeeded`) let the MOST diverged legacy
 * organisation through: one that had deleted every requirement and claim type
 * still held the pack's document types, under half the vocabulary, and an apply
 * re-seeded it. The id shape does not care how much is left.
 *
 * "No pack record of any kind" because two packs can share a slug (both ship a
 * W-9): an organisation on one pack, taking a second, holds a pack-shaped id at
 * a slug the second also uses, and that is not evidence about the second.
 */
function seedEvidence(q: Sql, pack: PackLike, tenantId: string): void {
  const v = packVocabularySlugs(pack);
  const like = (table: string, prefix: string, column: string, values: string[]) =>
    q.add(
      `EXISTS (SELECT 1 FROM ${table} WHERE tenant_id = ? AND id LIKE '${prefix}\\_%' ESCAPE '\\' AND ${column} IN (SELECT value FROM json_each(?)))`,
      tenantId,
      JSON.stringify(values),
    );
  q.add(`((NOT EXISTS (SELECT 1 FROM tenant_packs WHERE tenant_id = ?) AND (`, tenantId);
  like('document_types', 'dt', 'slug', v.document_types);
  q.add(' OR ');
  like('requirements', 'req', 'slug', v.requirements);
  q.add(' OR ');
  like('claim_types', 'clm', 'slug', v.claim_types);
  q.add(' OR ');
  like('spec_tests', 'spt', 'name', pack.spec_tests.map((t) => t.name));
  q.add(
    `)) OR EXISTS (SELECT 1 FROM tenant_setup_runs WHERE tenant_id = ? AND json_extract(applied, '$.pack.name') = ?))`,
    tenantId,
    pack.pack,
  );
}

/** The id prefixes `seedEvidence` reads, for the baseline's JavaScript twin. */
export const PACK_ROW_ID_PREFIXES: Partial<Record<PackItemKind, string>> = {
  document_type: 'dt_',
  requirement: 'req_',
  claim_type: 'clm_',
  spec_test: 'spt_',
};

/** `SELECT <held> AS held, <evidence> AS seeded` -- for the callers that explain a refusal in words. */
export function packHeldVocabularyQuery(pack: PackLike, tenantId: string): { sql: string; params: PackValue[] } {
  const q = new Sql();
  q.add('SELECT ');
  heldVocabulary(q, pack, tenantId);
  q.add(' AS held, ');
  seedEvidence(q, pack, tenantId);
  q.add(' AS seeded');
  return { sql: q.text, params: q.params };
}

/**
 * Is an organisation with NO stamp already seeded from this pack? Yes when it
 * holds at least half of the pack's vocabulary by slug -- the same bar
 * `bin/baseline-pack-ledger` uses to infer a pack. Below it, the organisation
 * has a few rows of its own that happen to share a slug, and those are adopted.
 */
export function packLooksSeeded(held: number, total: number): boolean {
  return total > 0 && held * 2 >= total;
}

/**
 * THE GATE. Records which pack and version an organisation is on -- the first
 * time only, and ONLY FOR AN ORGANISATION THAT IS NOT ALREADY SEEDED.
 *
 * It is the first statement of an apply and every other statement requires it
 * (`SAME_VERSION`). So an organisation that holds the pack's rows and has no
 * record -- one seeded before migration 0141 and never baselined -- gets no
 * stamp, and therefore NOTHING: no row, no ledger entry. "Holds the pack's
 * rows" is two tests, either of which is enough: at least half the vocabulary
 * by slug (`packLooksSeeded`), or ANY evidence of an earlier seeding however
 * little is left (`seedEvidence`). Without this, applying
 * to such an organisation re-inserted what it had deleted on purpose and
 * ledgered every row as if the apply had just written it, which is exactly the
 * guess a baseline exists to avoid. `bin/baseline-pack-ledger` is its way in.
 *
 * A later roll-forward appends its own row; a re-apply does not, so applying a
 * newer build of the portal to an organisation never claims it rolled forward.
 */
export function packTenantStamp(pack: PackLike, ctx: PackApplyContext): PackStatement {
  const q = new Sql();
  q.add(
    `INSERT OR IGNORE INTO tenant_packs (id, tenant_id, pack, version, from_version, source, applied_by) ` +
      `SELECT lower(hex(randomblob(16))), ?, ?, ?, NULL, ?, ? ` +
      `WHERE NOT EXISTS (SELECT 1 FROM tenant_packs WHERE tenant_id = ? AND pack = ?) AND `,
    ctx.tenantId,
    pack.pack,
    pack.version,
    ctx.source,
    ctx.appliedBy,
    ctx.tenantId,
    pack.pack,
  );
  heldVocabulary(q, pack, ctx.tenantId);
  // Integer form of `packLooksSeeded`: stamped only while held * 2 < total --
  // and only with no evidence at all of an earlier seeding.
  q.add(` * 2 < ? AND NOT `, Math.max(packVocabularySlugs(pack).total, 1));
  seedEvidence(q, pack, ctx.tenantId);
  return { section: 'ledger', sql: q.text, params: q.params };
}

/**
 * Everything applying a pack runs, in order: THE STAMP (the gate above), every
 * row insert (dependency order), then every ledger entry.
 *
 * The two halves are separate so a caller may run them as two transactions:
 * the rows are what the organisation needs, the ledger is what a LATER version
 * needs, and a ledger that failed is repaired by applying again (the row
 * inserts are then all ignored and the ledger entries all written). The stamp
 * travels with the rows: if they fail it rolls back with them.
 */
export function packApplyStatements(
  pack: PackLike,
  ctx: PackApplyContext,
): { rows: PackStatement[]; ledger: PackStatement[] } {
  const items = packItems(pack);
  return {
    rows: [packTenantStamp(pack, ctx), ...items.map((item) => packRowInsert(pack.pack, item, ctx, pack.version))],
    ledger: items.map((item) => packLedgerAdopt(pack.pack, pack.version, item, ctx, true)),
  };
}

/** SQLite literal for one value. */
export function sqlLiteral(value: PackValue): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Not a finite number: ${value}`);
    return String(value);
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * A statement as SQL text, for `wrangler d1 execute --file`. Every `?` in the
 * SQL this module writes is a placeholder (no literal contains one), so they
 * are replaced in order.
 */
export function inlineSql(statement: PackStatement): string {
  const parts = statement.sql.split('?');
  if (parts.length - 1 !== statement.params.length) {
    throw new Error(`Placeholder count (${parts.length - 1}) does not match parameter count (${statement.params.length})`);
  }
  let out = parts[0];
  for (let i = 0; i < statement.params.length; i++) {
    out += sqlLiteral(statement.params[i]) + parts[i + 1];
  }
  return `${out};`;
}

// ---------------------------------------------------------------------------
// The version pin
// ---------------------------------------------------------------------------

/** JSON with object keys sorted, so the same content always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

/**
 * What a pack version's hash covers: everything the compiled pack carries
 * EXCEPT its version number, plus every row it writes -- so `aliases`, a
 * packet, the teaching example and a name-derived renewal or sharing default
 * are all "content".
 */
export function packContentForHash(pack: PackLike & Record<string, unknown>): string {
  const { version: _version, ...rest } = pack;
  return canonicalJson({ pack: rest, writes: packItems(pack) });
}
