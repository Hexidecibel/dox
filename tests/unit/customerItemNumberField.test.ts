/**
 * `customer_item_number` — OUR SKU as the supplier prints it — is its own field
 * in all three extraction prompt copies (Any-Field COA Retrieval, Phase 3).
 *
 * Country Morning certificates print "CMF ITEM #: 30904" (the supplier's item,
 * product_code) and "CUSTOMER ITEM #: 10286" (Medosweet's SKU for the same
 * tote). The prompt had no slot for the second number, so the model filed it
 * as order_number — prod queue item 262542 carries order_number "10284", which
 * is no order at all — and the one identifier that ties a certificate to OUR
 * product was unsearchable. Search's product identity check reads
 * `customer_item_number` first (shared/productIdentity.ts).
 *
 * A copy left behind extracts the number into order_number on one surface,
 * silently, so the three copies are pinned byte-identical here.
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

describe('customer_item_number in every FIELD EXTRACTION RULES copy', () => {
  const blocks = [...fieldBlocks(processWorkerSource), ...fieldBlocks(llmSource)];

  it('finds the text path, the VLM path and the Pages copy', () => {
    expect(blocks).toHaveLength(3);
  });

  it('declares the field identically in all three', () => {
    const canonical = line(blocks[0], 'customer_item_number');
    expect(canonical, 'customer_item_number missing from the worker text-path block').toBeTruthy();
    for (const b of blocks.slice(1)) expect(line(b, 'customer_item_number')).toBe(canonical);
    expect(canonical).toContain('CUSTOMER ITEM #');
    expect(canonical).toContain('NOT the supplier\'s item code (that is product_code)');
    expect(canonical).toContain('never put it in order_number');
  });

  it('tells order_number the same thing from its side, identically', () => {
    const canonical = line(blocks[0], 'order_number');
    for (const b of blocks.slice(1)) expect(line(b, 'order_number')).toBe(canonical);
    expect(canonical).toContain('it is customer_item_number');
  });
});

describe('customer item aliases fold onto customer_item_number, never order_number', () => {
  it('keeps the alias list identical in both alias maps', () => {
    const aliasLine = (src: string) => src.split('\n').find((l) => l.startsWith('  customer_item_number: ['));
    expect(aliasLine(llmSource)).toBeTruthy();
    expect(aliasLine(processWorkerSource)).toBe(aliasLine(llmSource));
  });

  it('folds the spellings a model reaches for', () => {
    for (const key of ['customer_item', 'customer_item_no', 'cust_item_no', 'customer_sku']) {
      const out = canonicalizeFields({ [key]: '10286', order_number: '261313' });
      expect(out.customer_item_number, `${key} did not fold`).toBe('10286');
      expect(out.order_number).toBe('261313');
    }
  });
});
