/**
 * The sharing rule, read from the database (decision C-003, migration 0137).
 *
 * The rule itself -- three words, where each comes from, which exits it passes
 * -- is pure and lives in shared/sharingRule.ts. This file is the part that
 * needs D1: what rule each of these documents has RIGHT NOW, whether this
 * person may release a `qa` document, and which documents sit on one shared
 * file (a packet, a whole multi-lot certificate).
 *
 * EVERY EXIT CALLS `judgeDocumentsForExit`. It is the one place a list of
 * document ids becomes "these may go, these may not, and here is why", so a
 * refusal reads the same on a ZIP, a send, a bundle and an order, and a new
 * exit that forgets to ask is caught by tests/unit/exitRegister.test.ts.
 *
 * READ AT THE MOMENT OF THE EXIT, never cached on the thing leaving: a
 * document locked this morning must not ride out this afternoon on a plan, a
 * link or a resend that was made yesterday.
 */

import {
  describeRefusals,
  effectiveSharingRule,
  judgeExit,
  sharingRefusalMessage,
  strictest,
  type ExitActor,
  type SharingExit,
  type SharingRule,
  type SharingRuleSource,
} from '../../shared/sharingRule';
import { parseSharingRule } from '../../shared/sharingRule';
import type {
  DocumentSharingInfo,
  SharingRefusal,
  SharingRuleRefusedResponse,
} from '../../shared/types';
import { logAudit } from './db';
import { normalizeOwnerKey } from './alert-routing';
import { loadMasterUser } from './renewal-requests';
import type { User } from './types';

/**
 * The owner label whose route names the people who release `qa` documents.
 * The same lane expired-on-arrival notifies (shared/expiredOnArrival.ts); it
 * is repeated here rather than imported so that renaming one feature's label
 * cannot silently move who may release documents.
 */
export const QA_RELEASE_OWNER_LABEL = 'QA';

export interface DocumentSharingRule {
  document_id: string;
  title: string;
  document_type_id: string | null;
  document_type_name: string | null;
  rule: SharingRule;
  source: SharingRuleSource;
}

const IN_CHUNK = 80;

function chunk<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The effective rule of each document, TENANT SCOPED. An id that is not this
 * organization's document is simply absent from the map -- and a caller must
 * treat absent as "may not go" (`judgeDocumentsForExit` does).
 */
export async function loadSharingRules(
  db: D1Database,
  tenantId: string,
  documentIds: string[],
): Promise<Map<string, DocumentSharingRule>> {
  const out = new Map<string, DocumentSharingRule>();
  const ids = [...new Set(documentIds.filter((id) => typeof id === 'string' && id))];
  for (const part of chunk(ids)) {
    const res = await db
      .prepare(
        `SELECT d.id                    AS document_id,
                d.title                 AS title,
                d.document_type_id      AS document_type_id,
                d.sharing_rule_override AS override_rule,
                dt.id                   AS type_row_id,
                dt.name                 AS type_name,
                dt.sharing_rule         AS type_rule
           FROM documents d
           LEFT JOIN document_types dt ON dt.id = d.document_type_id
          WHERE d.tenant_id = ? AND d.id IN (${part.map(() => '?').join(', ')})`,
      )
      .bind(tenantId, ...part)
      .all<{
        document_id: string;
        title: string | null;
        document_type_id: string | null;
        override_rule: string | null;
        type_row_id: string | null;
        type_name: string | null;
        type_rule: string | null;
      }>();
    for (const r of res.results ?? []) {
      // A type id that points at no row is no type: nothing says what the
      // document is.
      const eff = effectiveSharingRule({
        override: r.override_rule,
        typeRule: r.type_rule,
        typeName: r.type_name,
        hasType: Boolean(r.type_row_id),
      });
      out.set(r.document_id, {
        document_id: r.document_id,
        title: r.title ?? '',
        document_type_id: r.type_row_id,
        document_type_name: r.type_name,
        rule: eff.rule,
        source: eff.source,
      });
    }
  }
  return out;
}

