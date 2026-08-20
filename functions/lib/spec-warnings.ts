/**
 * Review-time SPEC warnings for processing_queue rows.
 *
 * Sibling of `queue-warnings.ts`, and deliberately a separate array on the API
 * response. The two answer different questions and a reviewer needs to tell them
 * apart:
 *
 *   invariant_warnings  "the extraction looks wrong"   → check the document
 *   spec_results        "the RESULT looks wrong"       → check the product
 *
 * Conflating them would be a real cost: an extraction warning is a data-quality
 * chore, an out-of-spec micro result is a food-safety event, and the second must
 * never be filed behind the first.
 *
 * Phase 0 scope: the COA's OWN printed specification and pass/fail columns. No
 * configuration, no tenant data, works on every supplier from the day it ships.
 * Configured `spec_limits` arrive in Phase 1 and reuse the same engine and the
 * same response field, tagged `source: 'limit'`.
 *
 * SAME CONTRACT AS THE INVARIANTS: never throws, never blocks, advisory only.
 */

import { checkPrintedSpecs, checkConfiguredLimits } from '../../shared/specCheck';
import type {
  SpecSource,
  SpecVerdict,
  SpecTestDef,
  ConfiguredLimit,
  LimitContext,
} from '../../shared/specCheck';

/**
 * Above this, skip rather than burn worker CPU on a pathological payload. A
 * missing warning is survivable; a queue that times out is not. Mirrors the
 * guard in `queue-warnings.ts`.
 */
const MAX_PAYLOAD_CHARS = 400_000;

export interface SpecWarnableRow {
  /** JSON array of ExtractedTable — the flat/legacy extraction path. */
  tables?: unknown;
  /** JSON CoaRecordsPayload — the records path, tables and groups per record. */
  ai_records?: unknown;
  [key: string]: unknown;
}

function safeParse(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  if (raw.length > MAX_PAYLOAD_CHARS) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function asTables(v: unknown): SpecSource['tables'] {
  return Array.isArray(v) ? (v as SpecSource['tables']) : undefined;
}

function asGroups(v: unknown): SpecSource['groups'] {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as SpecSource['groups']) : undefined;
}

/**
 * Collect every place a queue row carries test results, tagged with the scope
 * name the review UI already uses ('ai_fields' for the flat path, 'record[N]'
 * for records mode) so a verdict can be routed to the tile that renders it.
 */
export function specSourcesFor(row: SpecWarnableRow): SpecSource[] {
  const sources: SpecSource[] = [];

  const flat = asTables(safeParse(row.tables));
  if (flat && flat.length > 0) sources.push({ scope: 'ai_fields', tables: flat });

  const rec = safeParse(row.ai_records) as { records?: unknown } | null;
  const records = rec && Array.isArray(rec.records) ? rec.records : [];
  records.forEach((r: unknown, i: number) => {
    if (!r || typeof r !== 'object') return;
    const tables = asTables((r as { tables?: unknown }).tables);
    const groups = asGroups((r as { groups?: unknown }).groups);
    if (tables?.length || groups) sources.push({ scope: `record[${i}]`, tables, groups });
  });

  return sources;
}

/**
 * Compute the spec verdicts for one queue row. Never throws — a checker bug must
 * not take down the review queue, so a failure degrades to "no verdicts" and
 * logs. Degrading silent is acceptable HERE and only here: the row still reaches
 * a human, which is the actual safety net.
 */
export function specResultsFor(row: SpecWarnableRow): SpecVerdict[] {
  try {
    return checkPrintedSpecs(specSourcesFor(row));
  } catch (err) {
    console.error(
      '[spec-warnings] printed-spec check failed:',
      err instanceof Error ? err.message : String(err)
    );
    return [];
  }
}

/**
 * Attach `spec_results` to a queue row for the API response. Returns a new
 * object; the input is not mutated.
 */
export function withSpecResults<T extends SpecWarnableRow>(
  row: T
): T & { spec_results: SpecVerdict[] } {
  return { ...row, spec_results: specResultsFor(row) };
}

// ---------------------------------------------------------------------------
// Phase 1 — OUR configured limits
// ---------------------------------------------------------------------------

/** Everything a tenant has configured, loaded once and reused across rows. */
export interface SpecConfig {
  tests: SpecTestDef[];
  limits: ConfiguredLimit[];
}

export const EMPTY_SPEC_CONFIG: SpecConfig = { tests: [], limits: [] };

/**
 * Load a tenant's analytes and limits. One query each — the queue list endpoint
 * renders many rows and must not issue a query per row.
 *
 * Returns the empty config on any failure, including a missing table: this ships
 * ahead of migration 0084 reaching every environment, and a review queue that
 * 500s because a spec table is absent would be a far worse outcome than one that
 * shows no spec warnings.
 */
