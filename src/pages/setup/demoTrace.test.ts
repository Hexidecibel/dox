/**
 * The wizard's last screen, reduced to the two questions that decide whether it
 * is honest: WHERE IS THE DEMO, and WHAT MAY IT SAY.
 *
 * These are the paths a demo actually hits. The happy path is exercised every
 * time anybody uploads anything anywhere in the product; the worker being down
 * and the model cold-starting with a 502 are the states that only this screen
 * has to render, in front of the person deciding whether to buy the thing.
 *
 * The trace assertions are all of one shape: given evidence that a stage did
 * NOT happen, the line for it must be ABSENT rather than optimistic. A demo
 * that narrates stages it did not watch will narrate them just as confidently
 * on the day the pipeline is broken.
 */

import { describe, it, expect } from 'vitest';
import {
  DEMO_TIMEOUT_MS,
  WORKER_SILENT_MS,
  buildTrace,
  classifyDemo,
  confidenceBand,
  isColdStartError,
  isWatching,
} from './demoTrace';
import type { DocumentTypeRequirementRow, ProcessingQueueItem } from '../../lib/types';

function queueItem(over: Partial<ProcessingQueueItem> = {}): ProcessingQueueItem {
  return {
    id: 'q1',
    tenant_id: 't1',
    document_type_id: null,
    file_r2_key: 'k',
    file_name: 'coa.pdf',
    file_size: 100,
    mime_type: 'application/pdf',
    extracted_text: null,
    ai_fields: null,
    ai_confidence: null,
    confidence_score: null,
    confidence: null,
    product_names: null,
    supplier: null,
    supplier_id: null,
    document_type_guess: null,
    status: 'pending',
    processing_status: 'queued',
    error_message: null,
    checksum: null,
    tables: null,
    summary: null,
    reviewed_by: null,
    reviewed_at: null,
    created_by: null,
    created_at: '2026-09-03T00:00:00Z',
    template_id: null,
    auto_ingested: 0,
    source: null,
    source_detail: null,
    output_kind: 'coa',
    origin_kind: null,
    ai_records: null,
    source_id: null,
    connector_run_id: null,
    vlm_extracted_fields: null,
    vlm_extracted_tables: null,
    vlm_confidence: null,
    vlm_error: null,
    vlm_model: null,
    vlm_duration_ms: null,
    vlm_extracted_at: null,
    text_model: null,
    learned_field_hints: null,
    uncertainty: null,
    ...over,
  };
}

const requirement = (name: string): DocumentTypeRequirementRow => ({
  requirement_id: `req-${name}`,
  requirement_name: name,
  requirement_slug: name.toLowerCase().replace(/\W+/g, '-'),
  requirement_checklist: null,
  source: 'pack',
});

