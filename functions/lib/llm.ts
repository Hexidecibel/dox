import type { ParsedQuery } from '../../shared/types';
import { resolveModel, noteServedModel, invalidateModelCache } from './models';
import type { ModelTag } from './models';

export interface ExtractionResult {
  fields: Record<string, string | null>;    // ALL key-value pairs found
  tables: Array<{ name: string; headers: string[]; rows: string[][] }>;
  products: string[];
  summary: string;
  confidence: 'high' | 'medium' | 'low';
  documentType: string | null;
  raw_response?: string;
  /**
   * The model id the router ACTUALLY served, including quantization
   * (e.g. "unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q5_K_M"). Recorded so any grading
   * or parity run can prove which model produced a result.
   */
  served_model?: string;
}

const BASE_PROMPT = `You are a document data extraction assistant specializing in supply chain and compliance documents including Certificates of Analysis (COAs), Bills of Lading, Spec Sheets, Safety Data Sheets, and invoices.

DOCUMENT TYPES:
- Certificate of Analysis (COA): Lab/QA results proving a product batch meets specifications. Structure: header info (supplier, customer, dates, lot) + test results table + approval.
- Bill of Lading (BOL): Shipping document with carrier, origin, destination, weights.
- Spec Sheet: Product specification with allowable ranges for tests.
- Invoice / PO: Purchase order or invoice with line items, quantities, prices.
- Safety Data Sheet (SDS): Chemical safety information.
- Certificates and statements: certificate of insurance, letter of guarantee, allergen statement, organic / kosher / gluten-free / non-GMO certificate, third-party audit certificate, country-of-origin statement, specification sheet. These attest something about a company, a site or a product LINE; they carry no measured lot results. A document is a Certificate of Analysis ONLY when it reports MEASURED RESULTS for a specific lot or batch — the word "certificate" in a title is not enough, and misreading a certificate as a COA is the single most common document-type error.

FIELD EXTRACTION RULES:
1. Use these EXACT canonical field names (snake_case):
   - supplier_name — company/organization that PRODUCED, TESTED, or SHIPPED the product. This is typically the company on the letterhead, the lab that ran the tests, or the "From" entity. NOT the customer/recipient. If only an address is visible with no company name, look for the company name in: letterhead, "Approved by" signatures, facility name, or document footer. Set to null only if truly unidentifiable.
   - customer_name — company RECEIVING the product. Often labeled "Ship To", "Customer", "Sold To", or "Attention". If a company name appears prominently but is clearly the recipient (e.g., appears after "Ship To:"), it is the customer, NOT the supplier.
   - product_name — full product name (e.g., "Unsalted Sweet Cream Butter 68#")
   - product_code — supplier's internal product/item code or SKU
   - customer_item_number — the CUSTOMER's own item number for this product, printed by the supplier and labelled as the customer's ("CUSTOMER ITEM #", "Customer Item", "Cust. Item No.", "Your Item #"). It is the buyer's SKU: NOT the supplier's item code (that is product_code), and NOT an order, invoice, sales order or PO number — never put it in order_number. Null when the page prints none.
   - lot_number — the lot or run number. Also the batch number, but ONLY when the document prints no separate lot; if it prints both, this is the lot.
   - batch_number — a batch identifier printed ALONGSIDE a separate lot ("Batch Number", "Batch", "Batch Code"). Null when the document prints only one of the two.
   - po_number — purchase order number
   - code_date — production/pack/code date
   - expiration_date — the PRODUCT's expiration, best-by, use-by, or sell-by date. This is SHELF LIFE: when the material stops being good. It says nothing about how long the paperwork is valid.
   - document_expires_on — the date THE DOCUMENT ITSELF stops being valid, when the document states one. ONLY certificates carry this: a certificate of insurance (the "Expiration Date" of the policy period), a certification (organic, kosher, halal, non-GMO, GFSI/SQF/BRC), a third-party audit certificate, a licence or registration. A COA, spec sheet, BOL or invoice does NOT have one — a COA's printed expiry is the PRODUCT's shelf life and belongs in expiration_date, never here. Never put the same date in both fields, and never infer this one: if the document is not a certificate stating its own validity period, return null.
   - effective_date — the date THIS DOCUMENT took effect, which is the date any renewal period is counted FROM. Take a printed "Effective Date", "Valid From", "In force from", "Inception", or the START of a stated policy or validity period; only when the document states none of those, take the date it was ISSUED or dated ("Issue Date", "Date Issued", "Issued", "Statement date", "Letter dated"). IT IS NOT AN EXPIRY — a certificate of insurance prints BOTH, and the policy period's START is this field while its END is document_expires_on; never put the same date in both. Nor is it a product date (expiration_date, code_date), an audit, test or print date, or the date a RELATIONSHIP began ("registered since", "supervision commenced", "certification first granted"). A VERSIONED document (a specification, a safety data sheet) carries both: a date labelled as a REVISION belongs in revision_date, and a date labelled "Issued" or "Issue Date" or "Effective" is this field even when the same page prints a revision or version number. Rule 7 governs: if the document prints no such date, this is null.
   - ship_date — date shipped
   - grade — quality grade (e.g., "Grade A", "Grade AA", "US Extra")
   - plant_number — facility ID or plant number
   - net_weight — net weight with units
   - order_number — sales order or reference number. A number labelled as the customer's item is NOT an order number; it is customer_item_number.
   - issuing_body — on a CERTIFICATE, the organisation that ISSUED it: the certifying agent, certification body, registrar, auditing firm, insurer or insurance broker whose name is on the letterhead. It is NOT the company being certified — that is supplier_name (rule 6). An ACCREDITATION body, which accredits the certifier rather than issuing this certificate (ANAB, IAF, a national accreditation service), is not the issuer.
   - certificate_number — the certificate's OWN number, as printed and labelled ("Certificate No.", "Cert #", "Certificate ID"). A policy number, a form number, an audit report number, a customer's item number and a document revision number are NOT certificate numbers. When the page prints none, this is null however many other numbers it prints.
   - scheme — the standard or programme a certification was granted against, as printed (e.g. "SQF Food Safety Code for Manufacturing Edition 9", "BRCGS Food Safety Issue 9", "FSSC 22000 v6", "USDA National Organic Program").
   - kosher_status — the kosher designation the certificate gives the certified products (e.g. "Dairy", "Pareve", "Meat", "Dairy Equipment"). Null when none is printed.
   - gluten_threshold — the gluten threshold the certification was granted against, EXACTLY as printed, with its unit ("10 ppm", "< 20 ppm"). A citation of a regulation or standard (21 CFR 101.91, Codex Alimentarius) is NOT a threshold — a document may cite the rule and print no figure at all. If no figure is printed this is null: rule 7 governs, and the well-known regulatory number is exactly the value you must not supply.
   - allergens — the allergens present IN the product's formulation, as printed, comma-separated. An allergen named only to say it is ABSENT ("contains no peanut"), and an allergen named only as a shared-line, shared-facility or cross-contact risk, is not present in the formulation.
   - country_of_origin — the country the document declares the GOODS THEMSELVES originate in. The origin of the packaging, the address of a testing laboratory, a port of transhipment, a corporate head office and a market the goods may not be exported to are NOT the origin of the goods.
   - revision_date — the date THIS VERSION of the document was issued or revised ("Revision Date", "Revised", "Version date"), on documents that carry versions — a safety data sheet, a specification. A print date, a page-footer date and a supersedes date are not revision dates.
   - signatory — the PRINTED NAME of the person who signed or authorised the document ("Jane Ruiz, QA Manager" gives "Jane Ruiz"). Rule 3 still bars the signature MARK: take a name that is typed or printed on the page, never one read out of a handwritten squiggle, and return null when no name is printed.

2. For dates: normalize to YYYY-MM-DD. Two-digit years mean 2000s (e.g., '26 = 2026, 03/08/26 = 2026-03-08). Julian dates (e.g., "6094") mean day 094 of 2026 — convert when identifiable. If ambiguous, keep as-is.

3. DO NOT include: addresses, phone/fax/email, page numbers, print dates, header/footer boilerplate, signature marks, titles, disclaimers, individual test values (those go in tables). The one carve-out is the signer's PRINTED NAME, which goes in signatory (rule 1): a name typed under a signature line is data a reviewer needs to chase a document, while the handwritten mark above it is not, and reading a name out of a squiggle is invention.

4. FILENAME CONTEXT: The filename is provided in <filename> tags. It often contains metadata like item numbers, product codes, lot numbers, and dates. Use this as supplementary context when the document text is incomplete or ambiguous, but prefer values from the document body when both are available.

5. SUPPLIER vs CUSTOMER: A common error is confusing supplier and customer. The supplier PRODUCES the product; the customer RECEIVES it. If "MEDOSWEET FARMS" appears after "Ship To:", it is the customer_name, not the supplier_name. The company at the TOP of the document (letterhead, header) is usually the supplier.

6. ON A CERTIFICATE THE LETTERHEAD IS THE ISSUER, NOT THE SUPPLIER. Rule 5's "company at the TOP is usually the supplier" is a COA heuristic and it is backwards here: an insurance certificate is printed on the broker's or insurer's paper, an organic or kosher certificate on the certifying agency's, an audit certificate on the certification body's. The SUBJECT of the certificate — the insured, the guarantor, the certified operation, the audited site, the company the statement is made ABOUT — is the supplier_name, and it is usually named in the body after "issued to", "this is to certify that", "certifies that", "the insured is", "certified operation" or "audited site". The organisation on the letterhead goes in issuing_body, so both are captured and neither is filed under the other's name. If you cannot tell which company is the subject, leave supplier_name null rather than falling back to the letterhead.

7. NEVER SUPPLY A FIELD VALUE THE DOCUMENT DID NOT PRINT. This is TABLE EXTRACTION RULE 14 applied to fields. If the page states no certificate number, no threshold, no expiry, no origin, the field is null — do not fill it from a regulation you know, from a different number printed elsewhere on the page, or from what documents of this kind usually say. A field a reviewer can see is empty is a gap somebody can close; a plausible value the page does not contain is a false record nobody will ever re-check.

TABLE EXTRACTION RULES:
1. Extract ALL tabular data found in the document. Preserve every column present — do not drop columns.
2. Name tables descriptively: "test_results", "line_items", "physical_properties", "microbiological_analysis", "sensory_analysis", etc.
3. Use the column headers exactly as they appear in the document. If no headers exist, infer them from context.
4. For a COA test-result table use EXACTLY these header names, in this order, dropping only the ones the document has no data for: ["test", "result", "unit", "specification", "pass_fail"]. Do not invent spellings ("units", "unit_of_measure", "value", "uom") and do not reorder them. Rule 3 governs every table that is NOT a test-result table.
5. Preserve units (CFU/mL, %, mg/kg, etc.) and pass/fail values as written.
6. Multiple distinct tables in the document → separate entries for each (e.g., physical tests and microbiological tests should be separate tables).
7. Keep row order as it appears in the document.
8. ONE ANALYTE PER ROW, AND "test" HOLDS ONLY THE ANALYTE NAME. "test" is the name of a single measured analyte and nothing else. Never join two analytes into one label ("Coliform Aerobic"), and never append a dilution ratio ("Coliform 1:1"), a weekday, a sample name, an incubator temperature, or the result itself. If you cannot name exactly one analyte for a row, do not emit that row.
9. A SAMPLE x ANALYTE MATRIX IS NOT ONE ROW. When a micro block runs SAMPLES down the side (Buffer, Blank, Control, Negative, Product, or the product's own name) and ANALYTES across the top, read the PRODUCT sample's row and emit ONE result row per ANALYTE COLUMN, taking "test" from that column's header. Buffer / Blank / Control / Negative rows are lab controls: never emit them as results. If the same analyte heading appears twice across the top, the second group is almost always a dilution or condition group (see rule 10), not a second result.
10. DILUTIONS, INCUBATION AND CLOCK TIMES ARE PROCESS METADATA, NOT RESULTS. A dilution ratio (1:1, 1-10, 1:100), an incubator temperature, and DATE IN / TIME IN / DATE OUT / TIME OUT describe how the test was run, not what it found. Never put one in "result" and never fold one into "test". Capture them, if at all, in a separate table named "test_conditions".
11. REGULATORY THRESHOLDS INSIDE CERTIFICATION TEXT ARE NOT RESULTS. Numbers that appear inside a certification, attestation or compliance sentence — e.g. "produced from raw milk meeting the somatic cell (400,000 per ml.) and bacteria standard plate count (100,000 per ml.) requirements of regulation (EC) No 853/2004" — are the REGULATION'S limits, not this lot's measured values. Never emit a result row for them, in any column. This is the "lab consumables are never product data" rule applied to legal boilerplate.
12. EVERY CELL IN A ROW COMES FROM THAT ROW'S OWN PRINTED LINE. Never carry a value in from a neighbouring row, a different block, the letterhead or the footer. A phone number, a clock time, a plate/reagent lot code or a document id sitting in "result" is always wrong — leave the cell empty instead. Likewise, a "specification" only belongs to a row if the document printed it on that row; do not reuse one analyte's limit as another analyte's spec.
13. A CELL YOU CANNOT READ IS EMPTY, NOT GUESSED. Emit "" rather than inventing a plausible number, and lower _confidence.
14. NEVER SUPPLY A UNIT, SPEC OR VERDICT THE DOCUMENT DID NOT PRINT. "unit" is empty unless the unit is printed on that row or in that column's heading. Do not infer one from the analyte ("a coliform count must be CFU/mL"), and never copy one out of an example in these instructions. An invented unit is WORSE than no unit: a result carrying a unit the document never stated cannot be compared against a configured limit, so it is dropped from checking without anyone noticing. The same applies to "specification" and "pass_fail" — empty unless the document printed them.

OCR / SCANNED DOCUMENT HANDLING:
- If text appears garbled, do your best but set _confidence to "low"
- Common OCR errors: l↔1, O↔0, rn↔m. Infer correct values from context.
- Partially readable values: include what you can and append "(?)".

Return JSON with:
{
  "fields": { ... },
  "tables": [{ "name": "string", "headers": [...], "rows": [[...]] }],
  "products": ["product name 1", ...],
  "summary": "one-sentence description",
  "_confidence": "high" | "medium" | "low",
  "document_type": "Certificate of Analysis" | "Bill of Lading" | etc.
}`;

