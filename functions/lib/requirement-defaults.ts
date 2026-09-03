import { generateId, logAudit } from './db';
import type { RegistryLinkSource, RegistryLinkStatus } from '../../shared/types';

/**
 * The producer that makes an approved document actually close checklist items.
 *
 * WHY THIS EXISTS
 * ---------------
 * The registry's layer 2 — `requirements` + `document_requirements` (migration
 * 0080) — and the gap engine built on it have been running on data that
 * NOTHING PRODUCED. `syncDocumentFacets` (functions/lib/registry.ts) is
 * reachable from exactly two places, POST /api/documents/ingest and
 * PUT /api/documents/:id, and both of them require the CALLER to name the
 * requirement ids. The approve path in functions/lib/kinds/coa.ts — the door
 * nearly every real document comes through — writes documents, versions,
 * products, lots and reviewer captures, and zero `document_requirements` rows.
 *
 * So an approved COA closed nothing, ever, unless a human opened the document
 * detail page and ticked boxes. This module reads the per-tenant
 * type → requirements mapping added by migration 0100 and turns it into
 * 'suggested' links the moment the document row exists.
 *
 * GATED ON CONFIGURATION EXISTING
 * -------------------------------
 * A tenant with no `document_type_requirements` rows and no
 * `document_types.default_owner` gets NO WRITE OF ANY KIND — not an audit row,
 * not an owner UPDATE that would churn the non-column-scoped
 * `trg_documents_au_fts` trigger. Its behaviour is BYTE-IDENTICAL to before
 * this shipped, which matters because this lands on existing tenants who never
 * asked for it. Migration 0100 inserts zero mapping rows and backfills no
 * default_owner, so that is EVERY tenant on the day it lands.
 *
 * The two halves are gated SEPARATELY, on their own configuration. A tenant
 * that sets a type's default_owner but writes no requirement mappings still
 * gets its owner defaulted; making one depend on the other would produce a
 * setting that is visibly configured and silently inert.
 *
 * SUGGESTS, NEVER DECIDES
 * -----------------------
 * Links land 'suggested' with source 'rule'. This is a guess made from a
 * document's TYPE, before anyone has looked at the document — precisely the
 * kind of machine proposal the registry's human-in-the-loop status exists for.
 * Confirming is a human act on the document detail page, which is the path
 * registry.ts already documents as defaulting to 'confirmed'.
 *
 * NEVER THROWS INTO THE CALLER
 * ----------------------------
 * Same shape, and the same reasoning, as the enqueue in
 * functions/api/supplier-requests/public/[token]/upload.ts: the caller has
 * already written a document row, and destroying an approval because a
 * SUGGESTION could not be written would be the worst trade available. Every
 * failure degrades to "the document exists and nobody suggested anything yet",
 * which is exactly the state that existed before 0100 — a safe floor, not a
 * broken one. The failure is made findable in two places: `console.error` for
 * whoever is tailing the worker, and a `requirement_defaults.failed` audit row,
 * which is the surface an operator actually has.
 */

/** What a link proposed by this module looks like. Both literals are checked
 *  against the vocabularies in functions/lib/registry.ts:
 *  - 'suggested' is in REGISTRY_LINK_STATUSES and in the
 *    `document_requirements.status` CHECK (0080).
 *  - 'rule' is in REGISTRY_LINK_SOURCES. `source` carries no DB CHECK by
 *    design, so the type is the guard.
 *  Typed, not inlined, so a rename in shared/types.ts breaks this file. */
const DEFAULTED_STATUS: RegistryLinkStatus = 'suggested';
const DEFAULTED_SOURCE: RegistryLinkSource = 'rule';

export interface ApplyDefaultsInput {
  /** The document that already exists — the junction FKs onto it. */
  documentId: string;
  tenantId: string;
  /** NULL/undefined when the document has no type: nothing to default from. */
  documentTypeId: string | null | undefined;
  /** Recorded as created_by on the proposed links. NULL for machine doors. */
  actorId?: string | null;
}

export interface ApplyDefaultsResult {
  /** Requirement ids newly proposed by this call. Empty when there were no
   *  mappings, when every mapping already had a link in SOME status, or when
   *  the attempt failed. */
  applied: string[];
  /** The owner label written to `documents.owner`, or null when the type had
   *  no default_owner or the document already had an owner. */
  ownerSet: string | null;
}

/**
 * Propose the requirement links a document of this TYPE normally closes, and
 * default `documents.owner` from the type while we are here.
 *
 * Call AFTER the documents row exists. Best-effort: it never throws.
 */
