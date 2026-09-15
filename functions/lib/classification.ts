import type { D1Database } from '@cloudflare/workers-types';
import { logAudit } from './db';
import type { ClassificationStatus } from '../../shared/types';

/**
 * WHO WRITES `documents.classification_status` (migration 0081).
 *
 * THE GAP THIS CLOSES
 * -------------------
 * 0081 added the column, the CHECK, the two reviewed_* stamps and a
 * tenant-scoped index, and `functions/lib/requirement-gaps.ts` counts by it on
 * every supplier gap report. NOTHING EVER WROTE IT. Every row therefore sat at
 * the DEFAULT, 'unclassified', for its whole life, so the "unclassified"
 * number was not a backlog — it was `COUNT(*)`, on every tenant, forever. A
 * number that cannot change is worse than a missing one: it reads as a real
 * measurement and it is always maximally alarming.
 *
 * WHAT EACH STATE MEANS (from 0081's own header, not reinvented here)
 * ------------------------------------------------------------------
 *   unclassified   never touched. Nothing proposed, nobody looked. DEFAULT.
 *   needs_review   something WAS proposed (extraction, a rule, an import) but
 *                  no human has confirmed it.
 *   classified     a human affirmed the classification.
 *   unclassifiable a human decided it genuinely fits no type. TERMINAL.
 *
 * WHERE EACH ONE IS WRITTEN
 * -------------------------
 *   Review Queue approval WITH a document type  -> classified
 *       Approving is a human looking at the extraction, the proposed type and
 *       the file together and saying yes. That IS affirming the
 *       classification; there is no second screen where it would be affirmed
 *       more.
 *   Review Queue approval with NO document type -> needs_review
 *       The classifier ran and did not resolve to one of the tenant's types
 *       (its near miss is kept in `processing_queue.document_type_guess`), and
 *       the reviewer approved the extraction without picking one. Something
 *       was proposed, nobody confirmed it: 0081's definition exactly. This is
 *       the state that makes the backlog a real worklist.
 *   A human setting the type on the document page -> classified
 *   POST /api/documents/ingest declaring a type    -> needs_review
 *       Ingest is a CALLER-ASSERTED upsert (an agent, a pipeline, an API key),
 *       not a person. A machine naming a type is a proposal, and filing it as
 *       'classified' would be the same lie in a new place.
 *
 * WHY NOT "type AND a confirmed requirement link"
 * ----------------------------------------------
 * Requirement links are a DIFFERENT facet: 0080 layer 2 is what a document
 * SATISFIES, 0081 is what it IS. Beyond the modelling point it would not work:
 * `functions/lib/requirement-defaults.ts` writes links at status 'suggested'
 * and a human confirms them separately, and migration 0100 inserts ZERO
 * type->requirement mappings, so on every tenant today the condition would
 * never hold and every approved document would land in 'needs_review'. That is
 * the bug being fixed here, wearing a different costume.
 *
 * THE reviewed_* STAMPS
 * --------------------
 * 0081: "the reviewed_at/by columns are what make 'unclassifiable'
 * trustworthy: the state asserts a human made a judgment, so the record has to
 * say which human and when." So they are stamped ONLY for 'classified' (and
 * would be for 'unclassifiable'). A 'needs_review' row leaves them NULL even
 * though a person approved the document, because that person did not rule on
 * the classification — stamping them there would make the column say a
 * judgment happened that did not.
 *
 * NEVER DEMOTES
 * -------------
 * A machine-grade write ('needs_review') is refused against a row a human has
 * already ruled on. Without that, a re-ingest through the API would silently
 * undo a reviewer's 'classified' or, worse, their terminal 'unclassifiable' —
 * and the backlog would grow rows that had already been closed by hand.
 *
 * BEST-EFFORT, LIKE ITS NEIGHBOUR
 * -------------------------------
 * Never throws into the caller, for the same reason as
 * `requirement-defaults.ts`: the document row already exists, and destroying
 * an approval because a STATUS COLUMN could not be written would be the worst
 * trade available. A failure degrades to the state that existed before this
 * shipped, and is made findable with a console.error and a
 * `document.classification_failed` audit row.
 */