/**
 * May this person release a `qa` document (C-040)?
 *
 *   - a super admin, or an org admin of this organization: always;
 *   - a read-only account: never, on any rung;
 *   - otherwise the ladder `resolveRenewalApprover` walks: a person on the
 *     `QA` owner route; and only when that route names nobody usable, the
 *     organization's master user.
 *
 * `resolveAlertRouting` cannot answer this for the reason it cannot name a
 * renewal approver: it returns addresses, and a releaser has to be an ACCOUNT.
 * So the route is read here for its user rows.
 */
export async function canReleaseQa(
  db: D1Database,
  user: Pick<User, 'id' | 'role' | 'tenant_id'>,
  tenantId: string,
): Promise<boolean> {
  if (user.role === 'super_admin') return true;
  if (user.tenant_id !== tenantId) return false;
  if (user.role === 'org_admin') return true;
  if (user.role === 'reader') return false;

  const key = normalizeOwnerKey(QA_RELEASE_OWNER_LABEL);
  let routed: string[] = [];
  try {
    const res = await db
      .prepare(
        `SELECT u.id
           FROM owner_routes r
           JOIN users u ON u.id = r.user_id
          WHERE r.tenant_id = ? AND r.owner_key = ? AND r.active = 1
            AND u.active = 1 AND u.tenant_id = r.tenant_id AND u.role != 'reader'`,
      )
      .bind(tenantId, key)
      .all<{ id: string }>();
    routed = (res.results ?? []).map((r) => r.id);
  } catch (err) {
    // No route table, no route: fall to the next rung rather than open a door.
    console.error('[sharing-rule] QA route lookup failed:', err instanceof Error ? err.message : String(err));
  }
  if (routed.length > 0) return routed.includes(user.id);

  try {
    const master = await loadMasterUser(db, tenantId);
    return Boolean(master && master.id === user.id);
  } catch {
    return false;
  }
}

/**
 * The actor of an authenticated request. `authMethod` is what
 * functions/api/_middleware.ts recorded; an API key is never a releaser, so
 * the route is not even read for one.
 */
export async function exitActorForRequest(
  db: D1Database,
  data: Record<string, unknown>,
  user: Pick<User, 'id' | 'role' | 'tenant_id'>,
  tenantId: string,
): Promise<ExitActor> {
  if (data.authMethod === 'api_key') return { method: 'api_key', canReleaseQa: false };
  return { method: 'jwt', canReleaseQa: await canReleaseQa(db, user, tenantId) };
}

/** The recipient of a public export link: no account. */
export const LINK_ACTOR: ExitActor = { method: 'link', canReleaseQa: false };

export interface ExitJudgement {
  /** Ids that may go, in the order asked. */
  allowed: string[];
  /** Ids that may not, each with its reason. Never silently dropped. */
  refused: SharingRefusal[];
  /**
   * `qa` documents among `allowed` that pass ONLY because the actor is a QA
   * releaser. Their going is the approval, and the caller audits it as one.
   */
  qa_released: string[];
  rules: Map<string, DocumentSharingRule>;
}

/**
 * Judge a list of documents for one exit.
 *
 * An id with no rule row (another organization's, or gone) is NOT judged
 * here: it is left out of both lists, because every exit already reports
 * those as missing and a second, different refusal for the same id would
 * tell the caller that a document it may not know about exists.
 */
export async function judgeDocumentsForExit(
  db: D1Database,
  tenantId: string,
  documentIds: string[],
  exit: SharingExit,
  actor: ExitActor,
): Promise<ExitJudgement> {
  const rules = await loadSharingRules(db, tenantId, documentIds);
  const allowed: string[] = [];
  const refused: SharingRefusal[] = [];
  const qaReleased: string[] = [];
  const seen = new Set<string>();
  for (const id of documentIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const r = rules.get(id);
    if (!r) continue;
    const verdict = judgeExit(r.rule, exit, actor);
    if (verdict === 'allow') {
      allowed.push(id);
      if (r.rule === 'qa' && actor.method === 'jwt' && exit !== 'portal_file') qaReleased.push(id);
    } else {
      refused.push(refusalFor(r, verdict, actor));
    }
  }
  return { allowed, refused, qa_released: qaReleased, rules };
}

