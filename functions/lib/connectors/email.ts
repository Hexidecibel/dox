import type { ConnectorExecuteFn, ConnectorOutput, ConnectorContext, ParsedOrder, ParsedCustomer, EmailAttachment } from './types';
import {
  CORE_FIELD_DEFINITIONS,
  type CoreFieldKey,
  normalizeFieldMappings,
} from '../../../shared/fieldMappings';
import {
  buildParsingPrompt,
  mergeOutputs,
  normalizeAiOutput,
  prependConnectorInstructions,
  type RawAiParseResult,
} from '../../../shared/orderPrompt';
import { modelFor } from '../models';

// Re-export the pure prompt/normalization helpers from their shared home so
// existing importers (tests, preview-extraction) that pulled them from this
// module keep working. The implementations now live in shared/orderPrompt.ts
// so the standalone Node worker can import the exact same code.
export {
  buildParsingPrompt,
  getDefaultParsingPrompt,
  mergeOutputs,
  prependConnectorInstructions,
  sanitizeCustomerName,
} from '../../../shared/orderPrompt';

/**
 * Email connector: parses inbound emails into orders and customers.
 * Supports plain text, HTML, and CSV/PDF/XLSX attachments.
 * Uses Qwen AI for unstructured text, direct parsing for CSV.
 */
export const execute: ConnectorExecuteFn = async (ctxIn, input) => {
  if (input.type !== 'email') {
    return { orders: [], customers: [], errors: [{ message: 'Expected email input' }] };
  }

  // Belt-and-suspenders normalization. The orchestrator already does this,
  // but direct callers (tests, the standalone webhook path) may pass a
  // legacy v1 field_mappings shape. Normalizing here ensures parseCSV and
  // parseWithAI see a proper v2 config no matter who invoked us.
  const ctx: ConnectorContext = {
    ...ctxIn,
    fieldMappings: normalizeFieldMappings(ctxIn.fieldMappings),
  };

  const { body, html, subject, attachments } = input;
  const results: ConnectorOutput[] = [];

  // Process every attachment independently, then merge.
  for (const att of attachments ?? []) {
    const kind = classifyAttachment(att);
    switch (kind) {
      case 'csv':
        results.push(parseCSVAttachment(ctx, att));
        break;
      case 'pdf':
        results.push(await parsePDFAttachment(ctx, att, subject));
        break;
      case 'xlsx':
        results.push(await parseXLSXAttachment(ctx, att, subject));
        break;
      case 'unknown':
      default:
        results.push({
          orders: [],
          customers: [],
          errors: [{
            message: `Skipped unsupported attachment: ${att.filename} (content-type: ${att.contentType || 'unknown'})`,
          }],
        });
        break;
    }
  }

  // If no attachments produced results at all, fall back to email body/html AI parse.
  if (results.length === 0) {
    const textContent = body || stripHtml(html || '');
    if (!textContent.trim()) {
      return { orders: [], customers: [], errors: [{ message: 'Empty email body' }] };
    }
    results.push(await parseWithAI(ctx, textContent, subject));
  }

  return mergeOutputs(results);
};

/**
 * Classify an attachment by content-type and filename extension.
 */
function classifyAttachment(att: EmailAttachment): 'csv' | 'pdf' | 'xlsx' | 'unknown' {
  const ct = (att.contentType || '').toLowerCase();
  const name = (att.filename || '').toLowerCase();

  if (ct === 'text/csv' || ct === 'text/tsv' || name.endsWith('.csv') || name.endsWith('.tsv')) {
    return 'csv';
  }
  if (ct === 'application/pdf' || name.endsWith('.pdf')) {
    return 'pdf';
  }
  if (
    ct === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    ct === 'application/vnd.ms-excel' ||
    name.endsWith('.xlsx') ||
    name.endsWith('.xls')
  ) {
    return 'xlsx';
  }
  return 'unknown';
}

/**
 * Safety caps shared across attachment chunking paths.
 * - CHUNK_CHAR_LIMIT: soft target for a single AI call on PDF content.
 *   PDFs are denser per char than pipe-delimited XLSX rows, and the existing
 *   live test passed at this size.
 * - XLSX_CHUNK_CHAR_LIMIT: smaller cap for XLSX content. Each pipe-delimited
 *   row expands into a relatively large JSON output object, and the full
 *   output for a 12-15k char sheet blew the 60s llama-swap / qwen gateway
 *   timeout in the live E2E run. 5000 chars keeps each AI call comfortably
 *   under the ceiling at the cost of more total calls per workbook.
 * - MAX_CHUNKS_PER_ATTACHMENT: hard cap on AI calls per attachment to avoid
 *   runaway Qwen spend on a pathological input.
 */