export async function loadSpecConfig(db: D1Database, tenantId: string): Promise<SpecConfig> {
  try {
    const [testRows, limitRows] = await Promise.all([
      db
        .prepare('SELECT id, name, aliases, default_unit FROM spec_tests WHERE tenant_id = ?')
        .bind(tenantId)
        .all(),
      db
        .prepare(
          `SELECT id, spec_test_id, operator, value_min, value_max, unit, severity, active,
                  supplier_id, document_type_id, product_id, updated_at
             FROM spec_limits
            WHERE tenant_id = ? AND active = 1`
        )
        .bind(tenantId)
        .all(),
    ]);

    const tests: SpecTestDef[] = (testRows.results ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      let aliases: string[] = [];
      try {
        const parsed = JSON.parse(String(row.aliases ?? '[]'));
        if (Array.isArray(parsed)) aliases = parsed.map((a) => String(a));
      } catch {
        // A corrupt aliases blob costs that analyte its synonyms, nothing more.
      }
      return {
        id: String(row.id),
        name: String(row.name ?? ''),
        aliases,
        default_unit: row.default_unit == null ? null : String(row.default_unit),
      };
    });

    const limits: ConfiguredLimit[] = (limitRows.results ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      return {
        id: String(row.id),
        spec_test_id: String(row.spec_test_id),
        operator: row.operator as ConfiguredLimit['operator'],
        value_min: row.value_min == null ? null : Number(row.value_min),
        value_max: row.value_max == null ? null : Number(row.value_max),
        unit: row.unit == null ? null : String(row.unit),
        severity: (row.severity as 'warn' | 'alert') ?? 'alert',
        active: Number(row.active ?? 1) === 1,
        supplier_id: row.supplier_id == null ? null : String(row.supplier_id),
        document_type_id: row.document_type_id == null ? null : String(row.document_type_id),
        product_id: row.product_id == null ? null : String(row.product_id),
        updated_at: row.updated_at == null ? null : String(row.updated_at),
      };
    });

    return { tests, limits };
  } catch (err) {
    console.error(
      '[spec-warnings] loading spec config failed:',
      err instanceof Error ? err.message : String(err)
    );
    return EMPTY_SPEC_CONFIG;
  }
}

/** Caches one config per tenant across a single request. */
export function specConfigLoader(db: D1Database) {
  const cache = new Map<string, Promise<SpecConfig>>();
  return (tenantId: string): Promise<SpecConfig> => {
    let hit = cache.get(tenantId);
    if (!hit) {
      hit = loadSpecConfig(db, tenantId);
      cache.set(tenantId, hit);
    }
    return hit;
  };
}

/** How many results of each kind — drives the queue's one-glance summary. */
export interface SpecSummary {
  out_of_spec: number;
  not_checked: number;
  /** Tests printed on the COA that we hold no limit for. Not a warning. */
  unmatched: number;
}

/**
 * Run BOTH passes over one row: the COA's own printed limits, then ours.
 *
 * Ours come second and are listed second, but they are the ones that matter
 * more — a supplier's COA passes against the supplier's spec, and the customer
 * spec is routinely tighter.
 *
 * `includePasses` is off here: the review queue treats silence as "fine". The
 * approve-time register turns it on, because "checked and passed" is exactly the
 * record a QA buyer is paying for.
 */
export function specResultsWithConfig(
  row: SpecWarnableRow,
  config: SpecConfig,
  ctx: LimitContext,
  opts: { includePasses?: boolean } = {}
): { results: SpecVerdict[]; summary: SpecSummary } {
  try {
    const sources = specSourcesFor(row);
    const printed = checkPrintedSpecs(sources);
    const configured = checkConfiguredLimits(sources, config.tests, config.limits, ctx, opts);
    const results = [...printed, ...configured.verdicts];
    return {
      results,
      summary: {
        out_of_spec: results.filter((v) => v.verdict === 'out_of_spec').length,
        not_checked: results.filter((v) => v.verdict === 'not_checked').length,
        unmatched: configured.unmatched.length,
      },
    };
  } catch (err) {
    console.error(
      '[spec-warnings] spec check failed:',
      err instanceof Error ? err.message : String(err)
    );
    return { results: [], summary: { out_of_spec: 0, not_checked: 0, unmatched: 0 } };
  }
}

/** Attach `spec_results` + `spec_summary` to a row. Does not mutate the input. */
export function withSpecConfig<T extends SpecWarnableRow>(
  row: T,
  config: SpecConfig,
  ctx: LimitContext
): T & { spec_results: SpecVerdict[]; spec_summary: SpecSummary } {
  const { results, summary } = specResultsWithConfig(row, config, ctx);
  return { ...row, spec_results: results, spec_summary: summary };
}
