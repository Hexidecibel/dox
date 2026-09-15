/**
 * The verified supplier list import — the D1 shell around
 * `deriveSupplierRequirements` (shared/requirementDerivation.ts).
 *
 * One entry point, `runSupplierListImport`, for every caller: the Supplier
 * Requirements page uploads a spreadsheet through POST
 * /api/supplier-list/import, and a future webhook/API feed posts `rows` to the
 * same endpoint. Neither can reach the rules any other way.
 *
 * DRY RUN WRITES NOTHING — not a supplier, not an alias, not a run row. A
 * supplier the list would create is reported `will_create` and keyed
 * provisionally. APPLY creates suppliers through `findOrCreateSupplier` (the
 * same resolver every intake door uses, so "Darigold, Inc." attaches to
 * Darigold and records the alias instead of forking a near-duplicate), then
 * writes the plan with SQL guards on provenance, then stores the run.
 *
 * WHAT AN IMPORT IS: the whole verified list, not a patch. A derived row for a
 * supplier the list no longer implies is FLAGGED for review, never deleted.
 */

import { generateId, logAudit } from './db';
import { findOrCreateSupplier, isPlausibleSupplierName, normalizeSupplierName, resolveExistingSupplierId } from './suppliers';
import {
  loadClaimVocab,
  loadExistingApplicability,
  loadRequirementVocab,
  resolveTenantPack,
} from './requirement-derivation';
import {
  DEFAULT_SUPPLIER_LIST_RULES,
  NOT_ON_VERIFIED_LIST,
  countDerivedChanges,
  deriveSupplierRequirements,
  describeBasis,
  planDerivedChanges,
  type DerivationProblem,
  type DerivationSupplierInput,
  type DerivedChange,
  type SupplierListRules,
} from '../../shared/requirementDerivation';
import {
  normalizeSupplierListRow,
  type NormalizedSupplierListRow,
  type SupplierCategory,
  type SupplierListInputRow,
} from '../../shared/supplierListTemplate';
import { normalizeCode, normalizeName } from '../../shared/productVocabulary';
import type {
  SupplierListFlaggedLine,
  SupplierListImportCounts,
  SupplierListImportResponse,
  SupplierListPreviewSupplier,
  SupplierListRowOutcome,
  SupplierListUnmatched,
  SupplierMatchStatus,
  SupplierRequirementSource,
} from '../../shared/types';

export interface SupplierListImportInput {
  tenantId: string;
  actorId: string;
  ip: string | null;
  dryRun: boolean;
  fileName: string | null;
  format: 'csv' | 'xlsx' | 'rows';
  rows: ReadonlyArray<{ line: number; row: Partial<SupplierListInputRow> }>;
  unrecognizedHeaders?: string[];
  packOverride?: string | null;
  rules?: SupplierListRules;
}

