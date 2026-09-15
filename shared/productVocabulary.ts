/**
 * Pack and attribute vocabulary — how the same product is WRITTEN differently.
 *
 * AJ Conner, Any-Field COA Retrieval, D5: "U/S and NS are the same attribute;
 * 55.115# and 25kg are the same pack. Nothing declares these equivalent." This
 * file declares them, in code, for every tenant. It is deliberately NOT
 * per-tenant configuration in v1: the equivalences here are facts about how
 * dairy paperwork abbreviates (a gallon is a gallon for everyone), and a
 * setting nobody can see is how "U/S" quietly stops meaning unsalted for one
 * workspace.
 *
 * CONSERVATIVE BY DESIGN. Every rule here makes two strings the same product,
 * and a wrong one hands a customer the certificate for something they did not
 * buy. So:
 *   - only abbreviations observed on real paperwork (Medosweet WMS
 *     descriptions, Darigold and Country Morning certificates) are folded;
 *   - "S" is NOT read as salted: a lone letter in free text means too many
 *     things, and a salted/unsalted mix-up is exactly the error to avoid;
 *   - a bare "g" after a number is GRAMS; only an upper-case "G" written
 *     against the number ("5G", Andersen's "Cream 5G") is gallons;
 *   - a weight compared with a weight in another unit is a CONVERSION, and
 *     every comparison that needed one says so (AJ: "conversions are shown,
 *     never silent").
 *
 * Pure; no I/O.
 */

export type PackUnit = 'gal' | 'lb' | 'kg' | 'oz';
export type PackContainer = 'bag' | 'tote' | 'jug' | 'dispenser' | 'pail' | 'drum' | 'case';

export interface Pack {
  /** Null for a container named with no size ("tote"). */
  quantity: number | null;
  unit: PackUnit | null;
  container: PackContainer | null;
  /** The text as written. */
  raw: string;
  start: number;
  end: number;
}

export type ProductAttribute = 'unsalted' | 'salted';

// ---------------------------------------------------------------------------
// Packs
// ---------------------------------------------------------------------------

const CONTAINERS: Array<{ re: RegExp; container: PackContainer }> = [
  { re: /^bags?$/i, container: 'bag' },
  { re: /^totes?$/i, container: 'tote' },
  { re: /^jugs?$/i, container: 'jug' },
  { re: /^(?:disp|dispensers?|bib)$/i, container: 'dispenser' },
  { re: /^pails?$/i, container: 'pail' },
  { re: /^drums?$/i, container: 'drum' },
];

function containerOf(word: string): PackContainer | null {
  for (const c of CONTAINERS) if (c.re.test(word)) return c.container;
  return null;
}

const NUM = String.raw`(\d+(?:\.\d+)?|½|1\/2)`;

/**
 * Size patterns, tried in order. `G` (upper-case, attached or spaced) is
 * gallons; lower-case g is grams and is not a pack this vocabulary knows.
 */
const SIZE_PATTERNS: Array<{ re: RegExp; unit: PackUnit; caseSensitive?: boolean }> = [
  { re: new RegExp(String.raw`\bhalf[\s-]*gal(?:lon)?s?\b`, 'gi'), unit: 'gal' },
  { re: new RegExp(String.raw`(?<![A-Za-z0-9])${NUM}\s*-?\s*(?:gallons?|gals?|gl)(?![A-Za-z])`, 'gi'), unit: 'gal' },
  { re: new RegExp(String.raw`(?<![A-Za-z0-9.])${NUM}\s?G(?![A-Za-z])`, 'g'), unit: 'gal', caseSensitive: true },
  { re: new RegExp(String.raw`(?<![A-Za-z0-9.])${NUM}\s*(?:kgs?|kilos?|kilograms?)(?![A-Za-z])`, 'gi'), unit: 'kg' },
  { re: new RegExp(String.raw`(?<![A-Za-z0-9.])${NUM}\s*(?:#|lbs?|pounds?)(?![A-Za-z])`, 'gi'), unit: 'lb' },
  { re: new RegExp(String.raw`(?<![A-Za-z0-9.])${NUM}\s*(?:oz|ounces?)(?![A-Za-z])`, 'gi'), unit: 'oz' },
  // "HG" is Andersen's half gallon ("CREAM HG"); only as its own word.
  { re: /\bHG\b/g, unit: 'gal', caseSensitive: true },
];