export const INDUSTRY_PROMPTS: Record<string, string> = {
  DAIRY_FOOD: `
ORG CONTEXT:
[Describe your organization and what these documents are for — edit this. e.g. "We are a dairy distributor managing supplier Certificates of Analysis for regulatory compliance. Lot traceability is critical; every document must be tied to a lot."]

INDUSTRY CONTEXT — Dairy & Food:
- Common COA tests: Standard Plate Count (SPC), coliform, E. coli, yeast & mold, somatic cell count, butterfat %, moisture %, pH, acidity, temperature
- Grade designations: Grade A, Grade AA, US Extra, USDA grades
- Plant/facility numbers: USDA plant numbers (e.g., "Plant 42-1234")
- Code dates may use Julian format (YDDD where Y=last digit of year, DDD=day)
- Net weights: common units are lbs, gallons, kg

DAIRY COA DOMAIN RULES (hard rules — follow exactly):
- Lab consumables are NEVER product data. Reagent / control / buffer lot numbers (e.g. 3M Petrifilm CC/AC/BUFFER lots and their expirations), dilution rows, plate-incubation tables, and incubator temperatures must never be bound to a product field. A reagent lot mistaken for the product's lot is the single worst error.
- Certification / legal boilerplate numbers are reference, not results. Numbers inside raw-milk certification clauses or regulatory citations (e.g. "standard plate count 100,000 per ml", "somatic cell 400,000 per ml") are reference thresholds, NOT this product's measured values. Do not extract them as results.
- Capture specifications verbatim; NEVER derive pass/fail. Copy the spec string exactly as printed. Leave pass/fail empty unless the document itself prints an explicit verdict — the human decides conformance.
- Result is not the spec. When a table has Spec and Result columns, the measured value is the Result; never report the spec/limit as the result.
- Lot is the most important field and keys every record. If there is no explicit lot label but a CODE DATE / DATE CODE is present, it may serve as the lot — capture it as the lot, and also keep it in its own date field.
- A missing required pathogen result (Listeria, Salmonella) is a GAP, not a pass — return null; do not infer absence.
- Capture yeast/mold and sensory (flavor / color / odor) exactly as printed — never auto-combine, split, or collapse them.
- Normalize dates to YYYY-MM-DD; when numeric order is genuinely ambiguous (e.g. 03/04/26 could be Mar or Apr), keep as-is rather than guess.

EXAMPLE — Dairy COA extraction:
Input: "Darigold Inc. COA for Grade AA Butter 68#, Lot L26-0842, PO PO-44821, Packed 03/15/26, Best By 09/15/26, Plant 42-1234. Tests: Fat >80% result 81.2% Pass, Moisture <16% result 15.4% Pass, Coliform <10 CFU/g result <1 Pass, SPC <20000 CFU/g result 4500 Pass"

Output:
{
  "fields": {
    "supplier_name": "Darigold Inc.",
    "product_name": "Grade AA Butter 68#",
    "lot_number": "L26-0842",
    "po_number": "PO-44821",
    "code_date": "2026-03-15",
    "expiration_date": "2026-09-15",
    "grade": "Grade AA",
    "plant_number": "42-1234",
    "net_weight": "68 lbs"
  },
  "tables": [{
    "name": "test_results",
    "headers": ["test", "test_method", "specification", "result", "units", "pass_fail"],
    "rows": [
      ["Fat Content", "SMEDP 15.122", ">80%", "81.2", "%", "Pass"],
      ["Moisture", "SMEDP 15.122", "<16%", "15.4", "%", "Pass"],
      ["Coliform", "AOAC 989.10", "<10", "<1", "CFU/g", "Pass"],
      ["Standard Plate Count", "AOAC 989.10", "<20,000", "4,500", "CFU/g", "Pass"]
    ]
  }],
  "products": ["Grade AA Butter 68#"],
  "summary": "COA for Darigold Grade AA Butter lot L26-0842, all tests pass.",
  "_confidence": "high",
  "document_type": "Certificate of Analysis"
}`,
};

