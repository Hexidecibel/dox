/**
 * QA's half of a document order (migration 0138, decision C-044): releasing or
 * refusing a document that was held because the person who sent the order
 * could not approve it.
 *
 * WHO. A QA releaser (`canReleaseQa`, C-040) signed in to the portal. NEVER an
 * API key, whoever it belongs to (C-041: a key reads `free` only, and
 * releasing is the opposite of that), and never a read-only account.
 *
 * A RELEASE IS PINNED TO WHAT QA SAW (C-060). The request names each line WITH
 * the document, the version and the asking send that were on the screen, and
 * the claim carries all three in its WHERE. A line id alone is not enough: the
 * first cut claimed on the id and the status, so a line refreshed to a newer
 * document and sent again was released as "the same line" with a document QA
 * never opened. A mismatch is stated for that line ("changed since you opened
 * it") and nothing of it is released.
 *
 * WHAT IS RELEASED IS THE DOCUMENT ON THE LINE. Nothing is re-resolved here.
 * If that document is no longer active, has expired, or has been LOCKED since,
 * the release is refused with the reason and the line stays where it is -- a
 * release is never a way around a rule that tightened while the line waited.
 *
 * THE RULE IS ASKED OF THE RELEASER, NOW, through the same gate every other
 * exit uses (`loadExportDocuments`, exit `order_send`). The line's stored
 * `rule_at_resolve` is not read.
 *
 * THE LINK IS MINTED IN THE RELEASER'S NAME (C-045). A public link serves a
 * `qa` document only while the person who minted it may release QA documents,
 * checked at every read. A link minted in the salesperson's name would serve
 * nothing the moment it was opened.
 *
 * WHO IT IS MAILED TO was settled when the order was sent: the recipients of
 * the send that put the line in front of QA, read from that send's stored
 * record. A line already waiting is never re-pointed at a later send
 * (`markLinesPendingQa`), and the claim checks the asking send is still the
 * one QA was shown.
 *
 * ONE MAIL FOR ONE ACT. Lines released together and bound for the same
 * recipients share one link and one email. One release covers at most as many
 * documents as one link (50); more is refused with the number, never split
 * silently and never truncated.
 *
 * THREE STATES, NOT TWO (C-063). pending_qa -> `releasing` (the claim) ->
 * `released` (only after the mail went AND the record was written). A Worker
 * that dies between the claim and the record leaves the line `releasing`,
 * which every screen reads as "release did not finish" and never as sent; a
 * releaser can release it again or put it back, and either first withdraws
 * whatever link the unfinished attempt minted. The `order_sends` row is
 * written as "outcome not recorded" immediately BEFORE the mail is handed to
 * the provider, so it can never read `failed` while a customer holds the link.
 */

import { generateId, logAudit } from './db';
import { sendEmailDetailed, viaSenderName } from './email';
import {
  EXPORT_MAX_DOCUMENTS,
  exportFileNames,
  exportLinkUrl,
  externalDocumentTitle,
  loadExportDocuments,
  mintExportLink,
  revokeExportLink,
} from './document-export';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from './permissions';
import { auditQaRelease, canReleaseQa } from './sharing-rule';
import {
  loadJudgedLinesById,
  loadOrderDocumentRow,
  releaseBlockedReason,
  type JudgedOrderDocument,
  type OrderDocumentRow,
} from './order-documents';
import {
  buildOrderDocumentsEmail,
  loadOrderSends,
  markOrderDeliveredIfEverythingTravelled,
  ORDER_SEND_MAX_SUBJECT_CHARS,
} from './order-send';
import { notifyRequesterOfDecision, type RequesterNoticeLine } from './order-document-notices';
import type { OrderWriteRow } from './order-items';
import {
  ORDER_DOCUMENT_LINK_DAYS,
  ORDER_DOCUMENT_REFUSE_NOTE_MAX,
  releaseIsStuck,
} from '../../shared/orderDocuments';
import type { ExitActor } from '../../shared/sharingRule';
import type {
  OrderDocumentReleaseTarget,
  OrderDocumentsReleaseResponse,
  OrderSendSummary,
} from '../../shared/types';
import type { User } from './types';

/**
 * Lines one release may name: what one link carries. Past it the release is
 * REFUSED with both numbers and nothing is released.
 */
export const ORDER_DOCUMENT_RELEASE_MAX = EXPORT_MAX_DOCUMENTS;

/** Ids per statement. D1 binds at most 100. */
const IN_CHUNK = 80;

const CHANGED =
  'This document line changed since you opened it, so nothing was released. Reload the list and look at it again.';

/**
 * How long a release waits for the mail provider. Far under the five minutes
 * after which a `releasing` line is treated as unfinished, so "mid-release for
 * more than five minutes" can never be a mail call still in flight. A release
 * mails one small message with a link and no attachment; a minute is generous.
 */
export const RELEASE_MAIL_TIMEOUT_MS = 60 * 1000;

/** What a release record says while its email's outcome is not yet written down. */
export const RELEASE_OUTCOME_UNRECORDED =
  'The email was handed to the mail provider and its outcome was not recorded. This release did not finish.';

