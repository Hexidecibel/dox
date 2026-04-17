/**
 * Unit tests for the pure VLM vs text diff helpers that power the dual-run
 * compare UI on ReviewQueue. These functions have zero React dependencies —
 * they are the same module the component imports, so if these pass, the
 * diff rendering is guaranteed to match.
 *
 * Covers:
 *   - diffFields() — pairwise match / differ / text-only / vlm-only logic
 *   - summarizeDiff() — the count badge above the compare table
 *   - mergeFieldSelection() — how per-field picks turn into a final blob
 *   - shouldShowDualCompare() — the predicate that hides the UI when only
 *     one side has output (the common case today when QWEN_VLM_MODE=off)
 *   - readTextPayload / readVlmPayload — robust JSON parsing
 */

import { describe, it, expect } from 'vitest';
import {
  diffFields,
  summarizeDiff,
  mergeFieldSelection,
  shouldShowDualCompare,
  hasTextExtraction,
  hasVlmExtraction,
  readTextPayload,
  readVlmPayload,
} from '../../src/pages/reviewVlmDiff';
import type { ProcessingQueueItem } from '../../shared/types';

function makeQueueItem(overrides: Partial<ProcessingQueueItem> = {}): ProcessingQueueItem {
  return {
    id: 'q1',
    tenant_id: 't1',
    document_type_id: null,
    file_r2_key: 'queue/q1/file.pdf',
    file_name: 'file.pdf',
    file_size: 1024,
    mime_type: 'application/pdf',
    extracted_text: null,
    ai_fields: null,
    ai_confidence: null,
    confidence_score: null,
    product_names: null,
    supplier: null,
    document_type_guess: null,
    status: 'pending',
    processing_status: 'ready',
    error_message: null,
    checksum: null,
    tables: null,
    summary: null,
    reviewed_by: null,
    reviewed_at: null,
    created_by: null,
    created_at: '2026-04-13T10:00:00.000Z',
    template_id: null,
    auto_ingested: 0,
    source: null,
    source_detail: null,
    vlm_extracted_fields: null,
    vlm_extracted_tables: null,
    vlm_confidence: null,
    vlm_error: null,
    vlm_model: null,
    vlm_duration_ms: null,
    vlm_extracted_at: null,
    ...overrides,
  };
}

describe('diffFields', () => {
  it('returns an empty array when both sides are empty', () => {
    expect(diffFields({}, {})).toEqual([]);
  });

  it('marks identical values as match (trimmed comparison)', () => {
    const rows = diffFields(
      { supplier_name: 'ACME', lot_number: 'L-1' },
      { supplier_name: 'ACME ', lot_number: 'L-1' }
    );
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.status === 'match')).toBe(true);
  });

  it('marks differing non-null values as differ', () => {
    const rows = diffFields(
      { supplier_name: 'ACME' },
      { supplier_name: 'ACME CORPORATION' }
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('differ');
    expect(rows[0].textValue).toBe('ACME');
    expect(rows[0].vlmValue).toBe('ACME CORPORATION');
  });

  it('marks fields only in text as text_only', () => {
    const rows = diffFields({ po_number: 'PO-1' }, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('text_only');
    expect(rows[0].vlmValue).toBeNull();
  });

  it('marks fields only in vlm as vlm_only', () => {
    const rows = diffFields({}, { expiration_date: '2026-05-01' });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('vlm_only');
    expect(rows[0].textValue).toBeNull();
  });

  it('treats empty strings as missing (same as null)', () => {
    const rows = diffFields(
      { supplier_name: 'ACME', po_number: '' },
      { supplier_name: '', po_number: 'PO-1' }
    );
    expect(rows).toHaveLength(2);
    const by = Object.fromEntries(rows.map(r => [r.key, r]));
    expect(by.supplier_name.status).toBe('text_only');
    expect(by.po_number.status).toBe('vlm_only');
  });

  it('skips rows where both sides are empty/null', () => {
    const rows = diffFields({ foo: '' }, { foo: '' });
    expect(rows).toHaveLength(0);
  });

  it('returns rows sorted by key for deterministic rendering', () => {
    const rows = diffFields(
      { zebra: 'z', alpha: 'a', mid: 'm' },
      { zebra: 'z', alpha: 'a', mid: 'm' }
    );
    expect(rows.map(r => r.key)).toEqual(['alpha', 'mid', 'zebra']);
  });

  it('handles the union of keys across both sides', () => {
    const rows = diffFields(
      { a: 'text-a', shared: 'same' },
      { b: 'vlm-b', shared: 'same' }
    );
    expect(rows.map(r => r.key)).toEqual(['a', 'b', 'shared']);
  });
});

