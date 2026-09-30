/**
 * The search golden corpus: a synthetic tenant with the SHAPES of the real one
 * (invented values), seeded through the writers the app uses so lot keys,
 * production-date provenance, search keys and FTS rows come out exactly the
 * way approval produces them in prod.
 *
 *   findOrCreateLot           lot_key under the supplier's DECLARED format (0110),
 *                             a stated production date, or the labelled
 *                             lot-code fallback ('lot_decode')
 *   legacyCodeDateAsProduction  the older-extraction code date read as a
 *                             production date ('extracted_code_date_legacy')
 *   declareLotScheme          the supplier's lot format
 *   insertProductIdentifier   what a product goes by (0107)
 *   rebuildDocumentKeys       document_search_keys (0122)
 *   FTS triggers              documents_fts (0054), synchronous
 *
 * Read by tests/api/search-golden.test.ts (the case table),
 * tests/api/search-examples.test.ts and tests/api/search-eval-golden.test.ts
 * (the bin/eval-search probes run against this corpus when no --url is given).
 * See README.md in this folder for how to add a case.
 */

import { findOrCreateLot } from '../../../functions/lib/entities/lots';
import { declareLotScheme, loadResolvedLotScheme } from '../../../functions/lib/lot-schemes';
import { insertProductIdentifier, validateIdentifierInput } from '../../../functions/lib/product-identifiers';
import { rebuildDocumentKeys } from '../../../functions/lib/search/keys';
import { LOT_SCHEME_TEMPLATES } from '../../../shared/lotScheme';
import { legacyCodeDateAsProduction, resolveProductionDate } from '../../../shared/lotProductionDate';

export const GOLDEN_TENANT = 'golden-tenant';
export const GOLDEN_OTHER_TENANT = 'golden-other';
export const GOLDEN_USER = { id: 'golden-user', role: 'org_admin', tenant_id: GOLDEN_TENANT, email: 'golden@test.com', name: 'Golden' };
export const GOLDEN_OTHER_USER = { id: 'golden-other-user', role: 'org_admin', tenant_id: GOLDEN_OTHER_TENANT, email: 'golden-other@test.com', name: 'Other' };
export const GOLDEN_SUPER = { id: 'golden-super', role: 'super_admin', tenant_id: null, email: 'golden-super@test.com', name: 'Super' };
export const GOLDEN_READER = { id: 'golden-reader', role: 'reader', tenant_id: GOLDEN_TENANT, email: 'golden-reader@test.com', name: 'Reader' };

// ---------------------------------------------------------------------------
// Suppliers, types, products
// ---------------------------------------------------------------------------

export const SUP = {
  /** Darigold-like: plant(3) · YY · Julian day + 2-digit sublot, production role. */
  cascade: 'g-sup-cascade',
  /** Country-Morning-like: best-by MMDDYY + product suffix. */
  valley: 'g-sup-valley',
  /** No declared format. */
  hollow: 'g-sup-hollow',
  /** No declared format; older extractions filed production dates as code dates. */
  riverside: 'g-sup-riverside',
} as const;

export const SUPPLIER_NAMES: Record<string, string> = {
  [SUP.cascade]: 'Cascade Creamery Cooperative',
  [SUP.valley]: 'Valley Morning Dairy',
  [SUP.hollow]: 'North Hollow Creamery',
  [SUP.riverside]: 'Riverside Egg Farms',
};

export const DT = {
  coa: 'g-dt-coa',
  spec: 'g-dt-spec',
  coi: 'g-dt-coi',
  kosher: 'g-dt-kosher',
  sqf: 'g-dt-sqf',
  invoice: 'g-dt-invoice',
} as const;

const TYPE_ROWS: Array<[string, string, string]> = [
  [DT.coa, 'Certificate of Analysis', 'coa'],
  [DT.spec, 'Specification Sheet', 'spec-sheet'],
  [DT.coi, 'Certificate of Insurance', 'certificate-of-insurance'],
  [DT.kosher, 'Kosher Certificate', 'kosher-certificate'],
  [DT.sqf, 'SQF Certificate', 'sqf-certificate'],
  [DT.invoice, 'Invoice', 'invoice'],
];

export const P = {
  butterUnsalted: 'g-p-4417',
  butterSalted: 'g-p-4418',
  creamTote: 'g-p-10386',
  whipBag: 'g-p-0901',
  milkTote: 'g-p-10384',
  sourCream: 'g-p-0919',
  egg: 'g-p-1167',
} as const;

interface ProductSeed {
  id: string;
  name: string;
  idents: Array<{ kind: 'our_sku' | 'supplier_item' | 'supplier_name' | 'alias' | 'pack'; value: string; supplier?: string }>;
}

