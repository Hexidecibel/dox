/**
 * Product identity — resolving the way a PERSON names a product to the products
 * we hold, and judging whether a document IS that product.
 *
 * AJ Conner, Any-Field COA Retrieval, R5 / R7: "Without this, a search on the
 * supplier's own product name returns nothing, which is exactly what a customer
 * or a supplier will type." The identifier graph (migration 0107) says what
 * each of OUR products goes by: our SKU, the supplier's item number(s), the
 * supplier's product name(s), aliases, a pack. This module:
 *
 *   resolveProductPhrase   "2235", "810004", "bulk unsalted butter",
 *                          "300 gal tote" -> candidate products, each with the
 *                          route it was reached by, in words.
 *   checkProductIdentity   does this document's OWN product evidence (customer
 *                          item #, supplier item #, product name + pack) make it
 *                          that product?
 *
 * RULES THAT KEEP A WRONG PRODUCT FROM BEING HANDED OVER:
 *   - A phrase that could mean several products is AMBIGUOUS and stays so:
 *     every candidate is returned and every document is judged against each.
 *     Nothing picks the one that happens to have a document on file.
 *   - A phrase resolves only when EVERY word in it is accounted for by one
 *     product. "cream tote" does not become "tote".
 *   - An identifier nobody has confirmed can help FIND a product, but anything
 *     reached through it is "likely — confirm", never covering, and says which
 *     identifier it came through.
 *   - A supplier's item number beats a name: when a document prints the
 *     supplier's item and this product lists that supplier's items, the number
 *     decides.
 *   - A pack compared across units is a conversion, and the message says so.
 *
 * Pure; no I/O. Loading the catalog is functions/lib/product-identifiers.ts.
 */

import type {
  ProductIdentifierKind,
  SearchCheckOutcome,
  SearchConstraint,
  SearchConstraintCheck,
  SearchProductCandidate,
  SearchProductMatchedVia,
  SearchProductResolution,
} from './types';
import {
  comparePacks,
  describePack,
  findAttributes,
  findPacks,
  normalizeCode,
  readProductPhrase,
  type Pack,
  type ProductAttribute,
  type ProductPhrase,
} from './productVocabulary';

// ===========================================================================
// Catalog
// ===========================================================================

export interface CatalogIdentifier {
  id: string;
  kind: ProductIdentifierKind;
  value: string;
  supplier_id: string | null;
  supplier_name: string | null;
  superseded: boolean;
  confirmed: boolean;
  note: string | null;
}

export interface CatalogProduct {
  product_id: string;
  product_name: string;
  identifiers: CatalogIdentifier[];
}

interface NameEntry {
  text: string;
  via: SearchProductMatchedVia;
  phrase: ProductPhrase;
}

export interface PreparedProduct extends CatalogProduct {
  names: NameEntry[];
  pack: { pack: Pack; via: SearchProductMatchedVia } | null;
  tokens: Set<string>;
  attributes: Set<ProductAttribute>;
}

export interface PreparedCatalog {
  products: PreparedProduct[];
  /** Normalized code -> the products and identifiers holding it. */
  codes: Map<string, Array<{ product: PreparedProduct; identifier: CatalogIdentifier }>>;
}

const CODE_KINDS: ReadonlySet<ProductIdentifierKind> = new Set(['our_sku', 'supplier_item', 'gtin']);

function viaOf(i: CatalogIdentifier): SearchProductMatchedVia {
  return {
    kind: i.kind,
    value: i.value,
    confirmed: i.confirmed,
    superseded: i.superseded,
    supplier_name: i.supplier_name,
    note: i.note,
  };
}

