/**
 * shared/extractionInvariants.ts — the review-gate checks.
 *
 * The anchor case is REAL: two Andersen Dairy "CREAM HG" COAs were APPROVED by
 * a human with 3M plate REAGENT lot numbers filed as product identity (see the
 * 2026-08-01 rejected-population study, §4.4 "QC reagent lots harvested as
 * product identity"). That form's header lists `CC LOT#`, `AC LOT#` and
 * `BUFFER LOT#` with their own expiries, and the model harvested them as
 * `product_code` / `po_number` / `plant_number`. Every text-grounding check is
 * blind to that — the values really are in the document — which is exactly why
 * `field_label_mismatch` reads the label printed next to the value.
 *
 * These tests also pin the FALSE-POSITIVE guarantees, which matter as much as
 * the detections: a warned reviewer who is wrong twice stops reading warnings.
 */

import { describe, it, expect } from 'vitest';
import { checkExtraction } from '../../shared/extractionInvariants';
import type { InvariantFailure } from '../../shared/extractionInvariants';

/** An Andersen-Dairy-shaped COA header, reagent lots and all. */
const ANDERSEN_TEXT = `
ANDERSEN DAIRY, INC.
1234 Dairy Lane, Battle Ground WA 98604
Phone: 360-687-7171   Fax: 360-687-7172
Plant #: 53-98

CERTIFICATE OF ANALYSIS

CC LOT#: 347DMK        EXP: 2027-06-01
AC LOT#: 418325212A    EXP: 2027-08-01
BUFFER LOT#: 151262C   EXP: 2027-09-01

Item #: 40122
Product: CREAM HG 40%
Lot: 061926LC3
Pack: 5 Gallon
Butterfat: 40.73
`;

function warn(fields: Record<string, unknown>, text = ANDERSEN_TEXT): InvariantFailure[] {
  return checkExtraction({ ai_fields: JSON.stringify(fields), extracted_text: text }).failures;
}

function find(fs: InvariantFailure[], check: string, field: string) {
  return fs.find((f) => f.check === check && f.field === field);
}

describe('field_label_mismatch — the reagent-lot case that got approved', () => {
  it('flags a reagent lot number filed as plant_number', () => {
    const f = find(warn({ plant_number: '151262C' }), 'field_label_mismatch', 'plant_number');
    expect(f).toBeDefined();
    // The reviewer must be told WHICH label contradicts the field, in one line.
    expect(f!.message).toContain('BUFFER LOT#');
    expect(f!.message).toContain('lot number');
    expect(f!.message).not.toContain('field_label_mismatch');
  });

  it('flags the coliform-plate reagent lot filed as product_code', () => {
    const f = find(warn({ product_code: '347DMK' }), 'field_label_mismatch', 'product_code');
    expect(f).toBeDefined();
    expect(f!.message).toContain('CC LOT#');
  });

  it('flags a PO number filed as the lot number', () => {
    const text = 'DARIGOLD COA\nPURCHASE ORDER #: K134561\nLOT: 10426110\n';
    const f = find(warn({ lot_number: 'K134561' }, text), 'field_label_mismatch', 'lot_number');
    expect(f).toBeDefined();
    expect(f!.message).toContain('purchase order');
  });

  it('does NOT flag values that carry their own correct label', () => {
    const fs = warn({ plant_number: '53-98', product_code: '40122', lot_number: '061926LC3' });
    expect(fs.filter((x) => x.check === 'field_label_mismatch')).toHaveLength(0);
  });

  it('does NOT flag a value that appears with no label at all', () => {
    const fs = warn({ plant_number: '98604' }); // part of the address, unlabelled
    expect(find(fs, 'field_label_mismatch', 'plant_number')).toBeUndefined();
  });

  it('does NOT match a value embedded inside a longer token', () => {
    // "4012" must not match inside "40122" and inherit its Item# label.
    const fs = warn({ plant_number: '4012' });
    expect(find(fs, 'field_label_mismatch', 'plant_number')).toBeUndefined();
  });

  it('passes when ANY occurrence carries the right label, even if another does not', () => {
    const text = 'PO #: 40122\nItem #: 40122\n';
    const fs = warn({ product_code: '40122' }, text);
    expect(find(fs, 'field_label_mismatch', 'product_code')).toBeUndefined();
  });
});

