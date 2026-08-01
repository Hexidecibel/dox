import { generateId } from './db';
import { BadRequestError } from './permissions';
import type {
  RenewalType,
  RegistryFacet,
  RegistryLinkStatus,
  RegistryLinkSource,
  ClaimSubjectType,
  ClaimSubjectGrain,
  ClassificationStatus,
} from '../../shared/types';

/**
 * IDP Document Registry helpers (migrations 0076-0081).
 *
 * The registry models THREE independent questions per document, each with its
 * own per-tenant vocabulary:
 *
 *   layer 1 — what it IS        documents.document_type_id (ONE value)
 *   layer 2 — what it SATISFIES requirements (MANY)  — CLOSES checklist items
 *   layer 3 — what it TRIGGERS  claim_types (MANY)   — OPENS checklist items
 *
 * Layers 2 and 3 are structurally identical: a tenant-scoped vocabulary table
 * plus a document junction carrying a human-in-the-loop status. This module
 * therefore drives both through ONE facet-descriptor table (FACETS) rather
 * than a hand-written pair of sync functions per facet. Adding a facet is a
 * descriptor entry, not a new code path.
 *
 * Shared by the manual single-doc upload path (POST /api/documents/ingest)
 * and the post-upload editor (PUT /api/documents/:id).
 */

// ---------------------------------------------------------------------------
// Renewal (migration 0077)
// ---------------------------------------------------------------------------

/** The renewal_type CHECK set (migration 0077). */
export const RENEWAL_TYPES: readonly RenewalType[] = [
  'renewal_application',
  'hard_expiry',
  'keep_current',
  'review_cycle',
];