export function prepareCatalog(products: CatalogProduct[]): PreparedCatalog {
  const codes: PreparedCatalog['codes'] = new Map();
  const prepared: PreparedProduct[] = products.map((p) => {
    const names: NameEntry[] = [
      { text: p.product_name, via: { kind: 'product_name', value: p.product_name, confirmed: true }, phrase: readProductPhrase(p.product_name) },
    ];
    for (const i of p.identifiers) {
      if (i.kind === 'supplier_name' || i.kind === 'alias') {
        names.push({ text: i.value, via: viaOf(i), phrase: readProductPhrase(i.value) });
      }
    }
    // The pack a product is known by: a declared pack first (confirmed before
    // unconfirmed), then OUR name's, then a supplier name's.
    let pack: PreparedProduct['pack'] = null;
    const packIds = p.identifiers.filter((i) => i.kind === 'pack').sort((a, b) => Number(b.confirmed) - Number(a.confirmed));
    for (const i of packIds) {
      const found = findPacks(i.value).find((x) => x.quantity !== null) ?? findPacks(i.value)[0];
      if (found) { pack = { pack: found, via: viaOf(i) }; break; }
    }
    if (!pack) {
      for (const n of names) {
        if (n.phrase.pack) { pack = { pack: n.phrase.pack, via: n.via }; break; }
      }
    }
    const tokens = new Set(names.flatMap((n) => n.phrase.words));
    const attributes = new Set(names.flatMap((n) => n.phrase.attributes));
    return { ...p, names, pack, tokens, attributes };
  });
  for (const p of prepared) {
    for (const i of p.identifiers) {
      if (!CODE_KINDS.has(i.kind)) continue;
      const key = normalizeCode(i.value);
      if (key.length < 3) continue;
      codes.set(key, [...(codes.get(key) ?? []), { product: p, identifier: i }]);
    }
  }
  return { products: prepared, codes };
}

/** Every code the catalog holds (so a code that looks like a lot is not read as one). */
export function catalogCodes(catalog: PreparedCatalog): Set<string> {
  return new Set(catalog.codes.keys());
}

// ===========================================================================
// Resolution
// ===========================================================================

function ourSkus(p: CatalogProduct): string[] {
  return p.identifiers.filter((i) => i.kind === 'our_sku').map((i) => i.value);
}

export function productLabel(p: PreparedProduct): string {
  const parts: string[] = [];
  const items = p.identifiers
    .filter((i) => i.kind === 'supplier_item' && !i.superseded)
    .sort((a, b) => Number(b.confirmed) - Number(a.confirmed));
  for (const i of items.slice(0, 2)) parts.push(`${i.supplier_name ?? 'supplier'} item ${i.value}${i.confirmed ? '' : ' (unconfirmed)'}`);
  const skus = ourSkus(p);
  if (skus.length) parts.push(`our SKU ${skus.join(' / ')}`);
  const packInName = p.pack && p.names[0].phrase.pack;
  if (p.pack && !packInName) parts.push(describePack(p.pack.pack));
  return parts.length ? `${p.product_name} (${parts.join(', ')})` : p.product_name;
}

function describeVia(v: SearchProductMatchedVia): string {
  const q = v.confirmed ? '' : 'unconfirmed ';
  const former = v.superseded ? 'former ' : '';
  switch (v.kind) {
    case 'our_sku': return `${q}our SKU ${v.value}`;
    case 'supplier_item': return `${q}${former}${v.supplier_name ?? 'supplier'} item ${v.value}`;
    case 'supplier_name': return `${q}${v.supplier_name ?? 'supplier'} product name "${v.value}"`;
    case 'alias': return `${q}alias "${v.value}"`;
    case 'gtin': return `${q}GTIN ${v.value}`;
    case 'pack': return `${q}pack ${v.value}`;
    case 'product_name': return `product name "${v.value}"`;
    case 'attribute': return v.value;
  }
}

export interface PhraseResolution {
  resolution: SearchProductResolution;
  /**
   * A code or a pack was named. A resolution on words alone ("butter") is not
   * strong enough to turn a browsing search into a coverage question; it is
   * applied only alongside another constraint.
   */
  strong: boolean;
  /** The character spans of `phrase` that were resolved (always the whole phrase today). */
}

function attributeSpellings(p: PreparedProduct, attr: ProductAttribute): string[] {
  const out = new Set<string>();
  for (const n of p.names) for (const h of findAttributes(n.text)) if (h.attribute === attr) out.add(h.raw);
  return [...out];
}

/**
 * Resolve a product phrase against the catalog, or return null when the phrase
 * does not resolve as a whole.
 */
