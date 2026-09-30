/**
 * "You already have this" (migration 0132) -- the D1 half.
 *
 * Computes, for pending COA-kind queue items, the approved document the item
 * is the same file as (byte-identical, the 0108 match) or a NEWER REVISION of
 * (same supplier + type + document number / certificate number / exact lot
 * set, different bytes -- the rule is pure, in shared/duplicateProposal.ts).
 *
 * Read-time, never stored: the proposal is recomputed on every queue read and
 * again at approval, from the item's STORED extraction and resolved supplier /
 * type, so the card and the server can never disagree about whether a decision
 * is required. It vanishes by itself if the matched document is deleted.
 *
 * The ledger half (what a person DECIDED) is `recordDuplicateDecision`, which
 * writes to `intake_duplicates`, the 0108 ledger, extended by 0132.
 */

import { generateId, logAudit } from '../db';
import { queueIdFromExternalRef } from './duplicates';
import { computeRecordLotKey } from '../kinds/coa';
import { loadResolvedLotScheme } from '../lot-schemes';
import { looksLikeCoaType } from '../../../shared/renewalPeriod';
import { parseCoaRecords } from '../../../shared/types';
import type {
  DuplicateDecision,
  DuplicateMatchBasis,
  DuplicateProposal,
  DuplicateProposalDocument,
} from '../../../shared/types';
import {
  duplicateReason,
  identityNumbers,
  keptVersionsLabel,
  pickRevisionMatch,
  type ArrivalIdentity,
  type RevisionCandidate,
} from '../../../shared/duplicateProposal';

/** D1 refuses more than 100 bound parameters per statement. */
const IN_CHUNK = 80;
function chunk<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
function ph(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

export interface AlreadyHaveInputItem {
  id: string;
  tenant_id: string;
  checksum: string | null;
  status: string;
  output_kind?: string | null;
  supplier_id?: string | null;
  document_type_id?: string | null;
  ai_fields?: string | null;
  ai_records?: string | null;
  packet_split_at?: string | null;
}

interface DocRow {
  id: string;
  title: string;
  current_version: number;
  external_ref: string | null;
  origin_queue_id: string | null;
  approved_at: string | null;
  created_at: string | null;
  supplier_name: string | null;
  document_type_name: string | null;
}

const DOC_COLUMNS = `d.id, d.title, d.current_version, d.external_ref, d.origin_queue_id,
  COALESCE(d.approved_at, d.created_at) AS approved_at, d.created_at,
  s.name AS supplier_name, dt.name AS document_type_name`;
const DOC_JOINS = `LEFT JOIN suppliers s ON s.id = d.supplier_id
  LEFT JOIN document_types dt ON dt.id = d.document_type_id`;

function originOf(d: Pick<DocRow, 'id' | 'external_ref' | 'origin_queue_id'>): string {
  return queueIdFromExternalRef(d.external_ref) ?? d.origin_queue_id ?? `doc:${d.id}`;
}

function eligible(it: AlreadyHaveInputItem): boolean {
  if (it.status !== 'pending') return false;
  const kind = it.output_kind || 'coa';
  if (kind !== 'coa') return false; // an order/shipment approval makes records, not a document
  if (it.packet_split_at) return false; // a split container is never approved
  return true;
}

async function lotKeysFor(db: D1Database, docIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const part of chunk(docIds)) {
    const rows = await db
      .prepare(
        `SELECT dl.document_id, l.lot_key FROM document_lots dl JOIN lots l ON l.id = dl.lot_id
          WHERE dl.document_id IN (${ph(part.length)})`,
      )
      .bind(...part)
      .all<{ document_id: string; lot_key: string }>();
    for (const r of rows.results ?? []) {
      const list = out.get(r.document_id) ?? [];
      if (!list.includes(r.lot_key)) list.push(r.lot_key);
      out.set(r.document_id, list);
    }
  }
  return out;
}

