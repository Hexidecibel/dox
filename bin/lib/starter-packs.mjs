/**
 * Starter-pack compiler — turns a pack JSON file into idempotent SQL.
 *
 * A "starter pack" is the per-tenant registry vocabulary a fresh tenant begins
 * life with: what documents ARE (document_types), what they SATISFY
 * (requirements), what they TRIGGER (claim_types) and which requirement each
 * claim opens (claim_type_requirements).
 *
 * The packs live as DATA in starter-packs/*.json precisely so that aiming the
 * platform at a new vertical is an editing exercise, not a code change. This
 * module is the only place that knows how a pack maps onto tables; it contains
 * no domain vocabulary of its own.
 *
 * Deliberately DEPENDENCY-FREE and free of node builtins so the same functions
 * can be unit-tested inside the Cloudflare Workers test pool.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A PACK COVERS NOW — "seeded" vs "ready to demonstrate"
 * ═══════════════════════════════════════════════════════════════════════════
 * The three-facet vocabulary above makes a tenant CONFIGURED. It does not make
 * it DEMONSTRATE anything: an approved document still closed no checklist item
 * (nothing produced `document_requirements` until migration 0100), every COA
 * result still resolved to `not_checked` (no `spec_tests`, so no analyte name
 * matched), and every renewal still reported a routing gap (no
 * `documents.owner`). Four additive keys close that:
 *
 *   document_types[].closes                  -> document_type_requirements (0100)
 *   document_types[].owner                   -> document_types.default_owner (0100)
 *   document_types[].extraction_instructions -> document_type_extraction_instructions (0098)
 *   owner_labels[]                           -> owner_labels (0099)
 *   spec_tests[]                             -> spec_tests + spec_limits (0084/0095)
 *   modules{}                                -> tenant_modules (0099)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A PACK DEFINES BUT DOES NOT SEED
 * ═══════════════════════════════════════════════════════════════════════════
 * `requirement_packets[]` and `teach{}` produce NO SQL, on purpose.
 *
 * A PACKET IS DEFINED HERE AND APPLIED ONE SUPPLIER AT A TIME. It would emit
 * into `supplier_requirements` (0087), and a brand-new tenant has ZERO
 * suppliers, so there is nothing to write and nothing to write it against.
 * More to the point, the live tenant's checklist is uniform-and-wrong precisely
 * because six items were bulk-written across 21 existing suppliers; a pack that
 * shipped with a bulk-apply would reproduce that on day one. A packet is a
 * NAMED SET a human points at one supplier.
 *
 * `teach{}` is the wizard's teaching screen — copy and a worked example, not
 * tenant state. Writing it to a table would give the tenant a row nobody reads
 * and nothing renders.
 *
 * Both are still part of the compiled pack: `packToStatements` ignores them,
 * `normalizePack` VALIDATES them (a packet naming a requirement that does not
 * exist is exactly the editing mistake this module catches), and
 * `bin/build-starter-packs` carries them to the browser.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FOUR THINGS A PACK DELIBERATELY NEVER WRITES
 * ═══════════════════════════════════════════════════════════════════════════
 *   supplier_requirements   see above — zero suppliers exist, and bulk
 *                           application is the defect, not the feature.
 *   owner_routes            a route needs a REAL recipient. A pack cannot know
 *                           one, and a placeholder route sends a compliance
 *                           alert nowhere WITHOUT reporting a gap — strictly
 *                           worse than the unrouted state it replaced. The pack
 *                           supplies the LABELS (`owner_labels`); a human
 *                           supplies the people.
 *   extraction_context      `tenants.extraction_context` (0072) is a
 *                           whole-block REPLACEMENT of the tenant's editable
 *                           industry prompt. Seeding it INSERT-OR-IGNORE style
 *                           is impossible (it is a column, not a row), so a
 *                           pack writing it would overwrite an edited block on
 *                           every re-run. The type layer (0098) is where a pack
 *                           puts guidance, because that layer composes.
 *   naming_templates        the table DOES NOT EXIST: created by 0014, dropped
 *                           by 0018. Its replacement
 *                           `document_types.naming_format` has zero readers.
 */

/**
 * The ONE applier, reached through the compiled mirror.
 *
 * THE EXCEPTION TO "DEPENDENCY-FREE", AND WHY. Everything the VALIDATION half
 * of this file needs from `shared/` is restated here and pinned by a test (see
 * SPEC_OPERATORS below). That trade is fine for a validation rule: a drifted
 * copy rejects a limit somebody has to fix anyway. It is NOT fine for what a
 * pack WRITES. The renewal default is the name match that decides whether a
 * Certificate of Analysis renews at all, and a drifted copy produces SILENCE --
 * the CLI seeds a tenant whose COA type renews annually, mails its owner about
 * a certificate that does not renew, and nothing fails.
 *
 * So the CLI does not write a pack itself any more. `shared/packItems.ts`
 * (compiled to `bin/lib/shared/packItems.js` by `npm run build:worker-shared`,
 * the same way `bin/process-worker` gets `shared/specCheck.ts`) holds what a
 * pack writes and the SQL that writes it -- including the renewal default
 * (`defaultRenewalSettingForTypeName`) and the sharing rule
 * (`defaultSharingRuleForTypeName`), bundled into that one file. The in-portal
 * applier binds the same statements this file inlines.
 */
