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

import {
  checkPrintedSpecs,
  checkConfiguredLimits,
  checkRequiredAnalytes,
  overdueWatches,
  isoDay,
  STRICT_UNIT_POLICY,
} from '../../shared/specCheck';
import { parseSpecCriticality } from '../../shared/specCriticality';
import type {
  SpecSource,
  SpecVerdict,
  SpecTestDef,
  ConfiguredLimit,
  LimitContext,
  UnitPolicy,
  RequiredAnalyte,
  UnjudgedResult,
  MissingRequiredAnalyte,
} from '../../shared/specCheck';

/** An overdue supplier watch in force for a document (see `overdueWatches`). */
export type OverdueWatch = ReturnType<typeof overdueWatches>[number];

/** Today as YYYY-MM-DD — the one clock read on the review path. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

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
  /**
   * The tenant's unit-equivalence setting (migration 0093). Loaded here so the
   * engine never has to reach for it, and carried explicitly into every call —
   * a setting that changed verdicts from somewhere the caller could not see is
   * precisely what this feature must not be.
   */
  unitPolicy: UnitPolicy;
  /**
   * Required analytes per (supplier, document type) — migration 0109. Optional
   * so a config built by hand (tests, the arrivals path) keeps compiling; absent
   * means none, which is the SME's "complete by default".
   */
  required?: RequiredAnalyte[];
}

export const EMPTY_SPEC_CONFIG: SpecConfig = {
  tests: [],
  limits: [],
  unitPolicy: STRICT_UNIT_POLICY,
  required: [],
};

/**
 * Read the tenant's required analytes. Its own try/catch for the same reason
 * as the unit policy: an environment without migration 0109 must lose the
 * completeness check, never the limits.
 */
async function loadRequiredAnalytes(db: D1Database, tenantId: string): Promise<RequiredAnalyte[]> {
  try {
    const res = await db
      .prepare(
        `SELECT id, spec_test_id, supplier_id, document_type_id, effective_from, review_by, reason
           FROM supplier_required_analytes WHERE tenant_id = ?`
      )
      .bind(tenantId)
      .all();
    return ((res.results ?? []) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      spec_test_id: String(r.spec_test_id),
      supplier_id: String(r.supplier_id),
      document_type_id: String(r.document_type_id),
      effective_from: isoDay(r.effective_from),
      review_by: isoDay(r.review_by),
      reason: r.reason == null ? null : String(r.reason),
    }));
  } catch (err) {
    console.error(
      '[spec-warnings] loading required analytes failed (migration 0109 not applied?):',
      err instanceof Error ? err.message : String(err)
    );
    return [];
  }
}

/**
 * Read the tenant's unit policy. Its OWN try/catch, deliberately not folded
 * into the `Promise.all` below: an environment that has not taken migration
 * 0093 would otherwise fail the whole load and lose the limits too, silently
 * turning spec checking off. A missing column costs the equivalence, nothing
 * more — and the fallback is the strict, safe answer.
 */
async function loadUnitPolicy(db: D1Database, tenantId: string): Promise<UnitPolicy> {
  try {
    const row = await db
      .prepare('SELECT spec_volume_mass_equivalent FROM tenants WHERE id = ?')
      .bind(tenantId)
      .first<{ spec_volume_mass_equivalent: number | null }>();
    return { volume_mass_equivalent: Number(row?.spec_volume_mass_equivalent ?? 0) === 1 };
  } catch (err) {
    console.error(
      '[spec-warnings] loading unit policy failed (falling back to strict):',
      err instanceof Error ? err.message : String(err)
    );
    return STRICT_UNIT_POLICY;
  }
}

/**
 * The columns every environment has held since migration 0084. `criticality`
 * (0095) is asked for separately below.
 */
const LIMIT_COLUMNS =
  `id, spec_test_id, operator, value_min, value_max, unit, severity, active,
   supplier_id, document_type_id, product_id, updated_at`;

/**
 * Read the tenant's active limits, degrading to the pre-0095 column list if
 * `criticality` is not there yet.
 *
 * The retry is not defensive habit: migrations reach prod surgically here, and
 * a SELECT naming a column that does not exist throws. Without the fallback
 * that throw would be caught by `loadSpecConfig` and turn spec checking OFF
 * entirely — trading every limit for a ranking, which is the worst possible
 * exchange. A missing column costs the ranking only; those rows land on
 * `DEFAULT_SPEC_CRITICALITY` at the mapping step below.
 */
