/**
 * The search golden table: "does this phrase find the right document?", asked
 * of a realistic synthetic tenant (tests/fixtures/search-golden/corpus.ts)
 * through the REAL endpoints — POST /api/search/interpret (which chips the
 * words become) and POST /api/search/query (what answers) — in-worker, no
 * network, no live data. It runs in `npx vitest run`, so it gates every deploy.
 *
 * One row per question. A user reports "I searched X and got nothing"? Add a
 * row with the answer they should have got (README.md in the fixture folder).
 *
 * expect:
 *   coverage       the answer's headline (covered / likely / none / unconstrained)
 *   covering       EXACTLY the documents presented as covering
 *   likely         EXACTLY the documents presented as "likely — confirm"
 *   coveringIncludes / likelyIncludes   at least these (rows whose full set a
 *                  parallel reader change may legitimately widen)
 *   notCovering    never covering or likely (may still be listed as nearby)
 *   nearby         listed, and only as nearby (candidate_not_matching)
 *   includes / excludes   present / absent anywhere in the result (browse rows)
 *   unreviewed     Review Queue files named as "still waiting for review"
 *   chips          interpret labels that must be among the chips (substring)
 *   status         HTTP status of the query (default 200)
 *
 * Month and range phrases ("produced in april", "early may") and product words
 * ("unsalted butter", "4417") are being taught to the reader on a parallel
 * branch. Those rows sit in their own blocks, switched on by DETECTING support
 * at the start of the run, so they turn on by themselves when that branch
 * merges — and until then they show as skipped in the output, never absent.
 */

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import type { Clause } from '../../shared/searchQuery';
import {
  DOC, DT, GOLDEN_OTHER_USER, GOLDEN_READER, GOLDEN_SUPER, GOLDEN_TENANT, GOLDEN_USER, P, QUEUE, SUP, seedGoldenCorpus,
} from '../fixtures/search-golden/corpus';
import { ask, bands, monthPhrasesSupported, productWordsSupported, type TestUser } from '../fixtures/search-golden/run';

interface Expect {
  coverage?: string;
  covering?: string[];
  likely?: string[];
  coveringIncludes?: string[];
  likelyIncludes?: string[];
  notCovering?: string[];
  nearby?: string[];
  includes?: string[];
  excludes?: string[];
  unreviewed?: string[];
  chips?: string[];
  /** Product ids the interpret step must read the words as (product-word block). */
  productChips?: string[];
  status?: number;
}

interface GoldenCase {
  q: string;
  clauses?: Clause[];
  as?: 'other' | 'super' | 'super-no-tenant' | 'reader';
  why: string;
  expect: Expect;
}

const supplier = (...ids: string[]): Clause => ({ id: 'c-sup', field: 'supplier', op: 'in', values: ids, source: 'builder' });
const docType = (...ids: string[]): Clause => ({ id: 'c-type', field: 'document_type', op: 'in', values: ids, source: 'builder' });
const product = (ids: string[], ambiguous = false): Clause => ({ id: 'c-prod', field: 'product', op: 'in', values: ids, source: ambiguous ? 'detected' : 'builder', ...(ambiguous ? { ambiguous: true } : {}) });
const lotParts = (lot: string, sublot: string): Clause => ({ id: 'c-lot', field: 'lot', op: 'is', values: [lot], sublot, source: 'builder' });

const CASCADE_COAS = [DOC.cascadeMulti, DOC.cascadeMay1, DOC.cascadeSalted, DOC.cascadeDecoded, DOC.cascadeSplit01, DOC.cascadeSplit02];

// ===========================================================================
// The table
// ===========================================================================

