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
 *
 * THE APPROVED COLUMN IS ALSO THE PAIR'S APPROVAL (migration 0135, decision
 * C-001). One row is supplier x product, so when the product resolves, Y / N
 * sets that item's approval from that supplier (`approval_source = 'import'`).
 * It never overrides a decision a person made; a product that does not resolve
 * has no pair to approve and is reported; rows that disagree change nothing.
 * The dry run reports every one of those outcomes and writes none of them.
 */

import { generateId, logAudit } from './db';
import { findOrCreateSupplier, isPlausibleSupplierName, normalizeSupplierName, resolveExistingSupplierId } from './suppliers';
import { normalizeContactEmail, recordImportedContact } from './supplier-contacts';
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
import { linkProductToSupplier } from './entities/products';
import {
  decideItemApproval,
  loadProductSupplierLink,
  planApprovalDecision,
  type ProductSupplierLinkRow,
} from './item-approval';
import { ITEM_APPROVAL_LABELS } from '../../shared/itemApproval';
import type {
  ItemApprovalSource,
  ItemApprovalStatus,
  SupplierListApprovalOutcome,
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

/** Every contact address already on file, per supplier (normalized). Empty before 0133. */
async function loadKnownContactEmails(db: D1Database, tenantId: string): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  try {
    const res = await db
      .prepare('SELECT supplier_id, email_norm FROM supplier_contacts WHERE tenant_id = ?')
      .bind(tenantId)
      .all<{ supplier_id: string; email_norm: string }>();
    for (const r of res.results ?? []) {
      const set = out.get(r.supplier_id);
      if (set) set.add(r.email_norm);
      else out.set(r.supplier_id, new Set([r.email_norm]));
    }
  } catch {
    // Pre-0133 database.
  }
  return out;
}

/** A slug-ish key for comparing a claim phrase to a claim type. */
/**
 * The approval every supplier-and-item pair holds BEFORE this run touches
 * anything (migration 0135), keyed `supplier|product`. Read once, up front, so
 * a dry run and the apply that follows it report the same "current" -- the
 * apply links a new pair as it goes, and reading afterwards would show a
 * `pending` row the dry run never saw.
 */
async function loadPairApprovals(
  db: D1Database,
  tenantId: string,
): Promise<Map<string, Pick<ProductSupplierLinkRow, 'approval_status' | 'approval_source' | 'approval_note'>>> {
  const res = await db
    .prepare(
      `SELECT supplier_id, product_id, approval_status, approval_source, approval_note
         FROM product_suppliers WHERE tenant_id = ?`,
    )
    .bind(tenantId)
    .all<{
      supplier_id: string;
      product_id: string;
      approval_status: ItemApprovalStatus;
      approval_source: ItemApprovalSource | null;
      approval_note: string | null;
    }>();
  const out = new Map<string, Pick<ProductSupplierLinkRow, 'approval_status' | 'approval_source' | 'approval_note'>>();
  for (const r of res.results ?? []) {
    out.set(`${r.supplier_id}|${r.product_id}`, {
      approval_status: r.approval_status,
      approval_source: r.approval_source ?? null,
      approval_note: r.approval_note ?? null,
    });
  }
  return out;
}

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

