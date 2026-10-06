/**
 * The WHOLE certificate a per-lot page was cut from (rules table H2).
 *
 * WHY THIS EXISTS
 * ---------------
 * A multi-lot certificate is approved one RECORD at a time: the records path
 * (functions/lib/kinds/coa.ts) writes one page-scoped PDF per lot and marks
 * each `extended_metadata.page_scoped`. That per-lot page is what the portal
 * files, searches and versions. AJ's ruling for what a CUSTOMER receives is
 * the opposite: the certificate goes whole, an exact copy of what the supplier
 * issued, and several order lines cut from one certificate travel as ONE
 * attachment.
 *
 * The whole file is the Review Queue item's staging object, which the records
 * path keeps (it used to stamp a 90-day reclaim date; it no longer stamps one).
 * This module walks a document back to it.
 *
 * HOW A DOCUMENT IS TRACED
 * ------------------------
 *   version 1   `documents.origin_queue_id` (0130) and/or the queue id inside
 *               `external_ref` ("queue-<id>-<lotKey>"). When both are present
 *               they must agree.
 *   version 2+  the version was written by "Replace existing" (0132) from a
 *               DIFFERENT queue item than the one the document was born from;
 *               `origin_queue_id` and `external_ref` still name the first. So
 *               they are NOT read: the `document.version_replaced` audit row
 *               for exactly this version names the queue item that produced
 *               it. No such row (a version uploaded by hand) means no trace.
 *
 * IT NEVER GUESSES. A candidate is used only when the queue item belongs to
 * the same organization, carries the same file name the document's version was
 * written under (the cut keeps its source's name), and its object is actually
 * in storage. Anything less is `missing`, the caller falls back to the per-lot
 * page, and the reason is in words the review screen prints -- a wrong
 * original in a customer's inbox is far worse than a narrower right one.
 */

import { queueIdFromExternalRef } from './intake/duplicates';

export interface WholeOriginal {
  queue_id: string;
  r2_key: string;
  /** The uploaded name. INTERNAL: never the name a file travels under. */
  file_name: string;
  mime_type: string | null;
  file_size: number;
  checksum: string | null;
}

export type WholeOriginalMissing = 'no_trace' | 'not_confirmed' | 'not_in_storage';

export type WholeOriginalResolution =
  /** The document's own file is the whole certificate; nothing to resolve. */
  | { state: 'not_split' }
  | { state: 'on_file'; original: WholeOriginal }
  | { state: 'missing'; reason: WholeOriginalMissing; message: string };

/** What the review screen prints for each way an original can be unavailable. */
export const WHOLE_ORIGINAL_MISSING_WORDS: Record<WholeOriginalMissing, string> = {
  no_trace:
    'This is one lot\'s page of a larger certificate, and the portal has no record of the file it was cut from. The per-lot page will be sent.',
  not_confirmed:
    'This is one lot\'s page of a larger certificate, and the original could not be confirmed as the source of this version. The per-lot page will be sent.',
  not_in_storage:
    'This is one lot\'s page of a larger certificate, and the original is not on file. The per-lot page will be sent.',
};

function missing(reason: WholeOriginalMissing): WholeOriginalResolution {
  return { state: 'missing', reason, message: WHOLE_ORIGINAL_MISSING_WORDS[reason] };
}

const IN_CHUNK = 80;

function chunk<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface TraceRow {
  id: string;
  current_version: number;
  external_ref: string | null;
  origin_queue_id: string | null;
  page_scoped: number | null;
  version_file_name: string | null;
}

/**
 * The queue item each document's CURRENT version came from, or null when it
 * cannot be said. Pure given its inputs; exported for the tests.
 */
export function candidateQueueId(
  doc: Pick<TraceRow, 'current_version' | 'external_ref' | 'origin_queue_id'>,
  replacedFrom: string | null,
): { queue_id: string | null; reason: WholeOriginalMissing | null } {
  if ((Number(doc.current_version) || 1) > 1) {
    return replacedFrom ? { queue_id: replacedFrom, reason: null } : { queue_id: null, reason: 'no_trace' };
  }
  const fromRef = queueIdFromExternalRef(doc.external_ref);
  const fromOrigin = doc.origin_queue_id || null;
  if (fromRef && fromOrigin && fromRef !== fromOrigin) return { queue_id: null, reason: 'not_confirmed' };
  const id = fromOrigin ?? fromRef;
  return id ? { queue_id: id, reason: null } : { queue_id: null, reason: 'no_trace' };
}

/**
 * Resolve the whole original for each document's current version.
 *
 * Every id asked for gets an answer; an id that is not this organization's
 * document answers `not_split` (the caller has already refused it elsewhere,
 * and there is nothing to send whole).
 */