const LOTS: GoldenCase[] = [
  { q: 'lot 2072610703', why: 'WMS composite spelling', expect: { coverage: 'covered', covering: [DOC.cascadeMulti], chips: ['Lot 2072610703'], excludes: [DOC.otherTwin] } },
  { q: '2072610703', why: 'a bare 10-digit run is asked as a lot', expect: { coverage: 'covered', covering: [DOC.cascadeMulti], chips: ['Lot 2072610703'] } },
  { q: '20726107-03', why: 'dash-separated sublot', expect: { coverage: 'covered', covering: [DOC.cascadeMulti], chips: ['Lot 20726107-03'] } },
  { q: '20726107 03', why: 'space-separated sublot', expect: { coverage: 'covered', covering: [DOC.cascadeMulti], chips: ['Lot 20726107 · sublot 03'] } },
  { q: 'lot 20726107-03', why: 'the word lot in front', expect: { coverage: 'covered', covering: [DOC.cascadeMulti] } },
  { q: '', clauses: [lotParts('20726107', '03')], why: 'lot and sublot typed as two inputs', expect: { coverage: 'covered', covering: [DOC.cascadeMulti] } },
  { q: 'lot 20726107', why: 'a base lot covers every sublot of it', expect: { coverage: 'covered', covering: [DOC.cascadeMulti, DOC.cascadeSalted] } },
  { q: 'lot 20726107-04', why: 'the second row of a multi-lot certificate', expect: { coverage: 'covered', covering: [DOC.cascadeMulti] } },
  { q: 'lot 20726108-01', why: 'the third row, a different base lot on the same certificate', expect: { coverage: 'covered', covering: [DOC.cascadeMulti] } },
  { q: 'lot 20726135-02', why: 'a page-scoped sublot document; its sibling sublot is not the answer', expect: { coverage: 'covered', covering: [DOC.cascadeSplit02], notCovering: [DOC.cascadeSplit01] } },
  { q: 'lot 207', why: 'a lot PREFIX, explained by the declared plant · YY · Julian format', expect: { coverage: 'covered', covering: CASCADE_COAS, chips: ['Lot starts with 207', 'plant'] } },
  { q: 'lot K349', why: 'a supplier with no declared format, lot as printed', expect: { coverage: 'covered', covering: [DOC.hollowSourA], notCovering: [DOC.hollowSourB] } },
  { q: 'lot 061526HCR', why: 'best-by MMDDYY + product suffix lot', expect: { coverage: 'covered', covering: [DOC.valleyCreamTote] } },
  { q: 'lot 5093', why: 'a four-digit lot typed after the word lot', expect: { coverage: 'covered', covering: [DOC.riversideEggLegacy] } },
  { q: 'lot 20726107-03', clauses: [supplier(SUP.cascade)], why: 'lot + the right supplier chip', expect: { coverage: 'covered', covering: [DOC.cascadeMulti] } },
];