function chunk<T>(items: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The actor of a release or a refusal, or a thrown 403. An API key is refused
 * before the QA route is even read.
 */
export async function requireQaReleaser(
  db: D1Database,
  data: Record<string, unknown>,
  user: Pick<User, 'id' | 'role' | 'tenant_id'>,
  tenantId: string,
): Promise<ExitActor> {
  if (data.authMethod === 'api_key') {
    throw new ForbiddenError('An API key cannot release or refuse a document. A person on the QA route does that, signed in.');
  }
  if (!(await canReleaseQa(db, user, tenantId))) {
    throw new ForbiddenError('Only QA or an administrator can release or refuse a document that needs QA approval.');
  }
  return { method: 'jwt', canReleaseQa: true };
}

export interface ReleaseContext {
  db: D1Database;
  /** The mail provider key. The route answers 503 before calling without one. */
  apiKey: string;
  origin: string;
  tenantName: string;
  order: OrderWriteRow;
  user: Pick<User, 'id' | 'name' | 'email' | 'role'>;
  actor: ExitActor;
  clientIp: string | null;
}

function requesterLine(l: JudgedOrderDocument): RequesterNoticeLine {
  return {
    requested_by: l.row.pending_requested_by,
    document_type_name: l.api.document_type_name,
    document_title: l.api.document_title,
    product_name: l.api.product_name,
    supplier_name: l.api.supplier_name,
  };
}

function recipientsKey(list: string[]): string {
  return [...list].map((a) => a.trim().toLowerCase()).sort().join('|');
}

/** The targets a request names: every one must say what QA saw. */
export function parseReleaseTargets(raw: unknown): OrderDocumentReleaseTarget[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: OrderDocumentReleaseTarget[] = [];
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue;
    const t = v as Record<string, unknown>;
    const id = typeof t.id === 'string' ? t.id.trim() : '';
    if (!id || seen.has(id)) continue;
    if (typeof t.document_id !== 'string' || !t.document_id || typeof t.pending_send_id !== 'string' || !t.pending_send_id) {
      throw new BadRequestError(
        'Each line to release must name the document, its version and the send that asked (document_id, version_number, pending_send_id), as the waiting list returned them.',
      );
    }
    const version = Number(t.version_number);
    if (!Number.isInteger(version)) {
      throw new BadRequestError('Each line to release must name the version_number of the document that was reviewed.');
    }
    seen.add(id);
    out.push({ id, document_id: t.document_id, version_number: version, pending_send_id: t.pending_send_id });
  }
  return out;
}

async function updateLines(
  db: D1Database,
  sql: (idSql: string) => string,
  before: (string | number | null)[],
  lineIds: string[],
  after: (string | number | null)[] = [],
): Promise<void> {
  for (const part of chunk(lineIds)) {
    await db
      .prepare(sql(part.map(() => '?').join(', ')))
      .bind(...before, ...part, ...after)
      .run();
  }
}

/**
 * Undo a release that did not finish: withdraw every link it minted, say so on
 * its record, and put its lines back in front of QA. Safe to call for a
 * release whose mail DID go -- the customer then holds a link that no longer
 * opens, and the release that follows gives them one that does; the record
 * says which is which.
 */
