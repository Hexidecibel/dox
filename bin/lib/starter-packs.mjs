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
 */

/** Grains a claim_types.subject_grain may declare (mirrors functions/lib/registry.ts). */
export const SUBJECT_GRAINS = ['any', 'tenant', 'product', 'supplier', 'facility'];

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
export function normalizePack(pack) {
  if (!pack || typeof pack !== 'object') throw new Error('Pack must be a JSON object');
  if (!pack.pack || !/^[a-z0-9-]+$/.test(pack.pack)) {
    throw new Error('Pack must have a "pack" name matching [a-z0-9-]+');
  }

  const sections = ['document_types', 'requirements', 'claim_types', 'claim_rules'];
  for (const key of sections) {
    if (pack[key] !== undefined && !Array.isArray(pack[key])) {
      throw new Error(`"${key}" must be an array`);
    }
  }

  const normalize = (items, kind) => {
    const seen = new Set();
    return (items || []).map((item, i) => {
      if (!item || typeof item !== 'object') throw new Error(`${kind}[${i}] must be an object`);
      if (!item.name || !String(item.name).trim()) {
        throw new Error(`${kind}[${i}] is missing "name"`);
      }
      const slug = itemSlug(item, i, kind);
      if (seen.has(slug)) throw new Error(`${kind}: duplicate slug "${slug}"`);
      seen.add(slug);
      return {
        ...item,
        name: String(item.name).trim(),
        slug,
        description: item.description ? String(item.description) : null,
        sort_order: Number.isFinite(item.sort_order) ? item.sort_order : (i + 1) * 10,
      };
    });
  };

  const documentTypes = normalize(pack.document_types, 'document_types');
  const requirements = normalize(pack.requirements, 'requirements').map((r) => ({
    ...r,
    checklist: r.checklist ? String(r.checklist) : null,
  }));
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

  return {
    pack: pack.pack,
    label: pack.label || pack.pack,
    description: pack.description || '',
    document_types: documentTypes,
    requirements,
    claim_types: claimTypes,
    claim_rules: claimRules,
  };
}

/**
 * Deterministic row ids, derived from the tenant slug + the vocabulary slug.
 *
 * This is what makes seeding idempotent in the strong sense: re-running
 * `bin/create-tenant` against an existing tenant produces the SAME ids, so the
 * INSERT OR IGNORE hits the primary key and no duplicate-by-another-name row
 * is created — and any edits an admin made to the seeded row survive.
 */
export function packRowId(prefix, tenantSlug, slug) {
  return `${prefix}_${slugify(tenantSlug)}_${slug}`;
}

/**
 * Compile a pack into an array of SQL statements for one tenant.
 *
 * Every statement is INSERT OR IGNORE: seeding is additive and never clobbers
 * what a tenant has already customized.
 */
export function packToStatements(rawPack, { tenantId, tenantSlug }) {
  if (!tenantId) throw new Error('tenantId is required');
  if (!tenantSlug) throw new Error('tenantSlug is required');
  const pack = normalizePack(rawPack);
  const statements = [];

  for (const dt of pack.document_types) {
    statements.push(
      `INSERT OR IGNORE INTO document_types (id, tenant_id, name, slug, description) VALUES (` +
        `${sqlQuote(packRowId('dt', tenantSlug, dt.slug))}, ${sqlQuote(tenantId)}, ` +
        `${sqlQuote(dt.name)}, ${sqlQuote(dt.slug)}, ${sqlQuote(dt.description)});`,
    );
  }

  for (const req of pack.requirements) {
    statements.push(
      `INSERT OR IGNORE INTO requirements (id, tenant_id, slug, name, description, checklist, sort_order) VALUES (` +
        `${sqlQuote(packRowId('req', tenantSlug, req.slug))}, ${sqlQuote(tenantId)}, ` +
        `${sqlQuote(req.slug)}, ${sqlQuote(req.name)}, ${sqlQuote(req.description)}, ` +
        `${sqlQuote(req.checklist)}, ${req.sort_order});`,
    );
  }

  for (const ct of pack.claim_types) {
    statements.push(
      `INSERT OR IGNORE INTO claim_types (id, tenant_id, slug, name, description, subject_grain, sort_order) VALUES (` +
        `${sqlQuote(packRowId('clm', tenantSlug, ct.slug))}, ${sqlQuote(tenantId)}, ` +
        `${sqlQuote(ct.slug)}, ${sqlQuote(ct.name)}, ${sqlQuote(ct.description)}, ` +
        `${sqlQuote(ct.subject_grain)}, ${ct.sort_order});`,
    );
  }

  for (const rule of pack.claim_rules) {
    const claimId = packRowId('clm', tenantSlug, rule.claim);
    const emit = (reqSlug, isRequired) => {
      const reqId = packRowId('req', tenantSlug, reqSlug);
      statements.push(
        `INSERT OR IGNORE INTO claim_type_requirements (id, tenant_id, claim_type_id, requirement_id, is_required, notes) VALUES (` +
          `${sqlQuote(`ctr_${slugify(tenantSlug)}_${rule.claim}__${reqSlug}`)}, ${sqlQuote(tenantId)}, ` +
          `${sqlQuote(claimId)}, ${sqlQuote(reqId)}, ${isRequired}, ${sqlQuote(rule.notes)});`,
      );
    };
    for (const reqSlug of rule.requires) emit(reqSlug, 1);
    for (const reqSlug of rule.recommends) emit(reqSlug, 0);
  }

  return statements;
}

/** Same as packToStatements, joined into a single .sql file body. */
export function packToSql(rawPack, opts) {
  const pack = normalizePack(rawPack);
  const header = [
    `-- Starter pack: ${pack.pack} (${pack.label})`,
    `-- Tenant: ${opts.tenantId} (${opts.tenantSlug})`,
    '-- Generated by bin/render-starter-pack. Every statement is INSERT OR IGNORE.',
    '',
  ].join('\n');
  return `${header}${packToStatements(rawPack, opts).join('\n')}\n`;
}

/** Counts for the CLI summary line. */
export function packSummary(rawPack) {
  const pack = normalizePack(rawPack);
  return {
    document_types: pack.document_types.length,
    requirements: pack.requirements.length,
    claim_types: pack.claim_types.length,
    claim_rules: pack.claim_rules.reduce(
      (n, r) => n + r.requires.length + r.recommends.length,
      0,
    ),
  };
}
