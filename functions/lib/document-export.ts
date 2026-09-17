/**
 * Getting documents OUT -- the one place that turns a set of document ids into
 * a zip, a manifest, and (when it is being mailed) a token-gated link.
 *
 * WHY THIS EXISTS
 * ---------------
 * AJ Conner, 2026-09-14: "the more frictionless it is for them to interact
 * with it and get the data directly, the better". One to three hours of his
 * day is answering document requests, and the person searching is usually
 * forwarding to a salesperson. Search could find the certificate and then
 * abandoned him: one download at a time, then a mail client, then no record of
 * what left.
 *
 * ONE ZIPPER, NOT TWO. The bundle download (functions/api/bundles/[id]/
 * download.ts) already builds an in-memory zip with fflate and already had to
 * solve duplicate file names. `uniqueFileName` and `buildExportZip` below are
 * that logic lifted out so a second implementation cannot drift from the
 * first.
 *
 * THE MANIFEST IS PART OF THE DELIVERABLE. A zip of eleven PDFs named
 * "COA.pdf" through "COA (3).pdf" is a puzzle for whoever opens it. Every
 * export carries a manifest.csv naming, per file, the document, the supplier,
 * the type, and the lot / production date where the portal knows them -- the
 * same facts the sender was looking at when they picked it.
 *
 * THE CAP IS STATED, NOT SILENT. The zip is assembled in memory inside a
 * Worker, so it has a real ceiling; an export over it is REFUSED with the cap
 * in the message, never quietly truncated to the first N files. A truncated
 * compliance package that looks complete is the worst outcome available here.
 */

import { zipSync } from 'fflate';
import { generateId } from './db';
import type {
  DocumentExportItem,
  DocumentExportLandingView,
  DocumentExportLinkState,
  DocumentExportLinkSummary,
} from '../../shared/types';

/**
 * Hard ceilings on one export.
 *
 * MAX_DOCUMENTS is about the request shape (a select-all on a broad search
 * should not become a thousand-row D1 IN clause), MAX_TOTAL_BYTES is about the
 * Worker: `zipSync` holds every file plus the archive in memory at once, and a
 * Pages Function has 128 MB. Forty megabytes of source files leaves room for
 * the archive and the runtime with margin.
 *
 * Both are quoted verbatim to the caller when they are hit -- see
 * `exportSizeRefusal` -- so "too big" is always actionable.
 */
export const EXPORT_MAX_DOCUMENTS = 50;
export const EXPORT_MAX_TOTAL_BYTES = 40 * 1024 * 1024;

/** How many addresses one send may name. A distribution list is not this. */
export const EXPORT_MAX_RECIPIENTS = 10;

/**
 * Default lifetime of an export link. Thirty days, matching alert links
 * (0089): long enough to survive a holiday, short enough that the same email
 * found in an archive two years later opens nothing.
 */
export const EXPORT_LINK_TTL_DAYS = 30;

/** 32 random bytes -> base64url, ~43 chars. Same entropy as /alert/ and /r/. */
export function generateExportToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

// ---------------------------------------------------------------------------
// Reading the documents
// ---------------------------------------------------------------------------

export interface ExportDocumentRow {
  document_id: string;
  title: string;
  supplier_name: string | null;
  document_type_name: string | null;
  version_number: number;
  file_name: string;
  r2_key: string;
  mime_type: string | null;
  file_size: number;
  created_at: string | null;
  /** "10426203 / 03" style, built from the document's lot rows. */
  lot_label: string | null;
  /** ISO date, when exactly one is known and it is not in conflict. */
  production_date: string | null;
}

export interface LoadedExport {
  rows: ExportDocumentRow[];
  /**
   * Ids that were asked for and are not in `rows`: another tenant's, deleted,
   * never uploaded. Reported rather than swallowed -- an export missing a
   * document the requester asked for must say so.
   */
  missing_ids: string[];
}

/**
 * Normalize the caller's id list: strings only, trimmed, de-duplicated, order
 * preserved. Returns at most EXPORT_MAX_DOCUMENTS + 1 entries so the caller
 * can tell "at the cap" from "over it" without walking an unbounded array.
 */
