/**
 * shared/rowScopedText.ts — the text one row of a multi-row certificate is
 * searched on (migration 0106, document_versions.search_text; AJ D3).
 */
import { describe, it, expect } from 'vitest';
import { rowScopedSearchText } from '../../shared/rowScopedText';

const BUNDLE =
  'DARIGOLD CERTIFICATE OF ANALYSIS SWEET CREAM BUTTER PO K135797 EDI187653 Date Shipped: 03-Sep-2026 '
  + 'Lot 10426204 Sub Lot 13 Production Date 23-Jul-2026 Lot 10426203 Sub Lot 04 Production Date 22-Jul-2026 '
  + 'Lot 10426203 Sub Lot 03 Production Date 22-Jul-2026 Lot 10426203-02 Production Date 22-Jul-2026 Coliform <10';

const rows = [
  { lot_code: '10426204', sub_lot_code: '13', production_date: '2026-07-23' },
  { lot_code: '10426203', sub_lot_code: '04', production_date: '2026-07-22' },
  { lot_code: '10426203', sub_lot_code: '03', production_date: '2026-07-22' },
  { lot_code: '10426203', sub_lot_code: '02', production_date: '2026-07-22' },
];
const page = { po_number: 'K135797', ship_date: '2026-09-03' };
const merged = rows.map((r) => ({ ...page, ...r }));
const scopedFor = (i: number) => rowScopedSearchText(BUNDLE, merged[i], merged.filter((_, j) => j !== i));

describe('rowScopedSearchText', () => {
  it('the 23-Jul row loses the 22-Jul dates and the other base lot, keeps everything shared', () => {
    const r = scopedFor(0)!;
    expect(r.text).not.toMatch(/22-Jul-2026/);
    expect(r.text).not.toMatch(/10426203/);
    expect(r.text).toMatch(/23-Jul-2026/);
    expect(r.text).toMatch(/10426204/);
    for (const shared of ['SWEET CREAM BUTTER', 'K135797', 'EDI187653', '03-Sep-2026', 'Coliform <10']) {
      expect(r.text).toContain(shared);
    }
  });

  it('a 22-Jul row keeps its own base and the shared day, and loses the 23-Jul row and a sibling composite', () => {
    const r = scopedFor(2)!;
    expect(r.text).toMatch(/22-Jul-2026/);
    expect(r.text).not.toMatch(/23-Jul-2026/);
    expect(r.text).not.toMatch(/10426204/);
    expect(r.text).not.toMatch(/10426203-02/);
    expect(r.text).toMatch(/Lot 10426203 Sub Lot 03/);
  });

  it('returns null when there is nothing to scope', () => {
    expect(rowScopedSearchText(BUNDLE, merged[0], [])).toBeNull();
    expect(rowScopedSearchText('', merged[0], merged.slice(1))).toBeNull();
    expect(rowScopedSearchText('plain text with nothing of theirs', merged[0], merged.slice(1))).toBeNull();
  });

  it('blanks a spaced sibling sublot only when the base is shared', () => {
    const text = 'Lots 10426203 04 and 10426203 03';
    const r = rowScopedSearchText(text, merged[2], [merged[1]])!;
    expect(r.text).toMatch(/10426203 03/);
    expect(r.text).not.toMatch(/10426203 04/);
  });
});