function parseQuantity(s: string | undefined, whole: string): number | null {
  if (/^half/i.test(whole) || /^HG$/.test(whole)) return 0.5;
  if (!s) return null;
  if (s === '½' || s === '1/2') return 0.5;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Every pack written in `text`: sizes ("5 GL BAG", "300 Gallon Tote", "55.115#",
 * "25kg", "half gallon", "HG") and containers named on their own ("tote").
 */
export function findPacks(text: string): Pack[] {
  const found: Pack[] = [];
  const taken = (s: number, e: number) => found.some((p) => s < p.end && e > p.start);
  for (const pat of SIZE_PATTERNS) {
    pat.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.re.exec(text)) !== null) {
      const start = m.index;
      let end = start + m[0].length;
      if (taken(start, end)) continue;
      const quantity = parseQuantity(m[1], m[0]);
      if (quantity === null) continue;
      // A container word right after the size belongs to it: "5 GL BAG".
      let container: PackContainer | null = null;
      const after = /^[\s-]+([A-Za-z]+)/.exec(text.slice(end));
      if (after) {
        const c = containerOf(after[1]);
        if (c) {
          container = c;
          end += after[0].length;
        }
      }
      found.push({ quantity, unit: pat.unit, container, raw: text.slice(start, end), start, end });
    }
  }
  const wordRe = /[A-Za-z]+/g;
  let w: RegExpExecArray | null;
  while ((w = wordRe.exec(text)) !== null) {
    const c = containerOf(w[0]);
    if (!c || taken(w.index, w.index + w[0].length)) continue;
    found.push({ quantity: null, unit: null, container: c, raw: w[0], start: w.index, end: w.index + w[0].length });
  }
  return found.sort((a, b) => a.start - b.start);
}

/** The first pack with a size, else the first container. */
export function primaryPack(text: string | null | undefined): Pack | null {
  if (!text) return null;
  const packs = findPacks(text);
  return packs.find((p) => p.quantity !== null) ?? packs[0] ?? null;
}

const LB_PER_KG = 2.20462262;
const LB_PER_OZ = 1 / 16;

function toBase(p: Pack): { family: 'mass' | 'volume'; value: number } | null {
  if (p.quantity === null || !p.unit) return null;
  switch (p.unit) {
    case 'gal': return { family: 'volume', value: p.quantity };
    case 'lb': return { family: 'mass', value: p.quantity };
    case 'kg': return { family: 'mass', value: p.quantity * LB_PER_KG };
    case 'oz': return { family: 'mass', value: p.quantity * LB_PER_OZ };
  }
}

function trimNumber(n: number): string {
  return String(Number(n.toFixed(3)));
}

const UNIT_WORD: Record<PackUnit, string> = { gal: 'gal', lb: 'lb', kg: 'kg', oz: 'oz' };

/** "5 gal bag", "55.115 lb", "tote". */
export function describePack(p: Pack): string {
  const size = p.quantity !== null && p.unit
    ? (p.unit === 'gal' && p.quantity === 0.5 ? 'half gal' : `${trimNumber(p.quantity)} ${UNIT_WORD[p.unit]}`)
    : '';
  return [size, p.container ?? ''].filter(Boolean).join(' ');
}

export interface PackComparison {
  equivalent: boolean;
  /**
   * Set when the sizes were only equal after converting units:
   * "25 kg = 55.116 lb, matched to 55.115 lb by unit conversion". Never set
   * for an exact match.
   */
  conversion: string | null;
  /** Why they differ, in words, when they do. */
  reason: string | null;
}

/**
 * Are two packs the same pack?
 *   - sizes in the same family compare after conversion, within 0.1% (25 kg is
 *     55.1156 lb; the WMS writes 55.115#);
 *   - containers must agree when BOTH name one; a size with no container
 *     ("300GL") is the same pack as that size in a container ("300 Gallon Tote");
 *   - a container alone ("tote") matches any pack in that container.
 */
export function comparePacks(a: Pack, b: Pack): PackComparison {
  if (a.container && b.container && a.container !== b.container) {
    return { equivalent: false, conversion: null, reason: `${describePack(a)} is not ${describePack(b)}` };
  }
  const ba = toBase(a);
  const bb = toBase(b);
  if (!ba || !bb) {
    // At least one side is a bare container ("tote"). It matches only a pack
    // that names the SAME container; a size with no container cannot be
    // verified as one.
    if (a.container && b.container) return { equivalent: true, conversion: null, reason: null };
    return { equivalent: false, conversion: null, reason: 'no container is written on one side, so the pack cannot be compared' };
  }
  if (ba.family !== bb.family) {
    return { equivalent: false, conversion: null, reason: `${describePack(a)} is a ${ba.family}, ${describePack(b)} is a ${bb.family}` };
  }
  const diff = Math.abs(ba.value - bb.value);
  const tolerance = Math.max(ba.value, bb.value) * 0.001;
  if (diff > tolerance) {
    return { equivalent: false, conversion: null, reason: `${describePack(a)} is not ${describePack(b)}` };
  }
  if (a.unit === b.unit) return { equivalent: true, conversion: null, reason: null };
  // Say the conversion from the metric side, where the exact figure lives.
  const [from, to] = a.unit === 'kg' || (a.unit === 'lb' && b.unit === 'oz') ? [a, b] : [b, a];
  const converted = toBase(from)!.value / (to.unit === 'kg' ? LB_PER_KG : to.unit === 'oz' ? LB_PER_OZ : 1);
  return {
    equivalent: true,
    conversion: `${describePack(from)} = ${trimNumber(converted)} ${UNIT_WORD[to.unit!]}, matched to ${describePack(to)} by unit conversion`,
    reason: null,
  };
}

