/**
 * Product identity resolution and judging (shared/productIdentity.ts), and the
 * order -> certificate check (shared/orderCoverage.ts). Pure.
 */
import { describe, it, expect } from 'vitest';
import {
  checkProductIdentity,
  makeProductIdentityConstraint,
  prepareCatalog,
  resolveProductPhrase,
  type CatalogIdentifier,
  type CatalogProduct,
} from '../../shared/productIdentity';
import { checkOrder, makeOrderConstraint } from '../../shared/orderCoverage';

let seq = 0;
const id = (kind: CatalogIdentifier['kind'], value: string, o: Partial<CatalogIdentifier> = {}): CatalogIdentifier => ({
  id: `i${++seq}`, kind, value, supplier_id: null, supplier_name: null, superseded: false, confirmed: true, note: null, ...o,
});
const DG = { supplier_id: 'dg', supplier_name: 'Darigold, Inc.' };
const CMF = { supplier_id: 'cmf', supplier_name: 'Country Morning Farms' };

const PRODUCTS: CatalogProduct[] = [
  { product_id: 'p2235', product_name: 'DG BTR BULK U/S 55.115#', identifiers: [
    id('our_sku', '2235'), id('supplier_item', '810004', DG),
    id('supplier_name', 'SWEET CREAM BUTTER - Btr NS Gr AA 25kg', DG),
    id('supplier_item', '310348', { ...DG, superseded: true, confirmed: false }),
  ] },
  { product_id: 'p10286', product_name: '40% CREAM 300GL', identifiers: [
    id('our_sku', '10286'), id('supplier_item', '30904', CMF), id('supplier_name', 'Cream - Heavy Whipping 40%', CMF), id('pack', '300 Gallon Tote'),
  ] },
  { product_id: 'p10284', product_name: 'MS WHOLE 300GL', identifiers: [
    id('our_sku', '10284'), id('supplier_item', '30906', CMF), id('supplier_name', 'Milk - Whole', CMF), id('pack', '300 Gallon Tote'),
  ] },
  { product_id: 'p0801', product_name: 'WHIP 5 GL BAG  (1/CS), M', identifiers: [
    id('our_sku', '0801'), id('supplier_item', '50903', CMF), id('supplier_name', 'Cream - Heavy Whipping 40%', CMF),
  ] },
  { product_id: 'p0417', product_name: 'MS WHOLE 5 GL BAG', identifiers: [
    id('our_sku', '0417'), id('supplier_item', '50900', CMF), id('supplier_name', 'Milk - Whole', CMF),
  ] },
  { product_id: 'pAlias', product_name: 'CREAM CHEESE 30 LB', identifiers: [id('alias', 'brick cheese', { confirmed: false })] },
];
const catalog = prepareCatalog(PRODUCTS);
const resolve = (q: string) => resolveProductPhrase(q, catalog);
const ids = (q: string) => resolve(q)?.resolution.candidates.map((c) => c.product_id).sort() ?? null;

