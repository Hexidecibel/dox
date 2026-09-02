/**
 * Request links — the token-gated door a supplier walks through.
 *
 * WHY THIS EXISTS
 * ---------------
 * 0090 built the ask. `buildSupplierRequestView` in ./document-requests.ts has
 * been the supplier-facing projection since then, but the only route serving it
 * sat behind the JWT gate, as an authenticated preview. The module note there
 * says what should happen next in as many words: "There is deliberately no
 * token-gated public variant yet — the moment one is wanted it follows the
 * alert_links pattern (0089): an expiring token, one link, one ask. It is not a
 * filter added to this route."
 *
 * This module is that door. It mints and resolves the token, derives the
 * per-item handles the page needs, and gathers the three reads that turn a
 * static packet into something a supplier can answer. It deliberately does NOT
 * build the outward payload — that stays in `buildSupplierRequestView`, which
 * remains the ONE place the external shape is decided, because an allow-list
 * with two implementations is an allow-list with a hole in it.
 *
 * WHAT IT IS NOT
 * --------------
 * Not a portal. There is no login, no navigation, no search, no way to reach a
 * second supplier's ask, and no download of anything we hold. One link, one
 * ask, read plus upload.
 */

import { generateId } from './db';
// TYPE-ONLY, and that matters: ./document-requests imports mintRequestLink from
// this module, so a value import here would close a runtime cycle. The
// assembler that pairs these two lives over there, next to the projection it
// feeds, for exactly that reason.
import type { SupplierUploadSource } from './document-requests';
import type { DocumentRequestRow, RequestLineRow } from '../../shared/types';

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

/**
 * Floor on a link's life. A request with no deadline still gets a working
 * quarter — the chase cycle for a certificate is measured in weeks, not days.
 */
export const REQUEST_LINK_MIN_TTL_DAYS = 90;

/**
 * Grace past the deadline.
 *
 * The deadline passing is the single most likely moment for a supplier to open
 * the link, because that is when the chase email lands. Expiring on the due
 * date would convert every late document into no document, so the door stays
 * open for two months after we stop asking nicely.
 */
export const REQUEST_LINK_GRACE_DAYS = 60;

/**
 * Hard cap. An unauthenticated read of a compliance record is a disclosure
 * with a clock on it; 400 days is the longest clock that is still a clock.
 * There is no "never expires" option, for the reason ./alert-links.ts gives.
 */
export const REQUEST_LINK_MAX_TTL_DAYS = 400;

/** 32 random bytes -> base64url, ~43 chars. Same entropy as /a/, /u/, /alert/. */
export function generateRequestToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When a link minted now, for an ask due on `dueDate`, should stop working.
 *
 *   max(now + 90d, due + 60d), capped at now + 400d
 *
 * Pure and exported so the decision is testable without a database, and so the
 * numbers above are the only place the policy lives.
 */
export function computeRequestLinkExpiry(dueDate: string | null, now: Date = new Date()): string {
  const floor = now.getTime() + REQUEST_LINK_MIN_TTL_DAYS * DAY_MS;
  const cap = now.getTime() + REQUEST_LINK_MAX_TTL_DAYS * DAY_MS;

  let chosen = floor;
  if (dueDate) {
    const due = new Date(dueDate.length === 10 ? `${dueDate}T00:00:00Z` : dueDate).getTime();
    if (Number.isFinite(due)) {
      chosen = Math.max(floor, due + REQUEST_LINK_GRACE_DAYS * DAY_MS);
    }
  }
  return new Date(Math.min(chosen, cap)).toISOString();
}

export interface RequestLinkRow {
  id: string;
  token: string;
  tenant_id: string;
  root_request_id: string;
  supplier_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  created_by: string | null;
  view_count: number;
  last_viewed_at: string | null;
  last_upload_at: string | null;
}

export interface MintRequestLinkInput {
  tenantId: string;
  /** The ask, across every amendment of it. NEVER a single version's id. */
  rootRequestId: string;
  supplierId: string;
  dueDate?: string | null;
  createdBy?: string | null;
}

/**
 * Mint a link for one ask and return its token.
 *
 * BEST-EFFORT, like the alert-link path: a failure here must not abort the
 * issue it is attached to. A packet issued without a link can still be chased
 * by email; an issue that rolls back because a convenience URL could not be
 * written is a worse outcome.
 */