export const PRODUCTS: ProductSeed[] = [
  {
    id: P.butterUnsalted, name: 'BTR BULK U/S 25KG',
    idents: [
      { kind: 'our_sku', value: '4417' },
      { kind: 'supplier_item', value: '820004', supplier: SUP.cascade },
      { kind: 'supplier_name', value: 'SWEET CREAM BUTTER - Unsalted 25kg', supplier: SUP.cascade },
      { kind: 'alias', value: 'unsalted butter' },
    ],
  },
  {
    id: P.butterSalted, name: 'BTR BULK SALTED 25KG',
    idents: [
      { kind: 'our_sku', value: '4418' },
      { kind: 'supplier_item', value: '820001', supplier: SUP.cascade },
      { kind: 'supplier_name', value: 'SWEET CREAM BUTTER - Salted 25kg', supplier: SUP.cascade },
      { kind: 'alias', value: 'salted butter' },
    ],
  },
  {
    // The ambiguous pair: one supplier name on two of our products (tote vs bag).
    id: P.creamTote, name: '40% CREAM 300GL',
    idents: [
      { kind: 'our_sku', value: '10386' },
      { kind: 'supplier_item', value: '31904', supplier: SUP.valley },
      { kind: 'supplier_name', value: 'Cream - Heavy Whipping 40%', supplier: SUP.valley },
      { kind: 'pack', value: '300 Gallon Tote' },
    ],
  },
  {
    id: P.whipBag, name: 'WHIP 5 GL BAG',
    idents: [
      { kind: 'our_sku', value: '0901' },
      { kind: 'supplier_item', value: '51903', supplier: SUP.valley },
      { kind: 'supplier_name', value: 'Cream - Heavy Whipping 40%', supplier: SUP.valley },
      { kind: 'pack', value: '5 Gallon Bag' },
    ],
  },
  {
    id: P.milkTote, name: 'MS WHOLE 300GL',
    idents: [
      { kind: 'our_sku', value: '10384' },
      { kind: 'supplier_item', value: '31906', supplier: SUP.valley },
      { kind: 'supplier_name', value: 'Milk - Whole', supplier: SUP.valley },
      { kind: 'pack', value: '300 Gallon Tote' },
    ],
  },
  {
    id: P.sourCream, name: 'SOUR CREAM 5#',
    idents: [
      { kind: 'our_sku', value: '0919' },
      { kind: 'alias', value: 'sour cream' },
    ],
  },
  {
    id: P.egg, name: 'CF LIQ WHOLE EGG 2-20#',
    idents: [
      { kind: 'our_sku', value: '1167' },
      { kind: 'supplier_name', value: 'Cage Free Liquid Whole Egg', supplier: SUP.riverside },
      { kind: 'alias', value: 'liquid egg' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export interface GoldenLot {
  lot: string;
  sub?: string;
  /** A stated production date on this row (ISO). */
  production?: string;
  /** An older extraction's code date, printed under a production label: legacy. */
  legacyCodeDate?: string;
}

export interface GoldenDoc {
  id: string;
  tenant?: string;
  supplier: string;
  type: string;
  title: string;
  product?: string;
  metadata: Record<string, unknown>;
  text: string;
  lots?: GoldenLot[];
  created_at?: string;
}

export const DOC = {
  // Cascade (declared plant · YY · Julian + sublot)
  cascadeMulti: 'g-doc-cascade-multi', // 20726107-03/-04 (Apr 17) + 20726108-01 (Apr 18)
  cascadeMay1: 'g-doc-cascade-may1', // 20726121-02, May 1 — the pending WMS suggestion
  cascadeSalted: 'g-doc-cascade-salted', // 20726107-09 salted, Apr 17
  cascadeDecoded: 'g-doc-cascade-decoded', // 20726152-01, no stated date -> decoded Jun 1
  cascadeSplit01: 'g-doc-cascade-split-01', // 20726135-01, May 15 (page-scoped sublot doc)
  cascadeSplit02: 'g-doc-cascade-split-02', // 20726135-02, May 15
  cascadeSpec: 'g-doc-cascade-spec',
  cascadeSqf: 'g-doc-cascade-sqf',
  cascadeCoi: 'g-doc-cascade-coi',
  // Valley Morning (declared best-by MMDDYY + suffix)
  valleyCreamTote: 'g-doc-valley-cream-tote', // 061526HCR, produced May 26
  valleyWhipBag: 'g-doc-valley-whip-bag', // 062026HCR, produced May 29
  valleyMilkTote: 'g-doc-valley-milk-tote', // 060826WHO, produced May 28
  valleyCodeDate: 'g-doc-valley-code-date', // code date Jul 10, no production date
  valleyBestBy: 'g-doc-valley-best-by', // best-by Jul 20
  valleyInvoice: 'g-doc-valley-invoice', // invoice 263518
  valleyKosher: 'g-doc-valley-kosher',
  valleyCoi: 'g-doc-valley-coi',
  // North Hollow (no declared format)
  hollowSourA: 'g-doc-hollow-sour-a', // K349, Mar 12
  hollowSourB: 'g-doc-hollow-sour-b', // K361, Mar 24
  hollowSpec: 'g-doc-hollow-spec',
  hollowSqf: 'g-doc-hollow-sqf',
  // Riverside (legacy code-date production dates)
  riversideEggLegacy: 'g-doc-riverside-egg-legacy', // 5093, legacy Apr 3
  riversideEggStated: 'g-doc-riverside-egg-stated', // 5099, stated Apr 9
  riversideSpec: 'g-doc-riverside-spec',
  riversideCoi: 'g-doc-riverside-coi',
  // The second tenant: the SAME lot and PO as cascadeMulti
  otherTwin: 'g-doc-other-twin',
} as const;

const butterText = (item: string, extra: string) =>
  `CASCADE CREAMERY COOPERATIVE CERTIFICATE OF ANALYSIS SWEET CREAM BUTTER Item Number ${item} ${extra}`;

export const DOCUMENTS: GoldenDoc[] = [
  {
    id: DOC.cascadeMulti, supplier: SUP.cascade, type: DT.coa, product: P.butterUnsalted,
    title: 'COA Cascade Butter K 145273',
    metadata: { supplier_name: 'Cascade Creamery Cooperative', product_name: 'SWEET CREAM BUTTER - Unsalted 25kg', product_code: '820004', po_number: 'K 145273' },
    text: butterText('820004', 'Unsalted 25kg PO K 145273 Lot 20726107 Sub Lot 03 Production Date 17-Apr-2026 Lot 20726107 Sub Lot 04 Production Date 17-Apr-2026 Lot 20726108 Sub Lot 01 Production Date 18-Apr-2026 Moisture 15.9%'),
    lots: [
      { lot: '20726107', sub: '03', production: '2026-04-17' },
      { lot: '20726107', sub: '04', production: '2026-04-17' },
      { lot: '20726108', sub: '01', production: '2026-04-18' },
    ],
  },
  {
    id: DOC.cascadeMay1, supplier: SUP.cascade, type: DT.coa, product: P.butterUnsalted,
    title: 'COA Cascade Butter K145390',
    metadata: { supplier_name: 'Cascade Creamery Cooperative', product_name: 'SWEET CREAM BUTTER - Unsalted 25kg', product_code: '820004', po_number: 'K145390', lot_number: '20726121', sub_lot_code: '02', production_date: '2026-05-01' },
    text: butterText('820004', 'Unsalted 25kg PO K145390 Lot 20726121 Sub Lot 02 Production Date 01-May-2026'),
    lots: [{ lot: '20726121', sub: '02', production: '2026-05-01' }],
  },
  {
    id: DOC.cascadeSalted, supplier: SUP.cascade, type: DT.coa, product: P.butterSalted,
    title: 'COA Cascade Salted Butter K145274',
    metadata: { supplier_name: 'Cascade Creamery Cooperative', product_name: 'SWEET CREAM BUTTER - Salted 25kg', product_code: '820001', po_number: 'K145274', lot_number: '20726107', sub_lot_code: '09', production_date: '2026-04-17' },
    text: butterText('820001', 'Salted 25kg PO K145274 Lot 20726107 Sub Lot 09 Production Date 17-Apr-2026 Salt 1.6%'),
    lots: [{ lot: '20726107', sub: '09', production: '2026-04-17' }],
  },
  {
    id: DOC.cascadeDecoded, supplier: SUP.cascade, type: DT.coa, product: P.butterUnsalted,
    title: 'COA Cascade Butter lot 20726152',
    metadata: { supplier_name: 'Cascade Creamery Cooperative', product_name: 'SWEET CREAM BUTTER - Unsalted 25kg', product_code: '820004', lot_number: '20726152', sub_lot_code: '01' },
    text: butterText('820004', 'Unsalted 25kg Lot 20726152 Sub Lot 01'),
    lots: [{ lot: '20726152', sub: '01' }],
  },
  {
    id: DOC.cascadeSplit01, supplier: SUP.cascade, type: DT.coa, product: P.butterUnsalted,
    title: 'COA Cascade Butter 20726135-01',
    metadata: { supplier_name: 'Cascade Creamery Cooperative', product_name: 'SWEET CREAM BUTTER - Unsalted 25kg', product_code: '820004', lot_number: '20726135', sub_lot_code: '01', production_date: '2026-05-15' },
    text: butterText('820004', 'Unsalted 25kg Lot 20726135 Sub Lot 01 Production Date 15-May-2026'),
    lots: [{ lot: '20726135', sub: '01', production: '2026-05-15' }],
  },
  {
    id: DOC.cascadeSplit02, supplier: SUP.cascade, type: DT.coa, product: P.butterUnsalted,
    title: 'COA Cascade Butter 20726135-02',
    metadata: { supplier_name: 'Cascade Creamery Cooperative', product_name: 'SWEET CREAM BUTTER - Unsalted 25kg', product_code: '820004', lot_number: '20726135', sub_lot_code: '02', production_date: '2026-05-15' },
    text: butterText('820004', 'Unsalted 25kg Lot 20726135 Sub Lot 02 Production Date 15-May-2026'),
    lots: [{ lot: '20726135', sub: '02', production: '2026-05-15' }],
  },
  {
    id: DOC.cascadeSpec, supplier: SUP.cascade, type: DT.spec, product: P.butterUnsalted,
    title: 'Cascade Unsalted Butter Specification',
    metadata: { supplier_name: 'Cascade Creamery Cooperative', product_name: 'SWEET CREAM BUTTER - Unsalted 25kg', document_number: 'SS-820004-R3', shelf_life: '12 months frozen' },
    text: 'CASCADE CREAMERY COOPERATIVE PRODUCT SPECIFICATION Document SS-820004-R3 SWEET CREAM BUTTER Unsalted Shelf life 12 months frozen',
  },
  {
    id: DOC.cascadeSqf, supplier: SUP.cascade, type: DT.sqf,
    title: 'Cascade SQF Certificate 2026',
    metadata: { supplier_name: 'Cascade Creamery Cooperative', certificate_number: 'SQF-C-778812', document_expires_on: '2027-03-31' },
    text: 'SQF Food Safety Code Certificate of Registration Cascade Creamery Cooperative Certificate SQF-C-778812 valid until 31 March 2027',
  },
  {
    id: DOC.cascadeCoi, supplier: SUP.cascade, type: DT.coi,
    title: 'Cascade Certificate of Insurance',
    metadata: { supplier_name: 'Cascade Creamery Cooperative', document_expires_on: '2027-01-01' },
    text: 'CERTIFICATE OF LIABILITY INSURANCE Insured Cascade Creamery Cooperative General Liability',
  },
  {
    id: DOC.valleyCreamTote, supplier: SUP.valley, type: DT.coa, product: P.creamTote,
    title: 'Valley Morning Cream Tote COA',
    metadata: { supplier_name: 'Valley Morning Dairy', product_name: 'Cream - Heavy Whipping 40%', product_code: '31904', customer_item_number: '10386', net_weight: '300 Gallon Tote', po_number: 'K145501', lot_number: '061526HCR', production_date: '2026-05-26' },
    text: 'VALLEY MORNING DAIRY PRODUCT NAME: Cream - Heavy Whipping 40% ITEM #: 31904 CUSTOMER ITEM #: 10386 PACKAGE SIZE: 300 Gallon Tote PO K145501 LOT 061526HCR Production Date 05/26/2026',
    lots: [{ lot: '061526HCR', production: '2026-05-26' }],
  },
  {
    id: DOC.valleyWhipBag, supplier: SUP.valley, type: DT.coa, product: P.whipBag,
    title: 'Valley Morning Whip Bag COA',
    metadata: { supplier_name: 'Valley Morning Dairy', product_name: 'Cream - Heavy Whipping 40%', product_code: '51903', net_weight: '5 Gallon Bag', lot_number: '062026HCR', production_date: '2026-05-29' },
    text: 'VALLEY MORNING DAIRY PRODUCT NAME: Cream - Heavy Whipping 40% ITEM #: 51903 PACKAGE SIZE: 5 Gallon Bag LOT 062026HCR Production Date 05/29/2026',
    lots: [{ lot: '062026HCR', production: '2026-05-29' }],
  },
  {
    id: DOC.valleyMilkTote, supplier: SUP.valley, type: DT.coa, product: P.milkTote,
    title: 'Valley Morning Whole Milk Tote COA',
    metadata: { supplier_name: 'Valley Morning Dairy', product_name: 'Milk - Whole', product_code: '31906', customer_item_number: '10384', net_weight: '300 Gallon Tote', lot_number: '060826WHO', production_date: '2026-05-28' },
    text: 'VALLEY MORNING DAIRY PRODUCT NAME: Milk - Whole ITEM #: 31906 CUSTOMER ITEM #: 10384 PACKAGE SIZE: 300 Gallon Tote LOT 060826WHO Production Date 05/28/2026',
    lots: [{ lot: '060826WHO', production: '2026-05-28' }],
  },
  {
    id: DOC.valleyCodeDate, supplier: SUP.valley, type: DT.coa, product: P.milkTote,
    title: 'Valley Morning Milk code date COA',
    metadata: { supplier_name: 'Valley Morning Dairy', product_name: 'Milk - Whole', product_code: '31906', code_date: '2026-07-10' },
    text: 'VALLEY MORNING DAIRY PRODUCT NAME: Milk - Whole ITEM #: 31906 Code Date 07/10/2026',
  },
  {
    id: DOC.valleyBestBy, supplier: SUP.valley, type: DT.coa, product: P.creamTote,
    title: 'Valley Morning Cream best-by COA',
    metadata: { supplier_name: 'Valley Morning Dairy', product_name: 'Cream - Heavy Whipping 40%', product_code: '31904', best_by: '2026-07-20' },
    text: 'VALLEY MORNING DAIRY PRODUCT NAME: Cream - Heavy Whipping 40% ITEM #: 31904 Best By 07/20/2026',
  },
  {
    id: DOC.valleyInvoice, supplier: SUP.valley, type: DT.invoice,
    title: 'Valley Morning Invoice 263518',
    metadata: { supplier_name: 'Valley Morning Dairy', invoice_number: '263518' },
    text: 'VALLEY MORNING DAIRY INVOICE 263518 Cream - Heavy Whipping 40% 300 Gallon Tote',
  },
  {
    id: DOC.valleyKosher, supplier: SUP.valley, type: DT.kosher,
    title: 'Valley Morning Kosher Letter',
    metadata: { supplier_name: 'Valley Morning Dairy', certificate_number: 'OU-K-55120', document_expires_on: '2027-06-30' },
    text: 'ORTHODOX UNION KOSHER CERTIFICATION Valley Morning Dairy Certificate OU-K-55120',
  },
  {
    id: DOC.valleyCoi, supplier: SUP.valley, type: DT.coi,
    title: 'Valley Morning Certificate of Insurance',
    metadata: { supplier_name: 'Valley Morning Dairy', document_expires_on: '2027-02-01' },
    text: 'CERTIFICATE OF LIABILITY INSURANCE Insured Valley Morning Dairy',
  },
  {
    id: DOC.hollowSourA, supplier: SUP.hollow, type: DT.coa, product: P.sourCream,
    title: 'North Hollow Sour Cream K349',
    metadata: { supplier_name: 'North Hollow Creamery', product_name: 'Cultured Sour Cream', po_number: 'k145612', lot_number: 'K349', production_date: '2026-03-12' },
    text: 'NORTH HOLLOW CREAMERY Cultured Sour Cream 5# LOT K349 PO k145612 Production Date 03/12/2026',
    lots: [{ lot: 'K349', production: '2026-03-12' }],
  },
  {
    id: DOC.hollowSourB, supplier: SUP.hollow, type: DT.coa, product: P.sourCream,
    title: 'North Hollow Sour Cream K361',
    metadata: { supplier_name: 'North Hollow Creamery', product_name: 'Cultured Sour Cream', lot_number: 'K361', production_date: '2026-03-24' },
    text: 'NORTH HOLLOW CREAMERY Cultured Sour Cream 5# LOT K361 Production Date 03/24/2026',
    lots: [{ lot: 'K361', production: '2026-03-24' }],
  },
  {
    id: DOC.hollowSpec, supplier: SUP.hollow, type: DT.spec, product: P.sourCream,
    title: 'North Hollow Sour Cream Specification',
    metadata: { supplier_name: 'North Hollow Creamery', product_name: 'Cultured Sour Cream', document_number: 'NH-SP-0919' },
    text: 'NORTH HOLLOW CREAMERY SPECIFICATION NH-SP-0919 Cultured Sour Cream',
  },
  {
    id: DOC.hollowSqf, supplier: SUP.hollow, type: DT.sqf,
    title: 'North Hollow SQF Certificate',
    metadata: { supplier_name: 'North Hollow Creamery', certificate_number: 'SQF-C-640021', document_expires_on: '2026-12-15' },
    text: 'SQF Certificate of Registration North Hollow Creamery Certificate SQF-C-640021',
  },
  {
    id: DOC.riversideEggLegacy, supplier: SUP.riverside, type: DT.coa, product: P.egg,
    title: 'Riverside Liquid Egg lot 5093',
    metadata: { supplier_name: 'Riverside Egg Farms', product_name: 'Cage Free Liquid Whole Egg', lot_number: '5093', code_date: '2026-04-03' },
    text: 'RIVERSIDE EGG FARMS Cage Free Liquid Whole Egg 2/20 LB LOT 5093 Production Date: 04/03/2026 Salmonella Negative',
    lots: [{ lot: '5093', legacyCodeDate: '2026-04-03' }],
  },
  {
    id: DOC.riversideEggStated, supplier: SUP.riverside, type: DT.coa, product: P.egg,
    title: 'Riverside Liquid Egg lot 5099',
    metadata: { supplier_name: 'Riverside Egg Farms', product_name: 'Cage Free Liquid Whole Egg', lot_number: '5099', production_date: '2026-04-09' },
    text: 'RIVERSIDE EGG FARMS Cage Free Liquid Whole Egg 2/20 LB LOT 5099 Production Date: 04/09/2026',
    lots: [{ lot: '5099', production: '2026-04-09' }],
  },
  {
    id: DOC.riversideSpec, supplier: SUP.riverside, type: DT.spec, product: P.egg,
    title: 'Riverside Liquid Egg Specification',
    metadata: { supplier_name: 'Riverside Egg Farms', product_name: 'Cage Free Liquid Whole Egg', document_number: 'RV-SPEC-1167' },
    text: 'RIVERSIDE EGG FARMS PRODUCT SPECIFICATION RV-SPEC-1167 Cage Free Liquid Whole Egg',
  },
  {
    id: DOC.riversideCoi, supplier: SUP.riverside, type: DT.coi,
    title: 'Riverside Certificate of Insurance',
    metadata: { supplier_name: 'Riverside Egg Farms', document_expires_on: '2026-11-30' },
    text: 'CERTIFICATE OF LIABILITY INSURANCE Insured Riverside Egg Farms',
  },
  {
    id: DOC.otherTwin, tenant: GOLDEN_OTHER_TENANT, supplier: 'g-other-sup', type: 'g-other-dt-coa', product: undefined,
    title: 'COA Other Tenant Butter K 145273',
    metadata: { supplier_name: 'Cascade Creamery Cooperative', product_name: 'SWEET CREAM BUTTER', po_number: 'K 145273', lot_number: '20726107', sub_lot_code: '03', production_date: '2026-04-17' },
    text: 'CASCADE CREAMERY COOPERATIVE SWEET CREAM BUTTER PO K 145273 Lot 20726107 Sub Lot 03 Production Date 17-Apr-2026',
    lots: [{ lot: '20726107', sub: '03', production: '2026-04-17' }],
  },
];

// ---------------------------------------------------------------------------
// WMS orders and the Review Queue
// ---------------------------------------------------------------------------

export const ORDERS = {
  /** Customer PO PO-90001: line lot 2072610703, a person ACCEPTED the cascadeMulti certificate. */
  accepted: { id: 'g-order-accepted', number: '1809921', po: 'PO-90001', lot: '2072610703', doc: DOC.cascadeMulti, status: 'accepted' as const },
  /**
   * Customer PO PO-90002: the line shipped lot 2072612199, which no certificate
   * prints; only a PENDING suggestion ties it to cascadeMay1 — likely, never covering.
   */
  pending: { id: 'g-order-pending', number: '1809922', po: 'PO-90002', lot: '2072612199', doc: DOC.cascadeMay1, status: 'pending' as const },
  /** Its number is an invoice number printed on NO document: never followed. */
  invoiceTwin: { id: 'g-order-invoice-twin', number: '263777', po: 'PO-90003', lot: '9999999901', doc: null, status: null },
};

/**
 * Phase 3 (every field): the registry and provenance facts the Advanced
 * filters read. Dates are RELATIVE to the day the corpus is seeded, because
 * renewal state and "approved in the last 30 days" are judged against today.
 */
export const CUSTOMER = {
  /** Every WMS order above is theirs. */
  harbor: 'g-cust-harbor',
  /** A customer with no orders on file: nothing can be shown as sent to them. */
  pier: 'g-cust-pier',
} as const;

export const REQ = {
  coi: 'g-req-coi',
  audit: 'g-req-audit',
} as const;

export const CLAIM = { kosher: 'g-claim-kosher' } as const;

export const QUEUE = {
  /** Waiting for review: lot 2072610705 — never covering. */
  pendingLot: 'g-queue-pending-lot',
  /** Waiting for review: PO K145999. */
  pendingPo: 'g-queue-pending-po',
};

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

async function tenantAndUsers(db: D1Database): Promise<void> {
  for (const [id, name, slug] of [[GOLDEN_TENANT, 'Golden Dairy Co', 'golden-dairy'], [GOLDEN_OTHER_TENANT, 'Other Dairy Co', 'other-dairy']]) {
    await db.prepare(`INSERT OR IGNORE INTO tenants (id, name, slug, active) VALUES (?, ?, ?, 1)`).bind(id, name, slug).run();
  }
  for (const u of [GOLDEN_USER, GOLDEN_OTHER_USER, GOLDEN_SUPER, GOLDEN_READER]) {
    await db.prepare(
      `INSERT OR IGNORE INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
       VALUES (?, ?, ?, ?, ?, 'x', 1, 0)`,
    ).bind(u.id, u.email, u.name, u.role, u.tenant_id).run();
  }
}

async function insertDocument(db: D1Database, d: GoldenDoc): Promise<void> {
  const tenant = d.tenant ?? GOLDEN_TENANT;
  const created = d.created_at ?? '2026-06-01T00:00:00Z';
  const userId = tenant === GOLDEN_TENANT ? GOLDEN_USER.id : GOLDEN_OTHER_USER.id;
  await db.prepare(
    `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, supplier_id, document_type_id, primary_metadata, created_at, updated_at)
     VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, ?, ?, ?, ?)`,
  ).bind(d.id, tenant, d.title, userId, d.supplier, d.type, JSON.stringify(d.metadata), created, created).run();
  await db.prepare(
    `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, extracted_text, uploaded_by)
     VALUES (?, ?, 1, ?, 2048, 'application/pdf', ?, ?, ?, ?)`,
  ).bind(`${d.id}-v1`, d.id, `${d.title}.pdf`, `golden/${d.id}.pdf`, `sum-${d.id}`, d.text, userId).run();
  if (d.product) {
    await db.prepare(`INSERT INTO document_products (id, document_id, product_id) VALUES (?, ?, ?)`).bind(`${d.id}-dp`, d.id, d.product).run();
  }
  const scheme = await loadResolvedLotScheme(db, tenant, d.supplier);
  for (const [i, l] of (d.lots ?? []).entries()) {
    let productionDate = null;
    if (l.production) {
      const r = resolveProductionDate({ production_date: l.production });
      productionDate = r ? { ...r, documentId: d.id } : null;
    } else if (l.legacyCodeDate) {
      const r = legacyCodeDateAsProduction({ code_date: l.legacyCodeDate }, d.text);
      if (!r.ok) throw new Error(`golden corpus: legacy date on ${d.id} refused (${r.refusal})`);
      productionDate = { ...r.resolution, documentId: d.id };
    }
    const lot = await findOrCreateLot(db, tenant, {
      lotNumber: l.lot,
      subLotCode: l.sub ?? null,
      supplierId: d.supplier,
      productId: d.product ?? null,
      codeDate: l.legacyCodeDate ?? null,
      productionDate,
      lotScheme: scheme,
      documentId: d.id,
      source: 'golden',
    });
    if (!lot) throw new Error(`golden corpus: lot ${l.lot} on ${d.id} did not normalize`);
    await db.prepare(`INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)`).bind(`${d.id}-dl-${i}`, d.id, lot.id).run();
  }
}

/** Seed the corpus into this database, once (a second call is a no-op). */
export async function seedGoldenCorpus(db: D1Database): Promise<void> {
  const have = await db.prepare(`SELECT 1 AS x FROM documents WHERE id = ?`).bind(DOC.cascadeMulti).first();
  if (have) return;
  await doSeed(db);
}

async function doSeed(db: D1Database): Promise<void> {
  await tenantAndUsers(db);
  for (const [id, name] of Object.entries(SUPPLIER_NAMES)) {
    await db.prepare(`INSERT INTO suppliers (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)`).bind(id, GOLDEN_TENANT, name, id).run();
  }
  await db.prepare(`INSERT INTO suppliers (id, tenant_id, name, slug, active) VALUES ('g-other-sup', ?, 'Cascade Creamery Cooperative', 'g-other-sup', 1)`).bind(GOLDEN_OTHER_TENANT).run();
  for (const [id, name, slug] of TYPE_ROWS) {
    await db.prepare(`INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)`).bind(id, GOLDEN_TENANT, name, slug).run();
  }
  await db.prepare(`INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES ('g-other-dt-coa', ?, 'Certificate of Analysis', 'coa', 1)`).bind(GOLDEN_OTHER_TENANT).run();

  await declareLotScheme(db, { tenantId: GOLDEN_TENANT, supplierId: SUP.cascade, spec: LOT_SCHEME_TEMPLATES.plant_yy_julian.spec, source: 'seed' });
  await declareLotScheme(db, { tenantId: GOLDEN_TENANT, supplierId: SUP.valley, spec: LOT_SCHEME_TEMPLATES.best_by_mmddyy_suffix.spec, source: 'seed' });
  await declareLotScheme(db, { tenantId: GOLDEN_OTHER_TENANT, supplierId: 'g-other-sup', spec: LOT_SCHEME_TEMPLATES.plant_yy_julian.spec, source: 'seed' });

  for (const p of PRODUCTS) {
    await db.prepare(`INSERT INTO products (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)`).bind(p.id, GOLDEN_TENANT, p.name, p.id).run();
    for (const ident of p.idents) {
      const input = validateIdentifierInput({ kind: ident.kind, value: ident.value, supplier_id: ident.supplier ?? null, confirmed: true, source: 'seed' });
      await insertProductIdentifier(db, GOLDEN_TENANT, p.id, input, GOLDEN_USER.id);
    }
  }

  for (const d of DOCUMENTS) await insertDocument(db, d);

  // WMS orders: order -> line -> a person's decision on the suggested certificate.
  for (const o of Object.values(ORDERS)) {
    await db.prepare(`INSERT INTO orders (id, tenant_id, order_number, po_number, customer_name, status) VALUES (?, ?, ?, ?, 'Harbor Seafood Co', 'pending')`)
      .bind(o.id, GOLDEN_TENANT, o.number, o.po).run();
    await db.prepare(`INSERT INTO order_items (id, order_id, product_code, product_name, lot_number) VALUES (?, ?, '4417', 'BTR BULK U/S 25KG', ?)`)
      .bind(`${o.id}-i1`, o.id, o.lot).run();
    if (o.doc && o.status) {
      await db.prepare(
        `INSERT INTO lot_match_suggestions (id, tenant_id, order_item_id, document_id, match_basis, match_confidence, status)
         VALUES (?, ?, ?, ?, 'lot_and_product', 0.9, ?)`,
      ).bind(`${o.id}-s1`, GOLDEN_TENANT, `${o.id}-i1`, o.doc, o.status).run();
    }
  }

  // The Review Queue: extracted, waiting for a person.
  const queueRows: Array<[string, Record<string, unknown>]> = [
    [QUEUE.pendingLot, { supplier_name: 'Cascade Creamery Cooperative', product_name: 'SWEET CREAM BUTTER - Unsalted 25kg', lot_number: '20726107', sub_lot_code: '05', production_date: '2026-04-17' }],
    [QUEUE.pendingPo, { supplier_name: 'North Hollow Creamery', product_name: 'Cultured Sour Cream', po_number: 'K145999', lot_number: 'K377', production_date: '2026-04-09' }],
  ];
  for (const [id, fields] of queueRows) {
    await db.prepare(
      `INSERT INTO processing_queue (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type, extracted_text, ai_fields, supplier, status, processing_status)
       VALUES (?, ?, ?, ?, ?, 1024, 'application/pdf', ?, ?, ?, 'pending', 'ready')`,
    ).bind(id, GOLDEN_TENANT, DT.coa, `golden/${id}.pdf`, `${id}.pdf`, JSON.stringify(fields), JSON.stringify(fields), String(fields.supplier_name)).run();
  }

  await seedRegistry(db);
  await rebuildDocumentKeys(db, DOCUMENTS.map((d) => d.id));
}

function dayFromToday(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}

/** Requirements, claims, spec results, renewal, owner, classification, provenance, customers. */
async function seedRegistry(db: D1Database): Promise<void> {
  const T = GOLDEN_TENANT;
  // Customers own the WMS orders.
  await db.prepare(`INSERT INTO customers (id, tenant_id, customer_number, name) VALUES (?, ?, 'C-100', 'Harbor Seafood Co'), (?, ?, 'C-200', 'Pier Bakery')`)
    .bind(CUSTOMER.harbor, T, CUSTOMER.pier, T).run();
  await db.prepare(`UPDATE orders SET customer_id = ? WHERE tenant_id = ?`).bind(CUSTOMER.harbor, T).run();

  // What documents SATISFY (layer 2) — a rejected link never counts.
  await db.prepare(`INSERT INTO requirements (id, tenant_id, slug, name) VALUES (?, ?, 'certificate-of-insurance', 'Certificate of Insurance'), (?, ?, 'third-party-audit', 'Third-party audit certificate')`)
    .bind(REQ.coi, T, REQ.audit, T).run();
  const links: Array<[string, string, string]> = [
    [DOC.cascadeCoi, REQ.coi, 'confirmed'],
    [DOC.valleyCoi, REQ.coi, 'suggested'],
    [DOC.riversideCoi, REQ.coi, 'rejected'],
    [DOC.cascadeSqf, REQ.audit, 'confirmed'],
    [DOC.hollowSqf, REQ.audit, 'confirmed'],
  ];
  for (const [doc, req, status] of links) {
    await db.prepare(`INSERT INTO document_requirements (id, document_id, requirement_id, status) VALUES (?, ?, ?, ?)`).bind(`${doc}-${req}`, doc, req, status).run();
  }
  // What documents TRIGGER (layer 3).
  await db.prepare(`INSERT INTO claim_types (id, tenant_id, slug, name) VALUES (?, ?, 'kosher', 'Kosher')`).bind(CLAIM.kosher, T).run();
  await db.prepare(`INSERT INTO document_claims (id, document_id, claim_type_id, status) VALUES (?, ?, ?, 'confirmed')`).bind(`${DOC.valleyKosher}-kosher`, DOC.valleyKosher, CLAIM.kosher).run();

  // The spec register (0085) and gaps (0109).
  const checks: Array<[string, string, string]> = [
    [DOC.cascadeMulti, 'Moisture', 'out_of_spec'],
    [DOC.cascadeMulti, 'Fat', 'in_spec'],
    [DOC.cascadeSalted, 'Moisture', 'in_spec'],
    [DOC.hollowSourA, 'Coliform', 'not_checked'],
  ];
  for (const [i, [doc, test, verdict]] of checks.entries()) {
    await db.prepare(`INSERT INTO document_spec_checks (id, tenant_id, document_id, test_name_raw, verdict, source) VALUES (?, ?, ?, ?, ?, 'limit')`)
      .bind(`g-dsc-${i}`, T, doc, test, verdict).run();
  }
  await db.prepare(`INSERT INTO document_spec_gaps (id, tenant_id, document_id, kind, test_name_raw, result_key, reason) VALUES ('g-gap-1', ?, ?, 'unjudged', 'Yeast', 'ai_fields::t0r1c1', 'unit refused')`)
    .bind(T, DOC.valleyCreamTote).run();

  // Renewal: a COA does not renew by its TYPE; the three insurance
  // certificates are due in 20 days (inside the default 60-day warning),
  // 5 days ago, and in 400 days; the Cascade SQF certificate was cleared by a
  // reviewer (does not renew).
  await db.prepare(`UPDATE document_types SET renewal_policy = 'none' WHERE id = ?`).bind(DT.coa).run();
  const due: Array<[string, string]> = [[DOC.valleyCoi, dayFromToday(20)], [DOC.riversideCoi, dayFromToday(-5)], [DOC.cascadeCoi, dayFromToday(400)]];
  for (const [doc, day] of due) {
    await db.prepare(`UPDATE documents SET renewal_due_date = ?, renewal_type = 'hard_expiry', renewal_decision = 'accepted', owner = 'Insurance' WHERE id = ?`).bind(day, doc).run();
  }
  await db.prepare(`UPDATE documents SET renewal_decision = 'cleared', owner = 'QA' WHERE id = ?`).bind(DOC.cascadeSqf).run();

  // Classification.
  await db.prepare(`UPDATE documents SET classification_status = 'needs_review' WHERE id = ?`).bind(DOC.valleyKosher).run();
  await db.prepare(`UPDATE documents SET classification_status = 'classified' WHERE id = ?`).bind(DOC.cascadeSpec).run();

  // Provenance (0130): approved from the queue by email three days ago; by
  // smart upload a hundred days ago; and an invoice uploaded directly.
  await db.prepare(`UPDATE documents SET approved_at = ?, intake_source = 'email', origin_queue_id = 'g-queue-was-email' WHERE id = ?`).bind(`${dayFromToday(-3)} 10:00:00`, DOC.cascadeMulti).run();
  await db.prepare(`UPDATE documents SET approved_at = ?, intake_source = 'import', origin_queue_id = 'g-queue-was-upload' WHERE id = ?`).bind(`${dayFromToday(-100)} 10:00:00`, DOC.cascadeSalted).run();
  await db.prepare(`UPDATE documents SET intake_source = 'direct_upload' WHERE id = ?`).bind(DOC.valleyInvoice).run();
}

/** Every approved golden document of the main tenant. */
export const GOLDEN_DOC_IDS: string[] = DOCUMENTS.filter((d) => !d.tenant).map((d) => d.id);