export function refusalFor(
  r: Pick<DocumentSharingRule, 'document_id' | 'title' | 'document_type_name' | 'rule'>,
  reason: 'needs_qa' | 'locked',
  actor: ExitActor,
): SharingRefusal {
  return {
    document_id: r.document_id,
    title: r.title,
    document_type_name: r.document_type_name,
    rule: r.rule,
    reason,
    message: sharingRefusalMessage(reason, { apiKey: actor.method === 'api_key' }),
  };
}

// ---------------------------------------------------------------------------
// One file, several documents (C-042)
// ---------------------------------------------------------------------------

/**
 * Every document of this organization with a version split out of this packet
 * (migration 0126). Deleted documents count: a part that was deleted is still
 * on the packet's pages.
 */
export async function documentsCitingPacket(
  db: D1Database,
  tenantId: string,
  packetQueueId: string,
): Promise<string[]> {
  const res = await db
    .prepare(
      `SELECT DISTINCT d.id
         FROM document_versions dv
         INNER JOIN documents d ON d.id = dv.document_id
        WHERE d.tenant_id = ? AND dv.source_packet_queue_id = ?`,
    )
    .bind(tenantId, packetQueueId)
    .all<{ id: string }>();
  return (res.results ?? []).map((r) => r.id);
}

/**
 * Every document of this organization born from this Review Queue item: the
 * per-lot pages cut from one multi-lot certificate (`origin_queue_id`, 0130,
 * or the queue id inside `external_ref`).
 */
export async function documentsFromQueueItem(
  db: D1Database,
  tenantId: string,
  queueId: string,
): Promise<string[]> {
  const res = await db
    .prepare(
      `SELECT id FROM documents
        WHERE tenant_id = ?
          AND (origin_queue_id = ?
               OR external_ref = 'queue-' || ?
               OR external_ref LIKE 'queue-' || ? || '-%')`,
    )
    .bind(tenantId, queueId, queueId, queueId)
    .all<{ id: string }>();
  return (res.results ?? []).map((r) => r.id);
}

export interface SharedFileJudgement {
  rule: SharingRule;
  verdict: 'allow' | 'needs_qa' | 'locked';
  document_ids: string[];
}

/**
 * The verdict for ONE file that holds several documents: the strictest rule of
 * the documents on it. No documents at all is `locked` (see `strictest`).
 */
export async function judgeSharedFile(
  db: D1Database,
  tenantId: string,
  documentIds: string[],
  exit: SharingExit,
  actor: ExitActor,
): Promise<SharedFileJudgement> {
  const rules = await loadSharingRules(db, tenantId, documentIds);
  const rule = strictest([...rules.values()].map((r) => r.rule));
  return { rule, verdict: judgeExit(rule, exit, actor), document_ids: [...rules.keys()] };
}

// ---------------------------------------------------------------------------
// One document's rule, for the document page
// ---------------------------------------------------------------------------

function isAdminOf(user: Pick<User, 'role' | 'tenant_id'>, tenantId: string): boolean {
  return user.role === 'super_admin' || (user.role === 'org_admin' && user.tenant_id === tenantId);
}

interface SharingRow {
  override_rule: string | null;
  override_by: string | null;
  override_at: string | null;
  override_reason: string | null;
  override_by_name: string | null;
  type_row_id: string | null;
  type_name: string | null;
  type_rule: string | null;
}

/**
 * The rule on one document, where it comes from, and what THIS caller may do
 * about it. Null when the document is not this organization's.
 */