describe('classifyDemo — the failure states', () => {
  it('is idle before anything has been uploaded, and uploading while it is', () => {
    expect(classifyDemo({ item: null, elapsedMs: 0 })).toEqual({ kind: 'idle' });
    expect(classifyDemo({ item: null, elapsedMs: 0, uploading: true })).toEqual({
      kind: 'uploading',
    });
  });

  it('reports an upload that never produced a queue row separately', () => {
    // Distinct from every worker state: nothing was queued, so telling somebody
    // to start the worker would be the wrong instruction.
    expect(classifyDemo({ item: null, elapsedMs: 0, uploadError: 'File too large' })).toEqual({
      kind: 'upload_failed',
      message: 'File too large',
    });
  });

  it('does not accuse a healthy worker while it is still between polls', () => {
    // bin/process-worker polls every 30s by default, so an item sitting
    // untouched for most of a minute is NORMAL. A threshold under one poll
    // interval would tell people to restart a worker that is running fine.
    const state = classifyDemo({ item: queueItem(), elapsedMs: WORKER_SILENT_MS - 1 });
    expect(state).toEqual({ kind: 'queued' });
    expect(isWatching(state)).toBe(true);
  });

  it('says the worker is not running once nothing has picked the item up', () => {
    const state = classifyDemo({ item: queueItem(), elapsedMs: WORKER_SILENT_MS });
    expect(state).toEqual({ kind: 'worker_silent' });
    // NOT terminal. The message promises the page picks up where it left off,
    // and that promise is only true if we keep polling.
    expect(isWatching(state)).toBe(true);
  });

  it('leaves worker_silent as soon as the worker takes the item', () => {
    const state = classifyDemo({
      item: queueItem({ processing_status: 'processing' }),
      elapsedMs: WORKER_SILENT_MS * 3,
    });
    expect(state).toEqual({ kind: 'extracting' });
  });

  it('reports a cold-start 502 as retryable, with the worker’s own message', () => {
    const state = classifyDemo({
      item: queueItem({
        processing_status: 'error',
        error_message: 'Qwen call failed: Qwen HTTP 502: upstream connect error',
      }),
      elapsedMs: 4_000,
    });
    expect(state).toEqual({
      kind: 'failed',
      coldStart: true,
      message: 'Qwen call failed: Qwen HTTP 502: upstream connect error',
    });
    expect(isWatching(state)).toBe(false);
  });

  it('still offers the failure state when the message is not a cold start', () => {
    const state = classifyDemo({
      item: queueItem({ processing_status: 'error', error_message: 'PDF has no text layer' }),
      elapsedMs: 4_000,
    });
    expect(state).toEqual({
      kind: 'failed',
      coldStart: false,
      message: 'PDF has no text layer',
    });
  });

  it('never leaves a failed item without a sentence', () => {
    const state = classifyDemo({
      item: queueItem({ processing_status: 'error', error_message: null }),
      elapsedMs: 1_000,
    });
    expect(state.kind).toBe('failed');
    expect(state.kind === 'failed' && state.message.length).toBeGreaterThan(0);
  });

  it('gives up rather than spinning forever, and says which way it was stuck', () => {
    expect(classifyDemo({ item: queueItem(), elapsedMs: DEMO_TIMEOUT_MS })).toEqual({
      kind: 'timed_out',
      lastStatus: 'queued',
    });
    expect(
      classifyDemo({
        item: queueItem({ processing_status: 'processing' }),
        elapsedMs: DEMO_TIMEOUT_MS,
      }),
    ).toEqual({ kind: 'timed_out', lastStatus: 'processing' });
    expect(isWatching({ kind: 'timed_out', lastStatus: 'queued' })).toBe(false);
  });

  it('prefers a real error to the clock — we know what went wrong', () => {
    const state = classifyDemo({
      item: queueItem({ processing_status: 'error', error_message: 'boom' }),
      elapsedMs: DEMO_TIMEOUT_MS * 2,
    });
    expect(state.kind).toBe('failed');
  });

  it('reaches ready and stops watching', () => {
    const state = classifyDemo({
      item: queueItem({ processing_status: 'ready' }),
      elapsedMs: 10_000,
    });
    expect(state).toEqual({ kind: 'ready' });
    expect(isWatching(state)).toBe(false);
  });
});

describe('isColdStartError', () => {
  it('recognises what the worker and the model router actually write', () => {
    expect(isColdStartError('Qwen call failed: Qwen HTTP 502: ...')).toBe(true);
    expect(isColdStartError('No available model for tag "best". Tried chain: ...')).toBe(true);
    expect(isColdStartError('fetch failed')).toBe(true);
    expect(isColdStartError('The operation was aborted')).toBe(true);
  });

  it('does not claim a document problem is the machine waking up', () => {
    expect(isColdStartError('PDF has no extractable text')).toBe(false);
    expect(isColdStartError(null)).toBe(false);
    expect(isColdStartError('')).toBe(false);
  });
});

