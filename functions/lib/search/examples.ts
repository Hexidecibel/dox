/**
 * "Try" examples built from the tenant's OWN approved documents
 * (GET /api/search/examples). The static chips ("lot 10426203-03",
 * "PO K134273") were one tenant's data; on any other tenant they answered
 * nothing, which teaches the opposite of what an example is for.
 *
 * Each candidate is a probe from shared/searchProbes.ts over a deterministic
 * sample (seeded by tenant + day), and it is RUN through `runSearch` — the
 * executor behind POST /api/search/query — before it is offered: a real example
 * is kept only when its document comes back covering, and the one teaching
 * example only when nothing covers and its neighbour is shown as nearby. A
 * month phrase is offered only when the reader turns it into a date clause
 * (`interpretQueryText`), so the set is right before and after the reader
 * learns month phrases.
 *
 * Cached per tenant for the day in the isolate: the row does not jump on every
 * load, and a cold isolate rebuilds the same set because the seed is the day.
 */

import { interpretQueryText } from './interpretText';
import { loadEvalSample } from './sample';
import { runSearch } from './execute';
import { probesForDocument, scoreProbe, spokenDay, type Probe, type ProbeKind, type SampleDoc } from '../../../shared/searchProbes';
import type { SearchExample, SearchExamplesResponse } from '../../../shared/types';

/** Documents one examples build draws from. */
export const EXAMPLE_SAMPLE = 40;
/** Candidates tried per example kind before giving up on it. */
const TRIES_PER_KIND = 3;
const CACHE_MAX = 200;

const cache = new Map<string, SearchExamplesResponse>();

export function clearExamplesCache(): void {
  cache.clear();
}

async function answers(db: D1Database, tenantId: string, probe: Probe, now: Date, fulfillment: boolean) {
  const res = await runSearch(db, tenantId, {
    fulfillment,
    query: { v: 1, text: probe.text, clauses: probe.clauses ?? [], view: { entity: 'documents' } },
    limit: 50,
    offset: 0,
    facets: false,
    interpret: true,
    now,
  });
  return res;
}

/** The shape an example is typed in (the probe's own text, with "lot" in front of a lot). */
function exampleText(p: Probe): string {
  if (p.kind === 'lot_dash') return `lot ${p.text}`;
  return p.text;
}

const ORDER: ProbeKind[] = ['lot_dash', 'lot_exact', 'lot_prefix', 'supplier_po', 'product_day', 'product_month', 'invoice', 'document_number'];
/** One lot example is enough: dash form first, a plain lot when no lot has a sublot. */
const SAME_SLOT: Partial<Record<ProbeKind, ProbeKind>> = { lot_exact: 'lot_dash' };

export async function buildSearchExamples(
  db: D1Database,
  tenantId: string,
  now = new Date(),
  /**
   * `fulfillment: false` = the module is off for the caller. An example is only
   * offered if it answers for THEM, so each candidate is run the way their own
   * search would run it -- without orders -- and that set is cached apart.
   */
  opts: { fulfillment?: boolean } = {},
): Promise<SearchExamplesResponse> {
  const fulfillment = opts.fulfillment !== false;
  const asOf = now.toISOString().slice(0, 10);
  const key = `${tenantId}|${asOf}${fulfillment ? '' : '|no-fulfillment'}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const sample = await loadEvalSample(db, tenantId, { n: EXAMPLE_SAMPLE, seed: `examples|${asOf}` });
  const docs = new Map<string, SampleDoc>(sample.docs.map((d) => [d.id, d]));
  const byKind = new Map<ProbeKind, Probe[]>();
  const push = (p: Probe) => byKind.set(p.kind, [...(byKind.get(p.kind) ?? []), p]);
  for (const d of sample.docs) for (const p of probesForDocument(d)) push(p);
  for (const p of sample.lot_prefixes) push({ kind: 'lot_prefix', text: `lot ${p.prefix}`, doc_id: p.doc_id, expect: 'covering' });

  const examples: SearchExample[] = [];
  const filled = new Set<ProbeKind>();
  const usedTexts = new Set<string>();

  for (const kind of ORDER) {
    const slot = SAME_SLOT[kind] ?? kind;
    if (filled.has(slot)) continue;
    // A real example answers COVERING; a legacy / decoded day is right to be
    // "likely", but it is not what an example should teach first.
    const candidates = (byKind.get(kind) ?? []).filter((p) => p.expect === 'covering').slice(0, TRIES_PER_KIND);
    for (const p of candidates) {
      const text = exampleText(p);
      if (usedTexts.has(text.toLowerCase())) continue;
      if (p.needs === 'month_phrases') {
        const read = await interpretQueryText(db, tenantId, p.text, { fulfillment });
        if (!read.clauses.some((c) => c.field === 'date' || c.field === 'production_date')) break; // the reader does not read months yet
      }
      const res = await answers(db, tenantId, { ...p, text }, now, fulfillment);
      if (scoreProbe(p, res).outcome !== 'pass') continue;
      let label: string | null = null;
      if (kind === 'lot_prefix') {
        const prefix = sample.lot_prefixes.find((x) => x.doc_id === p.doc_id);
        label = prefix ? `every lot from ${prefix.supplier_name} ${prefix.segment} ${prefix.prefix} (declared lot format)` : null;
      }
      examples.push({ text, kind, label });
      usedTexts.add(text.toLowerCase());
      filled.add(slot);
      break;
    }
  }

  // The teaching example: a day next to a real one, with nothing on file.
  for (const n of sample.negatives.days.slice(0, TRIES_PER_KIND)) {
    const doc = docs.get(n.doc_id);
    const day = probesForDocument(doc as SampleDoc).find((p) => p.kind === 'product_day');
    const word = day ? day.text.replace(/ produced .*$/, '') : null;
    const text = `${word ? `${word} ` : ''}produced ${spokenDay(n.day)}`;
    const probe: Probe = { kind: 'neg_adjacent_day', text, doc_id: n.doc_id, expect: 'none' };
    const res = await answers(db, tenantId, probe, now, fulfillment);
    const scored = scoreProbe(probe, res);
    // Only when the neighbour is SHOWN as nearby: that is what the example teaches.
    if (scored.outcome !== 'pass' || scored.landed !== 'nearby') continue;
    examples.push({ text, kind: 'neg_adjacent_day', label: 'nothing on file — see how a near miss is shown', teaching: true });
    break;
  }

  const out: SearchExamplesResponse = {
    examples,
    as_of: asOf,
    ...(fulfillment ? {} : { modules_not_applied: ['fulfillment' as const] }),
  };
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, out);
  return out;
}