const IDENTIFIERS: GoldenCase[] = [
  { q: 'PO K145273', why: 'our PO printed with a space ("K 145273")', expect: { coverage: 'covered', covering: [DOC.cascadeMulti], chips: ['PO K145273'], excludes: [DOC.otherTwin] } },
  { q: 'k 145273', why: 'lower case, letter typed apart', expect: { coverage: 'covered', covering: [DOC.cascadeMulti] } },
  { q: 'K 145273', why: 'exactly as printed', expect: { coverage: 'covered', covering: [DOC.cascadeMulti] } },
  { q: 'po k145273', why: 'keyword + lower case', expect: { coverage: 'covered', covering: [DOC.cascadeMulti] } },
  { q: 'PO K145612', why: 'printed in lower case ("k145612")', expect: { coverage: 'covered', covering: [DOC.hollowSourA] } },
  { q: 'PO K145390', why: 'a single-lot certificate PO', expect: { coverage: 'covered', covering: [DOC.cascadeMay1] } },
  { q: 'PO-90001', why: "the CUSTOMER's PO, through the WMS order to a person-accepted match", expect: { coverage: 'covered', covering: [DOC.cascadeMulti] } },
  { q: 'po 90001', why: "the customer's PO without its PO- prefix", expect: { coverage: 'covered', covering: [DOC.cascadeMulti] } },
  { q: 'PO-90002', why: 'customer PO whose only link is a PENDING suggestion: likely, never covering', expect: { coverage: 'likely', covering: [], likely: [DOC.cascadeMay1] } },
  { q: 'order 1809921', why: 'WMS order -> accepted lot match', expect: { coverage: 'covered', covering: [DOC.cascadeMulti], chips: ['Order 1809921'] } },
  { q: 'order 1809922', why: 'WMS order -> pending suggestion only', expect: { coverage: 'likely', covering: [], likely: [DOC.cascadeMay1] } },
  { q: 'invoice 263518', why: "the document's own printed invoice number", expect: { coverage: 'covered', covering: [DOC.valleyInvoice], chips: ['Invoice 263518'] } },
  { q: 'SS-820004-R3', why: 'a spec sheet document number', expect: { coverage: 'covered', covering: [DOC.cascadeSpec] } },
  { q: 'NH-SP-0919', why: 'another document number', expect: { coverage: 'covered', covering: [DOC.hollowSpec] } },
  { q: 'RV-SPEC-1167', why: 'another document number', expect: { coverage: 'covered', covering: [DOC.riversideSpec] } },
  { q: 'SQF-C-778812', why: 'a certificate number', expect: { coverage: 'covered', covering: [DOC.cascadeSqf], notCovering: [DOC.hollowSqf] } },
  { q: 'OU-K-55120', why: 'a kosher certificate number', expect: { coverage: 'covered', covering: [DOC.valleyKosher] } },
  { q: '820004', why: "the supplier's item number printed on the certificate", expect: { coverage: 'covered', covering: [DOC.cascadeMulti, DOC.cascadeMay1, DOC.cascadeDecoded, DOC.cascadeSplit01, DOC.cascadeSplit02], notCovering: [DOC.cascadeSalted] } },
  { q: '820001', why: 'the salted item number, not the unsalted one', expect: { coverage: 'covered', covering: [DOC.cascadeSalted] } },
  { q: '10386', why: 'OUR SKU printed as the customer item number (tote)', expect: { coverage: 'covered', covering: [DOC.valleyCreamTote] } },
  { q: '10384', why: 'customer item number, whole milk tote', expect: { coverage: 'covered', covering: [DOC.valleyMilkTote] } },
  { q: '31904', why: 'supplier item number on two certificates', expect: { coverage: 'covered', covering: [DOC.valleyCreamTote, DOC.valleyBestBy] } },
  { q: '51903', why: 'the bag item number, not the tote', expect: { coverage: 'covered', covering: [DOC.valleyWhipBag], notCovering: [DOC.valleyCreamTote] } },
];

