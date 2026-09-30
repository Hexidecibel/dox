/**
 * Rules table F6: a sales sheet filed as a specification sheet is caught at
 * review. See shared/salesSheetCheck.ts.
 */
import { describe, expect, it } from 'vitest';
import { salesSheetWarning, isSpecSheetCandidate } from '../../shared/salesSheetCheck';
import salesSheetHtml from '../fixtures/arrivals-demo/html/sales-sheet.html?raw';
import specCleanHtml from '../fixtures/doctype-corpus/html/spec-clean.html?raw';
import specModerateHtml from '../fixtures/doctype-corpus/html/spec-moderate.html?raw';
import specNastyHtml from '../fixtures/doctype-corpus/html/spec-nasty.html?raw';

const FIXTURES: Record<string, string> = {
  'sales-sheet': salesSheetHtml,
  'spec-clean': specCleanHtml,
  'spec-moderate': specModerateHtml,
  'spec-nasty': specNastyHtml,
};

function htmlText(name: string): string {
  return FIXTURES[name]
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
}

const SPEC = 'Specification Sheet';

describe('salesSheetWarning', () => {
  it('fires on the arrivals-demo sales sheet, quoting the marketing copy', () => {
    const w = salesSheetWarning({ documentTypeName: SPEC, text: htmlText('sales-sheet') });
    expect(w).not.toBeNull();
    expect(w!.marketing_evidence[0]).toMatch(/not specifications/i);
    expect(w!.message).toContain('Sales sheet, not a spec sheet');
  });

  it.each(['spec-clean', 'spec-moderate', 'spec-nasty'])('is silent on the doctype corpus %s', (name) => {
    const text = htmlText(name);
    expect(salesSheetWarning({ documentTypeName: SPEC, text })).toBeNull();
  });

  // The real corpus is PDF; these are the lines of each real spec sheet that
  // make it a controlled document (pdftotext -layout, verbatim). Without them
  // each of the four would read like prose.
  it.each([
    ['Country Morning light cream', '53-140-383   SQF 2.3.2.9   Latest Rev: 2 Mar 2026 JAG'],
    ['Country Morning ice cream mix', '53-140-389   SQF 2.3.2.9   Latest Rev: 27 Jul 2026 JAG'],
    ['Smith Brothers', 'Item #: 13106    UPC: 3453896632    Revision Date: 2/9/2024'],
    ['Andersen', "11/20/'25 Approved by QA Shawn B"],
  ])('is silent on the real %s spec sheet', (_name, line) => {
    const text = `PRODUCT SPECIFICATIONS\nHEAVY CREAM\nShelf Life: 21 days\nButterfat: 36%\n${line}\n`;
    expect(salesSheetWarning({ documentTypeName: SPEC, text })).toBeNull();
  });

  it('is silent when the extraction found a revision or effective date', () => {
    const text = 'Great in dips. Ask your rep for samples and pricing.';
    expect(salesSheetWarning({ documentTypeName: SPEC, text, fields: { revision_date: '2026-03-02' } })).toBeNull();
    expect(salesSheetWarning({ documentTypeName: SPEC, text, fields: { effective_date: '2026-03-02' } })).toBeNull();
  });

  it('warns without marketing copy when nothing controls the document, in plainer words', () => {
    const w = salesSheetWarning({ documentTypeName: SPEC, text: 'Sour Cream Powder\nFat 38%\nMoisture 3%\n' });
    expect(w).not.toBeNull();
    expect(w!.marketing_evidence).toEqual([]);
  });

  it('only reads documents filed as specification sheets', () => {
    const text = htmlText('sales-sheet');
    expect(salesSheetWarning({ documentTypeName: 'Certificate of Insurance', text })).toBeNull();
    expect(salesSheetWarning({ documentTypeName: null, documentTypeGuess: 'Specification Sheet', text })).not.toBeNull();
    expect(salesSheetWarning({ documentTypeName: null, documentTypeGuess: null, text })).toBeNull();
    expect(isSpecSheetCandidate({ documentTypeName: 'Product Spec' })).toBe(true);
  });

  it('says nothing without text', () => {
    expect(salesSheetWarning({ documentTypeName: SPEC, text: '' })).toBeNull();
    expect(salesSheetWarning({ documentTypeName: SPEC, text: null })).toBeNull();
  });
});