/**
 * The seeded default for a tenant's editable extraction_context (the dairy
 * "industry layer"). When a tenant has no custom extraction_context, this string
 * occupies the industry-layer slot. Served by GET /api/tenant-extraction-context
 * as `default_template` so the editor UI can seed without duplicating the text.
 */
export const DEFAULT_DAIRY_CONTEXT = INDUSTRY_PROMPTS.DAIRY_FOOD;

/**
 * Strip unfilled editor placeholders out of an industry-context block before it
 * is sent to the model.
 *
 * The industry layer is a WHOLE BLOCK — either a tenant's editable
 * `extraction_context` (migration 0072) or the DEFAULT_DAIRY_CONTEXT seed below.
 * There is no per-tenant "org description" field that fills a slot in it, so the
 * `ORG CONTEXT:` heading and its `[Describe your organization … edit this]` line
 * are an instruction to the HUMAN editing the template (it is served verbatim as
 * `default_template` so the editor UI can seed itself). Unedited — the current
 * state for every tenant — that bracketed instruction ships straight to the
 * model on every call. Keep the affordance in the template; drop it from the
 * wire.
 *
 * DELIBERATELY CONSERVATIVE — it drops WHOLE paragraphs, never individual
 * lines. A paragraph is removed only when every one of its lines is blank, a
 * heading (`Something:`), or a prose placeholder, AND at least one line is a
 * placeholder. Line-level deletion was tried first and was WRONG: the regex
 * also matched `["Standard Plate Count", "AOAC 989.10", ...]` inside this
 * file's own worked-example JSON and silently deleted a row of it.
 *
 * A "prose placeholder" is a whole line that is entirely `[ ... ]` whose body
 * starts with a letter and reads as prose (>= 3 words). JSON array lines start
 * with `"`, `{`, `[` or a digit and are therefore never candidates.
 *
 * KEEP IN SYNC with `stripUnfilledPlaceholders` in bin/process-worker.
 */
export function stripUnfilledPlaceholders(context: string): string {
  if (!context) return context;
  const isPlaceholder = (line: string): boolean => {
    const m = line.trim().match(/^\[([A-Za-z][^\]]*)\]$/);
    return !!m && m[1].trim().split(/\s+/).length >= 3;
  };
  const isHeading = (line: string): boolean => /:\s*$/.test(line.trim());
  return context
    .split(/\n{2,}/)
    .filter((block) => {
      const lines = block.split('\n');
      if (!lines.some(isPlaceholder)) return true;                     // nothing to strip
      return !lines.every((l) => !l.trim() || isHeading(l) || isPlaceholder(l));
    })
    .join('\n\n');
}

/**
 * Header for the authored-guidance block — the document-type layer (migration
 * 0098) and the (supplier, document_type) layer (0035), already composed
 * general -> specific by `composeInstructions` before they get here.
 *
 * THE LAST SENTENCE IS LOAD-BEARING, not politeness. Authored guidance is free
 * text written by a reviewer, and a sentence like "results on this COA are in
 * CFU/g" reads to a model as permission to STAMP that unit on rows the page
 * printed bare. TABLE EXTRACTION RULE 14 exists because an invented unit is
 * worse than no unit — a result carrying a unit the document never stated
 * cannot be matched against a configured limit, so it drops out of spec
 * checking silently. Guidance may say where to look; it may never say what the
 * page said.
 *
 * KEEP IN SYNC with GUIDANCE_BLOCK_HEADER in bin/process-worker — the worker is
 * the surface that actually runs the corpus, this one serves email ingest, and
 * tests/unit/extractionGuidanceBlock.test.ts pins them together.
 */