const DATES: GoldenCase[] = [
  { q: 'butter produced Apr 17', why: 'product word + production day (any year); two rows and a salted lot that day', expect: { coverage: 'covered', covering: [DOC.cascadeMulti, DOC.cascadeSalted], chips: ['Production date April 17 (any year)'] } },
  { q: 'salted butter produced Apr 17', why: 'the narrower product words drop the unsalted certificate', expect: { coverage: 'covered', covering: [DOC.cascadeSalted], notCovering: [DOC.cascadeMulti] } },
  { q: 'butter produced 4/17/2026', why: 'a full date', expect: { coverage: 'covered', covering: [DOC.cascadeMulti, DOC.cascadeSalted], chips: ['Production date Apr 17, 2026'] } },
  { q: 'produced Apr 18', why: "one certificate's third row alone", expect: { coverage: 'covered', covering: [DOC.cascadeMulti] } },
  { q: 'butter produced May 15', why: 'two page-scoped sublot documents from one day', expect: { coverage: 'covered', covering: [DOC.cascadeSplit01, DOC.cascadeSplit02] } },
  { q: 'cream produced May 26', why: 'the tote, not the bag produced three days later', expect: { coverage: 'covered', covering: [DOC.valleyCreamTote], notCovering: [DOC.valleyWhipBag] } },
  { q: 'sour cream produced Mar 12', why: 'a supplier with no declared format', expect: { coverage: 'covered', covering: [DOC.hollowSourA], notCovering: [DOC.hollowSourB] } },
  { q: 'egg produced Apr 9', why: 'a stated production date covers', expect: { coverage: 'covered', covering: [DOC.riversideEggStated] } },
  { q: 'produced Apr 17', clauses: [product([P.butterSalted])], why: 'a picked product chip + a day', expect: { coverage: 'covered', covering: [DOC.cascadeSalted] } },
  { q: 'egg produced Apr 3', why: "an older extraction's code date read as production: likely, never covered", expect: { coverage: 'likely', covering: [], likely: [DOC.riversideEggLegacy] } },
  { q: 'butter produced Jun 1', why: 'a date decoded from the lot code: likely, never covered', expect: { coverage: 'likely', covering: [], likely: [DOC.cascadeDecoded] } },
  { q: 'produced 6/1/2026', clauses: [supplier(SUP.cascade)], why: 'decoded date with the supplier chip', expect: { coverage: 'likely', covering: [], likely: [DOC.cascadeDecoded] } },
  { q: 'code date Jul 10', why: 'a code date is its own role', expect: { coverage: 'covered', covering: [DOC.valleyCodeDate], chips: ['Code date July 10 (any year)'] } },
  { q: 'best by Jul 20', why: 'best-by is its own role', expect: { coverage: 'covered', covering: [DOC.valleyBestBy] } },
];

const BROWSE: GoldenCase[] = [
  { q: 'cascade coa', why: 'supplier + type words: a browse, every Cascade certificate of analysis', expect: { coverage: 'unconstrained', includes: CASCADE_COAS, excludes: [DOC.cascadeSpec, DOC.cascadeSqf, DOC.cascadeCoi, DOC.valleyCreamTote] } },
  { q: '', clauses: [supplier(SUP.valley), docType(DT.coi)], why: 'supplier + type chips', expect: { coverage: 'unconstrained', includes: [DOC.valleyCoi], excludes: [DOC.cascadeCoi, DOC.riversideCoi, DOC.valleyInvoice] } },
  { q: 'butter', why: 'text only: a browse, never a coverage claim', expect: { coverage: 'unconstrained', includes: [...CASCADE_COAS, DOC.cascadeSpec], excludes: [DOC.valleyMilkTote, DOC.hollowSourA] } },
  { q: 'valley morning invoice', why: 'text only', expect: { coverage: 'unconstrained', includes: [DOC.valleyInvoice] } },
  { q: 'kosher', why: 'text only', expect: { coverage: 'unconstrained', includes: [DOC.valleyKosher], excludes: [DOC.cascadeSqf] } },
  { q: '', clauses: [product([P.creamTote, P.whipBag], true)], why: 'an ambiguous product chip keeps BOTH products — nothing is picked', expect: { includes: [DOC.valleyCreamTote, DOC.valleyWhipBag], excludes: [DOC.valleyMilkTote] } },
  { q: 'produced May 29', clauses: [product([P.creamTote, P.whipBag], true)], why: 'ambiguous product + a day: the day decides, not a pick', expect: { coverage: 'covered', covering: [DOC.valleyWhipBag], notCovering: [DOC.valleyCreamTote] } },
  { q: 'PO K145273', as: 'reader', why: 'a reader searches too', expect: { coverage: 'covered', covering: [DOC.cascadeMulti] } },
  { q: 'PO K145273', as: 'super', why: 'super_admin naming the tenant', expect: { coverage: 'covered', covering: [DOC.cascadeMulti] } },
];