export async function mintRequestLink(
  db: D1Database,
  input: MintRequestLinkInput,
): Promise<string | null> {
  try {
    const token = generateRequestToken();
    await db
      .prepare(
        `INSERT INTO request_links
           (id, tenant_id, token, root_request_id, supplier_id, expires_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        generateId(),
        input.tenantId,
        token,
        input.rootRequestId,
        input.supplierId,
        computeRequestLinkExpiry(input.dueDate ?? null),
        input.createdBy ?? null,
      )
      .run();
    return token;
  } catch (err) {
    console.error(
      '[request-links] minting a link failed:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** The URL an outbound message should point at. Null when either half is missing. */
export function requestLinkUrl(appUrl: string | undefined, token: string | null): string | null {
  if (!appUrl || !token) return null;
  return `${appUrl.replace(/\/$/, '')}/r/${token}`;
}

/**
 * Look a token up and decide whether it is still usable.
 *
 * Returns null for EVERY unusable case — unknown, malformed, expired, revoked —
 * so the endpoint answers 404 uniformly and a token cannot be probed for
 * existence. Same contract as `loadUsableAlertLink`.
 */
export async function loadUsableRequestLink(
  db: D1Database,
  token: string,
): Promise<RequestLinkRow | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const row = await db
    .prepare('SELECT * FROM request_links WHERE token = ?')
    .bind(token)
    .first<RequestLinkRow>();
  if (!row) return null;
  if (row.revoked_at) return null;
  if (!row.expires_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return row;
}

/**
 * The version of the ask this link currently points at.
 *
 * The link pins a ROOT, so this resolves to whichever version is live now — an
 * amendment issued this morning is what the supplier sees this afternoon,
 * through the URL they were sent last month.
 *
 * Filtered to the states `buildSupplierRequestView` will project: `issued` and
 * `closed`, both not-superseded. `closed` is in the list deliberately — a
 * finished ask stays readable so the supplier keeps the record of what they
 * sent, which is the client's stated top source of phone calls. A draft, a
 * cancelled ask or a replaced version resolves to nothing at all rather than
 * to a partial page.
 *
 * `supplier_id` is re-checked against the link even though the root implies it.
 * That is the second fence from migration 0092: no sequence of amendments can
 * make a token opened by supplier A resolve to supplier B's packet.
 */
export async function loadCurrentRequestForLink(
  db: D1Database,
  link: RequestLinkRow,
): Promise<DocumentRequestRow | null> {
  const row = await db
    .prepare(
      `SELECT * FROM document_requests
        WHERE root_request_id = ?
          AND tenant_id = ?
          AND supplier_id = ?
          AND status IN ('issued', 'closed')
          AND superseded_at IS NULL
        ORDER BY version DESC
        LIMIT 1`,
    )
    .bind(link.root_request_id, link.tenant_id, link.supplier_id)
    .first<DocumentRequestRow>();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Item handles — addressing a line without shipping its id
// ---------------------------------------------------------------------------

/**
 * A per-item handle the supplier's browser can send back.
 *
 * Per-line upload needs to name a line, and the allow-list doctrine says no
 * internal id may appear in the payload — "nothing in the payload can be used
 * to hand-craft a call against another endpoint". Both hold at once if the
 * handle is DERIVED: SHA-256 over the token and the line id, truncated to 96
 * bits.
 *
 * The properties that matter:
 *   - stable, so a page reload and a retry address the same item
 *   - opaque, so it discloses no id, no ordering and no row count
 *   - bound to the token, so a handle harvested from one link is meaningless
 *     against another — even for the same line
 *   - one-way, so holding it does not recover the line id
 *
 * Resolution is by recomputation over the request's own lines (see
 * `resolveItemRefs`), never by a lookup keyed on the ref, so a forged handle
 * matches nothing rather than matching something unexpected.
 */
export async function itemRef(token: string, lineId: string): Promise<string> {
  const data = new TextEncoder().encode(`${token}\n${lineId}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest).slice(0, 12);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** line_id -> ref, for every line of the current version. */
export async function computeItemRefs(
  token: string,
  lines: RequestLineRow[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const l of lines) out.set(l.id, await itemRef(token, l.id));
  return out;
}

/**
 * Turn refs supplied by a browser back into line ids.
 *
 * Unknown refs are DROPPED, not rejected: after an amendment a supplier's open
 * tab may still hold a handle for a line that no longer exists, and the right
 * answer is to accept the file against the items that do exist rather than to
 * fail the upload and lose it. The caller checks that at least one survived.
 */
export async function resolveItemRefs(
  token: string,
  lines: RequestLineRow[],
  refs: string[],
): Promise<string[]> {
  if (refs.length === 0) return [];
  const wanted = new Set(refs);
  const byRef = await computeItemRefs(token, lines);
  const out: string[] = [];
  for (const [lineId, ref] of byRef) {
    if (wanted.has(ref)) out.push(lineId);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The three reads behind the page
// ---------------------------------------------------------------------------

export interface RequestUploadRow {
  id: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  uploaded_at: string;
  uploader_label: string | null;
}

/**
 * Everything this supplier has sent through this link, newest first, with the
 * items each file was claimed against.
 *
 * The client: "the supplier can always see their own history — what they sent,
 * when, and what state it is in. This is the question that generates the most
 * phone calls." Scoped to the LINK, so it spans every amendment of the one ask
 * and cannot reach another ask, another supplier or another tenant.
 *
 * Two queries rather than one GROUP_CONCAT: an item name is free text and may
 * contain any separator we might have picked, and a history line that silently
 * splits "Allergen Statement, signed" into two items would be the page lying
 * about what the supplier sent.
 *
 * Coverage is resolved to NAMES here, not to line ids. After an amendment the
 * ids on an old upload point at a superseded version's rows, so an id-based
 * lookup against the current version would quietly show "covered nothing" for
 * every file sent before the amendment. The name was true when they sent it and
 * is what they read on the page, so it is what we keep.
 */
export async function loadUploadHistory(
  db: D1Database,
  linkId: string,
  tenantId: string,
): Promise<SupplierUploadSource[]> {
  const rows = await db
    .prepare(
      `SELECT id, file_name, file_size, mime_type, uploaded_at, uploader_label
         FROM request_uploads
        WHERE link_id = ? AND tenant_id = ?
        ORDER BY uploaded_at DESC, rowid DESC`,
    )
    .bind(linkId, tenantId)
    .all<RequestUploadRow>();
  const uploads = rows.results ?? [];
  if (uploads.length === 0) return [];

  const covers = await db
    .prepare(
      `SELECT ul.upload_id, l.name
         FROM request_upload_lines ul
         JOIN request_lines l ON l.id = ul.line_id
         JOIN request_uploads u ON u.id = ul.upload_id
        WHERE u.link_id = ? AND u.tenant_id = ?
        ORDER BY l.sort_order, l.rowid`,
    )
    .bind(linkId, tenantId)
    .all<{ upload_id: string; name: string }>();

  const byUpload = new Map<string, string[]>();
  for (const c of covers.results ?? []) {
    const list = byUpload.get(String(c.upload_id)) ?? [];
    list.push(String(c.name));
    byUpload.set(String(c.upload_id), list);
  }

  return uploads.map((u) => ({
    file_name: u.file_name,
    file_size: u.file_size,
    uploaded_at: u.uploaded_at,
    uploader_label: u.uploader_label,
    covered_names: byUpload.get(u.id) ?? [],
  }));
}

/**
 * How many files the supplier has sent against each CURRENT item.
 *
 * Joined across the whole root rather than the current version, using the same
 * line identity `lineKey` uses for carrying statuses through an amendment: a
 * typed line is its requirement, a free-text line is its trimmed name. Without
 * that, amending a due date would tell a supplier they had sent nothing for an
 * item they answered last week, which is the single most reliable way to make
 * someone upload it again.
 */
export async function loadReceivedCounts(
  db: D1Database,
  linkId: string,
  tenantId: string,
  rootRequestId: string,
  currentRequestId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .prepare(
      `SELECT cur.id AS line_id, COUNT(DISTINCT u.id) AS n
         FROM request_lines cur
         JOIN request_lines prev
           ON prev.tenant_id = cur.tenant_id
          AND (
                (cur.requirement_id IS NOT NULL AND prev.requirement_id = cur.requirement_id)
             OR (cur.requirement_id IS NULL AND prev.requirement_id IS NULL
                 AND lower(trim(prev.name)) = lower(trim(cur.name)))
              )
         JOIN document_requests r ON r.id = prev.request_id AND r.root_request_id = ?
         JOIN request_upload_lines ul ON ul.line_id = prev.id
         JOIN request_uploads u ON u.id = ul.upload_id AND u.link_id = ?
        WHERE cur.request_id = ? AND cur.tenant_id = ?
        GROUP BY cur.id`,
    )
    .bind(rootRequestId, linkId, currentRequestId, tenantId)
    .all<{ line_id: string; n: number }>();

  const out = new Map<string, number>();
  for (const r of rows.results ?? []) out.set(String(r.line_id), Number(r.n));
  return out;
}

/**
 * Which requirements this supplier's documents have historically satisfied
 * TOGETHER.
 *
 * THIS IS WHAT MAKES THE UPLOAD MOMENT HAPPEN BEFORE THE UPLOAD.
 *
 * The client's thesis is one sentence to the supplier: "this closed 7 of your
 * 14 items". The naive way to earn that sentence is to make the supplier tick
 * seven boxes, which is work we have moved onto them and then congratulated
 * ourselves for. The honest way is to already know, so the boxes tick
 * themselves the instant they name the first one.
 *
 * The evidence is the registry's own: `document_requirements` is many-to-many
 * and already records, per document, every requirement a human CONFIRMED it
 * satisfies. So a pair of requirements that a previous document of this
 * supplier's closed at the same time is a pair this supplier's next document of
 * that kind will probably close at the same time.
 *
 * Only `confirmed` counts, exactly as in `loadClosures` and the gap engine: a
 * `suggested` link is an unreviewed machine proposal and a `rejected` one is a
 * human saying no. Suggesting on the strength of either would let the pipeline
 * pre-tick boxes for the supplier on evidence a person already declined.
 *
 * Scoped to this tenant AND this supplier. Co-occurrence learned from a
 * different supplier's paperwork is not evidence about this one, and reading
 * across suppliers to build the hint would be the leak this whole surface is
 * arranged to prevent — even though only a boolean would come out.
 */
export async function loadCoSatisfaction(
  db: D1Database,
  tenantId: string,
  supplierId: string,
  requirementIds: string[],
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (requirementIds.length < 2) return out;

  const ph = requirementIds.map(() => '?').join(', ');
  const rows = await db
    .prepare(
      `SELECT a.requirement_id AS left_id, b.requirement_id AS right_id
         FROM document_requirements a
         JOIN document_requirements b
           ON b.document_id = a.document_id
          AND b.requirement_id != a.requirement_id
         JOIN documents d ON d.id = a.document_id
        WHERE d.tenant_id = ?
          AND d.supplier_id = ?
          AND d.status = 'active'
          AND a.status = 'confirmed'
          AND b.status = 'confirmed'
          AND a.requirement_id IN (${ph})
          AND b.requirement_id IN (${ph})`,
    )
    .bind(tenantId, supplierId, ...requirementIds, ...requirementIds)
    .all<{ left_id: string; right_id: string }>();

  for (const r of rows.results ?? []) {
    const key = String(r.left_id);
    const set = out.get(key) ?? new Set<string>();
    set.add(String(r.right_id));
    out.set(key, set);
  }
  return out;
}

/**
 * Record that a link was opened. Best-effort counter; the authoritative record
 * of the view is the audit_log row the endpoint writes.
 */
export async function recordRequestLinkView(db: D1Database, linkId: string): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE request_links
            SET view_count = view_count + 1, last_viewed_at = datetime('now')
          WHERE id = ?`,
      )
      .bind(linkId)
      .run();
  } catch (err) {
    console.error(
      '[request-links] recording a view failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ---------------------------------------------------------------------------
// The sentence
// ---------------------------------------------------------------------------

/**
 * What the supplier reads the instant a file lands.
 *
 * THE CLIENT CALLS THIS "the entire product thesis rendered as one sentence to
 * the person who has felt the incumbent's version of it." Their phrasing was
 * "this closed 7 of your 14 items."
 *
 * ONE DELIBERATE DEPARTURE FROM THAT WORDING: it says COVERED, not CLOSED.
 * Covering is what the supplier just did; closing is a reviewer accepting it,
 * which has not happened yet and may not. A page whose entire argument is that
 * we count satisfied items rather than uploaded files cannot afford to inflate
 * the count in its best moment — that would be the flattering number wearing
 * the honest number's clothes, in the one place a supplier would remember it.
 * The clause that follows carries the real payload anyway: they do not have to
 * send it again.
 *
 * Composed here, server-side, rather than in the browser, so the sentence is
 * auditable and cannot drift between a phone and a laptop.
 */
export function buildUploadMessage(coveredCount: number, totalItems: number): string {
  if (coveredCount <= 0) return 'Thanks — we have your file.';
  if (coveredCount === 1) {
    return 'Thanks — we have your file, and it is now with the team to review.';
  }
  return (
    `That one file covered ${coveredCount} of your ${totalItems} items — ` +
    'you do not need to send it again for the others.'
  );
}
