/**
 * THE ALIAS GAP, counted — which printed test names this tenant's configuration
 * does not recognise, how much they cover, and one document to go and look at.
 *
 * WHY IT IS ITS OWN MODULE. `bin/recheck-spec-limits` has reported this since
 * the feature shipped, and that CLI report is how an eight-spelling gap covering
 * hundreds of results was found on the live tenant. The finding matters more
 * than the tool: a limit whose analyte name never matches what suppliers print
 * is a limit that silently never runs, and the out-of-spec register cannot tell
 * you about a check that never happened — absence of a row reads as "fine".
 * Putting the same answer on the admin screen meant a second derivation of it,
 * and two derivations would eventually disagree about which spellings are
 * missing, which is exactly the kind of quiet divergence this codebase spends
 * its comments arguing against. So the derivation lives here, and BOTH the CLI
 * and `GET /api/spec-unmatched` call it.
 *
 * IT MATCHES THE WAY THE ENGINE MATCHES, because it IS the engine: every
 * document is run through `checkConfiguredLimits` and the answer is read off
 * `unmatched_results`. Nothing here re-implements name matching, so a spelling
 * this module offers to fix is a spelling that was genuinely skipped, and one it
 * does not list is one the engine really did recognise.
 *
 * TWO GAPS LAND IN `unmatched_results` AND ONLY ONE BELONGS HERE. A name that
 * matches no configured analyte is an ALIAS gap and is fixable by adding the
 * spelling. A name that matches an analyte for which no limit applies to this
 * supplier or document type is a SCOPE gap — a missing limit, not a missing
 * alias, and offering to "add it as an alias" there would be advice that does
 * nothing. Only the first kind is collected (`spec_test_id === null`).
 *
 * SPELLINGS ARE GROUPED BY THE MATCH KEY, not by the raw text. "Flavor",
 * "FLAVOR", "%FAT" and "FAT" are two groups, not four, because one alias fixes
 * each pair — `normalizeTestName` is the same fold `matchSpecTest` applies. A
 * panel that listed them separately would ask an operator to do the same job
 * twice and then show one of the two still outstanding.
 */

import { checkConfiguredLimits, normalizeTestName, STRICT_UNIT_POLICY } from './specCheck';
import type { ConfiguredLimit, SpecSource, SpecTestDef, UnitPolicy } from './specCheck';

/**
 * One approved document, as this module needs it: the identity a person can
 * click through to, plus the extraction the COA producer stored.
 */
export interface UnmatchedScanDocument {
  id: string;
  title?: string | null;
  supplier_id?: string | null;
  supplier_name?: string | null;
  document_type_id?: string | null;
  /** `documents.extended_metadata` — JSON text, or already parsed. */
  extended_metadata?: unknown;
}

/** One raw spelling inside a group, with what it covers. */
export interface UnmatchedSpelling {
  name: string;
  results: number;
  documents: number;
}

/** A document a spelling was printed on, and what it said there. */
export interface UnmatchedExample {
  document_id: string;
  document_title: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  test_name_raw: string;
  value_raw: string;
  unit_raw: string | null;
}

/** One unrecognised analyte, folded across every spelling of it. */
export interface UnmatchedAnalyteGroup {
  /** `normalizeTestName` of every spelling in the group — the identity. */
  key: string;
  /** The commonest spelling, which is what a person is shown. */
  name: string;
  /** Every spelling, commonest first. */
  spellings: UnmatchedSpelling[];
  /** Printed results carrying one of those spellings. */
  results: number;
  /** Documents at least one of them appeared on. */
  documents: number;
  /** Suppliers whose certificates print it, commonest first. */
  suppliers: Array<{ id: string | null; name: string | null; results: number }>;
  /** One document to open and check, with the value as printed. */
  example: UnmatchedExample | null;
}

export interface UnmatchedScanResult {
  groups: UnmatchedAnalyteGroup[];
  documents_scanned: number;
  /** Of those, how many carried any test results at all. */
  documents_with_results: number;
  total_groups: number;
  total_results: number;
}

/**
 * Above this a payload is skipped rather than parsed. Mirrors the guard in
 * `functions/lib/spec-warnings.ts`: one pathological document must not be able
 * to stall a screen that reads hundreds of them.
 */
const MAX_PAYLOAD_CHARS = 400_000;

