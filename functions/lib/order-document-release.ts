/**
 * QA's half of a document order (migration 0138, decision C-044): releasing or
 * refusing a document that was held because the person who sent the order
 * could not approve it.
 *
 * WHO. A QA releaser (`canReleaseQa`, C-040) signed in to the portal. NEVER an
 * API key, whoever it belongs to (C-041: a key reads `free` only, and
 * releasing is the opposite of that), and never a read-only account.
 *
 * WHAT IS RELEASED IS THE DOCUMENT ON THE LINE. Nothing is re-resolved here:
 * QA is approving the document the salesperson was shown. If that document is
 * no longer active, has expired, or has been LOCKED since, the release is
 * refused with the reason and the line stays where it is -- a release is never
 * a way around a rule that tightened while the line was waiting.
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
 * record. Editing the customer's contacts afterwards does not redirect a
 * release.
 *
 * ONE MAIL FOR ONE ACT. Lines released together and bound for the same
 * recipients share one link and one email.
 *
 * THE CLAIM COMES FIRST, the mail second. Each line is claimed with
 * `UPDATE ... WHERE release_status = 'pending_qa'`, so two people pressing
 * Release cannot mail the customer twice. If the mail then fails the link is
 * revoked and the lines go back to waiting: there is never a live link nobody
 * was told about, and never a "released" line whose document did not go.
 */

import { generateId, logAudit } from './db';
import { sendEmailDetailed, viaSenderName } from './email';
import {
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
  countDocumentLinesBehind,
  loadJudgedLinesById,
  loadOrderDocumentRow,
  loadSendRecipients,
  releaseBlockedReason,
  type JudgedOrderDocument,
} from './order-documents';
import { buildOrderDocumentsEmail, loadOrderSends, ORDER_SEND_MAX_SUBJECT_CHARS } from './order-send';
import type { OrderWriteRow } from './order-items';
import { ORDER_DOCUMENT_LINK_DAYS, ORDER_DOCUMENT_REFUSE_NOTE_MAX } from '../../shared/orderDocuments';
import type { ExitActor } from '../../shared/sharingRule';
import type { OrderDocumentsReleaseResponse, OrderSendSummary } from '../../shared/types';
import type { User } from './types';

/** Lines one release may name. */
export const ORDER_DOCUMENT_RELEASE_MAX = 100;

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

function recipientsKey(list: string[]): string {
  return [...list].map((a) => a.trim().toLowerCase()).sort().join('|');
}

/**
 * The order is delivered once QA's release was the last thing outstanding:
 * the latest send went in full, every COA line's certificate was in it, and
 * no document line is still waiting, missing, expired, locked or refused.
 */