const NEGATIVES: GoldenCase[] = [
  { q: 'butter produced Apr 16', why: 'the day before a real one: nothing covers, the real day is only NEARBY', expect: { coverage: 'none', covering: [], likely: [], nearby: [DOC.cascadeMulti, DOC.cascadeSalted] } },
  { q: 'butter produced 4/16/2026', why: 'same, with a year', expect: { coverage: 'none', covering: [], likely: [] } },
  { q: 'sour cream produced Mar 13', why: 'the day after a real one', expect: { coverage: 'none', covering: [], likely: [], nearby: [DOC.hollowSourA] } },
  { q: 'cream produced May 27', why: 'the day after the tote', expect: { coverage: 'none', covering: [], likely: [] } },
  { q: 'egg produced Apr 4', why: 'next to a LEGACY date: not even likely', expect: { coverage: 'none', covering: [], likely: [] } },
  { q: 'lot 99999999', why: 'a lot nobody has', expect: { coverage: 'none', covering: [], likely: [] } },
  { q: 'lot 2072610799', why: 'a sibling sublot that does not exist: its certificate is nearby, not the answer', expect: { coverage: 'none', covering: [], likely: [], nearby: [DOC.cascadeMulti] } },
  { q: 'lot 20726107-03', clauses: [supplier(SUP.hollow)], why: 'a real lot with the WRONG supplier chip', expect: { coverage: 'none', covering: [], likely: [], excludes: [DOC.cascadeMulti] } },
  { q: 'lot 20726107-03', clauses: [supplier(SUP.valley)], why: 'another wrong supplier', expect: { coverage: 'none', covering: [], likely: [] } },
  { q: 'invoice 263777', why: 'a WMS ORDER carries this number; an invoice is never followed through orders', expect: { coverage: 'none', covering: [], likely: [] } },
  { q: 'invoice 1809921', why: 'an order number asked as an invoice', expect: { coverage: 'none', covering: [], likely: [] } },
  { q: 'PO-90003', why: 'a customer PO whose order links to nothing', expect: { coverage: 'none', covering: [], likely: [] } },
  { q: 'best by Jul 10', why: 'a CODE date is not a best-by date', expect: { coverage: 'none', covering: [], likely: [], notCovering: [DOC.valleyCodeDate] } },
  { q: 'code date Jul 20', why: 'a best-by date is not a code date', expect: { coverage: 'none', covering: [], likely: [], notCovering: [DOC.valleyBestBy] } },
  { q: 'lot 2072610705', why: 'on a Review Queue file only: never covering, named as waiting', expect: { coverage: 'none', covering: [], likely: [], unreviewed: [QUEUE.pendingLot] } },
  { q: 'PO K145999', why: 'on a Review Queue file only', expect: { coverage: 'none', covering: [], likely: [], unreviewed: [QUEUE.pendingPo] } },
  { q: 'PO K145273', as: 'super-no-tenant', why: 'super_admin with no organization chosen: 400, the UI asks for one', expect: { status: 400 } },
];

const ISOLATION: GoldenCase[] = [
  { q: 'lot 20726107-03', as: 'other', why: "the other tenant sees ITS twin, never ours", expect: { coverage: 'covered', covering: [DOC.otherTwin], excludes: [DOC.cascadeMulti] } },
  { q: 'PO K145273', as: 'other', why: 'same PO in both tenants', expect: { coverage: 'covered', covering: [DOC.otherTwin], excludes: [DOC.cascadeMulti] } },
  { q: 'invoice 263518', as: 'other', why: "our invoice does not exist over there", expect: { coverage: 'none', covering: [], excludes: [DOC.valleyInvoice] } },
  { q: 'butter produced Apr 17', as: 'other', why: 'dates are tenant-scoped too', expect: { covering: [DOC.otherTwin], excludes: [DOC.cascadeMulti, DOC.cascadeSalted] } },
];

