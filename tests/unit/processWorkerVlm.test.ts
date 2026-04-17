/**
 * Unit tests for the VLM prompt builder and VLM config handling in
 * bin/process-worker.
 *
 * process-worker is a standalone Node daemon (CJS) that can't be imported
 * directly into the Workers test pool, so we load its source as a raw
 * string and assert on the prompt text + config wiring. This is the same
 * strategy extraction-prompt.test.ts uses conceptually — the prompt is the
 * single biggest lever on VLM quality, so the hard rules need regression
 * coverage.
 *
 * Step 2 of the VLM rollout. Once Step 3 (UI) and Step 4 (canary) land,
 * additional tests will cover the dual-run control flow end-to-end.
 */

import { describe, it, expect } from 'vitest';
// Vite's ?raw import — works inside the Workers test pool because Vite
// inlines the file contents at build time.
import processWorkerSource from '../../bin/process-worker?raw';

describe('process-worker — VLM config wiring', () => {
  it('declares QWEN_VLM_MODE with "off" as the default', () => {
    expect(processWorkerSource).toMatch(
      /const QWEN_VLM_MODE = \(process\.env\.QWEN_VLM_MODE \|\| 'off'\)/
    );
  });

  it('declares QWEN_VLM_MODEL defaulting to qwen2.5-vl-7b', () => {
    expect(processWorkerSource).toMatch(
      /const QWEN_VLM_MODEL = process\.env\.QWEN_VLM_MODEL \|\| 'qwen2\.5-vl-7b'/
    );
  });

  it('declares QWEN_VLM_MAX_PAGES with a default of 5 (VRAM cap)', () => {
    expect(processWorkerSource).toMatch(
      /const QWEN_VLM_MAX_PAGES = parseInt\(process\.env\.QWEN_VLM_MAX_PAGES \|\| '5'/
    );
  });

  it('validates QWEN_VLM_MODE against the allowed set', () => {
    // Unknown values should abort startup — prevents silent misconfig.
    expect(processWorkerSource).toMatch(
      /\['off', 'dual', 'vlm'\]\.includes\(QWEN_VLM_MODE\)/
    );
  });
});

describe('process-worker — renderPdfPagesToPng', () => {
  it('enforces the per-PDF page cap via the max_pages argument', () => {
    expect(processWorkerSource).toMatch(
      /VLM skipped: PDF has \$\{numPages\} pages, exceeds cap of \$\{maxPages\}/
    );
  });

  it('renders pages at scale 2.0 (produces ~1500x2000 px for US Letter)', () => {
    expect(processWorkerSource).toMatch(/scale: 2\.0/);
  });

  it('rejects tiny PNGs as a guard against the GGML_ASSERT 2x2-pixel crash', () => {
    // The Windows GPU host (Step 1) crashed llama.cpp's CLIP encoder when
    // given a < 2x2 image. scale:2.0 on a real page never produces anything
    // near this size, but the safety check is load-bearing: surface the
    // problem cleanly instead of crashing the VLM server.
    expect(processWorkerSource).toMatch(/png\.length < 100/);
    expect(processWorkerSource).toMatch(/likely < 2x2 pixels/);
  });
});

describe('process-worker — buildVlmPrompt', () => {
  // The prompt source lives as a template literal in the worker source.
  // We slice out the VLM_HEADER block and assert on its contents. This
  // keeps the test independent of the function's actual runtime behavior
  // while still catching any accidental removal of hard rules.
  const vlmHeaderMatch = processWorkerSource.match(
    /const VLM_HEADER = `([\s\S]*?)`;/
  );
  const vlmHeader = vlmHeaderMatch ? vlmHeaderMatch[1] : '';

  it('extracts a non-empty VLM_HEADER block', () => {
    expect(vlmHeader.length).toBeGreaterThan(500);
  });

  it('tells the model it is looking at an image (no OCR)', () => {
    // The whole point of the VLM path — if this wording drifts, we lose
    // the benefit over the text path.
    expect(vlmHeader).toMatch(/image of the document/i);
    expect(vlmHeader).toMatch(/no OCR/i);
  });

  it('includes the column-by-position rule (the core VLM win)', () => {
    // This is why we moved to VLM: the text path merged columns when the
    // PDF had no whitespace. VLM can read positions directly.
    expect(vlmHeader).toMatch(/column by its physical position/i);
    expect(vlmHeader).toMatch(/left-to-right/i);
    expect(vlmHeader).toMatch(/preserving column boundaries/i);
  });

  it('forbids merging values from adjacent columns', () => {
    expect(vlmHeader).toMatch(/Never merge or infer values from adjacent columns/i);
  });

  it('includes the "customer names never end in digits" rule', () => {
    // Bug #5 from extraction-prompt.test.ts reference — weight/count values
    // bleeding into customer_name. Must be encoded in the VLM prompt too.
    expect(vlmHeader).toMatch(/Customer names do NOT end in numbers/i);
    expect(vlmHeader).toMatch(/strip trailing digits/i);
  });

  it('still includes the canonical field list (snake_case contract)', () => {
    // Downstream canonicalizeFields()/parseExtraction() rely on these.
    for (const field of [
      'supplier_name',
      'customer_name',
      'product_name',
      'lot_number',
      'po_number',
      'code_date',
      'expiration_date',
    ]) {
      expect(vlmHeader).toContain(field);
    }
  });

  it('pins po_number to an explicit label (anti-hallucination)', () => {
    // Must be at least as strict as the text-path prompt — otherwise the
    // VLM will gladly backfill PO# from whatever column is adjacent.
    expect(vlmHeader).toMatch(/ONLY populate if an explicit "PO"/i);
    expect(vlmHeader).toMatch(/Do NOT infer or fabricate/i);
  });

  it('returns the same JSON output schema as the text-path prompt', () => {
    // Downstream code does not care which path produced the JSON — this
    // guarantee lets us swap primary paths by flipping QWEN_VLM_MODE.
    expect(vlmHeader).toMatch(/"fields":/);
    expect(vlmHeader).toMatch(/"tables":/);
    expect(vlmHeader).toMatch(/"products":/);
    expect(vlmHeader).toMatch(/"_confidence":/);
    expect(vlmHeader).toMatch(/"document_type":/);
  });
});

describe('process-worker — dual-run control flow', () => {
  it('branches processItem on QWEN_VLM_MODE', () => {
    expect(processWorkerSource).toMatch(/QWEN_VLM_MODE === 'vlm'/);
    expect(processWorkerSource).toMatch(/QWEN_VLM_MODE === 'dual'/);
  });

  it('only runs VLM on PDFs (not text/images)', () => {
    // VLM path rendering assumes a PDF — other mime types use the text
    // or OCR path exclusively.
    expect(processWorkerSource).toMatch(
      /QWEN_VLM_MODE !== 'off' && item\.mime_type === 'application\/pdf'/
    );
  });

  it('falls back to the text path when VLM primary fails', () => {
    expect(processWorkerSource).toMatch(/VLM primary failed/i);
  });

  it('attaches vlm_* columns to the results payload when VLM ran', () => {
    expect(processWorkerSource).toMatch(/resultBody\.vlm_extracted_fields/);
    expect(processWorkerSource).toMatch(/resultBody\.vlm_extracted_tables/);
    expect(processWorkerSource).toMatch(/resultBody\.vlm_model/);
    expect(processWorkerSource).toMatch(/resultBody\.vlm_duration_ms/);
    expect(processWorkerSource).toMatch(/resultBody\.vlm_error/);
  });
});
