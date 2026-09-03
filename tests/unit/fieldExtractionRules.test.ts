/**
 * FIELD EXTRACTION RULES parity — the certificate half of the prompt must not
 * drift between the three copies.
 *
 * WHY THIS TEST EXISTS
 * tests/unit/tableExtractionRules.test.ts already pins the TABLE rules across
 * the three hand-written BASE_PROMPT copies (bin/process-worker's text path,
 * its VLM path, and functions/lib/llm.ts). The FIELD rules were never pinned
 * because they legitimately differ: the worker's copies carry sub_lot_code,
 * production_date, a stricter filename rule and a records block that the Pages
 * copy has no use for.
 *
 * That reasoning does not extend to what was added on 2026-09-03. The nine
 * certificate fields and rules 6 and 7 are LAYOUT- AND SURFACE-GENERIC —
 * nothing in them is specific to text, to pixels, or to which door the document
 * came through — and they were added to fix measured defects:
 *
 *   * 60 of 66 value failures on tests/fixtures/doctype-corpus were fields with
 *     no slot in the schema. The model read the page and had nowhere to put the
 *     answer.
 *   * six documents bound supplier_name to a broker or a certifying body, which
 *     files the document against the wrong company and makes it invisible to
 *     the gap engine (rule 6).
 *   * rule 7 is the field-level statement of TABLE EXTRACTION RULE 14. The
 *     corpus deliberately contains a gluten-free certificate that cites
 *     21 CFR 101.91 and prints NO ppm figure, where supplying the well-known
 *     20 ppm is scored as a failure, not a near miss.
 *
 * A copy left behind would extract worse on one surface, silently.
 */
import { describe, it, expect } from 'vitest';
import processWorkerSource from '../../bin/process-worker?raw';
import llmSource from '../../functions/lib/llm.ts?raw';
import { canonicalizeFields } from '../../functions/lib/llm';

/** Every "FIELD EXTRACTION RULES:" block, up to the TABLE rules that follow it. */
function extractFieldRuleBlocks(src: string): string[] {
  const blocks: string[] = [];
  const re = /FIELD EXTRACTION RULES:\n([\s\S]*?)\n\nTABLE EXTRACTION RULES:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) blocks.push(m[1]);
  return blocks;
}

/** The nine canonical field lines added for certificates, plus rules 6 and 7. */
const SHARED_FIELDS = [
  'issuing_body', 'certificate_number', 'scheme', 'kosher_status',
  'gluten_threshold', 'allergens', 'country_of_origin', 'revision_date',
  'signatory',
];

function sharedText(block: string): string {
  const lines = block.split('\n');
  const pickField = (name: string) => {
    const line = lines.find((l) => l.startsWith(`   - ${name} — `));
    expect(line, `canonical field "${name}" missing from a FIELD EXTRACTION RULES block`).toBeTruthy();
    return line!;
  };
  const pickRule = (n: number) => {
    const line = lines.find((l) => l.startsWith(`${n}. `));
    expect(line, `field rule ${n} missing from a FIELD EXTRACTION RULES block`).toBeTruthy();
    return line!;
  };
  return [...SHARED_FIELDS.map(pickField), pickRule(6), pickRule(7)].join('\n');
}

