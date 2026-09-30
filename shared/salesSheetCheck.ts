/**
 * Is this "specification sheet" actually a SALES sheet? (rules table F6)
 *
 * AJ Conner, 2026-09-14: "Sales sheets are not spec sheets. The review step has
 * to catch a sales sheet submitted as a spec sheet." A sales sheet carries no
 * revision date and is not a controlled document; salespeople circulate them
 * and receiving teams accept them, and an auditor then finds a marketing flyer
 * filed as the product's specification. The table asks for two things: a
 * preset reject reason (`sales_sheet` in REJECTION_REASONS, shipped earlier)
 * and a document-type heuristic -- this file.
 *
 * WHAT IT READS. Only a document the queue already calls a specification
 * sheet (by its type, or by the classifier's guess when no type is set --
 * `looksLikeSpecSheetType`, the same name match renewal uses). On such a
 * document it looks for the marks of a CONTROLLED document:
 *
 *   - a revision / issue / effective / review / approval date, extracted
 *     (`revision_date`, `effective_date`, `issue_date`, `date_of_issue`) or
 *     printed ("Latest Rev: 2 Mar 2026", "Revision Date: 2/9/2024",
 *     "Issued February 6, 2026", "Approved by QA")
 *   - a document number or revision number ("FSQ-SPEC-0442 rev 9",
 *     "Supersedes rev 8", "Page 1 of 3")
 *
 * and for the marks of MARKETING copy ("Typical values ... are not
 * specifications", "Ask your rep for samples and pricing", "Why chefs love
 * it"). It WARNS when there is no controlled-document mark at all; marketing
 * copy only sharpens the wording. Marketing copy beside a real revision date
 * is a spec sheet with a friendly header, and says nothing.
 *
 * Measured before shipping: silent on all four real specification sheets in
 * tests/fixtures/real-corpus and all three in tests/fixtures/doctype-corpus,
 * fires on tests/fixtures/arrivals-demo's sales sheet. Pinned by
 * tests/unit/salesSheetCheck.test.ts.
 *
 * WARN, NEVER BLOCK -- the extractionInvariants discipline. The reviewer
 * decides; the warning names the preset reject reason so the send-back is one
 * click and is countable afterwards.
 *
 * PURE. No D1, no clock.
 */

import { looksLikeSpecSheetType } from './renewalPeriod';

export interface SalesSheetInput {
  /** The queue item's resolved type name, if any. */
  documentTypeName: string | null | undefined;
  /** The classifier's guess (processing_queue.document_type_guess) when no type is set. */
  documentTypeGuess?: string | null;
  /** The extraction (flat ai_fields), parsed. */
  fields?: Record<string, unknown> | null;
  /** The document's text layer / OCR text. */
  text: string | null | undefined;
}

export interface SalesSheetWarning {
  /** Always true when returned; a shape the UI can key on. */
  likely_sales_sheet: true;
  /** Marketing phrases found, verbatim (at most three), for the reviewer. */
  marketing_evidence: string[];
  /** One sentence for the reviewer. */
  message: string;
}

/** Extracted fields that are themselves a controlled-document date. */
const CONTROLLED_DATE_FIELDS = ['revision_date', 'effective_date', 'issue_date', 'date_of_issue'];

/**
 * Printed marks of a controlled document. Each wants a date, a number or a
 * named approver next to the word, so a sales sheet that merely says "issue"
 * or "version" in passing does not count as controlled.
 */
const CONTROLLED_MARKERS: RegExp[] = [
  /\b(?:latest\s+)?rev(?:ision)?\.?\s*(?:date|no\.?|#|number|level)?\s*[:#]?\s*[0-9A-Z]{1,3}\b/i,
  /\brev(?:ision|ised)?\b[^\n]{0,24}\d{1,4}[/.\- ]\w{1,9}[/.\- ]\d{2,4}/i,
  /\bsupersedes?\b/i,
  /\b(?:issued?|issue\s+date|date\s+of\s+issue|effective(?:\s+date)?|next\s+review|review(?:ed)?\s+date)\b[^\n]{0,20}\d{1,4}[/.\- ]\w{1,9}[/.\- ]?\d{0,4}/i,
  /\bapproved\s+by\b/i,
  /\bdoc(?:ument)?\.?\s*(?:no\.?|#|number|id)\s*[:#]?\s*\S+/i,
  /\bpage\s+\d+\s+of\s+\d+\b/i,
  /\b[A-Z]{2,6}-SPEC-\d+/,
];

/** Marketing copy. Any one is evidence; none is required to warn. */
const MARKETING_MARKERS: RegExp[] = [
  /typical values?[^\n.]{0,80}not (?:a )?specifications?/i,
  /(?:for information only|informational purposes only)/i,
  /\b(?:samples?\s+and\s+pricing|request (?:a )?(?:quote|samples?)|contact your (?:sales )?rep|ask your [^\n]{0,30}\brep\b)/i,
  /\bwhy [^\n]{0,40}\b(?:love|choose)\b/i,
  /\b(?:order (?:today|now)|call (?:us )?today)\b/i,
  /\b(?:great in|perfect for|ideal for)\b/i,
];

function hasControlledDateField(fields: Record<string, unknown> | null | undefined): boolean {
  if (!fields) return false;
  return CONTROLLED_DATE_FIELDS.some((k) => {
    const v = fields[k];
    return typeof v === 'string' ? v.trim() !== '' : v != null && v !== '';
  });
}

/** True when the queue item is being filed as a specification sheet. */
export function isSpecSheetCandidate(input: Pick<SalesSheetInput, 'documentTypeName' | 'documentTypeGuess'>): boolean {
  const name = (input.documentTypeName || '').trim();
  if (name) return looksLikeSpecSheetType(name);
  return looksLikeSpecSheetType((input.documentTypeGuess || '').trim());
}

/**
 * The warning for one queue item, or null. Never throws on odd input: no
 * text means nothing to judge, so null.
 */
export function salesSheetWarning(input: SalesSheetInput): SalesSheetWarning | null {
  if (!isSpecSheetCandidate(input)) return null;
  const text = input.text || '';
  if (!text.trim()) return null;
  if (hasControlledDateField(input.fields)) return null;
  if (CONTROLLED_MARKERS.some((re) => re.test(text))) return null;

  const evidence: string[] = [];
  for (const re of MARKETING_MARKERS) {
    const m = re.exec(text);
    if (m) evidence.push(m[0].replace(/\s+/g, ' ').trim().slice(0, 80));
    if (evidence.length >= 3) break;
  }
  const base =
    'This may be a sales sheet, not a specification: it carries no revision, issue or effective date and no document number, so it is not a controlled document.';
  return {
    likely_sales_sheet: true,
    marketing_evidence: evidence,
    message:
      evidence.length > 0
        ? `${base} It also reads as marketing copy ("${evidence[0]}"). If so, reject it as "Sales sheet, not a spec sheet" and ask the supplier for the specification.`
        : `${base} If it is, reject it as "Sales sheet, not a spec sheet" and ask the supplier for the specification.`,
  };
}
