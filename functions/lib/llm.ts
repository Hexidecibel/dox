import type { ParsedQuery } from '../../shared/types';

export interface ExtractionResult {
  fields: Record<string, string | null>;    // ALL key-value pairs found
  tables: Array<{ name: string; headers: string[]; rows: string[][] }>;
  products: string[];
  summary: string;
  confidence: 'high' | 'medium' | 'low';
  documentType: string | null;
  raw_response?: string;
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
   - supplier_name — company/organization name that produced/shipped the product (NOT a street address — if only an address is visible with no company name, set to null)
   - customer_name — company receiving the product
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
INDUSTRY CONTEXT — Dairy & Food:
- Common COA tests: Standard Plate Count (SPC), coliform, E. coli, yeast & mold, somatic cell count, butterfat %, moisture %, pH, acidity, temperature
- Grade designations: Grade A, Grade AA, US Extra, USDA grades
- Plant/facility numbers: USDA plant numbers (e.g., "Plant 42-1234")
- Code dates may use Julian format (YDDD where Y=last digit of year, DDD=day)
- Net weights: common units are lbs, gallons, kg

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

function buildPrompt(options?: { examples?: Array<{ text: string; result: string }>; industryPrompt?: string }): string {
  const { examples, industryPrompt = INDUSTRY_PROMPTS.DAIRY_FOOD } = options || {};

  let prompt = BASE_PROMPT;

  if (industryPrompt) {
    prompt += '\n' + industryPrompt;
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
  options?: { examples?: Array<{ text: string; result: string }>; industryPrompt?: string }
): Promise<ExtractionResult> {
  if (!text || text.trim().length === 0) {
    return { fields: {}, tables: [], products: [], summary: '', confidence: 'low', documentType: null };
  }

  const baseUrl = (env.QWEN_URL || 'http://127.0.0.1:9600').replace(/\/+$/, '');
  const systemPrompt = buildPrompt(options);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);

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
        model: 'Qwen3-5-35B-A3B',
        temperature: 0,
        max_tokens: 2048,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `<document>\n${text}\n</document>\n\nExtract ALL structured data from this document. Return JSON only. /no_think`,
          },
        ],
      }),
    });
  } catch (err: unknown) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('LLM request timed out after 180 seconds');
    }
    throw new Error(`LLM server not reachable at ${baseUrl}. Is Qwen running?`);
  } finally {
    clearTimeout(timeout);
  }

  const data = await response.json() as {
    choices: { message: { content: string } }[];
  };

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
    return { fields: {}, tables: [], products: [], summary: '', confidence: 'low', documentType: null, raw_response: content };
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
  return { fields: canonicalized, tables, products, summary, confidence, documentType };
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

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
        model: 'Qwen3-5-35B-A3B',
        temperature: 0,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `Parse this search query: "${query}" /no_think`,
          },
        ],
      }),
    });
  } catch (err: unknown) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('LLM request timed out after 30 seconds');
    }
    throw new Error(`LLM server not reachable at ${baseUrl}. Is Qwen running?`);
  } finally {
    clearTimeout(timeout);
  }

  const data = await response.json() as {
    choices: { message: { content: string } }[];
  };

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
