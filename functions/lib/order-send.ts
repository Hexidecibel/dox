/**
 * Sending an order's documents to the customer (migration 0134).
 *
 * WHAT AJ RULED (2026-10-05/06), and where each ruling lives in this file
 * ----------------------------------------------------------------------
 *   - The customer gets an exact copy of each certificate ATTACHED, not the
 *     30-day link the search export mails. (`planOrderSend`, `runParts`)
 *   - A multi-lot certificate goes WHOLE: the original file, once, however
 *     many of the order's lines were cut from it. (`resolveWholeOriginals`,
 *     the `original:<queue>` dedupe key)
 *   - Generated file names only; the uploaded name never leaves.
 *     (`exportFileNames` -- the search export's own namer, not a second one)
 *   - Too big for one email: numbered emails, "1 of N", shown on the review
 *     screen BEFORE sending; nothing dropped silently; refused with the number
 *     past the cap. (`packOrderSendFiles` in shared/orderSend.ts; the preview
 *     and the send are the same plan, and the send refuses a plan that changed
 *     since it was reviewed)
 *   - If a link is ever used -- one file too large to attach -- it does not
 *     expire. (`mintExportLink({ neverExpires: true })`)
 *   - The record shows what left, to whom, and how: attachment or link, whole
 *     original or per-lot page. (`order_sends` + `order_send_files`)
 *   - Any user except a read-only account may send; from "<Organization> via
 *     SupDox", reply-to the sender. (the endpoints + `viaSenderName`)
 *
 * ONE PLAN, TWO READERS. `planOrderSend` is the only place that decides which
 * files go, under which names, in which email. The preview endpoint prints it
 * and the send endpoint executes it, so the review screen cannot show a split
 * the send does not perform.
 *
 * ONE PART IN MEMORY AT A TIME. A Pages Function has 128 MB; a part is at most
 * 15 MB of files (about 20 MB once base64-encoded). Each part's bytes are
 * read, encoded, sent and released before the next is touched.
 *
 * A FAILED PART IS NOT A FAILED SEND. Each email succeeds or fails on its own
 * and is recorded on its own; the send is `partial` until every part went, the
 * order moves to `delivered` only then, and "resend failed parts" rebuilds
 * exactly those emails from the stored record -- the same files, the same
 * names, the same subject -- rather than re-planning from an order that may
 * have changed since.
 *
 * THE SHARING RULE (decision C-003, migration 0137) IS ASKED TWICE, on purpose.
 * Once in the PLAN: a line whose document is locked, or needs a QA approval
 * the sender cannot give, is listed in `lines_not_sent` with that reason and
 * its file is not planned. And once more IMMEDIATELY BEFORE EACH FILE'S BYTES
 * ARE READ (`runParts`), for the first send and for every resend: a resend
 * rebuilds from the stored record and never re-plans, so without the second
 * check a document locked after the first attempt would still go out on the
 * retry. The second check is made for whoever is pressing the button NOW.
 *
 * A WHOLE CERTIFICATE HOLDS EVERY LOT ON IT (C-042). The original takes the
 * strictest rule of every document cut from it -- including lots that are not
 * on this order. When that is stricter than the sender may pass, the per-lot
 * page goes instead and the review screen says so.
 */

import { generateId, logAudit } from './db';
import { computeChecksum } from './r2';
import {
  bytesToBase64,
  sendEmailDetailed,
  viaSenderName,
  type EmailAttachment,
} from './email';
import {
  EXPORT_MAX_DOCUMENTS,
  EXPORT_MAX_RECIPIENTS,
  exportFileNames,
  exportLinkUrl,
  externalDocumentTitle,
  loadExportDocuments,
  mintExportLink,
  readExportBytes,
  revokeExportLink,
  type ExportDocumentRow,
} from './document-export';
import { resolveWholeOriginals } from './coa-original';
import {
  auditQaRelease,
  documentsFromQueueItem,
  judgeDocumentsForExit,
  judgeSharedFile,
  loadSharingRules,
} from './sharing-rule';
import { judgeExit, sharingRefusalMessage, type ExitActor } from '../../shared/sharingRule';
import { loadOrderLines, type OrderWriteRow } from './order-items';
import { loadOrderCustomerContext } from './customer-coa';
import {
  ORDER_SEND_MAX_PARTS,
  ORDER_SEND_MAX_PART_BYTES,
  humanBytes,
  lotRowLabel,
  missingRequirementWarning,
  packOrderSendFiles,
  partSubject,
  planItemRequirements,
  planOrderRecipients,
} from '../../shared/orderSend';
import type {
  ApiOrderItem,
  OrderSendFileRecord,
  OrderSendLineRef,
  OrderSendPartResult,
  OrderSendPlanFile,
  OrderSendPreview,
  OrderSendSource,
  OrderSendStatus,
  OrderSendSummary,
} from '../../shared/types';
import type { User } from './types';

/** Sends (and resends) per user per hour -- the search export's own limit. */
export const ORDER_SEND_RATE_LIMIT_PER_HOUR = 30;
export const ORDER_SEND_RATE_WINDOW_SECONDS = 60 * 60;

export const ORDER_SEND_MAX_MESSAGE_CHARS = 2000;
export const ORDER_SEND_MAX_SUBJECT_CHARS = 200;

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** One planned file with the storage facts the public preview must not carry. */
export interface PlannedFile extends OrderSendPlanFile {
  r2_key: string;
  /** The document version the file is (source 'document'), or stands for. */
  version_number: number;
  source_queue_id: string | null;
}

export interface OrderSendPlan {
  preview: OrderSendPreview;
  files: PlannedFile[];
}