describe('resolveProductPhrase', () => {
  it('resolves our SKU, a supplier item and a former item to one product each', () => {
    expect(ids('2235')).toEqual(['p2235']);
    expect(ids('810004')).toEqual(['p2235']);
    expect(ids('10286')).toEqual(['p10286']);
    expect(resolve('810004')!.strong).toBe(true);
  });

  it('says a former item number is former, and that an unconfirmed one is unconfirmed', () => {
    const r = resolve('310348')!.resolution;
    expect(r.candidates[0].confirmed).toBe(false);
    expect(r.message).toMatch(/via unconfirmed former Darigold, Inc\. item 310348 — confirm/);
  });

  it('does not treat 801 as 0801, or 08012 as anything', () => {
    expect(resolve('801')).toBeNull();
    expect(resolve('08012')).toBeNull();
  });

  it('resolves words, attributes and a pack across our name and the supplier name', () => {
    expect(ids('bulk unsalted butter')).toEqual(['p2235']);
    expect(ids('NS butter')).toEqual(['p2235']);
    expect(ids('heavy cream 300 gal tote')).toEqual(['p10286']);
    expect(resolve('bulk unsalted butter')!.strong).toBe(false);
  });

  it('refuses a salted query against an unsalted product, and any phrase with a word no product has', () => {
    expect(resolve('salted butter')).toBeNull();
    expect(resolve('cream tote chocolate')).toBeNull();
  });

  it('keeps an ambiguous pack ambiguous and says so', () => {
    const r = resolve('300 gal tote')!;
    expect(r.strong).toBe(true);
    expect(r.resolution.ambiguous).toBe(true);
    expect(r.resolution.candidates.map((c) => c.product_id).sort()).toEqual(['p10284', 'p10286']);
    expect(r.resolution.message).toMatch(/^"300 gal tote" could mean 2 products: .*Nothing is picked/);
    expect(ids('5 gallon bags')).toEqual(['p0417', 'p0801']);
  });

  it('notes a conversion when the typed pack is in the other unit', () => {
    const k = resolve('unsalted butter 25kg')!.resolution.candidates[0];
    expect(k.conversion_note).toBe('25 kg = 55.116 lb, matched to 55.115 lb by unit conversion');
    expect(k.explanation).toContain('(25 kg = 55.116 lb, matched to 55.115 lb by unit conversion)');
  });

  it('marks a product reached through an unconfirmed alias as unconfirmed', () => {
    const k = resolve('brick cheese')!.resolution.candidates[0];
    expect(k.confirmed).toBe(false);
    expect(k.explanation).toMatch(/via unconfirmed alias "brick cheese"/);
  });

  it('several codes must name the same product', () => {
    expect(ids('2235 810004')).toEqual(['p2235']);
    expect(resolve('2235 10286')).toBeNull();
  });
});

const subject = (metadata: Record<string, unknown>, extra: Partial<Parameters<typeof checkProductIdentity>[1]> = {}) => ({
  supplier_id: null, supplier_name: null, supplier_aliases: [], product_names: [], lots: [], metadata, ...extra,
});
const constraintFor = (q: string) => makeProductIdentityConstraint('c1', resolve(q)!.resolution, 'query_text');

describe('checkProductIdentity', () => {
  it('a supplier item decides, and the pack conversion is shown', () => {
    const ch = checkProductIdentity(constraintFor('2235'), subject({ product_code: '810004', product_name: 'SWEET CREAM BUTTER - Btr NS Gr AA 25kg' }, { supplier_id: 'dg' }));
    expect(ch.outcome).toBe('match');
    expect(ch.message).toContain('25 kg = 55.116 lb, matched to 55.115 lb by unit conversion');
  });

  it('a different item number from the same supplier is not the product', () => {
    const ch = checkProductIdentity(constraintFor('2235'), subject({ product_code: '810001' }, { supplier_id: 'dg' }));
    expect(ch).toMatchObject({ outcome: 'mismatch' });
    expect(ch.message).toMatch(/item 810001, not item 810004/);
  });

  it('the customer item # is our SKU; a disagreeing supplier item is flagged, not trusted', () => {
    expect(checkProductIdentity(constraintFor('10286'), subject({ customer_item_number: '10286' })).outcome).toBe('match');
    const conflict = checkProductIdentity(constraintFor('10286'), subject({ customer_item_number: '10286', product_code: '30906' }, { supplier_id: 'cmf' }));
    expect(conflict.outcome).toBe('unverified');
    expect(conflict.message).toMatch(/disagree/);
  });

  it('a name match needs the pack when the product is known by one', () => {
    const k = constraintFor('10286');
    expect(checkProductIdentity(k, subject({ product_name: 'Cream - Heavy Whipping 40%', net_weight: '300 Gallon Tote' })).outcome).toBe('match');
    expect(checkProductIdentity(k, subject({ product_name: 'Cream - Heavy Whipping 40%', net_weight: '5 Gallon Bag' })).outcome).toBe('mismatch');
    expect(checkProductIdentity(k, subject({ product_name: 'Cream - Heavy Whipping 40%' })).outcome).toBe('unverified');
  });

  it('never reads a lot weight in net_weight as a pack', () => {
    const ch = checkProductIdentity(constraintFor('bulk unsalted butter'), subject({ product_name: 'SWEET CREAM BUTTER - Btr NS Gr AA 25kg', net_weight: '2755.75 LB' }));
    expect(ch.outcome).toBe('match');
  });

  it('under ambiguity the best candidate names itself; a document that is neither says so', () => {
    const c = constraintFor('300 gal tote');
    const whole = checkProductIdentity(c, subject({ product_code: '30906' }, { supplier_id: 'cmf' }));
    expect(whole).toMatchObject({ outcome: 'match', candidate_product_id: 'p10284' });
    expect(whole.message).toMatch(/^As MS WHOLE 300GL/);
    const bag = checkProductIdentity(c, subject({ product_code: '50903' }, { supplier_id: 'cmf' }));
    expect(bag).toMatchObject({ outcome: 'mismatch', candidate_product_id: null });
    expect(bag.message).toMatch(/^It is none of the 2 products "300 gal tote" could mean/);
  });

  it('a document reached only through an unconfirmed former item is likely, not a match', () => {
    const ch = checkProductIdentity(constraintFor('310348'), subject({ product_code: '810004' }, { supplier_id: 'dg' }));
    expect(ch.outcome).toBe('likely');
  });
});