function parsePayload(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return null;
  if (raw.length > MAX_PAYLOAD_CHARS) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Rebuild the engine's source list from an approved document's
 * `extended_metadata`, where the COA producer stores the approved `tables` and
 * `groups` (`functions/lib/kinds/coa.ts`).
 *
 * The scope is `ai_fields` for both, which is what the review queue calls the
 * flat path — a result key produced here therefore reads the same as one
 * produced at approval time.
 */
export function documentSpecSources(extendedMetadata: unknown): SpecSource[] {
  const extended = parsePayload(extendedMetadata);
  if (!extended) return [];
  const sources: SpecSource[] = [];
  const tables = extended.tables;
  if (Array.isArray(tables) && tables.length > 0) {
    sources.push({ scope: 'ai_fields', tables: tables as SpecSource['tables'] });
  }
  const groups = extended.groups;
  if (groups && typeof groups === 'object' && !Array.isArray(groups)) {
    sources.push({ scope: 'ai_fields', groups: groups as SpecSource['groups'] });
  }
  return sources;
}

export interface UnmatchedScanOptions {
  unitPolicy?: UnitPolicy;
  /**
   * Match keys a person has already said are not tests. Filtered out of the
   * groups but still counted in `total_groups` by the caller if it wants to say
   * so — this module simply does not return them.
   */
  ignoreKeys?: Iterable<string>;
}

interface Accumulator {
  key: string;
  results: number;
  documents: Set<string>;
  spellings: Map<string, { name: string; results: number; documents: Set<string> }>;
  suppliers: Map<string, { id: string | null; name: string | null; results: number }>;
  example: UnmatchedExample | null;
}

/**
 * Run the engine over a set of approved documents and report the spellings it
 * could not match.
 *
 * Pure: no clock, no database, no cap of its own. WHICH documents to look at,
 * and how many, is the caller's decision — the CLI reads the whole corpus, the
 * API reads a bounded, most-recent slice and says so.
 */
export function scanUnmatchedAnalytes(
  documents: UnmatchedScanDocument[],
  tests: SpecTestDef[],
  limits: ConfiguredLimit[],
  opts: UnmatchedScanOptions = {}
): UnmatchedScanResult {
  const unitPolicy = opts.unitPolicy ?? STRICT_UNIT_POLICY;
  const ignore = new Set<string>();
  for (const k of opts.ignoreKeys ?? []) ignore.add(normalizeTestName(k));

  const acc = new Map<string, Accumulator>();
  let withResults = 0;

  for (const doc of documents) {
    const sources = documentSpecSources(doc.extended_metadata);
    if (sources.length === 0) continue;
    withResults++;

    const checked = checkConfiguredLimits(
      sources,
      tests,
      limits,
      {
        supplier_id: doc.supplier_id ?? null,
        document_type_id: doc.document_type_id ?? null,
        product_ids: [],
      },
      { unitPolicy }
    );

    for (const r of checked.unmatched_results) {
      // A scope gap, not an alias gap — see the module header.
      if (r.spec_test_id) continue;
      const key = normalizeTestName(r.test_name_raw);
      if (!key || ignore.has(key)) continue;

      let entry = acc.get(key);
      if (!entry) {
        entry = {
          key,
          results: 0,
          documents: new Set(),
          spellings: new Map(),
          suppliers: new Map(),
          example: null,
        };
        acc.set(key, entry);
      }
      entry.results++;
      entry.documents.add(doc.id);

      const spellingKey = r.test_name_raw;
      let spelling = entry.spellings.get(spellingKey);
      if (!spelling) {
        spelling = { name: spellingKey, results: 0, documents: new Set() };
        entry.spellings.set(spellingKey, spelling);
      }
      spelling.results++;
      spelling.documents.add(doc.id);

      const supplierKey = doc.supplier_id ?? `name:${doc.supplier_name ?? ''}`;
      const supplier = entry.suppliers.get(supplierKey);
      if (supplier) supplier.results++;
      else {
        entry.suppliers.set(supplierKey, {
          id: doc.supplier_id ?? null,
          name: doc.supplier_name ?? null,
          results: 1,
        });
      }

      // The FIRST one seen, and the caller decides the document order — so a
      // most-recent-first scan shows the most recent certificate, which is the
      // one a person wants to open. Never overwritten: a stable example makes
      // the panel stable between reloads.
      if (!entry.example) {
        entry.example = {
          document_id: doc.id,
          document_title: doc.title ?? null,
          supplier_id: doc.supplier_id ?? null,
          supplier_name: doc.supplier_name ?? null,
          test_name_raw: r.test_name_raw,
          value_raw: r.value_raw,
          unit_raw: r.unit_raw,
        };
      }
    }
  }

  const groups: UnmatchedAnalyteGroup[] = [...acc.values()].map((e) => {
    const spellings = [...e.spellings.values()]
      .map((s) => ({ name: s.name, results: s.results, documents: s.documents.size }))
      .sort((a, b) => b.results - a.results || a.name.localeCompare(b.name));
    return {
      key: e.key,
      name: spellings.length > 0 ? spellings[0].name : e.key,
      spellings,
      results: e.results,
      documents: e.documents.size,
      suppliers: [...e.suppliers.values()].sort(
        (a, b) => b.results - a.results || (a.name || '').localeCompare(b.name || '')
      ),
      example: e.example,
    };
  });

  // Most results first: the spelling that costs the most checks is the one
  // worth fixing first, and it is the only ordering that survives a re-scan
  // unchanged. Ties break on the name so the list never shuffles.
  groups.sort((a, b) => b.results - a.results || a.name.localeCompare(b.name));

  return {
    groups,
    documents_scanned: documents.length,
    documents_with_results: withResults,
    total_groups: groups.length,
    total_results: groups.reduce((n, g) => n + g.results, 0),
  };
}
