/**
 * Supplier-portal arrivals — the staff side (migration 0104).
 *
 * WHY THIS EXISTS
 * ---------------
 * 0092 let a supplier answer an ask through a no-login link, 0094 made every
 * arrival readable (it is enqueued for extraction like any other door), and the
 * approve path in functions/api/queue/[id].ts fills `request_uploads.document_id`
 * when a reviewer approves the extraction. What nothing did was let one of our
 * own people look at what arrived and say "this satisfies requirement X" or
 * "this does not, and here is why". A line only ever reached `accepted` by a
 * hand-edited dropdown with no record of which file it was accepted from.
 *
 * This module is that decision, plus the read that puts it in front of someone.
 *
 * TWO JUDGEMENTS, STILL TWO
 * -------------------------
 * Queue approval asks "is this extraction faithful to this file?". Deciding an
 * arrival asks "does this document satisfy what we asked this supplier for?".
 * The approve helper explains why the first must never write the second, and
 * this module does not blur it back: it never approves anything, and the only
 * coupling runs the safe way round — a line cannot be ACCEPTED from an arrival
 * whose file nobody has approved (`request_uploads.document_id IS NULL` is a
 * 409). Accepting a file on the supplier's own description of it is the exact
 * thing 0092 said a claim is not. Needs-attention has no such precondition.
 *
 * The Review Queue can make both judgements in ONE click for a `request_link`
 * item (PUT /api/queue/:id with `arrival_decision`). That is still two
 * judgements recorded as two: the approval writes what it always wrote, then
 * `decideArrival` runs exactly as the arrivals screen runs it, with
 * `via: 'review_queue_combined'` on its audit rows. The reviewer is shown the
 * supplier's claims as pre-ticked boxes and has to choose accept or send back,
 * so the decision is still a person's, just made on the screen they were
 * already on. Nothing is accepted by default.
 *
 * WHAT A DECISION WRITES
 * ----------------------
 * One `db.batch`, so a decision cannot half-happen:
 *   - the claim row (`request_upload_lines`) — decision, document, who, when.
 *     A reviewer who sees the file covers something the supplier did not tick
 *     adds a `claimed_by = 'staff'` claim rather than a second kind of record.
 *   - the CURRENT version's line — status, stamps, the two notes, and
 *     `accepted_document_id`.
 *   - for an accepted TYPED line, the registry link that says this document
 *     satisfies the requirement, at `confirmed`. A human `rejected` link is
 *     never overridden: the whole decision is refused and nothing is written.
 *
 * AMENDMENTS RE-MINT LINE IDS
 * ---------------------------
 * A claim points at the line row the supplier ticked, which after an amendment
 * belongs to a superseded version. Everything here therefore speaks CURRENT
 * line ids and maps claims onto them by line identity (`lineKey`), the same
 * identity `loadReceivedCounts` and `carryStatuses` use.
 */

import { generateId, logAudit } from './db';
import { enqueueDocument } from './intake/enqueue';
import {
  auditRequest,
  countLines,
  lineKey,
  loadLines,
} from './document-requests';
import { BadRequestError, ConflictError, NotFoundError } from './permissions';
import { specConfigLoader, specResultsWithConfig } from './spec-warnings';
import { sanitizeString } from './validation';
import type {
  DecideArrivalLine,
  DecideArrivalResponse,
  DocumentRequestStatus,
  RequestArrival,
  RequestArrivalClaim,
  RequestArrivalPipelineState,
  RequestLineKind,
  RequestLineRow,
  RequestLineStatus,
  SupplierRequirementTier,
} from '../../shared/types';
import type { User } from './types';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * D1 refuses a statement with more than 100 bound parameters. Every IN list in
 * this module goes through here so a busy inbox cannot turn into a 500.
 */
const IN_CHUNK = 80;