describe('product_code_not_phone', () => {
  it('flags the supplier phone number filed as a product code', () => {
    const f = find(warn({ product_code: '360-687-7171' }), 'product_code_not_phone', 'product_code');
    expect(f).toBeDefined();
    expect(f!.message).toMatch(/phone|fax/i);
  });

  it('does not accuse a bare numeric SKU of being a phone number', () => {
    const fs = warn({ product_code: '4018325212' });
    expect(find(fs, 'product_code_not_phone', 'product_code')).toBeUndefined();
  });
});

describe('text grounding', () => {
  it('flags a lot number that appears nowhere in the document', () => {
    const f = find(warn({ lot_number: 'ZZ99999' }), 'lot_in_text', 'lot_number');
    expect(f).toBeDefined();
    expect(f!.message).toContain('does not appear anywhere in the document');
  });

  it('accepts a lot whose punctuation differs from the document', () => {
    expect(find(warn({ lot_number: 'Lot# 061926-LC3' }), 'lot_in_text', 'lot_number')).toBeUndefined();
  });

  it('flags several lots crammed into one field as a multi-record problem', () => {
    const text = 'Lots: 38292 and 38295 shipped together';
    const f = find(warn({ lot_number: '38292, 38295' }, text), 'single_value_per_field', 'lot_number');
    expect(f).toBeDefined();
    expect(f!.message).toContain('2 separate records');
  });

  it('skips text-grounded checks entirely when there is no extracted text', () => {
    const fs = warn({ lot_number: 'ZZ99999' }, '');
    expect(find(fs, 'lot_in_text', 'lot_number')).toBeUndefined();
  });
});

describe('supplier checks', () => {
  it('flags the receiving org reported as its own supplier', () => {
    const fs = checkExtraction(
      {
        ai_fields: JSON.stringify({ supplier_name: 'MEDOSWEET FARMS' }),
        extracted_text: 'Sold to: MEDOSWEET FARMS, Kent WA',
      },
      { selfNames: ['Medosweet Farms'] }
    ).failures;
    const f = find(fs, 'supplier_not_self', 'supplier_name');
    expect(f).toBeDefined();
    expect(f!.message).toMatch(/SENT this document/);
  });

  it('does not run the self check when the tenant name is unknown', () => {
    const fs = warn({ supplier_name: 'Andersen Dairy, Inc.' });
    expect(find(fs, 'supplier_not_self', 'supplier_name')).toBeUndefined();
  });
});

describe('dates', () => {
  it('flags an expiry that precedes production', () => {
    const f = find(
      warn({ production_date: '2026-06-19', expiration_date: '2026-06-01' }, 'x'),
      'date_ordering',
      'expiration_date'
    );
    expect(f).toBeDefined();
    expect(f!.message).toContain('BEFORE');
  });

  it("flags a multi-year expiry as an impossible dairy shelf life", () => {
    const f = find(
      warn({ production_date: '2026-06-19', expiration_date: '2029-01-01' }, 'x'),
      'date_ordering',
      'expiration_date'
    );
    expect(f).toBeDefined();
    expect(f!.message).toMatch(/shelf life/);
  });

  it("flags the reagent's expiry copied onto the product (zero shelf life)", () => {
    // The dominant real instance: on the Andersen COAs the model reported the
    // BUFFER LOT expiry as BOTH the production and expiration date. 24 of the
    // 24 date_ordering failures in the local corpus are exactly this.
    const f = find(
      warn({ production_date: '2027-09-01', expiration_date: '2027-09-01' }, 'x'),
      'date_ordering',
      'expiration_date'
    );
    expect(f).toBeDefined();
    expect(f!.message).toMatch(/same day/);
  });

  it('accepts a normal dairy shelf life', () => {
    const fs = warn({ production_date: '2026-06-19', expiration_date: '2026-07-10' }, 'x');
    expect(find(fs, 'date_ordering', 'expiration_date')).toBeUndefined();
  });
});

describe('placeholders and shapes', () => {
  it('flags a sentinel value instead of calling it a fabrication', () => {
    const fs = warn({ lot_number: 'Multiple' });
    expect(find(fs, 'no_placeholder_value', 'lot_number')).toBeDefined();
    // Critically: NOT also reported as ungrounded/fabricated.
    expect(find(fs, 'lot_in_text', 'lot_number')).toBeUndefined();
  });

  it('flags a sublot that is not 2 digits', () => {
    expect(find(warn({ sub_lot_code: '4A7' }), 'sublot_shape', 'sub_lot_code')).toBeDefined();
    expect(find(warn({ sub_lot_code: '05' }), 'sublot_shape', 'sub_lot_code')).toBeUndefined();
  });
});

