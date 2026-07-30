/**
 * D2 — Andersen inline `lot exp lot exp lot exp` run (Q4/Q8 A/B, 2026-07-30).
 *
 * WHAT THE DEFECT ACTUALLY IS. The A/B graded these three Andersen COAs as
 * "3 lots expected, 1 extracted". Reading the source PDFs shows that framing is
 * wrong: `418325187C / 346PXN / 151262C` are the 3M Petrifilm **CC / AC /
 * BUFFER reagent lots** printed in the form's "3M PLATES" box — the same three
 * codes appear on all three documents, for three different products on three
 * different dates. They are lab consumables. The document carries NO product
 * lot at all; the product is identified by CODE DATE / JULIAN DATE.
 *
 * So extracting all three as product lots would be the exact error the dairy
 * domain rules call "the single worst error". The real defect is the opposite:
 * those reagent lots were leaking INTO product fields (lot_number, product_code,
 * po_number, expiration_date) on BOTH quantizations.
 *
 * ROOT CAUSE, and why it is a layout rule rather than a supplier quirk: PDF
 * text extraction flattens the boxed form into two runs that land far apart —
 * the labels ("CC LOT#: CC EXP: AC LOT#: AC EXP: BUFFER LOT#: BUFFER EXP:") at
 * one end of the page and the bare values ("418325187C 01/04/'27 346PXN
 * 03/24/'27 151262C 09/01/'27") at the other. The existing "lab consumables are
 * never product data" rule could not fire because the values arrived orphaned
 * from the labels that identify them.
 *
 * The fix is a BASE prompt rule about orphaned label blocks, gated on the
 * presence of an empty label run so it cannot destabilise layouts that do not
 * have one. It is deliberately NOT added to the VLM prompt: the image path
 * sees the box, so there is nothing orphaned to re-pair.
 */

import { describe, it, expect } from 'vitest';
import processWorkerSource from '../../bin/process-worker?raw';

/** The text-path BASE_PROMPT only (the VLM prompt is a separate literal). */
const basePrompt = processWorkerSource.slice(
  processWorkerSource.indexOf('const BASE_PROMPT = `'),
  processWorkerSource.indexOf('const DAIRY_FOOD_INDUSTRY_PROMPT = `')
);

describe('D2 — orphaned label blocks (PDF text flattening)', () => {
  it('lives in the text BASE prompt', () => {
    expect(basePrompt).toContain('6. ORPHANED LABEL BLOCKS (PDF text flattening)');
  });

  it('is gated on an EMPTY LABEL RUN, not on the value run alone', () => {
    // Load-bearing: without the gate the rule would fire on any inline
    // `code date code date` sequence, including layouts where those genuinely
    // ARE product lots. The empty label run is what makes the block orphaned.
    expect(basePrompt).toMatch(/scan the WHOLE page for an empty label run/);
    expect(basePrompt).toContain('CC LOT#: CC EXP: AC LOT#: AC EXP: BUFFER LOT#: BUFFER EXP:');
  });

  it('names the inline lot/expiry-pair run as the value side of the block', () => {
    // This is the layout the A/B flagged: repeated (identifier, date) pairs on
    // one row.
    expect(basePrompt).toMatch(/inline "code date code date code date" sequence/);
    expect(basePrompt).toContain("418325187C 01/04/'27 346PXN 03/24/'27 151262C 09/01/'27");
  });

  it('instructs positional re-pairing of labels to values', () => {
    expect(basePrompt).toMatch(/Re-pair them POSITIONALLY/);
    expect(basePrompt).toMatch(/1st label ← 1st value, 2nd label ← 2nd value/);
  });

  it('forbids promoting orphaned values into product identity fields', () => {
    // The precise failure observed on both arms: 346PXN → product_code,
    // 418325187C → lot_number/po_number, BUFFER EXP → expiration_date,
    // JULIAN DATE → plant_number.
    expect(basePrompt).toMatch(
      /Never promote them to lot_number, sub_lot_code, product_code, po_number, expiration_date or plant_number/
    );
  });

  it('routes the consumable block to its own reagent_lots table', () => {
    expect(basePrompt).toContain('its own table named "reagent_lots"');
    expect(basePrompt).toContain('["item", "lot_number", "expiration_date"]');
    expect(basePrompt).toMatch(
      /leave the product's lot_number and expiration_date null unless the PRODUCT's own lot\/expiry is separately printed/
    );
  });

  it('falls back to the printed code date when the only lot-shaped codes are reagents', () => {
    // These Andersen COAs have no product lot at all; the lot must come from
    // CODE DATE / JULIAN DATE, never from a borrowed reagent code.
    expect(basePrompt).toMatch(/the product has NO lot number of its own/);
    expect(basePrompt).toMatch(/never borrow a reagent lot/);
  });

  it('is NOT copied into the VLM prompt (the image path sees the box)', () => {
    const vlmPrompt = processWorkerSource.slice(
      processWorkerSource.indexOf('VLM-SPECIFIC RULES:')
    );
    expect(vlmPrompt).not.toContain('ORPHANED LABEL BLOCKS');
    // ...but the VLM prompt DOES get the D1 flat sublot slot, which is a
    // schema gap on both paths.
    expect(vlmPrompt).toContain('- sub_lot_code — the sub-lot code that QUALIFIES lot_number');
  });
});
