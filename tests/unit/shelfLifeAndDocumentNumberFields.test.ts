/**
 * `shelf_life` and `document_number` — the two fields the REAL-document corpus
 * proved the schema had no slot for — in all three extraction prompt copies.
 *
 * Measured, not guessed. `bin/eval-aj-docs` scores 31 real client documents;
 * before this change both fields were `missed` on every document that prints
 * them:
 *
 *   shelf life      ALL FOUR specification sheets print one — Country Morning
 *                   Light Cream 23% "21 days", CMF 14% Ice Cream Mix "1 year
 *                   frozen, 21 days refrigerated", Smith Brothers Heavy
 *                   Whipping Cream "21 days at <=40F", Andersen Heavy Whip
 *                   "22 days". It also answers a live client question: the SME
 *                   was asked to supply per-product shelf life BY HAND while
 *                   the sheets already state it.
 *   document number both Country Morning sheets print one (53-140-383,
 *                   53-140-389) in a controlled-document footer; Smith Brothers
 *                   prints a revision date and no number at all.
 *
 * THE SHAPE OF shelf_life IS A STRING, VERBATIM. A parsed {days, basis,
 * condition} is more useful right up to the moment a page says "1 year frozen,
 * 21 days refrigerated" — two lives, each true only under its own condition —
 * and then it forces an invention: a number, or a dropped condition, or a
 * silent pick of one half. Rule 7 / table rule 14 say the page's own words are
 * the answer, so the field carries the printed phrasing including the
 * condition, and a multi-condition statement is never flattened.
 *
 * WHERE THE GUIDANCE LIVES: the BASE prompt, not the per-document-type layer
 * (migration 0098). The type layer only applies once a document's type has
 * resolved on an EXACT match, and on this corpus 13 of 30 documents resolve to
 * a type at all — 17 correctly answer "none". A field defined only in the type
 * layer is undefined on exactly the documents nobody has configured, which is
 * the case 0098 itself exists to fix. The type layer stays the place for
 * per-tenant layout hints ("Country Morning prints it in the footer"), and
 * nothing is seeded there.
 *
 * A copy left behind extracts on one surface and not another, silently, so the
 * three copies are pinned byte-identical here — same pattern as
 * tests/unit/customerItemNumberField.test.ts.
 */
import { describe, it, expect } from 'vitest';
import processWorkerSource from '../../bin/process-worker?raw';
import llmSource from '../../functions/lib/llm.ts?raw';
import { canonicalizeFields } from '../../functions/lib/llm';