describe('false-positive guarantees', () => {
  it('says nothing about net_weight — reviewers legitimately accept pack sizes', () => {
    const fs = warn({ net_weight: '300 Gallon Tote' });
    expect(fs.filter((f) => f.field === 'net_weight')).toHaveLength(0);
  });

  it('produces no warnings at all for a clean extraction', () => {
    const fs = warn({
      supplier_name: 'ANDERSEN DAIRY, INC.',
      plant_number: '53-98',
      product_code: '40122',
      lot_number: '061926LC3',
      net_weight: '5 Gallon',
    });
    expect(fs).toEqual([]);
  });

  it('every failure carries a one-line reviewer message with no check ids in it', () => {
    const fs = warn({ plant_number: '151262C', product_code: '360-687-7171', lot_number: 'ZZ99999' });
    expect(fs.length).toBeGreaterThan(0);
    for (const f of fs) {
      expect(f.message.length).toBeGreaterThan(20);
      expect(f.message).not.toMatch(/_[a-z]+_[a-z]+/); // no snake_case check ids
      expect(f.message.split('\n')).toHaveLength(1);
    }
  });
});

describe('records-mode scoping', () => {
  it('reports per-record scopes so the UI can route each warning to its card', () => {
    const fs = checkExtraction({
      extracted_text: 'Lot: AAA111\nLot: BBB222\n',
      ai_records: JSON.stringify({
        page_metadata: { supplier_name: 'Ghost Dairy' },
        records: [
          { record_index: 0, fields: { lot_code: 'AAA111' } },
          { record_index: 1, fields: { lot_code: 'ZZZ999' } },
        ],
      }),
    }).failures;
    expect(find(fs, 'supplier_in_text', 'supplier_name')?.scope).toBe('page_metadata');
    expect(find(fs, 'lot_in_text', 'lot_code')?.scope).toBe('record[1]');
  });
});

describe('product_code_in_text — the few-shot fabrication', () => {
  // Real defect, seen on production Country Morning COAs: the model emitted
  // product_code "64917" on documents whose ITEM # cell is BLANK. The value
  // came out of the few-shot PREVIOUS CORRECTIONS block — an example from a
  // DIFFERENT document. The 122B fabricates the identical value, so a bigger
  // model is not the cure; grounding the output is.
  //
  // lot_in_text and supplier_in_text already grounded their fields. product_code
  // did not, which is exactly why this one passed silently for so long.

  it('flags a product code that appears nowhere in the document', () => {
    const f = find(warn({ product_code: '64917' }), 'product_code_in_text', 'product_code');
    expect(f).toBeDefined();
    expect(f!.message).toContain('64917');
    // The reviewer needs the WHY, not the check id.
    expect(f!.message).toContain('previous example');
    expect(f!.message).not.toContain('product_code_in_text');
  });

  it('passes a product code that is really on the page', () => {
    // 40122 is the Item # in ANDERSEN_TEXT.
    expect(find(warn({ product_code: '40122' }), 'product_code_in_text', 'product_code'))
      .toBeUndefined();
  });

  it('ignores punctuation differences rather than false-accusing', () => {
    expect(find(warn({ product_code: '40-122' }), 'product_code_in_text', 'product_code'))
      .toBeUndefined();
  });

  it('skips codes too short to ground without matching noise', () => {
    // A 1-2 char code substring-matches almost any document; skipping beats
    // both a false pass and a false accusation.
    expect(find(warn({ product_code: '7' }), 'product_code_in_text', 'product_code'))
      .toBeUndefined();
  });

  it('skips when there is no extracted text to check against', () => {
    const fs = checkExtraction({
      ai_fields: JSON.stringify({ product_code: '64917' }),
      extracted_text: null,
    }).failures;
    expect(find(fs, 'product_code_in_text', 'product_code')).toBeUndefined();
  });

  it('also catches a value lifted from the FILENAME, without knowing the source', () => {
    // The other half of the same defect: filenames are not part of
    // extracted_text, so a value copied from one is ungrounded by definition.
    const f = find(warn({ product_code: '080126' }), 'product_code_in_text', 'product_code');
    expect(f).toBeDefined();
  });
});
