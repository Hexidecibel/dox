/**
 * The supplier renewal request: its stages and its fixed template (0133).
 *
 * Pure. No database, no clock, no model. AJ's ruling (D-048) is that the
 * message a supplier receives is a FIXED TEMPLATE a person may edit before
 * approving it -- not generated prose -- and that nothing internal can reach
 * it. Both halves are enforced here by construction rather than by review:
 *
 *   1. `renderRenewalRequestDraft` reads an ALLOW-LIST. It builds the text
 *      from the named fields of `RenewalRequestTemplateInput` one at a time
 *      and never spreads, iterates or stringifies its argument, so a caller
 *      that hands it a wider object (a document row, an expiration row) still
 *      cannot leak a document id, an owner label, a spec limit or a note. Same
 *      discipline as `buildSupplierRequestView` and `buildAlertLandingView`.
 *
 *   2. The LINK BLOCK is not part of the draft. A person edits the body; the
 *      system appends `renewalRequestLinkBlock(url)` at send. It cannot be
 *      edited out because it was never in the editable text, and it cannot be
 *      altered because it is rebuilt from the live link every time.
 *
 * THE STAGES
 * ----------
 * One lead-time setting, shared with the internal alert (0111): the request
 * window opens the same day the owner is first warned. Then the day of
 * expiry, 7 days after and 14 days after -- and then the portal STOPS writing
 * to the supplier and tells the organisation's own admins instead (D-051).
 * `RENEWAL_ESCALATE_AFTER_DAYS` is that line: 7 days after the last
 * follow-up. AJ said "after the 14-day follow-up"; the 21 is ours, and it is a
 * named constant so changing it is one edit.
 */

export const RENEWAL_REQUEST_STAGES = ['window_open', 'day_of', 'plus_7', 'plus_14'] as const;
export type RenewalRequestStage = (typeof RENEWAL_REQUEST_STAGES)[number];

/** Days past the due date at which each follow-up stage becomes due. */
export const RENEWAL_FOLLOW_UP_DAYS = { plus_7: 7, plus_14: 14 } as const;

/**
 * Days past the due date after which nothing more is drafted for the supplier
 * and the cycle is escalated internally. See the header.
 */
export const RENEWAL_ESCALATE_AFTER_DAYS = 21;

export function isRenewalRequestStage(v: unknown): v is RenewalRequestStage {
  return typeof v === 'string' && (RENEWAL_REQUEST_STAGES as readonly string[]).includes(v);
}

/** Position in the ladder; a higher rank is a later stage. */
export function renewalStageRank(stage: RenewalRequestStage): number {
  return RENEWAL_REQUEST_STAGES.indexOf(stage);
}

/**
 * Which stage is due for a document `daysUntil` days from its due date
 * (negative = past due), given the lead time that document is warned at.
 *
 *   null        not inside the window yet -- nothing to draft
 *   'escalate'  past the last follow-up window -- stop and tell the admins
 *
 * A document that is first seen late (a contact added after the date passed)
 * lands directly on the stage that is due TODAY. Earlier stages are never
 * drafted retroactively: four messages is a ceiling, not a quota.
 */
export function renewalStageFor(
  daysUntil: number,
  leadDays: number,
): RenewalRequestStage | 'escalate' | null {
  if (!Number.isFinite(daysUntil)) return null;
  if (daysUntil <= -RENEWAL_ESCALATE_AFTER_DAYS) return 'escalate';
  if (daysUntil <= -RENEWAL_FOLLOW_UP_DAYS.plus_14) return 'plus_14';
  if (daysUntil <= -RENEWAL_FOLLOW_UP_DAYS.plus_7) return 'plus_7';
  if (daysUntil <= 0) return 'day_of';
  if (daysUntil <= leadDays) return 'window_open';
  return null;
}

const STAGE_LABELS: Record<RenewalRequestStage, string> = {
  window_open: 'First request',
  day_of: 'Day of expiry',
  plus_7: '7 days after expiry',
  plus_14: '14 days after expiry',
};

/** What a person reads on the approval screen. */
export function renewalStageLabel(stage: RenewalRequestStage | string): string {
  return isRenewalRequestStage(stage) ? STAGE_LABELS[stage] : String(stage);
}

/** One thing being asked for, in the SUPPLIER's words. */
export interface RenewalRequestTemplateItem {
  /** The request line's name -- what the supplier page will show. */
  name: string;
  /** The request line's supplier-facing explanation, when it has one. */
  explanation?: string | null;
}

/**
 * EVERYTHING the template may read. Adding a field here is a decision about
 * what a supplier is shown; nothing else reaches the text.
 */
export interface RenewalRequestTemplateInput {
  /** The organisation asking. */
  tenantName: string;
  /** The supplier's document contact, when a name is on file. */
  contactName: string | null;
  items: RenewalRequestTemplateItem[];
  /** YYYY-MM-DD. */
  dueDate: string;
  stage: RenewalRequestStage;
  /** The person the reply goes to. Null when no single approver resolved. */
  requesterName: string | null;
  /** True when an earlier stage of this cycle actually reached the supplier. */
  isFollowUp: boolean;
}

