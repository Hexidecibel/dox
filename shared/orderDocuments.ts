/**
 * The pure half of a document order (migration 0138): what a send would do
 * with one document line, and the advisory sales reads before sharing a
 * co-packer's document. No database, no clock -- the order page, the review
 * screen, the send and the tests all get the same answer from one function.
 *
 * THE THREE GROUPS (decision C-044). Every line lands in exactly one:
 *
 *   goes_now      free; or `qa` and the person sending may release QA
 *                 documents (their send is the approval).
 *   waits_for_qa  `qa` and the sender may not release it. Held until QA
 *                 releases it, then mailed to the same addresses.
 *   will_not_go   locked; nothing on file; expired; no longer an active
 *                 document; refused by QA for this order.
 *
 * THE RULE IS THE LIVE ONE. `rule` here is what `loadSharingRules` read a
 * moment ago, never the snapshot stored when the line was added: a document
 * locked since then does not go, and one loosened since then does.
 */

import { isPrivateLabel } from './itemApproval';
import { judgeExit, type ExitActor, type SharingRule } from './sharingRule';
import { humanDay } from './orderSend';
import type {
  OrderDocumentDelivery,
  OrderDocumentDisposition,
  OrderDocumentReason,
  OrderDocumentReleaseStatus,
} from './types';

/** How long the link a document order's documents leave on lives. */
export const ORDER_DOCUMENT_LINK_DAYS = 30;

/** Document lines one request may add. Items x types past this is refused with the number. */
export const ORDER_DOCUMENTS_MAX_PER_REQUEST = 200;

export const ORDER_DOCUMENT_REFUSE_NOTE_MAX = 500;

/**
 * A line `releasing` for longer than this did not finish: the Worker died
 * between the claim and the record. Releases take seconds.
 */
export const ORDER_DOCUMENT_RELEASE_STUCK_MINUTES = 5;

/** True when a `releasing` claim is old enough to be called unfinished. */
export function releaseIsStuck(releasingAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!releasingAt) return true;
  const s = releasingAt.trim();
  const ms = Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  if (!Number.isFinite(ms)) return true;
  return now.getTime() - ms > ORDER_DOCUMENT_RELEASE_STUCK_MINUTES * 60 * 1000;
}

/** The causes QA is told about, once per line each. */
export type OrderDocumentQaCause = 'pending_qa' | 'missing' | 'expired';

export const RELEASE_STATUS_LABELS: Record<OrderDocumentReleaseStatus, string> = {
  none: '',
  pending_qa: 'Waiting for QA',
  releasing: 'Being released',
  released: 'Released by QA',
  refused: 'Refused by QA',
};

/**
 * What sales is told about a co-packer's document on a private-label item
 * (AJ: "the producer's name, for one"). Null when the pair is not private
 * label -- including when either party is simply not recorded, which is "not
 * known", not private label.
 *
 * AN ADVISORY, NEVER A BLOCK: nothing reads this to decide anything. It is
 * shown to the person building and sending; it is never in the customer's mail.
 */
export function privateLabelAdvisory(
  brandOwner: string | null | undefined,
  producer: string | null | undefined,
): string | null {
  if (!isPrivateLabel(brandOwner, producer)) return null;
  const who = (producer ?? '').trim();
  const brand = (brandOwner ?? '').trim();
  return (
    `This document is the producer's own and names ${who}. ` +
    `The item is sold under ${brand}, so the customer will see who makes it.`
  );
}

export interface OrderDocumentLineFacts {
  /** The line holds a document id at all. */
  has_document: boolean;
  /** `documents.status` now; null when the row is gone. */
  document_status: string | null;
  /** The document's current version has a file behind it. */
  has_file: boolean;
  /** The document's own due date is in the past, as of today. */
  expired: boolean;
  due_date: string | null;
  /** The LIVE rule. Null only when there is no document to have one. */
  rule: SharingRule | null;
  release_status: OrderDocumentReleaseStatus;
  decision_note: string | null;
  decided_at: string | null;
  /** The type is a certificate of analysis: it goes attached, like a COA pick. */
  is_coa_type: boolean;
  /** A fresh resolve finds a current, in-date document that is not the one on the line. */
  fresh_found: boolean;
  /** When the line was put in front of QA, and for whom. Only read while it waits. */
  pending_at?: string | null;
  pending_recipients?: readonly string[];
  /** A `releasing` claim that never finished. */
  release_stuck?: boolean;
}

export interface OrderDocumentJudgement {
  disposition: OrderDocumentDisposition;
  reason: OrderDocumentReason | null;
  text: string;
  delivery: OrderDocumentDelivery;
  /** What QA is told about when the order is sent, or null. */
  qa_cause: OrderDocumentQaCause | null;
  /** Left behind: the order is not delivered while a line like this is on it. */
  behind: boolean;
}