/** The states a human has ruled on. A machine write never overwrites these. */
const HUMAN_RULED: readonly ClassificationStatus[] = ['classified', 'unclassifiable'];

export interface ClassifyInput {
  documentId: string;
  tenantId: string;
  /** NULL/undefined = the document has no type. */
  documentTypeId: string | null | undefined;
  /**
   * Who is responsible for the write. A person's id for a human act (it is
   * stamped into classification_reviewed_by); NULL for a machine door.
   */
  actorId: string | null;
  /**
   * TRUE when `actorId` is a person affirming the classification — a Review
   * Queue approval or an edit on the document page. FALSE for a caller-asserted
   * write such as ingest. This, not the presence of an actor, is what decides
   * between 'classified' and 'needs_review', because ingest through an API key
   * also has a user id attached.
   */
  byHuman: boolean;
  clientIp?: string | null;
}

export interface ClassifyResult {
  /** What the row holds now, or null when nothing was written. */
  status: ClassificationStatus | null;
  /** Why nothing was written, for a caller that reports (the backfill does). */
  skipped?: 'already_ruled' | 'unchanged' | 'failed';
}

/**
 * Record what a classification act decided. Call AFTER the documents row
 * exists. Best-effort: it never throws.
 */
export async function recordClassification(
  db: D1Database,
  { documentId, tenantId, documentTypeId, actorId, byHuman, clientIp = null }: ClassifyInput,
): Promise<ClassifyResult> {
  if (!documentId || !tenantId) return { status: null, skipped: 'unchanged' };

  // A type present means there is a classification to affirm; a human
  // affirming it is what makes it 'classified'. Everything else is a proposal
  // nobody has confirmed.
  const status: ClassificationStatus =
    documentTypeId && byHuman ? 'classified' : 'needs_review';
  const stampReviewer = status === 'classified';

  try {
    const current = await db
      .prepare('SELECT classification_status FROM documents WHERE id = ? AND tenant_id = ?')
      .bind(documentId, tenantId)
      .first<{ classification_status: string | null }>();
    if (!current) return { status: null, skipped: 'unchanged' };

    const now = (current.classification_status ?? 'unclassified') as ClassificationStatus;

    // A machine proposal never overrules a person. A human act does: a
    // reviewer re-approving, or correcting the type on the document page, is
    // the newest human judgment and should move the stamps with it.
    if (!byHuman && HUMAN_RULED.includes(now)) {
      return { status: now, skipped: 'already_ruled' };
    }
    // Nothing to say. Skipping keeps the non-column-scoped
    // `trg_documents_au_fts` trigger from reindexing the document for a write
    // that changes nothing.
    if (now === status && !stampReviewer) {
      return { status: now, skipped: 'unchanged' };
    }

    await db
      .prepare(
        `UPDATE documents
            SET classification_status = ?,
                classification_reviewed_at = ${stampReviewer ? "datetime('now')" : 'classification_reviewed_at'},
                classification_reviewed_by = ${stampReviewer ? '?' : 'classification_reviewed_by'}
          WHERE id = ? AND tenant_id = ?`,
      )
      .bind(...(stampReviewer ? [status, actorId, documentId, tenantId] : [status, documentId, tenantId]))
      .run();

    return { status };
  } catch (err) {
    // See the header: a status column must not take an approval with it.
    console.error('classification: write failed:', err);
    try {
      await logAudit(
        db,
        actorId,
        tenantId,
        'document.classification_failed',
        'document',
        documentId,
        JSON.stringify({ intended_status: status, error: String(err) }),
        clientIp,
      );
    } catch {
      // The audit row is the fallback surface; if even that fails there is
      // nothing further to try, and the caller must still succeed.
    }
    return { status: null, skipped: 'failed' };
  }
}
