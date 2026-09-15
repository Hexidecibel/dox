/**
 * The supplier product bridge (shared/supplierProductBridge.ts) — which of our
 * products a supplier's certificate is, read from product_identifiers — and the
 * matcher's pair judgement over it (judgeBridgedPair). Pure.
 *
 * The fixture is prod's Country Morning shape: one supplier product name,
 * "Cream - Heavy Whipping 40%", on the 300 gal tote (CMF item 30904, our 10286)
 * AND the 5 gal bag (CMF item 50903, our 0801). supplier_product_map (0075)
 * could hold only one of them; this is the case it got wrong.
 */
import { describe, it, expect } from 'vitest';
import { prepareCatalog, type CatalogIdentifier, type CatalogProduct } from '../../shared/productIdentity';
import {
  bridgeEvidenceFromMetadata,
  namesAgree,
  resolveSupplierProduct,
  type BridgeEvidence,
} from '../../shared/supplierProductBridge';
import { findPacks } from '../../shared/productVocabulary';
import {
  judgeBridgedPair,
  CONFIDENCE_LOT_PRODUCT,
  CONFIDENCE_LOT_PRODUCT_UNCONFIRMED,
  CONFIDENCE_LOT_ONLY,
} from '../../functions/lib/entities/matching';

let seq = 0;
const id = (kind: CatalogIdentifier['kind'], value: string, o: Partial<CatalogIdentifier> = {}): CatalogIdentifier => ({
  id: `i${++seq}`, kind, value, supplier_id: null, supplier_name: null, superseded: false, confirmed: true, note: null, ...o,
});
const CMF = { supplier_id: 'cmf', supplier_name: 'Country Morning Farms' };
const OTHER = { supplier_id: 'other', supplier_name: 'Other Dairy' };

const PRODUCTS: CatalogProduct[] = [
  { product_id: 'p10286', product_name: '40% CREAM 300GL', identifiers: [
    id('our_sku', '10286'), id('supplier_item', '30904', CMF), id('supplier_name', 'Cream - Heavy Whipping 40%', CMF), id('pack', '300 Gallon Tote'),
  ] },
  { product_id: 'p0801', product_name: 'WHIP 5 GL BAG  (1/CS), M', identifiers: [
    id('our_sku', '0801'), id('supplier_item', '50903', CMF), id('supplier_name', 'Cream - Heavy Whipping 40%', CMF), id('pack', '5 Gallon Bag'),
  ] },
  { product_id: 'p0417', product_name: 'MS WHOLE 5 GL BAG', identifiers: [
    id('our_sku', '0417'), id('supplier_item', '50900', CMF), id('supplier_name', 'Milk - Whole', CMF),
  ] },
  { product_id: 'pHH', product_name: 'H&H 5 GL DISP', identifiers: [
    id('our_sku', '0708'), id('supplier_name', 'HALF AND HALF', CMF),
  ] },
  { product_id: 'pBM', product_name: 'BUTTERMILK 1%', identifiers: [
    id('supplier_name', 'Buttermilk - 1%', { ...CMF, confirmed: false }),
  ] },
  { product_id: 'pOther', product_name: 'OTHER CREAM', identifiers: [
    id('supplier_item', '30904', OTHER), id('supplier_name', 'Cream - Heavy Whipping 40%', OTHER),
  ] },
];
const catalog = prepareCatalog(PRODUCTS);

const ev = (o: Partial<BridgeEvidence> & { packText?: string }): BridgeEvidence => ({
  supplier_id: 'cmf',
  supplier_item: null,
  customer_item_number: null,
  product_name: null,
  pack: o.packText ? findPacks(o.packText).find((p) => p.quantity !== null) ?? findPacks(o.packText)[0] : null,
  ...o,
});