const REFRESH = 'Refresh the line to use it.';

/**
 * A line already in front of QA says since when and for whom, because neither
 * changes: a later send of the order does not ask again and does not move the
 * addresses the release will mail.
 */
export function alreadyWaitingText(
  pendingAt: string | null | undefined,
  recipients: readonly string[] | null | undefined,
): string {
  const day = humanDay(pendingAt ?? null);
  const who = (recipients ?? []).filter(Boolean).join(', ');
  return (
    `Already waiting for QA${day ? ` since ${day}` : ''}${who ? `, for ${who}` : ''}. ` +
    'Sending the order again does not ask again and does not change who it goes to.'
  );
}

/** Decide one line. `actor` is the person asking, as `exitActorForRequest` built it. */
export function judgeOrderDocumentLine(facts: OrderDocumentLineFacts, actor: ExitActor): OrderDocumentJudgement {
  const delivery: OrderDocumentDelivery = facts.is_coa_type ? 'attachment' : 'link';
  const wont = (
    reason: OrderDocumentReason,
    text: string,
    qa_cause: OrderDocumentQaCause | null = null,
    behind = true,
  ): OrderDocumentJudgement => ({ disposition: 'will_not_go', reason, text, delivery, qa_cause, behind });

  // A person's "no" for this order stands until the line is taken off or
  // re-resolved to a different document.
  if (facts.release_status === 'refused') {
    const note = (facts.decision_note ?? '').trim();
    return wont('refused', note ? `QA refused this document for this order: ${note}` : 'QA refused this document for this order.');
  }

  if (!facts.has_document) {
    if (facts.fresh_found) {
      return wont('stale', `Nothing was on file when this line was added. A document is on file now. ${REFRESH}`);
    }
    return wont(
      'missing',
      'No approved document of this type is on file for this item and supplier. QA is told when the order is sent.',
      'missing',
    );
  }
  if (facts.document_status !== 'active') {
    return wont(
      'inactive',
      `The document on this line is ${facts.document_status ?? 'no longer in the portal'}. Only active documents are sent. Refresh the line.`,
    );
  }
  if (!facts.has_file) return wont('no_file', 'The document on this line has no file on record.');
  if (facts.expired) {
    const day = humanDay(facts.due_date);
    if (facts.fresh_found) {
      return wont('stale', `This document expired${day ? ` on ${day}` : ''}. A newer one is on file now. ${REFRESH}`);
    }
    return wont(
      'expired',
      `This document expired${day ? ` on ${day}` : ''}. QA is told when the order is sent.`,
      'expired',
    );
  }

  // No rule row means the document could not be judged: it does not go.
  const rule: SharingRule = facts.rule ?? 'locked';
  const verdict = judgeExit(rule, 'order_send', actor);
  if (verdict === 'locked') {
    return wont('locked', 'Locked. This document does not leave the organization.');
  }
  // A release in progress (or one that did not finish) is QA's to complete.
  // Nobody's send carries the document meanwhile, a releaser's included: two
  // mails for one approval is what the claim exists to prevent.
  if (facts.release_status === 'releasing') {
    return {
      disposition: 'waits_for_qa',
      reason: null,
      text: facts.release_stuck
        ? 'A release of this document did not finish. QA can release it again or put it back in the waiting list. It has not been sent.'
        : 'QA is releasing this document now.',
      delivery: 'link',
      qa_cause: null,
      behind: true,
    };
  }
  if (verdict === 'needs_qa') {
    if (facts.release_status === 'released') {
      const day = humanDay(facts.decided_at);
      return wont(
        'already_released',
        `QA released this document${day ? ` on ${day}` : ''} and it was sent then. It is not sent again.`,
        null,
        false,
      );
    }
    return {
      disposition: 'waits_for_qa',
      reason: null,
      text:
        facts.release_status === 'pending_qa'
          ? alreadyWaitingText(facts.pending_at, facts.pending_recipients)
          : 'Needs QA approval. It is held for QA, and mailed to the same addresses once QA releases it.',
      delivery: 'link',
      qa_cause: 'pending_qa',
      behind: true,
    };
  }

  const how =
    delivery === 'attachment'
      ? 'Goes now, attached.'
      : `Goes now, on a link that works for ${ORDER_DOCUMENT_LINK_DAYS} days.`;
  return {
    disposition: 'goes_now',
    reason: null,
    text: rule === 'qa' ? `${how} It needs QA approval, and you can give it: sending it is the approval.` : how,
    delivery,
    qa_cause: null,
    behind: false,
  };
}