describe('the certificate field rules stay in sync across all three prompt copies', () => {
  const workerBlocks = extractFieldRuleBlocks(processWorkerSource);
  const llmBlocks = extractFieldRuleBlocks(llmSource);

  it('finds the expected number of field-rule blocks in each file', () => {
    // 2 in the worker (text path + VLM path), 1 in the Pages lib.
    expect(workerBlocks).toHaveLength(2);
    expect(llmBlocks).toHaveLength(1);
  });

  it('declares byte-identical certificate fields and rules 6-7 in every copy', () => {
    const canonical = sharedText(workerBlocks[0]);
    for (const [i, block] of [...workerBlocks.slice(1), ...llmBlocks].entries()) {
      expect(
        sharedText(block),
        `copy #${i + 2} drifted from bin/process-worker's text-path block`,
      ).toBe(canonical);
    }
  });

  it('keeps every defect-class clause present, so none can be quietly deleted', () => {
    const canonical = sharedText(workerBlocks[0]);
    // Rule 6: the letterhead inversion. Six corpus documents bound
    // supplier_name to a broker or a certifying body.
    expect(canonical).toContain('ON A CERTIFICATE THE LETTERHEAD IS THE ISSUER, NOT THE SUPPLIER');
    expect(canonical).toContain('leave supplier_name null rather than falling back to the letterhead');
    // Rule 7: the field-level restatement of table rule 14. Without it, naming
    // gluten_threshold as a field is an invitation to supply the 20 ppm every
    // model knows and no document printed.
    expect(canonical).toContain('NEVER SUPPLY A FIELD VALUE THE DOCUMENT DID NOT PRINT');
    expect(canonical).toContain('TABLE EXTRACTION RULE 14 applied to fields');
    // The threshold field says it again at the point of temptation.
    expect(canonical).toContain('the well-known regulatory number is exactly the value you must not supply');
    // The signatory carve-out is explicit about what it does NOT license.
    expect(canonical).toContain('Rule 3 still bars the signature MARK');
  });

  it('leaves rule 14 itself intact on every copy', () => {
    // This test may not become a place where rule 14 is weakened by degrees:
    // an invented unit is dropped from spec checking with nobody told.
    const copies = [processWorkerSource, llmSource];
    for (const src of copies) {
      expect(src).toContain('NEVER SUPPLY A UNIT, SPEC OR VERDICT THE DOCUMENT DID NOT PRINT');
    }
  });
});

describe('rule 3 carves out the printed name without unbarring the mark', () => {
  it('says so identically on all three copies', () => {
    const rule3 = (block: string) => block.split('\n').find((l) => l.startsWith('3. '))!;
    const blocks = [...extractFieldRuleBlocks(processWorkerSource), ...extractFieldRuleBlocks(llmSource)];
    const canonical = rule3(blocks[0]);
    for (const b of blocks.slice(1)) expect(rule3(b)).toBe(canonical);
    // The bar is on the MARK, and the carve-out is on the typed NAME. Reading
    // a name out of a signature image is still invention.
    expect(canonical).toContain('signature marks');
    expect(canonical).toContain("the signer's PRINTED NAME");
  });
});

describe('certificate field aliases fold onto the canonical names', () => {
  it('files a certificate SUBJECT as the supplier, whatever the page calls it', () => {
    // This is the half of the letterhead fix that survives a model that
    // answers in its own vocabulary. A certificate filed under the certifying
    // body instead of the company it certifies is invisible to the gap engine,
    // which only ever asks "what do we hold for THIS supplier".
    for (const key of ['insured', 'named_insured', 'guarantor', 'certified_operation', 'audited_site']) {
      const out = canonicalizeFields({ [key]: 'Cascade Valley Foods, LLC' });
      expect(out.supplier_name, `${key} did not fold onto supplier_name`).toBe('Cascade Valley Foods, LLC');
    }
  });

  it('keeps the issuer in its own field rather than competing for supplier_name', () => {
    const out = canonicalizeFields({
      insured: 'Cascade Valley Foods, LLC',
      certifying_body: 'Global Organic Alliance',
    });
    expect(out.supplier_name).toBe('Cascade Valley Foods, LLC');
    expect(out.issuing_body).toBe('Global Organic Alliance');
  });

  it('an EXACT canonical key still beats an alias, whatever order they arrive in', () => {
    // Same two-pass property the lot/batch fix relies on: the model's key
    // ordering must not decide which value wins.
    const out = canonicalizeFields({ certifying_body: 'Alias Co', issuing_body: 'Exact Co' });
    expect(out.issuing_body).toBe('Exact Co');
  });

  it('leaves generic keys alone', () => {
    // 'origin', 'standard', 'status', 'threshold', 'limit', 'contains' and
    // 'result' are deliberately NOT aliases: folding one of those onto a
    // canonical name silently rewrites a value whose meaning nobody checked.
    const out = canonicalizeFields({ origin: 'x', standard: 'y', status: 'z', threshold: 'w', contains: 'v' });
    expect(out.country_of_origin).toBeUndefined();
    expect(out.scheme).toBeUndefined();
    expect(out.kosher_status).toBeUndefined();
    expect(out.gluten_threshold).toBeUndefined();
    expect(out.allergens).toBeUndefined();
    // …and passed through verbatim, so nothing is lost — canonicalizeFields is
    // an open map, and the reviewer still sees the raw key.
    expect(out.origin).toBe('x');
  });
});