/** The note an import-set approval carries: where the answer came from. */
function importApprovalNote(fileName: string | null, lines: number[], status: ItemApprovalStatus): string {
  const where = `line${lines.length === 1 ? '' : 's'} ${lines.join(', ')}`;
  return `Supplier list${fileName ? ` "${fileName}"` : ''}, ${where}: Approved = ${status === 'approved' ? 'Y' : 'N'}`;
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
    requirements_held_unconfirmed: 0,
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
  const [vocab, claims, catalog, pairApprovals] = await Promise.all([
    loadRequirementVocab(db, input.tenantId),
    loadClaimVocab(db, input.tenantId),
    loadCatalogForMatching(db, input.tenantId),
    loadPairApprovals(db, input.tenantId),
  ]);
  // What the Approved column says about each supplier-and-item pair (0135).
  // One row of the list is supplier x product, so the approval is the PAIR's.
  const pairListings = new Map<
    string,
    { supplierKey: string; productId: string; label: string; lines: number[]; values: Set<boolean> }
  >();
  const approvalOutcomes: SupplierListApprovalOutcome[] = [];

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
          // The verified list says this supplier ships this product (0123):
          // record the link, stamped 'import', so per-product requirements
          // judge it. Same posture as findOrCreateSupplier above -- a dry run
          // writes nothing, and an existing link keeps what it already says.
          if (!input.dryRun && supplierId) {
            await linkProductToSupplier(db, input.tenantId, pm.product_id, supplierId, {
              source: 'import',
            });
          }
          if (r.approved !== null) {
            const pairKey = `${supplierKey}|${pm.product_id}`;
            const listing = pairListings.get(pairKey) ?? {
              supplierKey,
              productId: pm.product_id,
              label,
              lines: [],
              values: new Set<boolean>(),
            };
            listing.lines.push(r.line);
            listing.values.add(r.approved);
            pairListings.set(pairKey, listing);
          }
        } else {
          counts.products_unmatched++;
          unmatched.push({ line: r.line, kind: 'product', value: label, reason: pm.reason! });
          // No item, so no pair to approve. Said, not dropped.
          approvalOutcomes.push({
            lines: [r.line],
            supplier_id: supplierId,
            supplier_name: displayName,
            product_id: null,
            product_label: label,
            listed: r.approved === null ? null : r.approved ? 'approved' : 'not_approved',
            current: null,
            current_source: null,
            action: 'unresolved',
            reason: `${pm.reason} Its approval was not recorded.`,
          });
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

  // Item approvals (0135). Planned here, for both modes, by the same pure
  // rule the apply below executes -- so the dry run reports exactly what an
  // apply would write. An import NEVER overrides a person's decision.
  const approvalWrites: Array<{ supplierId: string; productId: string; status: ItemApprovalStatus; outcome: SupplierListApprovalOutcome }> = [];
  for (const listing of pairListings.values()) {
    const meta = supplierMeta.get(listing.supplierKey)!;
    const current = meta.id ? pairApprovals.get(`${meta.id}|${listing.productId}`) ?? null : null;
    const outcome: SupplierListApprovalOutcome = {
      lines: listing.lines,
      supplier_id: meta.id,
      supplier_name: meta.name,
      product_id: listing.productId,
      product_label: catalog.names.get(listing.productId) ?? listing.label,
      listed: null,
      current: current?.approval_status ?? null,
      current_source: current?.approval_source ?? null,
      action: 'conflict',
      reason: null,
    };
    if (listing.values.size > 1) {
      outcome.reason = `Lines ${listing.lines.join(', ')} disagree on Approved for this item. Nothing was changed.`;
    } else {
      const status: ItemApprovalStatus = listing.values.has(true) ? 'approved' : 'not_approved';
      outcome.listed = status;
      const plan = current
        ? planApprovalDecision(current, { status, note: importApprovalNote(input.fileName, listing.lines, status), source: 'import' })
        : { write: true, kept: null };
      if (plan.write) {
        outcome.action = 'set';
        if (meta.id) approvalWrites.push({ supplierId: meta.id, productId: listing.productId, status, outcome });
      } else if (plan.kept === 'person_decided') {
        outcome.action = 'kept_person';
        outcome.reason =
          current!.approval_status === status
            ? 'A person already decided this.'
            : `A person marked this ${ITEM_APPROVAL_LABELS[current!.approval_status].toLowerCase()}; the list does not override that.`;
      } else {
        outcome.action = 'unchanged';
      }
    }
    approvalOutcomes.push(outcome);
  }
  approvalOutcomes.sort((a, b) => (a.lines[0] ?? 0) - (b.lines[0] ?? 0));
  counts.approvals_set = approvalOutcomes.filter((a) => a.action === 'set').length;
  counts.approvals_unchanged = approvalOutcomes.filter((a) => a.action === 'unchanged').length;
  counts.approvals_kept_person_set = approvalOutcomes.filter((a) => a.action === 'kept_person').length;
  counts.approvals_unresolved = approvalOutcomes.filter((a) => a.action === 'unresolved').length;
  counts.approvals_conflicting = approvalOutcomes.filter((a) => a.action === 'conflict').length;

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
  counts.requirements_held_unconfirmed = cc.held_unconfirmed;
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
          tier: ch?.kind === 'keep_person' || ch?.kind === 'hold_unconfirmed' ? ch.tier : d.tier,
          action: action as SupplierListPreviewSupplier['lines'][number]['action'],
          from_tier:
            ch && (ch.kind === 'adopt_unconfirmed' || ch.kind === 'refresh_derived') ? ch.from_tier : ch?.kind === 'keep_person' || ch?.kind === 'hold_unconfirmed' ? ch.tier : null,
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

  // Contact addresses (0133). The column was parsed and only REPORTED until
  // there was somewhere to put it. Counted here for both modes - an address
  // the supplier already has is not counted and will not be touched - and
  // written below on apply.
  const knownContacts = await loadKnownContactEmails(db, input.tenantId);
  const contactWrites: Array<{ supplierId: string; email: string }> = [];
  counts.contacts_added = 0;
  for (const meta of supplierMeta.values()) {
    const known = meta.id ? knownContacts.get(meta.id) : undefined;
    const seen = new Set<string>();
    for (const email of meta.emails) {
      const norm = normalizeContactEmail(email);
      if (!norm || seen.has(norm) || known?.has(norm)) continue;
      seen.add(norm);
      counts.contacts_added++;
      if (meta.id) contactWrites.push({ supplierId: meta.id, email });
    }
  }

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
        case 'hold_unconfirmed':
          break;
      }
    }
    // The first chunk carries the run row; D1 batches are transactions, so a
    // failure in it leaves no run and no rows pointing at a missing run.
    for (let i = 0; i < stmts.length; i += 100) {
      await db.batch(stmts.slice(i, i + 100));
    }

    // After the requirement writes, and outside their batches: a contact is
    // not part of the derivation and must not be able to roll one back. Each
    // write is idempotent (recordImportedContact never touches an address the
    // supplier already has), so re-applying the same list adds nothing.
    for (const w of contactWrites) {
      try {
        await recordImportedContact(db, input.tenantId, w.supplierId, w.email, input.actorId);
      } catch (err) {
        console.error(
          '[supplier-list-import] recording a contact failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Item approvals, after the requirement writes and outside their batches
    // for the contacts' reason: an approval is not part of the derivation and
    // must not be able to roll one back. `decideItemApproval` is guarded in
    // SQL against a person's decision landing in between, and each pair it
    // changes gets the same audit row a person's decision writes.
    for (const w of approvalWrites) {
      try {
        const link = await loadProductSupplierLink(db, w.productId, w.supplierId);
        if (!link) continue;
        const note = importApprovalNote(input.fileName, w.outcome.lines, w.status);
        const result = await decideItemApproval(db, link, {
          status: w.status,
          note,
          source: 'import',
          actorId: input.actorId,
        });
        if (!result.changed) continue;
        await logAudit(
          db,
          input.actorId,
          input.tenantId,
          'product_supplier.approval_decided',
          'supplier',
          w.supplierId,
          JSON.stringify({
            supplier_name: w.outcome.supplier_name,
            product_id: w.productId,
            product_name: w.outcome.product_label,
            approval_status: result.status,
            approval_note: result.note,
            approval_source: 'import',
            via: 'supplier_list_import',
            run_id: runId,
            lines: w.outcome.lines,
            previous: result.previous,
          }),
          input.ip,
        );
      } catch (err) {
        console.error(
          '[supplier-list-import] recording an item approval failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
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
    approvals: approvalOutcomes,
    rule_problems: derivation.problems.map(describeProblem),
    unrecognized_headers: input.unrecognizedHeaders ?? [],
    rules: {
      baseline: rules.baseline.map((b) => b.slug),
      category_packets: { ...rules.categoryPackets },
      product_spec_sheet: rules.productSpecSheet?.slug ?? null,
    },
  };
}