import { packApplyStatements, inlineSql, packRowId } from './shared/packItems.js';

/** Grains a claim_types.subject_grain may declare (mirrors functions/lib/registry.ts). */
export const SUBJECT_GRAINS = ['any', 'tenant', 'product', 'supplier', 'facility'];

/**
 * What a requirement is owed PER (`requirements.scope`, migration 0123). A
 * MIRROR of `REQUIREMENT_SCOPES` in shared/requirementScope.ts -- this
 * dependency-free .mjs cannot import it; tests/unit/starter-packs.test.ts pins
 * the two equal. A requirement that names no scope is 'supplier'.
 */
export const REQUIREMENT_SCOPES = ['supplier', 'product', 'lot'];

/**
 * The `spec_limits.operator` CHECK from migration 0084, restated.
 *
 * A pack is compiled by a dependency-free .mjs that cannot import
 * `shared/specCheck.ts`, so this list and `validateSpecLimitShape` below are a
 * MIRROR of `validateLimitShape` over there — the same rules, worded for
 * somebody editing JSON. `tests/unit/starter-packs.test.ts` imports the real
 * `validateLimitShape` and asserts every shipped pack limit also passes IT, so
 * the two cannot drift silently: a rule added there and not here fails the
 * suite rather than shipping a limit the database will reject.
 */
export const SPEC_OPERATORS = ['<', '<=', '>', '>=', 'between', '==', 'absent'];

/** `spec_limits.severity` CHECK (0084): 'alert' mails the owner, 'warn' stays in the queue. */
export const SPEC_SEVERITIES = ['warn', 'alert'];

/** `spec_limits.criticality` CHECK (0095) / `shared/specCriticality.ts`, most critical first. */
export const SPEC_CRITICALITIES = ['high', 'medium', 'low'];

/**
 * The same normalization `normalizeOwnerKey` performs in
 * functions/lib/alert-routing.ts: lower-cased, whitespace-collapsed. Restated
 * rather than imported for the same reason as the operator list — this file
 * imports nothing. `owner_labels.owner_key` (0099) and `owner_routes.owner_key`
 * (0091) are both keyed on it and there is no SQL-side collation trick on
 * either, so a pack writing a differently-cased key would create a department
 * that no route and no visibility row can ever join to.
 */
export function ownerKey(label) {
  if (label === null || label === undefined) return null;
  const key = String(label).trim().toLowerCase().replace(/\s+/g, ' ');
  return key.length > 0 ? key : null;
}

/**
 * The analyte-matching normalization from `norm()` in shared/specCheck.ts:
 * lower-case, strip everything that is not alphanumeric. Used here ONLY to
 * catch two spec_tests claiming the same printed name — `matchSpecTest` walks
 * the configured tests in order and takes the first hit, so a collision means
 * one test's limit silently never fires.
 */
