/**
 * Unit tests for the Phase P3 output-kind dispatch in bin/process-worker.
 *
 * process-worker is a standalone Node daemon (CJS) that can't be imported
 * directly into the Workers test pool, so we load its source as a raw string
 * and assert on the dispatcher structure + the new order/shipment/XLSX wiring.
 * Same ?raw strategy as processWorkerVlm.test.ts / processWorkerInstructions.test.ts.
 *
 * These tests guard the *shape* of P3 (kind dispatch, shared-module imports,
 * XLSX arm, ai_records posting) without weakening any COA-path assertions —
 * those live in the sibling test files and must keep passing.
 */

import { describe, it, expect } from 'vitest';
import processWorkerSource from '../../bin/process-worker?raw';

describe('process-worker — P3 output-kind dispatch', () => {
  it('dispatches on item.output_kind with coa as the null/default fallback', () => {
    expect(processWorkerSource).toMatch(
      /const kind = item\.output_kind \|\| 'coa'/
    );
    expect(processWorkerSource).toMatch(/if \(kind === 'order'\) return await processOrderItem\(item\)/);
    expect(processWorkerSource).toMatch(/if \(kind === 'shipment'\) return await processShipmentItem\(item\)/);
    expect(processWorkerSource).toMatch(/return await processCoaItem\(item\)/);
  });

  it('keeps the entire COA path in a dedicated processCoaItem function', () => {
    expect(processWorkerSource).toMatch(/async function processCoaItem\(item\)/);
    // The COA result body MUST still post ai_fields/tables (NOT ai_records).
    expect(processWorkerSource).toMatch(/ai_fields: JSON\.stringify\(parsed\.fields \|\| \{\}\)/);
  });
});

describe('process-worker — shared order-prompt module (single source of truth)', () => {
  it('requires the transpiled shared/orderPrompt bundle (no hand-duplicated mirror)', () => {
    expect(processWorkerSource).toMatch(/require\('\.\/lib\/shared\/orderPrompt'\)/);
  });

  it('imports the pure order helpers it uses for the order/shipment paths', () => {
    for (const fn of [
      'buildParsingPrompt',
      'prependConnectorInstructions',
      'mergeOutputs',
      'normalizeAiOutput',
      'clampConfidence',
      'getDefaultParsingPrompt',
    ]) {
      expect(processWorkerSource).toContain(fn);
    }
  });
});

describe('process-worker — order extraction path', () => {
  it('builds the prompt from field_mappings via the shared module', () => {
    expect(processWorkerSource).toMatch(/buildParsingPrompt\(profile\.field_mappings\)/);
    // Falls back to the shared default prompt when no source profile resolved.
    expect(processWorkerSource).toMatch(/getDefaultParsingPrompt\(\)/);
  });

  it('prepends connector instructions from the source profile', () => {
    expect(processWorkerSource).toMatch(
      /prependConnectorInstructions\(basePrompt, profile\.extraction_instructions\)/
    );
  });

  it('normalizes each chunk via normalizeAiOutput and merges via mergeOutputs', () => {
    expect(processWorkerSource).toMatch(/normalizeAiOutput\(raw\)/);
    expect(processWorkerSource).toMatch(/mergeOutputs\(outputs\)/);
  });

  it('posts ai_records (orders+customers) and NOT ai_fields', () => {
    expect(processWorkerSource).toMatch(
      /ai_records: JSON\.stringify\(\{ orders, customers \}\)/
    );
    // The order path's result body must not carry ai_fields.
    const orderFn = sliceFn(processWorkerSource, 'async function processOrderItem');
    expect(orderFn).not.toContain('ai_fields:');
  });

  it('sets processing_status ready on success', () => {
    const orderFn = sliceFn(processWorkerSource, 'async function processOrderItem');
    expect(orderFn).toContain("processing_status: 'ready'");
  });
});

describe('process-worker — shipment extraction path', () => {
  it('declares a shipment prompt requiring order_number + lot_number', () => {
    expect(processWorkerSource).toMatch(/const SHIPMENT_PROMPT =/);
    expect(processWorkerSource).toMatch(/order_number\s+\(REQUIRED\)/);
    expect(processWorkerSource).toMatch(/lot_number\s+\(REQUIRED\)/);
  });

  it('drops rows missing order_number or lot_number', () => {
    const shipFn = sliceFn(processWorkerSource, 'async function processShipmentItem');
    expect(shipFn).toMatch(/if \(!orderNumber \|\| !lotNumber\) continue;/);
  });

  it('asks for the spec shipment fields', () => {
    expect(processWorkerSource).toContain('product_name');
    expect(processWorkerSource).toContain('product_code');
    expect(processWorkerSource).toContain('quantity');
    expect(processWorkerSource).toContain('status');
  });

  it('posts ai_records (shipments) and NOT ai_fields', () => {
    expect(processWorkerSource).toMatch(
      /ai_records: JSON\.stringify\(\{ shipments \}\)/
    );
    const shipFn = sliceFn(processWorkerSource, 'async function processShipmentItem');
    expect(shipFn).not.toContain('ai_fields:');
  });

  it('prepends connector instructions to the shipment prompt', () => {
    expect(processWorkerSource).toMatch(
      /prependConnectorInstructions\(SHIPMENT_PROMPT, profile\.extraction_instructions\)/
    );
  });
});

