/**
 * The request composer (migration 0090).
 *
 * Everything the registry built before this describes STATE — what a document
 * satisfies (0080), what a supplier owes (0087), what is missing
 * (shared/requirementGap.ts). This module is how a person ASKS for the missing
 * thing, in a way the registry can still reason about when it arrives.
 *
 * The client's framing: "The composer is the primitive. Every checklist source
 * is a feeder into it." Gap detection, a saved template, a manual compose, and
 * a future draft generator all fill the SAME draft row and leave through the
 * SAME `issueRequest`. There is no second pipeline in here, and adding one
 * would be the mistake this module is shaped to prevent.
 *
 * WHAT LIVES WHERE
 * ----------------
 * This file owns the transitions — compose, issue, amend, re-issue — because
 * each of them is several writes that must not half-happen, and because the
 * route handlers must not each hold their own opinion about what issuing
 * means. Route files are transport: parse, gate, delegate, serialize.
 *
 * THE ONE THING TO READ BEFORE CHANGING ANYTHING
 * ----------------------------------------------
 * `buildSupplierRequestView` at the bottom is an ALLOW-LIST, not a filter. It
 * builds the external payload field by field from named columns, exactly like
 * `buildAlertLandingView` in ./alert-links.ts, and for the same reason: a
 * supplier seeing the assigned buyer, an internal note, or the routing record
 * is not a bug you recover from by apologising. Never spread a row into it and
 * never "delete the sensitive keys" from a wider object.
 */

import { generateId, logAudit } from './db';
import {
  computeItemRefs,
  loadCoSatisfaction,
  loadReceivedCounts,
  loadUploadHistory,
  mintRequestLink,
} from './request-links';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  requireRole,
} from './permissions';
import { sanitizeString } from './validation';
import type {
  AmendDocumentRequestRequest,
  DocumentRequestDetail,
  DocumentRequestLineCounts,
  DocumentRequestOrigin,
  DocumentRequestRow,
  DocumentRequestStatus,
  DocumentRequestVersionSummary,
  RequestIssueChannel,
  RequestLineClosure,
  RequestLineInput,
  RequestLineKind,
  RequestLineRow,
  RequestLineStatus,
  RequestLineWithClosure,
  RequestRoutingRow,
  RequestTemplateLineRow,
  SupplierRequestItem,
  SupplierRequestProgress,
  SupplierRequestUpload,
  SupplierRequestView,
  SupplierRequirementTier,
} from '../../shared/types';
import type { User } from './types';

// ---------------------------------------------------------------------------
// Vocabulary + validators
// ---------------------------------------------------------------------------

export const REQUEST_STATUSES = ['draft', 'issued', 'cancelled', 'closed'] as const;
export const REQUEST_ORIGINS = ['manual', 'template', 'gap', 'generated'] as const;
export const LINE_KINDS = ['requirement', 'free_text'] as const;
export const LINE_STATUSES = [
  'not_started',
  'received',
  'under_review',
  'accepted',
  'needs_attention',
] as const;
export const ISSUE_CHANNELS = ['portal', 'email', 'manual'] as const;
export const LINE_TIERS = ['required', 'recommended'] as const;

export function isRequestStatus(v: string): v is DocumentRequestStatus {
  return (REQUEST_STATUSES as readonly string[]).includes(v);
}
export function isRequestOrigin(v: string): v is DocumentRequestOrigin {
  return (REQUEST_ORIGINS as readonly string[]).includes(v);
}
export function isLineKind(v: string): v is RequestLineKind {
  return (LINE_KINDS as readonly string[]).includes(v);
}
export function isLineStatus(v: string): v is RequestLineStatus {
  return (LINE_STATUSES as readonly string[]).includes(v);
}
export function isIssueChannel(v: string): v is RequestIssueChannel {
  return (ISSUE_CHANNELS as readonly string[]).includes(v);
}
export function isLineTier(v: string): v is SupplierRequirementTier {
  return (LINE_TIERS as readonly string[]).includes(v);
}

function clean(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = sanitizeString(String(v));
  return s.length === 0 ? null : s;
}