export const GUIDANCE_BLOCK_HEADER = [
  '## Reviewer instructions',
  'The following guidance was authored by the people who review these documents. Some of it describes this KIND of document from any supplier; some of it describes one supplier specifically, and where the two disagree the supplier-specific text wins. Follow it carefully.',
  'It tells you WHERE to look and WHAT to pull out. It never overrides the extraction rules below, and it never licenses you to supply a unit, specification or verdict the document did not print — if the guidance names one and the page does not, the page wins and the cell stays empty.',
].join('\n');

/**
 * Wrap authored guidance in its labelled block and put it AHEAD of the prompt.
 *
 * Composition, not substitution: the guidance is prepended as its own block and
 * the base rules below it are untouched. That is the semantics the supplier
 * layer has always had with BASE_PROMPT, and the type layer now joins it on the
 * same terms. (Only the tenant industry layer replaces anything, and what it
 * replaces is a default template — see `stripUnfilledPlaceholders` above.)
 *
 * No-op on empty guidance, so a tenant with nothing authored gets byte-identical
 * prompt text to what it got before this layer existed.
 *
 * KEEP IN SYNC with prependReviewerInstructions in bin/process-worker.
 */
export function prependGuidance(prompt: string, instructions?: string | null): string {
  if (!instructions || !instructions.trim()) return prompt;
  return `${GUIDANCE_BLOCK_HEADER}\n\n${instructions.trim()}\n\n---\n\n${prompt}`;
}

/**
 * The block that tells extraction what the classification pass already decided.
 *
 * It is CONTEXT, not an instruction to conform. A classifier that is wrong
 * about the page must not be able to talk the extractor into reporting fields
 * that kind of document usually has — hence the last two sentences, and hence
 * the pointer back to rule 7. Without them, handing the model a type is exactly
 * the licence to invent that rule 14 and rule 7 exist to withhold.
 *
 * KEEP IN SYNC with classifiedTypeBlock in bin/process-worker.
 */
export function classifiedTypeBlock(documentType: string): string {
  return [
    '',
    'DOCUMENT TYPE — ALREADY DETERMINED:',
    `A separate classification pass read this page against this organisation's own list of document types and identified it as: ${documentType}.`,
    'Read the page as that kind of document, and return that exact name in "document_type".',
    'If the page is plainly not that kind of document, extract what the page actually says and report the type it really is. The classification tells you where to look; it never licenses a value the page does not print (FIELD EXTRACTION rule 7).',
  ].join('\n');
}

function buildPrompt(options?: {
  examples?: Array<{ text: string; result: string }>;
  industryPrompt?: string;
  /**
   * Authored guidance for this document — the composed type + supplier stack
   * (`effective_instructions`), NOT one layer of it. Composing is the caller's
   * job because only the caller knows which layers resolved.
   */
  instructions?: string | null;
  /**
   * The document type the classification pass settled on, when one ran. Null /
   * omitted is the honest "nobody could type this" case and leaves the prompt
   * byte-identical to what it was before the classifier existed.
   */
  documentType?: string | null;
}): string {
  const { examples, industryPrompt = INDUSTRY_PROMPTS.DAIRY_FOOD, instructions, documentType } = options || {};

  let prompt = BASE_PROMPT;

  // Immediately after the base rules and ahead of the industry layer: the
  // extractor should know what it is reading before it is told how this
  // industry writes things.
  if (documentType && documentType.trim()) {
    prompt += '\n' + classifiedTypeBlock(documentType.trim());
  }

  if (industryPrompt) {
    prompt += '\n' + stripUnfilledPlaceholders(industryPrompt);
  }

  if (examples && examples.length > 0) {
    prompt += '\n\nHere are examples of correct extractions for this document type:\n';
    examples.forEach((ex, i) => {
      prompt += `\nExample ${i + 1}:\nInput (excerpt): ${ex.text.substring(0, 500)}\nCorrect output: ${ex.result}\n`;
    });
  }

  // Guidance goes on LAST so it ends up FIRST in the assembled text, ahead of
  // the base rules and the industry layer — same position the worker has always
  // put reviewer instructions in.
  return prependGuidance(prompt, instructions);
}

// ---------------------------------------------------------------------------
// Document-type classification — its own pass, BEFORE extraction
// ---------------------------------------------------------------------------

/**
 * One document type the tenant actually files. `name` is what the model is
 * asked to choose and what comes back; `slug` and `id` are carried through so
 * the caller can resolve the answer to a row without a second lookup.
 */
export interface DocumentTypeCandidate {
  id?: string;
  name: string;
  slug?: string | null;
}

export interface ClassificationResult {
  /**
   * The chosen candidate's name, VERBATIM from the list, or null. Null means
   * either "none of these" or an answer that did not resolve to a candidate —
   * `rawGuess` says which. Never a name the caller did not offer.
   */
  documentType: string | null;
  /** The matched candidate, when the answer resolved to one. */
  candidate: DocumentTypeCandidate | null;
  /** What the model actually said, before validation. Kept for the reviewer. */
  rawGuess: string | null;
  confidence: 'high' | 'medium' | 'low';
  /** A short phrase the model quotes from the page. Diagnostic only. */
  evidence: string | null;
  served_model?: string;
}

/**
 * How much of the document the classifier reads.
 *
 * A document announces what it is in its title block and its first operative
 * sentence. Nothing on page 4 changes the answer, and paying 35B prefill for
 * page 4 to decide "this is a Kosher Certificate" is waste. 3000 characters is
 * roughly the first page of a text-layer PDF and comfortably covers the header
 * of an OCR'd scan, where the top of the page is also where OCR is cleanest.
 */
export const CLASSIFIER_TEXT_BUDGET = 3000;

/**
 * The classifier prompt, minus the candidate list, which is per tenant.
 *
 * WHY THIS IS A SEPARATE PASS AT ALL. `document_type` used to fall out of the
 * extraction call, which made it a by-product of the very call that most needs
 * it: the document-type instruction layer (migration 0098) is KEYED on the
 * type, so guidance could only ever be applied on a re-extraction, and the pass
 * that decided the type was by definition the unguided one. Measured on the
 * document-type corpus that cost 21 of 40 documents — every organic, kosher,
 * gluten-free and third-party-audit certificate came back "Certificate of
 * Analysis", so the guidance missed exactly the documents written for it.
 *
 * WHY THE CANDIDATE LIST. The old prompt asked for a free-form string and
 * offered five example types, four of which are COA-adjacent. The consumer has
 * always been an EXACT match against the tenant's catalog (`fuzzyMatchDocType`
 * promotes on 'exact' only), so a free-form guess was being graded against a
 * closed list it was never shown. Showing it is the whole fix.
 *
 * WHY "none" IS A FIRST-CLASS ANSWER. A confidently wrong type silently selects
 * the wrong instruction block for every future document like it. An honest
 * unknown parks the item for a human, which is what `document_type_id` staying
 * NULL already means, and what `documents.classification_status` (migration
 * 0081) was built to count.
 *
 * WHY THE FILENAME IS NOT SUPPLIED. Filenames are the tenant's, not the
 * document's: "scan0043.pdf", or a name that says COA because a broker's mailer
 * says COA. The worker's own FIELD EXTRACTION rule 4 already restricts the
 * filename to supplier context for exactly this reason. Classification reads
 * the page.
 *
 * KEEP IN SYNC with CLASSIFIER_PROMPT in bin/process-worker;
 * tests/unit/documentClassifier.test.ts pins the two together.
 */