function fieldBlocks(src: string): string[] {
  const out: string[] = [];
  const re = /FIELD EXTRACTION RULES:\n([\s\S]*?)\n\nTABLE EXTRACTION RULES:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

const line = (block: string, field: string) => block.split('\n').find((l) => l.startsWith(`   - ${field} — `));

describe('shelf_life and document_number in every FIELD EXTRACTION RULES copy', () => {
  const blocks = [...fieldBlocks(processWorkerSource), ...fieldBlocks(llmSource)];

  it('finds the text path, the VLM path and the Pages copy', () => {
    expect(blocks).toHaveLength(3);
  });

  it('declares shelf_life identically in all three', () => {
    const canonical = line(blocks[0], 'shelf_life');
    expect(canonical, 'shelf_life missing from the worker text-path block').toBeTruthy();
    for (const b of blocks.slice(1)) expect(line(b, 'shelf_life')).toBe(canonical);
  });

  it('shelf_life is defined as a PERIOD that is never a date', () => {
    const l = line(blocks[0], 'shelf_life')!;
    expect(l).toContain('A DURATION AND NEVER A DATE');
    expect(l).toContain('never put it in expiration_date or document_expires_on');
    // The multi-condition rule — the reason the field is one verbatim string.
    expect(l).toMatch(/keep ALL of them in this one string as printed/);
    // Rule 7: a page that prints none yields null.
    expect(l).toMatch(/if the page states no shelf life, this is null/);
  });

  it('does not teach the corpus its own answers', () => {
    // Every example phrasing in the prompt must be one NO graded document
    // prints. A prompt that quotes "21 days" at a model measured on a page
    // reading "21 days" flatters the measurement instead of testing it. The
    // expiration_date line is held to the same bar because it now names this
    // field by example too.
    const lines = [line(blocks[0], 'shelf_life')!, line(blocks[0], 'expiration_date')!];
    for (const l of lines) {
      for (const answer of ['21 days', '22 days', '12 months', '24 months', '45 days', '1 year frozen']) {
        expect(l, `the prompt quotes a corpus answer: ${answer}`).not.toContain(answer);
      }
    }
  });

  it('declares document_number identically in all three', () => {
    const canonical = line(blocks[0], 'document_number');
    expect(canonical, 'document_number missing from the worker text-path block').toBeTruthy();
    for (const b of blocks.slice(1)) expect(line(b, 'document_number')).toBe(canonical);
  });

  it('document_number says what it is NOT — the confusions the corpus catches', () => {
    const l = line(blocks[0], 'document_number')!;
    expect(l).toContain('NOT the lot or batch number');
    expect(l).toContain('NOT a PO, order, invoice or sales-order number');
    expect(l).toContain("NOT the supplier's product or item code");
    expect(l).toContain("NOT the customer's item number");
    expect(l).toMatch(/NOT the revision or version printed next to it/);
    // The Country Morning shape: an UNLABELLED number in a controlled footer.
    expect(l).toMatch(/unlabelled one printed in a controlled-document header or footer/);
  });

  it('a certificate\'s "Document #" stays certificate_number — measured, not assumed', () => {
    // The corpus caught this the first time the field ran. Both IFANCA halal
    // certificates print `Document #: 5137.5676.11250060` AND a per-product
    // column headed "Product Certificate #". With document_number newly in the
    // schema and "Doc #" in its own label list, the model followed the label,
    // filed the document-level id here, and backfilled certificate_number from
    // the table column — turning two documents that had been right into two
    // that were wrong. The carve-out sits with the LABEL LIST, not in the tail
    // of the line: appended at the end it did not hold.
    const l = line(blocks[0], 'document_number')!;
    expect(l).toContain('THIS FIELD IS FOR A DOCUMENT THAT IS NOT A CERTIFICATE');
    expect(l).toContain('this field is then null');
    // A footer file path is where a document LIVES, not what it is called.
    // Smith Brothers' sheet prints one and the model reached for it.
    expect(l).toMatch(/file name or file path printed in a footer/);
  });

  it('expiration_date now says a stated PERIOD is not a date, in all three', () => {
    // The other half of the pair. Without this, "Shelf Life: 21 days" had one
    // plausible home in the schema and it was the PRODUCT DATE field — which
    // is the field shared/renewalPeriod.ts spends a header block refusing to
    // read, for a reason that cost 139 prod documents.
    const canonical = line(blocks[0], 'expiration_date')!;
    for (const b of blocks.slice(1)) expect(line(b, 'expiration_date')).toBe(canonical);
    expect(canonical).toContain('A stated PERIOD is NOT this field');
    expect(canonical).toContain('shelf_life');
  });
});

describe('aliases fold onto the new fields, and dates never do', () => {
  it('keeps both alias lists identical in both alias maps', () => {
    const aliasLine = (src: string, key: string) => src.split('\n').find((l) => l.startsWith(`  ${key}: [`));
    for (const key of ['shelf_life', 'document_number']) {
      expect(aliasLine(llmSource, key), `${key} missing from llm.ts aliases`).toBeTruthy();
      expect(aliasLine(processWorkerSource, key)).toBe(aliasLine(llmSource, key));
    }
  });

  it('folds the shelf-life spellings a model reaches for', () => {
    for (const key of ['shelf_life_days', 'shelflife', 'product_shelf_life', 'product_life', 'storage_life']) {
      const out = canonicalizeFields({ [key]: '21 days' });
      expect(out.shelf_life, `${key} did not fold`).toBe('21 days');
    }
  });

  it('a multi-condition shelf life survives canonicalization verbatim', () => {
    // The whole reason the shape is a string. Nothing between the model and
    // primary_metadata may split, round or pick a half.
    const printed = '1 year frozen, 21 days refrigerated';
    expect(canonicalizeFields({ shelf_life: printed }).shelf_life).toBe(printed);
    expect(canonicalizeFields({ storage_life: printed }).shelf_life).toBe(printed);
    expect(canonicalizeFields({ shelf_life: '21 days at ≤40°F' }).shelf_life).toBe('21 days at ≤40°F');
  });

  it('a page with no shelf life yields no shelf_life key', () => {
    const out = canonicalizeFields({ supplier_name: 'Country Morning Farms', expiration_date: '2026-09-15' });
    expect(out.shelf_life).toBeUndefined();
    expect(out.document_number).toBeUndefined();
  });

  it('DATE spellings stay on expiration_date — they are not shelf-life aliases', () => {
    // 'best_by' / 'exp_date' / 'use_by' are DATES. Folding one onto shelf_life
    // would hand a period-shaped field a calendar date, which is the mistake
    // migration 0097 exists to prevent, wearing the new field's name.
    for (const key of ['best_by', 'exp_date', 'use_by', 'sell_by', 'best_before']) {
      const out = canonicalizeFields({ [key]: '2026-09-15' });
      expect(out.expiration_date, `${key} did not fold onto expiration_date`).toBe('2026-09-15');
      expect(out.shelf_life).toBeUndefined();
    }
  });

  it('folds the document-number spellings a model reaches for', () => {
    for (const key of ['document_no', 'doc_number', 'doc_no', 'spec_number', 'spec_no', 'specification_number', 'document_id', 'form_number', 'sop_number']) {
      const out = canonicalizeFields({ [key]: '53-140-383' });
      expect(out.document_number, `${key} did not fold`).toBe('53-140-383');
    }
  });

  it('document_number is not confused with a lot, PO, order, item or revision', () => {
    // Every key here has its own canonical home. The test is that six numbers
    // on one page stay six fields.
    const out = canonicalizeFields({
      document_number: '53-140-383',
      lot_number: '053124ICR',
      po_number: 'PO-44821',
      order_number: '1784767',
      product_code: '30904',
      customer_item_number: '10286',
      revision_date: '2026-03-02',
      certificate_number: 'C-99',
    });
    expect(out.document_number).toBe('53-140-383');
    expect(out.lot_number).toBe('053124ICR');
    expect(out.po_number).toBe('PO-44821');
    expect(out.order_number).toBe('1784767');
    expect(out.product_code).toBe('30904');
    expect(out.customer_item_number).toBe('10286');
    expect(out.revision_date).toBe('2026-03-02');
    expect(out.certificate_number).toBe('C-99');
  });

  it('item / cert spellings still fold to their own fields, not document_number', () => {
    const item = canonicalizeFields({ item_number: '13106' });
    expect(item.product_code).toBe('13106');
    expect(item.document_number).toBeUndefined();

    const cert = canonicalizeFields({ certificate_no: '5137.5676.11250060' });
    expect(cert.certificate_number).toBe('5137.5676.11250060');
    expect(cert.document_number).toBeUndefined();
  });
});