describe('summarizeDiff', () => {
  it('counts rows by status', () => {
    const rows = diffFields(
      { match_me: 'x', only_text: 'y', differ_me: 'old' },
      { match_me: 'x', only_vlm: 'z', differ_me: 'new' }
    );
    const s = summarizeDiff(rows);
    expect(s.match).toBe(1);
    expect(s.differ).toBe(1);
    expect(s.textOnly).toBe(1);
    expect(s.vlmOnly).toBe(1);
    expect(s.total).toBe(4);
  });

  it('handles an all-match set', () => {
    const rows = diffFields({ a: '1', b: '2' }, { a: '1', b: '2' });
    const s = summarizeDiff(rows);
    expect(s).toEqual({ match: 2, differ: 0, textOnly: 0, vlmOnly: 0, total: 2 });
  });
});

describe('mergeFieldSelection', () => {
  it('uses the default source when no per-field picks exist', () => {
    const merged = mergeFieldSelection(
      { supplier_name: 'text-val', lot_number: 'L-text' },
      { supplier_name: 'vlm-val', lot_number: 'L-vlm' },
      {},
      'vlm'
    );
    expect(merged).toEqual({ supplier_name: 'vlm-val', lot_number: 'L-vlm' });
  });

  it('honors per-field picks', () => {
    const merged = mergeFieldSelection(
      { supplier_name: 'ACME', lot_number: 'L-text' },
      { supplier_name: 'ACME CORPORATION', lot_number: 'L-vlm' },
      { supplier_name: 'vlm', lot_number: 'text' },
      'text'
    );
    expect(merged).toEqual({
      supplier_name: 'ACME CORPORATION',
      lot_number: 'L-text',
    });
  });

  it('falls back to the other side when the chosen side is empty', () => {
    const merged = mergeFieldSelection(
      { po_number: 'PO-42' },
      {},
      { po_number: 'vlm' },
      'vlm'
    );
    expect(merged).toEqual({ po_number: 'PO-42' });
  });

  it('handles disjoint key sets', () => {
    const merged = mergeFieldSelection(
      { a: 'from-text' },
      { b: 'from-vlm' },
      {},
      'text'
    );
    expect(merged).toEqual({ a: 'from-text', b: 'from-vlm' });
  });
});

