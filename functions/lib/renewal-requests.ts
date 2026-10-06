/**
 * The supplier renewal send (migration 0133).
 *
 * The renewal alert (./renewal-alerts.ts) tells the INTERNAL owner a document
 * is running out. This is the other half: asking the supplier for the new one.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE
 * ---------------------------------------------------------------------------
 * The portal never emails a supplier on its own (AJ Conner, D-040..D-051).
 * So this module is two halves that do not share a code path:
 *
 *   draftSupplierRequests()  runs inside the scheduled/manual alert run. It
 *                            writes DRAFT rows and nothing else. It holds no
 *                            reference to the supplier's address beyond
 *                            checking that one exists, and it calls no mailer
 *                            with it.
 *   approveRenewalSend()     is reached only from an authenticated person's
 *                            POST. It is the ONLY place in the codebase that
 *                            mails a supplier contact.
 *
 * A test walks the whole ladder with the scheduled run and asserts that zero
 * mail reaches the contact without an approve call. Keep it that way: if a
 * future change needs "send automatically after N days", that is a ruling to
 * get from the client, not a flag to add here.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN PASS AND NOT PART OF THE DIGEST
 * ---------------------------------------------------------------------------
 * The owner digest is deliberately quiet: a 7-day cooldown, and three early
 * returns before anything is sent. Hung off that, the day-of and +7 / +14
 * drafts would be starved by the very suppression that makes the digest
 * bearable, and the manual "Send renewal alerts" button (which forces every
 * decision to 'first') would re-draft on every press. So drafting walks the
 * ALERTING ROWS itself and is idempotent through two UNIQUE keys:
 * (document, due date) for a cycle and (cycle, stage) for a draft. Run it ten
 * times in a morning and the tenth run writes nothing.
 *
 * ---------------------------------------------------------------------------
 * THE LADDER (shared/renewalRequestTemplate.ts)
 * ---------------------------------------------------------------------------
 *   window opens (the SAME lead time as the internal alert, 0111)
 *   day of expiry
 *   +7 days
 *   +14 days
 *   +21 days: stop. Escalate internally, once. Draft nothing further.
 *
 * At most four messages reach a supplier per cycle, and only one draft is ever
 * waiting: a newer stage SUPERSEDES an older one nobody approved.
 *
 * A cycle ends early when the due date moves, the document is archived or
 * re-pointed at another supplier, or a replacement is accepted against the
 * request (`request_lines.accepted_document_id`, set only by a person).
 *
 * ---------------------------------------------------------------------------
 * WHO APPROVES (D-050)
 * ---------------------------------------------------------------------------
 * The requester: the first active PORTAL USER on the record's owner route,
 * else the tenant's master user, else the org_admins. A route that holds only
 * a bare email address (a broker, a site manager) names nobody who can press
 * a button, so it falls through. The assigned approver or any administrator of
 * the tenant may approve; the email is sent with a reply-to of whoever did.
 */

import type { ExpirationRow } from './expirations';
import { alertingRows } from './expirations';
import { normalizeOwnerKey, resolveTenantAdmins, type AlertRecipient } from './alert-routing';
import { generateId, logAudit } from './db';
import { sendEmail, sendEmailDetailed, viaSenderName } from './email';
import {
  buildRenewalApprovalNoticeEmail,
  buildRenewalEscalationEmail,
  buildRenewalRequestSupplierEmail,
  type ApprovalNoticeItem,
  type EscalationNoticeItem,
} from './renewal-request-email';
import { composeRequest, issueRequest, resolveLines } from './document-requests';
import { mintRequestLink, requestLinkUrl } from './request-links';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from './permissions';
import { loadDocumentContact, loadDocumentContactsByTenant } from './supplier-contacts';
import {
  RENEWAL_BODY_MAX,
  RENEWAL_ESCALATE_AFTER_DAYS,
  RENEWAL_LINK_PLACEHOLDER,
  RENEWAL_SUBJECT_MAX,
  formatRenewalDate,
  isRenewalRequestStage,
  renderRenewalRequestDraft,
  renewalRequestEmailText,
  renewalRequestLinkBlock,
  renewalStageFor,
  renewalStageRank,
  type RenewalRequestStage,
  type RenewalRequestTemplateItem,
} from '../../shared/renewalRequestTemplate';
import type { User } from './types';
import type {
  RenewalApproverVia,
  RenewalNotDrafted,
  RenewalNotDraftedDocument,
  RenewalRequestItem,
  RenewalRequestListResponse,
  RenewalRequestSend,
  RenewalRequestSendStatus,
  RenewalRequestStatus,
  RequestLineInput,
  SupplierRequestRunResult,
} from '../../shared/types';

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface CycleRow {
  id: string;
  tenant_id: string;
  document_id: string;
  supplier_id: string;
  due_date: string;
  request_id: string | null;
  status: RenewalRequestStatus;
  status_reason: string | null;
  escalated_at: string | null;
  closed_at: string | null;
  created_at: string;
}

interface SendRow {
  id: string;
  tenant_id: string;
  renewal_request_id: string;
  stage: RenewalRequestStage;
  status: RenewalRequestSendStatus;
  draft_subject: string;
  draft_body: string;
  approver_user_id: string | null;
  approver_via: RenewalApproverVia | null;
  drafted_as_of: string;
  drafted_at: string;
  notified_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  sent_at: string | null;
  sent_to: string | null;
  sent_subject: string | null;
  sent_body: string | null;
  skipped_by: string | null;
  skipped_at: string | null;
  failure: string | null;
  attempt_count: number;
}

/** Statuses a person can still act on. A failed send is retryable. */
const WAITING: readonly RenewalRequestSendStatus[] = ['pending', 'failed'];

export function emptyNotDrafted(): RenewalNotDrafted {
  return { no_supplier: [], no_contact: [], past_escalation: [] };
}

export function emptySupplierRequestRun(): SupplierRequestRunResult {
  return {
    drafted: [],
    superseded_count: 0,
    ended: [],
    escalated: [],
    escalation_notified: [],
    escalation_notice_sent: false,
    not_drafted: emptyNotDrafted(),
    approver_notices: [],
  };
}

function notDraftedRef(r: ExpirationRow, supplierName: string | null): RenewalNotDraftedDocument {
  return {
    document_id: r.id,
    title: r.title,
    due_date: r.renewal_due_date,
    days_until: r.days_until,
    supplier_id: r.supplier_id ?? null,
    supplier_name: supplierName,
  };
}

