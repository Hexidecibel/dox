/**
 * The database half of "the current document of type T for supplier S and
 * item P" (migration 0138). The ranking itself is pure and lives in
 * shared/currentDocument.ts -- read its header for the rule.
 *
 * WHAT A CANDIDATE IS. An ACTIVE document of this organization, of the
 * supplier asked for, whose current version has a file behind it -- the same
 * bar a hand pick onto an order meets (functions/lib/order-items.ts). Nothing
 * here reads the sharing rule: whether a document may LEAVE is a different
 * question, asked at the send and at the release, against the live rule.
 *
 * WHICH TYPES COUNT (migration 0069). A document type is either the
 * organization's (`supplier_id` NULL) or one supplier's own. A person picks
 * ONE type; the documents that answer it are those filed under that type, or
 * under a type OF THE SAME NAME that is the organization's or this supplier's
 * own -- so "Spec Sheet" finds the document whether the supplier's spec sheets
 * were filed under the shared type or under that supplier's. A type that
 * belongs to a DIFFERENT supplier does not apply to this pair, and that is
 * said rather than answered "missing".
 *
 * WHEN IT EXPIRES. The document's own due date is `resolveRenewalExpiry`
 * (shared/renewalPeriod.ts), the one place that question is answered -- the
 * same date the Renewals page and the alert run use. NEVER `expiration_date`:
 * that is the PRODUCT's shelf life.
 */

import { resolveDueDate } from './expirations';
import {
  resolveCurrentDocument,
  type CurrentDocumentCandidate,
  type CurrentDocumentResult,
} from '../../shared/currentDocument';

export interface CurrentDocumentAsk {
  product_id: string;
  supplier_id: string;
  document_type_id: string;
}

export interface ResolvedCurrentDocument extends CurrentDocumentResult {
  /** Set when the type does not apply to this supplier at all; nothing was looked up. */
  not_applicable: string | null;
}

export function currentDocumentKey(ask: CurrentDocumentAsk): string {
  return `${ask.product_id}|${ask.supplier_id}|${ask.document_type_id}`;
}

/** Today, UTC, as the renewal engine reads it. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Newest candidates read per (supplier, type). Past this the two tiers are
 * read on their own, so a supplier with thousands of certificates still gets
 * an exact answer.
 */
const CANDIDATE_CAP = 300;
const TIER_CAP = 25;

interface TypeRow {
  id: string;
  name: string;
  supplier_id: string | null;
}