export const CLASSIFIER_PROMPT = `You are a document classifier for a food-safety and supply-chain document library.

You are given the beginning of ONE document and the list of document types this organisation actually files. Decide which ONE type names what this document IS.

HOW TO DECIDE:
- Read the title block, the letterhead and the operative sentence ("This is to certify that...", "We hereby guarantee...", "Results of analysis for the lot below...").
- Classify by what the document DOES, not by what it mentions. A certificate that names a product is still a certificate. An audit certificate that cites test standards is not a Certificate of Analysis.
- A Certificate of Analysis reports MEASURED RESULTS for a specific lot or batch. If the page reports no measured results for a lot, it is NOT a Certificate of Analysis, however often the word "certificate" appears.
- The organisation on the letterhead of a certificate is usually the body that ISSUED it, not the company it is about. Its line of business does not decide the type.
- Choose the name from the list VERBATIM. Do not invent a name, do not abbreviate one, and do not merge two.

WHEN NOTHING FITS:
Answer "none". An honest "none" sends the document to a human, which is correct. A confident wrong type is worse than no type: it silently applies the wrong reading instructions to every document like this one.

Return JSON only:
{
  "document_type": "<exact name from the list>" | "none",
  "confidence": "high" | "medium" | "low",
  "evidence": "<up to 12 words quoted from the document that decided it>"
}`;

/** Case/punctuation-fold a type name. Mirrors bin/process-worker's fuzzyMatchDocType. */
export function normalizeTypeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Resolve a model answer to one of the offered candidates — EXACT (normalized)
 * name or slug only.
 *
 * Deliberately not fuzzy. The whole point of handing over the list is that the
 * answer should already be a member of it; an answer that is not is evidence
 * the model went its own way, and substring-matching it back onto a candidate
 * would manufacture the confident wrong type this pass exists to avoid. The
 * unresolved answer is still returned as `rawGuess` for the reviewer.
 */
export function matchCandidate(
  guess: string | null,
  candidates: DocumentTypeCandidate[],
): DocumentTypeCandidate | null {
  if (!guess || !guess.trim()) return null;
  const g = normalizeTypeName(guess);
  if (!g || g === 'none') return null;
  for (const c of candidates) {
    if (normalizeTypeName(c.name) === g) return c;
    if (c.slug && normalizeTypeName(c.slug) === g) return c;
  }
  return null;
}

/**
 * Classify one document against the tenant's own type catalog.
 *
 * Runs on the `fast` chain by default: this is a short prompt, a short answer,
 * and one of the two places a human is waiting (the review queue). Today `fast`
 * and `best` resolve to the same weights on the same host, so the tag is a
 * statement of intent rather than a saving — the saving is the input, which is
 * a page instead of a document, and the output, which is one line instead of a
 * full extraction.
 *
 * Never throws for a classification reason: an unreadable or unparseable answer
 * is 'none' with low confidence, because a document nobody could type is a
 * document for a human, not a failed job. Transport errors do propagate — the
 * caller decides whether to extract unclassified or retry.
 */
export async function classifyDocumentType(
  text: string,
  candidates: DocumentTypeCandidate[],
  env: { QWEN_URL?: string; QWEN_SECRET?: string },
  options?: { modelTag?: ModelTag },
): Promise<ClassificationResult> {
  const empty: ClassificationResult = {
    documentType: null, candidate: null, rawGuess: null, confidence: 'low', evidence: null,
  };
  if (!text || !text.trim() || candidates.length === 0) return empty;

  const tag: ModelTag = options?.modelTag || 'fast';
  const baseUrl = (env.QWEN_URL || 'http://127.0.0.1:9600').replace(/\/+$/, '');
  const resolution = await resolveModel(tag, env);

  const list = candidates.map((c) => `- ${c.name}`).join('\n');
  const systemPrompt = `${CLASSIFIER_PROMPT}\n\nDOCUMENT TYPES THIS ORGANISATION FILES:\n${list}\n- none`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.QWEN_SECRET ? { Authorization: `Bearer ${env.QWEN_SECRET}` } : {}),
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: resolution.model,
        temperature: 0,
        // One short JSON object. Generous enough for a long type name plus the
        // evidence phrase, small enough that a rambling answer is cut off
        // rather than paid for.
        max_tokens: 200,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `<document>\n${text.substring(0, CLASSIFIER_TEXT_BUDGET)}\n</document>\n\nWhich ONE of the listed document types is this? Return JSON only.`,
          },
        ],
      }),
    });
  } catch (err: unknown) {
    clearTimeout(timeout);
    invalidateModelCache(env);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Document classification timed out after 120 seconds');
    }
    throw new Error(`LLM server not reachable at ${baseUrl}. Is Qwen running?`);
  } finally {
    clearTimeout(timeout);
  }

  const data = await response.json() as {
    choices: { message: { content: string } }[];
    model?: string;
  };
  const servedModel = noteServedModel(tag, resolution.model, data.model);

  let content = (data.choices?.[0]?.message?.content || '')
    .replace(/<think>[\s\S]*?<\/think>\s*/g, '')
    .trim();
  const fence = content.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fence) content = fence[1].trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ...empty, served_model: servedModel };
  }

  const rawGuess = typeof parsed.document_type === 'string' && parsed.document_type.trim()
    ? parsed.document_type.trim()
    : null;
  const candidate = matchCandidate(rawGuess, candidates);
  const confidence = (['high', 'medium', 'low'].includes(parsed.confidence as string)
    ? parsed.confidence
    : 'low') as ClassificationResult['confidence'];

  return {
    // The candidate's OWN name, not the model's echo of it: downstream code
    // matches this against the catalog, so it must be the catalog's spelling.
    documentType: candidate ? candidate.name : null,
    candidate,
    rawGuess,
    confidence,
    evidence: typeof parsed.evidence === 'string' ? parsed.evidence.trim().slice(0, 200) : null,
    served_model: servedModel,
  };
}