describe('hasTextExtraction / hasVlmExtraction / shouldShowDualCompare', () => {
  it('returns false when neither side has output (QWEN_VLM_MODE=off)', () => {
    const item = makeQueueItem();
    expect(hasTextExtraction(item)).toBe(false);
    expect(hasVlmExtraction(item)).toBe(false);
    expect(shouldShowDualCompare(item)).toBe(false);
  });

  it('returns false when only text is populated (non-dual case)', () => {
    const item = makeQueueItem({
      ai_fields: JSON.stringify({ supplier_name: 'ACME' }),
    });
    expect(hasTextExtraction(item)).toBe(true);
    expect(hasVlmExtraction(item)).toBe(false);
    expect(shouldShowDualCompare(item)).toBe(false);
  });

  it('returns false when only VLM is populated (QWEN_VLM_MODE=vlm case)', () => {
    const item = makeQueueItem({
      vlm_extracted_fields: JSON.stringify({ supplier_name: 'ACME' }),
    });
    expect(hasVlmExtraction(item)).toBe(true);
    expect(hasTextExtraction(item)).toBe(false);
    expect(shouldShowDualCompare(item)).toBe(false);
  });

  it('returns true when both sides are populated (QWEN_VLM_MODE=dual success)', () => {
    const item = makeQueueItem({
      ai_fields: JSON.stringify({ supplier_name: 'ACME' }),
      vlm_extracted_fields: JSON.stringify({ supplier_name: 'ACME CORP' }),
    });
    expect(shouldShowDualCompare(item)).toBe(true);
  });

  it('treats a VLM error as "no VLM extraction" — compare UI stays hidden', () => {
    const item = makeQueueItem({
      ai_fields: JSON.stringify({ supplier_name: 'ACME' }),
      vlm_error: 'VLM timed out',
      vlm_model: 'qwen2.5-vl-7b',
    });
    expect(hasVlmExtraction(item)).toBe(false);
    expect(shouldShowDualCompare(item)).toBe(false);
  });

  it('counts tables-only VLM output as a valid VLM extraction', () => {
    const item = makeQueueItem({
      ai_fields: JSON.stringify({ supplier_name: 'ACME' }),
      vlm_extracted_tables: JSON.stringify([
        { name: 't1', headers: ['a'], rows: [['1']] },
      ]),
    });
    expect(hasVlmExtraction(item)).toBe(true);
    expect(shouldShowDualCompare(item)).toBe(true);
  });
});

describe('readTextPayload / readVlmPayload', () => {
  it('parses JSON safely and fills defaults', () => {
    const item = makeQueueItem({
      ai_fields: JSON.stringify({ supplier_name: 'ACME' }),
      confidence_score: 0.8,
      tables: JSON.stringify([{ name: 't', headers: ['h'], rows: [['v']] }]),
    });
    const text = readTextPayload(item);
    expect(text.fields).toEqual({ supplier_name: 'ACME' });
    expect(text.confidence).toBe(0.8);
    expect(text.tables).toHaveLength(1);
  });

  it('degrades gracefully on malformed JSON', () => {
    const item = makeQueueItem({
      ai_fields: '{bad json',
      tables: 'also-bad',
    });
    const text = readTextPayload(item);
    expect(text.fields).toEqual({});
    expect(text.tables).toEqual([]);
  });

  it('extracts VLM model/duration/error metadata', () => {
    const item = makeQueueItem({
      vlm_extracted_fields: JSON.stringify({ supplier_name: 'ACME' }),
      vlm_confidence: 0.95,
      vlm_model: 'qwen2.5-vl-7b',
      vlm_duration_ms: 12_500,
      vlm_error: null,
    });
    const vlm = readVlmPayload(item);
    expect(vlm.fields).toEqual({ supplier_name: 'ACME' });
    expect(vlm.confidence).toBe(0.95);
    expect(vlm.model).toBe('qwen2.5-vl-7b');
    expect(vlm.durationMs).toBe(12_500);
    expect(vlm.error).toBeNull();
  });

  it('coerces non-string field values to strings', () => {
    const item = makeQueueItem({
      ai_fields: JSON.stringify({ lot_count: 42, active: true }),
    });
    const text = readTextPayload(item);
    expect(text.fields).toEqual({ lot_count: '42', active: 'true' });
  });

  it('filters out malformed tables (missing headers/rows)', () => {
    const item = makeQueueItem({
      vlm_extracted_tables: JSON.stringify([
        { name: 'good', headers: ['a'], rows: [['1']] },
        { name: 'bad', headers: null, rows: [['1']] },
        'not an object',
      ]),
    });
    const vlm = readVlmPayload(item);
    expect(vlm.tables).toHaveLength(1);
    expect(vlm.tables[0].name).toBe('good');
  });
});
