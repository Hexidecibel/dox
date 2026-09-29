/**
 * shared/searchKeys.ts — what a document states, as seekable rows (0122).
 */

import { describe, it, expect } from 'vitest';
import { DATE_KEY_FIELDS, deriveSearchKeys, identifierKeys, normalizeKeyValue, stripKeyword } from '../../shared/searchKeys';
import { DATE_ROLE_FIELDS } from '../../shared/searchCoverage';

describe('normalization', () => {
  it('folds case, spaces and punctuation; keeps leading zeros', () => {
    expect(normalizeKeyValue('K 135680')).toBe('K135680');
    expect(normalizeKeyValue('k135680')).toBe('K135680');
    expect(normalizeKeyValue('PO-90001')).toBe('PO90001');
    expect(normalizeKeyValue('08012')).toBe('08012');
  });

  it('a keyword is stripped only when separated from the number', () => {
    expect(stripKeyword('PO K134273', 'po')).toBe('K134273');
    expect(stripKeyword('po# 4500', 'po')).toBe('4500');
    expect(stripKeyword('PO-90001', 'po')).toBe('PO-90001');
    expect(stripKeyword('invoice: 261149', 'invoice')).toBe('261149');
    expect(stripKeyword('INV-7', 'invoice')).toBe('INV-7');
  });
});

describe('identifiers', () => {
  it('the PO on a supplier certificate is its own kind (our PO to them), not the customer PO', () => {
    const keys = identifierKeys({ po_number: 'K 134273', customer_po: 'PO-90001' });
    expect(keys.map((k) => [k.kind, k.value_norm])).toEqual([['supplier_po', 'K134273'], ['customer_po', 'PO90001']]);
  });

  it('a field holding several values yields one key each', () => {
    const keys = identifierKeys({ po_number: 'K1001, K1002; K1003' });
    expect(keys.map((k) => k.value_norm)).toEqual(['K1001', 'K1002', 'K1003']);
  });

  it('invoice and other identifiers', () => {
    const keys = deriveSearchKeys({ invoice_number: '261149', document_number: 'DS-44', certificate_number: 'IF-2' });
    expect(keys.filter((k) => k.value_date === null).map((k) => k.kind).sort()).toEqual(['certificate_number', 'document_number', 'invoice_number']);
  });
});

describe('dates', () => {
  it('a date that reads two ways stores BOTH readings, marked ambiguous', () => {
    const keys = deriveSearchKeys({ production_date: '04-05-2026' }).filter((k) => k.kind === 'production_date');
    expect(keys.map((k) => [k.value_date, k.provenance])).toEqual([['2026-04-05', 'ambiguous'], ['2026-05-04', 'ambiguous']]);
  });

  it("the document's own unambiguous dates decide the order", () => {
    const keys = deriveSearchKeys({ production_date: '04/05/2026', expiration_date: '04/25/2026' });
    expect(keys.find((k) => k.kind === 'production_date')).toMatchObject({ value_date: '2026-04-05', provenance: 'stated' });
  });

  it('code date is not best-by, and best_by_date is read', () => {
    const keys = deriveSearchKeys({ code_date: '2026-02-14', expiration_date: '2026-09-17', best_by_date: '2026-05-05' });
    expect(keys.filter((k) => k.value_date).map((k) => [k.kind, k.value_date])).toEqual([
      ['code_date', '2026-02-14'], ['best_by', '2026-05-05'], ['expiration_date', '2026-09-17'],
    ]);
  });

  it('an unreadable value is not stored as a date', () => {
    expect(deriveSearchKeys({ code_date: 'see label' }).filter((k) => k.kind === 'code_date')).toEqual([]);
  });

  it('every date field the judge reads is a key kind too (the seek never misses what the judge would match)', () => {
    const keyed = new Set(Object.values(DATE_KEY_FIELDS).flat());
    for (const fields of Object.values(DATE_ROLE_FIELDS)) for (const f of fields) expect(keyed.has(f)).toBe(true);
  });
});

describe('lots', () => {
  it('linked lot rows and the metadata lot, normalized; lot-row code/expiry dates carry the lot id', () => {
    const keys = deriveSearchKeys(
      { lot_number: '10426203', sub_lot_code: '03' },
      [{ lot_id: 'L1', lot_number: '10426203', sub_lot_code: '03', code_date: '2026-08-01', expiration_date: null }],
    );
    expect(keys.filter((k) => k.kind === 'lot').map((k) => k.value_norm)).toEqual(['1042620303']);
    expect(keys.find((k) => k.kind === 'code_date')).toMatchObject({ lot_id: 'L1', value_date: '2026-08-01' });
  });
});
