/**
 * THE SHARING RULE -- may a document leave the organization, and on whose say
 * (decision C-003; C-038..C-042; migration 0137).
 *
 * Three answers, and each holds on EVERY way a file leaves:
 *
 *   free    send freely
 *   qa      needs QA approval before it leaves
 *   locked  never leaves
 *
 * WHERE THE ANSWER COMES FROM, most specific first (`effectiveSharingRule`):
 *
 *   1. the document's own override, set by a person with a reason;
 *   2. NO TYPE AT ALL -> locked (C-038: anything unclassified stays in);
 *   3. the rule stored on its document type;
 *   4. the type's NAME, matched against the starting table below;
 *   5. a name nobody recognises -> qa.
 *
 * WHAT "LEAVING" IS (C-039): a ZIP, an emailed link, a public link read, a
 * bundle ZIP, an order send or resend, and any file read made with an API key.
 * A logged-in person opening or downloading ONE file in the portal is not
 * leaving, whatever their role and whatever the rule.
 *
 * WHO MAY RELEASE (C-040, C-041): a `qa` document leaves only when a QA
 * releaser does the act themselves -- and that act IS the approval. An API key
 * never releases anything, whoever it belongs to. Nobody releases `locked`.
 *
 * ONE FILE, SEVERAL DOCUMENTS (C-042): a packet original, or a whole
 * multi-lot certificate, takes the strictest rule of the documents on it
 * (`strictest`).
 *
 * A BAD VALUE CAN ONLY TIGHTEN. `parseSharingRule` answers null for anything
 * that is not one of the three words, and every caller treats null as "not
 * stored" and falls through to a default that is never `free` by accident.
 *
 * A HOLD IS ASKED AT THE SAME DOORS (decision C-005, migration 0139,
 * shared/holds.ts). A certificate with an active hold does not pass any exit
 * that is "leaving", whatever its rule and whoever is asking: the verdict is
 * `held`, with the hold's own reason. Nobody releases a held document by
 * sending it. The hold is released first.
 *
 * PURE. No D1, no clock. The loader is functions/lib/sharing-rule.ts.
 */

import { looksLikeCoaType, looksLikeSpecSheetType } from './renewalPeriod';
import { holdRefusalText } from './holds';

export const SHARING_RULES = ['free', 'qa', 'locked'] as const;
export type SharingRule = (typeof SHARING_RULES)[number];

/** The words a person reads. Used by every screen and every refusal. */
export const SHARING_RULE_LABELS: Record<SharingRule, string> = {
  free: 'Send freely',
  qa: 'Needs QA approval',
  locked: 'Locked',
};

/** One sentence under the label, for the settings screens. */
export const SHARING_RULE_HELP: Record<SharingRule, string> = {
  free: 'Anyone who can see it may send it. API keys can read it.',
  qa: 'Leaves only when QA or an administrator sends it. API keys cannot read it.',
  locked: 'Never leaves the portal: no ZIP, no link, no order, no API key.',
};

export function parseSharingRule(raw: unknown): SharingRule | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return (SHARING_RULES as readonly string[]).includes(v) ? (v as SharingRule) : null;
}

// ---------------------------------------------------------------------------
// The starting table (C-003)
// ---------------------------------------------------------------------------