describe('buildTrace — a stage with no evidence produces no line', () => {
  const keys = (lines: ReturnType<typeof buildTrace>) => lines.map((l) => l.key);

  it('emits nothing at all before a queue row exists', () => {
    expect(
      buildTrace({
        item: null,
        typeRequirements: null,
        hasTypeInstructions: null,
        renewalOwner: null,
      }),
    ).toEqual([]);
  });

  it('a queued item has been queued and nothing else', () => {
    const lines = buildTrace({
      item: queueItem(),
      typeRequirements: null,
      hasTypeInstructions: null,
      renewalOwner: null,
    });
    expect(keys(lines)).toEqual(['queued']);
  });

  it('omits every line whose side read has not come back', () => {
    // The classification happened — that is on the row. The other three are
    // NULL, meaning "not read", and a null read must never be rendered as an
    // answer.
    const lines = buildTrace({
      item: queueItem({ processing_status: 'ready', document_type_name: 'Specification Sheet' }),
      typeRequirements: null,
      hasTypeInstructions: null,
      renewalOwner: null,
    });
    expect(keys(lines)).toEqual(['queued', 'classified']);
  });

  it('distinguishes "closes nothing" from "we did not look"', () => {
    const notLooked = buildTrace({
      item: queueItem({ processing_status: 'ready', document_type_name: 'Spec Sheet' }),
      typeRequirements: null,
      hasTypeInstructions: null,
      renewalOwner: null,
    });
    expect(keys(notLooked)).not.toContain('requirements');

    const looked = buildTrace({
      item: queueItem({ processing_status: 'ready', document_type_name: 'Spec Sheet' }),
      typeRequirements: [],
      hasTypeInstructions: null,
      renewalOwner: null,
    });
    const line = looked.find((l) => l.key === 'requirements');
    expect(line?.tone).toBe('info');
    expect(line?.text).toContain('closes nothing');
  });

  it('states the checklist consequence in the FUTURE tense — nothing is written yet', () => {
    const lines = buildTrace({
      item: queueItem({ processing_status: 'ready', document_type_name: 'Spec Sheet' }),
      typeRequirements: [requirement('Allergen matrix'), requirement('Micro limits')],
      hasTypeInstructions: null,
      renewalOwner: null,
    });
    const line = lines.find((l) => l.key === 'requirements');
    expect(line?.text).toBe('2 checklist items will be proposed when you approve it');
    expect(line?.detail).toBe('Allergen matrix, Micro limits');
  });

  it('does not claim a supplier was created — nothing is created before approval', () => {
    const unknown = buildTrace({
      item: queueItem({ processing_status: 'ready', supplier: 'Darigold', supplier_id: null }),
      typeRequirements: null,
      hasTypeInstructions: null,
      renewalOwner: null,
    }).find((l) => l.key === 'supplier');
    expect(unknown?.text).toContain('read from the document');
    expect(unknown?.detail).toContain('created when you approve');

    const known = buildTrace({
      item: queueItem({ processing_status: 'ready', supplier: 'Darigold', supplier_id: 's1' }),
      typeRequirements: null,
      hasTypeInstructions: null,
      renewalOwner: null,
    }).find((l) => l.key === 'supplier');
    expect(known?.text).toContain('recognised');
  });

  it('reports missing type instructions as a gap rather than pretending they ran', () => {
    const lines = buildTrace({
      item: queueItem({ processing_status: 'ready', document_type_name: 'Spec Sheet' }),
      typeRequirements: null,
      hasTypeInstructions: false,
      renewalOwner: null,
    });
    const line = lines.find((l) => l.key === 'instructions');
    expect(line?.tone).toBe('info');
    expect(line?.text).toContain('No reading instructions');
  });

  it('an unrouted renewal owner is a warning, because nobody is emailed', () => {
    const line = buildTrace({
      item: queueItem({ processing_status: 'ready' }),
      typeRequirements: null,
      hasTypeInstructions: null,
      renewalOwner: { label: 'Insurance', recipients: [] },
    }).find((l) => l.key === 'owner');
    expect(line?.tone).toBe('warn');
    expect(line?.detail).toContain('do not fall back to the admin pool');
  });

  it('renders one line per out-of-spec result, carrying the engine’s own sentence', () => {
    const lines = buildTrace({
      item: queueItem({
        processing_status: 'ready',
        spec_results: [
          {
            scope: 'ai_fields',
            target: { kind: 'group', group: 'micro', cell: 'coliform' },
            test_name_raw: 'Coliform',
            value_raw: '40',
            unit_raw: 'CFU/g',
            verdict: 'out_of_spec',
            source: 'limit',
            limit_text: '≤ 10 CFU/g',
            reason: 'value 40 > max 10',
            message: 'Coliform 40 CFU/g — your limit is ≤ 10 CFU/g',
          },
          {
            scope: 'ai_fields',
            target: { kind: 'group', group: 'micro', cell: 'yeast' },
            test_name_raw: 'Yeast',
            value_raw: '5',
            unit_raw: 'CFU/g',
            verdict: 'in_spec',
            source: 'limit',
            limit_text: '≤ 10 CFU/g',
            reason: 'ok',
            message: 'Yeast is within your limit',
          },
        ],
        spec_summary: { out_of_spec: 1, not_checked: 2, unmatched: 3 },
      }),
      typeRequirements: null,
      hasTypeInstructions: null,
      renewalOwner: null,
    });

    const warn = lines.filter((l) => l.tone === 'warn');
    expect(warn).toHaveLength(1);
    expect(warn[0].text).toBe('Coliform 40 CFU/g — your limit is ≤ 10 CFU/g');

    // `not_checked` is never a silent pass, so the count has to be visible.
    const summary = lines.find((l) => l.key === 'spec-summary');
    expect(summary?.text).toContain('2 could not be judged');
    expect(summary?.text).toContain('3 we hold no limit for');
  });
});

describe('confidenceBand', () => {
  it('buckets at the same thresholds the Review Queue colours its chips at', () => {
    expect(confidenceBand(queueItem({ confidence: 0.9 }))).toBe('high');
    expect(confidenceBand(queueItem({ confidence: 0.6 }))).toBe('medium');
    expect(confidenceBand(queueItem({ confidence: 0.2 }))).toBe('low');
  });

  it('falls back to the deterministic score, and reports nothing when there is nothing', () => {
    expect(confidenceBand(queueItem({ confidence: null, confidence_score: 0.85 }))).toBe('high');
    // No signal is not low confidence. The caller drops the parenthetical
    // rather than printing "confidence: unknown".
    expect(confidenceBand(queueItem())).toBeNull();
  });
});
