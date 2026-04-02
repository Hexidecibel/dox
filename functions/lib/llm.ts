import type { ParsedQuery } from '../../shared/types';

export interface ExtractionResult {
  fields: Record<string, string | null>;    // ALL key-value pairs found
  tables: Array<{ name: string; headers: string[]; rows: string[][] }>;
  products: string[];
  summary: string;
  confidence: 'high' | 'medium' | 'low';
  raw_response?: string;
}

function buildPrompt(examples?: { input_text: string; corrected_output: string }[]): string {
  let prompt = [
    'You are a document data extraction assistant. Analyze the provided document and extract ALL structured data you can find.',
    '',
    'Return a JSON object with these sections:',
    '',
    '1. "fields": an object of ALL key-value pairs found in the document. Use snake_case keys derived from the field labels (e.g., "Lot Number" → "lot_number", "Ship Date" → "ship_date", "Customer Name" → "customer_name"). Set value to null if a label exists but the value is unclear.',
    '',
    '2. "tables": an array of any tabular data found (e.g., test results, line items). Each table is: { "name": "string describing the table", "headers": ["col1", "col2"], "rows": [["val1", "val2"], ...] }',
    '',
    '3. "products": an array of product/item names mentioned in the document (empty array if none found).',
    '',
    '4. "summary": a one-sentence description of what this document is (e.g., "Certificate of Analysis for Butter from Supplier X, Lot LOT-2024-042").',
    '',
    '5. "_confidence": "high" if the document was clearly structured and most data was extracted, "medium" if some parts were ambiguous, "low" if the document was hard to parse.',
  ].join('\n');

  if (examples && examples.length > 0) {
    prompt += '\n\nHere are examples of correct extractions for this document type:\n';
    examples.forEach((ex, i) => {
      prompt += `\nExample ${i + 1}:\nInput (excerpt): ${ex.input_text.substring(0, 500)}\nCorrect output: ${ex.corrected_output}\n`;
    });
  }

  return prompt;
}

export async function extractFields(
  text: string,
  env: { QWEN_URL?: string; QWEN_SECRET?: string },
  examples?: { input_text: string; corrected_output: string }[]
): Promise<ExtractionResult> {
  if (!text || text.trim().length === 0) {
    return { fields: {}, tables: [], products: [], summary: '', confidence: 'low' };
  }

  const baseUrl = (env.QWEN_URL || 'http://127.0.0.1:9600').replace(/\/+$/, '');
  const systemPrompt = buildPrompt(examples);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);

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
      throw new Error('LLM request timed out after 90 seconds');
    }
    throw new Error(`LLM server not reachable at ${baseUrl}. Is Qwen running?`);
  } finally {
    clearTimeout(timeout);
  }

  const data = await response.json() as {
    choices: { message: { content: string } }[];
  };

  let content = data.choices?.[0]?.message?.content || '';

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
    return { fields: {}, tables: [], products: [], summary: '', confidence: 'low', raw_response: content };
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

  // Build fields from the "fields" object, or from top-level non-reserved keys
  const fields: Record<string, string | null> = {};
  const rawFields = (typeof parsed.fields === 'object' && parsed.fields !== null && !Array.isArray(parsed.fields))
    ? parsed.fields as Record<string, unknown>
    : parsed;
  const reservedKeys = new Set(['fields', 'tables', 'products', 'summary', '_confidence']);

  for (const [key, value] of Object.entries(rawFields)) {
    if (!key.startsWith('_') && !reservedKeys.has(key)) {
      fields[key] = value === null || value === undefined ? null : String(value);
    }
  }

  return { fields, tables, products, summary, confidence };
}

export async function parseNaturalQuery(
  query: string,
  documentTypes: { slug: string; name: string }[],
  products: { name: string }[],
  env: { QWEN_URL?: string; QWEN_SECRET?: string }
): Promise<ParsedQuery> {
  const baseUrl = (env.QWEN_URL || 'http://127.0.0.1:9600').replace(/\/+$/, '');
  const today = new Date().toISOString().split('T')[0];

  const systemPrompt = [
    'You are a document search query parser. Parse the user\'s natural language query into structured search parameters.',
    'Return ONLY a valid JSON object with no additional text.',
    '',
    `Today's date: ${today}`,
    '',
    'Available document types:',
    ...documentTypes.map(dt => `- slug: "${dt.slug}", name: "${dt.name}"`),
    '',
    'Available products:',
    ...products.map(p => `- "${p.name}"`),
    '',
    'Output JSON fields:',
    '- "keywords": array of search keywords (words not matched to other fields)',
    '- "document_type_slug": matching document type slug or null',
    '- "product_name": matching product name or null',
    '- "date_from": start date (YYYY-MM-DD) or null — resolve relative dates like "last month", "from March"',
    '- "date_to": end date (YYYY-MM-DD) or null',
    '- "lot_number": lot number if mentioned, or null',
    '- "po_number": PO number if mentioned, or null',
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
  content = content.trim();
  const fenceMatch = content.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch) {
    content = fenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(content);
    return {
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
      document_type_slug: parsed.document_type_slug || null,
      product_name: parsed.product_name || null,
      date_from: parsed.date_from || null,
      date_to: parsed.date_to || null,
      lot_number: parsed.lot_number || null,
      po_number: parsed.po_number || null,
    };
  } catch {
    // Fallback: treat entire query as keywords
    return {
      keywords: query.split(/\s+/).filter(Boolean),
      document_type_slug: null,
      product_name: null,
      date_from: null,
      date_to: null,
      lot_number: null,
      po_number: null,
    };
  }
}