function nowIso(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ---------------------------------------------------------------------------
// Composing lines
// ---------------------------------------------------------------------------

/** A line input after validation, with every default resolved. */
export interface ResolvedLine {
  line_kind: RequestLineKind;
  requirement_id: string | null;
  name: string;
  explanation: string | null;
  acceptable_formats: string | null;
  criteria: string | null;
  owner: string | null;
  tier: SupplierRequirementTier;
  sort_order: number;
}

/**
 * Validate and normalize a composed line set.
 *
 * THE TYPED LINE IS THE DEFAULT AND THE FREE-TEXT ONE IS EXCEPTIONAL. That is
 * a client requirement, and it is enforced here rather than left to the UI:
 *
 *   * `line_kind` defaults to 'requirement'. A caller who omits it AND omits
 *     `requirement_id` gets a 400 naming the escape hatch, not a silently
 *     untyped line. Free text has to be asked for by name.
 *   * 'free_text' with a requirement_id is also a 400 — a line cannot be half
 *     of each, and the DB CHECK says the same thing one layer down.
 *
 * The client's reason, verbatim: "A line that is only free text produces a
 * document the registry cannot reason about, which quietly turns the portal
 * back into a filing cabinet."
 *
 * Typed lines inherit the requirement's name when none is given, but the name
 * stays editable — "Allergen Matrix" is the registry's word for it and the
 * supplier may need "the allergen statement your QA team signs".
 */
export async function resolveLines(
  db: D1Database,
  tenantId: string,
  raw: unknown,
  field = 'lines',
): Promise<ResolvedLine[]> {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new BadRequestError(`${field} must be an array`);

  const inputs = raw as RequestLineInput[];
  const resolved: ResolvedLine[] = [];
  const seenRequirements = new Set<string>();

  // Resolve every named requirement in ONE query, and against this tenant. The
  // FK on request_lines references requirements(id) and cannot carry a tenant
  // into the constraint, so this is the only thing standing between a line and
  // another tenant's vocabulary — same reasoning as `assertInTenant` in
  // /api/supplier-requirements.
  const wantedIds = [
    ...new Set(
      inputs
        .map((l) => (typeof l?.requirement_id === 'string' ? l.requirement_id.trim() : ''))
        .filter((s) => s.length > 0),
    ),
  ];
  const known = new Map<string, { name: string; active: number }>();
  if (wantedIds.length > 0) {
    const placeholders = wantedIds.map(() => '?').join(', ');
    const rows = await db
      .prepare(
        `SELECT id, name, active FROM requirements
          WHERE tenant_id = ? AND id IN (${placeholders})`,
      )
      .bind(tenantId, ...wantedIds)
      .all<{ id: string; name: string; active: number }>();
    for (const r of rows.results ?? []) {
      known.set(String(r.id), { name: String(r.name), active: Number(r.active) });
    }
  }

  inputs.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      throw new BadRequestError(`${field}[${i}] must be an object`);
    }

    const requirementId = clean(entry.requirement_id);
    const kindRaw = entry.line_kind ?? 'requirement';
    if (typeof kindRaw !== 'string' || !isLineKind(kindRaw)) {
      throw new BadRequestError(
        `${field}[${i}].line_kind must be one of: ${LINE_KINDS.join(', ')}`,
      );
    }
    const kind: RequestLineKind = kindRaw;

    if (kind === 'requirement' && !requirementId) {
      throw new BadRequestError(
        `${field}[${i}]: a request line must resolve to a requirement_id. ` +
          `If the taxonomy genuinely does not cover this ask, send ` +
          `line_kind: "free_text" explicitly — a free-text line produces a ` +
          `document the registry cannot reason about.`,
      );
    }
    if (kind === 'free_text' && requirementId) {
      throw new BadRequestError(
        `${field}[${i}]: a free_text line must not carry a requirement_id. ` +
          `Drop line_kind to make it a typed line instead.`,
      );
    }

    let name = clean(entry.name);

    if (kind === 'requirement' && requirementId) {
      const hit = known.get(requirementId);
      if (!hit) {
        throw new BadRequestError(
          `${field}[${i}]: unknown requirement for this tenant`,
        );
      }
      // A retired line item must not be asked for. `requirements` soft-deletes
      // so its ids keep resolving for history; that is not permission to
      // compose a new ask around one.
      if (hit.active !== 1) {
        throw new BadRequestError(
          `${field}[${i}]: requirement "${hit.name}" is inactive and cannot be requested`,
        );
      }
      if (seenRequirements.has(requirementId)) {
        throw new BadRequestError(
          `${field}[${i}]: requirement "${hit.name}" appears more than once in this request`,
        );
      }
      seenRequirements.add(requirementId);
      if (!name) name = hit.name;
    }

    if (!name) throw new BadRequestError(`${field}[${i}].name is required`);

    const tierRaw = entry.tier ?? 'required';
    if (typeof tierRaw !== 'string' || !isLineTier(tierRaw)) {
      throw new BadRequestError(
        `${field}[${i}].tier must be one of: ${LINE_TIERS.join(', ')}`,
      );
    }

    resolved.push({
      line_kind: kind,
      requirement_id: kind === 'requirement' ? requirementId : null,
      name,
      explanation: clean(entry.explanation),
      acceptable_formats: clean(entry.acceptable_formats),
      criteria: clean(entry.criteria),
      owner: clean(entry.owner),
      tier: tierRaw,
      sort_order:
        typeof entry.sort_order === 'number' && Number.isFinite(entry.sort_order)
          ? entry.sort_order
          : i,
    });
  });

  return resolved;
}