const FIELD_ALIASES: Record<string, string[]> = {
  // The certificate wordings ('insured', 'guarantor', 'certified_operation', …)
  // are here because on a certificate the SUBJECT is the supplier for filing
  // purposes — see FIELD EXTRACTION rule 6. A certificate filed under the
  // certifying body instead of the company it certifies is invisible to the
  // gap engine, which only ever asks "what do we hold for THIS supplier".
  supplier_name: ['supplier', 'vendor', 'manufacturer', 'company', 'from', 'shipped_by', 'insured', 'insured_name', 'named_insured', 'guarantor', 'certified_operation', 'certified_company', 'certified_site', 'audited_site', 'registered_organization'],
  customer_name: ['customer', 'sold_to', 'ship_to', 'buyer', 'consignee', 'certificate_holder', 'addressee'],
  // 'batch*' is deliberately NOT here — see batch_number below and the
  // promotion step in canonicalizeFields.
  lot_number: ['lot_no', 'lot_num', 'lot', 'run_number', 'lot_code'],
  batch_number: ['batch', 'batch_no', 'batch_code'],
  po_number: ['po', 'purchase_order', 'purchase_order_number', 'po_no'],
  product_name: ['product', 'item', 'material', 'description', 'item_description'],
  product_code: ['item_code', 'sku', 'material_code', 'item_number', 'item_no'],
  // The BUYER's item number, printed by the supplier (CMF "CUSTOMER ITEM #").
  // Its own field so it is never filed as order_number (Phase 3). KEEP IN SYNC
  // with functions/lib/llm.ts / bin/process-worker.
  customer_item_number: ['customer_item', 'customer_item_no', 'customer_item_num', 'cust_item_number', 'cust_item_no', 'customer_sku', 'customer_part_number', 'your_item_number'],
  expiration_date: ['exp_date', 'best_by', 'use_by', 'best_before', 'sell_by', 'bb_date'],
  // Certificate-validity wordings ONLY. Deliberately no generic 'exp_date' /
  // 'expiry' here: those are the PRODUCT's shelf life and must stay on
  // expiration_date, or every COA acquires a document expiry again.
  document_expires_on: ['valid_until', 'valid_through', 'valid_to', 'certificate_expiry', 'certificate_expiration', 'certificate_valid_until', 'policy_expiration', 'policy_expiry'],
  // The ANCHOR a renewal period is counted FROM (shared/renewalPeriod.ts,
  // tiers 5-7). Issue / effective wordings ONLY. Deliberately no bare 'date'
  // and no 'document_date': on these documents that is as often a print date as
  // an issue date, and a period counted from the wrong day is a renewal alert
  // sent on the wrong day. KEEP IN SYNC with bin/process-worker.
  effective_date: ['issue_date', 'date_issued', 'issued', 'issued_on', 'date_of_issue', 'certificate_issue_date', 'certificate_date', 'statement_date', 'letter_date', 'valid_from', 'effective', 'effective_from', 'effective_on', 'policy_effective_date', 'inception', 'inception_date'],
  // production_date is NOT an alias of code_date. It used to be here, which made
  // the two the SAME field, so a COA printing both (Andersen's 2026 layout:
  // 'Production Date 7-31-26' and 'Code Date (Expiration) 8-22-26', three weeks
  // apart) could not represent them separately — and a production-date search
  // matched a code date. bin/process-worker split them first; this copy had
  // drifted. KEEP IN SYNC with bin/process-worker.
  code_date: ['pack_date', 'code_dt'],
  production_date: ['mfg_date', 'manufacture_date', 'date_of_manufacture', 'prod_date'],
  ship_date: ['shipping_date', 'date_shipped'],
  net_weight: ['weight', 'net_wt'],
  order_number: ['order_no', 'sales_order', 'reference_number', 'ref_number'],
  grade: ['quality_grade', 'usda_grade'],
  plant_number: ['plant_no', 'facility_number', 'facility_id', 'plant_id'],
  // Certificate / statement fields (2026-09-02). Deliberately NARROW: only
  // spellings that can mean nothing else. Generic keys a model reaches for —
  // 'origin', 'country', 'standard', 'status', 'threshold', 'limit',
  // 'contains', 'result' — are left alone, because folding one of those onto a
  // canonical name silently rewrites a value whose meaning we did not check.
  issuing_body: ['issued_by', 'certifying_body', 'certification_body', 'certifier', 'certifying_agent', 'certification_agent', 'certification_agency', 'issuer', 'registrar'],
  certificate_number: ['certificate_no', 'certificate_num', 'cert_number', 'cert_no', 'certificate_id'],
  allergens: ['allergen', 'allergen_statement', 'allergen_declaration', 'declared_allergens', 'allergens_present'],
  country_of_origin: ['origin_country', 'country_of_manufacture'],
  scheme: ['certification_scheme', 'audit_standard', 'certification_standard', 'certification_program'],
  kosher_status: ['kosher_designation'],
  gluten_threshold: ['gluten_limit', 'gluten_ppm'],
  revision_date: ['revised', 'date_revised', 'sds_revision_date', 'version_date'],
  signatory: ['signed_by', 'signer', 'signer_name', 'authorized_by', 'authorised_by', 'authorized_representative', 'approved_by', 'signature'],
};

/** Blank, null, or whitespace — the shape of "the model gave us nothing". */
function isEmptyValue(v: unknown): boolean {
  return v == null || (typeof v === 'string' && v.trim() === '');
}

/** Exported for tests — pure, and the behaviour it encodes is load-bearing. */
export function canonicalizeFields(fields: Record<string, any>): Record<string, any> {
  const reverseMap: Record<string, string> = {};
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      reverseMap[alias] = canonical;
    }
  }

  // TWO PASSES, AND THE ORDER MATTERS. Keep in sync with the identical function
  // in bin/process-worker.
  //
  // One pass with first-writer-wins made the result depend on the order the
  // MODEL happened to emit its keys. A COA printing both "Lot#: 6203G" and
  // "Batch Number: 2586083" could have the batch land in `lot_number` purely
  // because it came first, silently discarding the real lot. An EXACT canonical
  // key is better evidence than an alias and wins regardless of order.
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!(key in reverseMap)) result[key] = value;
  }
  for (const [key, value] of Object.entries(fields)) {
    const canonical = reverseMap[key];
    if (!canonical) continue;
    if (!(canonical in result) || result[canonical] == null) {
      result[canonical] = value;
    }
  }

  // A batch number IS the lot when the document prints no separate lot. It
  // stops being true the moment a document prints both.
  if (isEmptyValue(result.lot_number) && !isEmptyValue(result.batch_number)) {
    result.lot_number = result.batch_number;
    delete result.batch_number;
  }

  return result;
}

