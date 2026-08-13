import type { ParsedQuery } from '../../shared/types';
import { resolveModel, noteServedModel, invalidateModelCache } from './models';

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

FIELD EXTRACTION RULES:
1. Use these EXACT canonical field names (snake_case):
   - supplier_name — company/organization that PRODUCED, TESTED, or SHIPPED the product. This is typically the company on the letterhead, the lab that ran the tests, or the "From" entity. NOT the customer/recipient. If only an address is visible with no company name, look for the company name in: letterhead, "Approved by" signatures, facility name, or document footer. Set to null only if truly unidentifiable.
   - customer_name — company RECEIVING the product. Often labeled "Ship To", "Customer", "Sold To", or "Attention". If a company name appears prominently but is clearly the recipient (e.g., appears after "Ship To:"), it is the customer, NOT the supplier.
   - product_name — full product name (e.g., "Unsalted Sweet Cream Butter 68#")
   - product_code — supplier's internal product/item code or SKU
   - lot_number — lot, batch, or run number
   - po_number — purchase order number
   - code_date — production/pack/code date
   - expiration_date — expiration, best-by, use-by, or sell-by date
   - ship_date — date shipped
   - grade — quality grade (e.g., "Grade A", "Grade AA", "US Extra")
   - plant_number — facility ID or plant number
   - net_weight — net weight with units
   - order_number — sales order or reference number

2. For dates: normalize to YYYY-MM-DD. Two-digit years mean 2000s (e.g., '26 = 2026, 03/08/26 = 2026-03-08). Julian dates (e.g., "6094") mean day 094 of 2026 — convert when identifiable. If ambiguous, keep as-is.

3. DO NOT include: addresses, phone/fax/email, page numbers, print dates, header/footer boilerplate, signatures, titles, disclaimers, individual test values (those go in tables).

4. FILENAME CONTEXT: The filename is provided in <filename> tags. It often contains metadata like item numbers, product codes, lot numbers, and dates. Use this as supplementary context when the document text is incomplete or ambiguous, but prefer values from the document body when both are available.

5. SUPPLIER vs CUSTOMER: A common error is confusing supplier and customer. The supplier PRODUCES the product; the customer RECEIVES it. If "MEDOSWEET FARMS" appears after "Ship To:", it is the customer_name, not the supplier_name. The company at the TOP of the document (letterhead, header) is usually the supplier.

TABLE EXTRACTION RULES:
1. Extract ALL tabular data found in the document. Preserve every column present — do not drop columns.
2. Name tables descriptively: "test_results", "line_items", "physical_properties", "microbiological_analysis", "sensory_analysis", etc.
3. Use the column headers exactly as they appear in the document. If no headers exist, infer them from context.
4. For COA test results, common columns include: test, test_method, unit_of_measure, specification, result, units, pass_fail — but extract whatever columns are present.
5. Preserve units (CFU/mL, %, mg/kg, etc.) and pass/fail values as written.
6. Multiple distinct tables in the document → separate entries for each (e.g., physical tests and microbiological tests should be separate tables).
7. Keep row order as it appears in the document.

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

function buildPrompt(options?: { examples?: Array<{ text: string; result: string }>; industryPrompt?: string }): string {
  const { examples, industryPrompt = INDUSTRY_PROMPTS.DAIRY_FOOD } = options || {};

  let prompt = BASE_PROMPT;

  if (industryPrompt) {
    prompt += '\n' + stripUnfilledPlaceholders(industryPrompt);
  }

  if (examples && examples.length > 0) {
    prompt += '\n\nHere are examples of correct extractions for this document type:\n';
    examples.forEach((ex, i) => {
      prompt += `\nExample ${i + 1}:\nInput (excerpt): ${ex.text.substring(0, 500)}\nCorrect output: ${ex.result}\n`;
    });
  }

  return prompt;
}

const FIELD_ALIASES: Record<string, string[]> = {
  supplier_name: ['supplier', 'vendor', 'manufacturer', 'company', 'from', 'shipped_by'],
  customer_name: ['customer', 'sold_to', 'ship_to', 'buyer', 'consignee'],
  lot_number: ['lot_no', 'lot_num', 'lot', 'batch_number', 'batch_no', 'batch', 'run_number', 'lot_code'],
  po_number: ['po', 'purchase_order', 'purchase_order_number', 'po_no'],
  product_name: ['product', 'item', 'material', 'description', 'item_description'],
  product_code: ['item_code', 'sku', 'material_code', 'item_number', 'item_no'],
  expiration_date: ['exp_date', 'best_by', 'use_by', 'best_before', 'sell_by', 'bb_date'],
  code_date: ['production_date', 'pack_date', 'mfg_date', 'manufacture_date', 'date_of_manufacture'],
  ship_date: ['shipping_date', 'date_shipped'],
  net_weight: ['weight', 'net_wt'],
  order_number: ['order_no', 'sales_order', 'reference_number', 'ref_number'],
  grade: ['quality_grade', 'usda_grade'],
  plant_number: ['plant_no', 'facility_number', 'facility_id', 'plant_id'],
};

function canonicalizeFields(fields: Record<string, any>): Record<string, any> {
  const reverseMap: Record<string, string> = {};
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      reverseMap[alias] = canonical;
    }
  }
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(fields)) {
    const canonical = reverseMap[key] || key;
    if (!(canonical in result) || result[canonical] == null) {
      result[canonical] = value;
    }
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
  options?: { examples?: Array<{ text: string; result: string }>; industryPrompt?: string; fileName?: string }
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
    '- expiration_date: product expiration (YYYY-MM-DD)',
    '- code_date: production/pack date (YYYY-MM-DD)',
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
    '  "product_names": string[],      // matching product names — use fuzzy matching!',
    '                                   // "creams" → ["Sweet Cream Butter 68#", "Cream - Light 23%"]',
    '                                   // Include ALL products that relate to the query term',
    '  "supplier_name": string|null,   // best-matching supplier name from list, or user\'s text if no match',
    '  "date_from": string|null,       // YYYY-MM-DD, resolve relative: "last month" → first day of prev month',
    '  "date_to": string|null,         // YYYY-MM-DD, resolve relative: "last month" → last day of prev month',
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
    '4. "from last month" or "in March" → set date_from and date_to to that range.',
    '5. Lot/PO numbers: "lot 776764" → metadata_filters with field=lot_number, operator=equals.',
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
      date_from: parsed.date_from || null,
      date_to: parsed.date_to || null,
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
      date_from: null,
      date_to: null,
      supplier_name: null,
      metadata_filters: [],
      expiration_filter: null,
      content_search: null,
      intent_summary: query,
    };
  }
}