export async function recoverUnfinishedRelease(
  db: D1Database,
  order: Pick<OrderWriteRow, 'id' | 'tenant_id' | 'order_number'>,
  rows: Pick<OrderDocumentRow, 'id' | 'release_send_id'>[],
  userId: string,
  clientIp: string | null,
): Promise<void> {
  const sendIds = [...new Set(rows.map((r) => r.release_send_id).filter((id): id is string => Boolean(id)))];
  const undoer = await db.prepare('SELECT name, email FROM users WHERE id = ?').bind(userId).first<{ name: string | null; email: string | null }>();
  const undoneBy = undoer?.name || undoer?.email || 'another user';
  for (const sendId of sendIds) {
    const send = await db
      .prepare(`SELECT id, status FROM order_sends WHERE id = ? AND tenant_id = ? AND order_id = ? AND kind = 'qa_release'`)
      .bind(sendId, order.tenant_id, order.id)
      .first<{ id: string; status: string }>();
    // A release that was recorded as sent is not unfinished, whatever a line says.
    if (!send || send.status === 'sent') continue;
    const links = await db
      .prepare('SELECT DISTINCT export_link_id AS id FROM order_send_files WHERE send_id = ? AND export_link_id IS NOT NULL')
      .bind(sendId)
      .all<{ id: string }>();
    for (const l of links.results ?? []) await revokeExportLink(db, l.id, userId);
    await db
      .prepare(`UPDATE order_sends SET status = 'failed', parts = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(
        JSON.stringify([
          {
            part_number: 1,
            ok: false,
            status: 0,
            error: `This release did not finish. ${undoneBy} put it back: its link was withdrawn and the documents are in the waiting list again.`,
            sent_at: null,
            attempts: 1,
            code: 'undone',
            undone_by_name: undoneBy,
          },
        ]),
        sendId,
      )
      .run();
    // Every line of that release, not only the ones named.
    await db
      .prepare(
        `UPDATE order_documents
            SET release_status = 'pending_qa', releasing_at = NULL, release_send_id = NULL,
                decided_by = NULL, decided_at = NULL, updated_at = datetime('now')
          WHERE tenant_id = ? AND order_id = ? AND release_status = 'releasing' AND release_send_id = ?`,
      )
      .bind(order.tenant_id, order.id, sendId)
      .run();
  }
  // Lines claimed before any record was written.
  await updateLines(
    db,
    (idSql) =>
      `UPDATE order_documents
          SET release_status = 'pending_qa', releasing_at = NULL, release_send_id = NULL,
              decided_by = NULL, decided_at = NULL, updated_at = datetime('now')
        WHERE tenant_id = ? AND order_id = ? AND release_status = 'releasing' AND id IN (${idSql})`,
    [order.tenant_id, order.id],
    rows.map((r) => r.id),
  );
  try {
    await logAudit(
      db,
      userId,
      order.tenant_id,
      'order.documents_release_recovered',
      'order',
      order.id,
      JSON.stringify({ order_number: order.order_number, order_document_ids: rows.map((r) => r.id), release_send_ids: sendIds }),
      clientIp,
    );
  } catch {
    // The lines and the record already say what happened.
  }
}

/**
 * The order is delivered once QA's release was the last thing outstanding.
 * THE SAME QUESTION THE SEND PATH ASKS (C-093, `everyOrderLineTravelled`):
 * every COA line's certificate went on some successful send, and no document
 * line is still waiting, missing, expired, locked, held or refused.
 *
 * It used to ask whether everything went on the LATEST send, so an order whose
 * certificates went on one send and whose document lines were asked of QA on a
 * later one stayed undelivered for good after QA released them.
 */
async function markDeliveredAfterRelease(db: D1Database, order: OrderWriteRow): Promise<string> {
  if (order.status === 'delivered') return order.status;
  return (await markOrderDeliveredIfEverythingTravelled(db, order.tenant_id, order.id)) ?? order.status;
}

/**
 * Release the lines named. A line that cannot be released is REPORTED with its
 * reason and stays waiting; the rest still go. An id that is not a line of
 * this order is a 404 for the whole request -- it must not be possible to
 * learn that a line exists on somebody else's order.
 */
export async function releaseOrderDocuments(
  ctx: ReleaseContext,
  rawTargets: unknown,
): Promise<OrderDocumentsReleaseResponse> {
  const { db, order, user } = ctx;
  const targets = parseReleaseTargets(rawTargets);
  if (targets.length === 0) throw new BadRequestError('Choose at least one document to release.');
  if (targets.length > ORDER_DOCUMENT_RELEASE_MAX) {
    throw new BadRequestError(
      `One release covers at most ${ORDER_DOCUMENT_RELEASE_MAX} documents, because they leave on one link, and this is ${targets.length}. ` +
        'Nothing was released. Release them in smaller groups.',
    );
  }
  const targetById = new Map(targets.map((t) => [t.id, t]));

  let lines = await loadJudgedLinesById(db, order.tenant_id, order.id, [...targetById.keys()], ctx.actor);
  if (lines.length !== targets.length) throw new NotFoundError('Document line not found');

  const response: OrderDocumentsReleaseResponse = { released: [], refused: [], sends: [], order_status: order.status };
  const refuse = (line: JudgedOrderDocument, reason: string, code?: 'changed' | 'in_progress' | 'unfinished' | 'undone') =>
    response.refused.push({ order_document_id: line.row.id, reason, ...(code ? { code } : {}) });

  // 0. A release that did not finish is undone first (its link withdrawn, its
  //    lines back in the list); then those lines are released like any other.
  const unfinished = lines.filter((l) => l.row.release_status === 'releasing' && releaseIsStuck(l.row.releasing_at));
  if (unfinished.length > 0) {
    await recoverUnfinishedRelease(db, order, unfinished.map((l) => l.row), user.id, ctx.clientIp);
    lines = await loadJudgedLinesById(db, order.tenant_id, order.id, [...targetById.keys()], ctx.actor);
    if (lines.length !== targets.length) throw new NotFoundError('Document line not found');
  }

  // 1. What may even be considered, and whether it is still what QA saw.
  const eligible: JudgedOrderDocument[] = [];
  for (const line of lines) {
    const target = targetById.get(line.row.id)!;
    if (line.row.release_status === 'releasing') {
      refuse(line, 'This document is being released right now. Nothing was done.', 'in_progress');
      continue;
    }
    if (line.row.release_status !== 'pending_qa') {
      refuse(
        line,
        line.row.release_status === 'released'
          ? 'This document has already been released.'
          : line.row.release_status === 'refused'
            ? 'This document has already been refused.'
            : 'This document is not waiting for QA.',
      );
      continue;
    }
    if (
      line.row.document_id !== target.document_id ||
      line.row.pending_send_id !== target.pending_send_id ||
      Number(line.api.version_number) !== target.version_number
    ) {
      refuse(line, CHANGED, 'changed');
      continue;
    }
    const blocked = releaseBlockedReason(line, line.api.pending_recipients);
    if (blocked) {
      refuse(line, blocked);
      continue;
    }
    eligible.push(line);
  }

  // 2. THE GATE. The live rule, asked of the releaser, through the one loader
  //    every exit uses. A document locked since the line was added stops here.
  const gate = await loadExportDocuments(
    db,
    order.tenant_id,
    [...new Set(eligible.map((l) => l.row.document_id as string))],
    { exit: 'order_send', actor: ctx.actor },
  );
  const rowById = new Map(gate.rows.map((r) => [r.document_id, r]));
  const refusalById = new Map(gate.refused.map((r) => [r.document_id, r]));
  const passed: JudgedOrderDocument[] = [];
  for (const line of eligible) {
    const docId = line.row.document_id as string;
    const refusal = refusalById.get(docId);
    if (refusal) {
      refuse(line, refusal.message);
      continue;
    }
    const row = rowById.get(docId);
    if (!row || !row.r2_key) {
      refuse(line, 'The document has no file on record.');
      continue;
    }
    if (Number(row.version_number) !== targetById.get(line.row.id)!.version_number) {
      refuse(line, CHANGED, 'changed');
      continue;
    }
    passed.push(line);
  }

  // 3. THE CLAIM, AGAINST WHAT QA SAW. Only a line still waiting, still
  //    holding that document at that version, still asked for by that send.
  const claimed: JudgedOrderDocument[] = [];
  for (const line of passed) {
    const target = targetById.get(line.row.id)!;
    const res = await db
      .prepare(
        `UPDATE order_documents
            SET release_status = 'releasing', releasing_at = datetime('now'), release_send_id = NULL,
                decided_by = ?, decided_at = NULL, decision_note = NULL, updated_at = datetime('now')
          WHERE id = ? AND order_id = ? AND tenant_id = ? AND release_status = 'pending_qa'
            AND document_id = ? AND pending_send_id = ?
            AND EXISTS (SELECT 1 FROM documents d
                         WHERE d.id = order_documents.document_id AND d.tenant_id = order_documents.tenant_id
                           AND d.current_version = ?)`,
      )
      .bind(user.id, line.row.id, order.id, order.tenant_id, target.document_id, target.pending_send_id, target.version_number)
      .run();
    if ((res.meta?.changes ?? 0) > 0) claimed.push(line);
    else refuse(line, CHANGED, 'changed');
  }
  if (claimed.length === 0) return response;

  // 4. One link and one mail per distinct set of recipients.
  const groups = new Map<string, { recipients: string[]; lines: JudgedOrderDocument[]; sendIds: string[] }>();
  for (const line of claimed) {
    const recipients = line.api.pending_recipients;
    const key = recipientsKey(recipients);
    const g = groups.get(key) ?? { recipients, lines: [], sendIds: [] };
    g.lines.push(line);
    const asked = line.row.pending_send_id as string;
    if (!g.sendIds.includes(asked)) g.sendIds.push(asked);
    groups.set(key, g);
  }

  /** Put claimed lines back in front of QA: nothing of theirs left. */
  const giveBack = async (lineIds: string[]): Promise<void> => {
    await updateLines(
      db,
      (idSql) =>
        `UPDATE order_documents
            SET release_status = 'pending_qa', releasing_at = NULL, release_send_id = NULL,
                decided_by = NULL, decided_at = NULL, updated_at = datetime('now')
          WHERE tenant_id = ? AND order_id = ? AND release_status = 'releasing' AND decided_by = ?
            AND id IN (${idSql})`,
      [order.tenant_id, order.id, user.id],
      lineIds,
    );
  };

  const qaDocs = new Set(gate.qa_released_ids);
  const producedSendIds: string[] = [];
  const releasedGroups: { recipients: string[]; lines: JudgedOrderDocument[] }[] = [];

  for (const g of groups.values()) {
    const docIds = [...new Set(g.lines.map((l) => l.row.document_id as string))];
    const rows = docIds.map((id) => rowById.get(id)!);
    const names = exportFileNames(rows);
    const lineIds = g.lines.map((l) => l.row.id);
    const sendId = generateId();
    let mintedLinkId: string | null = null;
    let mailed = false;
    /** The message was handed to the mail call. From here "nothing was sent" is not ours to say. */
    let handedOver = false;
    try {
      // The salesperson is who the customer has been talking to, so replies go
      // to the person who sent the order -- while that account still exists.
      const askedSendId = g.sendIds[g.sendIds.length - 1];
      const asked = await db
        .prepare('SELECT sent_by, subject FROM order_sends WHERE id = ? AND tenant_id = ?')
        .bind(askedSendId, order.tenant_id)
        .first<{ sent_by: string; subject: string }>();
      const requester = asked
        ? await db
            .prepare('SELECT id, name, email, active FROM users WHERE id = ?')
            .bind(asked.sent_by)
            .first<{ id: string; name: string | null; email: string; active: number }>()
        : null;
      const replyTo = requester && requester.active ? requester : { name: user.name, email: user.email };
      const subject = `${asked?.subject ?? `Documents for order ${order.order_number}`} - additional documents`.slice(
        0,
        ORDER_SEND_MAX_SUBJECT_CHARS,
      );

      // The record, at `failed` with nothing attempted: it under-claims.
      await db
        .prepare(
          `INSERT INTO order_sends
             (id, tenant_id, order_id, order_number, customer_id, customer_name, sent_by,
              recipients, subject, message, part_count, parts, status, kind)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, '[]', 'failed', 'qa_release')`,
        )
        .bind(
          sendId,
          order.tenant_id,
          order.id,
          order.order_number,
          order.customer_id,
          order.customer_name,
          user.id,
          JSON.stringify(g.recipients),
          subject,
        )
        .run();
      producedSendIds.push(sendId);
      // The lines know which release they are in, so one that does not finish
      // can be found and undone.
      await updateLines(
        db,
        (idSql) =>
          `UPDATE order_documents SET release_send_id = ?
            WHERE tenant_id = ? AND order_id = ? AND release_status = 'releasing' AND id IN (${idSql})`,
        [sendId, order.tenant_id, order.id],
        lineIds,
      );

      // Minted in the RELEASER's name: the link's authority to serve a document
      // that needs QA approval is theirs (C-045).
      const link = await mintExportLink(db, {
        tenantId: order.tenant_id,
        documentIds: docIds,
        createdBy: user.id,
        recipients: g.recipients,
        onBehalfOf: null,
        message: null,
        ttlDays: ORDER_DOCUMENT_LINK_DAYS,
      });
      mintedLinkId = link.id;

      // The files carry the link id from the start, so an unfinished release
      // can withdraw it.
      const fileStmts = rows.map((row, i) =>
        db
          .prepare(
            `INSERT INTO order_send_files
               (id, send_id, tenant_id, position, document_id, version_number, document_ids,
                document_title, lot_label, file_name, bytes, part_number, delivery, source, source_queue_id,
                order_document_ids, link_days, export_link_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'link', 'document', NULL, ?, ?, ?)`,
          )
          .bind(
            generateId(),
            sendId,
            order.tenant_id,
            i,
            row.document_id,
            row.version_number,
            JSON.stringify([row.document_id]),
            externalDocumentTitle(row),
            row.lot_label,
            names[i],
            Number(row.file_size) || 0,
            JSON.stringify(g.lines.filter((l) => l.row.document_id === row.document_id).map((l) => l.row.id)),
            ORDER_DOCUMENT_LINK_DAYS,
            link.id,
          ),
      );
      for (const part of chunk(fileStmts, 50)) await db.batch(part);

      const email = buildOrderDocumentsEmail({
        tenantName: ctx.tenantName,
        senderName: replyTo.name || replyTo.email,
        senderEmail: replyTo.email,
        orderNumber: order.order_number,
        poNumber: order.po_number,
        shipDate: order.ship_date,
        message: null,
        partNumber: 1,
        partCount: 1,
        attached: [],
        linked: [],
        linkUrl: null,
        documents: rows.map((row, i) => ({
          file_name: names[i],
          document_title: externalDocumentTitle(row),
          lot_label: row.lot_label,
        })),
        documentsLinkUrl: exportLinkUrl(ctx.origin, link.token),
        documentsLinkDays: ORDER_DOCUMENT_LINK_DAYS,
      });

      // FROM HERE THE CUSTOMER MAY HOLD THE LINK. The record stops saying
      // "failed" before the mail is handed over: if nothing more is ever
      // written, it reads "outcome not recorded", which is the truth.
      await db
        .prepare(`UPDATE order_sends SET status = 'partial', parts = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(
          JSON.stringify([
            { part_number: 1, ok: false, status: 0, error: RELEASE_OUTCOME_UNRECORDED, sent_at: null, attempts: 1, code: 'unrecorded' },
          ]),
          sendId,
        )
        .run();

      handedOver = true;
      const outcome = await sendEmailDetailed(ctx.apiKey, {
        to: g.recipients,
        subject,
        html: email.html,
        replyTo: replyTo.email,
        fromName: viaSenderName(ctx.tenantName),
        timeoutMs: RELEASE_MAIL_TIMEOUT_MS,
      });

      if (!outcome.ok && outcome.timedOut) {
        // THE PROVIDER DID NOT ANSWER IN TIME. That is not a refusal: the mail
        // may have gone. Nothing is undone and nothing is claimed -- the record
        // already says "outcome not recorded", the lines stay `releasing`, and
        // in five minutes a releaser can release again or put them back
        // (either withdraws this link first).
        mailed = true; // nothing below may say "nothing was sent"
        for (const line of g.lines) {
          refuse(
            line,
            'The mail provider did not answer in time, so it is not known whether the email went. This document shows as "release did not finish". ' +
              'In a few minutes it can be released again, which withdraws this link and sends a new one, or put back.',
            'unfinished',
          );
        }
        continue;
      }

      if (!outcome.ok) {
        // A refusal from the provider (a status) means nothing left. A request
        // that never completed (status 0) means WE DO NOT KNOW -- so the words
        // must not say "nothing was sent". Either way the link is withdrawn,
        // which makes whatever may have gone harmless, and the lines wait again.
        await revokeExportLink(db, link.id);
        mintedLinkId = null;
        await giveBack(lineIds);
        const unknown = outcome.status === 0;
        const error = unknown
          ? `The mail may not have been sent; the link was withdrawn.${outcome.error ? ` (${outcome.error})` : ''}`
          : outcome.error ?? 'The mail provider refused the message.';
        await db
          .prepare(`UPDATE order_sends SET status = 'failed', parts = ?, updated_at = datetime('now') WHERE id = ?`)
          .bind(
            JSON.stringify([{ part_number: 1, ok: false, status: outcome.status, error, sent_at: null, attempts: 1 }]),
            sendId,
          )
          .run();
        for (const line of g.lines) {
          refuse(
            line,
            unknown
              ? `${error} This document was not released and is still waiting.`
              : `The email could not be sent, so this document was not released. It is still waiting. (${error})`,
          );
        }
        try {
          await logAudit(
            db,
            user.id,
            order.tenant_id,
            'order.documents_release_failed',
            'order_send',
            sendId,
            JSON.stringify({ order_id: order.id, order_number: order.order_number, order_document_ids: lineIds, error }),
            ctx.clientIp,
          );
        } catch {
          // The send record says what happened.
        }
        continue;
      }

      mailed = true;
      // ONE TRANSACTION, AND ONLY IF THIS RELEASE IS STILL THIS RELEASE. The
      // record says sent and the lines say released together -- but each
      // statement is conditional on the record still being `partial` and every
      // line still being claimed by THIS release (`release_send_id`). While a
      // mail call is slow, somebody else may have put the release back
      // (revoking its link): the first cut then marked the record `sent` for a
      // dead link, unconditionally, and answered "released". Now nothing is
      // written, and the truth is said instead.
      const now = new Date().toISOString();
      const finish = async (): Promise<boolean> => {
        const stillOurs = `EXISTS (SELECT 1 FROM order_sends s WHERE s.id = ? AND s.status = 'sent')`;
        const stmts: D1PreparedStatement[] = [
          db
            .prepare(
              `UPDATE order_sends SET status = 'sent', parts = ?, updated_at = datetime('now')
                WHERE id = ? AND kind = 'qa_release' AND status = 'partial'
                  AND (SELECT COUNT(*) FROM order_documents od
                        WHERE od.tenant_id = ? AND od.order_id = ? AND od.release_send_id = ?
                          AND od.release_status = 'releasing') = ?`,
            )
            .bind(
              JSON.stringify([{ part_number: 1, ok: true, status: outcome.status, error: null, sent_at: now, attempts: 1 }]),
              sendId,
              order.tenant_id,
              order.id,
              sendId,
              lineIds.length,
            ),
          db.prepare(`UPDATE order_send_files SET sent_ok = 1 WHERE send_id = ? AND ${stillOurs}`).bind(sendId, sendId),
        ];
        for (const part of chunk(lineIds)) {
          stmts.push(
            db
              .prepare(
                `UPDATE order_documents
                    SET release_status = 'released', decided_at = datetime('now'), releasing_at = NULL,
                        export_link_id = ?, last_sent_at = datetime('now'), updated_at = datetime('now')
                  WHERE tenant_id = ? AND order_id = ? AND release_status = 'releasing' AND release_send_id = ?
                    AND ${stillOurs}
                    AND id IN (${part.map(() => '?').join(', ')})`,
              )
              .bind(link.id, order.tenant_id, order.id, sendId, sendId, ...part),
          );
        }
        const res = await db.batch(stmts);
        return (res[0]?.meta?.changes ?? 0) > 0;
      };
      let finished: boolean;
      try {
        finished = await finish();
      } catch {
        finished = await finish();
      }
      if (!finished) {
        // SOMEBODY ELSE UNDID THIS RELEASE WHILE ITS MAIL WAS GOING OUT. The
        // mail went; the link in it has been withdrawn. Say so, and by whom.
        const record = await db
          .prepare('SELECT parts FROM order_sends WHERE id = ?')
          .bind(sendId)
          .first<{ parts: string | null }>();
        let undoneBy = 'another user';
        try {
          const prior = JSON.parse(record?.parts ?? '[]') as Array<{ undone_by_name?: string }>;
          if (prior[0]?.undone_by_name) undoneBy = prior[0].undone_by_name;
        } catch {
          // Keep the default.
        }
        const error =
          `The email was sent, but ${undoneBy} put this release back while it was going out, and its link was withdrawn. ` +
          'The customer holds a link that no longer opens. The documents are waiting for QA again.';
        await revokeExportLink(db, link.id);
        await db
          .prepare(
            `UPDATE order_sends SET status = 'failed', parts = ?, updated_at = datetime('now')
              WHERE id = ? AND kind = 'qa_release' AND status != 'sent'`,
          )
          .bind(
            JSON.stringify([
              { part_number: 1, ok: false, status: outcome.status, error, sent_at: now, attempts: 1, code: 'undone', undone_by_name: undoneBy },
            ]),
            sendId,
          )
          .run();
        for (const line of g.lines) refuse(line, error, 'undone');
        try {
          await logAudit(
            db,
            user.id,
            order.tenant_id,
            'order.documents_release_undone',
            'order_send',
            sendId,
            JSON.stringify({ order_id: order.id, order_number: order.order_number, order_document_ids: lineIds, undone_by: undoneBy, mail_sent: true }),
            ctx.clientIp,
          );
        } catch {
          // The record says what happened.
        }
        continue;
      }
      response.released.push(...lineIds);
      releasedGroups.push({ recipients: g.recipients, lines: g.lines });

      try {
        await logAudit(
          db,
          user.id,
          order.tenant_id,
          'order.documents_released',
          'order_send',
          sendId,
          JSON.stringify({
            order_id: order.id,
            order_number: order.order_number,
            order_document_ids: lineIds,
            document_ids: docIds,
            versions: Object.fromEntries(rows.map((r) => [r.document_id, r.version_number])),
            asking_send_ids: g.sendIds,
            recipients: g.recipients,
            export_link_id: link.id,
            link_days: ORDER_DOCUMENT_LINK_DAYS,
            requested_by: asked?.sent_by ?? null,
          }),
          ctx.clientIp,
        );
      } catch {
        // The send record says what happened.
      }
      await auditQaRelease(db, {
        userId: user.id,
        tenantId: order.tenant_id,
        exit: 'order_send',
        documentIds: docIds.filter((id) => qaDocs.has(id)),
        resourceType: 'order_send',
        resourceId: sendId,
        clientIp: ctx.clientIp,
      });
    } catch (err) {
      console.error('[order-document-release] release failed:', err instanceof Error ? err.message : String(err));
      if (!mailed) {
        // Before the hand-over nothing left the portal. After it, we do not
        // know -- and the words say so. Either way the link is withdrawn.
        const what = handedOver
          ? 'The mail may not have been sent; the link was withdrawn.'
          : 'The release could not be completed. Nothing was sent.';
        try {
          if (mintedLinkId) await revokeExportLink(db, mintedLinkId);
          await giveBack(lineIds);
          await db
            .prepare(
              `UPDATE order_sends SET status = 'failed', parts = ?, updated_at = datetime('now')
                WHERE id = ? AND kind = 'qa_release'`,
            )
            .bind(
              JSON.stringify([
                { part_number: 1, ok: false, status: 0, error: what, sent_at: null, attempts: 1 },
              ]),
              sendId,
            )
            .run();
        } catch (inner) {
          console.error('[order-document-release] giving lines back failed:', inner instanceof Error ? inner.message : String(inner));
        }
        for (const line of g.lines) {
          if (!response.refused.some((r) => r.order_document_id === line.row.id)) {
            refuse(
              line,
              handedOver
                ? `${what} This document is still waiting. Try again.`
                : 'The release could not be completed, so this document is still waiting. Try again.',
            );
          }
        }
      } else if (!response.released.includes(lineIds[0])) {
        // THE MAIL WENT AND THE RECORD COULD NOT BE WRITTEN. Nothing here
        // pretends otherwise: the lines stay `releasing` (shown as "release
        // did not finish", never as sent), the record stays "outcome not
        // recorded", and the releaser is told exactly that.
        for (const line of g.lines) {
          refuse(
            line,
            'The email was sent, but the record of it could not be written. This document shows as "release did not finish". ' +
              'Releasing it again withdraws the link that went and sends a new one.',
            'unfinished',
          );
        }
      }
    }
  }

  if (response.released.length > 0) response.order_status = await markDeliveredAfterRelease(db, order);
  // THE PERSON WHO ASKED IS TOLD (C-070): one internal mail per act, per
  // set of recipients -- never an outside address, never the releaser.
  for (const g of releasedGroups) {
    const told = await notifyRequesterOfDecision(db, ctx.apiKey, {
      tenantId: order.tenant_id,
      tenantName: ctx.tenantName,
      appUrl: ctx.origin,
      order: { id: order.id, order_number: order.order_number, customer_name: order.customer_name },
      actor: { id: user.id, name: user.name ?? null, email: user.email },
      decision: 'released',
      recipients: g.recipients,
      lines: g.lines.map(requesterLine),
      clientIp: ctx.clientIp,
    });
    if (told) {
      response.requester_notice = {
        sent: (response.requester_notice?.sent ?? false) || told.sent,
        recipients: [...(response.requester_notice?.recipients ?? []), ...told.recipients],
      };
    }
  }
  if (producedSendIds.length > 0) {
    const sends = await loadOrderSends(db, user, { tenantId: order.tenant_id, orderId: order.id });
    const wanted = new Set(producedSendIds);
    response.sends = sends.filter((s: OrderSendSummary) => wanted.has(s.id));
  }
  return response;
}