function isLikelyAddress(value: any): boolean {
  if (!value || typeof value !== 'string') return false;
  const v = value.trim();
  const streetPattern = /^\d+\s+(N\.?|S\.?|E\.?|W\.?|North|South|East|West|Main)\b/i;
  const unitStreetPattern = /^[A-Z0-9#]+\s+\d+\s+\w/i;
  const stateZipPattern = /\b[A-Z]{2}\s+\d{5}(-\d{4})?\b/;
  const streetSuffixes = /\b(Street|St\.?|Avenue|Ave\.?|Boulevard|Blvd\.?|Road|Rd\.?|Drive|Dr\.?|Lane|Ln\.?|Way|Court|Ct\.?|Place|Pl\.?)\b/i;
  if ((streetPattern.test(v) || unitStreetPattern.test(v)) && (stateZipPattern.test(v) || streetSuffixes.test(v))) {
    return true;
  }
  if (stateZipPattern.test(v) && streetSuffixes.test(v)) {
    return true;
  }
  return false;
}

export async function extractFields(
  text: string,
  env: { QWEN_URL?: string; QWEN_SECRET?: string },
  options?: {
    examples?: Array<{ text: string; result: string }>;
    industryPrompt?: string;
    fileName?: string;
    /**
     * Authored extraction guidance — the composed document-type + supplier
     * stack from GET /api/extraction-instructions (`effective_instructions`).
     * Omitted means "nothing authored", which is the pre-0098 behaviour.
     */
    instructions?: string | null;
    /**
     * What `classifyDocumentType` decided, when it ran. Passing it lets the
     * extractor read the page as the right kind of document; omitting it is the
     * pre-classifier behaviour, which the email-ingest path still uses when it
     * has no tenant catalog to classify against.
     */
    documentType?: string | null;
  }
): Promise<ExtractionResult> {
  if (!text || text.trim().length === 0) {
    return { fields: {}, tables: [], products: [], summary: '', confidence: 'low', documentType: null };
  }

  const baseUrl = (env.QWEN_URL || 'http://127.0.0.1:9600').replace(/\/+$/, '');
  const systemPrompt = buildPrompt(options);

  // Health-aware resolution: best available model in the `best` chain.
  const resolution = await resolveModel('best', env);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300_000);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.QWEN_SECRET ? { Authorization: `Bearer ${env.QWEN_SECRET}` } : {}),
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: resolution.model,
        temperature: 0,
        max_tokens: 2048,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            // NO ` /no_think` SUFFIX — do not re-add it. Measured INERT on the
            // `best` chain (Qwen3.6-35B-A3B): identical output and zero
            // `reasoning_content` with and without it, because that chat
            // template defaults thinking OFF. The real switch is a request-body
            // field: `chat_template_kwargs: { enable_thinking: true }`.
            role: 'user',
            content: `${options?.fileName ? `<filename>${options.fileName}</filename>\n` : ''}<document>\n${text}\n</document>\n\nExtract ALL structured data from this document. Return JSON only.`,
          },
        ],
      }),
    });
  } catch (err: unknown) {
    clearTimeout(timeout);
    // The request failed — the cached health snapshot may be stale (a backend
    // just went away). Drop it so the next call re-resolves immediately
    // instead of waiting out the TTL.
    invalidateModelCache(env);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('LLM request timed out after 300 seconds');
    }
    throw new Error(`LLM server not reachable at ${baseUrl}. Is Qwen running?`);
  } finally {
    clearTimeout(timeout);
  }

  const data = await response.json() as {
    choices: { message: { content: string }; finish_reason?: string }[];
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };

  // Record what actually served us — the true id including quantization.
  const servedModel = noteServedModel('best', resolution.model, data.model);

  // llama.cpp runs with `ctx_shift = false`, so a generation that hits the
  // context boundary just STOPS and reports finish_reason: "length". The JSON
  // that comes back is truncated, and the catch below turns any parse failure
  // into an empty-but-valid result — so a completion cut off at the ceiling
  // posts as a SUCCESSFUL extraction with zero fields. That is the failure class
  // MODELS.md says the flat field aggregate has been blind to four separate
  // times, and it is invisible here because nothing throws. Raise a real error
  // instead. Nothing measured today is close to the ceiling; this is insurance.
  // (Deliberately worded to avoid "unknown model" / "no healthy upstream for
  // model" so isModelUnavailableError() can never read it as a routing fault —
  // retrying the same prompt against the same model would just truncate again.)
  if (data.choices?.[0]?.finish_reason === 'length') {
    const usage = data.usage || {};
    const counts = (['prompt_tokens', 'completion_tokens', 'total_tokens'] as const)
      .filter((k) => typeof usage[k] === 'number')
      .map((k) => `${k}=${usage[k]}`)
      .join(' ');
    throw new Error(
      `LLM completion truncated at the context limit (finish_reason=length) from ` +
      `"${data.model || resolution.model}"${counts ? ` [${counts}]` : ''} — the returned ` +
      `JSON is incomplete, so this extraction is being failed rather than parsed into an ` +
      `empty result. Shrink the input or raise the served context window; retrying as-is will truncate again.`
    );
  }

  let content = data.choices?.[0]?.message?.content || '';

  // Strip Qwen3 <think>...</think> blocks (thinking model artifacts)
  content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();

  // Strip markdown code fences if present
  content = content.trim();
  const fenceMatch = content.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch) {
    content = fenceMatch[1].trim();
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { fields: {}, tables: [], products: [], summary: '', confidence: 'low', documentType: null, raw_response: content, served_model: servedModel };
  }

  const products = Array.isArray(parsed.products)
    ? (parsed.products as string[])
    : [];

  const confidence = (['high', 'medium', 'low'].includes(parsed._confidence as string)
    ? parsed._confidence
    : 'low') as ExtractionResult['confidence'];

  const tables = Array.isArray(parsed.tables)
    ? (parsed.tables as ExtractionResult['tables'])
    : [];

  const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
  const documentType = typeof parsed.document_type === 'string' ? parsed.document_type : null;

  // Build fields from the "fields" object, or from top-level non-reserved keys
  const fields: Record<string, string | null> = {};
  const rawFields = (typeof parsed.fields === 'object' && parsed.fields !== null && !Array.isArray(parsed.fields))
    ? parsed.fields as Record<string, unknown>
    : parsed;
  const reservedKeys = new Set(['fields', 'tables', 'products', 'summary', '_confidence', 'document_type']);

  for (const [key, value] of Object.entries(rawFields)) {
    if (!key.startsWith('_') && !reservedKeys.has(key)) {
      if (value === null || value === undefined) {
        fields[key] = null;
      } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        fields[key] = String(value);
      } else if (Array.isArray(value)) {
        if (value.every(v => typeof v === 'string' || typeof v === 'number')) {
          fields[key] = value.join(', ');
        } else {
          fields[key] = JSON.stringify(value);
        }
      } else if (typeof value === 'object') {
        // Flatten nested object: { customer: { name: "ACME", city: "LA" } }
        // becomes: { customer_name: "ACME", customer_city: "LA" }
        for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
          if (subValue !== null && subValue !== undefined) {
            fields[`${key}_${subKey}`] = typeof subValue === 'object' ? JSON.stringify(subValue) : String(subValue);
          }
        }
      }
    }
  }

  const canonicalized = canonicalizeFields(fields);
  if (canonicalized.supplier_name && isLikelyAddress(canonicalized.supplier_name)) {
    canonicalized.supplier_name = null;
  }
  return { fields: canonicalized, tables, products, summary, confidence, documentType, served_model: servedModel };
}

const DATE_ROLES: ReadonlyArray<unknown> = ['production', 'code', 'expiration', 'ship', 'uploaded'];