async function markDeliveredAfterRelease(db: D1Database, order: OrderWriteRow): Promise<string> {
  if (order.status === 'delivered') return order.status;
  const latest = await db
    .prepare(
      `SELECT id, status FROM order_sends
        WHERE tenant_id = ? AND order_id = ? AND (kind IS NULL OR kind = 'qa_request')
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .bind(order.tenant_id, order.id)
    .first<{ id: string; status: string }>();
  if (!latest || latest.status !== 'sent') return order.status;
  if ((await countDocumentLinesBehind(db, order.tenant_id, order.id, latest.id)) > 0) return order.status;

  const items = await db
    .prepare(
      `SELECT oi.coa_document_id AS document_id, d.status AS status
         FROM order_items oi LEFT JOIN documents d ON d.id = oi.coa_document_id
        WHERE oi.order_id = ?`,
    )
    .bind(order.id)
    .all<{ document_id: string | null; status: string | null }>();
  const lines = items.results ?? [];
  if (lines.some((l) => !l.document_id || l.status !== 'active')) return order.status;
  if (lines.length > 0) {
    const files = await db
      .prepare('SELECT document_ids FROM order_send_files WHERE send_id = ? AND sent_ok = 1')
      .bind(latest.id)
      .all<{ document_ids: string }>();
    const went = new Set<string>();
    for (const f of files.results ?? []) {
      try {
        for (const id of JSON.parse(f.document_ids) as unknown[]) if (typeof id === 'string') went.add(id);
      } catch {
        // An unreadable row proves nothing went.
      }
    }
    if (lines.some((l) => !went.has(l.document_id as string))) return order.status;
  }
  await db
    .prepare(`UPDATE orders SET status = 'delivered', updated_at = datetime('now') WHERE id = ? AND tenant_id = ?`)
    .bind(order.id, order.tenant_id)
    .run();
  return 'delivered';
}

/**
 * Release the lines named. A line that cannot be released is REPORTED with its
 * reason and stays waiting; the rest still go. An id that is not a line of
 * this order is a 404 for the whole request -- it must not be possible to
 * learn that a line exists on somebody else's order.
 */
export async function releaseOrderDocuments(
  ctx: ReleaseContext,
  rawIds: unknown,
): Promise<OrderDocumentsReleaseResponse> {
  const { db, order, user } = ctx;
  const ids = Array.isArray(rawIds)
    ? [...new Set(rawIds.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()))]
    : [];
  if (ids.length === 0) throw new BadRequestError('Choose at least one document to release.');
  if (ids.length > ORDER_DOCUMENT_RELEASE_MAX) {
    throw new BadRequestError(`One release covers at most ${ORDER_DOCUMENT_RELEASE_MAX} documents.`);
  }

  const lines = await loadJudgedLinesById(db, order.tenant_id, order.id, ids, ctx.actor);
  if (lines.length !== ids.length) throw new NotFoundError('Document line not found');

  const response: OrderDocumentsReleaseResponse = { released: [], refused: [], sends: [], order_status: order.status };
  const refuse = (line: JudgedOrderDocument, reason: string) =>
    response.refused.push({ order_document_id: line.row.id, reason });

  const sendInfo = await loadSendRecipients(db, order.tenant_id, lines.map((l) => l.row.pending_send_id ?? ''));

  // 1. What may even be considered.
  const eligible: JudgedOrderDocument[] = [];
  for (const line of lines) {
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
    const recipients = sendInfo.get(line.row.pending_send_id ?? '')?.recipients ?? [];
    const blocked = releaseBlockedReason(line, recipients);
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
    passed.push(line);
  }

  // 3. THE CLAIM. Only the line still waiting is taken.
  const claimed: JudgedOrderDocument[] = [];
  for (const line of passed) {
    const res = await db
      .prepare(
        `UPDATE order_documents
            SET release_status = 'released', decided_by = ?, decided_at = datetime('now'),
                decision_note = NULL, updated_at = datetime('now')
          WHERE id = ? AND order_id = ? AND tenant_id = ? AND release_status = 'pending_qa'`,
      )
      .bind(user.id, line.row.id, order.id, order.tenant_id)
      .run();
    if ((res.meta?.changes ?? 0) > 0) claimed.push(line);
    else refuse(line, 'Somebody else has just decided this document.');
  }
  if (claimed.length === 0) return response;

  // 4. One link and one mail per distinct set of recipients.
  const groups = new Map<string, { recipients: string[]; lines: JudgedOrderDocument[]; sendIds: Set<string> }>();
  for (const line of claimed) {
    const info = sendInfo.get(line.row.pending_send_id ?? '')!;
    const key = recipientsKey(info.recipients);
    const g = groups.get(key) ?? { recipients: info.recipients, lines: [], sendIds: new Set<string>() };
    g.lines.push(line);
    g.sendIds.add(line.row.pending_send_id as string);
    groups.set(key, g);
  }

  const qaDocs = new Set(gate.qa_released_ids);
  const producedSendIds: string[] = [];

  /** Put claimed lines back in front of QA: nothing of theirs left. */
  const giveBack = async (lineIds: string[]): Promise<void> => {
    await db
      .prepare(
        `UPDATE order_documents
            SET release_status = 'pending_qa', decided_by = NULL, decided_at = NULL, updated_at = datetime('now')
          WHERE tenant_id = ? AND order_id = ? AND release_status = 'released' AND decided_by = ?
            AND id IN (${lineIds.map(() => '?').join(', ')})`,
      )
      .bind(order.tenant_id, order.id, user.id, ...lineIds)
      .run();
  };

  for (const g of groups.values()) {
    const docIds = [...new Set(g.lines.map((l) => l.row.document_id as string))];
    const rows = docIds.map((id) => rowById.get(id)!);
    const names = exportFileNames(rows);
    const lineIds = g.lines.map((l) => l.row.id);
    let mintedLinkId: string | null = null;
    let mailed = false;
    try {

    // The salesperson is who the customer has been talking to, so replies go
    // to the person who sent the order -- while that account still exists.
    const askedSendId = [...g.sendIds][g.sendIds.size - 1];
    const asked = sendInfo.get(askedSendId)!;
    const requester = await db
      .prepare('SELECT id, name, email, active FROM users WHERE id = ?')
      .bind(asked.sent_by)
      .first<{ id: string; name: string | null; email: string; active: number }>();
    const replyTo = requester && requester.active ? requester : { name: user.name, email: user.email };
    const subject = `${asked.subject} - additional documents`.slice(0, ORDER_SEND_MAX_SUBJECT_CHARS);

    const sendId = generateId();
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
    await db.batch(
      rows.map((row, i) =>
        db
          .prepare(
            `INSERT INTO order_send_files
               (id, send_id, tenant_id, position, document_id, version_number, document_ids,
                document_title, lot_label, file_name, bytes, part_number, delivery, source, source_queue_id,
                order_document_ids, link_days)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'link', 'document', NULL, ?, ?)`,
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
          ),
      ),
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
    const outcome = await sendEmailDetailed(ctx.apiKey, {
      to: g.recipients,
      subject,
      html: email.html,
      replyTo: replyTo.email,
      fromName: viaSenderName(ctx.tenantName),
    });

    const idSql = lineIds.map(() => '?').join(', ');
    if (!outcome.ok) {
      // Nothing left. Take the link back and put the lines back in front of QA.
      await revokeExportLink(db, link.id);
      mintedLinkId = null;
      await giveBack(lineIds);
      const error = outcome.error ?? 'The mail provider refused the message.';
      await db
        .prepare(`UPDATE order_sends SET parts = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(
          JSON.stringify([{ part_number: 1, ok: false, status: outcome.status, error, sent_at: null, attempts: 1 }]),
          sendId,
        )
        .run();
      for (const line of g.lines) {
        refuse(line, `The email could not be sent, so this document was not released. It is still waiting. (${error})`);
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
    const now = new Date().toISOString();
    await db.batch([
      db
        .prepare('UPDATE order_send_files SET sent_ok = 1, export_link_id = ? WHERE send_id = ?')
        .bind(link.id, sendId),
      db
        .prepare(`UPDATE order_sends SET status = 'sent', parts = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(
          JSON.stringify([{ part_number: 1, ok: true, status: outcome.status, error: null, sent_at: now, attempts: 1 }]),
          sendId,
        ),
      db
        .prepare(
          `UPDATE order_documents
              SET export_link_id = ?, last_sent_at = datetime('now'), updated_at = datetime('now')
            WHERE tenant_id = ? AND order_id = ? AND id IN (${idSql})`,
        )
        .bind(link.id, order.tenant_id, order.id, ...lineIds),
    ]);
    response.released.push(...lineIds);

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
          recipients: g.recipients,
          export_link_id: link.id,
          link_days: ORDER_DOCUMENT_LINK_DAYS,
          requested_by: asked.sent_by,
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
      // Something broke part way. If the mail had not gone, nothing left: the
      // link is taken back and the lines wait again. If it HAD gone, the lines
      // stay released -- the customer has the link, and saying otherwise would
      // invite a second mail.
      console.error('[order-document-release] release failed:', err instanceof Error ? err.message : String(err));
      if (!mailed) {
        try {
          if (mintedLinkId) await revokeExportLink(db, mintedLinkId);
          await giveBack(lineIds);
        } catch (inner) {
          console.error('[order-document-release] giving lines back failed:', inner instanceof Error ? inner.message : String(inner));
        }
        for (const line of g.lines) {
          if (!response.refused.some((r) => r.order_document_id === line.row.id)) {
            refuse(line, 'The release could not be completed, so this document is still waiting. Try again.');
          }
        }
      } else if (!response.released.includes(lineIds[0])) {
        response.released.push(...lineIds);
      }
    }
  }

  if (response.released.length > 0) response.order_status = await markDeliveredAfterRelease(db, order);
  if (producedSendIds.length > 0) {
    const sends = await loadOrderSends(db, user, { tenantId: order.tenant_id, orderId: order.id });
    const wanted = new Set(producedSendIds);
    response.sends = sends.filter((s: OrderSendSummary) => wanted.has(s.id));
  }
  return response;
}

/** QA says no to one waiting line, in words. The line stays on the order, marked. */
export async function refuseOrderDocument(
  db: D1Database,
  args: {
    order: OrderWriteRow;
    lineId: string;
    user: Pick<User, 'id'>;
    note: unknown;
    clientIp: string | null;
  },
): Promise<void> {
  const note = typeof args.note === 'string' ? args.note.trim() : '';
  // The line first: an id from another order is a 404 whatever else is wrong.
  const row = await loadOrderDocumentRow(db, args.order, args.lineId);
  if (!note) throw new BadRequestError('Say why this document is refused. The person who ordered it reads the note.');
  if (note.length > ORDER_DOCUMENT_REFUSE_NOTE_MAX) {
    throw new BadRequestError(`Keep the note under ${ORDER_DOCUMENT_REFUSE_NOTE_MAX} characters.`);
  }
  const res = await db
    .prepare(
      `UPDATE order_documents
          SET release_status = 'refused', decided_by = ?, decided_at = datetime('now'),
              decision_note = ?, updated_at = datetime('now')
        WHERE id = ? AND order_id = ? AND tenant_id = ? AND release_status = 'pending_qa'`,
    )
    .bind(args.user.id, note, row.id, args.order.id, args.order.tenant_id)
    .run();
  if ((res.meta?.changes ?? 0) === 0) {
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
      product_id: row.product_id,
      supplier_id: row.supplier_id,
      document_type_id: row.document_type_id,
      note,
    }),
    args.clientIp,
  );
}