/**
 * Put a release that did not finish back in the waiting list, without
 * releasing it. Only a line `releasing` for longer than a release takes.
 */
export async function giveBackUnfinishedRelease(
  db: D1Database,
  args: { order: OrderWriteRow; lineId: string; user: Pick<User, 'id'>; clientIp: string | null },
): Promise<void> {
  const row = await loadOrderDocumentRow(db, args.order, args.lineId);
  if (row.release_status !== 'releasing') {
    throw new ConflictError('This document is not in the middle of a release.');
  }
  if (!releaseIsStuck(row.releasing_at)) {
    throw new ConflictError('This document is being released right now. Give it a few minutes before putting it back.');
  }
  await recoverUnfinishedRelease(db, args.order, [row], args.user.id, args.clientIp);
}

/**
 * QA says no to one waiting line, in words. The line stays on the order,
 * marked. Pinned to what QA saw, like a release: the document and the asking
 * send must still be the ones on the screen.
 */
export async function refuseOrderDocument(
  db: D1Database,
  args: {
    order: OrderWriteRow;
    lineId: string;
    user: Pick<User, 'id'>;
    note: unknown;
    documentId: unknown;
    pendingSendId: unknown;
    clientIp: string | null;
    /** For the mail to the person who asked. Without a key nobody is mailed. */
    notify?: { apiKey: string | undefined; origin: string; tenantName: string; actor: { id: string; name: string | null; email: string } };
  },
): Promise<void> {
  const note = typeof args.note === 'string' ? args.note.trim() : '';
  // The line first: an id from another order is a 404 whatever else is wrong.
  const row = await loadOrderDocumentRow(db, args.order, args.lineId);
  if (!note) throw new BadRequestError('Say why this document is refused. The person who ordered it reads the note.');
  if (note.length > ORDER_DOCUMENT_REFUSE_NOTE_MAX) {
    throw new BadRequestError(`Keep the note under ${ORDER_DOCUMENT_REFUSE_NOTE_MAX} characters.`);
  }
  if (typeof args.documentId !== 'string' || !args.documentId || typeof args.pendingSendId !== 'string' || !args.pendingSendId) {
    throw new BadRequestError(
      'A refusal must name the document and the send that asked (document_id, pending_send_id), as the waiting list returned them.',
    );
  }
  const res = await db
    .prepare(
      `UPDATE order_documents
          SET release_status = 'refused', decided_by = ?, decided_at = datetime('now'),
              decision_note = ?, updated_at = datetime('now')
        WHERE id = ? AND order_id = ? AND tenant_id = ? AND release_status = 'pending_qa'
          AND document_id = ? AND pending_send_id = ?`,
    )
    .bind(args.user.id, note, row.id, args.order.id, args.order.tenant_id, args.documentId, args.pendingSendId)
    .run();
  if ((res.meta?.changes ?? 0) === 0) {
    if (row.release_status === 'pending_qa') {
      throw new ConflictError('This document line changed since you opened it, so it was not refused. Reload the list and look at it again.');
    }
    throw new ConflictError('This document is not waiting for QA any more. Reload to see what happened to it.');
  }
  await logAudit(
    db,
    args.user.id,
    args.order.tenant_id,
    'order.document_release_refused',
    'order',
    args.order.id,
    JSON.stringify({
      order_number: args.order.order_number,
      order_document_id: row.id,
      document_id: row.document_id,
      pending_send_id: row.pending_send_id,
      product_id: row.product_id,
      supplier_id: row.supplier_id,
      document_type_id: row.document_type_id,
      note,
    }),
    args.clientIp,
  );
  if (args.notify) {
    const names = await db
      .prepare(
        `SELECT p.name AS product_name, s.name AS supplier_name, dt.name AS document_type_name, d.title AS document_title
           FROM order_documents od
           LEFT JOIN products p ON p.id = od.product_id AND p.tenant_id = od.tenant_id
           LEFT JOIN suppliers s ON s.id = od.supplier_id AND s.tenant_id = od.tenant_id
           LEFT JOIN document_types dt ON dt.id = od.document_type_id AND dt.tenant_id = od.tenant_id
           LEFT JOIN documents d ON d.id = od.document_id AND d.tenant_id = od.tenant_id
          WHERE od.id = ? AND od.tenant_id = ?`,
      )
      .bind(row.id, args.order.tenant_id)
      .first<{ product_name: string | null; supplier_name: string | null; document_type_name: string | null; document_title: string | null }>();
    await notifyRequesterOfDecision(db, args.notify.apiKey, {
      tenantId: args.order.tenant_id,
      tenantName: args.notify.tenantName,
      appUrl: args.notify.origin,
      order: { id: args.order.id, order_number: args.order.order_number, customer_name: args.order.customer_name },
      actor: args.notify.actor,
      decision: 'refused',
      note,
      lines: [
        {
          requested_by: row.pending_requested_by,
          document_type_name: names?.document_type_name ?? null,
          document_title: names?.document_title ?? null,
          product_name: names?.product_name ?? null,
          supplier_name: names?.supplier_name ?? null,
        },
      ],
      clientIp: args.clientIp,
    });
  }
}