describe('process-worker — XLSX format arm', () => {
  it('detects xlsx by openxml mime or .xlsx extension', () => {
    expect(processWorkerSource).toMatch(
      /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/
    );
    expect(processWorkerSource).toMatch(/\\\.xlsx\$/);
  });

  it('reads the workbook and converts each sheet to pipe-separated CSV', () => {
    expect(processWorkerSource).toMatch(/XLSX\.read\(new Uint8Array\(fileBuffer\), \{ type: 'array' \}\)/);
    expect(processWorkerSource).toMatch(/sheet_to_csv\(ws, \{ FS: ' \| ' \}\)/);
  });

  it('skips inactive sheets (mirrors the connector email parser)', () => {
    expect(processWorkerSource).toMatch(/\/inactive\/i\.test\(sheetName\)/);
  });

  it('pushes sheets as pages[] entries so the existing chunker handles them', () => {
    const xlsxFn = sliceFn(processWorkerSource, 'function xlsxToPages');
    expect(xlsxFn).toMatch(/pages\.push\(/);
  });

  it('wires xlsx into the COA format branch as an additive arm', () => {
    // COA-via-xlsx must work too — additive else-if, never replacing an
    // existing format arm.
    const coaFn = sliceFn(processWorkerSource, 'async function processCoaItem');
    expect(coaFn).toMatch(/} else if \(isXlsxItem\(item\)\) \{/);
  });
});

describe('process-worker — DOCX format arm', () => {
  it('detects docx by openxml wordprocessing mime or .docx extension', () => {
    expect(processWorkerSource).toMatch(
      /application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/
    );
    expect(processWorkerSource).toMatch(/\\\.docx\$/);
  });

  it('extracts raw text via mammoth into a single text-shaped page', () => {
    const fn = sliceFn(processWorkerSource, 'async function docxToPages');
    expect(fn).toMatch(/require\('mammoth'\)/);
    expect(fn).toMatch(/mammoth\.extractRawText\(\{ buffer:/);
    expect(fn).toMatch(/return text \? \[text\] : \[\]/);
  });

  it('wires docx into the shared extractTextAndPages format branch', () => {
    const fn = sliceFn(processWorkerSource, 'async function extractTextAndPages');
    expect(fn).toMatch(/} else if \(isDocxItem\(item\)\) \{/);
    expect(fn).toMatch(/await docxToPages\(fileBuffer\)/);
  });

  it('wires docx into the COA inline format branch as an additive arm', () => {
    // The COA inline extractor has its OWN format branch (separate from
    // extractTextAndPages). Both must carry a docx arm — assert isDocxItem
    // appears as an else-if at least twice across the worker source.
    const arms = processWorkerSource.match(/} else if \(isDocxItem\(item\)\) \{/g) || [];
    expect(arms.length).toBeGreaterThanOrEqual(2);
  });
});

describe('process-worker — extraction profile loading', () => {
  it('fetches the source profile for order/shipment kinds', () => {
    expect(processWorkerSource).toMatch(/async function loadExtractionProfile\(item\)/);
    expect(processWorkerSource).toMatch(/\/api\/sources\/\$\{encodeURIComponent\(item\.source_id\)\}\/profile/);
  });

  it('treats the profile fetch as best-effort (never throws past the catch)', () => {
    const fn = sliceFn(processWorkerSource, 'async function loadExtractionProfile');
    expect(fn).toMatch(/catch \(err\)/);
    expect(fn).toContain('using defaults');
  });
});

/**
 * Slice out a single function body from the worker source for scoped
 * assertions. Returns the substring from the declaration to a heuristic end
 * marker; good enough for "this string does / does not appear inside fn X".
 */
function sliceFn(src: string, decl: string): string {
  const start = src.indexOf(decl);
  if (start === -1) return '';
  // Each top-level fn in the worker is followed by another `\n// ====` banner
  // or another `\nasync function` / `\nfunction` declaration. Grab a generous
  // window — these functions are < 120 lines each.
  return src.slice(start, start + 5000);
}
