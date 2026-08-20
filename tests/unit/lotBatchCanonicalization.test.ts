/**
 * Lot vs batch — the Michael Foods COA (2026-08-20).
 *
 * That document prints BOTH `Lot#: 6203G` and `Batch Number: 2586083`. The
 * schema had no `batch_number` field and declared `batch` to be an ALIAS of
 * `lot_number`, so the two identifiers competed for one slot and the winner was
 * decided by the order the model happened to emit its JSON keys. Whichever lost
 * was discarded with no warning and no trace — and if the batch won, every
 * downstream lot match was against a number the WMS has never heard of.
 *
 * Two rules come out of that and both are pinned here:
 *   1. An EXACT canonical key always beats an alias, whatever the key order.
 *   2. A batch IS the lot only when no separate lot was printed.
 */

import { describe, it, expect } from 'vitest';
import { canonicalizeFields } from '../../functions/lib/llm';
import processWorkerSource from '../../bin/process-worker?raw';

describe('lot vs batch', () => {
  it('keeps both when the document prints both', () => {
    const out = canonicalizeFields({ lot_number: '6203G', batch_number: '2586083' });
    expect(out.lot_number).toBe('6203G');
    expect(out.batch_number).toBe('2586083');
  });

  it('does not care which order the model emitted them in', () => {
    // This is the whole bug: key order used to decide which identifier survived.
    const a = canonicalizeFields({ batch_number: '2586083', lot_number: '6203G' });
    const b = canonicalizeFields({ lot_number: '6203G', batch_number: '2586083' });
    expect(a.lot_number).toBe('6203G');
    expect(b.lot_number).toBe('6203G');
    expect(a).toEqual(b);
  });

  it('promotes a lone batch to the lot — the common case', () => {
    const out = canonicalizeFields({ batch_number: '2586083' });
    expect(out.lot_number).toBe('2586083');
    expect(out.batch_number).toBeUndefined();
  });

  it('promotes a lone batch under any spelling', () => {
    for (const key of ['batch', 'batch_no', 'batch_code']) {
      expect(canonicalizeFields({ [key]: 'B1' }).lot_number).toBe('B1');
    }
  });

  it('treats a blank lot as no lot at all', () => {
    expect(canonicalizeFields({ lot_number: '   ', batch_number: 'B1' }).lot_number).toBe('B1');
  });

  it('never lets an alias outrank the real field name', () => {
    // The general form of the defect, beyond lot/batch.
    const out = canonicalizeFields({ lot: 'FROM-ALIAS', lot_number: 'REAL' });
    expect(out.lot_number).toBe('REAL');
  });

  it('still folds aliases when the canonical key is absent', () => {
    expect(canonicalizeFields({ lot: 'A1' }).lot_number).toBe('A1');
    expect(canonicalizeFields({ vendor: 'Acme' }).supplier_name).toBe('Acme');
  });
});

describe('the worker prompt says a batch is not a sublot', () => {
  it('declares batch_number as its own field', () => {
    expect(processWorkerSource).toContain('- batch_number —');
  });

  it('tells the model explicitly that a batch is not a sublot', () => {
    // Without the negative, the model has a second identifier and only one
    // "second identifier" slot to put it in, and picks sub_lot_code.
    expect(processWorkerSource).toContain('is NOT a sublot');
  });

  it('no longer lists batch as an alias of lot_number', () => {
    expect(processWorkerSource).not.toContain(
      "lot_number: ['lot_no', 'lot_num', 'lot', 'batch_number', 'batch_no', 'batch', 'run_number', 'lot_code']"
    );
  });

  it('keeps the batch-is-the-lot promotion in the worker too', () => {
    expect(processWorkerSource).toContain('result.lot_number = result.batch_number');
  });
});