describe('checkOrder (A7)', () => {
  const order = makeOrderConstraint('c1', {
    order_id: 'o1', order_number: '1797062', customer_name: null,
    lines: [
      { order_item_id: 'a', product_code: '2235', product_name: null, lot_number: '1042620304', accepted_document_ids: ['docAccepted'], legacy_document_ids: [], suggested: [], rejected_document_ids: [] },
      { order_item_id: 'b', product_code: '2235', product_name: null, lot_number: '1042620413', accepted_document_ids: [], legacy_document_ids: [], suggested: [{ document_id: 'docSuggested', basis: 'lot_only', confidence: 0.5 }], rejected_document_ids: ['docRejected'] },
    ],
  }, '1797062');
  const lot = (lot_number: string, sub_lot_code: string) => ({ lot_number, sub_lot_code, lot_key: lot_number + sub_lot_code });

  it('accepted by a person, or exactly the shipped lot, covers', () => {
    expect(checkOrder(order, { id: 'docAccepted', lots: [] }).outcome).toBe('match');
    expect(checkOrder(order, { id: 'x', lots: [lot('10426204', '13')] }).outcome).toBe('match');
  });

  it('a suggestion is "confirm", a sibling sublot is near, a rejection is a mismatch even on the exact lot', () => {
    const s = checkOrder(order, { id: 'docSuggested', lots: [] });
    expect(s.outcome).toBe('likely');
    expect(s.message).toMatch(/lot only, 50%/);
    expect(checkOrder(order, { id: 'y', lots: [lot('10426203', '03')] }).outcome).toBe('near');
    const rejected = checkOrder(order, { id: 'docRejected', lots: [lot('10426204', '13')] });
    expect(rejected.outcome).toBe('mismatch');
    expect(rejected.message).toMatch(/A person rejected this certificate/);
  });

  it('a suggestion or an accept for a line whose product resolves is checked against that product', () => {
    const line = {
      order_item_id: 'c', product_code: '2235', product_name: null, lot_number: '1042620388',
      accepted_document_ids: ['acceptedWrong'], legacy_document_ids: [], suggested: [{ document_id: 'suggestedWrong', basis: 'lot_only', confidence: 0.5 }],
      rejected_document_ids: [], product_resolution: resolve('2235')!.resolution,
    };
    const c = makeOrderConstraint('c1', { order_id: 'o2', order_number: '1797099', customer_name: null, lines: [line] }, '1797099');
    const salted = { supplier_id: 'dg', supplier_name: 'Darigold, Inc.', supplier_aliases: [], product_names: [], metadata: { product_code: '810001' } };
    const suggested = checkOrder(c, { ...salted, id: 'suggestedWrong', lots: [] });
    expect(suggested.outcome).toBe('mismatch');
    expect(suggested.message).toMatch(/wrong product: This certificate is Darigold, Inc\. item 810001, not item 810004/);
    // A person's accept is flagged, not overruled.
    const accepted = checkOrder(c, { ...salted, id: 'acceptedWrong', lots: [] });
    expect(accepted.outcome).toBe('unverified');
    expect(accepted.message).toMatch(/A person accepted .* But this certificate is Darigold, Inc\. item 810001/);
    // The right product keeps the suggestion as "confirm".
    expect(checkOrder(c, { ...salted, metadata: { product_code: '810004' }, id: 'suggestedWrong', lots: [] }).outcome).toBe('likely');
  });
});