export async function describeDocumentSharing(
  db: D1Database,
  user: Pick<User, 'id' | 'role' | 'tenant_id'>,
  tenantId: string,
  documentId: string,
): Promise<DocumentSharingInfo | null> {
  const row = await db
    .prepare(
      `SELECT d.sharing_rule_override        AS override_rule,
              d.sharing_rule_override_by     AS override_by,
              d.sharing_rule_override_at     AS override_at,
              d.sharing_rule_override_reason AS override_reason,
              u.name                         AS override_by_name,
              dt.id                          AS type_row_id,
              dt.name                        AS type_name,
              dt.sharing_rule                AS type_rule
         FROM documents d
         LEFT JOIN document_types dt ON dt.id = d.document_type_id
         LEFT JOIN users u ON u.id = d.sharing_rule_override_by
        WHERE d.id = ? AND d.tenant_id = ?`,
    )
    .bind(documentId, tenantId)
    .first<SharingRow>();
  if (!row) return null;

  const typeInput = { typeRule: row.type_rule, typeName: row.type_name, hasType: Boolean(row.type_row_id) };
  const withoutOverride = effectiveSharingRule(typeInput);
  const inForce = effectiveSharingRule({ ...typeInput, override: row.override_rule });
  const override = parseSharingRule(row.override_rule);
  return {
    rule: inForce.rule,
    source: inForce.source,
    type_rule: withoutOverride.rule,
    type_source: withoutOverride.source,
    override,
    override_by_name: override ? row.override_by_name ?? null : null,
    override_at: override ? row.override_at ?? null : null,
    override_reason: override ? row.override_reason ?? null : null,
    can_edit: await canReleaseQa(db, user, tenantId),
    can_unlock: isAdminOf(user, tenantId),
  };
}

export type SharingOverridePlan =
  | { ok: false; status: 400 | 403; error: string }
  | { ok: true; changed: false }
  | {
      ok: true;
      changed: true;
      override: SharingRule | null;
      reason: string;
      previous_override: SharingRule | null;
      previous_rule: SharingRule;
      next_rule: SharingRule;
    };

export type SharingOverrideChange = Extract<SharingOverridePlan, { changed: true }>;

/** A reason longer than this is a document, not a reason. */
export const SHARING_OVERRIDE_REASON_MAX = 500;

/**
 * Decide whether this person may set (or clear, with null) the override on
 * this document. Writes nothing.
 *
 *   - An admin or a QA releaser may set it; nobody else (C-040).
 *   - A REASON IS REQUIRED: the override is a person deciding against the
 *     type's rule, and the row has to say why.
 *   - MOVING A DOCUMENT OFF `locked` IS AN ADMIN'S ACT. "Nobody releases
 *     locked" would mean little if the person who may release `qa` could
 *     relabel a locked document `qa` and then release it.
 *   - Sending the value already in force is not a change and needs no reason:
 *     an editor that posts every field on save must not be refused.
 */
export async function planSharingOverride(
  db: D1Database,
  user: Pick<User, 'id' | 'role' | 'tenant_id'>,
  tenantId: string,
  documentId: string,
  rawOverride: unknown,
  rawReason: unknown,
): Promise<SharingOverridePlan> {
  let next: SharingRule | null;
  if (rawOverride === null || rawOverride === '') {
    next = null;
  } else {
    next = parseSharingRule(rawOverride);
    if (!next) {
      return { ok: false, status: 400, error: 'sharing_rule_override must be free, qa, locked or null' };
    }
  }

  const info = await describeDocumentSharing(db, user, tenantId, documentId);
  if (!info) return { ok: false, status: 400, error: 'Document not found' };
  if (next === info.override) return { ok: true, changed: false };

  if (!info.can_edit) {
    return {
      ok: false,
      status: 403,
      error: 'Only QA or an administrator can change how a document may be shared.',
    };
  }
  const nextRule = next ?? info.type_rule;
  if (info.rule === 'locked' && nextRule !== 'locked' && !info.can_unlock) {
    return {
      ok: false,
      status: 403,
      error: 'This document is locked. Only an administrator can unlock it.',
    };
  }
  const reason = typeof rawReason === 'string' ? rawReason.trim().slice(0, SHARING_OVERRIDE_REASON_MAX) : '';
  if (!reason) {
    return { ok: false, status: 400, error: 'Say why the sharing rule is being changed on this document.' };
  }
  return {
    ok: true,
    changed: true,
    override: next,
    reason,
    previous_override: info.override,
    previous_rule: info.rule,
    next_rule: nextRule,
  };
}