export interface RenewalRequestDraft {
  subject: string;
  body: string;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "2026-10-31" -> "October 31, 2026". An unparseable value is printed as given. */
export function formatRenewalDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? '').trim());
  if (!m) return String(iso ?? '');
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return String(iso);
  return `${month} ${Number(m[3])}, ${m[1]}`;
}

function oneLine(v: unknown): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

function itemPhrase(names: string[]): string {
  if (names.length === 0) return 'the document';
  if (names.length === 1) return names[0];
  return `${names.length} documents`;
}

/**
 * Fill the fixed template. The result is a DRAFT: a person reads it, may edit
 * the body, and approves it. It contains no link -- see the header.
 */
export function renderRenewalRequestDraft(input: RenewalRequestTemplateInput): RenewalRequestDraft {
  // Named reads only. Do not replace these with a spread or a loop over
  // `input`: that is the allow-list.
  const tenantName = oneLine(input.tenantName) || 'our organization';
  const contactName = oneLine(input.contactName);
  const requesterName = oneLine(input.requesterName);
  const due = formatRenewalDate(input.dueDate);
  const stage: RenewalRequestStage = isRenewalRequestStage(input.stage) ? input.stage : 'window_open';
  const isFollowUp = input.isFollowUp === true;
  const items = (Array.isArray(input.items) ? input.items : [])
    .map((i) => ({ name: oneLine(i?.name), explanation: oneLine(i?.explanation) }))
    .filter((i) => i.name.length > 0);
  const names = items.map((i) => i.name);
  const what = itemPhrase(names);

  let subject: string;
  let opening: string;
  switch (stage) {
    case 'day_of':
      subject = `Expires today: ${what} on file with ${tenantName}`;
      opening =
        names.length > 1
          ? `The copies we hold of the following documents expire today, ${due}.`
          : `The copy we hold of the following document expires today, ${due}.`;
      break;
    case 'plus_7':
      subject = `Expired ${due}: ${what} on file with ${tenantName}`;
      opening =
        names.length > 1
          ? `The copies we hold of the following documents expired on ${due}, and we have not yet received current versions.`
          : `The copy we hold of the following document expired on ${due}, and we have not yet received a current version.`;
      break;
    case 'plus_14':
      subject = `Final reminder: ${what} expired ${due}`;
      opening =
        names.length > 1
          ? `The copies we hold of the following documents expired on ${due}. This is our final reminder.`
          : `The copy we hold of the following document expired on ${due}. This is our final reminder.`;
      break;
    case 'window_open':
    default:
      subject = `Renewal request: ${what} on file with ${tenantName} expires ${due}`;
      opening =
        names.length > 1
          ? `The copies we hold of the following documents expire on ${due}.`
          : `The copy we hold of the following document expires on ${due}.`;
      break;
  }

  const lines: string[] = [];
  lines.push(contactName ? `Hello ${contactName},` : 'Hello,');
  lines.push('');
  if (isFollowUp) {
    lines.push('We are following up on our earlier request.');
    lines.push('');
  }
  lines.push(opening);
  lines.push('');
  if (items.length === 0) {
    lines.push('  - The document named on the page linked below');
  }
  for (const item of items) {
    lines.push(item.explanation ? `  - ${item.name}: ${item.explanation}` : `  - ${item.name}`);
  }
  lines.push('');
  lines.push(
    names.length > 1
      ? 'Please send us the current versions using the link below. No account or login is needed.'
      : 'Please send us the current version using the link below. No account or login is needed.',
  );
  lines.push('');
  lines.push('If you have already sent it, or it is no longer issued, reply to this email and let us know.');
  lines.push('');
  lines.push('Thank you,');
  if (requesterName) lines.push(requesterName);
  lines.push(tenantName);

  return { subject, body: lines.join('\n') };
}

/** Shown on the approval screen where the real URL will go. */
export const RENEWAL_LINK_PLACEHOLDER = '[the secure upload link is added here when the email is sent]';

/**
 * The block the system appends below the approved body. Fixed wording; the
 * only variable is the URL.
 */
export function renewalRequestLinkBlock(url: string): string {
  return [
    'Upload the document here (no login needed):',
    url,
    '',
    'This link is for your organization only. Sent on behalf of the sender through SupDox.',
  ].join('\n');
}

/** The exact plain text that leaves: the approved body, then the link block. */
export function renewalRequestEmailText(body: string, url: string): string {
  return `${String(body ?? '').replace(/\s+$/, '')}\n\n${renewalRequestLinkBlock(url)}`;
}

/** Limits on what an approver may send. Generous: these stop accidents, not edits. */
export const RENEWAL_SUBJECT_MAX = 200;
export const RENEWAL_BODY_MAX = 5000;