const CHUNK_CHAR_LIMIT = 28000;
const XLSX_CHUNK_CHAR_LIMIT = 5000;
const MAX_CHUNKS_PER_ATTACHMENT = 20;

/**
 * Split a block of text into chunks of at most `limit` chars, preserving
 * row (newline) boundaries. Any single row longer than `limit` is emitted
 * on its own — we don't break mid-row because that corrupts the AI's view
 * of the pipe-delimited columns.
 */
function chunkByRows(text: string, limit: number): string[] {
  const rows = text.split('\n');
  const chunks: string[] = [];
  let buf = '';

  for (const row of rows) {
    // +1 for the newline we'll rejoin with
    if (buf.length + row.length + 1 > limit && buf.length > 0) {
      chunks.push(buf);
      buf = '';
    }
    buf = buf.length === 0 ? row : `${buf}\n${row}`;
  }
  if (buf.length > 0) chunks.push(buf);
  return chunks;
}

/**
 * Extract text from a PDF attachment via unpdf, chunk into page groups that
 * fit under CHUNK_CHAR_LIMIT, and run parseWithAI per chunk. Results are
 * merged so no pages are silently dropped.
 *
 * Scanned PDFs (no extractable text) surface as a soft warning — no OCR fallback.
 */
async function parsePDFAttachment(
  ctx: ConnectorContext,
  att: EmailAttachment,
  subjectContext: string,
): Promise<ConnectorOutput> {
  try {
    const { extractText } = await import('unpdf');
    // mergePages: false gives us string[] (one entry per page) so we can
    // build size-aware chunks without losing page boundaries in the subject.
    const { text } = await extractText(new Uint8Array(att.content));

    const pages: string[] = Array.isArray(text)
      ? text.map(p => p || '')
      : text
        ? [text]
        : [];

    if (pages.length === 0 || pages.every(p => !p.trim())) {
      return {
        orders: [],
        customers: [],
        errors: [{
          message: `PDF extraction returned no text for ${att.filename} (likely scanned image — OCR not supported in connector path)`,
        }],
      };
    }

    // Accumulate pages into chunks. When the buffer would overflow, flush it.
    // If a single page is itself > CHUNK_CHAR_LIMIT, split that page row-by-row
    // rather than truncating.
    type PageChunk = { text: string; startPage: number; endPage: number };
    const chunks: PageChunk[] = [];
    let buf = '';
    let bufStart = 1;

    const flush = (endPage: number) => {
      if (!buf.trim()) return;
      chunks.push({ text: buf, startPage: bufStart, endPage });
      buf = '';
    };

    for (let i = 0; i < pages.length; i++) {
      const pageNum = i + 1;
      const page = pages[i] || '';

      // Oversized single page: flush current buf, then emit row-chunks for the page.
      if (page.length > CHUNK_CHAR_LIMIT) {
        flush(pageNum - 1);
        const subChunks = chunkByRows(page, CHUNK_CHAR_LIMIT);
        for (const sub of subChunks) {
          chunks.push({ text: sub, startPage: pageNum, endPage: pageNum });
        }
        bufStart = pageNum + 1;
        continue;
      }

      // Normal path: accumulate. Flush first if adding this page would overflow.
      if (buf.length + page.length + 2 > CHUNK_CHAR_LIMIT && buf.length > 0) {
        flush(pageNum - 1);
        bufStart = pageNum;
      }
      buf = buf.length === 0 ? page : `${buf}\n\n${page}`;
      if (buf.length === page.length) bufStart = pageNum;
    }
    flush(pages.length);

    if (chunks.length === 0) {
      return {
        orders: [],
        customers: [],
        errors: [{ message: `PDF produced only whitespace: ${att.filename}` }],
      };
    }

    if (chunks.length > MAX_CHUNKS_PER_ATTACHMENT) {
      return {
        orders: [],
        customers: [],
        errors: [{
          message: `Attachment too large: ${att.filename} would require ${chunks.length} AI calls (cap: ${MAX_CHUNKS_PER_ATTACHMENT}). Reduce input size or batch separately.`,
        }],
      };
    }

    const results: ConnectorOutput[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const range = c.startPage === c.endPage ? `page ${c.startPage}` : `pages ${c.startPage}-${c.endPage}`;
      const subject = `${subjectContext} :: ${att.filename} :: ${range}${chunks.length > 1 ? ` (chunk ${i + 1}/${chunks.length})` : ''}`;
      results.push(await parseWithAI(ctx, c.text, subject, CHUNK_CHAR_LIMIT));
    }

    const merged = mergeOutputs(results);
    // Informational summary — NOT an error. Lives in info[] so the
    // orchestrator's status calc doesn't downgrade a clean run to `partial`.
    (merged.info ||= []).push(
      `PDF ${att.filename}: processed ${pages.length} pages in ${chunks.length} chunk(s), extracted ${merged.orders.length} orders / ${merged.customers.length} customers`,
    );
    return merged;
  } catch (err) {
    return {
      orders: [],
      customers: [],
      errors: [{
        message: `PDF parse failed for ${att.filename}: ${err instanceof Error ? err.message : String(err)}`,
      }],
    };
  }
}