export async function resolveWholeOriginals(
  db: D1Database,
  files: R2Bucket,
  tenantId: string,
  documentIds: string[],
): Promise<Map<string, WholeOriginalResolution>> {
  const out = new Map<string, WholeOriginalResolution>();
  const ids = [...new Set(documentIds.filter(Boolean))];
  for (const id of ids) out.set(id, { state: 'not_split' });
  if (ids.length === 0) return out;

  const docs: TraceRow[] = [];
  for (const part of chunk(ids)) {
    const res = await db
      .prepare(
        `SELECT d.id, d.current_version, d.external_ref, d.origin_queue_id,
                CASE WHEN json_valid(d.extended_metadata)
                     THEN json_extract(d.extended_metadata, '$.page_scoped') END AS page_scoped,
                dv.file_name AS version_file_name
           FROM documents d
           LEFT JOIN document_versions dv
                  ON dv.document_id = d.id AND dv.version_number = d.current_version
          WHERE d.tenant_id = ? AND d.id IN (${part.map(() => '?').join(', ')})`,
      )
      .bind(tenantId, ...part)
      .all<TraceRow>();
    docs.push(...(res.results ?? []));
  }

  const split = docs.filter((d) => Number(d.page_scoped) === 1);
  if (split.length === 0) return out;

  // Version 2+ : which queue item wrote exactly this version ("Replace existing").
  const replacedFrom = new Map<string, string>();
  const replaced = split.filter((d) => (Number(d.current_version) || 1) > 1);
  for (const part of chunk(replaced.map((d) => d.id))) {
    const res = await db
      .prepare(
        `SELECT resource_id, details FROM audit_log
          WHERE tenant_id = ? AND action = 'document.version_replaced'
            AND resource_type = 'document' AND resource_id IN (${part.map(() => '?').join(', ')})
          ORDER BY id DESC`,
      )
      .bind(tenantId, ...part)
      .all<{ resource_id: string; details: string | null }>();
    for (const row of res.results ?? []) {
      if (replacedFrom.has(row.resource_id)) continue;
      const doc = replaced.find((d) => d.id === row.resource_id);
      if (!doc) continue;
      try {
        const details = JSON.parse(row.details ?? '{}') as { new_version?: unknown; queue_item_id?: unknown };
        if (Number(details.new_version) === Number(doc.current_version) && typeof details.queue_item_id === 'string') {
          replacedFrom.set(row.resource_id, details.queue_item_id);
        }
      } catch {
        // An unreadable audit row traces nothing.
      }
    }
  }

  const candidates = new Map<string, string>();
  for (const d of split) {
    const c = candidateQueueId(d, replacedFrom.get(d.id) ?? null);
    if (c.queue_id) candidates.set(d.id, c.queue_id);
    else out.set(d.id, missing(c.reason ?? 'no_trace'));
  }

  const queueRows = new Map<string, WholeOriginal>();
  for (const part of chunk([...new Set(candidates.values())])) {
    const res = await db
      .prepare(
        `SELECT id, file_r2_key, file_name, mime_type, file_size, checksum
           FROM processing_queue
          WHERE tenant_id = ? AND id IN (${part.map(() => '?').join(', ')})`,
      )
      .bind(tenantId, ...part)
      .all<{
        id: string;
        file_r2_key: string | null;
        file_name: string;
        mime_type: string | null;
        file_size: number | null;
        checksum: string | null;
      }>();
    for (const q of res.results ?? []) {
      if (!q.file_r2_key) continue;
      queueRows.set(q.id, {
        queue_id: q.id,
        r2_key: q.file_r2_key,
        file_name: q.file_name,
        mime_type: q.mime_type,
        file_size: Number(q.file_size) || 0,
        checksum: q.checksum,
      });
    }
  }

  // One storage check per original, however many documents were cut from it.
  const inStorage = new Map<string, number | null>();
  for (const d of split) {
    const queueId = candidates.get(d.id);
    if (!queueId) continue;
    const original = queueRows.get(queueId);
    if (!original) {
      out.set(d.id, missing('no_trace'));
      continue;
    }
    // The cut is written under its source's file name; a candidate with a
    // different one did not produce this version.
    if (d.version_file_name && original.file_name !== d.version_file_name) {
      out.set(d.id, missing('not_confirmed'));
      continue;
    }
    if (!inStorage.has(queueId)) {
      const head = await files.head(original.r2_key);
      inStorage.set(queueId, head ? head.size : null);
    }
    const size = inStorage.get(queueId);
    if (size === null || size === undefined) {
      out.set(d.id, missing('not_in_storage'));
      continue;
    }
    // Storage is the authority on how big the file is.
    out.set(d.id, { state: 'on_file', original: { ...original, file_size: size } });
  }

  return out;
}