async function buildProposal(
  db: D1Database,
  docs: DocRow[],
  basis: DuplicateMatchBasis,
  matchedValue: string | null,
  intakeDuplicateId: string | null,
): Promise<DuplicateProposal> {
  const sorted = [...docs].sort((a, b) =>
    String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || a.id.localeCompare(b.id),
  );
  const lots = await lotKeysFor(db, sorted.map((d) => d.id));
  const documents: DuplicateProposalDocument[] = sorted.map((d) => ({
    id: d.id,
    title: d.title,
    current_version: Number(d.current_version) || 1,
    lot_keys: lots.get(d.id) ?? [],
  }));
  const primary = sorted[0];
  const current = Number(primary.current_version) || 1;
  return {
    basis,
    reason: duplicateReason(basis, matchedValue),
    matched_value: matchedValue,
    document_id: primary.id,
    document_title: primary.title,
    supplier_name: primary.supplier_name,
    document_type_name: primary.document_type_name,
    approved_at: primary.approved_at,
    current_version: current,
    next_version: current + 1,
    documents,
    intake_duplicate_id: intakeDuplicateId,
  };
}

// ---------------------------------------------------------------------------
// 1. Byte-identical
// ---------------------------------------------------------------------------

async function identicalMatches(
  db: D1Database,
  tenantId: string,
  items: AlreadyHaveInputItem[],
): Promise<Map<string, DocRow[]>> {
  const out = new Map<string, DocRow[]>();
  const checksums = [...new Set(items.map((i) => i.checksum).filter((c): c is string => !!c))];
  if (checksums.length === 0) return out;

  // Live documents whose version is these bytes.
  const byChecksum = new Map<string, DocRow[]>();
  for (const part of chunk(checksums)) {
    const rows = await db
      .prepare(
        `SELECT DISTINCT dv.checksum, ${DOC_COLUMNS}
           FROM document_versions dv
           JOIN documents d ON d.id = dv.document_id
           ${DOC_JOINS}
          WHERE d.tenant_id = ? AND d.status = 'active' AND dv.checksum IN (${ph(part.length)})`,
      )
      .bind(tenantId, ...part)
      .all<DocRow & { checksum: string }>();
    for (const r of rows.results ?? []) {
      const list = byChecksum.get(r.checksum) ?? [];
      if (!list.some((d) => d.id === r.id)) list.push(r);
      byChecksum.set(r.checksum, list);
    }
  }

  // Approved queue items that are these bytes (a page-scoped records COA:
  // its documents carry their own pages' checksum, the item the arrival's).
  for (const part of chunk(checksums)) {
    const rows = await db
      .prepare(
        `SELECT id, checksum FROM processing_queue
          WHERE tenant_id = ? AND status = 'approved' AND checksum IN (${ph(part.length)})`,
      )
      .bind(tenantId, ...part)
      .all<{ id: string; checksum: string }>();
    for (const q of rows.results ?? []) {
      const docs = await db
        .prepare(
          `SELECT ${DOC_COLUMNS} FROM documents d ${DOC_JOINS}
            WHERE d.tenant_id = ? AND d.status = 'active'
              AND (d.external_ref = 'queue-' || ? OR d.external_ref LIKE 'queue-' || ? || '-%' OR d.origin_queue_id = ?)`,
        )
        .bind(tenantId, q.id, q.id, q.id)
        .all<DocRow>();
      const list = byChecksum.get(q.checksum) ?? [];
      for (const d of docs.results ?? []) if (!list.some((x) => x.id === d.id)) list.push(d);
      byChecksum.set(q.checksum, list);
    }
  }

  for (const it of items) {
    if (!it.checksum) continue;
    const docs = (byChecksum.get(it.checksum) ?? []).filter((d) => originOf(d) !== it.id);
    if (docs.length === 0) continue;
    // The OLDEST approval is the original (0108's rule); every document it
    // produced is versioned together.
    const groups = new Map<string, DocRow[]>();
    for (const d of docs) {
      const g = groups.get(originOf(d)) ?? [];
      g.push(d);
      groups.set(originOf(d), g);
    }
    const oldest = [...groups.values()].sort((a, b) => {
      const ma = a.map((d) => String(d.created_at ?? '')).sort()[0];
      const mb = b.map((d) => String(d.created_at ?? '')).sort()[0];
      return ma.localeCompare(mb);
    })[0];
    out.set(it.id, oldest);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. Same document, newer revision
// ---------------------------------------------------------------------------

function parseJson(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringFields(m: Record<string, unknown>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(m)) out[k] = v == null ? null : typeof v === 'string' ? v : String(v);
  return out;
}

/** The arrival's identity keys, from what the worker extracted (records first). */
async function arrivalIdentity(db: D1Database, it: AlreadyHaveInputItem): Promise<ArrivalIdentity | null> {
  const records = parseCoaRecords(it.ai_records ?? null);
  const fieldMaps: Array<Record<string, string | null>> = [];
  if (records && records.records.length > 0) {
    const page = stringFields((records.page_metadata ?? {}) as Record<string, unknown>);
    for (const r of records.records) fieldMaps.push({ ...page, ...stringFields((r.fields ?? {}) as Record<string, unknown>) });
  } else {
    const flat = parseJson(it.ai_fields);
    if (flat) fieldMaps.push(stringFields(flat));
  }
  if (fieldMaps.length === 0) return null;
  const numbers = identityNumbers(fieldMaps);
  const scheme = await loadResolvedLotScheme(db, it.tenant_id, it.supplier_id ?? null);
  const lots = new Set<string>();
  for (const m of fieldMaps) {
    const k = computeRecordLotKey(m, scheme);
    if (k) lots.add(k.lotKey);
  }
  return { ...numbers, lot_keys: [...lots] };
}

async function revisionMatch(
  db: D1Database,
  it: AlreadyHaveInputItem,
  typeCache: Map<string, { name: string; renewal_policy: string | null } | null>,
): Promise<{ docs: DocRow[]; basis: DuplicateMatchBasis; value: string } | null> {
  if (!it.supplier_id || !it.document_type_id) return null;
  if (!it.ai_fields && !it.ai_records) return null;
  const identity = await arrivalIdentity(db, it);
  if (!identity) return null;

  if (!typeCache.has(it.document_type_id)) {
    const t = await db
      .prepare('SELECT name, renewal_policy FROM document_types WHERE id = ? AND tenant_id = ?')
      .bind(it.document_type_id, it.tenant_id)
      .first<{ name: string; renewal_policy: string | null }>();
    typeCache.set(it.document_type_id, t ?? null);
  }
  const type = typeCache.get(it.document_type_id);
  if (!type) return null;
  const lotScoped = type.renewal_policy === 'none' || looksLikeCoaType(type.name);

  const hasNumbers = identity.document_numbers.length > 0 || identity.certificate_numbers.length > 0;
  const useLots = lotScoped && identity.lot_keys.length > 0;
  if (!hasNumbers && !useLots) return null;

  const rowsById = new Map<string, DocRow & { primary_metadata?: string | null }>();

  if (hasNumbers) {
    const rows = await db
      .prepare(
        `SELECT ${DOC_COLUMNS}, d.primary_metadata FROM documents d ${DOC_JOINS}
          WHERE d.tenant_id = ? AND d.status = 'active' AND d.supplier_id = ? AND d.document_type_id = ?
            AND (d.primary_metadata LIKE '%document_number%' OR d.primary_metadata LIKE '%certificate_n%')
          ORDER BY COALESCE(d.approved_at, d.created_at) DESC
          LIMIT 1000`,
      )
      .bind(it.tenant_id, it.supplier_id, it.document_type_id)
      .all<DocRow & { primary_metadata: string | null }>();
    for (const r of rows.results ?? []) rowsById.set(r.id, r);
  }

  if (useLots) {
    // Documents carrying ANY of the arrival's lots, then every document of the
    // same origin so the SET can be compared (a records COA is one document
    // per lot).
    const seedRows: DocRow[] = [];
    for (const part of chunk(identity.lot_keys)) {
      const rows = await db
        .prepare(
          `SELECT DISTINCT ${DOC_COLUMNS} FROM document_lots dl
             JOIN lots l ON l.id = dl.lot_id
             JOIN documents d ON d.id = dl.document_id
             ${DOC_JOINS}
            WHERE d.tenant_id = ? AND d.status = 'active' AND d.supplier_id = ? AND d.document_type_id = ?
              AND l.tenant_id = ? AND l.lot_key IN (${ph(part.length)})`,
        )
        .bind(it.tenant_id, it.supplier_id, it.document_type_id, it.tenant_id, ...part)
        .all<DocRow>();
      seedRows.push(...(rows.results ?? []));
    }
    const origins = [...new Set(seedRows.map((d) => queueIdFromExternalRef(d.external_ref) ?? d.origin_queue_id).filter((x): x is string => !!x))];
    for (const d of seedRows) rowsById.set(d.id, { ...(rowsById.get(d.id) ?? {}), ...d });
    for (const q of origins.slice(0, 50)) {
      const sib = await db
        .prepare(
          `SELECT ${DOC_COLUMNS} FROM documents d ${DOC_JOINS}
            WHERE d.tenant_id = ? AND d.status = 'active' AND d.supplier_id = ? AND d.document_type_id = ?
              AND (d.external_ref = 'queue-' || ? OR d.external_ref LIKE 'queue-' || ? || '-%' OR d.origin_queue_id = ?)`,
        )
        .bind(it.tenant_id, it.supplier_id, it.document_type_id, q, q, q)
        .all<DocRow>();
      for (const d of sib.results ?? []) if (!rowsById.has(d.id)) rowsById.set(d.id, d);
    }
  }

  const docs = [...rowsById.values()].filter((d) => originOf(d) !== it.id);
  if (docs.length === 0) return null;
  const lots = useLots ? await lotKeysFor(db, docs.map((d) => d.id)) : new Map<string, string[]>();
  const candidates: RevisionCandidate[] = docs.map((d) => {
    const meta = parseJson((d as { primary_metadata?: string | null }).primary_metadata ?? null);
    const nums = identityNumbers([meta]);
    return {
      document_id: d.id,
      origin: originOf(d),
      lot_keys: lots.get(d.id) ?? [],
      approved_at: d.approved_at,
      ...nums,
    };
  });
  const match = pickRevisionMatch(identity, candidates, { lotScoped });
  if (!match) return null;
  return {
    docs: docs.filter((d) => match.document_ids.includes(d.id)),
    basis: match.basis,
    value: match.matched_value,
  };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * `already_have` for a page of queue items. Best-effort: a failure returns no
 * proposals rather than failing the queue read (the approve path recomputes
 * with `alreadyHaveFor`, which does NOT swallow, so a proposal can never be
 * skipped by an error at the one place it gates).
 */
export async function loadAlreadyHave(
  db: D1Database,
  items: AlreadyHaveInputItem[],
): Promise<Map<string, DuplicateProposal | null>> {
  const out = new Map<string, DuplicateProposal | null>();
  for (const it of items) out.set(it.id, null);
  try {
    const candidates = items.filter(eligible);
    const byTenant = new Map<string, AlreadyHaveInputItem[]>();
    for (const it of candidates) {
      const list = byTenant.get(it.tenant_id) ?? [];
      list.push(it);
      byTenant.set(it.tenant_id, list);
    }
    const typeCache = new Map<string, { name: string; renewal_policy: string | null } | null>();
    for (const [tenantId, list] of byTenant) {
      const identical = await identicalMatches(db, tenantId, list);
      const ledger = await ledgerRowsFor(db, list.map((i) => i.id));
      for (const it of list) {
        const docs = identical.get(it.id);
        if (docs && docs.length > 0) {
          out.set(it.id, await buildProposal(db, docs, 'identical_bytes', null, ledger.get(it.id) ?? null));
          continue;
        }
        const rev = await revisionMatch(db, it, typeCache);
        if (rev && rev.docs.length > 0) {
          out.set(it.id, await buildProposal(db, rev.docs, rev.basis, rev.value, ledger.get(it.id) ?? null));
        }
      }
    }
  } catch (err) {
    console.warn('already-have: load failed:', err instanceof Error ? err.message : String(err));
  }
  return out;
}

/** The proposal for ONE item, for the approve gate. Throws on a read failure. */
export async function alreadyHaveFor(db: D1Database, it: AlreadyHaveInputItem): Promise<DuplicateProposal | null> {
  if (!eligible(it)) return null;
  const identical = await identicalMatches(db, it.tenant_id, [it]);
  const ledger = await ledgerRowsFor(db, [it.id]);
  const docs = identical.get(it.id);
  if (docs && docs.length > 0) return buildProposal(db, docs, 'identical_bytes', null, ledger.get(it.id) ?? null);
  const rev = await revisionMatch(db, it, new Map());
  if (rev && rev.docs.length > 0) return buildProposal(db, rev.docs, rev.basis, rev.value, ledger.get(it.id) ?? null);
  return null;
}

/** The ledger row a queued arrival already has (intake wrote it, or Review anyway). */
async function ledgerRowsFor(db: D1Database, queueIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    for (const part of chunk(queueIds)) {
      const rows = await db
        .prepare(
          `SELECT id, queue_id FROM intake_duplicates
            WHERE queue_id IN (${ph(part.length)}) AND match_kind = 'already_approved'
            ORDER BY received_at ASC`,
        )
        .bind(...part)
        .all<{ id: string; queue_id: string }>();
      for (const r of rows.results ?? []) if (!out.has(r.queue_id)) out.set(r.queue_id, r.id);
    }
  } catch {
    // Pre-0108 database: no ledger.
  }
  return out;
}

// ---------------------------------------------------------------------------
// Intake: a byte-identical arrival is queued WITH its ledger row
// ---------------------------------------------------------------------------

export interface QueuedDuplicateArgs {
  tenantId: string;
  queueId: string;
  checksum: string;
  matchedDocumentId: string | null;
  matchedQueueId: string | null;
  source: string;
  sourceDetail: string | null;
  sourceId: string | null;
  connectorRunId: string | null;
  requestUploadId: string | null;
  fileName: string;
  fileSize: number;
  mimeType: string;
  fileR2Key: string;
  enqueueParams: unknown;
  createdBy: string | null;
  clientIp: string | null;
}

/**
 * Record that an arrival byte-identical to an approved document was QUEUED
 * for a person to decide (0132), not suppressed. One ledger row, one audit row.
 * Best-effort: the card exists either way, and the proposal is computed at
 * read, so a missing ledger row costs the "received" history, not the choice.
 */
export async function recordQueuedDuplicate(db: D1Database, args: QueuedDuplicateArgs): Promise<string | null> {
  const id = generateId();
  try {
    await db
      .prepare(
        `INSERT INTO intake_duplicates
           (id, tenant_id, checksum, match_kind, matched_document_id, matched_queue_id,
            source, source_detail, source_id, connector_run_id, request_upload_id,
            file_name, file_size, mime_type, file_r2_key, enqueue_params, created_by,
            queue_id, match_basis, disposition)
         VALUES (?, ?, ?, 'already_approved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'identical_bytes', 'queued')`,
      )
      .bind(
        id,
        args.tenantId,
        args.checksum,
        args.matchedDocumentId,
        args.matchedQueueId,
        args.source,
        args.sourceDetail,
        args.sourceId,
        args.connectorRunId,
        args.requestUploadId,
        args.fileName,
        args.fileSize,
        args.mimeType,
        args.fileR2Key,
        JSON.stringify(args.enqueueParams ?? {}),
        args.createdBy,
        args.queueId,
      )
      .run();
  } catch (err) {
    console.warn('already-have: ledger write failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
  try {
    await logAudit(
      db,
      args.createdBy,
      args.tenantId,
      'intake.duplicate_queued',
      'processing_queue',
      args.queueId,
      JSON.stringify({
        intake_duplicate_id: id,
        match_basis: 'identical_bytes',
        matched_document_id: args.matchedDocumentId,
        matched_queue_id: args.matchedQueueId,
        source: args.source,
        file_name: args.fileName,
        checksum: args.checksum,
        ...(args.requestUploadId ? { request_upload_id: args.requestUploadId } : {}),
      }),
      args.clientIp,
    );
  } catch (err) {
    console.warn('already-have: audit write failed:', err);
  }
  return id;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface DuplicateDecisionRecord {
  item: {
    id: string;
    tenant_id: string;
    checksum: string | null;
    file_name: string;
    file_size: number;
    mime_type: string;
    file_r2_key: string;
    source?: string | null;
    source_detail?: string | null;
    source_id?: string | null;
    connector_run_id?: string | null;
    created_by?: string | null;
  };
  proposal: DuplicateProposal;
  decision: DuplicateDecision | 'rejected';
  userId: string;
  /** The document the decision produced (keep_both) or versioned (replace). */
  documentId: string | null;
  /** The version replace created. */
  versionNumber: number | null;
  /** Every document replace versioned, with its before/after version. */
  replaced?: Array<{ document_id: string; previous_version: number; new_version: number }>;
  clientIp: string | null;
}

/** Plain words for the audit row and the toast. */
export function decisionSummary(
  decision: DuplicateDecision | 'rejected',
  proposal: DuplicateProposal,
  versionNumber: number | null,
): string {
  if (decision === 'replace') {
    const v = versionNumber ?? proposal.next_version;
    return `Replaced "${proposal.document_title}": it is now v${v}; ${keptVersionsLabel(v - 1)}.`;
  }
  if (decision === 'keep_both') return `Kept as a new document; "${proposal.document_title}" is unchanged.`;
  if (decision === 'discard') return `Discarded this copy; "${proposal.document_title}" is unchanged.`;
  return `Rejected; "${proposal.document_title}" is unchanged.`;
}

/**
 * Write the person's decision to the ledger (updating the row intake wrote,
 * or inserting one for a newer-revision match, which is only known after
 * extraction) and audit it. Best-effort on the ledger; the audit row is the
 * copy nobody can rewrite.
 */
export async function recordDuplicateDecision(db: D1Database, rec: DuplicateDecisionRecord): Promise<void> {
  const { item, proposal } = rec;
  let ledgerId = proposal.intake_duplicate_id;
  try {
    if (ledgerId) {
      await db
        .prepare(
          `UPDATE intake_duplicates
              SET decision = ?, decided_by = ?, decided_at = datetime('now'),
                  decision_document_id = ?, decision_version_number = ?,
                  match_basis = COALESCE(match_basis, ?)
            WHERE id = ? AND tenant_id = ?`,
        )
        .bind(rec.decision, rec.userId, rec.documentId, rec.versionNumber, proposal.basis, ledgerId, item.tenant_id)
        .run();
    } else {
      ledgerId = generateId();
      await db
        .prepare(
          `INSERT INTO intake_duplicates
             (id, tenant_id, checksum, match_kind, matched_document_id, matched_queue_id,
              source, source_detail, source_id, connector_run_id, request_upload_id,
              file_name, file_size, mime_type, file_r2_key, enqueue_params, created_by,
              queue_id, match_basis, disposition, decision, decided_by, decided_at,
              decision_document_id, decision_version_number)
           VALUES (?, ?, ?, 'already_approved', ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?, '{}', ?, ?, ?, 'queued', ?, ?, datetime('now'), ?, ?)`,
        )
        .bind(
          ledgerId,
          item.tenant_id,
          item.checksum ?? '',
          proposal.document_id,
          item.source ?? 'unknown',
          item.source_detail ?? null,
          item.source_id ?? null,
          item.connector_run_id ?? null,
          item.file_name,
          item.file_size,
          item.mime_type,
          item.file_r2_key,
          item.created_by ?? null,
          item.id,
          proposal.basis,
          rec.decision,
          rec.userId,
          rec.documentId,
          rec.versionNumber,
        )
        .run();
    }
  } catch (err) {
    console.warn('already-have: decision ledger write failed:', err instanceof Error ? err.message : String(err));
  }

  await logAudit(
    db,
    rec.userId,
    item.tenant_id,
    'queue_item.duplicate_decided',
    'processing_queue',
    item.id,
    JSON.stringify({
      decision: rec.decision,
      summary: decisionSummary(rec.decision, proposal, rec.versionNumber),
      match_basis: proposal.basis,
      matched_value: proposal.matched_value,
      matched_document_id: proposal.document_id,
      matched_document_title: proposal.document_title,
      matched_document_ids: proposal.documents.map((d) => d.id),
      document_id: rec.documentId,
      version_number: rec.versionNumber,
      ...(rec.replaced ? { replaced: rec.replaced } : {}),
      intake_duplicate_id: ledgerId,
      file_name: item.file_name,
    }),
    rec.clientIp,
  );
}

/** A `processing_queue` row (pq.*) as the input the proposal reads. */
export function alreadyHaveInput(row: Record<string, unknown>): AlreadyHaveInputItem {
  const str = (v: unknown): string | null => (v == null ? null : String(v));
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    checksum: str(row.checksum),
    status: String(row.status),
    output_kind: str(row.output_kind),
    supplier_id: str(row.supplier_id),
    document_type_id: str(row.document_type_id),
    ai_fields: str(row.ai_fields),
    ai_records: str(row.ai_records),
    packet_split_at: str(row.packet_split_at),
  };
}