export async function parseNaturalQuery(
  query: string,
  documentTypes: { slug: string; name: string }[],
  products: { name: string }[],
  suppliers: { name: string }[],
  env: { QWEN_URL?: string; QWEN_SECRET?: string }
): Promise<ParsedQuery> {
  const baseUrl = (env.QWEN_URL || 'http://127.0.0.1:9600').replace(/\/+$/, '');
  const today = new Date().toISOString().split('T')[0];

  const systemPrompt = [
    'You are a document search query parser for a compliance document management system.',
    'Parse natural language queries into structured search parameters.',
    'Return ONLY a valid JSON object.',
    '',
    `Today's date: ${today}`,
    '',
    'AVAILABLE DOCUMENT TYPES:',
    ...documentTypes.map(dt => `- slug: "${dt.slug}", name: "${dt.name}"`),
    ...(documentTypes.length === 0 ? ['(none configured yet)'] : []),
    '',
    'AVAILABLE PRODUCTS:',
    ...products.slice(0, 50).map(p => `- "${p.name}"`),
    ...(products.length === 0 ? ['(none yet)'] : []),
    '',
    'AVAILABLE SUPPLIERS:',
    ...suppliers.slice(0, 50).map(s => `- "${s.name}"`),
    ...(suppliers.length === 0 ? ['(none yet)'] : []),
    '',
    'METADATA FIELDS (stored on documents):',
    '- lot_number: batch/lot identifier',
    '- po_number: purchase order number',
    '- order_number: sales order / reference number',
    '- expiration_date: PRODUCT expiration / shelf life (YYYY-MM-DD)',
    '- document_expires_on: the date the DOCUMENT itself stops being valid — a certificate of insurance, a certification, an audit certificate (YYYY-MM-DD). Never a COA.',
    '- production_date: the date the product was MADE — "production date", "produced", "manufactured", "mfg", "pack date", "packed" (YYYY-MM-DD)',
    '- code_date: the CODE date printed on the product — only when the query says "code date" (YYYY-MM-DD). It is NOT the production date.',
    '- ship_date: shipping date (YYYY-MM-DD)',
    '- grade: quality grade (e.g., "Grade A", "Grade AA")',
    '- plant_number: facility ID',
    '- net_weight: weight with units',
    '- product_code: supplier item code / SKU',
    '',
    'OUTPUT JSON SCHEMA:',
    '{',
    '  "keywords": string[],           // general search terms not matched elsewhere',
    '  "document_type_slug": string|null, // exact slug from available types',
    '  "product_text": string|null,    // the product EXACTLY as the person named it, pack and attributes included:',
    '                                   // "bulk unsalted butter", "300 gal tote", "5 gallon bags", "2235", "810004"',
    '  "product_names": string[],      // matching product names — use fuzzy matching!',
    '                                   // "creams" → ["Sweet Cream Butter 68#", "Cream - Light 23%"]',
    '                                   // Include ALL products that relate to the query term',
    '  "supplier_name": string|null,   // best-matching supplier name from list, or user\'s text if no match',
    '  "date_from": string|null,       // YYYY-MM-DD, resolve relative: "last month" → first day of prev month',
    '  "date_to": string|null,         // YYYY-MM-DD, resolve relative: "last month" → last day of prev month',
    '  "date_role": "production"|"code"|"expiration"|"ship"|"uploaded"|null, // WHICH date date_from/date_to mean',
    '  "metadata_filters": [           // structured field queries',
    '    { "field": "lot_number", "operator": "equals"|"contains"|"gt"|"lt", "value": "..." }',
    '  ],',
    '  "expiration_filter": {          // for expiration-related queries',
    '    "operator": "before"|"after"|"between",',
    '    "date1": "YYYY-MM-DD",        // "expiring soon" → before date(today + 30 days)',
    '    "date2": "YYYY-MM-DD"         // only for "between"',
    '  } | null,',
    '  "content_search": string|null,  // free-text to search in document content',
    '                                   // "failing test results", "high coliform" → search extracted text',
    '  "intent_summary": string        // human-readable: "COAs for cream products expiring within 30 days"',
    '}',
    '',
    'RULES:',
    '1. Fuzzy product matching: "butter" matches any product with "butter" in the name. Return ALL matches.',
    '2. Fuzzy supplier matching: "darigold" matches "Darigold, Inc." — pick the closest match.',
    '3. Temporal reasoning: "expiring soon" = expiration_date within 30 days. "expiring" without qualifier = within 30 days.',
    '4. "from last month" or "in March" → set date_from and date_to to that range. date_role says WHICH date: "produced in March" → "production"; "code date in March" → "code"; "uploaded / added / received last month" → "uploaded". A date printed on the document is never "uploaded".',
    '4a. A single production date ("produced 7/31/26", "production date 22-Jul-2026", "packed on 9/2") → metadata_filters with field=production_date, operator=equals, value YYYY-MM-DD. Use code_date ONLY when the query says "code date". Never put a production date in date_from/date_to with date_role "uploaded".',
    '5. Lot/PO numbers: "lot 776764" → metadata_filters with field=lot_number, operator=equals.',
    '5a. PRODUCT TEXT: copy the words that name the product into product_text verbatim — the product words, its pack size ("5 gallon bag", "300 gal tote", "55.115#", "25kg", "half gallon") and its attributes ("unsalted", "U/S", "NS", "salted"). A pack size or an attribute is PART OF THE PRODUCT: never drop it, and never put it only in keywords. A bare product or item number ("2235", "810004", "10286") is product_text too, not a lot and not an order number. Do not include the supplier, the dates, or words like "COA".',
    '6. If query mentions test results, coliform, bacteria, etc. → use content_search.',
    '7. Always provide intent_summary — a clear one-line description of what was understood.',
    '8. Don\'t force matches — if nothing matches a field, leave it null/empty.',
  ].join('\n');

  const resolution = await resolveModel('best', env);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300_000);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.QWEN_SECRET ? { Authorization: `Bearer ${env.QWEN_SECRET}` } : {}),
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: resolution.model,
        temperature: 0,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            // No ` /no_think` — inert on the `best` chain (Qwen3.6 defaults
            // thinking OFF); the real switch is chat_template_kwargs.enable_thinking.
            role: 'user',
            content: `Parse this search query: "${query}"`,
          },
        ],
      }),
    });
  } catch (err: unknown) {
    clearTimeout(timeout);
    invalidateModelCache(env);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('LLM request timed out after 300 seconds');
    }
    throw new Error(`LLM server not reachable at ${baseUrl}. Is Qwen running?`);
  } finally {
    clearTimeout(timeout);
  }

  const data = await response.json() as {
    choices: { message: { content: string } }[];
    model?: string;
  };

  noteServedModel('best', resolution.model, data.model);

  let content = data.choices?.[0]?.message?.content || '';

  // Strip Qwen3 <think>...</think> blocks (thinking model artifacts)
  content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();

  const fenceMatch = content.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch) {
    content = fenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(content);
    return {
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
      document_type_slug: parsed.document_type_slug || null,
      product_names: Array.isArray(parsed.product_names) ? parsed.product_names :
        (parsed.product_name ? [parsed.product_name] : []),
      product_text: typeof parsed.product_text === 'string' && parsed.product_text.trim() ? parsed.product_text.trim() : null,
      date_from: parsed.date_from || null,
      date_to: parsed.date_to || null,
      date_role: DATE_ROLES.includes(parsed.date_role) ? parsed.date_role : null,
      supplier_name: parsed.supplier_name || null,
      metadata_filters: Array.isArray(parsed.metadata_filters) ? parsed.metadata_filters : [],
      expiration_filter: parsed.expiration_filter || null,
      content_search: parsed.content_search || null,
      intent_summary: parsed.intent_summary || query,
    };
  } catch {
    // Fallback: treat entire query as keywords
    return {
      keywords: query.split(/\s+/).filter(Boolean),
      document_type_slug: null,
      product_names: [],
      product_text: null,
      date_from: null,
      date_to: null,
      date_role: null,
      supplier_name: null,
      metadata_filters: [],
      expiration_filter: null,
      content_search: null,
      intent_summary: query,
    };
  }
}