interface Entry {
  key: string;
  source: OrderSendSource;
  r2_key: string;
  bytes: number;
  source_queue_id: string | null;
  /** The row the generated name is built from. */
  name_row: ExportDocumentRow;
  base_row: ExportDocumentRow;
  document_ids: string[];
  lines: OrderSendLineRef[];
  lot_labels: string[];
  notes: string[];
}

function lineRef(line: ApiOrderItem): OrderSendLineRef {
  return {
    order_item_id: line.id,
    product_name: line.product_name_resolved ?? line.product_name ?? null,
    product_code: line.product_code ?? null,
    lot_label: lotRowLabel(line.lot_row_number, line.sub_lot_code) ?? line.lot_number ?? null,
    production_date_label: line.production_date_label ?? null,
    production_date_state: line.production_date_state ?? 'none',
  };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function defaultOrderSubject(tenantName: string, order: Pick<OrderWriteRow, 'order_number' | 'po_number'>): string {
  const po = order.po_number ? ` (PO ${order.po_number})` : '';
  return `${tenantName}: documents for order ${order.order_number}${po}`;
}

/**
 * Decide what one send of this order would be. Reads; writes nothing.
 *
 * The files come out in the order's line order. A line with no document, or
 * whose document is no longer active, is NOT quietly left out: it is listed in
 * `lines_not_sent` with the reason, and the review screen prints it.
 */
export async function planOrderSend(
  db: D1Database,
  files: R2Bucket,
  args: {
    order: OrderWriteRow;
    tenantName: string;
    sender: Pick<User, 'email'>;
    /** Who is asking, for the sharing rule (0137). */
    actor: ExitActor;
    emailConfigured: boolean;
    /** The subject the parts are numbered under; defaults to the generated one. */
    subject?: string | null;
  },
): Promise<OrderSendPlan> {
  const { order } = args;
  const lines = await loadOrderLines(db, files, order.tenant_id, order.id);

  const customer = order.customer_id
    ? await db
        .prepare('SELECT name, email FROM customers WHERE id = ? AND tenant_id = ?')
        .bind(order.customer_id, order.tenant_id)
        .first<{ name: string; email: string | null }>()
    : null;

  const linesNotSent: OrderSendPreview['lines_not_sent'] = [];
  const sendable: ApiOrderItem[] = [];
  for (const line of lines) {
    const base = {
      order_item_id: line.id,
      product_name: line.product_name_resolved ?? line.product_name ?? null,
      lot_number: lotRowLabel(line.lot_row_number, line.sub_lot_code) ?? line.lot_number ?? null,
    };
    if (!line.coa_document_id) {
      linesNotSent.push({ ...base, reason: 'No document on this line.' });
    } else if (line.coa_document_status !== 'active') {
      linesNotSent.push({
        ...base,
        reason: `The document on this line is ${line.coa_document_status ?? 'no longer in the portal'}. Only active documents are sent.`,
      });
    } else {
      sendable.push(line);
    }
  }

  const docIds = [...new Set(sendable.map((l) => l.coa_document_id as string))];
  const { rows, refused } = await loadExportDocuments(db, order.tenant_id, docIds, {
    exit: 'order_send',
    actor: args.actor,
  });
  const rowById = new Map(rows.map((r) => [r.document_id, r]));
  const refusedById = new Map(refused.map((r) => [r.document_id, r]));
  const originals = await resolveWholeOriginals(db, files, order.tenant_id, rows.map((r) => r.document_id));

  // The whole certificate holds every lot cut from it, on this order or not
  // (C-042). Judged once per original.
  //
  // The documents on an original are those BORN from its queue item plus the
  // order's own documents that trace to it: a version written by "Replace
  // existing" came from a different queue item than the one its document was
  // born from, so the first list alone would miss it.
  const tracedTo = new Map<string, Set<string>>();
  for (const [docId, resolution] of originals) {
    if (resolution.state !== 'on_file') continue;
    const set = tracedTo.get(resolution.original.queue_id) ?? new Set<string>();
    set.add(docId);
    tracedTo.set(resolution.original.queue_id, set);
  }
  const originalVerdicts = new Map<string, Awaited<ReturnType<typeof judgeSharedFile>>>();
  for (const [queueId, traced] of tracedTo) {
    const onIt = new Set<string>([...traced, ...(await documentsFromQueueItem(db, order.tenant_id, queueId))]);
    originalVerdicts.set(
      queueId,
      await judgeSharedFile(db, order.tenant_id, [...onIt], 'order_send', args.actor),
    );
  }

  const entries = new Map<string, Entry>();
  for (const line of sendable) {
    const docId = line.coa_document_id as string;
    const row = rowById.get(docId);
    const refusal = refusedById.get(docId);
    if (refusal) {
      // Held back by the sharing rule: said, with the reason, never dropped.
      linesNotSent.push({
        order_item_id: line.id,
        product_name: line.product_name_resolved ?? line.product_name ?? null,
        lot_number: lotRowLabel(line.lot_row_number, line.sub_lot_code) ?? line.lot_number ?? null,
        reason: refusal.message,
        sharing_refusal: refusal.reason,
        document_id: docId,
      });
      continue;
    }
    if (!row || !row.r2_key) {
      linesNotSent.push({
        order_item_id: line.id,
        product_name: line.product_name_resolved ?? line.product_name ?? null,
        lot_number: line.lot_number ?? null,
        reason: 'The document on this line has no file on record.',
      });
      continue;
    }
    const resolution = originals.get(docId) ?? { state: 'not_split' as const };
    const notes: string[] = [];
    let useOriginal = resolution.state === 'on_file';
    if (resolution.state === 'on_file' && resolution.original.file_size > ORDER_SEND_MAX_PART_BYTES) {
      // A whole certificate too large for any email. The per-lot page is what
      // can travel, and the sender is told which they are getting.
      useOriginal = false;
      notes.push(
        `The whole certificate is ${humanBytes(resolution.original.file_size)}, too large to attach. This lot's page is sent instead.`,
      );
    }
    if (resolution.state === 'missing') notes.push(resolution.message);
    if (useOriginal && resolution.state === 'on_file') {
      const whole = originalVerdicts.get(resolution.original.queue_id);
      if (!whole || whole.verdict !== 'allow') {
        useOriginal = false;
        notes.push(
          whole && whole.verdict === 'needs_qa'
            ? 'The whole certificate also covers a document that needs QA approval, so only this lot\'s page is sent.'
            : 'The whole certificate also covers a document that is locked, so only this lot\'s page is sent.',
        );
      }
    }

    const key =
      useOriginal && resolution.state === 'on_file'
        ? `original:${resolution.original.queue_id}`
        : `document:${docId}:${row.version_number}`;
    let entry = entries.get(key);
    if (!entry) {
      if (useOriginal && resolution.state === 'on_file') {
        const o = resolution.original;
        entry = {
          key,
          source: 'original',
          r2_key: o.r2_key,
          bytes: o.file_size,
          source_queue_id: o.queue_id,
          // Named from the original's own extension and type; the lots are
          // filled in below, once every line cut from it is known.
          name_row: { ...row, file_name: o.file_name, mime_type: o.mime_type, file_size: o.file_size, lot_label: null, production_date: null },
          base_row: row,
          document_ids: [],
          lines: [],
          lot_labels: [],
          notes: [],
        };
      } else {
        entry = {
          key,
          source: 'document',
          r2_key: row.r2_key,
          bytes: Number(row.file_size) || 0,
          source_queue_id: null,
          name_row: row,
          base_row: row,
          document_ids: [],
          lines: [],
          lot_labels: [],
          notes: [],
        };
      }
      entries.set(key, entry);
    }
    if (!entry.document_ids.includes(docId)) entry.document_ids.push(docId);
    const ref = lineRef(line);
    entry.lines.push(ref);
    if (ref.lot_label && !entry.lot_labels.includes(ref.lot_label)) entry.lot_labels.push(ref.lot_label);
    for (const n of notes) if (!entry.notes.includes(n)) entry.notes.push(n);
  }

  const list = [...entries.values()];
  for (const e of list) {
    if (e.source === 'original') {
      e.name_row = { ...e.name_row, lot_label: e.lot_labels.length ? e.lot_labels.join('; ') : null };
      if (e.lines.length > 1) {
        e.notes.unshift(`One certificate covers ${e.lines.length} lines of this order. It is attached once, whole.`);
      } else {
        e.notes.unshift('The whole certificate is attached, not only this lot\'s page.');
      }
    }
  }

  const names = exportFileNames(list.map((e) => e.name_row));
  const packed = packOrderSendFiles(list.map((e) => ({ key: e.key, bytes: e.bytes })));
  const baseSubject = (args.subject ?? '').trim() || defaultOrderSubject(args.tenantName, order);

  const planned: PlannedFile[] = list.map((e, i) => {
    const p = packed.files[i];
    const notes = [...e.notes];
    if (p.delivery === 'link') {
      notes.push(
        `At ${humanBytes(e.bytes)} this file is too large to attach. It goes as a link in the first email; the link does not expire and can be revoked.`,
      );
    }
    return {
      key: e.key,
      file_name: names[i],
      bytes: e.bytes,
      delivery: p.delivery,
      source: e.source,
      part_number: p.part_number,
      document_ids: e.document_ids,
      document_title: externalDocumentTitle(e.base_row),
      supplier_name: e.base_row.supplier_name,
      document_type_name: e.base_row.document_type_name,
      lot_label: e.source === 'original' ? e.name_row.lot_label : e.base_row.lot_label,
      lines: e.lines,
      notes,
      r2_key: e.r2_key,
      version_number: e.base_row.version_number,
      source_queue_id: e.source_queue_id,
    };
  });

  const warnings: string[] = [];
  if (linesNotSent.length > 0) {
    warnings.push(
      `${linesNotSent.length} line${linesNotSent.length === 1 ? '' : 's'} of this order will not be sent. See the list below.`,
    );
  }
  if (packed.part_count > 1 && !packed.refusal) {
    warnings.push(
      `These files do not fit in one email. They will go as ${packed.part_count} emails, numbered "1 of ${packed.part_count}" onward.`,
    );
  }
  const linkDocs = new Set(planned.filter((f) => f.delivery === 'link').flatMap((f) => f.document_ids));

  // What the customer's own record says (migration 0135): who receives COAs,
  // and what they need for each item on this order. INFORMATION ONLY -- it
  // adds a warning and pre-fills the address box; it never blocks the send and
  // is not part of the fingerprint, which covers what leaves, not who reads
  // the review screen. A customer with no contact and no requirement on file
  // yields exactly the pre-0135 answer.
  const customerContext = await loadOrderCustomerContext(db, order.tenant_id, order.customer_id);
  const sentLineIds = new Set(list.flatMap((e) => e.lines.map((l) => l.order_item_id)));
  const itemRequirements = planItemRequirements(
    lines.map((line) => ({
      order_item_id: line.id,
      product_id: line.product_id,
      product_name: line.product_name_resolved ?? line.product_name ?? null,
      lot_label: lotRowLabel(line.lot_row_number, line.sub_lot_code) ?? line.lot_number ?? null,
    })),
    customerContext.requirements,
    sentLineIds,
  );
  const missingWarning = missingRequirementWarning(itemRequirements);
  if (missingWarning) warnings.push(missingWarning);
  const recipientPlan = planOrderRecipients({
    coaContacts: customerContext.coa_contacts,
    deliveryContacts: itemRequirements.flatMap((r) => (r.delivery_contact ? [r.delivery_contact] : [])),
    customerEmail: customer?.email ?? null,
    cap: EXPORT_MAX_RECIPIENTS,
  });
  if (recipientPlan.over_cap > 0) {
    warnings.push(
      `This customer has ${recipientPlan.recipients.length + recipientPlan.over_cap} addresses to receive COAs and one send reaches at most ${EXPORT_MAX_RECIPIENTS}. ` +
        `${recipientPlan.over_cap} ${recipientPlan.over_cap === 1 ? 'was' : 'were'} left off the list below.`,
    );
  }

  let blocked: OrderSendPreview['blocked'] = null;
  if (planned.length === 0) {
    const heldByRule = linesNotSent.length > 0 && linesNotSent.every((l) => l.sharing_refusal);
    blocked = {
      code: 'nothing_to_send',
      message: heldByRule
        ? 'Every document on this order is held back by its sharing rule, so there is nothing to send. See the list below.'
        : 'No line of this order has an active document on it, so there is nothing to send.',
    };
  } else if (packed.refusal) {
    blocked = { code: 'too_many_parts', message: packed.refusal };
  } else if (linkDocs.size > EXPORT_MAX_DOCUMENTS) {
    blocked = {
      code: 'too_many_linked',
      message: `${linkDocs.size} documents are too large to attach, and one link covers at most ${EXPORT_MAX_DOCUMENTS}. Send the order in two goes.`,
    };
  }

  const parts = Array.from({ length: packed.part_count }, (_, i) => ({
    part_number: i + 1,
    subject: partSubject(baseSubject, i + 1, packed.part_count),
    bytes: packed.part_bytes[i] ?? 0,
    file_count: planned.filter((f) => f.part_number === i + 1).length,
  }));

  const fingerprint = (
    await sha256Hex(
      JSON.stringify(planned.map((f) => [f.key, f.file_name, f.bytes, f.delivery, f.part_number, f.document_ids])),
    )
  ).slice(0, 24);

  const preview: OrderSendPreview = {
    order: {
      id: order.id,
      order_number: order.order_number,
      po_number: order.po_number,
      ship_date: order.ship_date,
      customer_id: order.customer_id,
      customer_name: customer?.name ?? order.customer_name,
    },
    recipient: customer?.email ?? null,
    recipients: recipientPlan.recipients,
    recipient_source: recipientPlan.source,
    recipients_over_cap: recipientPlan.over_cap,
    item_requirements: itemRequirements,
    from_name: viaSenderName(args.tenantName),
    reply_to: args.sender.email,
    default_subject: defaultOrderSubject(args.tenantName, order),
    email_configured: args.emailConfigured,
    // The public shape: storage keys and queue ids stay on this side.
    files: planned.map(({ r2_key: _r, version_number: _v, source_queue_id: _q, ...pub }) => pub),
    parts,
    part_count: packed.part_count,
    total_bytes: planned.reduce((sum, f) => sum + f.bytes, 0),
    lines_not_sent: linesNotSent,
    warnings,
    blocked,
    limits: { max_part_bytes: ORDER_SEND_MAX_PART_BYTES, max_parts: ORDER_SEND_MAX_PARTS },
    fingerprint,
  };
  return { preview, files: planned };
}

// ---------------------------------------------------------------------------
// The email
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface OrderEmailFile {
  file_name: string;
  document_title: string | null;
  lot_label: string | null;
}

/**
 * One email of a send. Built ONLY from what the send record stores, so the
 * first attempt and a later "resend failed parts" produce the same message.
 *
 * It says what is attached by the GENERATED file name, never the uploaded one,
 * and prints no production date: a date the portal holds with any doubt is not
 * stated as fact to a customer, and the certificate itself is attached.
 */
export function buildOrderDocumentsEmail(params: {
  tenantName: string;
  senderName: string;
  senderEmail: string;
  orderNumber: string;
  poNumber: string | null;
  shipDate: string | null;
  message: string | null;
  partNumber: number;
  partCount: number;
  attached: OrderEmailFile[];
  linked: OrderEmailFile[];
  linkUrl: string | null;
}): { html: string } {
  const facts = [
    `Order ${params.orderNumber}`,
    params.poNumber ? `PO ${params.poNumber}` : null,
    params.shipDate ? `Ships ${params.shipDate}` : null,
  ]
    .filter(Boolean)
    .map((s) => escapeHtml(String(s)))
    .join(' &middot; ');

  const fileRow = (f: OrderEmailFile) => {
    const detail = [f.document_title, f.lot_label ? `Lot ${f.lot_label}` : null]
      .filter(Boolean)
      .map((s) => escapeHtml(String(s)))
      .join(' &middot; ');
    return `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;">
          <div style="color:#333;font-weight:600;word-break:break-all;">${escapeHtml(f.file_name)}</div>
          ${detail ? `<div style="color:#666;font-size:13px;">${detail}</div>` : ''}
        </td></tr>`;
  };

  const attachedBlock = params.attached.length
    ? `<p style="margin:0 0 8px;color:#555;">Attached to this email (${params.attached.length}):</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">${params.attached.map(fileRow).join('')}</table>`
    : '';
  const linkedBlock =
    params.linked.length && params.linkUrl
      ? `<p style="margin:0 0 8px;color:#555;">Too large to attach &mdash; open ${params.linked.length === 1 ? 'it' : 'them'} with the link below (${params.linked.length}):</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">${params.linked.map(fileRow).join('')}</table>
        <p style="margin:0 0 24px;text-align:center;">
          <a href="${escapeHtml(params.linkUrl)}" style="display:inline-block;background:#1A365D;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;">Open the documents</a>
        </p>
        <p style="margin:0 0 24px;color:#666;font-size:13px;">This link does not expire.</p>`
      : '';
  const partLine =
    params.partCount > 1
      ? `<p style="margin:0 0 16px;color:#555;line-height:1.6;">This is email ${params.partNumber} of ${params.partCount}. The documents for this order did not fit in one message.</p>`
      : '';

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <tr>
      <td style="background:#1A365D;padding:24px 32px;">
        <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">${escapeHtml(params.tenantName)}</h1>
        <p style="margin:6px 0 0;color:#cbd5e0;font-size:13px;">${facts}</p>
      </td>
    </tr>
    <tr>
      <td style="padding:32px;">
        ${partLine}
        ${params.message ? `<p style="margin:0 0 16px;padding:12px 16px;background:#f8f9fa;border-left:3px solid #1A365D;color:#333;line-height:1.6;white-space:pre-wrap;">${escapeHtml(params.message)}</p>` : ''}
        ${attachedBlock}
        ${linkedBlock}
        <p style="margin:0;color:#666;font-size:13px;line-height:1.6;">
          Reply to this email to reach ${escapeHtml(params.senderName)} directly.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 32px;background:#f8f9fa;border-top:1px solid #eee;">
        <p style="margin:0;color:#999;font-size:12px;text-align:center;">
          Sent through SupDox by ${escapeHtml(params.senderEmail)}.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
  return { html };
}

// ---------------------------------------------------------------------------
// Running the parts
// ---------------------------------------------------------------------------

interface StoredFile {
  id: string;
  position: number;
  document_id: string;
  version_number: number | null;
  document_ids: string;
  document_title: string | null;
  lot_label: string | null;
  file_name: string;
  bytes: number;
  checksum: string | null;
  part_number: number;
  delivery: 'attachment' | 'link';
  source: OrderSendSource;
  source_queue_id: string | null;
  export_link_id: string | null;
  sent_ok: number;
}

interface StoredSend {
  id: string;
  tenant_id: string;
  order_id: string;
  order_number: string;
  customer_id: string | null;
  customer_name: string | null;
  sent_by: string;
  recipients: string;
  subject: string;
  message: string | null;
  part_count: number;
  parts: string | null;
  status: OrderSendStatus;
  created_at: string;
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

/** Where a stored file's bytes are, re-derived from the record and tenant scoped. */
async function storedFileKey(db: D1Database, tenantId: string, f: StoredFile): Promise<string | null> {
  if (f.source === 'original') {
    if (!f.source_queue_id) return null;
    const q = await db
      .prepare('SELECT file_r2_key FROM processing_queue WHERE id = ? AND tenant_id = ?')
      .bind(f.source_queue_id, tenantId)
      .first<{ file_r2_key: string | null }>();
    return q?.file_r2_key ?? null;
  }
  const v = await db
    .prepare(
      `SELECT dv.r2_key FROM document_versions dv
         INNER JOIN documents d ON d.id = dv.document_id
        WHERE d.tenant_id = ? AND d.id = ? AND dv.version_number = ?`,
    )
    .bind(tenantId, f.document_id, f.version_number ?? 1)
    .first<{ r2_key: string | null }>();
  return v?.r2_key ?? null;
}

export interface RunContext {
  db: D1Database;
  files: R2Bucket;
  apiKey: string;
  origin: string;
  tenantName: string;
  sender: Pick<User, 'id' | 'name' | 'email'>;
  order: Pick<OrderWriteRow, 'order_number' | 'po_number' | 'ship_date'>;
  /**
   * Who is pressing send (or resend) NOW, for the sharing rule (0137). Not
   * `sender`: on a resend `sender` is the original sender, kept for the
   * reply-to, and may no longer be allowed to release what they once did.
   */
  actor: ExitActor;
  /**
   * The account of that same person. A link minted for an oversize file is
   * minted in THEIR name, because a link serves a `qa` document only while
   * its minter may release QA documents (C-045).
   */
  actorUserId: string;
}

/** What one run of parts did. */
interface PartsRun {
  results: OrderSendPartResult[];
  /** `qa` documents that went in this run because the actor is a QA releaser. */
  qaReleasedIds: string[];
}

/**
 * The sharing rule for ONE stored file, read now. Returns the sentence to fail
 * the part with, or null when the file may go.
 *
 * A stored file stands for one or more documents (`document_ids`); a whole
 * original additionally holds every document cut from the same queue item.
 * The strictest of all of them decides (C-042). A file whose documents can no
 * longer be found is refused: nothing says it may leave.
 */
async function storedFileRefusal(
  db: D1Database,
  tenantId: string,
  f: StoredFile,
  actor: ExitActor,
): Promise<{ problem: string | null; qaReleased: string[] }> {
  const own = parseJsonArray<string>(f.document_ids);
  const ids = new Set<string>(own.length > 0 ? own : [f.document_id]);
  if (f.source === 'original' && f.source_queue_id) {
    for (const id of await documentsFromQueueItem(db, tenantId, f.source_queue_id)) ids.add(id);
  }
  const judged = await judgeSharedFile(db, tenantId, [...ids], 'order_send', actor);
  if (judged.verdict !== 'allow') {
    return {
      problem: `${f.file_name} was not sent. ${sharingRefusalMessage(judged.verdict, { apiKey: actor.method === 'api_key' })}`,
      qaReleased: [],
    };
  }
  if (judged.document_ids.length < ids.size) {
    return {
      problem: `${f.file_name} was not sent: a document it stands for is no longer in the portal.`,
      qaReleased: [],
    };
  }
  // Which of them are `qa`, passing only because of who is sending.
  const rules = await loadSharingRules(db, tenantId, [...ids]);
  const qaReleased = [...rules.values()]
    .filter((r) => r.rule === 'qa' && judgeExit(r.rule, 'order_send', actor) === 'allow')
    .map((r) => r.document_id);
  return { problem: null, qaReleased };
}

/**
 * Send the given parts of a stored send and record each outcome. The bytes of
 * one part are read, encoded, sent and released before the next is started.
 *
 * A file that is not in storage, or no longer the bytes that were recorded,
 * FAILS ITS PART with the reason. Nothing is sent short: an email that is
 * missing a certificate the review screen promised is worse than no email.
 */
async function runParts(ctx: RunContext, send: StoredSend, partNumbers: number[]): Promise<PartsRun> {
  const { db } = ctx;
  const filesRes = await db
    .prepare('SELECT * FROM order_send_files WHERE send_id = ? ORDER BY position ASC')
    .bind(send.id)
    .all<StoredFile>();
  const all = filesRes.results ?? [];
  const recipients = parseJsonArray<string>(send.recipients);
  const previous = parseJsonArray<OrderSendPartResult>(send.parts);
  const results: OrderSendPartResult[] = [];
  const qaReleasedIds = new Set<string>();

  for (const part of partNumbers) {
    const prior = previous.find((p) => p.part_number === part);
    const attempts = (prior?.attempts ?? 0) + 1;
    const inPart = all.filter((f) => f.part_number === part);
    const attachedFiles = inPart.filter((f) => f.delivery === 'attachment');
    const linkedFiles = inPart.filter((f) => f.delivery === 'link');

    const fail = (error: string, status = 0): OrderSendPartResult => ({
      part_number: part,
      ok: false,
      status,
      error,
      sent_at: null,
      attempts,
    });

    const attachments: EmailAttachment[] = [];
    let problem: string | null = null;
    const partQaReleased: string[] = [];

    // THE SHARING RULE, READ NOW, before a byte of this part is read -- for
    // every file of the part, attached or linked. This is the check a resend
    // depends on: it rebuilds from the stored record, so the plan's own check
    // is days old by the time it runs.
    for (const f of inPart) {
      const ruled = await storedFileRefusal(db, send.tenant_id, f, ctx.actor);
      if (ruled.problem) {
        problem = ruled.problem;
        break;
      }
      partQaReleased.push(...ruled.qaReleased);
    }
    if (problem) {
      results.push(fail(problem));
      continue;
    }

    for (const f of attachedFiles) {
      const key = await storedFileKey(db, send.tenant_id, f);
      const bytes = await readExportBytes(ctx.files, key);
      if (!bytes) {
        problem = `${f.file_name} is not in storage, so this email was not sent.`;
        break;
      }
      const checksum = await computeChecksum(bytes);
      if (f.checksum && f.checksum !== checksum) {
        problem = `${f.file_name} is no longer the file that was reviewed, so this email was not sent.`;
        break;
      }
      if (!f.checksum) {
        await db
          .prepare('UPDATE order_send_files SET checksum = ?, bytes = ? WHERE id = ?')
          .bind(checksum, bytes.byteLength, f.id)
          .run();
      }
      attachments.push({ filename: f.file_name, content: bytesToBase64(bytes) });
    }
    if (problem) {
      results.push(fail(problem));
      continue;
    }

    // The link for files too large to attach is minted just before the email
    // that announces it, and revoked if that email fails: there is never a
    // live link nobody was told about.
    let linkId: string | null = null;
    let linkUrl: string | null = null;
    if (linkedFiles.length > 0) {
      const ids = [...new Set(linkedFiles.flatMap((f) => parseJsonArray<string>(f.document_ids)))];
      const link = await mintExportLink(db, {
        tenantId: send.tenant_id,
        documentIds: ids,
        createdBy: ctx.actorUserId,
        recipients,
        onBehalfOf: null,
        message: send.message,
        neverExpires: true,
      });
      linkId = link.id;
      linkUrl = exportLinkUrl(ctx.origin, link.token);
    }

    const email = buildOrderDocumentsEmail({
      tenantName: ctx.tenantName,
      senderName: ctx.sender.name || ctx.sender.email,
      senderEmail: ctx.sender.email,
      orderNumber: ctx.order.order_number,
      poNumber: ctx.order.po_number,
      shipDate: ctx.order.ship_date,
      message: send.message,
      partNumber: part,
      partCount: send.part_count,
      attached: attachedFiles,
      linked: linkedFiles,
      linkUrl,
    });
    const outcome = await sendEmailDetailed(ctx.apiKey, {
      to: recipients,
      subject: partSubject(send.subject, part, send.part_count),
      html: email.html,
      // The portal sends it; the person who pressed send answers for it.
      replyTo: ctx.sender.email,
      fromName: viaSenderName(ctx.tenantName),
      attachments,
    });

    if (!outcome.ok) {
      if (linkId) await revokeExportLink(db, linkId);
      results.push(fail(outcome.error ?? 'The mail provider refused the message.', outcome.status));
      continue;
    }
    await db
      .prepare('UPDATE order_send_files SET sent_ok = 1, export_link_id = COALESCE(?, export_link_id) WHERE send_id = ? AND part_number = ?')
      .bind(linkId, send.id, part)
      .run();
    for (const id of partQaReleased) qaReleasedIds.add(id);
    results.push({
      part_number: part,
      ok: true,
      status: outcome.status,
      error: null,
      sent_at: new Date().toISOString(),
      attempts,
    });
  }

  // Fold this run into the stored per-part record and re-derive the status.
  const merged: OrderSendPartResult[] = [];
  for (let n = 1; n <= send.part_count; n++) {
    const fresh = results.find((r) => r.part_number === n);
    const old = previous.find((p) => p.part_number === n);
    merged.push(fresh ?? old ?? { part_number: n, ok: false, status: 0, error: 'Not attempted.', sent_at: null, attempts: 0 });
  }
  const okCount = merged.filter((p) => p.ok).length;
  const status: OrderSendStatus = okCount === merged.length ? 'sent' : okCount === 0 ? 'failed' : 'partial';
  await db
    .prepare(`UPDATE order_sends SET parts = ?, status = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(JSON.stringify(merged), status, send.id)
    .run();
  send.parts = JSON.stringify(merged);
  send.status = status;
  return { results, qaReleasedIds: [...qaReleasedIds] };
}

/**
 * An order whose every line reached the customer is `delivered`.
 *
 * Two conditions, both required: every email of the send was accepted, AND no
 * line of the order was left behind -- a line with no document, or whose
 * document is no longer active, was listed as "not sent" on the review screen,
 * and an order with one of those is not delivered however well the rest went.
 * The same holds for a line the SHARING RULE held back (0137): its document is
 * active and on the line, and it did not go.
 */
async function markDeliveredIfSent(db: D1Database, send: StoredSend, actor: ExitActor): Promise<string | null> {
  if (send.status !== 'sent') return null;
  const behind = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM order_items oi
         LEFT JOIN documents d ON d.id = oi.coa_document_id
        WHERE oi.order_id = ?
          AND (oi.coa_document_id IS NULL OR d.status IS NULL OR d.status != 'active')`,
    )
    .bind(send.order_id)
    .first<{ n: number }>();
  if (Number(behind?.n) > 0) return null;
  const onLines = await db
    .prepare('SELECT DISTINCT coa_document_id AS id FROM order_items WHERE order_id = ? AND coa_document_id IS NOT NULL')
    .bind(send.order_id)
    .all<{ id: string }>();
  const held = await judgeDocumentsForExit(
    db,
    send.tenant_id,
    (onLines.results ?? []).map((r) => r.id),
    'order_send',
    actor,
  );
  if (held.refused.length > 0) return null;
  await db
    .prepare(`UPDATE orders SET status = 'delivered', updated_at = datetime('now') WHERE id = ? AND tenant_id = ?`)
    .bind(send.order_id, send.tenant_id)
    .run();
  return 'delivered';
}

async function auditSend(
  db: D1Database,
  send: StoredSend,
  userId: string,
  clientIp: string | null,
  ran: OrderSendPartResult[],
  resend: boolean,
): Promise<void> {
  const files = await db
    .prepare(
      `SELECT file_name, document_ids, part_number, delivery, source, bytes, sent_ok
         FROM order_send_files WHERE send_id = ? ORDER BY position ASC`,
    )
    .bind(send.id)
    .all<{ file_name: string; document_ids: string; part_number: number; delivery: string; source: string; bytes: number; sent_ok: number }>();
  const anyWent = ran.some((r) => r.ok);
  try {
    await logAudit(
      db,
      userId,
      send.tenant_id,
      anyWent ? 'order.coas_sent' : 'order.coas_send_failed',
      'order_send',
      send.id,
      JSON.stringify({
        order_id: send.order_id,
        order_number: send.order_number,
        customer_id: send.customer_id,
        recipients: parseJsonArray<string>(send.recipients),
        subject: send.subject,
        status: send.status,
        resend,
        part_count: send.part_count,
        parts: ran,
        files: (files.results ?? []).map((f) => ({
          file_name: f.file_name,
          document_ids: parseJsonArray<string>(f.document_ids),
          part: f.part_number,
          delivery: f.delivery,
          source: f.source,
          bytes: f.bytes,
          sent_ok: Number(f.sent_ok) === 1,
        })),
      }),
      clientIp,
    );
  } catch {
    // The emails have gone (or not); the send record itself says which.
  }
}

/**
 * Record a reviewed plan and send it.
 *
 * The record is written BEFORE the first email, at `failed` with every file
 * unsent, and only moves toward `sent` as emails are accepted. If the Function
 * dies half way the record under-claims; it can never say something left that
 * did not.
 */
export async function executeOrderSend(
  ctx: RunContext,
  args: {
    order: OrderWriteRow;
    plan: OrderSendPlan;
    recipients: string[];
    subject: string;
    message: string | null;
    clientIp: string | null;
  },
): Promise<{ sendId: string; orderStatus: string }> {
  const { db } = ctx;
  const { order, plan } = args;
  const sendId = generateId();
  const customerName = plan.preview.order.customer_name;

  await db
    .prepare(
      `INSERT INTO order_sends
         (id, tenant_id, order_id, order_number, customer_id, customer_name, sent_by,
          recipients, subject, message, part_count, parts, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'failed')`,
    )
    .bind(
      sendId,
      order.tenant_id,
      order.id,
      order.order_number,
      order.customer_id,
      customerName,
      ctx.sender.id,
      JSON.stringify(args.recipients),
      args.subject,
      args.message,
      plan.preview.part_count,
    )
    .run();

  await db.batch(
    plan.files.map((f, i) =>
      db
        .prepare(
          `INSERT INTO order_send_files
             (id, send_id, tenant_id, position, document_id, version_number, document_ids,
              document_title, lot_label, file_name, bytes, part_number, delivery, source, source_queue_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          generateId(),
          sendId,
          order.tenant_id,
          i,
          f.document_ids[0],
          f.version_number,
          JSON.stringify(f.document_ids),
          f.document_title,
          f.lot_label,
          f.file_name,
          f.bytes,
          f.part_number,
          f.delivery,
          f.source,
          f.source_queue_id,
        ),
    ),
  );

  const send = (await db.prepare('SELECT * FROM order_sends WHERE id = ?').bind(sendId).first<StoredSend>())!;
  const run = await runParts(ctx, send, Array.from({ length: send.part_count }, (_, i) => i + 1));
  const delivered = await markDeliveredIfSent(db, send, ctx.actor);
  await auditSend(db, send, ctx.sender.id, args.clientIp, run.results, false);
  // A QA releaser sending a document that needs QA approval IS the approval.
  await auditQaRelease(db, {
    userId: ctx.sender.id,
    tenantId: send.tenant_id,
    exit: 'order_send',
    documentIds: run.qaReleasedIds,
    resourceType: 'order_send',
    resourceId: send.id,
    clientIp: args.clientIp,
  });
  return { sendId, orderStatus: delivered ?? order.status };
}

/** Send again exactly the parts that did not go. Returns null when none failed. */
export async function resendFailedParts(
  ctx: RunContext,
  args: { sendId: string; tenantId: string; actorId: string; clientIp: string | null },
): Promise<{ orderStatus: string | null; attempted: number } | null> {
  const send = await ctx.db
    .prepare('SELECT * FROM order_sends WHERE id = ? AND tenant_id = ?')
    .bind(args.sendId, args.tenantId)
    .first<StoredSend>();
  if (!send) return null;
  const done = new Set(parseJsonArray<OrderSendPartResult>(send.parts).filter((p) => p.ok).map((p) => p.part_number));
  const failed = Array.from({ length: send.part_count }, (_, i) => i + 1).filter((n) => !done.has(n));
  if (failed.length === 0) return { orderStatus: null, attempted: 0 };
  const run = await runParts(ctx, send, failed);
  const delivered = await markDeliveredIfSent(ctx.db, send, ctx.actor);
  // The audit row names whoever pressed resend, which may be an admin rather
  // than the original sender.
  await auditSend(ctx.db, send, args.actorId, args.clientIp, run.results, true);
  await auditQaRelease(ctx.db, {
    userId: args.actorId,
    tenantId: send.tenant_id,
    exit: 'order_send',
    documentIds: run.qaReleasedIds,
    resourceType: 'order_send',
    resourceId: send.id,
    clientIp: args.clientIp,
  });
  return { orderStatus: delivered, attempted: failed.length };
}

// ---------------------------------------------------------------------------
// Reading the record
// ---------------------------------------------------------------------------

interface SendListRow extends StoredSend {
  sent_by_name: string | null;
  sent_by_email: string | null;
}

function isAdmin(user: Pick<User, 'role'>): boolean {
  return user.role === 'super_admin' || user.role === 'org_admin';
}

/**
 * What left, to whom and how -- for the order page (`orderId`) or for "Sent
 * documents" (`sentBy` narrows to one person's sends). Tenant scoped in SQL.
 *
 * `can_resend` is the caller's own answer: the person who sent it or an admin,
 * never a read-only account, and only while a part is still unsent.
 */
export async function loadOrderSends(
  db: D1Database,
  user: Pick<User, 'id' | 'role'>,
  args: { tenantId: string; orderId?: string; sentBy?: string; limit?: number },
): Promise<OrderSendSummary[]> {
  const where = ['s.tenant_id = ?'];
  const binds: (string | number)[] = [args.tenantId];
  if (args.orderId) {
    where.push('s.order_id = ?');
    binds.push(args.orderId);
  }
  if (args.sentBy) {
    where.push('s.sent_by = ?');
    binds.push(args.sentBy);
  }
  let rows: SendListRow[];
  try {
    const res = await db
      .prepare(
        `SELECT s.*, u.name AS sent_by_name, u.email AS sent_by_email
           FROM order_sends s
           LEFT JOIN users u ON u.id = s.sent_by
          WHERE ${where.join(' AND ')}
          ORDER BY s.created_at DESC, s.rowid DESC
          LIMIT ?`,
      )
      .bind(...binds, args.limit ?? 100)
      .all<SendListRow>();
    rows = res.results ?? [];
  } catch (err) {
    // A database without migration 0134 has no sends to list.
    console.warn('[order-send] sends could not be read:', err instanceof Error ? err.message : String(err));
    return [];
  }
  if (rows.length === 0) return [];

  const filesBySend = new Map<string, OrderSendFileRecord[]>();
  const CHUNK = 80;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK).map((r) => r.id);
    const res = await db
      .prepare(
        `SELECT * FROM order_send_files
          WHERE send_id IN (${slice.map(() => '?').join(', ')})
          ORDER BY send_id, position ASC`,
      )
      .bind(...slice)
      .all<StoredFile & { send_id: string }>();
    for (const f of res.results ?? []) {
      const list = filesBySend.get(f.send_id) ?? [];
      list.push({
        position: f.position,
        file_name: f.file_name,
        bytes: Number(f.bytes) || 0,
        part_number: f.part_number,
        delivery: f.delivery,
        source: f.source,
        document_id: f.document_id,
        document_ids: parseJsonArray<string>(f.document_ids),
        document_title: f.document_title,
        lot_label: f.lot_label,
        sent_ok: Number(f.sent_ok) === 1,
      });
      filesBySend.set(f.send_id, list);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    order_id: r.order_id,
    order_number: r.order_number,
    customer_name: r.customer_name,
    status: r.status,
    created_at: r.created_at,
    sent_by_id: r.sent_by,
    sent_by_name: r.sent_by_name ?? null,
    sent_by_email: r.sent_by_email ?? null,
    recipients: parseJsonArray<string>(r.recipients),
    subject: r.subject,
    message: r.message,
    part_count: r.part_count,
    parts: parseJsonArray<OrderSendPartResult>(r.parts),
    files: filesBySend.get(r.id) ?? [],
    can_resend: r.status !== 'sent' && user.role !== 'reader' && (isAdmin(user) || r.sent_by === user.id),
  }));
}