/** Switched on when the reader learns month / range phrases. */
const MONTHS: GoldenCase[] = [
  { q: 'butter produced in april', why: 'product word + a month', expect: { coveringIncludes: [DOC.cascadeMulti, DOC.cascadeSalted], notCovering: [DOC.cascadeMay1, DOC.cascadeSplit01] } },
  { q: 'produced in april', why: 'a month alone: stated days cover, a legacy day stays likely', expect: { coveringIncludes: [DOC.cascadeMulti, DOC.cascadeSalted, DOC.riversideEggStated], notCovering: [DOC.hollowSourA, DOC.valleyCreamTote] } },
  { q: 'sour cream produced in march', why: 'both March sour cream lots', expect: { coveringIncludes: [DOC.hollowSourA, DOC.hollowSourB] } },
  { q: 'butter produced April 2026', why: 'month + year', expect: { coveringIncludes: [DOC.cascadeMulti, DOC.cascadeSalted], notCovering: [DOC.cascadeMay1] } },
  { q: 'butter produced early may', why: 'a range phrase: May 1 is early May, May 15 is not', expect: { coveringIncludes: [DOC.cascadeMay1], notCovering: [DOC.cascadeSplit01, DOC.cascadeSplit02] } },
  { q: 'egg produced in april', why: 'a legacy day inside the month is likely, never covering', expect: { coveringIncludes: [DOC.riversideEggStated], notCovering: [DOC.riversideEggLegacy] } },
  { q: 'butter produced in february', why: 'a month with no lot at all', expect: { covering: [], coverage: 'none' } },
];

/** Switched on when the reader turns product words into product chips. */
const PRODUCT_WORDS: GoldenCase[] = [
  { q: 'unsalted butter', why: 'an alias', expect: { productChips: [P.butterUnsalted], excludes: [DOC.cascadeSalted] } },
  { q: '4417', why: 'OUR SKU, never printed on a certificate', expect: { productChips: [P.butterUnsalted] } },
  { q: 'liquid egg', why: 'an alias', expect: { productChips: [P.egg] } },
  { q: 'heavy whipping cream 40%', why: 'one supplier name on two products: ambiguous, nothing picked', expect: { productChips: [P.creamTote, P.whipBag] } },
  { q: '5 gallon bag', why: 'a pack', expect: { productChips: [P.whipBag] } },
  { q: 'unsalted butter produced Apr 17', why: 'alias + a day', expect: { covering: [DOC.cascadeMulti], notCovering: [DOC.cascadeSalted] } },
];

// ===========================================================================
// Runner
// ===========================================================================

await seedGoldenCorpus(env.DB);
const MONTHS_ON = await monthPhrasesSupported(GOLDEN_USER);
const PRODUCT_WORDS_ON = await productWordsSupported(GOLDEN_USER);

function userFor(c: GoldenCase): { user: TestUser; tenant?: string } {
  switch (c.as) {
    case 'other': return { user: GOLDEN_OTHER_USER };
    case 'reader': return { user: GOLDEN_READER };
    case 'super': return { user: GOLDEN_SUPER, tenant: GOLDEN_TENANT };
    case 'super-no-tenant': return { user: GOLDEN_SUPER };
    default: return { user: GOLDEN_USER };
  }
}

