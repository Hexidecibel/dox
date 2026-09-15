/**
 * The supplier product bridge — which of OUR products a supplier's certificate
 * is, read from the product identifier graph (migration 0107).
 *
 * This replaced `supplier_product_map` (0075, retired by 0113). That table held
 * ONE product per supplier product NAME, and Country Morning prints "Cream -
 * Heavy Whipping 40%" on two different items: 30904 (a 300 gallon tote, our
 * 10286) and 50903 (a 5 gallon bag, our 0801). The map said 0801 for both, so a
 * tote certificate was offered to a bag order line at "lot and product agree".
 *
 * PRECEDENCE — the strongest evidence the certificate prints decides:
 *   1. NUMBERS. The supplier's item number (a `supplier_item` identifier for
 *      THIS supplier, a former number included and said to be former) and the
 *      customer item number (OUR SKU printed by the supplier, an `our_sku`
 *      identifier). When both are printed they must agree on a product; when
 *      they point at different products nothing is picked.
 *   2. NAME + PACK. A `supplier_name` identifier for this supplier that names the
 *      certificate's product, narrowed by the certificate's pack against each
 *      candidate's pack (shared/productVocabulary.ts, conversions said).
 *   3. NAME ALONE, only when that name belongs to exactly ONE of our products
 *      (and no pack printed on the certificate contradicts it).
 *
 * NEVER PICKS. A name that belongs to several products with nothing to tell
 * them apart yields NO product; the resolution carries the candidates and a
 * sentence saying so, and the matcher writes that sentence onto the suggestion.
 * An identifier nobody confirmed may still resolve a product, and every
 * resolution through one says "via unconfirmed identifier ...".
 *
 * Pure; no I/O. The catalog is loaded by functions/lib/product-identifiers.ts
 * (`loadProductCatalog`), the same one search uses.
 */

import {
  describeVia,
  documentCustomerItem,
  documentPack,
  documentSupplierItem,
  productLabel,
  sameName,
  viaOf,
  type CatalogIdentifier,
  type PreparedCatalog,
  type PreparedProduct,
} from './productIdentity';
import { normalizeProductNameKey } from './lotNormalize';
import type { ProductBridgeResolution } from './types';
import { comparePacks, describePack, normalizeCode, readProductPhrase, type Pack } from './productVocabulary';

export type BridgeResolution = ProductBridgeResolution;
export type BridgeRoute = NonNullable<ProductBridgeResolution['route']>;

/** What a certificate says about its own product. */
export interface BridgeEvidence {
  supplier_id: string | null;
  supplier_item: string | null;
  customer_item_number: string | null;
  product_name: string | null;
  pack: Pack | null;
}

const NONE: BridgeResolution = {
  product_id: null, product_label: null, route: null, confirmed: false, our_skus: [], candidates: [], note: null,
};

/**
 * Read a certificate's product evidence from its metadata (primary_metadata
 * over extended_metadata), with an explicit product name preferred when the
 * caller holds one (a record's own name on a split certificate).
 */
export function bridgeEvidenceFromMetadata(
  metadata: Record<string, unknown>,
  opts: { supplierId: string | null; productName?: string | null },
): BridgeEvidence {
  const mdName = typeof metadata.product_name === 'string' && metadata.product_name.trim() ? metadata.product_name.trim() : null;
  const productName = opts.productName?.trim() || mdName;
  return {
    supplier_id: opts.supplierId,
    supplier_item: documentSupplierItem(metadata),
    customer_item_number: documentCustomerItem(metadata),
    product_name: productName,
    pack: documentPack(metadata, productName),
  };
}

/** Two product names are the same name: same words/attributes, or the same 0075 key. */
export function namesAgree(a: string, b: string): boolean {
  const ka = normalizeProductNameKey(a);
  if (ka && ka === normalizeProductNameKey(b)) return true;
  return sameName(readProductPhrase(a), readProductPhrase(b));
}

function skusOf(p: PreparedProduct): string[] {
  return p.identifiers.filter((i) => i.kind === 'our_sku').map((i) => i.value);
}