/**
 * Parse an XLSX attachment by processing each sheet as an independent AI call.
 * Sheets are never concatenated — that caused silent drops for late-alphabet
 * customers in the weekly registry workbook (6 sheets × ~260 rows).
 *
 * For each sheet:
 *   - Skip INACTIVE_CUST (case-insensitive "inactive" match).
 *   - Convert to pipe-CSV.
 *   - If the sheet fits under CHUNK_CHAR_LIMIT, one AI call.
 *   - Otherwise split row-by-row into chunks and issue one call per chunk.
 *
 * Results are merged with mergeOutputs (first-wins customer dedupe).
 *
 * Uses SheetJS (xlsx) — pure JS, Workers-compatible. Dynamic import mirrors
 * the unpdf pattern so cold-start cost is paid lazily.
 */
async function parseXLSXAttachment(
  ctx: ConnectorContext,
  att: EmailAttachment,
  subjectContext: string,
): Promise<ConnectorOutput> {
  try {
    const XLSX = await import('xlsx');
    const workbook = XLSX.read(new Uint8Array(att.content), { type: 'array' });

    // Informational messages accumulated while walking the workbook (skipped
    // sheets, etc.). NOT errors — flow into ConnectorOutput.info[].
    const preInfo: string[] = [];

    // First pass: build the list of (sheet, chunk) work units and enforce the
    // call cap before we fire any AI requests.
    type Unit = { sheetName: string; text: string; chunkIndex: number; chunkTotal: number };
    const units: Unit[] = [];
    let processedSheets = 0;

    for (const sheetName of workbook.SheetNames) {
      if (/inactive/i.test(sheetName)) {
        preInfo.push(`Skipped sheet: ${sheetName} (inactive customers excluded)`);
        continue;
      }

      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;

      // sheet_to_csv with pipe separator — cells commonly contain commas
      // (emails, addresses), pipes are much rarer and keep the AI grounded
      // on the actual column boundaries.
      const csv = XLSX.utils.sheet_to_csv(sheet, {
        FS: ' | ',
        RS: '\n',
        blankrows: false,
      });

      if (!csv || !csv.trim()) continue;
      processedSheets++;

      if (csv.length <= XLSX_CHUNK_CHAR_LIMIT) {
        units.push({ sheetName, text: csv, chunkIndex: 1, chunkTotal: 1 });
        continue;
      }

      const chunks = chunkByRows(csv, XLSX_CHUNK_CHAR_LIMIT);
      chunks.forEach((text, idx) => {
        units.push({
          sheetName,
          text,
          chunkIndex: idx + 1,
          chunkTotal: chunks.length,
        });
      });
    }

    if (units.length === 0) {
      return {
        orders: [],
        customers: [],
        errors: [{ message: `XLSX had no processable sheets: ${att.filename}` }],
        info: preInfo,
      };
    }

    if (units.length > MAX_CHUNKS_PER_ATTACHMENT) {
      return {
        orders: [],
        customers: [],
        errors: [
          {
            message: `Attachment too large: ${att.filename} would require ${units.length} AI calls (cap: ${MAX_CHUNKS_PER_ATTACHMENT}). Reduce input size or batch separately.`,
          },
        ],
        info: preInfo,
      };
    }

    const results: ConnectorOutput[] = [];
    for (const u of units) {
      const label = u.chunkTotal > 1
        ? `${att.filename} :: ${u.sheetName} :: chunk ${u.chunkIndex}/${u.chunkTotal}`
        : `${att.filename} :: ${u.sheetName}`;
      const subject = `${subjectContext} :: ${label}`;
      results.push(await parseWithAI(ctx, u.text, subject, XLSX_CHUNK_CHAR_LIMIT));
    }

    const merged = mergeOutputs(results);
    // Prepend the pre-info (INACTIVE skip notices) so they appear before
    // per-call info in the final output, then append the processing summary.
    merged.info = [
      ...preInfo,
      ...(merged.info || []),
      `XLSX ${att.filename}: processed ${processedSheets} sheet(s) in ${units.length} chunk(s), extracted ${merged.orders.length} orders / ${merged.customers.length} customers`,
    ];
    return merged;
  } catch (err) {
    return {
      orders: [],
      customers: [],
      errors: [{
        message: `XLSX parse failed for ${att.filename}: ${err instanceof Error ? err.message : String(err)}`,
      }],
    };
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<(?:td|th)[^>]*>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#?\w+;/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Normalize a label for fuzzy alias matching: lowercase, collapse whitespace,
 * strip punctuation except alphanumerics. "Order #" and "order_number" and
 * "Order No." all collapse to "ordernumber".
 */
function normalizeLabel(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Match a detected CSV header to a list of candidate source labels using the
 * normalized-label comparison. Returns the first match, or undefined.
 */
function labelMatches(header: string, candidates: readonly string[]): boolean {
  const n = normalizeLabel(header);
  for (const c of candidates) {
    if (normalizeLabel(c) === n) return true;
  }
  return false;
}

/**
 * Parse a CSV string into an array of row records (lowercased header keys).
 * Exported for preview-extraction and schema discovery helpers.
 */
export function parseCSVText(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return { headers: [], rows: [] };

  const delimiter = text.includes('\t') ? '\t' : ',';
  const headers = lines[0]
    .split(delimiter)
    .map(h => h.trim().replace(/^["']|["']$/g, ''));

  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(delimiter).map(v => v.trim().replace(/^["']|["']$/g, ''));
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || '';
    });
    rows.push(row);
  }

  return { headers, rows };
}

/**
 * Parse a CSV attachment using the v2 field-mappings config. For each core
 * field, walk its source_labels aliases against the detected headers and
 * collect the matched value into primary_metadata. Extended-field mappings
 * feed extended_metadata. Any header that didn't match ANY declared alias is
 * still retained verbatim in source_data for audit / downstream workflows.
 *
 * Exported so the preview-extraction endpoint and in-process tests can drive
 * it directly without going through the email entry point.
 */
export function parseCSVAttachment(ctx: ConnectorContext, attachment: EmailAttachment): ConnectorOutput {
  const decoder = new TextDecoder();
  const text = decoder.decode(attachment.content);
  const { headers, rows } = parseCSVText(text);

  if (rows.length === 0) {
    return { orders: [], customers: [], errors: [{ message: 'CSV has no data rows' }] };
  }

  const mappings = ctx.fieldMappings;
  const orders: ParsedOrder[] = [];
  const customers: ParsedCustomer[] = [];
  const errors: { record_index?: number; field?: string; message: string }[] = [];
  const seenCustomers = new Set<string>();

  // Precompute which header maps to which target (once per CSV, not per row).
  // Shape: { header: { core?: CoreFieldKey; extendedKey?: string } }
  const headerMap: Record<string, { core?: CoreFieldKey; extendedKey?: string }> = {};
  for (const header of headers) {
    // Core first — canonical fields win over extended if both claim the same column.
    let matched = false;
    for (const def of CORE_FIELD_DEFINITIONS) {
      const c = mappings.core[def.key];
      if (!c || !c.enabled) continue;
      if (labelMatches(header, c.source_labels)) {
        headerMap[header] = { core: def.key };
        matched = true;
        break;
      }
    }
    if (matched) continue;
    for (const ext of mappings.extended) {
      if (labelMatches(header, ext.source_labels)) {
        headerMap[header] = { extendedKey: ext.key };
        break;
      }
    }
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const primary: Record<string, string> = {};
    const extended: Record<string, string> = {};

    for (const [header, val] of Object.entries(row)) {
      const mapping = headerMap[header];
      if (!mapping) continue;
      if (mapping.core) primary[mapping.core] = val;
      if (mapping.extendedKey) extended[mapping.extendedKey] = val;
    }

    const orderNumber = primary.order_number;
    if (!orderNumber) {
      errors.push({ record_index: i + 1, message: 'Missing order number' });
      continue;
    }

    const customerNumber = primary.customer_number || undefined;
    const customerName = primary.customer_name || undefined;

    orders.push({
      order_number: orderNumber,
      po_number: primary.po_number || undefined,
      customer_number: customerNumber,
      customer_name: customerName,
      items: [],
      source_data: row,
      primary_metadata: Object.keys(primary).length > 0 ? { ...primary } : undefined,
      extended_metadata: Object.keys(extended).length > 0 ? { ...extended } : undefined,
    });

    if (customerNumber && !seenCustomers.has(customerNumber)) {
      seenCustomers.add(customerNumber);
      // Email / customer_email still uses the legacy header fallback — the
      // customers registry path is not part of this wave's scope.
      customers.push({
        customer_number: customerNumber,
        name: customerName || customerNumber,
        email: row['email'] || row['customer_email'] || undefined,
      });
    }
  }

  return { orders, customers, errors };
}

async function parseWithAI(
  ctx: ConnectorContext,
  text: string,
  subject: string,
  maxChars: number = 8000,
): Promise<ConnectorOutput> {
  const config = ctx.config as Record<string, unknown>;
  // Dynamic prompt built from the v2 field_mappings config so enabled core
  // fields, source-label aliases, format hints, and extended fields all make
  // it into the Qwen system message. Fall back to a hand-written prompt if
  // the config provides `parsing_prompt` verbatim (rare; escape hatch).
  const basePrompt = typeof config.parsing_prompt === 'string' && config.parsing_prompt.length > 0
    ? (config.parsing_prompt as string)
    : buildParsingPrompt(ctx.fieldMappings);
  // R2.b: connector-level reviewer guidance is prepended verbatim so any
  // quirks the model misses ("CODE DATE = expiration_date", "ignore footer
  // lines starting with X") teach across every future run for THIS connector.
  // Header matches bin/process-worker:485 (DOCUMENT path) so future tweaks
  // live in exactly one shape.
  const parsingPrompt = prependConnectorInstructions(basePrompt, ctx.extractionInstructions);

  if (!ctx.qwenUrl) {
    return { orders: [], customers: [], errors: [{ message: 'AI extraction not configured (QWEN_URL missing)' }] };
  }

  // Trim to avoid token limits. XLSX/PDF callers can raise this above the
  // default for structured content.
  const trimmedText = text.slice(0, maxChars);

  const messages = [
    {
      role: 'system' as const,
      content: parsingPrompt,
    },
    {
      role: 'user' as const,
      content: `Subject: ${subject}\n\n${trimmedText}`,
    },
  ];

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (ctx.qwenSecret) {
      headers['Authorization'] = `Bearer ${ctx.qwenSecret}`;
    }

    const response = await fetch(`${ctx.qwenUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        // Must match a model the llama-swap gateway knows about. `'qwen'`
        // is NOT a real model id and silently 404s.
        model: modelFor('best'),
        messages,
        temperature: 0.1,
        // llama-swap defaults to ~2048 output tokens. Long XLSX outputs
        // truncate mid-JSON at that cap ("Unterminated string at position
        // 4296") — bumping to 8192 lets a dense customer-registry chunk
        // finish cleanly while still bounding worst-case cost.
        max_tokens: 8192,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      return { orders: [], customers: [], errors: [{ message: `AI extraction failed: ${response.status}` }] };
    }

    const result = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = result.choices?.[0]?.message?.content;
    if (!content) {
      return { orders: [], customers: [], errors: [{ message: 'AI returned empty response' }] };
    }

    const parsed = JSON.parse(content) as RawAiParseResult;

    // Pure validation + mapping lives in shared/orderPrompt so the standalone
    // Node worker runs the exact same transform. parseWithAI keeps only the
    // fetch/LLM-call shell.
    const { orders, customers } = normalizeAiOutput(parsed);

    return { orders, customers, errors: [] };
  } catch (err) {
    return {
      orders: [],
      customers: [],
      errors: [{ message: `AI parsing error: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }
}