function chunk<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function ph(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

function clean(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = sanitizeString(String(v));
  return s.length === 0 ? null : s;
}

function nowIso(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/** Statuses that mean "a file is in, and nobody has settled it yet". */
const OPEN_LINE_STATUSES: readonly RequestLineStatus[] = ['received', 'under_review'];
/** Statuses that mean a person has settled the line, one way or the other. */
const SETTLED_LINE_STATUSES: readonly RequestLineStatus[] = ['accepted', 'needs_attention'];

// ---------------------------------------------------------------------------
// Enqueue — shared by the upload door and the manual re-enqueue
// ---------------------------------------------------------------------------

export interface EnqueueSupplierUploadArgs {
  tenantId: string;
  supplierId: string;
  requestId: string;
  linkId: string;
  uploadId: string;
  r2Key: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  checksum: string;
  ip: string | null;
  /** Who asked for a re-enqueue. NULL for the supplier's own upload. */
  actorId?: string | null;
}

/**
 * Put one supplier arrival on the extraction queue and record the pairing.
 *
 * Best-effort by construction. The upload door has already committed the
 * upload when it calls this, so every failure mode here degrades to "the file
 * is stored, the lines moved, and nobody read it yet" — which is precisely the
 * behaviour that existed before 0094, and is therefore a safe floor rather than
 * a broken state.
 *
 * The failure is made findable in two places rather than one:
 *   - `console.error`, for whoever is tailing the worker.
 *   - an audit-log row (`request_link.enqueue_failed`) against the upload,
 *     which is the surface an operator actually has.
 *
 * And the DATA records it too: `request_uploads.queue_id` stays NULL, so
 * "arrivals we never read" is one indexed query away — which is exactly what
 * POST /api/request-uploads/:id/enqueue acts on.
 */
export async function enqueueSupplierUpload(
  db: D1Database,
  args: EnqueueSupplierUploadArgs,
): Promise<string | null> {
  try {
    const { queueId } = await enqueueDocument(db, {
      tenantId: args.tenantId,
      // Unknown, and honestly so. A supplier request packet asks for an
      // allergen statement, an insurance certificate and a spec sheet in the
      // same breath; guessing a type here would only teach the worker a wrong
      // one. NULL lets the doc-type resolution happen downstream where the
      // extracted text is available to inform it.
      documentTypeId: null,
      fileR2Key: args.r2Key,
      fileName: args.fileName,
      fileSize: args.fileSize,
      mimeType: args.mimeType,
      checksum: args.checksum,
      // A supplier is not a user. `created_by` is a nullable FK to users(id),
      // so NULL is the only value that is both true and legal. A staff
      // re-enqueue is still the supplier's file, so it stays NULL there too;
      // who pressed the button is in the audit row.
      createdBy: null,
      // The door, in the vocabulary the other doors use ('email', 's3', 'api',
      // 'public_link', 'import'). Deliberately NOT 'public_link' — that value
      // is already taken by the connector drop door, and collapsing the two
      // would make "which door did this come from" unanswerable for exactly
      // the two doors an operator most needs to tell apart.
      source: 'request_link',
      // Enough to walk back to the ask and to the individual arrival.
      sourceDetail: `request:${args.requestId}:upload:${args.uploadId}`,
      // NULL, treated as 'coa' downstream. Same reasoning as documentTypeId.
      outputKind: null,
      // Not a connector. A request link is its own kind of door.
      sourceId: null,
      // THE POINT. The link knows exactly which supplier this is, so the
      // worker can load that supplier's extraction instructions instead of
      // extracting blind.
      supplierId: args.supplierId,
    });

    await db
      .prepare(`UPDATE request_uploads SET queue_id = ? WHERE id = ? AND tenant_id = ?`)
      .bind(queueId, args.uploadId, args.tenantId)
      .run();

    return queueId;
  } catch (err) {
    console.error('Supplier request upload: enqueue failed:', err);
    try {
      await logAudit(
        db,
        args.actorId ?? null,
        args.tenantId,
        'request_link.enqueue_failed',
        'request_upload',
        args.uploadId,
        JSON.stringify({
          request_id: args.requestId,
          link_id: args.linkId,
          supplier_id: args.supplierId,
          file_name: args.fileName,
          r2_key: args.r2Key,
          error: err instanceof Error ? err.message : String(err),
        }),
        args.ip,
      );
    } catch {
      // If even the audit write fails, the console line is what is left.
      // Still not a reason to fail an upload that already succeeded.
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pipeline state
// ---------------------------------------------------------------------------

export interface ArrivalStateInput {
  queue_id: string | null;
  document_id: string | null;
  queue_status: string | null;
  processing_status: string | null;
}

/**
 * Where an arrival is before anyone decides what it satisfies.
 *
 * A linked document wins outright: it is the one fact the accept precondition
 * reads, so the card must never say "awaiting approval" while the API would
 * accept. After that the states follow the pipeline: never read, being read,
 * failed to read, waiting for a reviewer, rejected by one.
 */
export function arrivalState(row: ArrivalStateInput): RequestArrivalPipelineState {
  if (row.document_id) return 'document_linked';
  if (!row.queue_id || !row.queue_status) return 'not_read';
  if (row.queue_status === 'rejected') return 'rejected_in_queue';
  if (row.processing_status === 'queued' || row.processing_status === 'processing') {
    return 'extracting';
  }
  if (row.processing_status === 'error') return 'extraction_error';
  return 'awaiting_approval';
}

// ---------------------------------------------------------------------------
// Claims -> current lines
// ---------------------------------------------------------------------------

export interface ClaimSourceRow {
  claim_id: string;
  upload_id: string;
  claimed_line_id: string;
  claimed_by: 'supplier' | 'staff';
  added_by_name: string | null;
  decision: 'accepted' | 'needs_attention' | null;
  decision_document_id: string | null;
  decided_at: string | null;
  decided_by_name: string | null;
  line_kind: RequestLineKind;
  requirement_id: string | null;
  name: string;
  tier: SupplierRequirementTier;
  sort_order: number;
}

/**
 * Map claims (made against whichever version was current at upload) onto the
 * CURRENT version's lines, by line identity.
 *
 * A claim whose line an amendment has since removed keeps its own name and
 * gets `line_id: null`; it is history, not work. Ordered the way the current
 * checklist is ordered, removed lines last.
 */
export function mapClaimsToCurrentLines(
  claims: ClaimSourceRow[],
  currentLines: RequestLineRow[],
): RequestArrivalClaim[] {
  const byKey = new Map<string, RequestLineRow>();
  for (const l of currentLines) byKey.set(lineKey(l), l);

  const mapped = claims.map((c) => {
    const cur = byKey.get(lineKey(c)) ?? null;
    const status = cur?.status ?? null;
    return {
      claim: {
        claim_id: c.claim_id,
        line_id: cur?.id ?? null,
        claimed_line_id: c.claimed_line_id,
        line_name: cur?.name ?? c.name,
        line_kind: c.line_kind,
        requirement_id: c.requirement_id,
        tier: cur?.tier ?? c.tier,
        line_status: status,
        line_accepted_document_id: cur?.accepted_document_id ?? null,
        claimed_by: c.claimed_by,
        added_by_name: c.added_by_name,
        decision: c.decision,
        decision_document_id: c.decision_document_id,
        decided_at: c.decided_at,
        decided_by_name: c.decided_by_name,
        decided_elsewhere:
          c.decision === null && status !== null && SETTLED_LINE_STATUSES.includes(status),
      } satisfies RequestArrivalClaim,
      order: cur ? cur.sort_order : Number.MAX_SAFE_INTEGER,
    };
  });

  mapped.sort((a, b) => a.order - b.order);
  return mapped.map((m) => m.claim);
}

/** Undecided claims whose current line is still waiting on a person. */
export function pendingCount(claims: RequestArrivalClaim[]): number {
  return claims.filter(
    (c) =>
      c.decision === null &&
      c.line_status !== null &&
      OPEN_LINE_STATUSES.includes(c.line_status),
  ).length;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface LoadArrivalsOptions {
  rootRequestId?: string | null;
  supplierId?: string | null;
  /** Only arrivals with at least one claim still waiting on a person. */
  pending?: boolean;
  uploadId?: string | null;
  /** The arrival a Review Queue item came from. */
  queueId?: string | null;
  limit?: number;
  offset?: number;
}

interface ArrivalBaseRow {
  id: string;
  tenant_id: string;
  supplier_id: string;
  supplier_name: string | null;
  request_id: string;
  root_request_id: string;
  current_request_id: string | null;
  current_request_status: DocumentRequestStatus | null;
  request_title: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  uploaded_at: string;
  uploader_label: string | null;
  queue_id: string | null;
  document_id: string | null;
  document_title: string | null;
  queue_status: string | null;
  processing_status: string | null;
  error_message: string | null;
  rejection_reason: string | null;
  rejection_note: string | null;
  q_supplier_id: string | null;
  q_document_type_id: string | null;
  q_tables: string | null;
  q_ai_records: string | null;
}

/**
 * The columns every arrival read selects. `uploader_ip` and `r2_key` are
 * deliberately absent from the SELECT itself, not merely dropped later — a
 * column that is never read cannot be serialized by accident.
 */
const ARRIVAL_SELECT = `
  SELECT u.id, u.tenant_id, u.supplier_id, s.name AS supplier_name,
         u.request_id, r.root_request_id,
         cur.id AS current_request_id, cur.status AS current_request_status,
         COALESCE(cur.title, r.title) AS request_title,
         u.file_name, u.file_size, u.mime_type, u.uploaded_at, u.uploader_label,
         u.queue_id, u.document_id, d.title AS document_title,
         q.status AS queue_status, q.processing_status, q.error_message,
         q.rejection_reason, q.rejection_note,
         q.supplier_id AS q_supplier_id, q.document_type_id AS q_document_type_id,
         q.tables AS q_tables, q.ai_records AS q_ai_records
    FROM request_uploads u
    JOIN document_requests r ON r.id = u.request_id
    LEFT JOIN document_requests cur
      ON cur.root_request_id = r.root_request_id
     AND cur.tenant_id = u.tenant_id
     AND cur.superseded_at IS NULL
    LEFT JOIN suppliers s ON s.id = u.supplier_id AND s.tenant_id = u.tenant_id
    LEFT JOIN documents d ON d.id = u.document_id AND d.tenant_id = u.tenant_id
    LEFT JOIN processing_queue q ON q.id = u.queue_id AND q.tenant_id = u.tenant_id`;

/**
 * The inbox is computed, not stored (a line settled from another file drops a
 * claim out of it), so pending mode reads candidates and filters in memory.
 * This bounds that read; a tenant with more undecided arrivals than this has a
 * staffing problem the page will make obvious long before it matters.
 */
const PENDING_CANDIDATE_CAP = 1000;

/**
 * Arrivals for one tenant, fully assembled.
 *
 * Two-query shape, like `loadUploadHistory`: the uploads, then every claim for
 * them in one pass, rather than a GROUP_CONCAT over free-text line names.
 */
export async function loadArrivals(
  db: D1Database,
  tenantId: string,
  opts: LoadArrivalsOptions = {},
): Promise<{ arrivals: RequestArrival[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const where: string[] = ['u.tenant_id = ?'];
  const params: (string | number)[] = [tenantId];
  if (opts.uploadId) {
    where.push('u.id = ?');
    params.push(opts.uploadId);
  }
  if (opts.queueId) {
    where.push('u.queue_id = ?');
    params.push(opts.queueId);
  }
  if (opts.rootRequestId) {
    where.push('r.root_request_id = ?');
    params.push(opts.rootRequestId);
  }
  if (opts.supplierId) {
    where.push('u.supplier_id = ?');
    params.push(opts.supplierId);
  }
  if (opts.pending) {
    // Candidate filter only. A decision is only makeable against a live ask,
    // and only an undecided claim can be pending; the exact answer (is the
    // current line still open?) needs the identity mapping and is done below.
    where.push(`cur.status = 'issued'`);
    where.push(
      `EXISTS (SELECT 1 FROM request_upload_lines ul
                WHERE ul.tenant_id = u.tenant_id AND ul.upload_id = u.id
                  AND ul.decision IS NULL)`,
    );
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  if (opts.pending) {
    const rows = await db
      .prepare(
        `${ARRIVAL_SELECT} ${whereSql}
          ORDER BY u.uploaded_at ASC, u.rowid ASC
          LIMIT ?`,
      )
      .bind(...params, PENDING_CANDIDATE_CAP)
      .all<ArrivalBaseRow>();
    // Oldest first: the inbox is a queue, and the file that has waited longest
    // is the one a supplier is most likely phoning about.
    const assembled = (await assembleArrivals(db, tenantId, rows.results ?? [])).filter(
      (a) => a.pending_count > 0,
    );
    return { arrivals: assembled.slice(offset, offset + limit), total: assembled.length };
  }

  const count = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM request_uploads u
         JOIN document_requests r ON r.id = u.request_id
         LEFT JOIN document_requests cur
           ON cur.root_request_id = r.root_request_id
          AND cur.tenant_id = u.tenant_id
          AND cur.superseded_at IS NULL
        ${whereSql}`,
    )
    .bind(...params)
    .first<{ n: number }>();

  const rows = await db
    .prepare(
      `${ARRIVAL_SELECT} ${whereSql}
        ORDER BY u.uploaded_at DESC, u.rowid DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(...params, limit, offset)
    .all<ArrivalBaseRow>();

  return {
    arrivals: await assembleArrivals(db, tenantId, rows.results ?? []),
    total: Number(count?.n ?? 0),
  };
}

/** One arrival, tenant-scoped. A foreign or unknown id is a 404. */
export async function loadArrival(
  db: D1Database,
  tenantId: string,
  uploadId: string,
): Promise<RequestArrival> {
  const { arrivals } = await loadArrivals(db, tenantId, { uploadId, limit: 1 });
  const hit = arrivals[0];
  if (!hit) throw new NotFoundError('Arrival not found');
  return hit;
}

/** Tenant-wide inbox size, for the tab badge. Ignores every filter. */
export async function countPendingArrivals(db: D1Database, tenantId: string): Promise<number> {
  const { total } = await loadArrivals(db, tenantId, { pending: true, limit: 1 });
  return total;
}

async function assembleArrivals(
  db: D1Database,
  tenantId: string,
  rows: ArrivalBaseRow[],
): Promise<RequestArrival[]> {
  if (rows.length === 0) return [];

  // --- claims, in one pass per chunk --------------------------------------
  const claimsByUpload = new Map<string, ClaimSourceRow[]>();
  for (const ids of chunk(rows.map((r) => r.id))) {
    const res = await db
      .prepare(
        `SELECT ul.id AS claim_id, ul.upload_id, ul.line_id AS claimed_line_id,
                ul.claimed_by, au.name AS added_by_name,
                ul.decision, ul.decision_document_id, ul.decided_at,
                du.name AS decided_by_name,
                l.line_kind, l.requirement_id, l.name, l.tier, l.sort_order
           FROM request_upload_lines ul
           JOIN request_lines l ON l.id = ul.line_id
           LEFT JOIN users au ON au.id = ul.added_by
           LEFT JOIN users du ON du.id = ul.decided_by
          WHERE ul.tenant_id = ? AND ul.upload_id IN (${ph(ids.length)})
          ORDER BY l.sort_order, ul.created_at, ul.rowid`,
      )
      .bind(tenantId, ...ids)
      .all<ClaimSourceRow>();
    for (const c of res.results ?? []) {
      const list = claimsByUpload.get(c.upload_id) ?? [];
      list.push(c);
      claimsByUpload.set(c.upload_id, list);
    }
  }

  // --- current lines, per current version ----------------------------------
  const currentIds = [
    ...new Set(rows.map((r) => r.current_request_id).filter((v): v is string => !!v)),
  ];
  const linesByRequest = new Map<string, RequestLineRow[]>();
  for (const ids of chunk(currentIds)) {
    const res = await db
      .prepare(
        `SELECT * FROM request_lines
          WHERE tenant_id = ? AND request_id IN (${ph(ids.length)})
          ORDER BY sort_order, created_at, rowid`,
      )
      .bind(tenantId, ...ids)
      .all<RequestLineRow>();
    for (const l of res.results ?? []) {
      const list = linesByRequest.get(l.request_id) ?? [];
      list.push(l);
      linesByRequest.set(l.request_id, list);
    }
  }

  // --- documents the queue item produced ------------------------------------
  // Producers write external_ref as `queue-<id>` or `queue-<id>-<suffix>`
  // (sublot / multi-product splits). Same prefix rule as /api/queue/:id/file.
  const docsByQueue = new Map<string, { id: string; title: string }[]>();
  const approvedQueueRows = rows.filter((r) => r.queue_id && r.document_id);
  for (const group of chunk(approvedQueueRows, 20)) {
    const clauses = group
      .map(() => `(d.supplier_id = ? AND (d.external_ref = 'queue-' || ? OR d.external_ref LIKE 'queue-' || ? || '-%'))`)
      .join(' OR ');
    const binds = group.flatMap((r) => [r.supplier_id, r.queue_id!, r.queue_id!]);
    const res = await db
      .prepare(
        `SELECT d.id, d.title, d.external_ref FROM documents d
          WHERE d.tenant_id = ? AND d.status = 'active' AND (${clauses})
          ORDER BY d.created_at, d.rowid`,
      )
      .bind(tenantId, ...binds)
      .all<{ id: string; title: string; external_ref: string }>();
    for (const d of res.results ?? []) {
      const qid = group.find(
        (r) => d.external_ref === `queue-${r.queue_id}` || d.external_ref.startsWith(`queue-${r.queue_id}-`),
      )?.queue_id;
      if (!qid) continue;
      const list = docsByQueue.get(qid) ?? [];
      list.push({ id: d.id, title: d.title });
      docsByQueue.set(qid, list);
    }
  }

  // --- spec: the frozen register, after approval ----------------------------
  const registerByQueue = new Map<string, { out_of_spec: number; not_checked: number }>();
  const queueIds = approvedQueueRows.map((r) => r.queue_id!);
  for (const ids of chunk(queueIds)) {
    const res = await db
      .prepare(
        `SELECT queue_item_id,
                SUM(CASE WHEN verdict = 'out_of_spec' THEN 1 ELSE 0 END) AS out_of_spec,
                SUM(CASE WHEN verdict = 'not_checked' THEN 1 ELSE 0 END) AS not_checked,
                COUNT(*) AS n
           FROM document_spec_checks
          WHERE tenant_id = ? AND queue_item_id IN (${ph(ids.length)})
          GROUP BY queue_item_id`,
      )
      .bind(tenantId, ...ids)
      .all<{ queue_item_id: string; out_of_spec: number; not_checked: number; n: number }>();
    for (const r of res.results ?? []) {
      registerByQueue.set(r.queue_item_id, {
        out_of_spec: Number(r.out_of_spec ?? 0),
        not_checked: Number(r.not_checked ?? 0),
      });
    }
  }

  // One spec-config read per tenant, not per row — the queue list's rule.
  const loadConfig = specConfigLoader(db);

  const out: RequestArrival[] = [];
  for (const r of rows) {
    const state = arrivalState(r);
    const currentLines = r.current_request_id
      ? (linesByRequest.get(r.current_request_id) ?? [])
      : [];
    const claims = mapClaimsToCurrentLines(claimsByUpload.get(r.id) ?? [], currentLines);

    let spec: RequestArrival['spec'] = null;
    if (state === 'document_linked' && r.queue_id) {
      const reg = registerByQueue.get(r.queue_id);
      if (reg) spec = { ...reg, source: 'register' };
    } else if (state === 'awaiting_approval') {
      const config = await loadConfig(tenantId);
      const { results, summary } = specResultsWithConfig(
        { tables: r.q_tables, ai_records: r.q_ai_records },
        config,
        {
          supplier_id: r.q_supplier_id ?? r.supplier_id,
          document_type_id: r.q_document_type_id,
          product_ids: [],
        },
      );
      if (results.length > 0) {
        spec = { out_of_spec: summary.out_of_spec, not_checked: summary.not_checked, source: 'queue' };
      }
    }

    const produced = r.queue_id ? (docsByQueue.get(r.queue_id) ?? []) : [];
    const documents =
      r.document_id && !produced.some((d) => d.id === r.document_id)
        ? [{ id: r.document_id, title: r.document_title ?? r.file_name }, ...produced]
        : produced;

    out.push({
      id: r.id,
      tenant_id: r.tenant_id,
      supplier_id: r.supplier_id,
      supplier_name: r.supplier_name,
      request_id: r.request_id,
      root_request_id: r.root_request_id,
      current_request_id: r.current_request_id ?? r.request_id,
      current_request_status: r.current_request_status ?? 'cancelled',
      request_title: r.request_title,
      file_name: r.file_name,
      file_size: Number(r.file_size),
      mime_type: r.mime_type,
      uploaded_at: r.uploaded_at,
      uploader_label: r.uploader_label,
      queue_id: r.queue_id,
      document_id: r.document_id,
      document_title: r.document_title,
      documents,
      pipeline_state: state,
      rejection_reason: state === 'rejected_in_queue' ? r.rejection_reason : null,
      rejection_note: state === 'rejected_in_queue' ? r.rejection_note : null,
      processing_error: state === 'extraction_error' ? r.error_message : null,
      spec,
      claims,
      pending_count: r.current_request_status === 'issued' ? pendingCount(claims) : 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

interface UploadRow {
  id: string;
  tenant_id: string;
  link_id: string;
  request_id: string;
  supplier_id: string;
  document_id: string | null;
  queue_id: string | null;
  file_name: string;
}

async function loadUploadRow(
  db: D1Database,
  tenantId: string,
  uploadId: string,
): Promise<UploadRow> {
  const row = await db
    .prepare(
      `SELECT id, tenant_id, link_id, request_id, supplier_id, document_id, queue_id, file_name
         FROM request_uploads WHERE id = ? AND tenant_id = ?`,
    )
    .bind(uploadId, tenantId)
    .first<UploadRow>();
  if (!row) throw new NotFoundError('Arrival not found');
  return row;
}

/**
 * Confirm (or create) the registry link that says `documentId` satisfies
 * `requirementId`, as statements for the caller's batch.
 *
 *   none       -> INSERT at 'confirmed', source 'request_accept'
 *   suggested  -> 'confirmed'; the original provenance (usually 'rule') is kept
 *   confirmed  -> nothing to write
 *   rejected   -> ConflictError. A person already said this document does NOT
 *                 satisfy this requirement, and accepting a request line is not
 *                 a licence to overrule them from a different screen. The caller
 *                 has written nothing yet, so the whole decision is refused.
 *
 * Split into a check and a write so a multi-line decision can refuse before any
 * statement is issued.
 */
export async function confirmRequirementLink(
  db: D1Database,
  args: { documentId: string; requirementId: string; requirementName: string; userId: string; at: string },
): Promise<{ statements: D1PreparedStatement[]; action: 'inserted' | 'confirmed' | 'already_confirmed' }> {
  const existing = await db
    .prepare(
      `SELECT id, status FROM document_requirements WHERE document_id = ? AND requirement_id = ?`,
    )
    .bind(args.documentId, args.requirementId)
    .first<{ id: string; status: string }>();

  if (existing?.status === 'rejected') {
    throw new ConflictError(
      `Someone has already recorded that this document does not satisfy the ` +
        `"${args.requirementName}" requirement. Accepting it here would overrule them, ` +
        `so nothing was saved. Review that decision on the document first, or send ` +
        `this item back to the supplier instead.`,
    );
  }
  if (existing?.status === 'confirmed') return { statements: [], action: 'already_confirmed' };
  if (existing) {
    return {
      action: 'confirmed',
      statements: [
        db
          .prepare(
            `UPDATE document_requirements
                SET status = 'confirmed', confirmed_at = ?, confirmed_by = ?
              WHERE id = ? AND status = 'suggested'`,
          )
          .bind(args.at, args.userId, existing.id),
      ],
    };
  }
  return {
    action: 'inserted',
    statements: [
      db
        .prepare(
          `INSERT OR IGNORE INTO document_requirements
             (id, document_id, requirement_id, status, source, created_by, confirmed_at, confirmed_by)
           VALUES (?, ?, ?, 'confirmed', 'request_accept', ?, ?, ?)`,
        )
        .bind(generateId(), args.documentId, args.requirementId, args.userId, args.at, args.userId),
    ],
  };
}

/** Where a decision came from, for the audit trail. */
export type ArrivalDecisionVia = 'arrival' | 'review_queue_combined';

export interface DecideArrivalOptions {
  /**
   * 'arrival' for POST /api/request-uploads/:id/decide, 'review_queue_combined'
   * when the Review Queue approved (or rejected) the file and decided it in the
   * same action. Written into every audit row this decision produces, so the
   * two paths stay distinguishable after the fact.
   */
  via?: ArrivalDecisionVia;
  /** The queue item the combined action approved or rejected. */
  queueItemId?: string | null;
}

interface DecisionContext {
  upload: UploadRow;
  rootRequestId: string;
  current: { id: string; status: DocumentRequestStatus };
  lines: RequestLineRow[];
  entries: Array<{ index: number; decision: DecideArrivalLine; line: RequestLineRow }>;
}

/**
 * Every check a decision can fail WITHOUT knowing which document it is about:
 * the arrival exists in this tenant, the body is well-formed, the ask is still
 * live, every line is on the current version, none repeats, every decision is a
 * known word. Reads only.
 */
async function loadDecisionContext(
  db: D1Database,
  tenantId: string,
  uploadId: string,
  rawDecisions: unknown,
): Promise<DecisionContext> {
  const upload = await loadUploadRow(db, tenantId, uploadId);

  if (!Array.isArray(rawDecisions) || rawDecisions.length === 0) {
    throw new BadRequestError('decisions must be a non-empty array');
  }

  const arrivalVersion = await db
    .prepare('SELECT root_request_id FROM document_requests WHERE id = ? AND tenant_id = ?')
    .bind(upload.request_id, tenantId)
    .first<{ root_request_id: string }>();
  if (!arrivalVersion) throw new NotFoundError('Arrival not found');

  const current = await db
    .prepare(
      `SELECT id, status FROM document_requests
        WHERE root_request_id = ? AND tenant_id = ? AND superseded_at IS NULL`,
    )
    .bind(arrivalVersion.root_request_id, tenantId)
    .first<{ id: string; status: DocumentRequestStatus }>();
  if (!current || current.status !== 'issued') {
    throw new ConflictError(
      `This request is ${current?.status ?? 'no longer live'}, so nothing on it can be decided. ` +
        `Re-issue it if you still need these requirements.`,
    );
  }

  const lines = await loadLines(db, tenantId, current.id);
  const linesById = new Map(lines.map((l) => [l.id, l]));

  const seen = new Set<string>();
  const entries: DecisionContext['entries'] = [];
  for (const [i, raw] of (rawDecisions as unknown[]).entries()) {
    if (!raw || typeof raw !== 'object') {
      throw new BadRequestError(`decisions[${i}] must be an object`);
    }
    const d = raw as DecideArrivalLine;
    const lineId = typeof d.line_id === 'string' ? d.line_id : '';
    const line = linesById.get(lineId);
    if (!line) {
      throw new BadRequestError(
        `decisions[${i}].line_id is not an item on the current version of this request. ` +
          `If the request was amended, reload and decide against the current version.`,
      );
    }
    if (seen.has(line.id)) {
      throw new BadRequestError(`decisions[${i}]: "${line.name}" appears more than once`);
    }
    seen.add(line.id);
    if (d.decision !== 'accepted' && d.decision !== 'needs_attention') {
      throw new BadRequestError(`decisions[${i}].decision must be accepted or needs_attention`);
    }
    entries.push({ index: i, decision: d, line });
  }

  return { upload, rootRequestId: arrivalVersion.root_request_id, current, lines, entries };
}

/**
 * The Review Queue's combined approve-and-decide runs this BEFORE it approves
 * anything, so a decision that could never have been saved (a stale line id, a
 * cancelled ask, a typo'd decision) is refused while nothing has happened yet.
 *
 * What it cannot check is anything about the document, because the document
 * does not exist until the approval creates it. See `runCombinedArrivalDecision`
 * in functions/api/queue/[id].ts for what happens if that part fails afterwards.
 *
 * `willApprove: false` is the reject-and-send-back path: there will be no
 * document, so an `accepted` decision is refused here rather than by the 409
 * after the rejection has already been written.
 */
export async function preflightArrivalDecision(
  db: D1Database,
  tenantId: string,
  uploadId: string,
  rawDecisions: unknown,
  opts: { willApprove: boolean },
): Promise<void> {
  const ctx = await loadDecisionContext(db, tenantId, uploadId, rawDecisions);
  if (!opts.willApprove) {
    const accepted = ctx.entries.find((e) => e.decision.decision === 'accepted');
    if (accepted) {
      throw new BadRequestError(
        `"${accepted.line.name}" cannot be accepted from a file that is being rejected. ` +
          `Send it back instead, or approve the file.`,
      );
    }
  }
  if (ctx.entries.some((e) => e.decision.document_id)) {
    throw new BadRequestError(
      'document_id cannot be chosen in the Review Queue: the document is the one this approval creates.',
    );
  }
}

/**
 * Decide what one arrival satisfies. See the module header for what is written.
 *
 * Every check runs before any write, so a refusal on the third line leaves the
 * first two untouched.
 */
export async function decideArrival(
  db: D1Database,
  user: User,
  tenantId: string,
  uploadId: string,
  rawDecisions: unknown,
  ip: string | null,
  opts: DecideArrivalOptions = {},
): Promise<DecideArrivalResponse> {
  const via: ArrivalDecisionVia = opts.via ?? 'arrival';
  const { upload, rootRequestId, current, entries } = await loadDecisionContext(
    db,
    tenantId,
    uploadId,
    rawDecisions,
  );

  const claimRows = await db
    .prepare(
      `SELECT ul.id AS claim_id, ul.claimed_by, ul.decision,
              l.line_kind, l.requirement_id, l.name
         FROM request_upload_lines ul
         JOIN request_lines l ON l.id = ul.line_id
        WHERE ul.upload_id = ? AND ul.tenant_id = ?`,
    )
    .bind(upload.id, tenantId)
    .all<{
      claim_id: string;
      claimed_by: 'supplier' | 'staff';
      decision: string | null;
      line_kind: RequestLineKind;
      requirement_id: string | null;
      name: string;
    }>();
  const claimsByKey = new Map((claimRows.results ?? []).map((c) => [lineKey(c), c]));

  // --- validate everything before writing anything ---------------------------
  const at = nowIso();
  const statements: D1PreparedStatement[] = [];
  const lineAudits: Array<{ line: RequestLineRow; decision: DecideArrivalLine; documentId: string | null }> = [];
  const staffClaims: Array<{ line: RequestLineRow; claimId: string }> = [];
  const registryAudits: Array<{ line: RequestLineRow; documentId: string; action: string }> = [];

  for (const { index: i, decision: d, line } of entries) {
    let documentId: string | null = upload.document_id;

    if (d.decision === 'accepted') {
      if (!upload.document_id) {
        throw new ConflictError(
          'Approve this file in the Review Queue first. A requirement can only be accepted ' +
            'from a document someone has checked, not from what the supplier said the file is.',
        );
      }
      documentId = clean(d.document_id) ?? upload.document_id;
      const doc = await db
        .prepare(
          `SELECT id, title FROM documents
            WHERE id = ? AND tenant_id = ? AND supplier_id = ? AND status = 'active'`,
        )
        .bind(documentId, tenantId, upload.supplier_id)
        .first<{ id: string; title: string }>();
      if (!doc) {
        throw new BadRequestError(
          `decisions[${i}].document_id must be an active document filed under this supplier`,
        );
      }
      if (line.line_kind === 'requirement' && line.requirement_id) {
        const link = await confirmRequirementLink(db, {
          documentId: doc.id,
          requirementId: line.requirement_id,
          requirementName: line.name,
          userId: user.id,
          at,
        });
        statements.push(...link.statements);
        if (link.action !== 'already_confirmed') {
          registryAudits.push({ line, documentId: doc.id, action: link.action });
        }
      }
    }

    // The claim row: decide on the existing one, or add a staff claim.
    const existingClaim = claimsByKey.get(lineKey(line));
    if (existingClaim) {
      statements.push(
        db
          .prepare(
            `UPDATE request_upload_lines
                SET decision = ?, decision_document_id = ?, decided_at = ?, decided_by = ?
              WHERE id = ? AND tenant_id = ?`,
          )
          .bind(d.decision, documentId, at, user.id, existingClaim.claim_id, tenantId),
      );
    } else {
      const claimId = generateId();
      staffClaims.push({ line, claimId });
      statements.push(
        db
          .prepare(
            `INSERT INTO request_upload_lines
               (id, tenant_id, upload_id, line_id, claimed_by, added_by,
                decision, decision_document_id, decided_at, decided_by)
             VALUES (?, ?, ?, ?, 'staff', ?, ?, ?, ?, ?)`,
          )
          .bind(claimId, tenantId, upload.id, line.id, user.id, d.decision, documentId, at, user.id),
      );
    }

    const accepted = d.decision === 'accepted';
    const statusChanged = line.status !== d.decision;
    statements.push(
      db
        .prepare(
          `UPDATE request_lines
              SET status = ?,
                  status_changed_at = CASE WHEN ? THEN ? ELSE status_changed_at END,
                  status_changed_by = CASE WHEN ? THEN ? ELSE status_changed_by END,
                  status_note = ?,
                  attention_reason = ?,
                  accepted_document_id = ?,
                  updated_at = ?, updated_by = ?
            WHERE id = ? AND tenant_id = ?`,
        )
        .bind(
          d.decision,
          statusChanged ? 1 : 0,
          at,
          statusChanged ? 1 : 0,
          user.id,
          // Internal note: an omitted field keeps what is there; a sent one,
          // even blank, is the reviewer's current word on it.
          d.status_note === undefined ? line.status_note : clean(d.status_note),
          // The supplier-facing sentence. An accepted line has nothing wrong with
          // it, so any old reason goes. A blank needs-attention reason is stored
          // NULL on purpose: the projection composes the fallback from the
          // line's own criteria at read time (`attentionReasonFor`), so the bare
          // word "rejected" is still unreachable and the sentence tracks the
          // line if its wording is later amended.
          accepted ? null : clean(d.attention_reason),
          accepted ? documentId : null,
          at,
          user.id,
          line.id,
          tenantId,
        ),
    );
    lineAudits.push({ line, decision: d, documentId: accepted ? documentId : upload.document_id });
  }

  await db.batch(statements);

  // --- audit trail --------------------------------------------------------------
  for (const { line, decision, documentId } of lineAudits) {
    await auditRequest(
      db,
      user,
      tenantId,
      // The SAME action PUT /api/request-lines/:id writes, so "how did this line
      // move" is one query whichever screen moved it.
      'request_line_status_changed',
      current.id,
      {
        line_id: line.id,
        line_name: line.name,
        requirement_id: line.requirement_id,
        from: line.status,
        to: decision.decision,
        note: decision.status_note ?? null,
        via,
        ...(opts.queueItemId ? { queue_item_id: opts.queueItemId } : {}),
        upload_id: upload.id,
        document_id: documentId,
      },
      ip,
    );
  }
  for (const { line, claimId } of staffClaims) {
    await logAudit(
      db,
      user.id,
      tenantId,
      'request_upload.claim_added',
      'request_upload',
      upload.id,
      JSON.stringify({ claim_id: claimId, line_id: line.id, line_name: line.name, request_id: current.id, via }),
      ip,
    );
  }
  for (const { line, documentId, action } of registryAudits) {
    await logAudit(
      db,
      user.id,
      tenantId,
      'document_requirement.confirmed_via_request',
      'document',
      documentId,
      JSON.stringify({
        requirement_id: line.requirement_id,
        line_id: line.id,
        request_id: current.id,
        upload_id: upload.id,
        link_action: action,
        source: 'request_accept',
        via,
      }),
      ip,
    );
  }
  await logAudit(
    db,
    user.id,
    tenantId,
    'request_upload.decided',
    'request_upload',
    upload.id,
    JSON.stringify({
      request_id: current.id,
      root_request_id: rootRequestId,
      supplier_id: upload.supplier_id,
      via,
      ...(opts.queueItemId ? { queue_item_id: opts.queueItemId } : {}),
      decisions: lineAudits.map(({ line, decision, documentId }) => ({
        line_id: line.id,
        line_name: line.name,
        decision: decision.decision,
        document_id: documentId,
      })),
    }),
    ip,
  );

  const arrival = await loadArrival(db, tenantId, upload.id);
  const counts = countLines(await loadLines(db, tenantId, current.id));
  return { arrival, counts };
}

// ---------------------------------------------------------------------------
// Tenant resolution
// ---------------------------------------------------------------------------

/**
 * Which tenant an arrival-scoped call resolves in.
 *
 * Everyone but a super_admin is pinned to their own tenant BEFORE any read, so
 * another tenant's upload id is a 404 rather than a row — the same arrangement
 * `resolveTenantForRequest` uses.
 */
export async function resolveTenantForUpload(
  db: D1Database,
  user: User,
  uploadId: string,
): Promise<string> {
  if (user.role !== 'super_admin') {
    if (!user.tenant_id) throw new NotFoundError('Arrival not found');
    return user.tenant_id;
  }
  const row = await db
    .prepare('SELECT tenant_id FROM request_uploads WHERE id = ?')
    .bind(uploadId)
    .first<{ tenant_id: string }>();
  if (!row) throw new NotFoundError('Arrival not found');
  return row.tenant_id;
}