/** Statements that insert one composed line set. Batched by the caller. */
function lineInsertStatements(
  db: D1Database,
  tenantId: string,
  requestId: string,
  lines: ResolvedLine[],
  userId: string,
  /** Carried-forward statuses, keyed by the line key. See `carryStatuses`. */
  statuses?: Map<string, CarriedLineState>,
): D1PreparedStatement[] {
  return lines.map((l) => {
    const carried = statuses?.get(lineKey(l));
    return db
      .prepare(
        `INSERT INTO request_lines
           (id, tenant_id, request_id, line_kind, requirement_id, name, explanation,
            acceptable_formats, criteria, owner, tier, status, status_note,
            attention_reason, accepted_document_id, sort_order, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        generateId(),
        tenantId,
        requestId,
        l.line_kind,
        l.requirement_id,
        l.name,
        l.explanation,
        l.acceptable_formats,
        l.criteria,
        l.owner,
        l.tier,
        carried?.status ?? 'not_started',
        carried?.note ?? null,
        carried?.attention_reason ?? null,
        // Only ever set alongside 'accepted'; see CarriedLineState.
        carried?.status === 'accepted' ? (carried.accepted_document_id ?? null) : null,
        l.sort_order,
        userId,
        userId,
      );
  });
}

/**
 * The identity of a line ACROSS an amendment.
 *
 * A typed line is identified by its requirement — that is the whole value of
 * being typed. A free-text line has nothing better than its name, which is
 * another small, concrete cost of the escape hatch.
 */
export function lineKey(l: { line_kind: RequestLineKind; requirement_id: string | null; name: string }): string {
  return l.line_kind === 'requirement' && l.requirement_id
    ? `req:${l.requirement_id}`
    : `txt:${l.name.trim().toLowerCase()}`;
}

/** What survives an amendment, per line. */
interface CarriedLineState {
  status: RequestLineStatus;
  /** Internal note. Carried because it is the reviewer's own working memory. */
  note: string | null;
  /**
   * The supplier-facing reason. Carried for the same reason the status is: an
   * item that was open BECAUSE something was wrong with it is still open for
   * that reason after we fix a typo in the due date, and dropping the sentence
   * would leave the supplier looking at a needs_attention item with nothing
   * telling them what to do — the exact state this page must never reach.
   */
  attention_reason: string | null;
  /**
   * The document the line stands accepted on (migration 0104). Carried with
   * the status it belongs to: an amendment that fixes a due date must not turn
   * "accepted, from this certificate" into "accepted, from nothing we can
   * name" — that is the unexplained acceptance 0104 exists to end.
   */
  accepted_document_id: string | null;
}

/**
 * Statuses from the version being amended, so progress survives the amendment.
 *
 * Without this, correcting a due date would reset a line whose document is
 * already `under_review` back to `not_started` and tell the buyer to chase
 * something they already have. Lines that are new in the amendment simply have
 * no entry and start at `not_started`.
 */
function carryStatuses(previous: RequestLineRow[]): Map<string, CarriedLineState> {
  const m = new Map<string, CarriedLineState>();
  for (const p of previous) {
    m.set(lineKey(p), {
      status: p.status,
      note: p.status_note,
      attention_reason: p.attention_reason ?? null,
      accepted_document_id: p.accepted_document_id ?? null,
    });
  }
  return m;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Load one request, scoped to a tenant.
 *
 * Tenant scoping is in the WHERE clause, not in a caller-side check, so a bad
 * id and another tenant's id are indistinguishable from outside — the same
 * arrangement `assertNoteParent` uses, and for the same reason: an id-existence
 * probe across tenants is a leak even when the row never comes back.
 */
export async function loadRequest(
  db: D1Database,
  tenantId: string,
  requestId: string,
): Promise<DocumentRequestRow> {
  const row = await db
    .prepare('SELECT * FROM document_requests WHERE id = ? AND tenant_id = ?')
    .bind(requestId, tenantId)
    .first<DocumentRequestRow>();
  if (!row) throw new NotFoundError('Request not found');
  return row;
}

export async function loadLines(
  db: D1Database,
  tenantId: string,
  requestId: string,
): Promise<RequestLineRow[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM request_lines
        WHERE request_id = ? AND tenant_id = ?
        ORDER BY sort_order, created_at, rowid`,
    )
    .bind(requestId, tenantId)
    .all<RequestLineRow>();
  return rows.results ?? [];
}

/**
 * What `document_requirements` ALREADY says about these requirements, for this
 * supplier's active documents.
 *
 * THIS IS THE SATISFACTION SEAM, AND IT IS DELIBERATELY READ-ONLY.
 *
 * The registry already records what a document satisfies; a request line that
 * resolves to a requirement therefore needs no second mechanism to know
 * whether something has arrived — the join is the mechanism. Only
 * `status = 'confirmed'` counts, exactly as in the gap engine: a `suggested`
 * link is an unreviewed machine proposal and a `rejected` one is a human
 * saying no, and either counting would let the pipeline close its own asks.
 *
 * WHAT THIS FUNCTION DOES NOT DO, ON PURPOSE: move `request_lines.status`.
 * `accepted` is the fourth of the client's five states and `received` and
 * `under_review` sit in front of it. A confirmed link means a document exists
 * that satisfies the requirement; it does not mean a person has accepted it
 * against THIS ask. Auto-advancing to `accepted` would erase the review the
 * five states exist to describe, and auto-advancing to `received` would need
 * an arrival event this read has no access to. That move now lives on the
 * arrival itself — POST /api/request-uploads/:id/decide
 * (functions/lib/request-arrivals.ts) — which is where a person accepts a line
 * from a named document and, for a typed line, confirms the link this reads.
 */
export async function loadClosures(
  db: D1Database,
  tenantId: string,
  supplierId: string,
  requirementIds: string[],
): Promise<Map<string, RequestLineClosure[]>> {
  const out = new Map<string, RequestLineClosure[]>();
  if (requirementIds.length === 0) return out;

  const placeholders = requirementIds.map(() => '?').join(', ');
  const rows = await db
    .prepare(
      `SELECT dr.requirement_id, dr.confirmed_at,
              d.id AS document_id, d.title AS document_title
         FROM document_requirements dr
         JOIN documents d ON d.id = dr.document_id
        WHERE d.tenant_id = ?
          AND d.supplier_id = ?
          AND d.status = 'active'
          AND dr.status = 'confirmed'
          AND dr.requirement_id IN (${placeholders})
        ORDER BY dr.confirmed_at DESC`,
    )
    .bind(tenantId, supplierId, ...requirementIds)
    .all<{
      requirement_id: string;
      confirmed_at: string | null;
      document_id: string;
      document_title: string;
    }>();

  for (const r of rows.results ?? []) {
    const key = String(r.requirement_id);
    const list = out.get(key) ?? [];
    list.push({
      document_id: String(r.document_id),
      document_title: String(r.document_title),
      confirmed_at: r.confirmed_at ?? null,
    });
    out.set(key, list);
  }
  return out;
}

export function countLines(lines: RequestLineRow[]): DocumentRequestLineCounts {
  const by_status = {
    not_started: 0,
    received: 0,
    under_review: 0,
    accepted: 0,
    needs_attention: 0,
  } as Record<RequestLineStatus, number>;
  let typed = 0;
  let free_text = 0;
  let required = 0;
  let recommended = 0;
  for (const l of lines) {
    if (l.line_kind === 'requirement') typed += 1;
    else free_text += 1;
    if (l.tier === 'required') required += 1;
    else recommended += 1;
    if (isLineStatus(l.status)) by_status[l.status] += 1;
  }
  return { total: lines.length, typed, free_text, required, recommended, by_status };
}

/** Every version of one ask, oldest first — the amendment trail. */
export async function loadHistory(
  db: D1Database,
  tenantId: string,
  rootRequestId: string,
): Promise<DocumentRequestVersionSummary[]> {
  const rows = await db
    .prepare(
      `SELECT r.id, r.version, r.status, r.title, r.due_date, r.issued_at,
              r.superseded_at, r.amendment_reason,
              (SELECT COUNT(*) FROM request_lines rl WHERE rl.request_id = r.id) AS line_count
         FROM document_requests r
        WHERE r.root_request_id = ? AND r.tenant_id = ?
        ORDER BY r.version ASC`,
    )
    .bind(rootRequestId, tenantId)
    .all<Record<string, unknown>>();

  return (rows.results ?? []).map((r) => ({
    id: String(r.id),
    version: Number(r.version),
    status: String(r.status) as DocumentRequestStatus,
    title: String(r.title),
    due_date: (r.due_date as string) ?? null,
    issued_at: (r.issued_at as string) ?? null,
    superseded_at: (r.superseded_at as string) ?? null,
    amendment_reason: (r.amendment_reason as string) ?? null,
    line_count: Number(r.line_count ?? 0),
    is_current: r.superseded_at == null,
  }));
}

/** The full internal view. Never hand this to anyone outside the tenant. */
export async function loadRequestDetail(
  db: D1Database,
  tenantId: string,
  requestId: string,
): Promise<DocumentRequestDetail> {
  const request = await loadRequest(db, tenantId, requestId);
  const lines = await loadLines(db, tenantId, requestId);

  const requirementIds = [
    ...new Set(lines.map((l) => l.requirement_id).filter((v): v is string => !!v)),
  ];
  const closures = await loadClosures(db, tenantId, request.supplier_id, requirementIds);

  const vocab = new Map<string, { name: string; slug: string; checklist: string | null }>();
  if (requirementIds.length > 0) {
    const placeholders = requirementIds.map(() => '?').join(', ');
    const rows = await db
      .prepare(
        `SELECT id, name, slug, checklist FROM requirements
          WHERE tenant_id = ? AND id IN (${placeholders})`,
      )
      .bind(tenantId, ...requirementIds)
      .all<{ id: string; name: string; slug: string; checklist: string | null }>();
    for (const r of rows.results ?? []) {
      vocab.set(String(r.id), {
        name: String(r.name),
        slug: String(r.slug),
        checklist: r.checklist ?? null,
      });
    }
  }

  const supplier = await db
    .prepare('SELECT name FROM suppliers WHERE id = ? AND tenant_id = ?')
    .bind(request.supplier_id, tenantId)
    .first<{ name: string }>();

  let assignedName: string | null = null;
  if (request.assigned_to) {
    const u = await db
      .prepare('SELECT name FROM users WHERE id = ?')
      .bind(request.assigned_to)
      .first<{ name: string }>();
    assignedName = u?.name ?? null;
  }

  const routing = await db
    .prepare('SELECT * FROM request_routing WHERE request_id = ? AND tenant_id = ?')
    .bind(requestId, tenantId)
    .first<RequestRoutingRow>();

  const withClosure: RequestLineWithClosure[] = lines.map((l) => {
    const v = l.requirement_id ? vocab.get(l.requirement_id) : undefined;
    return {
      ...l,
      requirement_name: v?.name ?? null,
      requirement_slug: v?.slug ?? null,
      requirement_checklist: v?.checklist ?? null,
      // Free-text lines get an empty array, always. Nothing in the registry can
      // point at them, which is the client's argument made visible in the API.
      closure: l.requirement_id ? (closures.get(l.requirement_id) ?? []) : [],
    };
  });

  return {
    ...request,
    supplier_name: supplier?.name ?? null,
    assigned_to_name: assignedName,
    lines: withClosure,
    counts: countLines(lines),
    routing: routing ?? null,
    history: await loadHistory(db, tenantId, request.root_request_id),
  };
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export interface ComposeInput {
  supplierId: string;
  title: string;
  intro?: string | null;
  dueDate?: string | null;
  assignedTo?: string | null;
  origin?: DocumentRequestOrigin;
  originRef?: string | null;
  lines: ResolvedLine[];
}

/** Assert a supplier belongs to this tenant. The FK cannot say so. */
export async function assertSupplier(
  db: D1Database,
  tenantId: string,
  supplierId: string,
): Promise<void> {
  const row = await db
    .prepare('SELECT id FROM suppliers WHERE id = ? AND tenant_id = ?')
    .bind(supplierId, tenantId)
    .first();
  if (!row) throw new BadRequestError('Invalid supplier for this tenant');
}

/** Assert an assigned buyer is a real, active user of this tenant. */
export async function assertAssignee(
  db: D1Database,
  tenantId: string,
  userId: string | null,
): Promise<void> {
  if (!userId) return;
  const row = await db
    .prepare(
      `SELECT id FROM users
        WHERE id = ? AND active = 1 AND (tenant_id = ? OR role = 'super_admin')`,
    )
    .bind(userId, tenantId)
    .first();
  if (!row) throw new BadRequestError('Invalid assigned_to for this tenant');
}

/**
 * Compose a DRAFT. Nothing here is committed and nothing is routed.
 *
 * The single entry point for every feeder — manual, template, gap, generator.
 * `origin` records which one, and is provenance only.
 */
export async function composeRequest(
  db: D1Database,
  tenantId: string,
  user: User,
  input: ComposeInput,
): Promise<string> {
  await assertSupplier(db, tenantId, input.supplierId);
  await assertAssignee(db, tenantId, input.assignedTo ?? null);

  const id = generateId();
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO document_requests
           (id, tenant_id, supplier_id, root_request_id, version, origin, origin_ref,
            title, intro, due_date, assigned_to, status, created_by, updated_by)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      )
      .bind(
        id,
        tenantId,
        input.supplierId,
        // A first version is its own root. The chain always has an anchor, so
        // no query ever has to special-case "the one without a parent".
        id,
        input.origin ?? 'manual',
        input.originRef ?? null,
        input.title,
        input.intro ?? null,
        input.dueDate ?? null,
        input.assignedTo ?? null,
        user.id,
        user.id,
      ),
    ...lineInsertStatements(db, tenantId, id, input.lines, user.id),
  ];

  await db.batch(statements);
  return id;
}

export interface IssueInput {
  channel?: RequestIssueChannel;
  recipient?: string | null;
  internalNotes?: string | null;
  /** Set when this issue is committing an amendment. */
  amendmentOfRoutingId?: string | null;
}

/**
 * THE ONE ISSUE PATH.
 *
 * Every feeder converges here and nothing else may write `issued_at` or insert
 * into `request_routing`. One issue event produces exactly one routing row
 * (enforced by the UNIQUE on request_routing.request_id) and exactly one audit
 * row, regardless of what filled the form.
 *
 * `user` is a real human actor and that is load-bearing, not incidental: it is
 * what stops a future draft generator from issuing on its own. A generator
 * composes a draft with origin = 'generated' and stops; a person reviews,
 * amends if needed, and issues.
 */
export async function issueRequest(
  db: D1Database,
  tenantId: string,
  requestId: string,
  user: User,
  input: IssueInput = {},
): Promise<void> {
  const request = await loadRequest(db, tenantId, requestId);

  if (request.status !== 'draft') {
    throw new BadRequestError(
      `Only a draft can be issued; this request is ${request.status}. ` +
        `To change an issued request, amend it — amendments are versioned, not overwritten.`,
    );
  }

  const lineCount = await db
    .prepare('SELECT COUNT(*) AS n FROM request_lines WHERE request_id = ? AND tenant_id = ?')
    .bind(requestId, tenantId)
    .first<{ n: number }>();
  if (!lineCount || Number(lineCount.n) === 0) {
    throw new BadRequestError('A request must have at least one line before it is issued');
  }

  const channel = input.channel ?? 'portal';
  if (!isIssueChannel(channel)) {
    throw new BadRequestError(`channel must be one of: ${ISSUE_CHANNELS.join(', ')}`);
  }

  const issuedAt = nowIso();
  await db.batch([
    db
      .prepare(
        `UPDATE document_requests
            SET status = 'issued', issued_at = ?, updated_at = ?, updated_by = ?
          WHERE id = ? AND tenant_id = ? AND status = 'draft'`,
      )
      .bind(issuedAt, issuedAt, user.id, requestId, tenantId),
    db
      .prepare(
        `INSERT INTO request_routing
           (id, tenant_id, request_id, issued_by, issued_at, version,
            amendment_of_routing_id, channel, recipient, internal_notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        generateId(),
        tenantId,
        requestId,
        user.id,
        issuedAt,
        request.version,
        input.amendmentOfRoutingId ?? null,
        channel,
        clean(input.recipient),
        clean(input.internalNotes),
      ),
  ]);

  // The supplier's door, minted once per ASK rather than once per issue.
  //
  // The link pins `root_request_id` (migration 0092), so the URL an amendment
  // is chased with is the URL the original went out on — which is the whole
  // reason it pins a root. Minting a second one here would hand the supplier
  // two live links to the same ask and make "revoke it" a question with two
  // answers.
  //
  // Best-effort and last, exactly like the alert-link path: a packet that
  // issued without a convenience URL can still be chased by email, whereas an
  // issue that rolled back because a URL could not be written has lost the
  // routing row and the audit trail with it.
  const existingLink = await db
    .prepare(
      `SELECT id FROM request_links
        WHERE root_request_id = ? AND tenant_id = ?
          AND revoked_at IS NULL AND expires_at > datetime('now')
        LIMIT 1`,
    )
    .bind(request.root_request_id, tenantId)
    .first<{ id: string }>();

  if (!existingLink) {
    await mintRequestLink(db, {
      tenantId,
      rootRequestId: request.root_request_id,
      supplierId: request.supplier_id,
      dueDate: request.due_date,
      createdBy: user.id,
    });
  }
}

/**
 * Amend an ISSUED request: a new version, never an overwrite.
 *
 * Both packets survive. The previous row's title, lines, due date, status and
 * issued_at are never touched again — the ONLY column written to it is
 * `superseded_at`, which is chain metadata rather than a restatement of what
 * was asked. Its `status` deliberately stays 'issued', because it was.
 *
 * ORDER MATTERS. The partial unique index
 * `idx_document_requests_root_live (root_request_id) WHERE superseded_at IS NULL`
 * permits exactly one live version per ask, so the old row must be stamped
 * BEFORE the new one lands. Both happen in one `db.batch`, which D1 runs as a
 * single transaction, so a failure half-way cannot leave an ask with two live
 * versions or none.
 *
 * Amending a DRAFT is not this. A draft has been committed to nobody, so
 * editing it in place is an edit; versioning it would produce a chain of rows
 * documenting a conversation that never happened.
 */
export async function amendRequest(
  db: D1Database,
  tenantId: string,
  requestId: string,
  user: User,
  body: AmendDocumentRequestRequest,
): Promise<string> {
  const previous = await loadRequest(db, tenantId, requestId);

  if (previous.superseded_at) {
    throw new BadRequestError(
      'This version has already been amended. Amend the current version instead.',
    );
  }
  if (previous.status !== 'issued') {
    throw new BadRequestError(
      previous.status === 'draft'
        ? 'A draft is edited in place, not amended — versioning begins at issue.'
        : `A ${previous.status} request cannot be amended.`,
    );
  }

  const reason = clean(body.amendment_reason);
  if (!reason) {
    throw new BadRequestError(
      'amendment_reason is required: an amendment with no stated reason is an untraceable rewrite',
    );
  }

  const previousLines = await loadLines(db, tenantId, requestId);

  // A `lines` array REPLACES the set wholesale; its absence keeps the previous
  // composition verbatim (the "the due date moved" amendment).
  const nextLines: ResolvedLine[] =
    body.lines === undefined
      ? previousLines.map((l, i) => ({
          line_kind: l.line_kind,
          requirement_id: l.requirement_id,
          name: l.name,
          explanation: l.explanation,
          acceptable_formats: l.acceptable_formats,
          criteria: l.criteria,
          owner: l.owner,
          tier: l.tier,
          sort_order: typeof l.sort_order === 'number' ? l.sort_order : i,
        }))
      : await resolveLines(db, tenantId, body.lines);

  if (nextLines.length === 0) {
    throw new BadRequestError('An amended request must still have at least one line');
  }

  const assignedTo =
    body.assigned_to === undefined ? previous.assigned_to : clean(body.assigned_to);
  await assertAssignee(db, tenantId, assignedTo);

  const previousRouting = await db
    .prepare('SELECT id FROM request_routing WHERE request_id = ? AND tenant_id = ?')
    .bind(requestId, tenantId)
    .first<{ id: string }>();

  const newId = generateId();
  const at = nowIso();

  await db.batch([
    // 1. Close the old version FIRST — see the note on index ordering above.
    db
      .prepare(
        `UPDATE document_requests SET superseded_at = ?
          WHERE id = ? AND tenant_id = ? AND superseded_at IS NULL`,
      )
      .bind(at, requestId, tenantId),
    // 2. The new version. Same root, version + 1, pointing back at what it
    //    replaces. Issued immediately: an amendment to a packet the supplier
    //    already holds is only meaningful once it has gone out, and leaving it
    //    as a draft would leave the ask with no live issued version at all.
    db
      .prepare(
        `INSERT INTO document_requests
           (id, tenant_id, supplier_id, root_request_id, version, supersedes_id,
            amendment_reason, reissue_of_request_id, origin, origin_ref,
            title, intro, due_date, assigned_to, status, issued_at,
            created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?)`,
      )
      .bind(
        newId,
        tenantId,
        previous.supplier_id,
        previous.root_request_id,
        previous.version + 1,
        previous.id,
        reason,
        previous.reissue_of_request_id,
        previous.origin,
        previous.origin_ref,
        body.title === undefined ? previous.title : sanitizeString(String(body.title)),
        body.intro === undefined ? previous.intro : clean(body.intro),
        body.due_date === undefined ? previous.due_date : clean(body.due_date),
        assignedTo,
        at,
        user.id,
        user.id,
      ),
    // 3. Lines, with progress carried forward by line identity.
    ...lineInsertStatements(
      db,
      tenantId,
      newId,
      nextLines,
      user.id,
      carryStatuses(previousLines),
    ),
    // 4. Its own routing record, linked to the one it amends. One issue event,
    //    one routing row — the same rule as a first issue.
    db
      .prepare(
        `INSERT INTO request_routing
           (id, tenant_id, request_id, issued_by, issued_at, version,
            amendment_of_routing_id, channel, recipient, internal_notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        generateId(),
        tenantId,
        newId,
        user.id,
        at,
        previous.version + 1,
        previousRouting?.id ?? null,
        body.channel ?? 'portal',
        clean(body.recipient),
        clean(body.internal_notes),
      ),
  ]);

  return newId;
}

/**
 * Re-issue: a NEW ask modelled on an old one.
 *
 * NOT an amendment, and the distinction is the easy mistake in this feature.
 * An amendment corrects the same ask and stays on the same root; a re-issue
 * starts a fresh root at version 1 and keeps `reissue_of_request_id` as
 * provenance. This is what a renewal is ("same packet, this year") and what a
 * new item under an approved vendor is. Reusing the original root for either
 * would rewrite last year's record as though it had always been about this
 * year.
 *
 * The result is a DRAFT. A renewal is still an ask a person should look at
 * before it goes out, and routing it straight through would give the composer
 * a second issue path — the one thing this module refuses to have.
 */
export async function reissueRequest(
  db: D1Database,
  tenantId: string,
  sourceRequestId: string,
  user: User,
  body: {
    supplier_id?: string;
    title?: string;
    intro?: string | null;
    due_date?: string | null;
    assigned_to?: string | null;
  } = {},
): Promise<string> {
  const source = await loadRequest(db, tenantId, sourceRequestId);
  const sourceLines = await loadLines(db, tenantId, sourceRequestId);
  if (sourceLines.length === 0) {
    throw new BadRequestError('The source request has no lines to re-issue');
  }

  // Defaults to the same supplier — the common case is a renewal — but may be
  // pointed at another, which is how "the packet we send every approved vendor"
  // gets reused without a template.
  const supplierId = clean(body.supplier_id) ?? source.supplier_id;
  await assertSupplier(db, tenantId, supplierId);

  const assignedTo =
    body.assigned_to === undefined ? source.assigned_to : clean(body.assigned_to);
  await assertAssignee(db, tenantId, assignedTo);

  const newId = generateId();
  // Line statuses deliberately DO NOT carry across a re-issue: a new ask starts
  // at not_started even when last year's version was accepted, because last
  // year's certificate is not this year's.
  const lines: ResolvedLine[] = sourceLines.map((l, i) => ({
    line_kind: l.line_kind,
    requirement_id: l.requirement_id,
    name: l.name,
    explanation: l.explanation,
    acceptable_formats: l.acceptable_formats,
    criteria: l.criteria,
    owner: l.owner,
    tier: l.tier,
    sort_order: typeof l.sort_order === 'number' ? l.sort_order : i,
  }));

  await db.batch([
    db
      .prepare(
        `INSERT INTO document_requests
           (id, tenant_id, supplier_id, root_request_id, version,
            reissue_of_request_id, origin, origin_ref, title, intro, due_date,
            assigned_to, status, created_by, updated_by)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      )
      .bind(
        newId,
        tenantId,
        supplierId,
        newId,
        source.id,
        source.origin,
        source.origin_ref,
        body.title === undefined ? source.title : sanitizeString(String(body.title)),
        body.intro === undefined ? source.intro : clean(body.intro),
        body.due_date === undefined ? null : clean(body.due_date),
        assignedTo,
        user.id,
        user.id,
      ),
    ...lineInsertStatements(db, tenantId, newId, lines, user.id),
  ]);

  return newId;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/** Turn saved template lines into composable ones. A column-for-column copy. */
export function templateLinesToResolved(rows: RequestTemplateLineRow[]): ResolvedLine[] {
  return rows.map((l, i) => ({
    line_kind: l.line_kind,
    requirement_id: l.requirement_id,
    name: l.name,
    explanation: l.explanation,
    acceptable_formats: l.acceptable_formats,
    criteria: l.criteria,
    owner: l.owner,
    tier: l.tier,
    sort_order: typeof l.sort_order === 'number' ? l.sort_order : i,
  }));
}

/** Statements inserting a template's line set. Batched by the caller. */
export function templateLineInsertStatements(
  db: D1Database,
  tenantId: string,
  templateId: string,
  lines: ResolvedLine[],
  userId: string,
): D1PreparedStatement[] {
  return lines.map((l) =>
    db
      .prepare(
        `INSERT INTO request_template_lines
           (id, tenant_id, template_id, line_kind, requirement_id, name, explanation,
            acceptable_formats, criteria, owner, tier, sort_order, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        generateId(),
        tenantId,
        templateId,
        l.line_kind,
        l.requirement_id,
        l.name,
        l.explanation,
        l.acceptable_formats,
        l.criteria,
        l.owner,
        l.tier,
        l.sort_order,
        userId,
      ),
  );
}

// ---------------------------------------------------------------------------
// The external projection — an allow-list, not a filter
// ---------------------------------------------------------------------------

/**
 * Project one issued request into the EXACT payload a supplier may see.
 *
 * Constructed field by field from named columns, the same discipline as
 * `buildAlertLandingView` in ./alert-links.ts. It never spreads a row and never
 * deletes keys from a wider object, because the failure mode is not recoverable
 * by apologising.
 *
 * Things intentionally NOT here:
 *
 *   - the routing record in any form: issued_by, channel, recipient,
 *     internal_notes, amendment_of_routing_id
 *   - `assigned_to` — which of our buyers owns chasing them
 *   - every internal id: request, root, tenant, supplier, line, requirement,
 *     user. Nothing in the payload can be used to hand-craft a call against
 *     another endpoint.
 *   - `origin` / `origin_ref` — a supplier does not get to learn that their
 *     packet was machine-drafted, or which template we reuse
 *   - the version chain and `amendment_reason` — the fact of an amendment is
 *     surfaced as a bare boolean because the recipient needs to know this
 *     replaces something; WHY we changed it is our business
 *   - `status_note` — the INTERNAL note column. Its supplier-facing counterpart
 *     is `attention_reason`, a separate column added in 0092 precisely so the
 *     two audiences cannot be confused by a reviewer typing in the wrong box
 *   - `owner` — who at either end is chasing it is not the supplier's business
 *     to read off a page
 *   - `line_kind` — whether an ask is typed is a registry concern
 *   - the uploader IP we record against every arrival, and the R2 key of
 *     anything we hold
 *   - anything belonging to another supplier, request, or tenant
 *
 * ONE REVERSAL FROM THE ORIGINAL PROJECTION, STATED PLAINLY. Per-line `status`
 * used to be withheld here on the grounds that 'under_review' describes our
 * process. It is now shown. A supplier who cannot tell "we have it" from "we
 * are waiting on you" phones to ask, and that call is the single thing this
 * page exists to stop. What they learn is one word about where their own
 * document sits, which is not the same as learning how we judged it — the
 * judgement, its reasoning, and every threshold behind it stay out.
 *
 * WHAT PROJECTS AND WHAT DOES NOT:
 *
 *   - `issued`    -> yes. The live ask.
 *   - `closed`    -> yes, READ ONLY. The client is explicit that "the supplier
 *                    can always see their own history — what they sent, when,
 *                    and what state it is in", and calls it the question that
 *                    generates the most phone calls. Going dark the moment a
 *                    buyer marks the ask complete would delete that record from
 *                    under the one person who needs it, at exactly the moment
 *                    they want to confirm they are done. `accepting_uploads`
 *                    turns off; nothing else does.
 *   - `draft`     -> null. Never sent; there is no state in which showing a
 *                    supplier an unissued packet is correct.
 *   - `cancelled` -> null. We withdrew the ask, and the realistic reason is
 *                    that it went to the wrong supplier.
 *   - superseded  -> null. An old version is not what they hold; the link
 *                    resolves to the current one instead.
 */
export interface SupplierViewInputs {
  tenantName: string;
  supplierName: string;
  request: DocumentRequestRow;
  lines: RequestLineRow[];
  /** line_id -> the opaque handle this response will publish for it. */
  refs: Map<string, string>;
  /** line_id -> how many files the supplier has claimed against it. */
  receivedCounts: Map<string, number>;
  /** What they sent, newest first, with the line ids each file was claimed against. */
  uploads: SupplierUploadSource[];
  /** requirement_id -> requirement ids this supplier's own documents closed alongside it. */
  coSatisfaction: Map<string, Set<string>>;
  linkExpiresAt: string;
  acceptingUploads: boolean;
}

/**
 * One arrival, as the projection needs it.
 *
 * Coverage arrives already resolved to item NAMES rather than line ids — see
 * `loadUploadHistory` in ./request-links.ts for why. It means this struct
 * carries no id at all, so there is nothing here for the allow-list to have to
 * remember to drop.
 */
export interface SupplierUploadSource {
  file_name: string;
  file_size: number;
  uploaded_at: string;
  uploader_label: string | null;
  covered_names: string[];
}

/**
 * The sentence a supplier reads when an item comes back to them.
 *
 * NEVER the bare word "rejected". A rejection with no reason is a second round
 * trip we have chosen to make them take, and it arrives with no information
 * about how to avoid a third. So: the reviewer's own words when they wrote
 * them, and otherwise a fallback composed from the item's OWN criteria and
 * formats — both of which the supplier can already read further up the same
 * page, so restating them here discloses nothing and makes the item actionable
 * on its own.
 *
 * Returns null for every state but 'needs_attention', and a non-null string for
 * that one. That asymmetry is the guarantee: it is enforced here, server-side,
 * not left to a component remembering to render a default.
 */
function attentionReasonFor(l: RequestLineRow): string | null {
  if (l.status !== 'needs_attention') return null;

  const written = clean(l.attention_reason);
  if (written) return written;

  const parts = ['We were not able to accept what was sent, so this item is still open.'];
  const criteria = clean(l.criteria);
  if (criteria) parts.push(`The replacement needs to show: ${criteria}`);
  const formats = clean(l.acceptable_formats);
  if (formats) parts.push(`Acceptable formats: ${formats}`);
  if (parts.length === 1) {
    parts.push(
      'Please send a current version. If you are not sure what changed, reply to the message that brought you here.',
    );
  }
  return parts.join(' ');
}

export function buildSupplierRequestView(input: SupplierViewInputs): SupplierRequestView | null {
  const { request, lines } = input;
  if (request.status !== 'issued' && request.status !== 'closed') return null;
  if (request.superseded_at) return null;

  // requirement_id -> the refs of the lines asking for it, so co-satisfaction
  // can be published as handles rather than as registry ids.
  const refsByRequirement = new Map<string, string[]>();
  for (const l of lines) {
    if (!l.requirement_id) continue;
    const ref = input.refs.get(l.id);
    if (!ref) continue;
    const list = refsByRequirement.get(l.requirement_id) ?? [];
    list.push(ref);
    refsByRequirement.set(l.requirement_id, list);
  }

  const items: SupplierRequestItem[] = lines.map((l) => {
    const ref = input.refs.get(l.id) ?? '';

    // Sibling items this supplier's own paperwork has closed at the same time.
    // Self is excluded; order follows the checklist, not the query.
    const also = new Set<string>();
    if (l.requirement_id) {
      for (const sibling of input.coSatisfaction.get(l.requirement_id) ?? []) {
        for (const siblingRef of refsByRequirement.get(sibling) ?? []) {
          if (siblingRef !== ref) also.add(siblingRef);
        }
      }
    }

    return {
      ref,
      name: l.name,
      explanation: l.explanation,
      acceptable_formats: l.acceptable_formats,
      criteria: l.criteria,
      tier: l.tier,
      status: l.status,
      attention_reason: attentionReasonFor(l),
      received_count: input.receivedCounts.get(l.id) ?? 0,
      also_covers: [...also],
    };
  });

  // Names, not ids: an upload's coverage is rendered as the item text the
  // supplier already sees, so the history block needs no handle at all.
  const history: SupplierRequestUpload[] = input.uploads.map((u) => ({
    file_name: u.file_name,
    size_bytes: u.file_size,
    uploaded_at: u.uploaded_at,
    uploader_label: u.uploader_label,
    covered_items: u.covered_names,
  }));

  const progress = buildProgress(lines);

  return {
    tenant_name: input.tenantName,
    supplier_name: input.supplierName,
    title: request.title,
    intro: request.intro,
    due_date: request.due_date,
    issued_at: request.issued_at,
    amended: request.version > 1,
    items,
    progress,
    complete: isComplete(lines, progress),
    history,
    accepting_uploads: input.acceptingUploads,
    link_expires_at: input.linkExpiresAt,
  };
}

/**
 * SATISFIED LINES, NOT UPLOADED FILES.
 *
 * The client was explicit: "Those are different numbers and the second one
 * flatters us." So the only thing counted is a line at 'accepted' — a state
 * only a reviewer can write. A supplier uploading ten files against one item
 * moves this by zero, which is correct and is the reason the number is worth
 * showing them.
 */
export function buildProgress(lines: RequestLineRow[]): SupplierRequestProgress {
  let required_total = 0;
  let required_satisfied = 0;
  let recommended_total = 0;
  let recommended_satisfied = 0;
  for (const l of lines) {
    const done = l.status === 'accepted';
    if (l.tier === 'required') {
      required_total += 1;
      if (done) required_satisfied += 1;
    } else {
      recommended_total += 1;
      if (done) recommended_satisfied += 1;
    }
  }
  return { required_total, required_satisfied, recommended_total, recommended_satisfied };
}

/**
 * "Am I done?" — the question the finished state answers.
 *
 * Required items only. A recommended item left open is not a failure to
 * comply, and telling a supplier they are incomplete because they declined an
 * optional extra would be the page lying in the other direction. A packet made
 * entirely of recommended lines falls back to all of them, so `complete` is
 * never trivially true for a request with outstanding work.
 */
function isComplete(lines: RequestLineRow[], progress: SupplierRequestProgress): boolean {
  if (lines.length === 0) return false;
  if (progress.required_total > 0) {
    return progress.required_satisfied === progress.required_total;
  }
  return progress.recommended_satisfied === progress.recommended_total;
}

// ---------------------------------------------------------------------------
// Gates + audit
// ---------------------------------------------------------------------------

/**
 * Composing, issuing, amending and templating are org_admin work: they commit
 * the organization to an outbound ask. Mirrors /api/supplier-requirements.
 */
export function requireComposer(user: User): void {
  requireRole(user, 'super_admin', 'org_admin');
}

/**
 * Moving a line's status is the assigned buyer doing their job, so the `user`
 * role is included. `reader` is not: a read-only account marking a document
 * accepted would be the role model saying one thing and the data another.
 */
export function requireLineWorker(user: User): void {
  requireRole(user, 'super_admin', 'org_admin', 'user');
}

/**
 * Which tenant a write targets. Same convention as the registry vocabulary
 * endpoints: a super_admin must name one, everyone else is pinned to their own.
 */
export function resolveRequestTenant(user: User, bodyTenantId?: string): string {
  if (user.role === 'super_admin') {
    if (!bodyTenantId) throw new BadRequestError('tenant_id is required for super_admin');
    return bodyTenantId;
  }
  if (!user.tenant_id) throw new ForbiddenError('No tenant');
  return user.tenant_id;
}

/**
 * Which tenant a request-scoped call resolves in.
 *
 * A super_admin has no tenant of their own, so the row's own tenant_id is used
 * once the id is known. Everyone else is pinned to theirs BEFORE any read, so a
 * foreign id is a 404 rather than a row — the id-existence probe is closed the
 * same way `assertNoteParent` closes it.
 */
export async function resolveTenantForRequest(
  db: D1Database,
  user: User,
  requestId: string,
): Promise<string> {
  if (user.role !== 'super_admin') {
    if (!user.tenant_id) throw new ForbiddenError('No tenant');
    return user.tenant_id;
  }
  const row = await db
    .prepare('SELECT tenant_id FROM document_requests WHERE id = ?')
    .bind(requestId)
    .first<{ tenant_id: string }>();
  if (!row) throw new NotFoundError('Request not found');
  return row.tenant_id;
}

export async function auditRequest(
  db: D1Database,
  user: User,
  tenantId: string,
  action: string,
  requestId: string,
  details: Record<string, unknown>,
  ip: string | null,
): Promise<void> {
  await logAudit(
    db,
    user.id,
    tenantId,
    action,
    'document_request',
    requestId,
    JSON.stringify(details),
    ip,
  );
}

// ---------------------------------------------------------------------------
// The one assembler
// ---------------------------------------------------------------------------

export interface AssembleSupplierViewInput {
  tenantId: string;
  /** The token whose handles this response publishes. See `itemRef`. */
  token: string;
  request: DocumentRequestRow;
  rootRequestId: string;
  supplierId: string;
  /** Null when there is no link yet — the internal preview before issue. */
  linkId: string | null;
  linkExpiresAt: string;
  acceptingUploads: boolean;
}

/**
 * Gather every input the outward payload needs and hand them to the ONE
 * projection.
 *
 * Both callers go through here — the public token route and the authenticated
 * "show me what they will see" preview — for the reason the preview's own
 * module note gives: "An allow-list only works if it is the ONE place the
 * outward shape is decided... Every future outward channel calls the same
 * function rather than assembling its own 'mostly the same' object, which is
 * how the second copy ends up with one field too many."
 *
 * Assembling is separated from projecting so the projection stays pure: it
 * takes named values and returns a payload, with no database in reach to
 * accidentally read one more column from.
 */
export async function assembleSupplierView(
  db: D1Database,
  input: AssembleSupplierViewInput,
): Promise<SupplierRequestView | null> {
  const lines = await loadLines(db, input.tenantId, input.request.id);

  const tenant = await db
    .prepare('SELECT name FROM tenants WHERE id = ?')
    .bind(input.tenantId)
    .first<{ name: string }>();
  // Tenant-scoped: the supplier name is read through the tenant that owns the
  // ask, never by id alone.
  const supplier = await db
    .prepare('SELECT name FROM suppliers WHERE id = ? AND tenant_id = ?')
    .bind(input.supplierId, input.tenantId)
    .first<{ name: string }>();
  if (!tenant || !supplier) return null;

  const refs = await computeItemRefs(input.token, lines);

  const uploads = input.linkId
    ? await loadUploadHistory(db, input.linkId, input.tenantId)
    : [];
  const receivedCounts = input.linkId
    ? await loadReceivedCounts(
        db,
        input.linkId,
        input.tenantId,
        input.rootRequestId,
        input.request.id,
      )
    : new Map<string, number>();

  const requirementIds = [
    ...new Set(lines.map((l) => l.requirement_id).filter((v): v is string => !!v)),
  ];
  const coSatisfaction = await loadCoSatisfaction(
    db,
    input.tenantId,
    input.supplierId,
    requirementIds,
  );

  return buildSupplierRequestView({
    tenantName: tenant.name,
    supplierName: supplier.name,
    request: input.request,
    lines,
    refs,
    receivedCounts,
    uploads,
    coSatisfaction,
    linkExpiresAt: input.linkExpiresAt,
    acceptingUploads: input.acceptingUploads,
  });
}