function analyteKey(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** SQLite numeric literal, or NULL. Rejects NaN/Infinity rather than emitting them. */
export function sqlNum(value) {
  if (value === null || value === undefined) return 'NULL';
  if (!Number.isFinite(value)) throw new Error(`Not a finite number: ${value}`);
  return String(value);
}

/** Same slug rule as document_types / the vocabulary APIs. */
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** SQLite string literal escaping. */
export function sqlQuote(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * The key two names are compared on to decide whether they are the same
 * concept: lower-cased, everything that is not a letter or a digit removed.
 * A MIRROR of `conceptKey` in shared/duplicateConcept.ts (this file's
 * validation half imports nothing); tests/unit/duplicateConcept.test.ts pins
 * the two equal.
 */
export function conceptKey(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function itemSlug(item, index, kind) {
  const slug = slugify(item.slug || item.name || '');
  if (!slug) {
    throw new Error(`${kind}[${index}]: could not derive a slug (needs "name" or "slug")`);
  }
  return slug;
}

/**
 * Validate a parsed pack and return it normalized (slugs filled in, sort order
 * assigned from array position). Throws Error with a message aimed at whoever
 * is EDITING THE JSON, not at a developer reading a stack trace.
 */
export function normalizePack(pack, options = {}) {
  if (!pack || typeof pack !== 'object') throw new Error('Pack must be a JSON object');
  if (!pack.pack || !/^[a-z0-9-]+$/.test(pack.pack)) {
    throw new Error('Pack must have a "pack" name matching [a-z0-9-]+');
  }

  // `version` (migration 0141). A positive whole number, REQUIRED: it is what
  // an organisation's ledger records and what the roll-forward compares, so a
  // pack without one could be applied and then never updated -- the state this
  // whole mechanism exists to end.
  if (!Number.isInteger(pack.version) || pack.version < 1) {
    throw new Error(
      'Pack must have a "version": a positive whole number. Start at 1 and raise it by one every time the pack changes.',
    );
  }

  /** Non-fatal notes for the CLI. See the `modules` section for why they exist. */
  const warnings = [];

  const sections = [
    'document_types',
    'requirements',
    'claim_types',
    'claim_rules',
    'owner_labels',
    'requirement_packets',
    'spec_tests',
  ];
  for (const key of sections) {
    if (pack[key] !== undefined && !Array.isArray(pack[key])) {
      throw new Error(`"${key}" must be an array`);
    }
  }

  const normalize = (items, kind) => {
    const seen = new Set();
    // Every way this vocabulary can name one of its items -> the item that
    // owns it. `aliases` exist so the portal can recognise a second copy of a
    // concept ("Spec Sheet" for "Specification Sheet"); a spelling that two
    // items both claim would make that answer ambiguous, so it is an error
    // here rather than a coin toss at a customer's screen.
    const claimed = new Map();
    const claim = (text, owner, what) => {
      const key = conceptKey(text);
      if (!key) return;
      const by = claimed.get(key);
      if (by && by !== owner) {
        throw new Error(
          `${kind} "${owner}": ${what} "${text}" is already a name, slug or alias of "${by}" — one spelling may only mean one item`,
        );
      }
      claimed.set(key, owner);
    };
    return (items || []).map((item, i) => {
      if (!item || typeof item !== 'object') throw new Error(`${kind}[${i}] must be an object`);
      if (!item.name || !String(item.name).trim()) {
        throw new Error(`${kind}[${i}] is missing "name"`);
      }
      const slug = itemSlug(item, i, kind);
      if (seen.has(slug)) throw new Error(`${kind}: duplicate slug "${slug}"`);
      seen.add(slug);
      const name = String(item.name).trim();
      if (item.aliases !== undefined && !Array.isArray(item.aliases)) {
        throw new Error(`${kind} "${name}": "aliases" must be an array of other names for the same thing`);
      }
      claim(name, name, 'the name');
      claim(slug, name, 'the slug');
      const aliases = [];
      const seenAlias = new Set([conceptKey(name), conceptKey(slug)]);
      for (const raw of item.aliases || []) {
        const text = String(raw ?? '').trim();
        if (!text) throw new Error(`${kind} "${name}": "aliases" holds an empty entry`);
        const key = conceptKey(text);
        if (!key) throw new Error(`${kind} "${name}": alias "${text}" has no letters or digits in it`);
        if (seenAlias.has(key)) continue;
        seenAlias.add(key);
        claim(text, name, 'the alias');
        aliases.push(text);
      }
      return {
        ...item,
        name,
        slug,
        aliases,
        description: item.description ? String(item.description) : null,
        sort_order: Number.isFinite(item.sort_order) ? item.sort_order : (i + 1) * 10,
      };
    });
  };

  const documentTypes = normalize(pack.document_types, 'document_types');
  const requirements = normalize(pack.requirements, 'requirements').map((r, i) => {
    const scope = r.scope ?? 'supplier';
    if (!REQUIREMENT_SCOPES.includes(scope)) {
      throw new Error(
        `requirements[${i}] ("${r.name}"): scope "${scope}" must be one of ${REQUIREMENT_SCOPES.join(', ')}`,
      );
    }
    return {
      ...r,
      checklist: r.checklist ? String(r.checklist) : null,
      scope,
    };
  });
  const claimTypes = normalize(pack.claim_types, 'claim_types').map((c, i) => {
    const grain = c.subject_grain || 'any';
    if (!SUBJECT_GRAINS.includes(grain)) {
      throw new Error(
        `claim_types[${i}] ("${c.name}"): subject_grain "${grain}" must be one of ${SUBJECT_GRAINS.join(', ')}`,
      );
    }
    return { ...c, subject_grain: grain };
  });

  const requirementSlugs = new Set(requirements.map((r) => r.slug));
  const claimSlugs = new Set(claimTypes.map((c) => c.slug));

  const claimRules = (pack.claim_rules || []).map((rule, i) => {
    if (!rule || typeof rule !== 'object') throw new Error(`claim_rules[${i}] must be an object`);
    const claim = slugify(rule.claim || '');
    if (!claim) throw new Error(`claim_rules[${i}] is missing "claim"`);
    if (!claimSlugs.has(claim)) {
      throw new Error(
        `claim_rules[${i}]: claim "${claim}" is not defined in claim_types of this pack`,
      );
    }
    const resolve = (list, field) =>
      (list || []).map((entry) => {
        const slug = slugify(entry);
        if (!requirementSlugs.has(slug)) {
          throw new Error(
            `claim_rules[${i}] (${claim}).${field}: "${slug}" is not defined in requirements of this pack`,
          );
        }
        return slug;
      });
    return {
      claim,
      requires: resolve(rule.requires, 'requires'),
      recommends: resolve(rule.recommends, 'recommends'),
      notes: rule.notes ? String(rule.notes) : null,
    };
  });

  // ── owner_labels — the departments, and ONLY the departments ─────────────
  // `{label, description}`. The label is what a human reads; `owner_key` is the
  // join key every other table uses. `description` is carried for the wizard
  // and never written: `owner_labels` (0099) has no such column, and adding one
  // to describe a department would duplicate what the routing screen says.
  const ownerLabelKeys = new Set();
  const ownerLabels = (pack.owner_labels || []).map((entry, i) => {
    if (!entry || typeof entry !== 'object') throw new Error(`owner_labels[${i}] must be an object`);
    const label = String(entry.label ?? entry.name ?? '').trim();
    if (!label) throw new Error(`owner_labels[${i}] is missing "label"`);
    const key = ownerKey(label);
    if (ownerLabelKeys.has(key)) {
      throw new Error(
        `owner_labels: duplicate department "${label}" — it normalizes to the same key ("${key}") as an earlier entry`,
      );
    }
    ownerLabelKeys.add(key);
    return {
      label,
      owner_key: key,
      description: entry.description ? String(entry.description) : null,
    };
  });

  // ── document_types: closes / owner / extraction_instructions ─────────────
  // Post-processed here rather than inside `normalize()` because every one of
  // the three is a CROSS-REFERENCE: `closes` into requirements, `owner` into
  // owner_labels. Validating them at parse time would depend on arrays that do
  // not exist yet.
  const typeSlugs = new Set(documentTypes.map((d) => d.slug));
  for (const dt of documentTypes) {
    const where = `document_types "${dt.name}"`;

    // `closes` — the key the whole feature turns on. A document of this TYPE
    // normally closes these checklist items; migration 0100 stores it and
    // functions/lib/requirement-defaults.ts turns it into 'suggested' links.
    if (dt.closes !== undefined && !Array.isArray(dt.closes)) {
      throw new Error(`${where}: "closes" must be an array of requirement slugs`);
    }
    const closes = [];
    for (const entry of dt.closes || []) {
      const slug = slugify(entry);
      if (!requirementSlugs.has(slug)) {
        throw new Error(
          `${where}: closes "${slug}" is not defined in requirements of this pack`,
        );
      }
      if (closes.includes(slug)) {
        throw new Error(`${where}: closes lists "${slug}" twice`);
      }
      closes.push(slug);
    }
    dt.closes = closes;

    // `owner` — the department that owns this type's renewals. It MUST be a
    // declared label: `documents.owner` resolves through `owner_routes` on a
    // normalized key, so a department the pack never declared is a value that
    // routes to nobody and reports a gap forever.
    if (dt.owner !== undefined && dt.owner !== null && typeof dt.owner !== 'string') {
      throw new Error(`${where}: "owner" must be a string naming one of owner_labels`);
    }
    const owner = dt.owner ? String(dt.owner).trim() : '';
    if (owner) {
      const key = ownerKey(owner);
      if (!ownerLabelKeys.has(key)) {
        const known = ownerLabels.map((o) => o.label).join(', ') || '(none declared)';
        throw new Error(
          `${where}: owner "${owner}" is not one of this pack's owner_labels (${known})`,
        );
      }
      dt.owner = owner;
      dt.owner_key = key;
    } else {
      dt.owner = null;
      dt.owner_key = null;
    }

    if (dt.extraction_instructions !== undefined && dt.extraction_instructions !== null) {
      // A STRING or AN ARRAY OF LINES, joined with newlines. JSON has no
      // multi-line string literal, and a 400-character escaped one-liner is not
      // something a non-engineer can edit — which is the whole premise of this
      // file being data. bin/seed-doctype-extraction-instructions writes the
      // same texts the same way, as `[...].join('\n')`.
      const raw = Array.isArray(dt.extraction_instructions)
        ? dt.extraction_instructions.map((line) => String(line ?? '')).join('\n')
        : dt.extraction_instructions;
      if (typeof raw !== 'string') {
        throw new Error(`${where}: "extraction_instructions" must be a string or an array of lines`);
      }
      const text = raw.trim();
      // An empty block is worse than none: 0098's UNIQUE + INSERT OR IGNORE
      // would pin the empty row in place and block a later real one.
      if (!text) throw new Error(`${where}: "extraction_instructions" is empty — omit the key instead`);
      dt.extraction_instructions = text;
    } else {
      dt.extraction_instructions = null;
    }
  }

  // ── requirement_packets — DEFINED here, applied one supplier at a time ────
  // No SQL. See the module header: these would land in `supplier_requirements`
  // (0087) and a new tenant has no suppliers. `default: true` marks the packet
  // the wizard offers first; it does not apply anything.
  const packetSlugs = new Set();
  const requirementPackets = (pack.requirement_packets || []).map((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`requirement_packets[${i}] must be an object`);
    }
    const name = String(entry.name ?? '').trim();
    if (!name) throw new Error(`requirement_packets[${i}] is missing "name"`);
    const slug = slugify(entry.slug || name);
    if (packetSlugs.has(slug)) throw new Error(`requirement_packets: duplicate slug "${slug}"`);
    packetSlugs.add(slug);

    const resolve = (list, field) => {
      if (list !== undefined && !Array.isArray(list)) {
        throw new Error(`requirement_packets "${name}": "${field}" must be an array`);
      }
      return (list || []).map((raw) => {
        const reqSlug = slugify(raw);
        if (!requirementSlugs.has(reqSlug)) {
          throw new Error(
            `requirement_packets "${name}".${field}: "${reqSlug}" is not defined in requirements of this pack`,
          );
        }
        return reqSlug;
      });
    };
    const requires = resolve(entry.requirements, 'requirements');
    const recommends = resolve(entry.recommends, 'recommends');
    // 0087's `tier` is one value per (supplier, requirement) row: a slug in both
    // lists would be a packet that cannot be applied without picking a winner.
    for (const reqSlug of recommends) {
      if (requires.includes(reqSlug)) {
        throw new Error(
          `requirement_packets "${name}": "${reqSlug}" is listed as both required and recommended`,
        );
      }
    }
    if (requires.length === 0 && recommends.length === 0) {
      throw new Error(`requirement_packets "${name}" lists no requirements`);
    }
    return {
      name,
      slug,
      description: entry.description ? String(entry.description) : null,
      default: entry.default === true,
      requirements: requires,
      recommends,
    };
  });

  // ── spec_tests — the SYNONYM MAP first, the threshold second ─────────────
  // `matchSpecTest` (shared/specCheck.ts) is EXACT on a normalized name, never
  // fuzzy. So without the spellings suppliers actually print, every result
  // resolves to `not_checked` and a limit that looks configured judges nothing.
  const specTestSlugs = new Set();
  const analyteClaims = new Map(); // normalized printed name -> canonical test name
  const specTests = (pack.spec_tests || []).map((entry, i) => {
    if (!entry || typeof entry !== 'object') throw new Error(`spec_tests[${i}] must be an object`);
    const name = String(entry.name ?? '').trim();
    if (!name) throw new Error(`spec_tests[${i}] is missing "name"`);
    const slug = slugify(entry.slug || name);
    if (specTestSlugs.has(slug)) throw new Error(`spec_tests: duplicate slug "${slug}"`);
    specTestSlugs.add(slug);

    if (entry.aliases !== undefined && !Array.isArray(entry.aliases)) {
      throw new Error(`spec_tests "${name}": "aliases" must be an array of printed spellings`);
    }
    // Deduped on the NORMALIZED form, because that is what matching compares:
    // "E. coli" and "E.coli" are one alias, and listing both is not an error.
    const aliases = [];
    const seenAlias = new Set();
    for (const raw of [name, ...(entry.aliases || [])]) {
      const text = String(raw ?? '').trim();
      if (!text) continue;
      const key = analyteKey(text);
      if (!key || seenAlias.has(key)) continue;
      seenAlias.add(key);
      const claimedBy = analyteClaims.get(key);
      if (claimedBy && claimedBy !== name) {
        // matchSpecTest takes the FIRST test that matches, so the second one's
        // limit would silently never fire.
        throw new Error(
          `spec_tests "${name}": the spelling "${text}" is already claimed by "${claimedBy}" — ` +
            'a printed name may only resolve to one analyte',
        );
      }
      analyteClaims.set(key, name);
      if (text !== name) aliases.push(text);
    }

    const test = {
      name,
      slug,
      aliases,
      default_unit: entry.default_unit ? String(entry.default_unit) : null,
      notes: entry.notes ? String(entry.notes) : null,
      limit: null,
    };

    if (entry.limit === undefined || entry.limit === null) return test;
    if (typeof entry.limit !== 'object') throw new Error(`spec_tests "${name}": "limit" must be an object`);
    test.limit = normalizeSpecLimit(entry.limit, name, test.default_unit);
    return test;
  });

  // ── teach — the wizard's one lesson, checked against this pack's own rows ─
  const teach = normalizeTeach(pack.teach, { documentTypes, typeSlugs, requirementSlugs });

  // ── modules — WARNING, never an error ────────────────────────────────────
  // Validated against `MODULE_KEYS` from shared/modules.ts when the caller
  // hands them over. Deliberately non-fatal: `shared/modules.ts` is owned by a
  // parallel workstream, and a pack that refuses to compile because somebody
  // renamed a nav group would make the vocabulary a BUILD DEPENDENCY of that
  // workstream. An unknown key is inert anyway — a `tenant_modules` row naming
  // a module this build does not have cannot hide a surface, because surfaces
  // come from code (0099 carries no CHECK on the column for the same reason).
  const modules = normalizeModules(pack.modules, options.moduleKeys, warnings);

  return {
    pack: pack.pack,
    version: pack.version,
    label: pack.label || pack.pack,
    description: pack.description || '',
    document_types: documentTypes,
    requirements,
    claim_types: claimTypes,
    claim_rules: claimRules,
    owner_labels: ownerLabels,
    requirement_packets: requirementPackets,
    spec_tests: specTests,
    teach,
    modules,
    warnings,
  };
}

/**
 * One tenant-wide acceptance limit, validated against migration 0084's CHECK
 * and 0095's criticality vocabulary before it can reach the database.
 *
 * The bounds rules mirror `validateLimitShape` in shared/specCheck.ts — see
 * SPEC_OPERATORS above for why they are restated rather than imported.
 */
function normalizeSpecLimit(raw, testName, defaultUnit) {
  const where = `spec_tests "${testName}".limit`;
  const operator = String(raw.operator ?? '').trim();
  if (!SPEC_OPERATORS.includes(operator)) {
    throw new Error(`${where}: operator "${operator}" must be one of ${SPEC_OPERATORS.join(' ')}`);
  }

  const num = (value, field) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${where}: "${field}" must be a number`);
    }
    return value;
  };
  const min = num(raw.value_min, 'value_min');
  const max = num(raw.value_max, 'value_max');

  // A limit with a missing bound cannot judge anything, and a limit that
  // silently never fires is the exact failure spec checking exists to prevent.
  switch (operator) {
    case '<':
    case '<=':
      if (max === null) throw new Error(`${where}: a "${operator}" limit needs "value_max"`);
      break;
    case '>':
    case '>=':
      if (min === null) throw new Error(`${where}: a "${operator}" limit needs "value_min"`);
      break;
    case '==':
      if (min === null) throw new Error(`${where}: an "==" limit needs "value_min" as the target`);
      break;
    case 'between':
      if (min === null || max === null) {
        throw new Error(`${where}: a "between" limit needs both "value_min" and "value_max"`);
      }
      if (min > max) throw new Error(`${where}: value_min (${min}) is greater than value_max (${max})`);
      break;
    case 'absent':
      // Satisfied by Absent / Negative / ND / None detected. Bounds are
      // meaningless here and a stored one would only mislead a later reader.
      if (min !== null || max !== null) {
        throw new Error(`${where}: an "absent" limit takes no value_min / value_max`);
      }
      break;
    default:
      break;
  }

  const severity = raw.severity === undefined ? 'alert' : String(raw.severity);
  if (!SPEC_SEVERITIES.includes(severity)) {
    throw new Error(`${where}: severity "${severity}" must be one of ${SPEC_SEVERITIES.join(' ')}`);
  }
  const criticality = raw.criticality === undefined ? 'medium' : String(raw.criticality);
  if (!SPEC_CRITICALITIES.includes(criticality)) {
    throw new Error(
      `${where}: criticality "${criticality}" must be one of ${SPEC_CRITICALITIES.join(' ')}`,
    );
  }

  // A numeric limit with no unit anywhere is judged against whatever the
  // certificate printed, which is how a CFU/mL result comes to be compared with
  // a per-gram threshold. `spec_tests.default_unit` is the fallback the limit
  // inherits, so requiring one of the two is not pedantry.
  //
  // DIMENSIONLESS ANALYTES MUST DECLARE THEMSELVES. pH and water activity carry
  // no unit at all, and `normalizeUnit` reads an absent unit as "unknown", which
  // the comparator treats as "assume it matches" — the one case where silence
  // is indistinguishable between "there is no unit" and "nobody filled it in".
  // So an explicit `"unit": null` is a DECLARATION and passes; an omitted key
  // is an oversight and fails. Same discipline as `line_kind: "free_text"` on
  // request lines: the escape hatch exists and has to be asked for.
  const declaredUnit = Object.prototype.hasOwnProperty.call(raw, 'unit');
  const unit = raw.unit === undefined || raw.unit === null ? null : String(raw.unit).trim() || null;
  if (operator !== 'absent' && !unit && !defaultUnit && !declaredUnit) {
    throw new Error(
      `${where}: give the limit a "unit", or the test a "default_unit" — or write "unit": null to declare the analyte dimensionless. A bare number is judged against whatever the certificate printed.`,
    );
  }

  return {
    operator,
    value_min: min,
    value_max: max,
    unit,
    severity,
    criticality,
    notes: raw.notes ? String(raw.notes) : null,
  };
}

/**
 * The wizard's teaching screen, as data.
 *
 * Every field is checked against THIS PACK's own rows, because the lesson is
 * "one document closes several line items" and a lesson that names a
 * requirement the tenant does not have teaches the opposite.
 */
function normalizeTeach(raw, { documentTypes, typeSlugs, requirementSlugs }) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') throw new Error('"teach" must be an object');

  const typeSlug = slugify(raw.document_type || '');
  if (!typeSlug) throw new Error('teach is missing "document_type"');
  if (!typeSlugs.has(typeSlug)) {
    throw new Error(`teach.document_type: "${typeSlug}" is not defined in document_types of this pack`);
  }
  const type = documentTypes.find((d) => d.slug === typeSlug);

  if (raw.closes !== undefined && !Array.isArray(raw.closes)) {
    throw new Error('teach.closes must be an array of requirement slugs');
  }
  const closes = (raw.closes || []).map((entry) => {
    const slug = slugify(entry);
    // A SUBSET of the type's own `closes`, not a free list: the screen ticks
    // boxes that a real document of this type really does close, and the
    // suggestion engine would otherwise disagree with the lesson on screen.
    if (!type.closes.includes(slug)) {
      throw new Error(
        `teach.closes: "${slug}" is not in document_types "${type.name}".closes — ` +
          'the teaching screen may only tick what a document of this type actually closes',
      );
    }
    return slug;
  });
  if (closes.length === 0) throw new Error('teach.closes lists nothing to tick');

  const decoy = raw.decoy ? slugify(raw.decoy) : null;
  if (decoy) {
    if (!requirementSlugs.has(decoy)) {
      throw new Error(`teach.decoy: "${decoy}" is not defined in requirements of this pack`);
    }
    // The decoy is the TEMPTING WRONG ANSWER. One this type genuinely closes
    // would make "why not this one?" a lie.
    if (type.closes.includes(decoy)) {
      throw new Error(
        `teach.decoy: "${decoy}" IS closed by "${type.name}" — a decoy has to be the wrong answer`,
      );
    }
    if (!String(raw.decoy_reason || '').trim()) {
      throw new Error('teach.decoy_reason is required whenever a decoy is named');
    }
  }

  let alsoClosedBy = null;
  if (raw.also_closed_by) {
    const req = slugify(raw.also_closed_by.requirement || '');
    const dt = slugify(raw.also_closed_by.document_type || '');
    if (!requirementSlugs.has(req)) {
      throw new Error(`teach.also_closed_by.requirement: "${req}" is not defined in requirements`);
    }
    if (!typeSlugs.has(dt)) {
      throw new Error(`teach.also_closed_by.document_type: "${dt}" is not defined in document_types`);
    }
    const other = documentTypes.find((d) => d.slug === dt);
    // The mirror only lands if the named type really does close it — this is
    // the answer to "then what does close this?".
    if (!other.closes.includes(req)) {
      throw new Error(
        `teach.also_closed_by: "${other.name}" does not list "${req}" in its closes — ` +
          'the mirror would name a document that closes nothing of the sort',
      );
    }
    alsoClosedBy = { requirement: req, document_type: dt };
  }

  return {
    document_type: typeSlug,
    closes,
    decoy,
    decoy_reason: raw.decoy_reason ? String(raw.decoy_reason) : null,
    also_closed_by: alsoClosedBy,
    sample_file: raw.sample_file ? String(raw.sample_file) : null,
  };
}

/** `{default_on, default_off}` -> `tenant_modules` rows. Unknown keys WARN. */
function normalizeModules(raw, moduleKeys, warnings) {
  const empty = { default_on: [], default_off: [] };
  if (raw === undefined || raw === null) return empty;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('"modules" must be an object with "default_on" / "default_off" arrays');
  }
  const read = (list, field) => {
    if (list !== undefined && !Array.isArray(list)) {
      throw new Error(`modules.${field} must be an array of module keys`);
    }
    return [...new Set((list || []).map((k) => String(k).trim()).filter(Boolean))];
  };
  const on = read(raw.default_on, 'default_on');
  const off = read(raw.default_off, 'default_off');

  // A key on both sides is not a naming question, it is a contradiction: the
  // pack would emit enabled=1 and enabled=0 for the same primary key and the
  // second statement would be silently ignored.
  for (const key of off) {
    if (on.includes(key)) {
      throw new Error(`modules: "${key}" is listed in both default_on and default_off`);
    }
  }

  if (Array.isArray(moduleKeys) && moduleKeys.length > 0) {
    for (const key of [...on, ...off]) {
      if (!moduleKeys.includes(key)) {
        warnings.push(
          `modules: "${key}" is not a module in this build (${moduleKeys.join(', ')}). ` +
            'The row will be seeded and ignored — it can hide nothing, because surfaces come from code.',
        );
      }
    }
  }

  return { default_on: on, default_off: off };
}

/**
 * The id a pack gives a row IT inserts. Re-exported from the shared compiler.
 *
 * It used to be how every row was FOUND as well, which made the tenant slug
 * half of every foreign key: a hand-made row under a pack slug, or a tenant
 * whose slug had been changed, failed the whole batch. Rows are now found by
 * `(tenant_id, slug)`; see the header of shared/packItems.ts.
 */
export { packRowId };

/**
 * Compile a pack into an array of SQL statements for one tenant.
 *
 * THE SAME STATEMENTS THE PORTAL RUNS. `packApplyStatements`
 * (shared/packItems.ts, reached through its compiled mirror) writes each one
 * once with `?` placeholders; `functions/lib/starter-packs.ts` binds them and
 * this function inlines them. Until migration 0141 this was a second
 * hand-written copy of the portal's applier.
 *
 * Every row statement is INSERT OR IGNORE: applying is additive and never
 * clobbers what a tenant has customized. They are followed by one ledger
 * statement per item (`pack_applied_items`: what the pack wrote, and which
 * columns of an adopted row were not the pack's) and the version stamp
 * (`tenant_packs`) -- which is what lets a LATER pack version reach this
 * tenant through a roll-forward instead of a repair script.
 */
export function packToStatements(rawPack, { tenantId, tenantSlug, moduleKeys } = {}) {
  if (!tenantId) throw new Error('tenantId is required');
  if (!tenantSlug) throw new Error('tenantSlug is required');
  const pack = normalizePack(rawPack, { moduleKeys });
  const { rows, ledger } = packApplyStatements(pack, {
    tenantId,
    tenantSlug,
    source: 'cli',
    appliedBy: null,
  });
  return [...rows, ...ledger].map(inlineSql);
}

/** Same as packToStatements, joined into a single .sql file body. */
export function packToSql(rawPack, opts) {
  const pack = normalizePack(rawPack, { moduleKeys: opts.moduleKeys });
  const header = [
    `-- Starter pack: ${pack.pack} (${pack.label})`,
    `-- Tenant: ${opts.tenantId} (${opts.tenantSlug})`,
    `-- Pack version: ${pack.version}`,
    '-- Generated by bin/render-starter-pack. Every row statement is INSERT OR IGNORE;',
    '-- the pack_applied_items / tenant_packs statements after them are the ledger (0141).',
    ...(pack.requirement_packets.length
      ? [
          `-- ${pack.requirement_packets.length} requirement packet(s) are DEFINED by this pack and`,
          '-- deliberately not seeded: they apply to suppliers, and a new tenant has none.',
        ]
      : []),
    ...pack.warnings.map((w) => `-- WARNING: ${w}`),
    '',
  ].join('\n');
  return `${header}${packToStatements(rawPack, opts).join('\n')}\n`;
}

/**
 * Counts for the CLI summary line.
 *
 * Everything a pack WRITES is counted, plus the two things it only DEFINES
 * (`requirement_packets`, `teach`) — `bin/create-tenant` prints this before it
 * touches the database, and a pre-flight line that omitted half the pack would
 * be exactly the kind of quiet inaccuracy this format is trying to remove.
 */
export function packSummary(rawPack, options = {}) {
  const pack = normalizePack(rawPack, options);
  return {
    document_types: pack.document_types.length,
    requirements: pack.requirements.length,
    claim_types: pack.claim_types.length,
    claim_rules: pack.claim_rules.reduce(
      (n, r) => n + r.requires.length + r.recommends.length,
      0,
    ),
    owner_labels: pack.owner_labels.length,
    document_type_requirements: pack.document_types.reduce((n, d) => n + d.closes.length, 0),
    type_owners: pack.document_types.filter((d) => d.owner).length,
    extraction_instructions: pack.document_types.filter((d) => d.extraction_instructions).length,
    spec_tests: pack.spec_tests.length,
    spec_limits: pack.spec_tests.filter((t) => t.limit).length,
    modules_on: pack.modules.default_on.length,
    modules_off: pack.modules.default_off.length,
    // Defined, never seeded. Counted so --list-packs stays truthful about what
    // the pack contains, not only about what it writes.
    requirement_packets: pack.requirement_packets.length,
    teaches: pack.teach ? 1 : 0,
    warnings: pack.warnings,
  };
}

/**
 * The one-line pre-flight description used by `bin/create-tenant` and
 * `--summary`. Sections with nothing in them are dropped rather than printed as
 * "0", so an older pack reads exactly as it did before these keys existed.
 */
export function summaryLine(summary) {
  const parts = [
    [summary.document_types, 'document types'],
    [summary.requirements, 'requirements'],
    [summary.claim_types, 'claim types'],
    [summary.claim_rules, 'claim rules'],
    [summary.document_type_requirements, 'type→requirement defaults'],
    [summary.owner_labels, 'departments'],
    [summary.extraction_instructions, 'type extraction instructions'],
    [summary.spec_tests, 'spec tests'],
    [summary.spec_limits, 'spec limits'],
    [summary.modules_off, 'modules off'],
  ]
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`);
  const defined = [];
  if (summary.requirement_packets > 0) defined.push(`${summary.requirement_packets} requirement packets`);
  if (summary.teaches > 0) defined.push('a teaching example');
  const written = parts.join(', ');
  return defined.length ? `${written} (+ ${defined.join(' and ')}, defined but not seeded)` : written;
}