function resolved(
  p: PreparedProduct,
  route: BridgeRoute,
  via: CatalogIdentifier[],
  extraNote: string | null = null,
): BridgeResolution {
  const unconfirmed = via.filter((i) => !i.confirmed);
  const confirmed = unconfirmed.length === 0;
  const notes = [
    extraNote,
    confirmed ? null : `${productLabel(p)} via unconfirmed identifier ${unconfirmed.map((i) => describeVia({ ...viaOf(i), confirmed: true })).join(', ')} — confirm it before relying on this match.`,
  ].filter((x): x is string => !!x);
  return {
    product_id: p.product_id,
    product_label: productLabel(p),
    route,
    confirmed,
    our_skus: skusOf(p),
    candidates: [],
    note: notes.length ? notes.join(' ') : null,
  };
}

function unresolved(candidates: PreparedProduct[], note: string): BridgeResolution {
  return { ...NONE, candidates: candidates.map((p) => ({ product_id: p.product_id, label: productLabel(p) })), note };
}

function listLabels(ps: PreparedProduct[]): string {
  return ps.map(productLabel).join('; ');
}

/** Distinct products holding a code, restricted by a predicate on the identifier. */
function codeHits(
  catalog: PreparedCatalog,
  code: string | null,
  keep: (i: CatalogIdentifier) => boolean,
): Map<string, { product: PreparedProduct; identifiers: CatalogIdentifier[] }> {
  const out = new Map<string, { product: PreparedProduct; identifiers: CatalogIdentifier[] }>();
  if (!code) return out;
  for (const h of catalog.codes.get(normalizeCode(code)) ?? []) {
    if (!keep(h.identifier)) continue;
    const e = out.get(h.product.product_id) ?? { product: h.product, identifiers: [] };
    e.identifiers.push(h.identifier);
    out.set(h.product.product_id, e);
  }
  return out;
}

/**
 * Resolve a certificate to one of our products, or say why not. A null catalog
 * (the tenant holds no identifiers) resolves nothing and says nothing.
 */
