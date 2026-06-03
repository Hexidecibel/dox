/**
 * Pure, deterministic CSV field-mapping parse helpers.
 *
 * Single source of truth shared between the Cloudflare Worker connector pipeline
 * (functions/lib/connectors/email.ts, fileWatch.ts, preview-extraction.ts,
 * schemaDiscovery.ts) and the standalone Node extraction worker (bin/process-worker).
 * Keep this file PURE — no DB access, no fetch, no Worker-only globals, no R2 —
 * so the exact same code runs in a Worker and in plain Node.
 *
 * What lives here:
 *  - normalizeLabel / labelMatches — fuzzy header-to-alias matching.
 *  - parseCSVText — split a CSV/TSV string into headers + row records.
 *  - parseCSVAttachment — map CSV headers onto the v2 field_mappings config,
 *    splitting core vs extended fields into primary_metadata/extended_metadata
 *    and emitting ParsedOrder/ParsedCustomer records.
 *
 * The fetch/LLM-call shell (parseWithAI), PDF/XLSX extraction, and the email
 * entry point stay in email.ts — only the deterministic CSV transforms live here.
 */

import {
  CORE_FIELD_DEFINITIONS,
  type ConnectorFieldMappings,
  type CoreFieldKey,
} from './fieldMappings';
import type {
  ConnectorOutput,
  ParsedCustomer,
  ParsedOrder,
} from './connectorOutput';

/**
 * Normalize a label for fuzzy alias matching: lowercase, collapse whitespace,
 * strip punctuation except alphanumerics. "Order #" and "order_number" and
 * "Order No." all collapse to "ordernumber".
 */
export function normalizeLabel(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Match a detected CSV header to a list of candidate source labels using the
 * normalized-label comparison. Returns true on the first match.
 */
export function labelMatches(header: string, candidates: readonly string[]): boolean {
  const n = normalizeLabel(header);
  for (const c of candidates) {
    if (normalizeLabel(c) === n) return true;
  }
  return false;
}

/**
 * Parse a CSV string into an array of row records (header keys preserved
 * verbatim). Exported for preview-extraction and schema discovery helpers.
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
 * Minimal structural shapes the pure CSV parser needs. Declared locally (rather
 * than importing ConnectorContext / EmailAttachment from the Worker-only
 * functions/lib/connectors/types.ts) so this module stays free of Cloudflare
 * runtime types. Callers pass their full ConnectorContext / EmailAttachment —
 * structural typing accepts them.
 */
export interface CSVParseContext {
  fieldMappings: ConnectorFieldMappings;
}

export interface CSVAttachment {
  content: ArrayBuffer;
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
export function parseCSVAttachment(ctx: CSVParseContext, attachment: CSVAttachment): ConnectorOutput {
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
