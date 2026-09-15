/**
 * Pack and attribute vocabulary (shared/productVocabulary.ts). Each equivalence
 * here makes two strings the same product, so each one is pinned — and so is
 * each thing that must NOT be folded.
 */
import { describe, it, expect } from 'vitest';
import {
  comparePacks,
  describePack,
  findAttributes,
  findPacks,
  normalizeCode,
  readProductPhrase,
} from '../../shared/productVocabulary';

const pack = (s: string) => {
  const p = findPacks(s).find((x) => x.quantity !== null) ?? findPacks(s)[0];
  if (!p) throw new Error(`no pack in "${s}"`);
  return p;
};
const same = (a: string, b: string) => comparePacks(pack(a), pack(b));

describe('attributes: unsalted = U/S = NS', () => {
  it('reads every spelling of unsalted', () => {
    for (const s of ['DG BTR BULK U/S 55.115#', 'SWEET CREAM BUTTER - Btr NS Gr AA 25kg', 'bulk unsalted butter', 'no salt butter']) {
      expect(findAttributes(s).map((a) => a.attribute), s).toEqual(['unsalted']);
    }
  });

  it('reads salted, and does NOT read a lone S as salted', () => {
    expect(findAttributes('salted butter').map((a) => a.attribute)).toEqual(['salted']);
    expect(findAttributes('DG BTR BULK S 55.115#')).toEqual([]);
  });

  it('does not find NS inside a word or a code', () => {
    expect(findAttributes('INSTANT NSF-1 CONS')).toEqual([]);
  });
});

describe('packs: sizes and containers', () => {
  it('"5 gallon bag(s)" = "5 GL BAG" = "5 Gallon Bag"', () => {
    for (const s of ['5 gallon bags', '5 GL BAG', '5 Gallon Bag', 'WHIP 5 GL BAG  (1/CS), M']) {
      expect(describePack(pack(s)), s).toBe('5 gal bag');
    }
    expect(same('5 gallon bags', '5 GL BAG')).toMatchObject({ equivalent: true, conversion: null });
  });

  it('"300 gal tote" = "300GL" = "300 Gallon Tote"', () => {
    expect(describePack(pack('40% CREAM 300GL'))).toBe('300 gal');
    expect(same('300 gal tote', '300 Gallon Tote')).toMatchObject({ equivalent: true });
    // A size with no container is the same pack as that size in a container.
    expect(same('300 gal tote', '300GL')).toMatchObject({ equivalent: true });
  });

  it('"half gallon" = "HG" = "½ gal"', () => {
    for (const s of ['half gallon', 'CREAM HG', '½ gal', '1/2 gallon']) expect(describePack(pack(s)), s).toBe('half gal');
    expect(same('CREAM HG', 'half gallon')).toMatchObject({ equivalent: true });
  });

  it('"5G" and "5 GL" are five gallons; a lower-case "500g" is not a gallon pack', () => {
    expect(describePack(pack('Cream 5G'))).toBe('5 gal');
    expect(same('Cream 5G', '5 GL')).toMatchObject({ equivalent: true });
    expect(findPacks('500g cup').filter((p) => p.unit === 'gal')).toEqual([]);
  });

  it('55.115# = 25 kg, by a conversion that is SAID', () => {
    const r = same('DG BTR BULK U/S 55.115#', 'Btr NS Gr AA 25kg');
    expect(r.equivalent).toBe(true);
    expect(r.conversion).toBe('25 kg = 55.116 lb, matched to 55.115 lb by unit conversion');
    // Same answer from either side.
    expect(same('25kg', '55.115#').conversion).toBe(r.conversion);
  });

  it('an exact match in the same unit carries no conversion note', () => {
    expect(same('55.115 lb', '55.115#')).toEqual({ equivalent: true, conversion: null, reason: null });
  });

  it('different sizes, containers or families are different packs', () => {
    expect(same('5 gal bag', '5 Gallon Tote')).toMatchObject({ equivalent: false, reason: '5 gal bag is not 5 gal tote' });
    expect(same('5 gal bag', '300 gal bag').equivalent).toBe(false);
    expect(same('25 kg', '5 gal').equivalent).toBe(false);
    // 68# butter is not a 25 kg case: 25 kg is 55.1 lb.
    expect(same('68#', '25kg').equivalent).toBe(false);
  });

  it('a bare container matches only a pack naming the same container', () => {
    expect(same('tote', '300 Gallon Tote').equivalent).toBe(true);
    expect(same('tote', '300GL').equivalent).toBe(false);
  });
});

describe('product phrases', () => {
  it('reads our WMS name and the supplier name into the same words, attributes and an equivalent pack', () => {
    const ours = readProductPhrase('DG BTR BULK U/S 55.115#');
    const theirs = readProductPhrase('SWEET CREAM BUTTER - Btr NS Gr AA 25kg');
    expect(ours).toMatchObject({ words: ['dg', 'butter', 'bulk'], attributes: ['unsalted'] });
    expect(theirs).toMatchObject({ words: ['sweet', 'cream', 'butter', 'aa'], attributes: ['unsalted'] });
    expect(comparePacks(ours.pack!, theirs.pack!).equivalent).toBe(true);
  });

  it('folds whipping/whip and plurals, keeps percentages, drops request words', () => {
    expect(readProductPhrase('Cream - Heavy Whipping 40%').words).toEqual(['cream', 'heavy', 'whip', '40%']);
    expect(readProductPhrase('COA for the creams').words).toEqual(['cream']);
  });

  it('keeps leading zeros in a code: 0801 is not 801, and 08012 is not 0801', () => {
    expect(normalizeCode('0801')).toBe('0801');
    expect(normalizeCode('08012')).not.toBe(normalizeCode('0801'));
  });
});