async function loadSupplierNames(db: D1Database, tenantId: string): Promise<Map<string, string>> {
  const res = await db
    .prepare('SELECT id, name FROM suppliers WHERE tenant_id = ?')
    .bind(tenantId)
    .all<{ id: string; name: string }>();
  return new Map((res.results ?? []).map((s) => [s.id, s.name]));
}

// ---------------------------------------------------------------------------
// The approver
// ---------------------------------------------------------------------------

export interface ResolvedApprover {
  user_id: string | null;
  name: string | null;
  via: RenewalApproverVia;
}

/**
 * Who approves a draft for a record with this owner label. See the header.
 *
 * `resolveAlertRouting` cannot answer this: it returns addresses, and an
 * approver has to be an ACCOUNT. So the owner route is read again here for its
 * user rows only -- the first by creation, which is the person the route was
 * set up for before anybody was added to it.
 */
export async function resolveRenewalApprover(
  db: D1Database,
  tenantId: string,
  ownerLabel: string | null | undefined,
): Promise<ResolvedApprover> {
  const key = normalizeOwnerKey(ownerLabel);
  if (key) {
    const routed = await db
      .prepare(
        `SELECT u.id, u.name
           FROM owner_routes r
           JOIN users u ON u.id = r.user_id
          WHERE r.tenant_id = ? AND r.owner_key = ? AND r.active = 1 AND u.active = 1
            AND u.role != 'reader'
          ORDER BY r.created_at, r.id
          LIMIT 1`,
      )
      .bind(tenantId, key)
      .first<{ id: string; name: string | null }>();
    if (routed) return { user_id: routed.id, name: routed.name ?? null, via: 'owner_route' };
  }

  const master = await loadMasterUser(db, tenantId);
  if (master) return { user_id: master.id, name: master.name ?? null, via: 'master_user' };

  return { user_id: null, name: null, via: 'org_admins' };
}

/** The tenant's master user, only while it still resolves to an active account of this tenant. */
export async function loadMasterUser(
  db: D1Database,
  tenantId: string,
): Promise<{ id: string; name: string | null; email: string } | null> {
  const row = await db
    .prepare(
      `SELECT u.id, u.name, u.email
         FROM tenants t
         JOIN users u ON u.id = t.default_owner_user_id
        WHERE t.id = ? AND u.active = 1 AND u.tenant_id = t.id AND u.role != 'reader'`,
    )
    .bind(tenantId)
    .first<{ id: string; name: string | null; email: string }>();
  return row ?? null;
}

/**
 * May this person approve or skip this draft? The assigned approver, or an
 * administrator of the tenant. Not "any user": the draft was routed to a named
 * person for the same reason the alert was. Never a read-only account, even an
 * assigned one -- approving sends mail outside the organization, the same bar
 * as every other send (AJ, 2026-10-06: "anyone but a read-only account").
 */
export function canApproveSend(
  user: Pick<User, 'id' | 'role' | 'tenant_id'>,
  tenantId: string,
  approverUserId: string | null,
): boolean {
  if (user.role === 'super_admin') return true;
  if (user.tenant_id !== tenantId) return false;
  if (user.role === 'org_admin') return true;
  if (user.role === 'reader') return false;
  return approverUserId !== null && approverUserId === user.id;
}

// ---------------------------------------------------------------------------
// What is being asked for
// ---------------------------------------------------------------------------

export interface RenewalLinePlan {
  lines: RequestLineInput[];
  /** The supplier-facing names, which is all the template is given. */
  items: RenewalRequestTemplateItem[];
  basis: 'document_requirements' | 'document_type_requirements' | 'free_text';
}

/**
 * The lines of the request an approval will issue, most specific first:
 *
 *   1. the requirements this document is CONFIRMED to satisfy -- its renewal
 *      is what keeps exactly those closed;
 *   2. else what its TYPE normally closes (0100);
 *   3. else one declared free-text line named after the type. Free text is the
 *      composer's escape hatch and it is used as one: declared, and counted
 *      separately on every response.
 *
 * Read twice, at draft time (for the wording) and at approval (for the
 * request), so the request reflects the registry as it stands when a person
 * commits to the ask.
 */
export async function planRenewalLines(
  db: D1Database,
  tenantId: string,
  documentId: string,
): Promise<RenewalLinePlan> {
  const confirmed = await db
    .prepare(
      `SELECT r.id, r.name
         FROM document_requirements dr
         JOIN requirements r ON r.id = dr.requirement_id
        WHERE dr.document_id = ? AND dr.status = 'confirmed'
          AND r.tenant_id = ? AND r.active = 1
        ORDER BY r.sort_order, r.name`,
    )
    .bind(documentId, tenantId)
    .all<{ id: string; name: string }>();
  let rows = confirmed.results ?? [];
  let basis: RenewalLinePlan['basis'] = 'document_requirements';

  if (rows.length === 0) {
    const typed = await db
      .prepare(
        `SELECT r.id, r.name
           FROM documents d
           JOIN document_type_requirements dtr
             ON dtr.document_type_id = d.document_type_id AND dtr.tenant_id = d.tenant_id
           JOIN requirements r ON r.id = dtr.requirement_id
          WHERE d.id = ? AND d.tenant_id = ? AND r.active = 1
          ORDER BY r.sort_order, r.name`,
      )
      .bind(documentId, tenantId)
      .all<{ id: string; name: string }>();
    rows = typed.results ?? [];
    basis = 'document_type_requirements';
  }

  if (rows.length > 0) {
    return {
      lines: rows.map((r) => ({ requirement_id: r.id })),
      items: rows.map((r) => ({ name: r.name })),
      basis,
    };
  }

  // The type's NAME, never the document's title: a title is our own filing
  // label for the supplier's paper and is not written to be read by them.
  const type = await db
    .prepare(
      `SELECT dt.name FROM documents d
         LEFT JOIN document_types dt ON dt.id = d.document_type_id
        WHERE d.id = ? AND d.tenant_id = ?`,
    )
    .bind(documentId, tenantId)
    .first<{ name: string | null }>();
  const name = (type?.name ?? '').trim() || 'Current version of the document on file';
  return {
    lines: [{ line_kind: 'free_text', name }],
    items: [{ name }],
    basis: 'free_text',
  };
}

// ---------------------------------------------------------------------------
// The drafting pass
// ---------------------------------------------------------------------------