/** A slug-ish key for comparing a claim phrase to a claim type. */
function claimKey(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

interface ProductCatalog {
  byCode: Map<string, Array<{ product_id: string; supplier_id: string | null }>>;
  byName: Map<string, Array<{ product_id: string; supplier_id: string | null }>>;
  names: Map<string, string>;
}

async function loadCatalogForMatching(db: D1Database, tenantId: string): Promise<ProductCatalog> {
  const [products, identifiers] = await Promise.all([
    db
      .prepare('SELECT id, name FROM products WHERE tenant_id = ? AND active = 1')
      .bind(tenantId)
      .all<{ id: string; name: string }>(),
    db
      .prepare(
        `SELECT pi.product_id, pi.kind, pi.value, pi.supplier_id
           FROM product_identifiers pi JOIN products p ON p.id = pi.product_id
          WHERE pi.tenant_id = ? AND p.active = 1 AND pi.superseded = 0`,
      )
      .bind(tenantId)
      .all<{ product_id: string; kind: string; value: string; supplier_id: string | null }>(),
  ]);
  const byCode = new Map<string, Array<{ product_id: string; supplier_id: string | null }>>();
  const byName = new Map<string, Array<{ product_id: string; supplier_id: string | null }>>();
  const names = new Map<string, string>();
  const push = (m: typeof byCode, k: string, v: { product_id: string; supplier_id: string | null }) => {
    if (!k) return;
    const list = m.get(k) ?? [];
    if (!list.some((x) => x.product_id === v.product_id && x.supplier_id === v.supplier_id)) list.push(v);
    m.set(k, list);
  };
  for (const p of products.results ?? []) {
    names.set(p.id, p.name);
    push(byName, normalizeName(p.name), { product_id: p.id, supplier_id: null });
  }
  for (const i of identifiers.results ?? []) {
    if (i.kind === 'our_sku' || i.kind === 'supplier_item' || i.kind === 'gtin') {
      push(byCode, normalizeCode(i.value), { product_id: i.product_id, supplier_id: i.supplier_id });
    } else if (i.kind === 'supplier_name' || i.kind === 'alias') {
      push(byName, normalizeName(i.value), { product_id: i.product_id, supplier_id: i.supplier_id });
    }
  }
  return { byCode, byName, names };
}

/**
 * Match a product bought to OUR catalog: by code first (our SKU, the
 * supplier's item number, a GTIN), then by name. A supplier-scoped identifier
 * only counts for that supplier. More than one candidate is NOT a match — the
 * row reports the ambiguity rather than picking one.
 */
function matchProduct(
  catalog: ProductCatalog,
  supplierId: string | null,
  sku: string | null,
  name: string | null,
): { product_id: string | null; reason: string | null } {
  const pick = (cands: Array<{ product_id: string; supplier_id: string | null }> | undefined) => {
    const usable = (cands ?? []).filter((c) => c.supplier_id === null || c.supplier_id === supplierId);
    return [...new Set(usable.map((c) => c.product_id))];
  };
  if (sku) {
    const ids = pick(catalog.byCode.get(normalizeCode(sku)));
    if (ids.length === 1) return { product_id: ids[0], reason: null };
    if (ids.length > 1) return { product_id: null, reason: `SKU "${sku}" fits ${ids.length} products; not matched.` };
  }
  if (name) {
    const ids = pick(catalog.byName.get(normalizeName(name)));
    if (ids.length === 1) return { product_id: ids[0], reason: null };
    if (ids.length > 1) return { product_id: null, reason: `Product name "${name}" fits ${ids.length} products; not matched.` };
  }
  return {
    product_id: null,
    reason: `${sku ? `SKU "${sku}"` : `"${name}"`} is not in the product catalog. A spec sheet is still required for it.`,
  };
}

function emptyCounts(): SupplierListImportCounts {
  return {
    rows_total: 0,
    rows_accepted: 0,
    rows_rejected: 0,
    suppliers_listed: 0,
    suppliers_matched: 0,
    suppliers_created: 0,
    suppliers_not_approved: 0,
    products_matched: 0,
    products_unmatched: 0,
    claims_unmatched: 0,
    requirements_added: 0,
    requirements_adopted_unconfirmed: 0,
    requirements_refreshed: 0,
    requirements_tier_changed: 0,
    requirements_kept_person_set: 0,
    requirements_newly_flagged: 0,
    requirements_still_flagged: 0,
  };
}

function describeProblem(p: DerivationProblem): string {
  switch (p.kind) {
    case 'unknown_requirement':
      return `Requirement "${p.slug}" (${p.because}) does not exist or is inactive in this tenant, so nothing was derived for it.`;
    case 'unknown_packet':
      return `The ${p.category} category maps to packet "${p.packet}", which this tenant's starter pack does not define.`;
    case 'category_without_packet':
      return `No requirement packet is defined for ${p.category} suppliers; they get the baseline only.`;
  }
}

export async function runSupplierListImport(
  db: D1Database,
  input: SupplierListImportInput,
): Promise<SupplierListImportResponse> {
  const rules = input.rules ?? DEFAULT_SUPPLIER_LIST_RULES;
  const pack = await resolveTenantPack(db, input.tenantId, input.packOverride);
  const [vocab, claims, catalog] = await Promise.all([
    loadRequirementVocab(db, input.tenantId),
    loadClaimVocab(db, input.tenantId),
    loadCatalogForMatching(db, input.tenantId),
  ]);

  const counts = emptyCounts();
  const unmatched: SupplierListUnmatched[] = [];
  const outcomes = new Map<number, SupplierListRowOutcome>();

  const normalized: NormalizedSupplierListRow[] = input.rows.map(({ line, row }) =>
    normalizeSupplierListRow(line, row),
  );
  counts.rows_total = normalized.length;

  const claimTypeByKey = new Map<string, string>();
  for (const ct of claims.claimTypes) {
    claimTypeByKey.set(claimKey(ct.slug), ct.slug);
    claimTypeByKey.set(claimKey(ct.name), ct.slug);
  }

  // Group the usable rows by supplier. The key is the normalized name, so
  // "Darigold" and "Darigold, Inc." on two rows are one supplier.
  const groups = new Map<string, NormalizedSupplierListRow[]>();
  for (const r of normalized) {
    const outcome: SupplierListRowOutcome = {
      line: r.line,
      status: 'accepted',
      supplier_name: r.supplier_name,
      supplier_id: null,
      supplier_match: 'unresolved',
      category: r.category,
      approved: r.approved,
      product_label: [r.product_sku, r.product_name].filter(Boolean).join(' ') || null,
      product_id: null,
      product_name_matched: null,
      claims_matched: [],
      claims_unmatched: [],
      problems: [...r.problems],
      warnings: [...r.warnings],
    };
    outcomes.set(r.line, outcome);
    if (r.supplier_name && !isPlausibleSupplierName(r.supplier_name)) {
      outcome.problems.push(`"${r.supplier_name}" does not look like a supplier name.`);
    }
    if (outcome.problems.length > 0) {
      outcome.status = 'rejected';
      for (const p of outcome.problems) {
        unmatched.push({ line: r.line, kind: 'row', value: r.supplier_name, reason: p });
      }
      continue;
    }
    const key = normalizeSupplierName(r.supplier_name) || r.supplier_name.toLowerCase();
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  // Resolve suppliers and build the derivation input.
  const supplierInputs: DerivationSupplierInput[] = [];
  const supplierMeta = new Map<
    string,
    { id: string | null; name: string; match: SupplierMatchStatus; emails: string[] }
  >();
  for (const [key, rows] of groups) {
    const displayName = rows[0].supplier_name;
    let supplierId: string | null = null;
    let match: SupplierMatchStatus;
    if (input.dryRun) {
      supplierId = await resolveExistingSupplierId(db, input.tenantId, displayName);
      match = supplierId ? 'matched' : 'will_create';
    } else {
      const res = await findOrCreateSupplier(db, input.tenantId, displayName, {
        userId: input.actorId,
        ip: input.ip,
      });
      supplierId = res.id;
      match = res.created ? 'created' : 'matched';
    }
    const supplierKey = supplierId ?? `new:${key}`;
    const approvals = new Set(rows.map((r) => r.approved));
    const approved = approvals.size === 1 && approvals.has(true);
    if (approvals.size > 1) {
      for (const r of rows) {
        outcomes.get(r.line)!.warnings.push(
          `Rows for ${displayName} disagree on Approved; treated as not approved until the list agrees.`,
        );
      }
    }

    const categories = [...new Set(rows.map((r) => r.category).filter((c): c is SupplierCategory => c !== null))];
    const products: Array<{ label: string; claims: string[] }> = [];
    const supplierClaims: string[] = [];
    for (const r of rows) {
      const outcome = outcomes.get(r.line)!;
      outcome.supplier_id = supplierId;
      outcome.supplier_match = match;
      const matchedClaims: string[] = [];
      for (const phrase of r.claims) {
        const slug = claimTypeByKey.get(claimKey(phrase));
        if (slug) {
          matchedClaims.push(slug);
          outcome.claims_matched.push(slug);
        } else {
          outcome.claims_unmatched.push(phrase);
          counts.claims_unmatched++;
          unmatched.push({
            line: r.line,
            kind: 'claim',
            value: phrase,
            reason: `"${phrase}" is not a claim type in this tenant, so nothing was derived for it.`,
          });
        }
      }
      if (r.product_sku || r.product_name) {
        const label = outcome.product_label!;
        const pm = matchProduct(catalog, supplierId, r.product_sku, r.product_name);
        if (pm.product_id) {
          outcome.product_id = pm.product_id;
          outcome.product_name_matched = catalog.names.get(pm.product_id) ?? null;
          counts.products_matched++;
        } else {
          counts.products_unmatched++;
          unmatched.push({ line: r.line, kind: 'product', value: label, reason: pm.reason! });
        }
        products.push({ label, claims: matchedClaims });
      } else {
        supplierClaims.push(...matchedClaims);
      }
    }

    supplierInputs.push({
      key: supplierKey,
      name: displayName,
      approved,
      categories,
      products,
      supplierClaims: [...new Set(supplierClaims)],
    });
    supplierMeta.set(supplierKey, {
      id: supplierId,
      name: displayName,
      match,
      emails: [...new Set(rows.map((r) => r.supplier_contact_email).filter((e): e is string => !!e))],
    });
    counts.suppliers_listed++;
    if (match === 'matched') counts.suppliers_matched++;
    if (match === 'created' || match === 'will_create') counts.suppliers_created++;
    if (!approved) counts.suppliers_not_approved++;
  }

  counts.rows_rejected = [...outcomes.values()].filter((o) => o.status === 'rejected').length;
  counts.rows_accepted = counts.rows_total - counts.rows_rejected;

  const derivation = deriveSupplierRequirements({
    suppliers: supplierInputs,
    rules,
    packets: pack.requirement_packets,
    claimRules: claims.claimRules,
    knownRequirementSlugs: new Set(vocab.bySlug.keys()),
  });

  const existing = await loadExistingApplicability(db, input.tenantId);
  const changes = planDerivedChanges(derivation.bySupplier, existing);
  const cc = countDerivedChanges(changes);
  counts.requirements_added = cc.added;
  counts.requirements_adopted_unconfirmed = cc.adopted_unconfirmed;
  counts.requirements_refreshed = cc.refreshed;
  counts.requirements_tier_changed = cc.tier_changed;
  counts.requirements_kept_person_set = cc.kept_person_set;
  counts.requirements_newly_flagged = cc.newly_flagged;
  counts.requirements_still_flagged = cc.still_flagged;

  const nameOfSlug = (slug: string) => vocab.bySlug.get(slug)?.name ?? slug;

  // Preview per listed supplier.
  const suppliers: SupplierListPreviewSupplier[] = supplierInputs.map((s) => {
    const meta = supplierMeta.get(s.key)!;
    const derived = derivation.bySupplier[s.key] ?? [];
    const changeFor = new Map<string, DerivedChange>();
    for (const ch of changes) {
      if (ch.supplier_key === s.key && ch.kind !== 'flag_unsupported') changeFor.set(ch.slug, ch);
    }
    return {
      supplier_key: s.key,
      supplier_id: meta.id,
      supplier_name: meta.name,
      supplier_match: meta.match,
      approved: s.approved,
      categories: [...s.categories],
      products: s.products.map((p) => p.label),
      contact_emails: meta.emails,
      lines: derived.map((d) => {
        const ch = changeFor.get(d.slug);
        const action = ch?.kind ?? 'add';
        return {
          requirement_slug: d.slug,
          requirement_name: nameOfSlug(d.slug),
          tier: ch?.kind === 'keep_person' ? ch.tier : d.tier,
          action: action as SupplierListPreviewSupplier['lines'][number]['action'],
          from_tier:
            ch && (ch.kind === 'adopt_unconfirmed' || ch.kind === 'refresh_derived') ? ch.from_tier : ch?.kind === 'keep_person' ? ch.tier : null,
          existing_source:
            ch?.kind === 'keep_person'
              ? (ch.source as SupplierRequirementSource)
              : ch?.kind === 'refresh_derived'
                ? 'derived'
                : null,
          because: d.basis.map(describeBasis),
        };
      }),
    };
  });

  const flaggedChanges = changes.filter((c): c is Extract<DerivedChange, { kind: 'flag_unsupported' }> => c.kind === 'flag_unsupported');
  const flaggedSupplierNames = new Map<string, string>();
  const needNames = [...new Set(flaggedChanges.map((c) => c.supplier_key))];
  for (let i = 0; i < needNames.length; i += 50) {
    const chunk = needNames.slice(i, i + 50);
    const res = await db
      .prepare(`SELECT id, name FROM suppliers WHERE tenant_id = ? AND id IN (${chunk.map(() => '?').join(',')})`)
      .bind(input.tenantId, ...chunk)
      .all<{ id: string; name: string }>();
    for (const r of res.results ?? []) flaggedSupplierNames.set(r.id, r.name);
  }
  const flagged: SupplierListFlaggedLine[] = flaggedChanges.map((c) => ({
    row_id: c.row_id,
    supplier_id: c.supplier_key,
    supplier_name: flaggedSupplierNames.get(c.supplier_key) ?? c.supplier_key,
    requirement_slug: c.slug,
    requirement_name: nameOfSlug(c.slug),
    tier: c.tier,
    already_flagged: c.already_flagged,
  }));

  const rowOutcomes = [...outcomes.values()].sort((a, b) => a.line - b.line);
  let runId: string | null = null;

  if (!input.dryRun) {
    runId = generateId();
    const stmts: D1PreparedStatement[] = [];
    // The run row first: every derived row written below points at it.
    stmts.push(
      db
        .prepare(
          `INSERT INTO supplier_list_imports
             (id, tenant_id, file_name, input_format, pack, counts, row_outcomes, input_rows, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          runId,
          input.tenantId,
          input.fileName,
          input.format,
          pack.pack,
          JSON.stringify(counts),
          JSON.stringify(rowOutcomes),
          JSON.stringify(input.rows.map(({ line, row }) => ({ line, row }))),
          input.actorId,
        ),
    );
    for (const ch of changes) {
      switch (ch.kind) {
        case 'add': {
          const req = vocab.bySlug.get(ch.slug)!;
          stmts.push(
            db
              .prepare(
                `INSERT OR IGNORE INTO supplier_requirements
                   (id, tenant_id, supplier_id, requirement_id, tier, source, derivation_run_id, derivation_basis,
                    created_by, updated_by)
                 VALUES (?, ?, ?, ?, ?, 'derived', ?, ?, ?, ?)`,
              )
              .bind(
                generateId(),
                input.tenantId,
                ch.supplier_key,
                req.id,
                ch.tier,
                runId,
                JSON.stringify(ch.basis),
                input.actorId,
                input.actorId,
              ),
          );
          break;
        }
        case 'adopt_unconfirmed':
          stmts.push(
            db
              .prepare(
                `UPDATE supplier_requirements
                    SET tier = ?, source = 'derived', derivation_run_id = ?, derivation_basis = ?,
                        review_flag = NULL, review_flagged_at = NULL,
                        updated_at = datetime('now'), updated_by = ?
                  WHERE id = ? AND tenant_id = ? AND source IS NULL`,
              )
              .bind(ch.tier, runId, JSON.stringify(ch.basis), input.actorId, ch.row_id, input.tenantId),
          );
          break;
        case 'refresh_derived':
          stmts.push(
            db
              .prepare(
                `UPDATE supplier_requirements
                    SET tier = ?, derivation_run_id = ?, derivation_basis = ?,
                        review_flag = NULL, review_flagged_at = NULL,
                        updated_at = datetime('now'), updated_by = ?
                  WHERE id = ? AND tenant_id = ? AND source = 'derived'`,
              )
              .bind(ch.tier, runId, JSON.stringify(ch.basis), input.actorId, ch.row_id, input.tenantId),
          );
          break;
        case 'flag_unsupported':
          if (!ch.already_flagged) {
            stmts.push(
              db
                .prepare(
                  `UPDATE supplier_requirements
                      SET review_flag = ?, review_flagged_at = datetime('now')
                    WHERE id = ? AND tenant_id = ? AND source = 'derived'`,
                )
                .bind(NOT_ON_VERIFIED_LIST, ch.row_id, input.tenantId),
            );
          }
          break;
        case 'keep_person':
          break;
      }
    }
    // The first chunk carries the run row; D1 batches are transactions, so a
    // failure in it leaves no run and no rows pointing at a missing run.
    for (let i = 0; i < stmts.length; i += 100) {
      await db.batch(stmts.slice(i, i + 100));
    }

    await logAudit(
      db,
      input.actorId,
      input.tenantId,
      'supplier_list.import',
      'supplier_list_import',
      runId,
      JSON.stringify({
        file_name: input.fileName,
        input_format: input.format,
        pack: pack.pack,
        counts,
        rule_problems: derivation.problems.map(describeProblem),
      }),
      input.ip,
    );
  }

  return {
    dry_run: input.dryRun,
    run_id: runId,
    pack: pack.pack,
    file_name: input.fileName,
    counts,
    suppliers,
    flagged,
    rows: rowOutcomes,
    unmatched,
    rule_problems: derivation.problems.map(describeProblem),
    unrecognized_headers: input.unrecognizedHeaders ?? [],
    rules: {
      baseline: rules.baseline.map((b) => b.slug),
      category_packets: { ...rules.categoryPackets },
      product_spec_sheet: rules.productSpecSheet?.slug ?? null,
    },
  };
}