export function isValidRenewalType(value: string): value is RenewalType {
  return (RENEWAL_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Classification lifecycle (migration 0081)
// ---------------------------------------------------------------------------

/**
 * The classification_status CHECK set. 'unclassified' (never touched) and
 * 'unclassifiable' (a human reviewed it and it genuinely fits no type) are
 * deliberately distinct so a terminal judgment stops inflating the backlog.
 */
export const CLASSIFICATION_STATUSES: readonly ClassificationStatus[] = [
  'unclassified',
  'needs_review',
  'classified',
  'unclassifiable',
];

export function isValidClassificationStatus(
  value: string,
): value is ClassificationStatus {
  return (CLASSIFICATION_STATUSES as readonly string[]).includes(value);
}

/** The two states that mean "a human has ruled on this document". */
export const REVIEWED_CLASSIFICATION_STATUSES: readonly ClassificationStatus[] = [
  'classified',
  'unclassifiable',
];

export function isReviewedClassification(value: string): boolean {
  return (REVIEWED_CLASSIFICATION_STATUSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Facet link vocabulary (migration 0080)
// ---------------------------------------------------------------------------

/**
 * Human-in-the-loop states, matching the junction CHECK constraints. Nothing
 * auto-confirms: a machine-proposed link lands 'suggested'. 'rejected' rows
 * are retained, not deleted, so the same wrong suggestion is not re-proposed.
 */
export const REGISTRY_LINK_STATUSES: readonly RegistryLinkStatus[] = [
  'suggested',
  'confirmed',
  'rejected',
];

export function isValidLinkStatus(value: string): value is RegistryLinkStatus {
  return (REGISTRY_LINK_STATUSES as readonly string[]).includes(value);
}

/**
 * Known link provenances. Deliberately NOT a DB CHECK — the set grows with new
 * pipelines and a CHECK would force a SQLite table rebuild each time. Validated
 * here instead.
 */
export const REGISTRY_LINK_SOURCES: readonly RegistryLinkSource[] = [
  'human',
  'extraction',
  'rule',
  'import',
];

export function isValidLinkSource(value: string): value is RegistryLinkSource {
  return (REGISTRY_LINK_SOURCES as readonly string[]).includes(value);
}

/**
 * Claim subject grains. Also not a DB CHECK — the product-vs-supplier/facility
 * question is unresolved with the client and a non-food vertical will want its
 * own grain, so this must be extensible without a migration.
 */
export const CLAIM_SUBJECT_TYPES: readonly ClaimSubjectType[] = [
  'tenant',
  'product',
  'supplier',
  'facility',
];

export function isValidClaimSubjectType(value: string): value is ClaimSubjectType {
  return (CLAIM_SUBJECT_TYPES as readonly string[]).includes(value);
}

export const CLAIM_SUBJECT_GRAINS: readonly ClaimSubjectGrain[] = [
  'any',
  ...CLAIM_SUBJECT_TYPES,
];

export function isValidClaimSubjectGrain(value: string): value is ClaimSubjectGrain {
  return (CLAIM_SUBJECT_GRAINS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Facet descriptors
// ---------------------------------------------------------------------------

/**
 * One link a document asserts against a facet vocabulary. `id` is the
 * vocabulary row id (a requirement id or a claim_type id). The remaining
 * fields are optional and default via SyncFacetOptions.
 */
export interface FacetLinkInput {
  id: string;
  status?: RegistryLinkStatus;
  source?: string;
  confidence?: number | null;
  notes?: string | null;
  /** claim facet only — what the claim is ABOUT. */
  subjectType?: string;
  subjectId?: string | null;
  /** claim facet only — the snippet the claim was read from. */
  evidence?: string | null;
}

interface FacetSpec {
  facet: RegistryFacet;
  /** Per-tenant vocabulary table. */
  vocabTable: string;
  /** Document junction table. */
  junctionTable: string;
  /** FK column on the junction pointing at the vocabulary. */
  vocabColumn: string;
  /** Human-readable noun for error messages. */
  label: string;
  /** Columns beyond the shared set, and how to fill them from a link. */
  buildExtra(link: FacetLinkInput): { columns: string[]; values: unknown[] };
}

export const FACETS: Record<RegistryFacet, FacetSpec> = {
  requirement: {
    facet: 'requirement',
    vocabTable: 'requirements',
    junctionTable: 'document_requirements',
    vocabColumn: 'requirement_id',
    label: 'requirement',
    buildExtra: () => ({ columns: [], values: [] }),
  },
  claim: {
    facet: 'claim',
    vocabTable: 'claim_types',
    junctionTable: 'document_claims',
    vocabColumn: 'claim_type_id',
    label: 'claim type',
    buildExtra: (link) => ({
      columns: ['subject_type', 'subject_id', 'evidence'],
      values: [
        link.subjectType ?? 'tenant',
        link.subjectId ?? null,
        link.evidence ?? null,
      ],
    }),
  },
};

export function getFacetSpec(facet: RegistryFacet): FacetSpec {
  const spec = FACETS[facet];
  if (!spec) throw new BadRequestError(`Unknown registry facet: ${facet}`);
  return spec;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a form/body value that should be a JSON array of strings. Returns the
 * cleaned array (trimmed, empties dropped). Throws BadRequestError with the
 * given field name on malformed input. `null`/`undefined` yield [].
 */
export function parseStringArray(
  raw: string | string[] | null | undefined,
  field: string,
): string[] {
  if (raw == null) return [];
  let arr: unknown = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return [];
    try {
      arr = JSON.parse(raw);
    } catch {
      throw new BadRequestError(`${field} must be a valid JSON array`);
    }
  }
  if (!Array.isArray(arr)) {
    throw new BadRequestError(`${field} must be a JSON array of strings`);
  }
  return arr
    .filter((v) => typeof v === 'string')
    .map((v) => (v as string).trim())
    .filter(Boolean);
}

/**
 * Parse a facet link list from a multipart form field or a JSON body value.
 *
 * Accepts BOTH shapes so a simple UI multi-select and a rich extraction payload
 * can post to the same endpoint:
 *   ["req_a","req_b"]                        — bare ids
 *   [{"id":"req_a","status":"suggested"}]    — full link objects
 * Mixed arrays are fine. Validates status/source/subject_type against the open
 * sets above so a typo fails loudly at the edge rather than silently persisting.
 */
export function parseFacetLinks(
  raw: string | unknown[] | null | undefined,
  field: string,
): FacetLinkInput[] {
  if (raw == null) return [];
  let arr: unknown = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return [];
    try {
      arr = JSON.parse(raw);
    } catch {
      throw new BadRequestError(`${field} must be a valid JSON array`);
    }
  }
  if (!Array.isArray(arr)) {
    throw new BadRequestError(`${field} must be a JSON array`);
  }

  const links: FacetLinkInput[] = [];
  for (const entry of arr) {
    if (typeof entry === 'string') {
      const id = entry.trim();
      if (id) links.push({ id });
      continue;
    }
    if (!entry || typeof entry !== 'object') {
      throw new BadRequestError(
        `${field} entries must be strings or objects with an id`,
      );
    }
    const obj = entry as Record<string, unknown>;
    const id = typeof obj.id === 'string' ? obj.id.trim() : '';
    if (!id) throw new BadRequestError(`${field} entries must have an id`);

    const link: FacetLinkInput = { id };

    if (obj.status != null) {
      const status = String(obj.status);
      if (!isValidLinkStatus(status)) {
        throw new BadRequestError(
          `${field}: invalid status "${status}" (expected ${REGISTRY_LINK_STATUSES.join(', ')})`,
        );
      }
      link.status = status;
    }
    if (obj.source != null) {
      const source = String(obj.source);
      if (!isValidLinkSource(source)) {
        throw new BadRequestError(
          `${field}: invalid source "${source}" (expected ${REGISTRY_LINK_SOURCES.join(', ')})`,
        );
      }
      link.source = source;
    }
    if (obj.confidence != null) {
      const confidence = Number(obj.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        throw new BadRequestError(`${field}: confidence must be between 0 and 1`);
      }
      link.confidence = confidence;
    }
    if (typeof obj.notes === 'string') link.notes = obj.notes;
    if (typeof obj.evidence === 'string') link.evidence = obj.evidence;

    const subjectType = obj.subject_type ?? obj.subjectType;
    if (subjectType != null) {
      const st = String(subjectType);
      if (!isValidClaimSubjectType(st)) {
        throw new BadRequestError(
          `${field}: invalid subject_type "${st}" (expected ${CLAIM_SUBJECT_TYPES.join(', ')})`,
        );
      }
      link.subjectType = st;
    }
    const subjectId = obj.subject_id ?? obj.subjectId;
    if (subjectId != null) {
      const sid = String(subjectId).trim();
      link.subjectId = sid || null;
    }

    links.push(link);
  }
  return links;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Ensure every id in `ids` exists in `table` and belongs to `tenantId`. One
 * implementation behind every facet's validator, so a cross-tenant id can
 * never slip through one facet because its check was written separately.
 */
async function validateTenantScopedIds(
  db: D1Database,
  table: string,
  tenantId: string,
  ids: string[],
  label: string,
): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const placeholders = unique.map(() => '?').join(',');
  const rows = await db
    .prepare(`SELECT id FROM ${table} WHERE id IN (${placeholders}) AND tenant_id = ?`)
    .bind(...unique, tenantId)
    .all<{ id: string }>();
  const valid = new Set(rows.results.map((r) => r.id));
  const invalid = unique.filter((id) => !valid.has(id));
  if (invalid.length > 0) {
    throw new BadRequestError(
      `Invalid ${label}(s) for this tenant: ${invalid.join(', ')}`,
    );
  }
}

/**
 * Ensure every vocabulary id referenced by `links` belongs to `tenantId`.
 * Throws BadRequestError listing the offenders. No-op for an empty list.
 */
export async function validateFacetIds(
  db: D1Database,
  facet: RegistryFacet,
  tenantId: string,
  links: Array<FacetLinkInput | string>,
): Promise<void> {
  const spec = getFacetSpec(facet);
  const ids = links.map((l) => (typeof l === 'string' ? l : l.id));
  await validateTenantScopedIds(db, spec.vocabTable, tenantId, ids, spec.label);
}

/**
 * Ensure a claim's (subject_type, subject_id) pair is coherent and in-tenant.
 *
 * The junction cannot carry a real FK — the column is polymorphic — and an FK
 * would not have bought tenant safety anyway (it cannot stop a cross-tenant
 * product id). So the check lives here, where the tenant IS known:
 *   tenant   — must carry no subject_id
 *   product  — must exist in products for this tenant
 *   supplier — must exist in suppliers for this tenant
 *   facility — free-text; facilities are not an entity yet (they live as names
 *              in documents.applies_to), so only non-emptiness is enforced
 */
export async function validateClaimSubjects(
  db: D1Database,
  tenantId: string,
  links: FacetLinkInput[],
): Promise<void> {
  const productIds: string[] = [];
  const supplierIds: string[] = [];

  for (const link of links) {
    const subjectType = link.subjectType ?? 'tenant';
    const subjectId = link.subjectId ?? null;

    if (subjectType === 'tenant') {
      if (subjectId) {
        throw new BadRequestError(
          'A tenant-scoped claim must not carry a subject_id',
        );
      }
      continue;
    }
    if (!subjectId) {
      throw new BadRequestError(
        `A ${subjectType}-scoped claim requires a subject_id`,
      );
    }
    if (subjectType === 'product') productIds.push(subjectId);
    else if (subjectType === 'supplier') supplierIds.push(subjectId);
    // 'facility' — non-empty is all we can check today.
  }

  await validateTenantScopedIds(db, 'products', tenantId, productIds, 'claim subject product');
  await validateTenantScopedIds(db, 'suppliers', tenantId, supplierIds, 'claim subject supplier');
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export interface SyncFacetOptions {
  /** Status for links that do not specify one. Default 'confirmed' — this is
   *  the human editing path. Machine callers must pass 'suggested'. (The DB
   *  column default is 'suggested', i.e. the fail-safe, for direct inserts.) */
  defaultStatus?: RegistryLinkStatus;
  /** Provenance for links that do not specify one. Default 'human'. */
  defaultSource?: string;
  /** User id recorded as created_by, and as confirmed_by on confirmed links. */
  actorId?: string | null;
  /** Keep existing 'rejected' rows instead of clearing them, so a re-run of an
   *  extraction pass cannot resurrect a link a human already turned down.
   *  Default false: an explicit human replacement of the set is authoritative. */
  preserveRejected?: boolean;
}

/**
 * REPLACE a document's link set for one facet.
 *
 * Deletes the document's existing rows in that facet's junction and inserts
 * one per link. Inserts use INSERT OR IGNORE so the junction's uniqueness
 * guard makes the operation idempotent — for claims that guard is the
 * expression index on (document_id, claim_type_id, subject_type,
 * COALESCE(subject_id,'')), which is why a duplicate tenant-wide claim cannot
 * be inserted twice despite subject_id being NULL.
 *
 * Callers are expected to have run validateFacetIds (and, for claims,
 * validateClaimSubjects) first.
 */
export async function syncDocumentFacet(
  db: D1Database,
  facet: RegistryFacet,
  documentId: string,
  links: Array<FacetLinkInput | string>,
  options: SyncFacetOptions = {},
): Promise<void> {
  const spec = getFacetSpec(facet);
  const {
    defaultStatus = 'confirmed',
    defaultSource = 'human',
    actorId = null,
    preserveRejected = false,
  } = options;

  const deleteSql = preserveRejected
    ? `DELETE FROM ${spec.junctionTable} WHERE document_id = ? AND status <> 'rejected'`
    : `DELETE FROM ${spec.junctionTable} WHERE document_id = ?`;
  await db.prepare(deleteSql).bind(documentId).run();

  // Deduplicate on the vocabulary id plus (for claims) the subject, mirroring
  // the DB uniqueness guard so a payload with repeats does not silently drop
  // rows via OR IGNORE with an unpredictable winner.
  const seen = new Set<string>();
  const normalized: FacetLinkInput[] = [];
  for (const raw of links) {
    const link: FacetLinkInput = typeof raw === 'string' ? { id: raw } : raw;
    if (!link.id) continue;
    const key = `${link.id} ${link.subjectType ?? 'tenant'} ${link.subjectId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(link);
  }

  const now = new Date().toISOString();
  for (const link of normalized) {
    const status = link.status ?? defaultStatus;
    const source = link.source ?? defaultSource;
    const extra = spec.buildExtra(link);

    const columns = [
      'id',
      'document_id',
      spec.vocabColumn,
      'status',
      'source',
      'confidence',
      'notes',
      'created_by',
      'confirmed_at',
      'confirmed_by',
      ...extra.columns,
    ];
    const values = [
      generateId(),
      documentId,
      link.id,
      status,
      source,
      link.confidence ?? null,
      link.notes ?? null,
      actorId,
      status === 'confirmed' ? now : null,
      status === 'confirmed' ? actorId : null,
      ...extra.values,
    ];

    await db
      .prepare(
        `INSERT OR IGNORE INTO ${spec.junctionTable} (${columns.join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})`,
      )
      .bind(...values)
      .run();
  }
}

/**
 * Load a document's link set for one facet, vocabulary joined in and ordered
 * the way the tenant configured its vocabulary.
 */
export async function listDocumentFacet<T = Record<string, unknown>>(
  db: D1Database,
  facet: RegistryFacet,
  documentId: string,
): Promise<T[]> {
  const spec = getFacetSpec(facet);
  const rows = await db
    .prepare(
      `SELECT j.*, v.name AS vocab_name, v.slug AS vocab_slug
         FROM ${spec.junctionTable} j
         JOIN ${spec.vocabTable} v ON v.id = j.${spec.vocabColumn}
        WHERE j.document_id = ?
        ORDER BY v.sort_order, v.name`,
    )
    .bind(documentId)
    .all<T>();
  return rows.results;
}

/**
 * The requirements a set of confirmed claims OPENS, via claim_type_requirements.
 * This is the half of gap detection that belongs in the shared lib: P4's gap
 * view subtracts the requirements documents CLOSE from what this returns.
 * `requiredOnly` drops advisory (is_required = 0) mappings.
 */
export async function requirementsOpenedByClaims(
  db: D1Database,
  tenantId: string,
  claimTypeIds: string[],
  requiredOnly = true,
): Promise<string[]> {
  const unique = [...new Set(claimTypeIds)].filter(Boolean);
  if (unique.length === 0) return [];
  const placeholders = unique.map(() => '?').join(',');
  const rows = await db
    .prepare(
      `SELECT DISTINCT requirement_id
         FROM claim_type_requirements
        WHERE tenant_id = ?
          AND claim_type_id IN (${placeholders})
          ${requiredOnly ? 'AND is_required = 1' : ''}`,
    )
    .bind(tenantId, ...unique)
    .all<{ requirement_id: string }>();
  return rows.results.map((r) => r.requirement_id);
}

// ---------------------------------------------------------------------------
// RETIRED — document_categories (migration 0076)
// ---------------------------------------------------------------------------
//
// document_requirements supersedes this junction: it pointed at document_types
// (layer-1 vocabulary) but was used with layer-2 semantics ("pick every
// document type this satisfies"). It cannot be dropped yet — migration 0079's
// documents_fts_source VIEW reads it to build category_text and every document
// FTS trigger writes through that view, so the DROP has to happen inside P3's
// FTS DROP+recreate. Until then these three keep the shipped write path alive.
// Do NOT add new callers.

/**
 * @deprecated Use validateFacetIds('requirement', ...). Retired with
 * document_categories in P3.
 */
export async function validateCategoryIds(
  db: D1Database,
  tenantId: string,
  ids: string[],
): Promise<void> {
  await validateTenantScopedIds(db, 'document_types', tenantId, ids, 'document type');
}

/**
 * Resolve which category id is the primary. Prefers an explicit
 * `primaryCategoryId` when it is one of the categories; otherwise the first
 * category. Returns null when there are no categories.
 *
 * @deprecated Layer 1 is documents.document_type_id, set directly. Retired
 * with document_categories in P3.
 */
export function resolvePrimaryCategoryId(
  categoryIds: string[],
  primaryCategoryId: string | null | undefined,
): string | null {
  if (categoryIds.length === 0) return null;
  if (primaryCategoryId && categoryIds.includes(primaryCategoryId)) {
    return primaryCategoryId;
  }
  return categoryIds[0];
}

/**
 * REPLACE a document's category set. Deletes existing document_categories rows
 * and inserts one per id, flagging `primaryId` as is_primary. Idempotent via
 * the UNIQUE(document_id, document_type_id) guard. The Phase-1 FTS triggers on
 * document_categories keep category_text in sync.
 *
 * @deprecated Use syncDocumentFacet('requirement', ...). Retired with
 * document_categories in P3.
 */
export async function syncDocumentCategories(
  db: D1Database,
  documentId: string,
  categoryIds: string[],
  primaryId: string | null,
): Promise<void> {
  await db
    .prepare('DELETE FROM document_categories WHERE document_id = ?')
    .bind(documentId)
    .run();
  const unique = [...new Set(categoryIds)];
  for (const catId of unique) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO document_categories (id, document_id, document_type_id, is_primary)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(generateId(), documentId, catId, catId === primaryId ? 1 : 0)
      .run();
  }
}