/** A draft whose approver has not been told yet. */
export interface AwaitingApproval {
  send_id: string;
  renewal_request_id: string;
  document_id: string;
  document_title: string;
  supplier_name: string;
  stage: RenewalRequestStage;
  due_date: string;
  approver_name: string | null;
  /** Everyone who must hear about it: the approver, or the admin pool. */
  notify: AlertRecipient[];
}

export interface SupplierRequestPass {
  result: SupplierRequestRunResult;
  awaiting: AwaitingApproval[];
}

export interface DraftSupplierRequestsOptions {
  tenantId: string;
  tenantName: string;
  asOf: string;
  /** EVERY classified row of the tenant, not only the alerting ones. */
  rows: ExpirationRow[];
  appUrl?: string;
  actorUserId: string | null;
}

function nowIso(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

async function audit(
  db: D1Database,
  actorUserId: string | null,
  tenantId: string,
  action: string,
  cycleId: string,
  details: Record<string, unknown>,
  ip: string | null = null,
): Promise<void> {
  try {
    await logAudit(db, actorUserId, tenantId, action, 'renewal_request', cycleId, JSON.stringify(details), ip);
  } catch (err) {
    console.error(`[renewal-requests] audit ${action} failed:`, err instanceof Error ? err.message : String(err));
  }
}

/** Close a cycle and withdraw whatever was still waiting on it. */
async function endCycle(
  db: D1Database,
  cycle: CycleRow,
  status: Exclude<RenewalRequestStatus, 'open'>,
  reason: string,
): Promise<void> {
  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `UPDATE renewal_requests
            SET status = ?, status_reason = ?, closed_at = ?, updated_at = ?,
                escalated_at = CASE WHEN ? = 'escalated' THEN ? ELSE escalated_at END
          WHERE id = ? AND status = 'open'`,
      )
      .bind(status, reason, now, now, status, now, cycle.id),
    db
      .prepare(
        `UPDATE renewal_request_sends
            SET status = 'cancelled', updated_at = ?
          WHERE renewal_request_id = ? AND status IN ('pending', 'failed')`,
      )
      .bind(now, cycle.id),
  ]);
  cycle.status = status;
  cycle.status_reason = reason;
}

/**
 * The scheduled half. Drafts, supersedes, ends and escalates -- and sends
 * nothing to any supplier. See the header.
 *
 * The one mail this function can send is the internal escalation notice, to
 * the tenant's own administrators.
 */