describe('resolveSupplierProduct — precedence', () => {
  it('an item number decides, even when the name is shared by two products', () => {
    const tote = resolveSupplierProduct(catalog, ev({ supplier_item: '30904', product_name: 'Cream - Heavy Whipping 40%' }));
    expect(tote.product_id).toBe('p10286');
    expect(tote.route).toBe('supplier_item');
    expect(tote.confirmed).toBe(true);
    expect(tote.our_skus).toEqual(['10286']);
    expect(tote.note).toBeNull();

    const bag = resolveSupplierProduct(catalog, ev({ supplier_item: '50903', product_name: 'Cream - Heavy Whipping 40%' }));
    expect(bag.product_id).toBe('p0801');
  });

  it('an item number beats a pack that points the other way', () => {
    const r = resolveSupplierProduct(catalog, ev({ supplier_item: '50903', product_name: 'Cream - Heavy Whipping 40%', packText: '300 Gallon Tote' }));
    expect(r.product_id).toBe('p0801');
    expect(r.route).toBe('supplier_item');
  });

  it("another supplier's identical item number is not this supplier's", () => {
    const r = resolveSupplierProduct(catalog, ev({ supplier_id: 'other', supplier_item: '30904' }));
    expect(r.product_id).toBe('pOther');
  });

  it('the customer item number (our SKU printed by the supplier) resolves too', () => {
    const r = resolveSupplierProduct(catalog, ev({ customer_item_number: '0801' }));
    expect(r.product_id).toBe('p0801');
    expect(r.route).toBe('customer_item');
  });

  it('item number and customer item number that disagree pick nothing and say so', () => {
    const r = resolveSupplierProduct(catalog, ev({ supplier_item: '30904', customer_item_number: '0801' }));
    expect(r.product_id).toBeNull();
    expect(r.note).toMatch(/the two numbers disagree, so no product is assumed/);
    expect(r.candidates.map((c) => c.product_id).sort()).toEqual(['p0801', 'p10286']);
  });

  it('name + pack disambiguates the tote from the bag when no number is printed', () => {
    const tote = resolveSupplierProduct(catalog, ev({ product_name: 'Cream - Heavy Whipping 40%', packText: '300 Gallon Tote' }));
    expect(tote.product_id).toBe('p10286');
    expect(tote.route).toBe('name_pack');
    expect(tote.note).toMatch(/uses "Cream - Heavy Whipping 40%" for 2 of our products; the certificate's pack 300 gal tote makes it/);

    const bag = resolveSupplierProduct(catalog, ev({ product_name: 'Cream - Heavy Whipping 40%', packText: '5 Gallon' }));
    expect(bag.product_id).toBe('p0801');
  });

  it('a name alone resolves ONLY when it names exactly one product', () => {
    const whole = resolveSupplierProduct(catalog, ev({ product_name: 'Milk - Whole' }));
    expect(whole.product_id).toBe('p0417');
    expect(whole.route).toBe('name');
  });

  it('the 0075 normalized key still names the product ("HALF AND HALF" = "Half-and-Half")', () => {
    expect(namesAgree('HALF AND HALF', 'Half-and-Half')).toBe(true);
    expect(namesAgree('CREAM HEAVY WHIPPING 40', 'Cream - Heavy Whipping 40%')).toBe(true);
    expect(resolveSupplierProduct(catalog, ev({ product_name: 'Half-and-Half' })).product_id).toBe('pHH');
  });
});

describe('resolveSupplierProduct — never picks', () => {
  it('an ambiguous name with nothing to tell the products apart yields no product and a reason', () => {
    const r = resolveSupplierProduct(catalog, ev({ product_name: 'Cream - Heavy Whipping 40%' }));
    expect(r.product_id).toBeNull();
    expect(r.candidates.map((c) => c.product_id).sort()).toEqual(['p0801', 'p10286']);
    expect(r.note).toMatch(/Country Morning Farms uses "Cream - Heavy Whipping 40%" for 2 of our products .* no item number or pack on the certificate tells them apart, so no product is assumed/);
  });

  it("a pack that fits neither product yields no product", () => {
    const r = resolveSupplierProduct(catalog, ev({ product_name: 'Cream - Heavy Whipping 40%', packText: '1/2 Gallon' }));
    expect(r.product_id).toBeNull();
    expect(r.note).toMatch(/half gal is none of theirs/);
  });

  it('a unique name whose pack contradicts the certificate is not assumed', () => {
    const r = resolveSupplierProduct(catalog, ev({ product_name: 'Half-and-Half', packText: '1/2 Gallon' }));
    expect(r.product_id).toBeNull();
    expect(r.note).toMatch(/this certificate's pack is half gal, not 5 gal dispenser/);
  });

  it('nothing known about the certificate says nothing', () => {
    expect(resolveSupplierProduct(catalog, ev({ product_name: 'Sour Cream' }))).toMatchObject({ product_id: null, note: null });
    expect(resolveSupplierProduct(null, ev({ supplier_item: '30904' }))).toMatchObject({ product_id: null, note: null });
  });

  it('supplier-scoped identifiers need the supplier', () => {
    expect(resolveSupplierProduct(catalog, ev({ supplier_id: null, supplier_item: '50900', product_name: 'Milk - Whole' })).product_id).toBeNull();
  });
});

describe('resolveSupplierProduct — unconfirmed', () => {
  it('resolves through an unconfirmed identifier and says "via unconfirmed identifier"', () => {
    const r = resolveSupplierProduct(catalog, ev({ product_name: 'Buttermilk - 1%' }));
    expect(r.product_id).toBe('pBM');
    expect(r.confirmed).toBe(false);
    expect(r.note).toMatch(/via unconfirmed identifier Country Morning Farms product name "Buttermilk - 1%" — confirm it/);
  });
});

describe('bridgeEvidenceFromMetadata', () => {
  it("reads a CMF certificate's own item number, name and pack", () => {
    const e = bridgeEvidenceFromMetadata(
      { product_name: 'Cream - Heavy Whipping 40%', product_code: '30904', net_weight: '300 Gallon Tote', customer_item_number: '10286' },
      { supplierId: 'cmf' },
    );
    expect(e).toMatchObject({ supplier_item: '30904', customer_item_number: '10286', product_name: 'Cream - Heavy Whipping 40%' });
    expect(e.pack?.container).toBe('tote');
  });
});

describe('judgeBridgedPair', () => {
  const base = { coaSupplierId: 'cmf', titleProductCode: null };

  it('a confirmed item number naming a DIFFERENT product records no suggestion', () => {
    const bridge = resolveSupplierProduct(catalog, ev({ supplier_item: '30904', product_name: 'Cream - Heavy Whipping 40%' }));
    const j = judgeBridgedPair({ ...base, bridge, coaProductId: 'pCoaSide', orderProductId: 'p0801', orderProductCode: '0801' });
    expect(j.skip).toBe(true);
  });

  it('the same item number against its OWN product is a lot+product suggestion', () => {
    const bridge = resolveSupplierProduct(catalog, ev({ supplier_item: '30904' }));
    const j = judgeBridgedPair({ ...base, bridge, coaProductId: 'pCoaSide', orderProductId: 'p10286', orderProductCode: '10286' });
    expect(j.skip).toBe(false);
    expect(j.classification.basis).toBe('lot+product');
    expect(j.note).toBeNull();
  });

  it('an ambiguous name stays a lot_only suggestion carrying the ambiguity as its reason', () => {
    const bridge = resolveSupplierProduct(catalog, ev({ product_name: 'Cream - Heavy Whipping 40%' }));
    const j = judgeBridgedPair({ ...base, bridge, coaProductId: 'pCoaSide', orderProductId: 'p0801', orderProductCode: '0801' });
    expect(j.skip).toBe(false);
    expect(j.classification.basis).toBe('lot_only');
    expect(j.classification.confidence).toBe(CONFIDENCE_LOT_ONLY);
    expect(j.note).toMatch(/no product is assumed/);
  });

  it('a name naming a different product is NOT suppressed — it says what it read', () => {
    const bridge = resolveSupplierProduct(catalog, ev({ product_name: 'Milk - Whole' }));
    const j = judgeBridgedPair({ ...base, bridge, coaProductId: 'pCoaSide', orderProductId: 'p0801', orderProductCode: '0801' });
    expect(j.skip).toBe(false);
    expect(j.note).toMatch(/reads as MS WHOLE 5 GL BAG .* by the supplier's product name, not this line's product/);
  });

  it('an unconfirmed bridge is ranked below a confirmed one and says so', () => {
    const bridge = resolveSupplierProduct(catalog, ev({ product_name: 'Buttermilk - 1%' }));
    const j = judgeBridgedPair({ ...base, coaSupplierId: null, bridge, coaProductId: 'pCoaSide', orderProductId: 'pBM', orderProductCode: null });
    expect(j.classification.basis).toBe('lot+product');
    expect(j.classification.confidence).toBe(CONFIDENCE_LOT_PRODUCT_UNCONFIRMED);
    expect(j.classification.confidence).toBeLessThan(CONFIDENCE_LOT_PRODUCT);
    expect(j.note).toMatch(/via unconfirmed identifier/);
  });

  it('an unconfirmed item number never suppresses', () => {
    const cat = prepareCatalog([
      { product_id: 'pX', product_name: 'X', identifiers: [id('supplier_item', '777', { ...CMF, confirmed: false })] },
    ]);
    const bridge = resolveSupplierProduct(cat, ev({ supplier_item: '777' }));
    const j = judgeBridgedPair({ ...base, bridge, coaProductId: 'pCoaSide', orderProductId: 'pY', orderProductCode: null });
    expect(j.skip).toBe(false);
  });

  it('a distributor code in the title that agrees with the line is never suppressed', () => {
    const bridge = resolveSupplierProduct(catalog, ev({ supplier_item: '30904' }));
    const j = judgeBridgedPair({ ...base, titleProductCode: '0801', bridge, coaProductId: 'pCoaSide', orderProductId: 'p0801', orderProductCode: '0801' });
    expect(j.skip).toBe(false);
  });

  it('with an empty bridge it is exactly classifyMatch on the certificate product', () => {
    const bridge = resolveSupplierProduct(null, ev({}));
    const j = judgeBridgedPair({ ...base, bridge, coaProductId: 'p1', orderProductId: 'p1', orderProductCode: null });
    expect(j).toEqual({ skip: false, classification: { basis: 'lot+product', confidence: CONFIDENCE_LOT_PRODUCT, strong: true }, note: null });
  });
});