// ---------------------------------------------------------------------------
// Attributes and words
// ---------------------------------------------------------------------------

/**
 * Attribute spellings. "U/S" (Medosweet WMS) and "NS" (Darigold) are both
 * unsalted. Matched as whole tokens only.
 */
const ATTRIBUTE_PATTERNS: Array<{ re: RegExp; attribute: ProductAttribute }> = [
  { re: /(?<![A-Za-z0-9])(?:u\/s|unsalted|no[\s-]+salt|salt[\s-]+free)(?![A-Za-z0-9])/gi, attribute: 'unsalted' },
  { re: /(?<![A-Za-z0-9/])NS(?![A-Za-z0-9/])/g, attribute: 'unsalted' },
  { re: /(?<![A-Za-z0-9])salted(?![A-Za-z0-9])/gi, attribute: 'salted' },
];

export interface AttributeHit {
  attribute: ProductAttribute;
  raw: string;
  start: number;
  end: number;
}

export function findAttributes(text: string): AttributeHit[] {
  const out: AttributeHit[] = [];
  for (const p of ATTRIBUTE_PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (out.some((h) => start < h.end && end > h.start)) continue;
      out.push({ attribute: p.attribute, raw: m[0], start, end });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Word abbreviations observed on the paperwork. Kept to the ones whose
 * expansion cannot be anything else in a dairy product description.
 */
const WORD_EXPANSIONS: Record<string, string> = {
  btr: 'butter',
  crm: 'cream',
  hvy: 'heavy',
  whl: 'whole',
  whipping: 'whip',
  whipped: 'whip',
  choc: 'chocolate',
};

/** Words that describe a request or a record, never a product. */
const NON_PRODUCT_WORDS = new Set([
  'a', 'an', 'the', 'and', 'of', 'for', 'with', 'in', 'on', 'or', 'to',
  'item', 'items', 'product', 'products', 'sku', 'code', 'number', 'no', 'supplier', 'customer',
  'our', 'their', 'coa', 'coas', 'certificate', 'certificates', 'cert', 'certs',
  'gr', 'grade', 'cs', 'm',
]);

function stem(word: string): string {
  const w = WORD_EXPANSIONS[word] ?? word;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !/\d/.test(w)) return WORD_EXPANSIONS[w.slice(0, -1)] ?? w.slice(0, -1);
  return w;
}

export interface ProductPhrase {
  /** Canonical product words ("butter", "bulk", "40%"). */
  words: string[];
  attributes: ProductAttribute[];
  pack: Pack | null;
  /** Every pack written, in order. */
  packs: Pack[];
}

/**
 * Read a product description into canonical words, attributes and a pack.
 * "DG BTR BULK U/S 55.115#" -> words [dg, butter, bulk], attributes
 * [unsalted], pack 55.115 lb. "SWEET CREAM BUTTER - Btr NS Gr AA 25kg" -> words
 * [sweet, cream, butter, aa], attributes [unsalted], pack 25 kg.
 */
export function readProductPhrase(text: string): ProductPhrase {
  const packs = findPacks(text);
  const attrs = findAttributes(text);
  let masked = '';
  let pos = 0;
  const spans = [...packs, ...attrs].sort((a, b) => a.start - b.start);
  for (const s of spans) {
    if (s.start < pos) continue;
    masked += text.slice(pos, s.start) + ' ';
    pos = s.end;
  }
  masked += text.slice(pos);
  const words = masked
    .toLowerCase()
    .replace(/\(\s*\d+\s*\/\s*cs\s*\)/g, ' ')
    .replace(/[^a-z0-9%&]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w === 'h&h' ? 'half' : w))
    .filter((w) => !NON_PRODUCT_WORDS.has(w) && w !== '&')
    .map(stem);
  const unique = [...new Set(words)];
  return {
    words: unique,
    attributes: [...new Set(attrs.map((a) => a.attribute))],
    pack: packs.find((p) => p.quantity !== null) ?? packs[0] ?? null,
    packs,
  };
}

/** Upper-case alphanumerics — how a code is compared. Leading zeros are kept: 0801 is not 801. */
export function normalizeCode(value: string): string {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Lower-cased, punctuation-collapsed words — how a name is compared. */
export function normalizeName(value: string): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9%]+/g, ' ').replace(/\s+/g, ' ').trim();
}