function normalizeTypeName(name: string | null | undefined): string {
  return (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Does the name match a row of the starting table? Returns null when it does
 * not, so a caller can tell "the table says qa" from "nobody recognised this".
 *
 * NARROW ON PURPOSE, and LOCKED IS ASKED FIRST. A false `free` is the expensive
 * direction: it lets something out. So `free` needs the document's own noun
 * (an allergen STATEMENT, a kosher CERTIFICATE), not merely the subject, and a
 * name that reads as an audit report is locked whatever else it says
 * ("Organic Audit Report" is a report).
 *
 * The COA and spec-sheet matches are `looksLikeCoaType` / `looksLikeSpecSheetType`
 * from shared/renewalPeriod.ts -- the same two name matches the renewal default
 * uses, so "what is a COA type called" is answered in one place.
 */
export function matchSharingRuleTable(name: string | null | undefined): SharingRule | null {
  const n = normalizeTypeName(name);
  if (!n) return null;

  // locked: audit report, W-9
  if (/\baudit\b.*\breports?\b/.test(n) || /\breports?\b.*\baudit\b/.test(n)) return 'locked';
  if (/\bw\s?9\b/.test(n)) return 'locked';

  // qa: audit certificate, HACCP / food safety plan, letter of guarantee, insurance
  if (/\baudit\b/.test(n)) return 'qa';
  if (/\bhaccp\b/.test(n) || /\bfood\s+safety\s+plans?\b/.test(n)) return 'qa';
  if (/\bletters?\s+of\s+guarantee\b/.test(n) || /\bguarantee\s+letters?\b/.test(n)) return 'qa';
  if (/\binsurance\b/.test(n)) return 'qa';

  // free: COA, spec sheet, allergen statement, kosher / halal / organic
  // certificates, SDS
  if (looksLikeCoaType(n)) return 'free';
  if (looksLikeSpecSheetType(n)) return 'free';
  if (/\bm?sds\b/.test(n) || /\bsafety\s+data\s+sheets?\b/.test(n)) return 'free';
  if (/^allergens?$/.test(n) || /\ballergens?\s+(statements?|declarations?|letters?)\b/.test(n)) return 'free';
  if (
    /\b(kosher|halal|organic)\b/.test(n) &&
    (/^(kosher|halal|organic)$/.test(n) || /\b(certificates?|certifications?|certs?|letters?)\b/.test(n))
  ) {
    return 'free';
  }

  return null;
}

/**
 * The rule a document type starts life with, from its name. A name the table
 * does not recognise is `qa` (C-038): a person looks before it goes.
 */
export function defaultSharingRuleForTypeName(name: string | null | undefined): SharingRule {
  return matchSharingRuleTable(name) ?? 'qa';
}

// ---------------------------------------------------------------------------
// The effective rule of one document
// ---------------------------------------------------------------------------

export type SharingRuleSource =
  /** A person set it on this document. */
  | 'override'
  /** The document has no type. */
  | 'no_type'
  /** Stored on the document type. */
  | 'type'
  /** Not stored; the type's name matched the starting table. */
  | 'type_name'
  /** Not stored, and the name is not in the table. */
  | 'unrecognised';

export interface EffectiveSharingRule {
  rule: SharingRule;
  source: SharingRuleSource;
}

export function effectiveSharingRule(input: {
  override?: unknown;
  typeRule?: unknown;
  typeName?: string | null;
  hasType: boolean;
}): EffectiveSharingRule {
  const override = parseSharingRule(input.override);
  if (override) return { rule: override, source: 'override' };
  if (!input.hasType) return { rule: 'locked', source: 'no_type' };
  const stored = parseSharingRule(input.typeRule);
  if (stored) return { rule: stored, source: 'type' };
  const matched = matchSharingRuleTable(input.typeName);
  if (matched) return { rule: matched, source: 'type_name' };
  return { rule: 'qa', source: 'unrecognised' };
}

/** Why this rule, in words, for the document page. */
export function sharingRuleSourceLabel(source: SharingRuleSource): string {
  switch (source) {
    case 'override':
      return 'set on this document';
    case 'no_type':
      return 'this document has no type';
    case 'type':
      return "this document type's rule";
    case 'type_name':
      return 'the default for a type with this name';
    case 'unrecognised':
      return 'the default for a type the portal does not recognise';
  }
}

// ---------------------------------------------------------------------------
// Strictest of several
// ---------------------------------------------------------------------------

const STRICTNESS: Record<SharingRule, number> = { free: 0, qa: 1, locked: 2 };

/**
 * The strictest of several rules (C-042). An EMPTY list is `locked`: a file
 * that cannot be tied to any document is unclassified, and unclassified stays
 * in.
 */
export function strictest(rules: readonly SharingRule[]): SharingRule {
  if (rules.length === 0) return 'locked';
  let out: SharingRule = 'free';
  for (const r of rules) if (STRICTNESS[r] > STRICTNESS[out]) out = r;
  return out;
}

// ---------------------------------------------------------------------------
// Judging one exit
// ---------------------------------------------------------------------------

/**
 * The ways a file is read out of storage toward a person or a system.
 *
 *   portal_file   one file opened or downloaded in the portal (also the
 *                 packet original, and a queue / arrival file served from an
 *                 approved document). Not "leaving" for a logged-in person.
 *   zip           the search export ZIP
 *   send          the emailed link
 *   public_link   a recipient reading an already-minted link
 *   bundle        the bundle ZIP
 *   order_send    an order's attachments, first send or resend
 */
export const SHARING_EXITS = ['portal_file', 'zip', 'send', 'public_link', 'bundle', 'order_send'] as const;
export type SharingExit = (typeof SHARING_EXITS)[number];

export interface ExitActor {
  /**
   * How the request was authenticated. `link` is the recipient of a public
   * export link: no account at all.
   */
  method: 'jwt' | 'api_key' | 'link';
  /**
   * Resolved by `canReleaseQa`. Ignored for an API key. For a `link` it is
   * asked of the PERSON WHO MINTED THE LINK, at the moment of the read (C-045):
   * the recipient has no authority of their own, only the sender's.
   */
  canReleaseQa: boolean;
}

export type ExitVerdict = 'allow' | 'needs_qa' | 'locked' | 'held';

/**
 * May this rule pass this exit for this actor?
 *
 *   - `locked` passes exactly one door: a logged-in person opening one file.
 *   - An API key reads `free` only, on every exit (C-041).
 *   - A public link read (C-045) serves `free`, and serves `qa` ONLY WHILE THE
 *     PERSON WHO MINTED THE LINK MAY RELEASE QA DOCUMENTS. "The mint was the
 *     approval" is true only of a releaser's mint: a link an ordinary user
 *     sent while the document was `free` (or before the rule existed) approved
 *     nothing, and stops serving the document once it becomes `qa`. `locked`
 *     is never served.
 *   - Everything else that leaves: `free` for anyone, `qa` for a QA releaser.
 *
 * `held` (migration 0139) IS ASKED FIRST. A document with an active hold passes
 * exactly one door, the same one `locked` passes: a logged-in person opening
 * one file in the portal. Everything else answers `held` -- for a QA releaser
 * and an administrator too, for an API key, and for a link minted before the
 * hold was placed. `held` outranks `needs_qa` and `locked` so that the answer
 * a person reads is the one they can act on first (release the hold), and so a
 * `qa` document on hold is never queued for a QA release it could not get.
 */
export function judgeExit(rule: SharingRule, exit: SharingExit, actor: ExitActor, held = false): ExitVerdict {
  if (held && !(exit === 'portal_file' && actor.method === 'jwt')) return 'held';
  if (actor.method === 'api_key') {
    return rule === 'free' ? 'allow' : rule === 'qa' ? 'needs_qa' : 'locked';
  }
  if (exit === 'public_link') {
    if (rule === 'locked') return 'locked';
    if (rule === 'free') return 'allow';
    // `qa`: only on the minter's authority, and a link is the only actor with
    // a minter. Anything else asking for this exit is a caller mistake.
    return actor.method === 'link' && actor.canReleaseQa ? 'allow' : 'needs_qa';
  }
  if (actor.method === 'link') {
    // A link holder has exactly one exit. Anything else is a caller mistake,
    // and a mistake must not open a door.
    return rule === 'free' ? 'allow' : rule === 'qa' ? 'needs_qa' : 'locked';
  }
  if (exit === 'portal_file') return 'allow';
  if (rule === 'free') return 'allow';
  if (rule === 'locked') return 'locked';
  return actor.canReleaseQa ? 'allow' : 'needs_qa';
}

/** The refusal reasons a response names. `allow` is not a refusal. */
export type SharingRefusalReason = Exclude<ExitVerdict, 'allow'>;

/**
 * One sentence for a refused document. `apiKey` changes only the `needs_qa`
 * wording: for a key there is nobody to ask, the answer is "not with a key".
 * `hold` is the active hold behind a `held` refusal: "On hold: <reason>".
 */
export function sharingRefusalMessage(
  reason: SharingRefusalReason,
  opts: { apiKey?: boolean; hold?: { reason?: string | null; lot_label?: string | null } | null } = {},
): string {
  if (reason === 'held') return holdRefusalText(opts.hold);
  if (reason === 'locked') return 'Locked: this document does not leave the portal.';
  return opts.apiKey
    ? 'Needs QA approval: an API key can read only documents marked "Send freely".'
    : 'Needs QA approval: only QA or an administrator can send this document.';
}

// ---------------------------------------------------------------------------
// Saying what was left out
// ---------------------------------------------------------------------------

/** The word for a `held` refusal, beside the three rule labels. */
export const HELD_LABEL = 'On hold';

/** How many titles one sentence names before it says "and N more". */
export const REFUSAL_NAMES_SHOWN = 6;

function nameList(titles: string[]): string {
  const shown = titles.slice(0, REFUSAL_NAMES_SHOWN).map((t) => t.trim() || 'Untitled document');
  const more = titles.length - shown.length;
  return more > 0 ? `${shown.join(', ')}, and ${more} more` : shown.join(', ');
}

/**
 * What an exit left out, in words, naming each document under its reason:
 *
 *   "3 documents were not included. Locked: Tax form, Unsorted scan.
 *    Needs QA approval: Guarantee letter. On hold: Lot 1042 certificate."
 *
 * ONE wording for the server's refusal and for every screen that reports a
 * partial one, so a ZIP, a send, a bundle and an order cannot describe the
 * same rule four ways. Returns '' when nothing was left out.
 */
export function describeRefusals(
  refused: readonly { title?: string | null; reason: SharingRefusalReason }[],
): string {
  if (refused.length === 0) return '';
  const held = refused.filter((r) => r.reason === 'held').map((r) => r.title ?? '');
  const locked = refused.filter((r) => r.reason === 'locked').map((r) => r.title ?? '');
  const qa = refused.filter((r) => r.reason === 'needs_qa').map((r) => r.title ?? '');
  const n = refused.length;
  const parts = [`${n} document${n === 1 ? ' was' : 's were'} not included.`];
  if (locked.length > 0) parts.push(`${SHARING_RULE_LABELS.locked}: ${nameList(locked)}.`);
  if (qa.length > 0) parts.push(`${SHARING_RULE_LABELS.qa}: ${nameList(qa)}.`);
  if (held.length > 0) parts.push(`${HELD_LABEL}: ${nameList(held)}.`);
  return parts.join(' ');
}

/**
 * Read the `id:reason,id:reason` header a binary response carries
 * (`X-Export-Refused-Ids`, `X-Bundle-Refused-Ids`). Anything malformed is
 * skipped rather than guessed at.
 */
export function parseRefusedHeader(
  value: string | null | undefined,
): { document_id: string; reason: SharingRefusalReason }[] {
  if (!value) return [];
  const out: { document_id: string; reason: SharingRefusalReason }[] = [];
  for (const part of value.split(',')) {
    const at = part.lastIndexOf(':');
    if (at <= 0) continue;
    const id = part.slice(0, at).trim();
    const reason = part.slice(at + 1).trim();
    if (id && (reason === 'locked' || reason === 'needs_qa' || reason === 'held')) out.push({ document_id: id, reason });
  }
  return out;
}

/** Is `after` a LOOSER rule than `before` (free < qa < locked)? */
export function loosens(before: SharingRule, after: SharingRule): boolean {
  return STRICTNESS[after] < STRICTNESS[before];
}