export function normalizeExportIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const id = v.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length > EXPORT_MAX_DOCUMENTS) break;
  }
  return out;
}

/**
 * Load the current version of each requested document, TENANT SCOPED.
 *
 * The tenant filter is in the SQL, not in a later check: an id belonging to
 * another tenant comes back as missing, indistinguishable from an id that
 * never existed, so the endpoint cannot be used to probe for documents
 * elsewhere.
 */
export async function loadExportDocuments(
  db: D1Database,
  tenantId: string,
  ids: string[],
): Promise<LoadedExport> {
  if (ids.length === 0) return { rows: [], missing_ids: [] };

  const placeholders = ids.map(() => '?').join(', ');
  const res = await db
    .prepare(
      `SELECT d.id            AS document_id,
              d.title         AS title,
              d.created_at    AS created_at,
              s.name          AS supplier_name,
              dt.name         AS document_type_name,
              dv.version_number AS version_number,
              dv.file_name    AS file_name,
              dv.r2_key       AS r2_key,
              dv.mime_type    AS mime_type,
              dv.file_size    AS file_size
         FROM documents d
         LEFT JOIN suppliers s       ON s.id  = d.supplier_id
         LEFT JOIN document_types dt ON dt.id = d.document_type_id
         INNER JOIN document_versions dv
                 ON dv.document_id = d.id AND dv.version_number = d.current_version
        WHERE d.tenant_id = ?
          AND d.status != 'deleted'
          AND d.id IN (${placeholders})`,
    )
    .bind(tenantId, ...ids)
    .all<Omit<ExportDocumentRow, 'lot_label' | 'production_date'>>();

  const byId = new Map<string, ExportDocumentRow>();
  for (const r of res.results ?? []) {
    byId.set(r.document_id, { ...r, lot_label: null, production_date: null });
  }

  // Lots are a second query rather than a join: a certificate can certify
  // several lot rows, and fanning the main select out by them would multiply
  // the file rows it returns.
  const lots = await db
    .prepare(
      `SELECT dl.document_id AS document_id,
              l.lot_number   AS lot_number,
              l.sub_lot_code AS sub_lot_code,
              l.production_date AS production_date,
              l.production_date_status AS production_date_status
         FROM document_lots dl
         INNER JOIN lots l ON l.id = dl.lot_id
        WHERE l.tenant_id = ? AND dl.document_id IN (${placeholders})
        ORDER BY l.lot_number ASC, l.sub_lot_code ASC`,
    )
    .bind(tenantId, ...ids)
    .all<{
      document_id: string;
      lot_number: string;
      sub_lot_code: string | null;
      production_date: string | null;
      production_date_status: string | null;
    }>();

  const lotLabels = new Map<string, string[]>();
  const productionDates = new Map<string, Set<string>>();
  for (const l of lots.results ?? []) {
    const label = l.sub_lot_code ? `${l.lot_number} / ${l.sub_lot_code}` : l.lot_number;
    const list = lotLabels.get(l.document_id) ?? [];
    if (!list.includes(label)) list.push(label);
    lotLabels.set(l.document_id, list);
    // A date the portal itself flags as ambiguous, unreadable or in conflict
    // is not printed as fact on a manifest a customer may read.
    if (l.production_date && (l.production_date_status ?? 'resolved') === 'resolved') {
      const set = productionDates.get(l.document_id) ?? new Set<string>();
      set.add(l.production_date);
      productionDates.set(l.document_id, set);
    }
  }

  for (const [docId, row] of byId) {
    const labels = lotLabels.get(docId);
    if (labels && labels.length > 0) row.lot_label = labels.join('; ');
    const dates = productionDates.get(docId);
    // Several lots with different production dates cannot be reduced to one
    // date, so nothing is claimed.
    if (dates && dates.size === 1) row.production_date = [...dates][0];
  }

  const rows = ids.map((id) => byId.get(id)).filter((r): r is ExportDocumentRow => Boolean(r));
  const missing_ids = ids.filter((id) => !byId.has(id));
  return { rows, missing_ids };
}

// ---------------------------------------------------------------------------
// Size
// ---------------------------------------------------------------------------