async function loadLimitRows(
  db: D1Database,
  tenantId: string
): Promise<Record<string, unknown>[]> {
  const read = async (columns: string): Promise<Record<string, unknown>[]> => {
    const res = await db
      .prepare(`SELECT ${columns} FROM spec_limits WHERE tenant_id = ? AND active = 1`)
      .bind(tenantId)
      .all();
    return (res.results ?? []) as Record<string, unknown>[];
  };
  // Newest column first, each fallback dropping one migration's worth: a
  // missing review_by (0109) costs the watch flag, a missing criticality (0095)
  // the ranking — never the limits themselves.
  const attempts = [
    `${LIMIT_COLUMNS}, criticality, review_by`,
    `${LIMIT_COLUMNS}, criticality`,
    LIMIT_COLUMNS,
  ];
  let lastErr: unknown = null;
  for (const columns of attempts) {
    try {
      return await read(columns);
    } catch (err) {
      lastErr = err;
      console.error(
        `[spec-warnings] reading spec_limits (${columns.split(',').slice(-1)[0].trim()}) failed, ` +
          'falling back to fewer columns:',
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  throw lastErr;
}

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
  const unitPolicy = await loadUnitPolicy(db, tenantId);
  const required = await loadRequiredAnalytes(db, tenantId);
  try {
    const [testRows, limitRows] = await Promise.all([
      db
        .prepare('SELECT id, name, aliases, default_unit FROM spec_tests WHERE tenant_id = ?')
        .bind(tenantId)
        .all(),
      loadLimitRows(db, tenantId),
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

    const limits: ConfiguredLimit[] = limitRows.map((row) => {
      return {
        id: String(row.id),
        spec_test_id: String(row.spec_test_id),
        operator: row.operator as ConfiguredLimit['operator'],
        value_min: row.value_min == null ? null : Number(row.value_min),
        value_max: row.value_max == null ? null : Number(row.value_max),
        unit: row.unit == null ? null : String(row.unit),
        severity: (row.severity as 'warn' | 'alert') ?? 'alert',
        // Absent on a pre-0095 row; the parser lands it on the middle tier
        // rather than inventing a rank for it.
        criticality: parseSpecCriticality(row.criticality),
        active: Number(row.active ?? 1) === 1,
        supplier_id: row.supplier_id == null ? null : String(row.supplier_id),
        document_type_id: row.document_type_id == null ? null : String(row.document_type_id),
        product_id: row.product_id == null ? null : String(row.product_id),
        updated_at: row.updated_at == null ? null : String(row.updated_at),
        review_by: isoDay(row.review_by),
      };
    });

    return { tests, limits, unitPolicy, required };
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
  /** Printed results with no limit and no printed spec — "No limit configured". */
  unjudged: number;
  /** Required analytes (0109) this certificate did not report. */
  missing_required: number;
  /** Supplier watches in force for this document whose review-by has passed. */
  watch_overdue: number;
}

/** Everything the spec pass says about one row, beyond the verdicts. */
export interface SpecCoverage {
  unjudged: UnjudgedResult[];
  missing_required: MissingRequiredAnalyte[];
  watch_overdue: OverdueWatch[];
}

const EMPTY_SUMMARY: SpecSummary = {
  out_of_spec: 0,
  not_checked: 0,
  unmatched: 0,
  unjudged: 0,
  missing_required: 0,
  watch_overdue: 0,
};

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
  opts: { includePasses?: boolean; asOf?: string } = {}
): { results: SpecVerdict[]; summary: SpecSummary } & SpecCoverage {
  const asOf = opts.asOf ?? todayIso();
  try {
    const sources = specSourcesFor(row);
    const unitPolicy = config.unitPolicy ?? STRICT_UNIT_POLICY;
    const required = config.required ?? [];
    const printed = checkPrintedSpecs(sources, { unitPolicy });
    const configured = checkConfiguredLimits(sources, config.tests, config.limits, ctx, {
      includePasses: opts.includePasses,
      unitPolicy,
      asOf,
    });
    const missing = checkRequiredAnalytes(sources, config.tests, required, ctx, { asOf });
    const watchOverdue = overdueWatches(config.tests, config.limits, required, ctx, asOf);
    const results = [...printed, ...configured.verdicts];
    return {
      results,
      unjudged: configured.unjudged,
      missing_required: missing,
      watch_overdue: watchOverdue,
      summary: {
        out_of_spec: results.filter((v) => v.verdict === 'out_of_spec').length,
        not_checked: results.filter((v) => v.verdict === 'not_checked').length,
        unmatched: configured.unmatched.length,
        unjudged: configured.unjudged.length,
        missing_required: missing.length,
        watch_overdue: watchOverdue.length,
      },
    };
  } catch (err) {
    console.error(
      '[spec-warnings] spec check failed:',
      err instanceof Error ? err.message : String(err)
    );
    return { results: [], summary: { ...EMPTY_SUMMARY }, unjudged: [], missing_required: [], watch_overdue: [] };
  }
}

/**
 * Attach `spec_results` + `spec_summary` — and the coverage lists the review
 * queue renders beside them (`spec_unjudged`, `spec_missing_required`,
 * `spec_watch_overdue`) — to a row. Does not mutate the input.
 */
export function withSpecConfig<T extends SpecWarnableRow>(
  row: T,
  config: SpecConfig,
  ctx: LimitContext
): T & {
  spec_results: SpecVerdict[];
  spec_summary: SpecSummary;
  spec_unjudged: UnjudgedResult[];
  spec_missing_required: MissingRequiredAnalyte[];
  spec_watch_overdue: OverdueWatch[];
} {
  const out = specResultsWithConfig(row, config, ctx);
  return {
    ...row,
    spec_results: out.results,
    spec_summary: out.summary,
    spec_unjudged: out.unjudged,
    spec_missing_required: out.missing_required,
    spec_watch_overdue: out.watch_overdue,
  };
}