export async function applyDocumentTypeRequirementDefaults(
  db: D1Database,
  { documentId, tenantId, documentTypeId, actorId = null }: ApplyDefaultsInput,
): Promise<ApplyDefaultsResult> {
  // Tracked OUTSIDE the try so a failure in the owner half still reports the
  // links that really landed. Returning [] for rows that exist would make the
  // result a lie, and this value is what a trace/report reads.
  const applied: string[] = [];
  if (!documentId || !tenantId || !documentTypeId) return { applied, ownerSet: null };

  try {
    const mappings = await db
      .prepare(
        `SELECT requirement_id
           FROM document_type_requirements
          WHERE tenant_id = ? AND document_type_id = ?`,
      )
      .bind(tenantId, documentTypeId)
      .all<{ requirement_id: string }>();

    const candidates = [...new Set(mappings.results.map((r) => r.requirement_id))].filter(Boolean);

    // THE GATE for this half: no mapping rows means nothing to propose, and the
    // second read below is skipped entirely. The owner default has its own gate
    // (a non-null default_owner) and runs regardless.
    if (candidates.length > 0) {
      applied.push(...(await proposeLinks(db, documentId, candidates, actorId)));
    }

    const ownerSet = await applyDefaultOwner(db, documentId, tenantId, documentTypeId);

    return { applied, ownerSet };
  } catch (err) {
    // See the module header: a suggestion that could not be written must not
    // take an already-written document with it.
    console.error('requirement defaults: apply failed:', err);
    try {
      await logAudit(
        db,
        actorId,
        tenantId,
        'requirement_defaults.failed',
        'document',
        documentId,
        JSON.stringify({
          document_type_id: documentTypeId,
          error: err instanceof Error ? err.message : String(err),
        }),
        null,
      );
    } catch {
      // The audit write is itself best-effort. If the DB is the thing that is
      // broken, there is nowhere left to report it and the caller must still
      // succeed.
    }
    return { applied, ownerSet: null };
  }
}

/**
 * INSERT one 'suggested' link per requirement that this document does not
 * already have IN ANY STATUS.
 *
 * A 'rejected' row is as disqualifying as a 'confirmed' one: a human turning a
 * suggestion down is a decision, and a rule that re-proposes it on the next
 * re-run has overruled them.
 *
 * This is the SAME guarantee `syncDocumentFacet`'s `preserveRejected` gives,
 * by the SAME mechanism rather than a second one: the real enforcement is
 * `document_requirements`' UNIQUE(document_id, requirement_id) meeting an
 * INSERT OR IGNORE, exactly as over there. Nothing here DELETEs, so there is
 * no path by which a stored rejection can stop existing. The read exists so
 * the returned list reports what actually landed rather than what was
 * attempted — OR IGNORE is silent about which rows it dropped.
 */
async function proposeLinks(
  db: D1Database,
  documentId: string,
  candidates: string[],
  actorId: string | null,
): Promise<string[]> {
  const existing = await db
    .prepare(`SELECT requirement_id FROM document_requirements WHERE document_id = ?`)
    .bind(documentId)
    .all<{ requirement_id: string }>();
  const alreadyLinked = new Set(existing.results.map((r) => r.requirement_id));

  const applied: string[] = [];
  for (const requirementId of candidates) {
    if (alreadyLinked.has(requirementId)) continue;
    await db
      .prepare(
        `INSERT OR IGNORE INTO document_requirements
           (id, document_id, requirement_id, status, source, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(generateId(), documentId, requirementId, DEFAULTED_STATUS, DEFAULTED_SOURCE, actorId)
      .run();
    applied.push(requirementId);
  }
  return applied;
}

/**
 * Default `documents.owner` from `document_types.default_owner` (migration
 * 0100) when the document has none.
 *
 * `documents.owner` is the free-text departmental label the renewal engine
 * resolves through `owner_routes` (0091). Set by hand it is almost always
 * empty, and an empty owner is a routing gap rather than an alert — but the
 * label is nearly always a property of the KIND of document, so the type is
 * the right place to carry the default.
 *
 * NEVER OVERWRITES A NON-NULL OWNER. The `owner IS NULL` guard lives in the
 * WHERE clause rather than in a read-then-write, so it holds even if two
 * producers race, and so the UPDATE matches zero rows — and therefore fires no
 * FTS trigger — when there is nothing to do. An empty string counts as unset:
 * `''` is what a cleared form field leaves behind and it routes exactly as
 * badly as NULL.
 */
async function applyDefaultOwner(
  db: D1Database,
  documentId: string,
  tenantId: string,
  documentTypeId: string,
): Promise<string | null> {
  const typeRow = await db
    .prepare(`SELECT default_owner FROM document_types WHERE id = ? AND tenant_id = ?`)
    .bind(documentTypeId, tenantId)
    .first<{ default_owner: string | null }>();

  const defaultOwner = typeRow?.default_owner?.trim() || null;
  if (!defaultOwner) return null;

  const res = await db
    .prepare(
      `UPDATE documents
          SET owner = ?
        WHERE id = ? AND tenant_id = ?
          AND (owner IS NULL OR trim(owner) = '')`,
    )
    .bind(defaultOwner, documentId, tenantId)
    .run();

  const changes = (res as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0;
  return changes > 0 ? defaultOwner : null;
}
