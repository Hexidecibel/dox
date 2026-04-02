import type { ExtractionField } from '../../shared/types';

export interface ExtractionResult {
  fields: Record<string, string | null>;
  product_names: string[];
  confidence: 'high' | 'medium' | 'low';
  raw_response?: string;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function buildPrompt(fields: ExtractionField[]): string {
  const fieldLines = fields.map((f) => {
    const key = slugify(f.name);
    let line = `- "${key}": ${f.name}`;
    if (f.hint) line += ` (hint: ${f.hint})`;
    if (f.aliases && f.aliases.length > 0) {
      line += ` (may also appear as: ${f.aliases.join(', ')})`;
    }
    return line;
  });

  return [
    'You are a document data extraction assistant. Extract the requested fields from the provided document text. Return ONLY a valid JSON object with no additional text or explanation.',
    '',
    'For each field below, extract its value from the document. If a field is not found, set it to null.',
    '',
    'Fields to extract:',
    ...fieldLines,
    '',
    'Also include these in your JSON response:',
    '- "_product_names": an array of product/item names mentioned in the document (empty array if none found)',
    '- "_confidence": "high" if most fields were clearly found, "medium" if some were ambiguous, "low" if the document was hard to parse',
  ].join('\n');
}

export async function extractFields(
  text: string,
  extractionFields: ExtractionField[],
  env: { QWEN_URL?: string; QWEN_SECRET?: string }
): Promise<ExtractionResult> {
  if (!text || text.trim().length === 0) {
    const fields: Record<string, string | null> = {};
    for (const f of extractionFields) {
      fields[slugify(f.name)] = null;
    }
    return { fields, product_names: [], confidence: 'low' };
  }

  const baseUrl = (env.QWEN_URL || 'http://127.0.0.1:9600').replace(/\/+$/, '');
  const systemPrompt = buildPrompt(extractionFields);

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
            content: `<document>\n${text}\n</document>\n\nExtract the fields and respond with JSON only. /no_think`,
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
    return { fields: {}, product_names: [], confidence: 'low', raw_response: content };
  }

  const product_names = Array.isArray(parsed._product_names)
    ? (parsed._product_names as string[])
    : [];

  const confidence = (['high', 'medium', 'low'].includes(parsed._confidence as string)
    ? parsed._confidence
    : 'low') as ExtractionResult['confidence'];

  // Build fields, excluding underscore-prefixed keys
  const fields: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!key.startsWith('_')) {
      fields[key] = value === null || value === undefined ? null : String(value);
    }
  }

  return { fields, product_names, confidence };
}