export function resolveProductPhrase(phrase: string, catalog: PreparedCatalog): PhraseResolution | null {
  const text = phrase.trim();
  if (!text || catalog.products.length === 0) return null;

  // 1. Codes: a token that IS an identifier value.
  const rawTokens = text.split(/\s+/).filter(Boolean);
  const codeTokens: Array<{ raw: string; hits: Array<{ product: PreparedProduct; identifier: CatalogIdentifier }> }> = [];
  const rest: string[] = [];
  for (const t of rawTokens) {
    const hits = catalog.codes.get(normalizeCode(t));
    if (hits && /\d/.test(t)) codeTokens.push({ raw: t, hits });
    else rest.push(t);
  }

  const restPhrase = readProductPhrase(rest.join(' '));
  const describes = (p: PreparedProduct): { ok: boolean; conversion: string | null } => {
    if (!restPhrase.words.every((w) => p.tokens.has(w))) return { ok: false, conversion: null };
    if (!restPhrase.attributes.every((a) => p.attributes.has(a))) return { ok: false, conversion: null };
    if (restPhrase.pack) {
      if (!p.pack) return { ok: false, conversion: null };
      const cmp = comparePacks(restPhrase.pack, p.pack.pack);
      if (!cmp.equivalent) return { ok: false, conversion: null };
      return { ok: true, conversion: cmp.conversion };
    }
    return { ok: true, conversion: null };
  };

  let pool: Array<{ product: PreparedProduct; codeVia: CatalogIdentifier[] }>;
  if (codeTokens.length > 0) {
    // Every code must name the same product.
    const byProduct = new Map<string, { product: PreparedProduct; codeVia: CatalogIdentifier[] }>();
    for (const h of codeTokens[0].hits) byProduct.set(h.product.product_id, { product: h.product, codeVia: [h.identifier] });
    for (const t of codeTokens.slice(1)) {
      for (const [id, entry] of byProduct) {
        const hit = t.hits.find((h) => h.product.product_id === id);
        if (!hit) byProduct.delete(id);
        else entry.codeVia.push(hit.identifier);
      }
    }
    pool = [...byProduct.values()];
  } else {
    if (restPhrase.words.length === 0 && restPhrase.attributes.length === 0 && !restPhrase.pack) return null;
    pool = catalog.products.map((product) => ({ product, codeVia: [] }));
  }

  const candidates: SearchProductCandidate[] = [];
  for (const { product: p, codeVia } of pool) {
    const d = describes(p);
    if (!d.ok) continue;
    const via: SearchProductMatchedVia[] = codeVia.map(viaOf);
    // Words: prefer a confirmed name that carries each word.
    const usedNames = new Map<string, NameEntry>();
    for (const w of restPhrase.words) {
      const holders = p.names.filter((n) => n.phrase.words.includes(w));
      const pick = holders.find((n) => n.via.confirmed) ?? holders[0];
      if (pick) usedNames.set(pick.text + pick.via.kind, pick);
    }
    for (const a of restPhrase.attributes) {
      const holders = p.names.filter((n) => n.phrase.attributes.includes(a));
      const pick = holders.find((n) => n.via.confirmed) ?? holders[0];
      if (pick) usedNames.set(pick.text + pick.via.kind, pick);
    }
    via.push(...[...usedNames.values()].map((n) => n.via));
    if (restPhrase.pack && p.pack) via.push(p.pack.via);
    for (const a of restPhrase.attributes) {
      const spellings = attributeSpellings(p, a);
      if (spellings.some((s) => s.toLowerCase() !== a)) {
        via.push({ kind: 'attribute', value: `${a} = ${[...new Set([a, ...spellings])].join(' = ')}`, confirmed: true });
      }
    }
    const confirmed = via.every((v) => v.confirmed);
    const label = productLabel(p);
    const routes = via.filter((v) => v.kind !== 'product_name' || codeVia.length === 0);
    const routeText = routes.length ? ` via ${routes.map(describeVia).join(', ')}` : '';
    const skus = ourSkus(p);
    candidates.push({
      product_id: p.product_id,
      product_name: p.product_name,
      label,
      our_skus: skus,
      supplier_items: p.identifiers
        .filter((i) => i.kind === 'supplier_item')
        .map((i) => ({ supplier_id: i.supplier_id!, supplier_name: i.supplier_name, value: i.value, superseded: i.superseded, confirmed: i.confirmed })),
      supplier_names: p.identifiers
        .filter((i) => i.kind === 'supplier_name')
        .map((i) => ({ supplier_id: i.supplier_id!, supplier_name: i.supplier_name, value: i.value, confirmed: i.confirmed })),
      pack: p.pack ? describePack(p.pack.pack) : null,
      matched_via: via,
      confirmed,
      conversion_note: d.conversion,
      explanation: `"${text}" → ${label}${routeText}${d.conversion ? ` (${d.conversion})` : ''}${confirmed ? '.' : ' — confirm the identifier before relying on it.'}`,
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => Number(b.confirmed) - Number(a.confirmed) || a.label.localeCompare(b.label));
  const ambiguous = candidates.length > 1;
  const message = ambiguous
    ? `"${text}" could mean ${candidates.length} products: ${candidates.map((c) => c.label).join('; ')}. Nothing is picked — each document is checked against each of them.`
    : candidates[0].explanation;
  return {
    resolution: { phrase: text, candidates, ambiguous, message },
    strong: codeTokens.length > 0 || !!restPhrase.pack,
  };
}

export function makeProductIdentityConstraint(
  id: string,
  resolved: SearchProductResolution,
  source: SearchConstraint['source'],
): SearchConstraint {
  const c = resolved.candidates;
  return {
    id,
    kind: 'product',
    label: resolved.ambiguous
      ? `product "${resolved.phrase}" (could mean ${c.length} products)`
      : `product ${c[0].label}`,
    raw: resolved.phrase,
    value: c.map((x) => x.product_id).join(','),
    fields: ['customer_item_number', 'product_code', 'product_name', 'pack'],
    source,
    note: resolved.message,
    product_resolution: resolved,
  };
}

// ===========================================================================
// Judging a document against a resolved product
// ===========================================================================

/** The subject fields this check reads (a structural subset of CoverageSubject). */
export interface ProductSubject {
  supplier_id?: string | null;
  supplier_name: string | null;
  supplier_aliases: string[];
  product_ids?: string[];
  product_names: string[];
  metadata: Record<string, unknown>;
  lots: Array<{ product_name?: string | null }>;
}

const OUTCOME_RANK: Record<SearchCheckOutcome, number> = {
  match: 9, likely: 8, multiple_values: 7, ambiguous: 6, near: 5, partial_lot: 4, role_mismatch: 3, unverified: 2, mismatch: 1, missing: 0,
};

function str(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  return null;
}

function words(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(inc|llc|co|corp|company|ltd|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

function sameSupplier(s: ProductSubject, supplierId: string, supplierName: string | null): boolean | null {
  if (s.supplier_id) return s.supplier_id === supplierId;
  const docNames = [s.supplier_name, ...s.supplier_aliases, str(s.metadata.supplier_name)].filter((x): x is string => !!x).map(words);
  if (docNames.length === 0 || !supplierName) return null;
  const want = words(supplierName);
  return docNames.some((n) => n && (n.includes(want) || want.includes(n)));
}

/**
 * The document's pack. A size in the product name wins; then a declared pack
 * field; then `net_weight` ONLY when it names a volume or a container — on a
 * Darigold certificate net_weight is the LOT's total ("2755.75 LB"), and
 * reading that as a pack would call every butter certificate the wrong pack.
 */
function subjectPack(s: ProductSubject, matchedName: string | null): Pack | null {
  const fromName = matchedName ? findPacks(matchedName).find((p) => p.quantity !== null) : undefined;
  if (fromName) return fromName;
  for (const k of ['package_size', 'pack_size', 'pack', 'container_size']) {
    const v = str(s.metadata[k]);
    const p = v ? (findPacks(v).find((x) => x.quantity !== null) ?? findPacks(v)[0]) : undefined;
    if (p) return p;
  }
  const nw = str(s.metadata.net_weight);
  if (nw) {
    const p = findPacks(nw).find((x) => x.unit === 'gal' || x.container !== null);
    if (p) return p;
  }
  return null;
}

function sameName(a: ProductPhrase, b: ProductPhrase): boolean {
  if (a.words.length === 0 || a.words.length !== b.words.length) return false;
  if (!a.words.every((w) => b.words.includes(w))) return false;
  return a.attributes.length === b.attributes.length && a.attributes.every((x) => b.attributes.includes(x));
}

function checkOneCandidate(k: SearchProductCandidate, catalogNames: NameEntry[], catalogPack: Pack | null, s: ProductSubject, cid: string): SearchConstraintCheck {
  const base = { constraint_id: cid, candidate_product_id: k.product_id } as const;
  const md = s.metadata;
  const unconfirmedResolution = !k.confirmed;
  const finish = (ch: SearchConstraintCheck, viaConfirmed = true): SearchConstraintCheck => {
    if (ch.outcome !== 'match') return ch;
    if (!unconfirmedResolution && viaConfirmed) return ch;
    const route = unconfirmedResolution
      ? k.matched_via.filter((v) => !v.confirmed).map(describeVia).join(', ')
      : 'an unconfirmed identifier';
    return { ...ch, outcome: 'likely', message: `${ch.message} Reached via ${route} — confirm before using this certificate.` };
  };

  const packNote = (docName: string | null): { ok: boolean; note: string } => {
    if (!catalogPack) return { ok: true, note: '' };
    const dp = subjectPack(s, docName);
    if (!dp) return { ok: true, note: '' };
    const cmp = comparePacks(catalogPack, dp);
    if (!cmp.equivalent) return { ok: false, note: ` Its pack is ${describePack(dp)}, not ${describePack(catalogPack)}.` };
    return { ok: true, note: cmp.conversion ? ` Its pack ${cmp.conversion}.` : '' };
  };

  // 1. The customer item number — OUR SKU, printed by the supplier.
  const customerItem = str(md.customer_item_number);
  let customerVerdict: SearchConstraintCheck | null = null;
  if (customerItem && k.our_skus.length > 0) {
    const hit = k.our_skus.find((sku) => normalizeCode(sku) === normalizeCode(customerItem));
    customerVerdict = hit
      ? { ...base, outcome: 'match', field: 'customer_item_number', field_label: 'customer item #', value: customerItem, provenance: 'extracted',
        message: `This certificate prints customer item # ${customerItem}, our SKU for ${k.label}.` }
      : { ...base, outcome: 'mismatch', field: 'customer_item_number', field_label: 'customer item #', value: customerItem, provenance: 'extracted',
        message: `This certificate prints customer item # ${customerItem}; ${k.product_name} is our SKU ${k.our_skus.join(' / ')}.` };
  }

  // 2. The supplier's item number.
  const supplierItem = str(md.product_code) ?? str(md.item_number) ?? str(md.supplier_item_number);
  if (supplierItem) {
    const items = k.supplier_items.filter((i) => sameSupplier(s, i.supplier_id, i.supplier_name) !== false);
    if (items.length > 0) {
      const hit = items.find((i) => normalizeCode(i.value) === normalizeCode(supplierItem));
      const who = hit?.supplier_name ?? items[0].supplier_name ?? s.supplier_name ?? 'supplier';
      if (hit) {
        const pn = packNote(str(md.product_name));
        const former = hit.superseded ? ` (${hit.value} is a former item number)` : '';
        const v: SearchConstraintCheck = pn.ok
          ? { ...base, outcome: 'match', field: 'product_code', field_label: 'supplier item #', value: supplierItem, provenance: 'extracted',
            message: `${who} item ${supplierItem} on this certificate is ${k.label}${former}.${pn.note}` }
          : { ...base, outcome: 'unverified', field: 'product_code', field_label: 'supplier item #', value: supplierItem, provenance: 'extracted',
            message: `${who} item ${supplierItem} on this certificate is ${k.label}, but${pn.note.replace(/^ Its/, ' its')} Check the certificate.` };
        if (customerVerdict && customerVerdict.outcome === 'mismatch') {
          return { ...v, outcome: 'unverified', message: `${v.message} ${customerVerdict.message} The two numbers disagree — check the certificate.` };
        }
        return finish(v, hit.confirmed);
      }
      const itemMismatch: SearchConstraintCheck = {
        ...base, outcome: 'mismatch', field: 'product_code', field_label: 'supplier item #', value: supplierItem, provenance: 'extracted',
        message: `This certificate is ${who} item ${supplierItem}, not item ${(items.some((i) => !i.superseded) ? items.filter((i) => !i.superseded) : items).map((i) => i.value).join(' / ')} — that is ${k.label}.`,
      };
      if (customerVerdict && customerVerdict.outcome === 'match') {
        return { ...itemMismatch, outcome: 'unverified', message: `${customerVerdict.message} ${itemMismatch.message} The two numbers disagree — check the certificate.` };
      }
      return itemMismatch;
    }
  }
  if (customerVerdict) return finish(customerVerdict);

  // 3. The product name, with the pack when this product is known by one.
  const docNames: Array<{ name: string; provenance: 'linked_record' | 'extracted' }> = [
    ...s.product_names.map((n) => ({ name: n, provenance: 'linked_record' as const })),
    ...(str(md.product_name) ? [{ name: str(md.product_name)!, provenance: 'extracted' as const }] : []),
    ...s.lots.map((l) => l.product_name).filter((n): n is string => !!n).map((n) => ({ name: n, provenance: 'linked_record' as const })),
  ];
  for (const dn of docNames) {
    const phrase = readProductPhrase(dn.name);
    const hitName = catalogNames.find((n) => sameName(n.phrase, phrase));
    if (!hitName) continue;
    const common = { ...base, field: 'product_name', field_label: 'product', value: dn.name, provenance: dn.provenance };
    if (catalogPack) {
      const dp = subjectPack(s, dn.name);
      if (!dp) {
        return { ...common, outcome: 'unverified',
          message: `Product on this document is ${dn.name}, but no pack is recorded, so it can't be confirmed as ${k.label} (${describePack(catalogPack)}).` };
      }
      const cmp = comparePacks(catalogPack, dp);
      if (!cmp.equivalent) {
        return { ...common, outcome: 'mismatch', message: `Product on this document is ${dn.name}, ${describePack(dp)} — not ${describePack(catalogPack)} (${k.label}).` };
      }
      return finish({ ...common, outcome: 'match',
        message: `Product on this document is ${dn.name}, ${describePack(dp)}: ${k.label}${cmp.conversion ? ` (${cmp.conversion})` : ''}.` }, hitName.via.confirmed);
    }
    return finish({ ...common, outcome: 'match', message: `Product on this document is ${dn.name}: ${k.label}.` }, hitName.via.confirmed);
  }

  // 4. Linked directly to the product itself.
  if (s.product_ids?.includes(k.product_id)) {
    return finish({ ...base, outcome: 'match', field: 'product', field_label: 'product', value: k.product_name, provenance: 'linked_record',
      message: `This document is linked to ${k.label}.` });
  }

  const shown = [
    supplierItem ? `${s.supplier_name ?? 'supplier'} item ${supplierItem}` : null,
    ...docNames.map((d) => d.name),
  ].filter(Boolean);
  if (shown.length === 0) {
    return { ...base, outcome: 'missing', field: 'product', field_label: 'product', value: null, provenance: null,
      message: 'No product is recorded on this document.' };
  }
  return { ...base, outcome: 'mismatch', field: 'product', field_label: 'product', value: String(shown[0]), provenance: 'extracted',
    message: `Product on this document is ${[...new Set(shown)].join(', ')}, not ${k.label}.` };
}

/**
 * Judge a subject against a resolved product constraint. With several
 * candidates the best outcome wins and names its candidate; the ambiguity is
 * the constraint's to report, not the document's to resolve.
 */
export function checkProductIdentity(c: SearchConstraint, s: ProductSubject): SearchConstraintCheck {
  const res = c.product_resolution!;
  let best: SearchConstraintCheck | null = null;
  for (const k of res.candidates) {
    const names: NameEntry[] = [
      { text: k.product_name, via: { kind: 'product_name', value: k.product_name, confirmed: true }, phrase: readProductPhrase(k.product_name) },
      ...k.supplier_names.map((n) => ({
        text: n.value,
        via: { kind: 'supplier_name' as const, value: n.value, confirmed: n.confirmed, supplier_name: n.supplier_name },
        phrase: readProductPhrase(n.value),
      })),
    ];
    const pack = k.pack ? (findPacks(k.pack).find((p) => p.quantity !== null) ?? findPacks(k.pack)[0] ?? null) : null;
    let ch = checkOneCandidate(k, names, pack, s, c.id);
    if (res.ambiguous && (ch.outcome === 'match' || ch.outcome === 'likely')) {
      ch = { ...ch, message: `As ${k.product_name}: ${ch.message}` };
    }
    if (!best || OUTCOME_RANK[ch.outcome] > OUTCOME_RANK[best.outcome]) best = ch;
  }
  if (best && res.ambiguous && OUTCOME_RANK[best.outcome] < OUTCOME_RANK.likely) {
    best = { ...best, candidate_product_id: null, message: `It is none of the ${res.candidates.length} products "${res.phrase}" could mean. ${best.message}` };
  }
  return best!;
}