function typeNameKey(name: string | null | undefined): string {
  return (name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Every document type of the organization, active or not: a retired type still names documents. */
export async function loadTenantDocumentTypes(db: D1Database, tenantId: string): Promise<Map<string, TypeRow>> {
  const res = await db
    .prepare('SELECT id, name, supplier_id FROM document_types WHERE tenant_id = ?')
    .bind(tenantId)
    .all<TypeRow>();
  return new Map((res.results ?? []).map((t) => [t.id, t]));
}

/**
 * The type ids whose documents answer "type T for supplier S", or a sentence
 * saying why T does not apply to S.
 */
export function typeFamilyFor(
  types: ReadonlyMap<string, TypeRow>,
  typeId: string,
  supplierId: string,
): { ids: string[]; not_applicable: string | null } {
  const picked = types.get(typeId);
  if (!picked) return { ids: [], not_applicable: 'That document type is not in this organization.' };
  if (picked.supplier_id && picked.supplier_id !== supplierId) {
    return {
      ids: [],
      not_applicable: `"${picked.name}" is another supplier's own document type, so it does not apply to this supplier.`,
    };
  }
  const key = typeNameKey(picked.name);
  const ids = [...types.values()]
    .filter((t) => typeNameKey(t.name) === key && (t.supplier_id === null || t.supplier_id === supplierId))
    .map((t) => t.id);
  if (!ids.includes(picked.id)) ids.push(picked.id);
  return { ids, not_applicable: null };
}

const CANDIDATE_COLUMNS = `
  d.id                      AS document_id,
  d.title                   AS title,
  d.current_version         AS version_number,
  COALESCE(d.approved_at, d.created_at) AS effective_at,
  d.created_at              AS created_at,
  d.renewal_type            AS renewal_type,
  d.renewal_due_date        AS renewal_due_date,
  d.renewal_interval_months AS renewal_interval_months,
  d.renewal_decision        AS renewal_decision,
  json_extract(d.primary_metadata, '$.document_expires_on') AS meta_document_expires_on,
  json_extract(d.primary_metadata, '$.effective_date')      AS meta_effective_date,
  dt.renewal_policy          AS type_renewal_policy,
  dt.renewal_interval_months AS type_renewal_interval_months,
  dt.renewal_window          AS type_renewal_window,
  (SELECT group_concat(dp.product_id) FROM document_products dp WHERE dp.document_id = d.id) AS product_ids`;

const CANDIDATE_FROM = `
  FROM documents d
  INNER JOIN document_types dt ON dt.id = d.document_type_id AND dt.tenant_id = d.tenant_id
  INNER JOIN document_versions dv ON dv.document_id = d.id AND dv.version_number = d.current_version`;

const CANDIDATE_ORDER = 'ORDER BY COALESCE(d.approved_at, d.created_at) DESC, d.created_at DESC, d.id DESC';

interface CandidateSqlRow {
  document_id: string;
  title: string | null;
  version_number: number | null;
  effective_at: string | null;
  created_at: string | null;
  renewal_type: string | null;
  renewal_due_date: string | null;
  renewal_interval_months: number | null;
  renewal_decision: string | null;
  meta_document_expires_on: string | null;
  meta_effective_date: string | null;
  type_renewal_policy: string | null;
  type_renewal_interval_months: number | null;
  type_renewal_window: string | null;
  product_ids: string | null;
}

function dueDateOf(r: CandidateSqlRow): string | null {
  return resolveDueDate({
    renewal_type: r.renewal_type,
    renewal_due_date: r.renewal_due_date,
    renewal_interval_months: r.renewal_interval_months,
    renewal_decision: r.renewal_decision,
    meta_document_expires_on: r.meta_document_expires_on,
    meta_effective_date: r.meta_effective_date,
    type_renewal_policy: r.type_renewal_policy,
    type_renewal_interval_months: r.type_renewal_interval_months,
    type_renewal_window: r.type_renewal_window,
  });
}

function toCandidate(r: CandidateSqlRow): CurrentDocumentCandidate {
  return {
    document_id: r.document_id,
    title: r.title,
    version_number: r.version_number,
    effective_at: r.effective_at,
    created_at: r.created_at,
    product_ids: r.product_ids ? r.product_ids.split(',').filter(Boolean) : [],
    due_date: dueDateOf(r),
  };
}

/**
 * Resolve many asks at once. One read per (supplier, type) -- an order for
 * twenty items of one supplier is one read per type, not twenty.
 */
export async function resolveCurrentDocuments(
  db: D1Database,
  tenantId: string,
  asks: readonly CurrentDocumentAsk[],
  today: string = todayIso(),
): Promise<Map<string, ResolvedCurrentDocument>> {
  const out = new Map<string, ResolvedCurrentDocument>();
  if (asks.length === 0) return out;
  const types = await loadTenantDocumentTypes(db, tenantId);

  const groups = new Map<string, { supplierId: string; typeIds: string[]; asks: CurrentDocumentAsk[] }>();
  for (const ask of asks) {
    const family = typeFamilyFor(types, ask.document_type_id, ask.supplier_id);
    if (family.not_applicable) {
      out.set(currentDocumentKey(ask), {
        resolution: 'missing',
        document_id: null,
        title: null,
        version_number: null,
        due_date: null,
        basis: null,
        tied_with: [],
        in_date_alternative: null,
        note: null,
        not_applicable: family.not_applicable,
      });
      continue;
    }
    const ids = [...family.ids].sort();
    const key = `${ask.supplier_id}|${ids.join(',')}`;
    const g = groups.get(key) ?? { supplierId: ask.supplier_id, typeIds: ids, asks: [] };
    g.asks.push(ask);
    groups.set(key, g);
  }

  for (const g of groups.values()) {
    const typeSql = g.typeIds.map(() => '?').join(', ');
    const where = `WHERE d.tenant_id = ? AND d.status = 'active' AND d.supplier_id = ?
                     AND d.document_type_id IN (${typeSql})
                     AND dv.r2_key IS NOT NULL AND dv.r2_key != ''`;
    const base = [tenantId, g.supplierId, ...g.typeIds];
    const res = await db
      .prepare(`SELECT ${CANDIDATE_COLUMNS} ${CANDIDATE_FROM} ${where} ${CANDIDATE_ORDER} LIMIT ?`)
      .bind(...base, CANDIDATE_CAP)
      .all<CandidateSqlRow>();
    const byId = new Map<string, CurrentDocumentCandidate>();
    for (const r of res.results ?? []) byId.set(r.document_id, toCandidate(r));

    // At the cap the newest N may hold neither tier's best. Read each tier on
    // its own so the answer does not depend on how many certificates there are.
    if ((res.results ?? []).length >= CANDIDATE_CAP) {
      const unlinked = await db
        .prepare(
          `SELECT ${CANDIDATE_COLUMNS} ${CANDIDATE_FROM} ${where}
              AND NOT EXISTS (SELECT 1 FROM document_products x WHERE x.document_id = d.id)
            ${CANDIDATE_ORDER} LIMIT ?`,
        )
        .bind(...base, TIER_CAP)
        .all<CandidateSqlRow>();
      for (const r of unlinked.results ?? []) byId.set(r.document_id, toCandidate(r));
      for (const productId of new Set(g.asks.map((a) => a.product_id))) {
        const linked = await db
          .prepare(
            `SELECT ${CANDIDATE_COLUMNS} ${CANDIDATE_FROM} ${where}
                AND EXISTS (SELECT 1 FROM document_products x WHERE x.document_id = d.id AND x.product_id = ?)
              ${CANDIDATE_ORDER} LIMIT ?`,
          )
          .bind(...base, productId, TIER_CAP)
          .all<CandidateSqlRow>();
        for (const r of linked.results ?? []) byId.set(r.document_id, toCandidate(r));
      }
    }

    const candidates = [...byId.values()];
    for (const ask of g.asks) {
      out.set(currentDocumentKey(ask), {
        ...resolveCurrentDocument(candidates, ask.product_id, today),
        not_applicable: null,
      });
    }
  }
  return out;
}

export interface DocumentLiveFacts {
  document_id: string;
  title: string | null;
  status: string | null;
  current_version: number | null;
  has_file: boolean;
  due_date: string | null;
  document_type_name: string | null;
}

/**
 * What the documents already on an order's lines are NOW: status, whether the
 * current version has a file, and the due date resolved today. Tenant scoped;
 * an id that is not this organization's is simply absent.
 */
export async function loadDocumentLiveFacts(
  db: D1Database,
  tenantId: string,
  documentIds: readonly string[],
): Promise<Map<string, DocumentLiveFacts>> {
  const out = new Map<string, DocumentLiveFacts>();
  const ids = [...new Set(documentIds.filter(Boolean))];
  const CHUNK = 80;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const res = await db
      .prepare(
        `SELECT d.id AS document_id, d.title AS title, d.status AS status,
                d.current_version AS version_number,
                d.created_at AS created_at, d.created_at AS effective_at,
                d.renewal_type AS renewal_type, d.renewal_due_date AS renewal_due_date,
                d.renewal_interval_months AS renewal_interval_months, d.renewal_decision AS renewal_decision,
                json_extract(d.primary_metadata, '$.document_expires_on') AS meta_document_expires_on,
                json_extract(d.primary_metadata, '$.effective_date')      AS meta_effective_date,
                dt.renewal_policy AS type_renewal_policy,
                dt.renewal_interval_months AS type_renewal_interval_months,
                dt.renewal_window AS type_renewal_window,
                dt.name AS document_type_name,
                dv.r2_key AS r2_key,
                NULL AS product_ids
           FROM documents d
           LEFT JOIN document_types dt ON dt.id = d.document_type_id AND dt.tenant_id = d.tenant_id
           LEFT JOIN document_versions dv ON dv.document_id = d.id AND dv.version_number = d.current_version
          WHERE d.tenant_id = ? AND d.id IN (${part.map(() => '?').join(', ')})`,
      )
      .bind(tenantId, ...part)
      .all<CandidateSqlRow & { status: string | null; r2_key: string | null; document_type_name: string | null }>();
    for (const r of res.results ?? []) {
      out.set(r.document_id, {
        document_id: r.document_id,
        title: r.title,
        status: r.status,
        current_version: r.version_number,
        has_file: Boolean(r.r2_key),
        due_date: dueDateOf(r),
        document_type_name: r.document_type_name,
      });
    }
  }
  return out;
}
