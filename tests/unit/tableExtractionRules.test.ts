/**
 * TABLE EXTRACTION RULES parity — the prompt copies must not drift.
 *
 * WHY THIS TEST EXISTS
 * The COA table-extraction rules are written out THREE times by hand:
 *   1. bin/process-worker — BASE_PROMPT, the text path the worker actually runs;
 *   2. bin/process-worker — the VLM_HEADER, the vision path;
 *   3. functions/lib/llm.ts — BASE_PROMPT, the Pages/Workers surface used by
 *      the email-ingest endpoint.
 * They were byte-identical by accident, with nothing asserting it. When rules
 * 8-13 were added to fix six measured extraction defects (merged analyte
 * labels, certification boilerplate lifted as results, spec-column
 * contamination, dilution ratios in the result cell, junk values, header
 * instability), a copy left behind would silently extract worse on one
 * surface. This test is modelled on the bin/lib/models.js <-> models.ts mirror
 * check in tests/unit/models.test.ts.
 *
 * WHAT IS AND IS NOT ASSERTED
 * Rules 1-3 and 5-7 differ between the text and vision copies on purpose
 * ("in the document" vs "in the image", "as it appears" vs "as it appears
 * visually"). Rule 4 and rules 8-13 are LAYOUT-GENERIC — nothing in them is
 * specific to text or to pixels — so all three copies must carry them
 * verbatim. That shared block is what this test pins.
 */
import { describe, it, expect } from 'vitest';
import processWorkerSource from '../../bin/process-worker?raw';
import llmSource from '../../functions/lib/llm.ts?raw';

/**
 * Pull every "TABLE EXTRACTION RULES:" block out of a source file. A block
 * runs from the heading to the first blank line that is followed by a
 * non-numbered line (i.e. the next prompt section).
 */
function extractRuleBlocks(src: string): string[] {
  const blocks: string[] = [];
  const re = /TABLE EXTRACTION RULES:\n([\s\S]*?)\n\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) blocks.push(m[1]);
  return blocks;
}

/** Just the rules that must be identical everywhere: 4, then 8 through 13. */
function sharedRules(block: string): string {
  const lines = block.split('\n');
  const pick = (n: number) => {
    const line = lines.find((l) => l.startsWith(`${n}. `));
    expect(line, `rule ${n} missing from a TABLE EXTRACTION RULES block`).toBeTruthy();
    return line!;
  };
  return [4, 8, 9, 10, 11, 12, 13, 14].map(pick).join('\n');
}

describe('TABLE EXTRACTION RULES stay in sync across all three prompt copies', () => {
  const workerBlocks = extractRuleBlocks(processWorkerSource);
  const llmBlocks = extractRuleBlocks(llmSource);

  it('finds the expected number of rule blocks in each file', () => {
    // 2 in the worker (text path + VLM path), 1 in the Pages lib.
    expect(workerBlocks).toHaveLength(2);
    expect(llmBlocks).toHaveLength(1);
  });

  it('declares byte-identical rule 4 and rules 8-13 in every copy', () => {
    const canonical = sharedRules(workerBlocks[0]);
    for (const [i, block] of [...workerBlocks.slice(1), ...llmBlocks].entries()) {
      expect(sharedRules(block), `copy #${i + 2} drifted from bin/process-worker's text-path block`).toBe(canonical);
    }
  });

  it('keeps every defect-class rule present, so none can be quietly deleted', () => {
    const canonical = sharedRules(workerBlocks[0]);
    // One assertion per measured defect class these rules were written for.
    expect(canonical).toContain('ONE ANALYTE PER ROW');            // merged analyte labels
    expect(canonical).toContain('SAMPLE x ANALYTE MATRIX');        // flattened micro matrix
    expect(canonical).toContain('PROCESS METADATA, NOT RESULTS');  // dilution ratio as result
    expect(canonical).toContain('REGULATORY THRESHOLDS');          // certification boilerplate
    expect(canonical).toContain("ROW'S OWN PRINTED LINE");         // junk values + spec contamination
    expect(canonical).toContain('"test", "result", "unit", "specification", "pass_fail"'); // header instability
    // Rule 14 was added after rule 4 was measured to INDUCE a defect: naming a
    // "unit" column made the model fill it with CFU/mL on a COA that prints no
    // unit at all, and the spec engine then refused to compare CFU/mL against a
    // CFU/g limit — 6 of 32 results went not_checked. Deleting rule 14 while
    // keeping rule 4 reintroduces that.
    expect(canonical).toContain('NEVER SUPPLY A UNIT');
  });

  it('names the canonical header vocabulary the spec engine already understands', () => {
    // detectTableShape() in shared/specCheck.ts resolves columns by synonym, so
    // these names must be ones it recognises — otherwise standardising the
    // prompt would break judging rather than stabilise it.
    const canonical = sharedRules(workerBlocks[0]);
    for (const name of ['test', 'result', 'unit', 'specification', 'pass_fail']) {
      expect(canonical).toContain(`"${name}"`);
    }
  });
});