export function exportTotalBytes(rows: ExportDocumentRow[]): number {
  return rows.reduce((sum, r) => sum + (Number(r.file_size) || 0), 0);
}

function mb(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/**
 * The refusal message, or null when the export fits. One sentence, both
 * numbers in it: what was asked for and what the ceiling is.
 */
export function exportSizeRefusal(rows: ExportDocumentRow[]): string | null {
  const total = exportTotalBytes(rows);
  if (total <= EXPORT_MAX_TOTAL_BYTES) return null;
  return (
    `That selection is ${mb(total)} and the limit for one export is ` +
    `${mb(EXPORT_MAX_TOTAL_BYTES)}. Send it in smaller batches, or share the ` +
    `documents as a bundle instead.`
  );
}

// ---------------------------------------------------------------------------
// The zip
// ---------------------------------------------------------------------------

/**
 * Pick a name not already used, keeping the extension. Lifted verbatim in
 * behaviour from the bundle download so two exports of the same file set do
 * not produce two different name schemes.
 */
export function uniqueFileName(taken: Set<string>, desired: string): string {
  let name = desired || 'unnamed';
  let counter = 1;
  while (taken.has(name)) {
    const dot = name.lastIndexOf('.');
    if (dot > 0) {
      const base = name.substring(0, dot).replace(/_\d+$/, '');
      name = `${base}_${counter}${name.substring(dot)}`;
    } else {
      name = `${name.replace(/_\d+$/, '')}_${counter}`;
    }
    counter++;
  }
  taken.add(name);
  return name;
}

/** RFC 4180 field: always quoted, embedded quotes doubled. */
function csvField(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '""';
  return `"${String(v).replace(/"/g, '""')}"`;
}

export const EXPORT_MANIFEST_NAME = 'manifest.csv';

export interface ManifestMeta {
  /** The organization the documents belong to. */
  tenant_name: string;
  /** Who produced the export, for the header line. */
  exported_by: string;
  /** ISO timestamp. */
  exported_at: string;
  on_behalf_of?: string | null;
}

/**
 * The manifest, as CSV. Column one is the file name inside the zip, because
 * the question a recipient actually has is "which of these files is the
 * Darigold cream certificate".
 */
export function buildExportManifestCsv(
  entries: { file_name: string; row: ExportDocumentRow }[],
  meta: ManifestMeta,
): string {
  const lines: string[] = [];
  lines.push(
    [
      csvField('File name'),
      csvField('Document'),
      csvField('Supplier'),
      csvField('Document type'),
      csvField('Lot'),
      csvField('Production date'),
      csvField('Version'),
      csvField('Filed on'),
    ].join(','),
  );
  for (const e of entries) {
    lines.push(
      [
        csvField(e.file_name),
        csvField(e.row.title),
        csvField(e.row.supplier_name),
        csvField(e.row.document_type_name),
        csvField(e.row.lot_label),
        csvField(e.row.production_date),
        csvField(e.row.version_number),
        csvField(e.row.created_at ? e.row.created_at.slice(0, 10) : null),
      ].join(','),
    );
  }
  // Provenance last, as trailing comment rows: a spreadsheet still parses the
  // table above it, and whoever opens the file can see where it came from.
  lines.push('');
  lines.push([csvField('Exported from'), csvField(meta.tenant_name)].join(','));
  lines.push([csvField('Exported by'), csvField(meta.exported_by)].join(','));
  if (meta.on_behalf_of) {
    lines.push([csvField('On behalf of'), csvField(meta.on_behalf_of)].join(','));
  }
  lines.push([csvField('Exported at'), csvField(meta.exported_at)].join(','));
  return lines.join('\r\n');
}

export interface BuiltExportZip {
  zip: Uint8Array;
  /** What went in, in order, with the name each document ended up under. */
  entries: { file_name: string; row: ExportDocumentRow }[];
  /** Documents whose bytes were not in R2. Reported, never silently dropped. */
  unavailable: ExportDocumentRow[];
}

/**
 * Assemble the archive. The manifest is added LAST, after the names are
 * settled, so it describes the files as they actually landed.
 */
export async function buildExportZip(
  files: R2Bucket,
  rows: ExportDocumentRow[],
  meta: ManifestMeta,
): Promise<BuiltExportZip> {
  const contents: Record<string, Uint8Array> = {};
  const taken = new Set<string>([EXPORT_MANIFEST_NAME]);
  const entries: { file_name: string; row: ExportDocumentRow }[] = [];
  const unavailable: ExportDocumentRow[] = [];

  for (const row of rows) {
    if (!row.r2_key) {
      unavailable.push(row);
      continue;
    }
    const obj = await files.get(row.r2_key);
    if (!obj) {
      unavailable.push(row);
      continue;
    }
    const buf = await obj.arrayBuffer();
    const name = uniqueFileName(taken, row.file_name);
    contents[name] = new Uint8Array(buf);
    entries.push({ file_name: name, row });
  }

  const manifest = buildExportManifestCsv(entries, meta);
  contents[EXPORT_MANIFEST_NAME] = new TextEncoder().encode(manifest);

  return { zip: zipSync(contents), entries, unavailable };
}

/**
 * fflate hands back a `Uint8Array`; the Workers `Response` constructor is
 * typed for an `ArrayBuffer`. Copying the exact byte range is the honest
 * conversion — the view may not span its whole buffer.
 */
export function zipResponseBody(zip: Uint8Array): ArrayBuffer {
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
}

/** `documents-2026-09-15.zip` — dated, so two in a downloads folder differ. */
export function exportZipFileName(now: Date = new Date()): string {
  return `documents-${now.toISOString().slice(0, 10)}.zip`;
}

// ---------------------------------------------------------------------------
// The link
// ---------------------------------------------------------------------------

export interface DocumentExportLinkRow {
  id: string;
  token: string;
  tenant_id: string;
  document_ids: string;
  created_by: string;
  on_behalf_of: string | null;
  recipients: string;
  message: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  /** Who pulled it back (migration 0116). NULL on rows revoked before that. */
  revoked_by?: string | null;
  view_count: number;
  last_viewed_at: string | null;
  download_count: number;
  last_downloaded_at: string | null;
}

export interface MintExportLinkInput {
  tenantId: string;
  documentIds: string[];
  createdBy: string;
  recipients: string[];
  onBehalfOf?: string | null;
  message?: string | null;
  ttlDays?: number;
}

export interface MintedExportLink {
  id: string;
  token: string;
  expires_at: string;
}

/**
 * Create the link row. Unlike `mintAlertLink` this one THROWS on failure
 * rather than returning null: an alert must go out even without a link, but an
 * export email whose link does not exist is an email with nothing in it.
 */
export async function mintExportLink(
  db: D1Database,
  input: MintExportLinkInput,
): Promise<MintedExportLink> {
  const id = generateId();
  const token = generateExportToken();
  const expires = new Date();
  expires.setUTCDate(expires.getUTCDate() + (input.ttlDays ?? EXPORT_LINK_TTL_DAYS));
  const expiresAt = expires.toISOString();

  await db
    .prepare(
      `INSERT INTO document_export_links
         (id, token, tenant_id, document_ids, created_by, on_behalf_of,
          recipients, message, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      token,
      input.tenantId,
      JSON.stringify(input.documentIds),
      input.createdBy,
      input.onBehalfOf ?? null,
      JSON.stringify(input.recipients),
      input.message ?? null,
      expiresAt,
    )
    .run();

  return { id, token, expires_at: expiresAt };
}

/**
 * Shut a link off.
 *
 * Two callers with one behaviour: the send path uses it when the email it was
 * minted for failed (no actor — nobody decided anything, the send simply did
 * not happen), and a person pressing Revoke on "Documents you sent" passes
 * their own id.
 *
 * `revoked_at IS NULL` in the WHERE is not decoration: revoking twice must not
 * move the first revocation's timestamp, because "when did this stop working"
 * is exactly the question the row is kept to answer. A second press is a no-op
 * that reports zero rows changed.
 */
export async function revokeExportLink(
  db: D1Database,
  id: string,
  revokedBy?: string | null,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE document_export_links
          SET revoked_at = datetime('now'), revoked_by = ?
        WHERE id = ? AND revoked_at IS NULL`,
    )
    .bind(revokedBy ?? null, id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Which of the three states a link is in, as of `now`.
 *
 * REVOKED BEATS EXPIRED when both are true. A reader of this list is asking
 * whether somebody pulled the link back; collapsing that into "expired"
 * because thirty days have since passed would erase the only fact worth
 * recording about it.
 */
export function exportLinkState(
  row: Pick<DocumentExportLinkRow, 'revoked_at' | 'expires_at'>,
  now: Date = new Date(),
): DocumentExportLinkState {
  if (row.revoked_at) return 'revoked';
  if (!row.expires_at) return 'expired';
  return new Date(row.expires_at).getTime() <= now.getTime() ? 'expired' : 'active';
}

/**
 * How many document titles one row carries into the list. A send is capped at
 * 50 documents; printing all of them would turn a twenty-row screen into a
 * thousand-line one, so the list names the first few and says there are more.
 * The count is always exact — it comes from the frozen id list, not from this.
 */
export const EXPORT_LINK_TITLE_PREVIEW = 6;

export interface ExportLinkListRow extends DocumentExportLinkRow {
  sent_by_name: string | null;
  sent_by_email: string | null;
  revoked_by_name: string | null;
}

/**
 * Project one stored link into the internal list shape.
 *
 * THE TOKEN IS NOT IN THE OUTPUT, deliberately. This screen exists so a person
 * can see and withdraw what they sent; handing every tenant user the live
 * bearer URL for every export ever sent would make the accountability surface
 * the largest hole in the feature. Anyone who needs the link again has the
 * email, and the honest answer for anyone who does not is a new send.
 */
export function buildExportLinkSummary(
  row: ExportLinkListRow,
  titlesById: Map<string, string>,
  canRevoke: boolean,
  now: Date = new Date(),
): DocumentExportLinkSummary {
  const ids = parseStringList(row.document_ids);
  const titles = ids
    .slice(0, EXPORT_LINK_TITLE_PREVIEW)
    // A document deleted since the send has no title left to print. Saying so
    // is better than dropping the row and leaving the count unexplained.
    .map((id) => titlesById.get(id) ?? 'Document no longer in the portal');
  return {
    id: row.id,
    state: exportLinkState(row, now),
    created_at: row.created_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    revoked_by_name: row.revoked_by_name ?? null,
    sent_by_id: row.created_by,
    sent_by_name: row.sent_by_name ?? null,
    sent_by_email: row.sent_by_email ?? null,
    on_behalf_of: row.on_behalf_of,
    message: row.message,
    recipients: parseStringList(row.recipients),
    document_count: ids.length,
    document_titles: titles,
    documents_truncated: ids.length > titles.length,
    view_count: Number(row.view_count) || 0,
    last_viewed_at: row.last_viewed_at,
    download_count: Number(row.download_count) || 0,
    last_downloaded_at: row.last_downloaded_at,
    can_revoke: canRevoke,
  };
}

/**
 * Titles for every document named by these links, tenant scoped.
 *
 * Deleted documents are simply absent — the caller prints a placeholder. The
 * tenant filter is here rather than at the call site for the same reason it is
 * in `loadExportDocuments`: a link's frozen id list is data, and data is never
 * trusted to stay inside its own tenant just because it started there.
 */
export async function loadExportLinkTitles(
  db: D1Database,
  tenantId: string,
  links: Pick<DocumentExportLinkRow, 'document_ids'>[],
): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const l of links) {
    for (const id of parseStringList(l.document_ids).slice(0, EXPORT_LINK_TITLE_PREVIEW)) {
      ids.add(id);
    }
  }
  const out = new Map<string, string>();
  const list = [...ids];
  if (list.length === 0) return out;
  // D1 caps bound parameters per statement; chunking keeps a page of links
  // with six titles each comfortably inside it whatever the page size becomes.
  const CHUNK = 90;
  for (let i = 0; i < list.length; i += CHUNK) {
    const slice = list.slice(i, i + CHUNK);
    const res = await db
      .prepare(
        `SELECT id, title FROM documents
          WHERE tenant_id = ? AND id IN (${slice.map(() => '?').join(', ')})`,
      )
      .bind(tenantId, ...slice)
      .all<{ id: string; title: string }>();
    for (const r of res.results ?? []) out.set(r.id, r.title);
  }
  return out;
}

/** The URL an email should point at. Null when either half is missing. */
export function exportLinkUrl(appUrl: string | undefined, token: string | null): string | null {
  if (!appUrl || !token) return null;
  return `${appUrl.replace(/\/$/, '')}/export/${token}`;
}

/**
 * Look a token up and decide whether it is still usable. Returns null for
 * EVERY unusable case — unknown, expired, revoked — so the endpoint answers
 * 404 uniformly and a token cannot be probed for existence.
 */
export async function loadUsableExportLink(
  db: D1Database,
  token: string,
): Promise<DocumentExportLinkRow | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const row = await db
    .prepare('SELECT * FROM document_export_links WHERE token = ?')
    .bind(token)
    .first<DocumentExportLinkRow>();
  if (!row) return null;
  if (row.revoked_at) return null;
  if (!row.expires_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return row;
}

/** Parse a JSON string column into a string[]. Tolerant. */
export function parseStringList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The documents a link covers, in the order they were sent, loaded through the
 * same tenant-scoped reader as everything else.
 *
 * This is the ONLY way the public routes learn which documents they may touch.
 * They never take an id from the request.
 */
export async function loadExportLinkDocuments(
  db: D1Database,
  link: DocumentExportLinkRow,
): Promise<ExportDocumentRow[]> {
  const ids = parseStringList(link.document_ids);
  if (ids.length === 0) return [];
  const { rows } = await loadExportDocuments(db, link.tenant_id, ids);
  return rows;
}

/**
 * Project one export into the exact payload a recipient may see.
 *
 * ALLOW-LIST, in the `buildAlertLandingView` mould. Every field is named on
 * purpose. Deliberately NOT here:
 *
 *   - any internal id (document, tenant, supplier, version, link)
 *   - the R2 key, or anything else that addresses storage
 *   - our configured spec limits, spec verdicts, classification, confidence
 *   - who reviewed it, who owns it, internal notes, requirement links
 *   - anything belonging to a document that was not in this export
 *
 * Files are addressed by their POSITION in the link's own list, so the
 * recipient never holds an identifier that means anything anywhere else.
 */
export async function buildExportLandingView(
  db: D1Database,
  link: DocumentExportLinkRow,
): Promise<DocumentExportLandingView | null> {
  const tenant = await db
    .prepare('SELECT name FROM tenants WHERE id = ?')
    .bind(link.tenant_id)
    .first<{ name: string }>();
  if (!tenant) return null;

  const sender = await db
    .prepare('SELECT name, email FROM users WHERE id = ?')
    .bind(link.created_by)
    .first<{ name: string | null; email: string | null }>();

  const rows = await loadExportLinkDocuments(db, link);

  const items: DocumentExportItem[] = rows.map((r, i) => ({
    index: i,
    title: r.title,
    supplier_name: r.supplier_name,
    document_type_name: r.document_type_name,
    lot_label: r.lot_label,
    production_date: r.production_date,
    file_name: r.file_name,
    file_size: Number(r.file_size) || 0,
  }));

  return {
    tenant_name: tenant.name,
    sent_by_name: sender?.name ?? null,
    sent_by_email: sender?.email ?? null,
    on_behalf_of: link.on_behalf_of,
    message: link.message,
    expires_at: link.expires_at,
    documents: items,
  };
}

/** Best-effort counters; the audit row is the authoritative record. */
export async function recordExportLinkView(
  db: D1Database,
  linkId: string,
  kind: 'view' | 'download',
): Promise<void> {
  try {
    const sql =
      kind === 'view'
        ? `UPDATE document_export_links
              SET view_count = view_count + 1, last_viewed_at = datetime('now')
            WHERE id = ?`
        : `UPDATE document_export_links
              SET download_count = download_count + 1, last_downloaded_at = datetime('now')
            WHERE id = ?`;
    await db.prepare(sql).bind(linkId).run();
  } catch (err) {
    console.error(
      '[document-export] recording a link view failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}