// ---------------------------------------------------------------------------
// Responses and audit rows every exit shares
// ---------------------------------------------------------------------------

/**
 * 403 for an exit the sharing rule left with NOTHING to hand over. The body
 * names every document and its reason.
 */
export function sharingRefusedResponse(refused: SharingRefusal[]): Response {
  // The sentence names every document under its reason, so a screen that
  // only prints `error` still says which documents and why.
  const body: SharingRuleRefusedResponse = {
    error: `Nothing was shared. ${describeRefusals(refused)}`,
    code: 'sharing_rule_refused',
    refused,
  };
  return new Response(JSON.stringify(body), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** `id:reason,id:reason` -- what a binary response can say in a header. */
export function refusedHeaderValue(refused: SharingRefusal[]): string {
  return refused.map((r) => `${r.document_id}:${r.reason}`).join(',');
}

/**
 * A QA releaser sending a `qa` document IS the approval (C-040), and it is
 * written down as one: who, which documents, through which exit. One row per
 * act, not per document. Never throws -- the audit must not undo a send that
 * already happened.
 */
export async function auditQaRelease(
  db: D1Database,
  args: {
    userId: string;
    tenantId: string;
    exit: SharingExit;
    documentIds: string[];
    resourceType: string;
    resourceId: string | null;
    clientIp: string | null;
  },
): Promise<void> {
  if (args.documentIds.length === 0) return;
  try {
    await logAudit(
      db,
      args.userId,
      args.tenantId,
      'document.qa_release_approved',
      args.resourceType,
      args.resourceId,
      JSON.stringify({
        exit: args.exit,
        document_ids: args.documentIds,
        document_count: args.documentIds.length,
        note: 'Sent by a QA releaser; the send is the approval.',
      }),
      args.clientIp,
    );
  } catch (err) {
    console.error('[sharing-rule] QA release audit failed:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * The one check behind every route that serves ONE file to an authenticated
 * caller (a document download, a packet original, a queue or arrival file
 * served from an approved document).
 *
 * A LOGGED-IN PERSON IS NOT ASKED (C-039): opening one file in the portal is
 * not leaving, and this returns null without reading anything. AN API KEY IS
 * (C-041): it reads the file only when the strictest rule of the documents on
 * it is `free`. Otherwise this returns the 403 to send back, and writes an
 * audit row -- a key reaching for a locked document is worth knowing about.
 *
 * `documentIds` is every document the file holds (C-042). An empty list is
 * refused for a key: a file tied to no document is unclassified.
 */
export async function apiKeyFileRefusal(
  db: D1Database,
  data: Record<string, unknown>,
  args: {
    user: Pick<User, 'id'>;
    tenantId: string;
    documentIds: string[];
    /** What was being read, for the audit row. */
    route: string;
    clientIp: string | null;
  },
): Promise<Response | null> {
  if (data.authMethod !== 'api_key') return null;
  const actor: ExitActor = { method: 'api_key', canReleaseQa: false };
  const judged = await judgeSharedFile(db, args.tenantId, args.documentIds, 'portal_file', actor);
  if (judged.verdict === 'allow') return null;

  try {
    await logAudit(
      db,
      args.user.id,
      args.tenantId,
      'document.sharing_rule_refused',
      'document',
      args.documentIds[0] ?? null,
      JSON.stringify({
        via: 'api_key',
        api_key_id: typeof data.apiKeyId === 'string' ? data.apiKeyId : null,
        route: args.route,
        rule: judged.rule,
        reason: judged.verdict,
        document_ids: args.documentIds,
      }),
      args.clientIp,
    );
  } catch {
    // The refusal stands whether or not it could be written down.
  }
  return new Response(
    JSON.stringify({
      error: sharingRefusalMessage(judged.verdict, { apiKey: true }),
      code: 'sharing_rule_refused',
      rule: judged.rule,
      reason: judged.verdict,
    }),
    { status: 403, headers: { 'Content-Type': 'application/json' } },
  );
}