export function resolveSupplierProduct(catalog: PreparedCatalog | null, e: BridgeEvidence): BridgeResolution {
  if (!catalog || catalog.products.length === 0) return NONE;
  const supplierName = (p: PreparedProduct) =>
    p.identifiers.find((i) => i.supplier_id === e.supplier_id && i.supplier_name)?.supplier_name ?? 'this supplier';

  // 1. Numbers.
  const bySupplierItem = e.supplier_id
    ? codeHits(catalog, e.supplier_item, (i) => i.kind === 'supplier_item' && i.supplier_id === e.supplier_id)
    : codeHits(catalog, null, () => false);
  const byCustomerItem = codeHits(catalog, e.customer_item_number, (i) => i.kind === 'our_sku');

  let pool: PreparedProduct[] | null = null;
  if (bySupplierItem.size > 0 && byCustomerItem.size > 0) {
    const both = [...bySupplierItem.keys()].filter((id) => byCustomerItem.has(id));
    if (both.length === 0) {
      const a = [...bySupplierItem.values()].map((x) => x.product);
      const b = [...byCustomerItem.values()].map((x) => x.product);
      return unresolved([...a, ...b],
        `The certificate's item ${e.supplier_item} is ${listLabels(a)}, but its customer item # ${e.customer_item_number} is ${listLabels(b)} — the two numbers disagree, so no product is assumed.`);
    }
    if (both.length === 1) {
      const id = both[0];
      return resolved(bySupplierItem.get(id)!.product, 'supplier_item',
        [...bySupplierItem.get(id)!.identifiers, ...byCustomerItem.get(id)!.identifiers]);
    }
    pool = both.map((id) => bySupplierItem.get(id)!.product);
  } else if (bySupplierItem.size > 0 || byCustomerItem.size > 0) {
    const hits = bySupplierItem.size > 0 ? bySupplierItem : byCustomerItem;
    const route: BridgeRoute = bySupplierItem.size > 0 ? 'supplier_item' : 'customer_item';
    if (hits.size === 1) {
      const [only] = [...hits.values()];
      const former = only.identifiers.some((i) => i.superseded)
        ? `${e.supplier_item} is a former item number of ${productLabel(only.product)}.`
        : null;
      return resolved(only.product, route, only.identifiers, former);
    }
    pool = [...hits.values()].map((x) => x.product);
  }

  // 2 + 3. Names, within whatever the numbers left open.
  const candidates = (pool ?? catalog.products).filter((p) =>
    !!e.supplier_id && !!e.product_name &&
    p.identifiers.some((i) => i.kind === 'supplier_name' && i.supplier_id === e.supplier_id && namesAgree(i.value, e.product_name!)));
  const nameVia = (p: PreparedProduct): CatalogIdentifier[] => {
    const ids = p.identifiers.filter((i) => i.kind === 'supplier_name' && i.supplier_id === e.supplier_id && namesAgree(i.value, e.product_name!));
    return ids.some((i) => i.confirmed) ? [ids.find((i) => i.confirmed)!] : ids.slice(0, 1);
  };

  if (candidates.length === 0) {
    if (pool) {
      const number = bySupplierItem.size > 0 ? `item ${e.supplier_item}` : `customer item # ${e.customer_item_number}`;
      return unresolved(pool, `The certificate's ${number} belongs to ${pool.length} of our products (${listLabels(pool)}); nothing else on it tells them apart, so no product is assumed.`);
    }
    return NONE;
  }

  const who = supplierName(candidates[0]);
  const named = `"${e.product_name}"`;
  if (e.pack) {
    const fits: Array<{ p: PreparedProduct; conversion: string | null }> = [];
    const unknown: PreparedProduct[] = [];
    const contradicted: Array<{ p: PreparedProduct; pack: string }> = [];
    for (const p of candidates) {
      if (!p.pack) { unknown.push(p); continue; }
      const cmp = comparePacks(e.pack, p.pack.pack);
      if (cmp.equivalent) fits.push({ p, conversion: cmp.conversion });
      else contradicted.push({ p, pack: describePack(p.pack.pack) });
    }
    if (fits.length === 1 && unknown.length === 0) {
      const { p, conversion } = fits[0];
      const packVia = p.pack!.via.kind === 'pack'
        ? p.identifiers.filter((i) => i.kind === 'pack' && i.value === p.pack!.via.value)
        : [];
      const narrowed = candidates.length > 1
        ? `${who} uses ${named} for ${candidates.length} of our products; the certificate's pack ${describePack(e.pack)} makes it ${productLabel(p)}${conversion ? ` (${conversion})` : ''}.`
        : conversion ? `Pack ${conversion}.` : null;
      return resolved(p, 'name_pack', [...nameVia(p), ...packVia], narrowed);
    }
    if (fits.length === 0 && unknown.length === 1) {
      const p = unknown[0];
      return resolved(p, 'name', nameVia(p),
        contradicted.length ? `The certificate's pack ${describePack(e.pack)} rules out ${contradicted.map((c) => c.p.product_name).join(', ')}; ${p.product_name} has no pack on file to check.` : `${p.product_name} has no pack on file, so the certificate's pack ${describePack(e.pack)} could not be checked.`);
    }
    if (fits.length + unknown.length === 0) {
      return unresolved(candidates,
        candidates.length === 1
          ? `${who} calls ${productLabel(candidates[0])} ${named}, but this certificate's pack is ${describePack(e.pack)}, not ${contradicted[0].pack}; no product is assumed.`
          : `${who} uses ${named} for ${candidates.length} of our products (${listLabels(candidates)}), and this certificate's pack ${describePack(e.pack)} is none of theirs; no product is assumed.`);
    }
    const open = [...fits.map((f) => f.p), ...unknown];
    return unresolved(open,
      `${who} uses ${named} for ${open.length} of our products (${listLabels(open)}), and the certificate's pack ${describePack(e.pack)} does not tell them apart; no product is assumed.`);
  }

  if (candidates.length === 1) {
    return resolved(candidates[0], 'name', nameVia(candidates[0]));
  }
  return unresolved(candidates,
    `${who} uses ${named} for ${candidates.length} of our products (${listLabels(candidates)}); no item number or pack on the certificate tells them apart, so no product is assumed.`);
}