async function check(c: GoldenCase): Promise<void> {
  const { user, tenant } = userFor(c);
  const r = await ask(user, c.q, c.clauses ?? [], tenant);
  const e = c.expect;
  const label = `"${c.q}"${c.clauses?.length ? ` + ${c.clauses.map((x) => `${x.field}:${x.values.join('|')}`).join(' ')}` : ''}`;
  expect(r.status, `${label}: status (${r.body.error ?? ''})`).toBe(e.status ?? 200);
  if (r.status !== 200) return;
  const b = bands(r.body);
  const sorted = (xs: string[]) => [...xs].sort();
  const got = `covering=${b.covering.join(',') || '-'} likely=${b.likely.join(',') || '-'} nearby=${b.nearby.join(',') || '-'} | ${r.body.coverage_summary ?? ''}`;
  if (e.coverage) expect(r.body.coverage, `${label}: coverage — ${got}`).toBe(e.coverage);
  if (e.covering) expect(b.covering, `${label}: covering — ${got}`).toEqual(sorted(e.covering));
  if (e.likely) expect(b.likely, `${label}: likely — ${got}`).toEqual(sorted(e.likely));
  for (const id of e.coveringIncludes ?? []) expect(b.covering, `${label}: covering must include ${id} — ${got}`).toContain(id);
  for (const id of e.likelyIncludes ?? []) expect(b.likely, `${label}: likely must include ${id} — ${got}`).toContain(id);
  for (const id of e.notCovering ?? []) {
    expect(b.covering, `${label}: ${id} must not cover — ${got}`).not.toContain(id);
    expect(b.likely, `${label}: ${id} must not be likely — ${got}`).not.toContain(id);
  }
  for (const id of e.nearby ?? []) expect(b.nearby, `${label}: ${id} should be nearby — ${got}`).toContain(id);
  for (const id of e.includes ?? []) expect(b.all, `${label}: should list ${id} — ${got}`).toContain(id);
  for (const id of e.excludes ?? []) expect(b.all, `${label}: must not list ${id} — ${got}`).not.toContain(id);
  if (e.unreviewed) {
    const ids = (r.body.unreviewed_candidates ?? []).map((u) => u.queue_id);
    for (const id of e.unreviewed) expect(ids, `${label}: Review Queue file ${id}`).toContain(id);
    expect(b.all.some((id) => id.startsWith('g-queue')), `${label}: a queue file is never a result row`).toBe(false);
  }
  if (e.chips) {
    const labels = Object.values(r.interpreted?.labels ?? {});
    for (const want of e.chips) expect(labels.some((l) => l.includes(want)), `${label}: chip "${want}" in ${JSON.stringify(labels)}`).toBe(true);
  }
  if (e.productChips) {
    const ids = (r.interpreted?.clauses ?? []).filter((x) => x.field === 'product').flatMap((x) => x.values);
    expect(sorted([...new Set(ids)]), `${label}: product chips`).toEqual(sorted(e.productChips));
  }
}

const table = (name: string, rows: GoldenCase[], enabled = true) =>
  describe(name, () => {
    for (const c of rows) {
      const title = `${c.q || '(chips only)'}${c.as ? ` [as ${c.as}]` : ''} — ${c.why}`;
      (enabled ? it : it.skip)(title, () => check(c));
    }
  });

table('lots — every spelling', LOTS);
table('identifiers — PO, order, invoice, document / certificate / item numbers', IDENTIFIERS);
table('dates — production day, legacy and decoded provenance, roles', DATES);
table('browse, chips and roles', BROWSE);
table('negatives — nothing covers, and nothing nearby is presented as covering', NEGATIVES);
table('tenant isolation', ISOLATION);
table(`month / range phrases (${MONTHS_ON ? 'reader supports them' : 'SKIPPED: the reader does not read "produced in april" yet'})`, MONTHS, MONTHS_ON);
table(`product words -> product chips (${PRODUCT_WORDS_ON ? 'reader supports them' : 'SKIPPED: the reader does not turn "unsalted butter" into a product chip yet'})`, PRODUCT_WORDS, PRODUCT_WORDS_ON);

describe('the golden table itself', () => {
  it('names every approved golden document at least once', () => {
    const all = [...LOTS, ...IDENTIFIERS, ...DATES, ...BROWSE, ...NEGATIVES, ...ISOLATION];
    const named = new Set(all.flatMap((c) => Object.values(c.expect).flat().filter((v): v is string => typeof v === 'string')));
    const missing = Object.values(DOC).filter((id) => !named.has(id));
    expect(missing).toEqual([]);
  });
});