export async function draftSupplierRequests(
  db: D1Database,
  resendApiKey: string | undefined,
  opts: DraftSupplierRequestsOptions,
): Promise<SupplierRequestPass> {
  const result = emptySupplierRequestRun();
  const { tenantId, asOf } = opts;

  const cyclesRes = await db
    .prepare('SELECT * FROM renewal_requests WHERE tenant_id = ?')
    .bind(tenantId)
    .all<CycleRow>();
  const cycles = cyclesRes.results ?? [];
  const alerts = alertingRows(opts.rows).filter((r) => r.days_until !== null && r.renewal_due_date);

  // Nothing on file and nothing alerting: the common case for a tenant that
  // has never added a contact. Two cheap reads and out.
  const contacts = await loadDocumentContactsByTenant(db, tenantId);
  if (cycles.length === 0 && contacts.size === 0) {
    if (alerts.length > 0) {
      const names = await loadSupplierNames(db, tenantId);
      classifyUndrafted(alerts, new Map(), contacts, names, result.not_drafted);
    }
    return { result, awaiting: [] };
  }

  const supplierNames = await loadSupplierNames(db, tenantId);
  const rowById = new Map(opts.rows.map((r) => [r.id, r]));

  // -- 1. cycles that are over ---------------------------------------------
  const open = cycles.filter((c) => c.status === 'open');
  if (open.length > 0) {
    const acceptedRes = await db
      .prepare(
        `SELECT DISTINCT rr.id
           FROM renewal_requests rr
           JOIN document_requests dr
             ON dr.root_request_id = rr.request_id AND dr.superseded_at IS NULL
           JOIN request_lines rl ON rl.request_id = dr.id
          WHERE rr.tenant_id = ? AND rr.status = 'open'
            AND rl.accepted_document_id IS NOT NULL`,
      )
      .bind(tenantId)
      .all<{ id: string }>();
    const accepted = new Set((acceptedRes.results ?? []).map((r) => r.id));

    for (const cycle of open) {
      const row = rowById.get(cycle.document_id);
      let end: { status: Exclude<RenewalRequestStatus, 'open'>; reason: string } | null = null;
      if (accepted.has(cycle.id)) {
        end = { status: 'satisfied', reason: 'replacement_accepted' };
      } else if (!row) {
        // Not among the tenant's classified rows any more: archived, deleted,
        // or it no longer resolves to a renewal date at all.
        const doc = await db
          .prepare('SELECT status FROM documents WHERE id = ? AND tenant_id = ?')
          .bind(cycle.document_id, tenantId)
          .first<{ status: string }>();
        end = {
          status: 'stopped',
          reason: doc && doc.status === 'active' ? 'no_longer_renews' : 'document_archived',
        };
      } else if (row.renewal_due_date !== cycle.due_date) {
        end = { status: 'stopped', reason: 'due_date_changed' };
      } else if ((row.supplier_id ?? null) !== cycle.supplier_id) {
        end = { status: 'stopped', reason: 'supplier_changed' };
      }
      if (!end) continue;
      await endCycle(db, cycle, end.status, end.reason);
      result.ended.push({
        renewal_request_id: cycle.id,
        document_id: cycle.document_id,
        status: end.status,
        reason: end.reason,
      });
      await audit(db, opts.actorUserId, tenantId, 'renewal_request.cycle_ended', cycle.id, {
        document_id: cycle.document_id,
        supplier_id: cycle.supplier_id,
        due_date: cycle.due_date,
        status: end.status,
        reason: end.reason,
        ...(row && end.reason === 'due_date_changed' ? { new_due_date: row.renewal_due_date } : {}),
      });
    }
  }

  // -- 2. drafts ------------------------------------------------------------
  const cycleByKey = new Map(cycles.map((c) => [`${c.document_id}|${c.due_date}`, c]));
  const sendsRes = await db
    .prepare(
      `SELECT s.* FROM renewal_request_sends s
         JOIN renewal_requests r ON r.id = s.renewal_request_id
        WHERE r.tenant_id = ? AND r.status = 'open'`,
    )
    .bind(tenantId)
    .all<SendRow>();
  const sendsByCycle = new Map<string, SendRow[]>();
  for (const s of sendsRes.results ?? []) {
    const list = sendsByCycle.get(s.renewal_request_id);
    if (list) list.push(s);
    else sendsByCycle.set(s.renewal_request_id, [s]);
  }

  const approverByOwner = new Map<string | null, ResolvedApprover>();
  const escalations: EscalationNoticeItem[] = [];

  for (const r of alerts) {
    const due = r.renewal_due_date as string;
    const daysUntil = r.days_until as number;
    const supplierName = r.supplier_id ? (supplierNames.get(r.supplier_id) ?? null) : null;

    if (!r.supplier_id) {
      result.not_drafted.no_supplier.push(notDraftedRef(r, null));
      continue;
    }

    let cycle = cycleByKey.get(`${r.id}|${due}`) ?? null;
    if (cycle && cycle.status !== 'open') continue; // this date's cycle is over

    const stage = renewalStageFor(daysUntil, r.alert_lead_days);
    if (stage === null) continue;
    const contact = contacts.get(r.supplier_id) ?? null;

    if (!cycle) {
      // First seen already past the last follow-up window (a contact added
      // late, or the day this shipped). Opening a cycle only to escalate it
      // would greet a tenant with one notice per long-expired document.
      if (stage === 'escalate') {
        result.not_drafted.past_escalation.push(notDraftedRef(r, supplierName));
        continue;
      }
      if (!contact) {
        result.not_drafted.no_contact.push(notDraftedRef(r, supplierName));
        continue;
      }
      const id = generateId();
      await db
        .prepare(
          `INSERT OR IGNORE INTO renewal_requests
             (id, tenant_id, document_id, supplier_id, due_date, status)
           VALUES (?, ?, ?, ?, ?, 'open')`,
        )
        .bind(id, tenantId, r.id, r.supplier_id, due)
        .run();
      // Re-read by the UNIQUE key rather than trusting `id`: a concurrent run
      // may have won the insert.
      cycle = await db
        .prepare('SELECT * FROM renewal_requests WHERE document_id = ? AND due_date = ?')
        .bind(r.id, due)
        .first<CycleRow>();
      if (!cycle || cycle.status !== 'open') continue;
      cycleByKey.set(`${r.id}|${due}`, cycle);
    }

    const sends = sendsByCycle.get(cycle.id) ?? [];
    const emailsSent = sends.filter((s) => s.status === 'sent').length;

    if (stage === 'escalate') {
      await endCycle(db, cycle, 'escalated', 'no_response');
      result.escalated.push({ renewal_request_id: cycle.id, document_id: r.id, emails_sent: emailsSent });
      escalations.push({
        document_title: r.title,
        supplier_name: supplierName ?? 'the supplier',
        due_date: due,
        days_past_due: -daysUntil,
        emails_sent: emailsSent,
      });
      await audit(db, opts.actorUserId, tenantId, 'expirations.supplier_send_escalated', cycle.id, {
        document_id: r.id,
        supplier_id: cycle.supplier_id,
        due_date: due,
        days_past_due: -daysUntil,
        emails_sent: emailsSent,
        escalate_after_days: RENEWAL_ESCALATE_AFTER_DAYS,
      });
      continue;
    }

    // Idempotency, and never backwards: a stage that exists is settled, and a
    // run replayed for an earlier `as_of` must not draft behind a later stage.
    const rank = renewalStageRank(stage);
    if (sends.some((s) => renewalStageRank(s.stage) >= rank)) continue;

    if (!contact) {
      result.not_drafted.no_contact.push(notDraftedRef(r, supplierName));
      continue;
    }

    const ownerKey = normalizeOwnerKey(r.owner);
    let approver = approverByOwner.get(ownerKey);
    if (!approver) {
      approver = await resolveRenewalApprover(db, tenantId, r.owner);
      approverByOwner.set(ownerKey, approver);
    }

    const plan = await planRenewalLines(db, tenantId, r.id);
    // The allow-list call. Every argument is named; nothing of `r` beyond its
    // due date reaches the template.
    const draft = renderRenewalRequestDraft({
      tenantName: opts.tenantName,
      contactName: contact.name,
      items: plan.items,
      dueDate: due,
      stage,
      requesterName: approver.name,
      isFollowUp: emailsSent > 0,
    });

    const sendId = generateId();
    const now = nowIso();
    const superseded = sends.filter((s) => WAITING.includes(s.status));
    const batch = await db.batch([
      db
        .prepare(
          `UPDATE renewal_request_sends
              SET status = 'superseded', updated_at = ?
            WHERE renewal_request_id = ? AND status IN ('pending', 'failed')`,
        )
        .bind(now, cycle.id),
      db
        .prepare(
          `INSERT OR IGNORE INTO renewal_request_sends
             (id, tenant_id, renewal_request_id, stage, status, draft_subject, draft_body,
              approver_user_id, approver_via, drafted_as_of, drafted_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          sendId,
          tenantId,
          cycle.id,
          stage,
          draft.subject,
          draft.body,
          approver.user_id,
          approver.via,
          asOf,
          now,
          now,
        ),
    ]);
    // 0 changes = the UNIQUE(cycle, stage) key held: another run drafted it.
    if ((batch[1]?.meta?.changes ?? 0) === 0) continue;

    for (const s of superseded) s.status = 'superseded';
    result.superseded_count += superseded.length;
    result.drafted.push({
      renewal_request_id: cycle.id,
      send_id: sendId,
      document_id: r.id,
      stage,
      approver_user_id: approver.user_id,
      approver_via: approver.via,
    });
    await audit(db, opts.actorUserId, tenantId, 'renewal_request.drafted', cycle.id, {
      send_id: sendId,
      document_id: r.id,
      supplier_id: cycle.supplier_id,
      due_date: due,
      stage,
      approver_user_id: approver.user_id,
      approver_via: approver.via,
      line_basis: plan.basis,
      superseded_send_ids: superseded.map((s) => s.id),
    });
  }

  // -- 3. the escalation notice (internal) ----------------------------------
  if (escalations.length > 0) {
    const recipients = await escalationRecipients(db, tenantId);
    result.escalation_notified = recipients.map((r) => r.email);
    if (resendApiKey && recipients.length > 0) {
      const { subject, html } = buildRenewalEscalationEmail(
        escalations,
        opts.tenantName,
        opts.appUrl ? `${opts.appUrl.replace(/\/$/, '')}/expirations` : null,
      );
      result.escalation_notice_sent = await sendEmail(resendApiKey, {
        to: result.escalation_notified,
        subject,
        html,
      });
    }
  }

  return { result, awaiting: await loadAwaitingApproval(db, tenantId) };
}

/** Sort alerting rows nothing can be drafted for, when there is no cycle state to consult. */
function classifyUndrafted(
  alerts: ExpirationRow[],
  cycleByKey: Map<string, CycleRow>,
  contacts: Map<string, unknown>,
  supplierNames: Map<string, string>,
  out: RenewalNotDrafted,
): void {
  for (const r of alerts) {
    if (!r.supplier_id) {
      out.no_supplier.push(notDraftedRef(r, null));
      continue;
    }
    const name = supplierNames.get(r.supplier_id) ?? null;
    const cycle = cycleByKey.get(`${r.id}|${r.renewal_due_date}`);
    if (cycle && cycle.status !== 'open') continue;
    const stage = renewalStageFor(r.days_until as number, r.alert_lead_days);
    if (stage === null) continue;
    if (!cycle && stage === 'escalate') out.past_escalation.push(notDraftedRef(r, name));
    else if (!contacts.has(r.supplier_id)) out.no_contact.push(notDraftedRef(r, name));
  }
}

/**
 * The same three buckets, computed at READ for the Renewals page -- so the
 * screen says "no document contact on file" the moment a document enters its
 * window, without waiting for the next scheduled run to report it.
 */
export async function loadNotDrafted(
  db: D1Database,
  tenantId: string,
  rows: ExpirationRow[],
): Promise<RenewalNotDrafted> {
  const out = emptyNotDrafted();
  const alerts = alertingRows(rows).filter((r) => r.days_until !== null && r.renewal_due_date);
  if (alerts.length === 0) return out;
  const [contacts, names, cyclesRes] = await Promise.all([
    loadDocumentContactsByTenant(db, tenantId),
    loadSupplierNames(db, tenantId),
    db.prepare('SELECT * FROM renewal_requests WHERE tenant_id = ?').bind(tenantId).all<CycleRow>(),
  ]);
  const cycleByKey = new Map((cyclesRes.results ?? []).map((c) => [`${c.document_id}|${c.due_date}`, c]));
  classifyUndrafted(alerts, cycleByKey, contacts, names, out);
  return out;
}

/** The tenant's org_admins plus its master user, deduped. */
async function escalationRecipients(db: D1Database, tenantId: string): Promise<AlertRecipient[]> {
  const admins = await resolveTenantAdmins(db, tenantId);
  const master = await loadMasterUser(db, tenantId);
  const seen = new Set(admins.map((a) => a.email.toLowerCase()));
  if (master && master.email && !seen.has(master.email.toLowerCase())) {
    admins.push({ email: master.email, name: master.name });
  }
  return admins;
}

/** Every waiting draft whose approver has not been told. */
async function loadAwaitingApproval(db: D1Database, tenantId: string): Promise<AwaitingApproval[]> {
  const res = await db
    .prepare(
      `SELECT s.id AS send_id, s.renewal_request_id, s.stage, s.approver_user_id,
              r.document_id, r.due_date,
              d.title AS document_title, sup.name AS supplier_name,
              u.name AS approver_name, u.email AS approver_email, u.active AS approver_active
         FROM renewal_request_sends s
         JOIN renewal_requests r ON r.id = s.renewal_request_id
         JOIN documents d ON d.id = r.document_id
         JOIN suppliers sup ON sup.id = r.supplier_id
         LEFT JOIN users u ON u.id = s.approver_user_id
        WHERE s.tenant_id = ? AND s.status = 'pending' AND s.notified_at IS NULL
          AND r.status = 'open'
        ORDER BY r.due_date, s.id`,
    )
    .bind(tenantId)
    .all<{
      send_id: string;
      renewal_request_id: string;
      stage: RenewalRequestStage;
      approver_user_id: string | null;
      document_id: string;
      due_date: string;
      document_title: string;
      supplier_name: string;
      approver_name: string | null;
      approver_email: string | null;
      approver_active: number | null;
    }>();
  const rows = res.results ?? [];
  if (rows.length === 0) return [];

  let admins: AlertRecipient[] | null = null;
  const out: AwaitingApproval[] = [];
  for (const r of rows) {
    const named = r.approver_user_id && r.approver_email && Number(r.approver_active) === 1;
    let notify: AlertRecipient[];
    if (named) {
      notify = [{ email: r.approver_email as string, name: r.approver_name }];
    } else {
      // No single approver (or the one named has since been deactivated):
      // any administrator may approve, so every administrator is told.
      if (admins === null) admins = await resolveTenantAdmins(db, tenantId);
      notify = admins;
    }
    out.push({
      send_id: r.send_id,
      renewal_request_id: r.renewal_request_id,
      document_id: r.document_id,
      document_title: r.document_title,
      supplier_name: r.supplier_name,
      stage: r.stage,
      due_date: r.due_date,
      approver_name: named ? r.approver_name : null,
      notify,
    });
  }
  return out;
}

export function reviewUrl(appUrl: string | undefined, sendId: string): string | null {
  if (!appUrl) return null;
  return `${appUrl.replace(/\/$/, '')}/expirations?supplier_request=${encodeURIComponent(sendId)}`;
}

export function toApprovalNoticeItem(a: AwaitingApproval, appUrl: string | undefined): ApprovalNoticeItem {
  return {
    document_title: a.document_title,
    supplier_name: a.supplier_name,
    stage: a.stage,
    due_date: a.due_date,
    approver_name: a.approver_name,
    review_url: reviewUrl(appUrl, a.send_id),
  };
}

/**
 * The drafts an owner digest can carry (D-049: one notification, not two).
 *
 * A draft rides along only when the digest is about that very document AND
 * every person who has to hear about the draft is already a recipient of it.
 * Anything else gets its own notice afterwards.
 */
export function awaitingForDigest(
  awaiting: AwaitingApproval[],
  documentIds: string[],
  recipients: string[],
  alreadyNotified: Set<string>,
): AwaitingApproval[] {
  const docs = new Set(documentIds);
  const to = new Set(recipients.map((e) => e.toLowerCase()));
  return awaiting.filter(
    (a) =>
      !alreadyNotified.has(a.send_id) &&
      docs.has(a.document_id) &&
      a.notify.length > 0 &&
      a.notify.every((n) => to.has(n.email.toLowerCase())),
  );
}

export async function markApproversNotified(
  db: D1Database,
  tenantId: string,
  sendIds: string[],
): Promise<void> {
  if (sendIds.length === 0) return;
  const now = nowIso();
  const stmt = db.prepare(
    `UPDATE renewal_request_sends SET notified_at = ? WHERE id = ? AND tenant_id = ? AND notified_at IS NULL`,
  );
  try {
    await db.batch(sendIds.map((id) => stmt.bind(now, id, tenantId)));
  } catch (err) {
    console.error('[renewal-requests] stamping notified_at failed:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Tell the approvers the digests did not reach. One email per distinct set of
 * recipients, stamped only when it actually left -- an unsent notice is tried
 * again on the next run.
 */
export async function sendApproverNotices(
  db: D1Database,
  resendApiKey: string | undefined,
  opts: { tenantId: string; tenantName: string; appUrl?: string },
  awaiting: AwaitingApproval[],
): Promise<SupplierRequestRunResult['approver_notices']> {
  const notices: SupplierRequestRunResult['approver_notices'] = [];
  if (awaiting.length === 0) return notices;

  const groups = new Map<string, { recipients: string[]; items: AwaitingApproval[] }>();
  for (const a of awaiting) {
    const recipients = [...new Set(a.notify.map((n) => n.email))].sort();
    if (recipients.length === 0) continue; // nobody to tell; the screen still shows it
    const key = recipients.map((e) => e.toLowerCase()).join('|');
    const g = groups.get(key);
    if (g) g.items.push(a);
    else groups.set(key, { recipients, items: [a] });
  }

  for (const g of groups.values()) {
    const sendIds = g.items.map((i) => i.send_id);
    if (!resendApiKey) {
      notices.push({ send_ids: sendIds, recipients: g.recipients, via: 'notice', sent: false });
      continue;
    }
    const { subject, html } = buildRenewalApprovalNoticeEmail(
      g.items.map((i) => toApprovalNoticeItem(i, opts.appUrl)),
      opts.tenantName,
    );
    const ok = await sendEmail(resendApiKey, { to: g.recipients, subject, html });
    if (ok) await markApproversNotified(db, opts.tenantId, sendIds);
    notices.push({ send_ids: sendIds, recipients: g.recipients, via: 'notice', sent: ok });
  }
  return notices;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function toSend(
  s: SendRow & { approver_name?: string | null; approved_by_name?: string | null; skipped_by_name?: string | null },
): RenewalRequestSend {
  return {
    id: s.id,
    stage: s.stage,
    status: s.status,
    draft_subject: s.draft_subject,
    draft_body: s.draft_body,
    approver_user_id: s.approver_user_id ?? null,
    approver_name: s.approver_name ?? null,
    approver_via: s.approver_via ?? null,
    drafted_at: s.drafted_at,
    approved_by: s.approved_by ?? null,
    approved_by_name: s.approved_by_name ?? null,
    approved_at: s.approved_at ?? null,
    sent_at: s.sent_at ?? null,
    sent_to: s.sent_to ?? null,
    sent_subject: s.sent_subject ?? null,
    sent_body: s.sent_body ?? null,
    skipped_by_name: s.skipped_by_name ?? null,
    skipped_at: s.skipped_at ?? null,
    failure: s.failure ?? null,
  };
}

const LIST_LIMIT = 300;

/**
 * Cycles for the Renewals page, most pressing first. `id` narrows to one.
 * `user` decides `can_approve` per row -- the screen never has to guess
 * whether a button will be refused.
 */
export async function listRenewalRequests(
  db: D1Database,
  tenantId: string,
  user: Pick<User, 'id' | 'role' | 'tenant_id'>,
  filter: { id?: string } = {},
): Promise<RenewalRequestItem[]> {
  const cyclesRes = await db
    .prepare(
      `SELECT r.*, d.title AS document_title, sup.name AS supplier_name
         FROM renewal_requests r
         JOIN documents d ON d.id = r.document_id
         JOIN suppliers sup ON sup.id = r.supplier_id
        WHERE r.tenant_id = ? ${filter.id ? 'AND r.id = ?' : ''}
        ORDER BY CASE r.status WHEN 'open' THEN 0 WHEN 'escalated' THEN 1 ELSE 2 END,
                 r.due_date, r.id
        LIMIT ${LIST_LIMIT}`,
    )
    .bind(...(filter.id ? [tenantId, filter.id] : [tenantId]))
    .all<CycleRow & { document_title: string; supplier_name: string }>();
  const cycles = cyclesRes.results ?? [];
  if (cycles.length === 0) return [];

  const sendsRes = await db
    .prepare(
      `SELECT s.*, au.name AS approver_name, bu.name AS approved_by_name, su.name AS skipped_by_name
         FROM renewal_request_sends s
         LEFT JOIN users au ON au.id = s.approver_user_id
         LEFT JOIN users bu ON bu.id = s.approved_by
         LEFT JOIN users su ON su.id = s.skipped_by
        WHERE s.tenant_id = ? ${filter.id ? 'AND s.renewal_request_id = ?' : ''}
        ORDER BY s.drafted_at, s.id`,
    )
    .bind(...(filter.id ? [tenantId, filter.id] : [tenantId]))
    .all<SendRow & { approver_name: string | null; approved_by_name: string | null; skipped_by_name: string | null }>();
  const sendsByCycle = new Map<string, RenewalRequestSend[]>();
  for (const s of sendsRes.results ?? []) {
    const list = sendsByCycle.get(s.renewal_request_id);
    if (list) list.push(toSend(s));
    else sendsByCycle.set(s.renewal_request_id, [toSend(s)]);
  }

  const contacts = await loadDocumentContactsByTenant(db, tenantId);

  return cycles.map((c) => {
    const sends = (sendsByCycle.get(c.id) ?? []).sort(
      (a, b) => renewalStageRank(a.stage) - renewalStageRank(b.stage),
    );
    const waiting = c.status === 'open' ? sends.find((s) => WAITING.includes(s.status)) : undefined;
    const contact = contacts.get(c.supplier_id) ?? null;
    return {
      id: c.id,
      document: { id: c.document_id, title: c.document_title },
      supplier: { id: c.supplier_id, name: c.supplier_name },
      due_date: c.due_date,
      status: c.status,
      status_reason: c.status_reason ?? null,
      escalated_at: c.escalated_at ?? null,
      closed_at: c.closed_at ?? null,
      request_id: c.request_id ?? null,
      contact: contact ? { name: contact.name ?? null, email: contact.email } : null,
      sends,
      waiting_send_id: waiting?.id ?? null,
      can_approve: waiting ? canApproveSend(user, tenantId, waiting.approver_user_id) : false,
      emails_sent: sends.filter((s) => s.status === 'sent').length,
    };
  });
}

export function listResponseExtras(
  resendApiKey: string | undefined,
): Pick<RenewalRequestListResponse, 'link_block_preview' | 'email_configured' | 'escalate_after_days'> {
  return {
    link_block_preview: renewalRequestLinkBlock(RENEWAL_LINK_PLACEHOLDER),
    email_configured: Boolean(resendApiKey),
    escalate_after_days: RENEWAL_ESCALATE_AFTER_DAYS,
  };
}

// ---------------------------------------------------------------------------
// The human half: approve / skip
// ---------------------------------------------------------------------------

async function loadCycleAndSend(
  db: D1Database,
  tenantId: string,
  cycleId: string,
  sendId: string,
): Promise<{ cycle: CycleRow; send: SendRow }> {
  const cycle = await db
    .prepare('SELECT * FROM renewal_requests WHERE id = ? AND tenant_id = ?')
    .bind(cycleId, tenantId)
    .first<CycleRow>();
  if (!cycle) throw new NotFoundError('Renewal request not found');
  const send = await db
    .prepare('SELECT * FROM renewal_request_sends WHERE id = ? AND renewal_request_id = ? AND tenant_id = ?')
    .bind(sendId, cycleId, tenantId)
    .first<SendRow>();
  if (!send) throw new NotFoundError('Renewal request not found');
  return { cycle, send };
}

function assertActionable(cycle: CycleRow, send: SendRow): void {
  if (cycle.status !== 'open') {
    throw new ConflictError(
      `This renewal request is ${cycle.status}; nothing further is sent for it.`,
    );
  }
  if (!WAITING.includes(send.status)) {
    throw new ConflictError(`This draft is already ${send.status}.`);
  }
}

/** Which tenant a renewal-request call resolves in (a super_admin has none of their own). */
export async function resolveTenantForRenewalRequest(
  db: D1Database,
  user: User,
  cycleId: string,
): Promise<string> {
  if (user.role !== 'super_admin') {
    if (!user.tenant_id) throw new ForbiddenError('No tenant');
    return user.tenant_id;
  }
  const row = await db
    .prepare('SELECT tenant_id FROM renewal_requests WHERE id = ?')
    .bind(cycleId)
    .first<{ tenant_id: string }>();
  if (!row) throw new NotFoundError('Renewal request not found');
  return row.tenant_id;
}

export type ApproveOutcome =
  | { sent: true; sendId: string; to: string }
  | { sent: false; code: 'email_not_configured' | 'no_document_contact' | 'send_failed'; error: string };

export interface ApproveRenewalSendInput {
  tenantId: string;
  cycleId: string;
  sendId: string;
  subject: unknown;
  body: unknown;
  appUrl: string;
  ip: string | null;
}

/**
 * APPROVE = ISSUE + SEND. The only function that mails a supplier.
 *
 * `user` is the human who pressed the button and is the actor on everything
 * below: the request is composed and issued as them (the composer's "a
 * generator drafts, a human issues" rule holds with no exception), the email
 * carries their address as reply-to, and the audit row names them.
 *
 * Order matters:
 *   1. refuse everything refusable BEFORE writing (state, role, text, mail
 *      configuration, a contact to send to);
 *   2. claim the draft under a guard, so a double click cannot send twice;
 *   3. issue the request once per cycle and pin it to the cycle immediately,
 *      so a failed send retried later re-uses the same request and link;
 *   4. send; record `sent` only on the provider's 2xx. A refused send is
 *      `failed`, says why, and can be approved again.
 */
export async function approveRenewalSend(
  db: D1Database,
  resendApiKey: string | undefined,
  user: User,
  input: ApproveRenewalSendInput,
): Promise<ApproveOutcome> {
  const { tenantId } = input;
  const { cycle, send } = await loadCycleAndSend(db, tenantId, input.cycleId, input.sendId);
  if (!canApproveSend(user, tenantId, send.approver_user_id)) {
    throw new ForbiddenError('Only the assigned approver or an administrator can send this request');
  }
  assertActionable(cycle, send);

  const subject = typeof input.subject === 'string' ? input.subject.replace(/[\r\n]+/g, ' ').trim() : '';
  const body = typeof input.body === 'string' ? input.body.replace(/\r\n/g, '\n').trim() : '';
  if (!subject) throw new BadRequestError('subject is required');
  if (!body) throw new BadRequestError('body is required');
  if (subject.length > RENEWAL_SUBJECT_MAX) {
    throw new BadRequestError(`subject must be ${RENEWAL_SUBJECT_MAX} characters or fewer`);
  }
  if (body.length > RENEWAL_BODY_MAX) {
    throw new BadRequestError(`body must be ${RENEWAL_BODY_MAX} characters or fewer`);
  }

  if (!resendApiKey) {
    return {
      sent: false,
      code: 'email_not_configured',
      error: 'Email is not configured on this server, so nothing was sent. The draft is still waiting.',
    };
  }
  const contact = await loadDocumentContact(db, tenantId, cycle.supplier_id);
  if (!contact) {
    return {
      sent: false,
      code: 'no_document_contact',
      error: 'This supplier has no document contact on file. Add one on Supplier > Contacts, then send.',
    };
  }

  // -- claim ----------------------------------------------------------------
  const now = nowIso();
  const claim = await db
    .prepare(
      `UPDATE renewal_request_sends
          SET attempt_count = attempt_count + 1, approved_by = ?, approved_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('pending', 'failed') AND attempt_count = ?`,
    )
    .bind(user.id, now, now, send.id, send.attempt_count)
    .run();
  if ((claim.meta?.changes ?? 0) !== 1) {
    throw new ConflictError('This request is already being sent.');
  }

  // -- issue, once per cycle --------------------------------------------------
  let rootRequestId = cycle.request_id;
  if (!rootRequestId) {
    const plan = await planRenewalLines(db, tenantId, cycle.document_id);
    const lines = await resolveLines(db, tenantId, plan.lines);
    const what = plan.items.length === 1 ? plan.items[0].name : `${plan.items.length} documents`;
    rootRequestId = await composeRequest(db, tenantId, user, {
      supplierId: cycle.supplier_id,
      title: `Renewal request: ${what}`,
      intro: `Our copy on file expires on ${formatRenewalDate(cycle.due_date)}. Please send the current version.`,
      dueDate: cycle.due_date,
      origin: 'generated',
      originRef: `renewal:${cycle.document_id}:${cycle.due_date}`,
      lines,
    });
    await issueRequest(db, tenantId, rootRequestId, user, {
      channel: 'email',
      recipient: contact.email,
    });
    await db
      .prepare(`UPDATE renewal_requests SET request_id = ?, updated_at = ? WHERE id = ? AND request_id IS NULL`)
      .bind(rootRequestId, now, cycle.id)
      .run();
    try {
      await logAudit(
        db,
        user.id,
        tenantId,
        'document_request_issued',
        'document_request',
        rootRequestId,
        JSON.stringify({
          supplier_id: cycle.supplier_id,
          version: 1,
          origin: 'generated',
          origin_ref: `renewal:${cycle.document_id}:${cycle.due_date}`,
          line_count: lines.length,
          free_text_lines: lines.filter((l) => l.line_kind === 'free_text').length,
          channel: 'email',
          via: 'renewal_request_approval',
        }),
        input.ip,
      );
    } catch {
      /* best-effort, like every other audit write on a path that already committed */
    }
  }

  // -- the link ---------------------------------------------------------------
  let token =
    (
      await db
        .prepare(
          `SELECT token FROM request_links
            WHERE root_request_id = ? AND tenant_id = ?
              AND revoked_at IS NULL AND expires_at > datetime('now')
            ORDER BY created_at DESC LIMIT 1`,
        )
        .bind(rootRequestId, tenantId)
        .first<{ token: string }>()
    )?.token ?? null;
  if (!token) {
    // Revoked or expired since the first send. A follow-up still needs a door.
    token = await mintRequestLink(db, {
      tenantId,
      rootRequestId,
      supplierId: cycle.supplier_id,
      dueDate: cycle.due_date,
      createdBy: user.id,
    });
  }
  const linkUrl = requestLinkUrl(input.appUrl, token);
  if (!linkUrl) {
    return await recordFailure(db, user, input, cycle, send, contact.email, 'Could not create the upload link');
  }

  // -- send -------------------------------------------------------------------
  const tenant = await db
    .prepare('SELECT name FROM tenants WHERE id = ?')
    .bind(tenantId)
    .first<{ name: string }>();
  const tenantName = tenant?.name ?? 'SupDox';
  const sentBody = renewalRequestEmailText(body, linkUrl);
  const { html } = buildRenewalRequestSupplierEmail({ tenantName, body, linkUrl });

  const mail = await sendEmailDetailed(resendApiKey, {
    to: contact.email,
    subject,
    html,
    fromName: viaSenderName(tenantName),
    replyTo: user.email,
  });
  if (!mail.ok) {
    return await recordFailure(
      db,
      user,
      input,
      cycle,
      send,
      contact.email,
      mail.error || `The mail provider refused the message (status ${mail.status})`,
    );
  }

  const sentAt = nowIso();
  await db
    .prepare(
      `UPDATE renewal_request_sends
          SET status = 'sent', sent_at = ?, sent_to = ?, sent_subject = ?, sent_body = ?,
              failure = NULL, updated_at = ?
        WHERE id = ?`,
    )
    .bind(sentAt, contact.email, subject, sentBody, sentAt, send.id)
    .run();
  await audit(
    db,
    user.id,
    tenantId,
    'renewal_request.sent',
    cycle.id,
    {
      send_id: send.id,
      stage: send.stage,
      document_id: cycle.document_id,
      supplier_id: cycle.supplier_id,
      due_date: cycle.due_date,
      request_id: rootRequestId,
      sent_to: contact.email,
      reply_to: user.email,
      from_name: viaSenderName(tenantName),
      approved_by: user.id,
      approved_at: now,
      assigned_approver_user_id: send.approver_user_id,
      subject,
      body: sentBody,
      edited: subject !== send.draft_subject || body !== send.draft_body.trim(),
    },
    input.ip,
  );
  return { sent: true, sendId: send.id, to: contact.email };
}

async function recordFailure(
  db: D1Database,
  user: User,
  input: ApproveRenewalSendInput,
  cycle: CycleRow,
  send: SendRow,
  to: string,
  error: string,
): Promise<ApproveOutcome> {
  await db
    .prepare(`UPDATE renewal_request_sends SET status = 'failed', failure = ?, updated_at = ? WHERE id = ?`)
    .bind(error.slice(0, 500), nowIso(), send.id)
    .run();
  await audit(
    db,
    user.id,
    input.tenantId,
    'renewal_request.send_failed',
    cycle.id,
    { send_id: send.id, stage: send.stage, document_id: cycle.document_id, sent_to: to, error: error.slice(0, 500) },
    input.ip,
  );
  return { sent: false, code: 'send_failed', error };
}

/** A person decides this stage should not go. The cycle continues; a later stage may still be drafted. */
export async function skipRenewalSend(
  db: D1Database,
  user: User,
  input: { tenantId: string; cycleId: string; sendId: string; ip: string | null },
): Promise<void> {
  const { cycle, send } = await loadCycleAndSend(db, input.tenantId, input.cycleId, input.sendId);
  if (!canApproveSend(user, input.tenantId, send.approver_user_id)) {
    throw new ForbiddenError('Only the assigned approver or an administrator can skip this request');
  }
  assertActionable(cycle, send);
  const now = nowIso();
  const res = await db
    .prepare(
      `UPDATE renewal_request_sends
          SET status = 'skipped', skipped_by = ?, skipped_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('pending', 'failed')`,
    )
    .bind(user.id, now, now, send.id)
    .run();
  if ((res.meta?.changes ?? 0) !== 1) throw new ConflictError('This draft was already handled.');
  await audit(
    db,
    user.id,
    input.tenantId,
    'renewal_request.skipped',
    cycle.id,
    { send_id: send.id, stage: send.stage, document_id: cycle.document_id, supplier_id: cycle.supplier_id },
    input.ip,
  );
}

export { isRenewalRequestStage };
