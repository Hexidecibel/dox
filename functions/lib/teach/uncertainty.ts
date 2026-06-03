/**
 * Learning Interface — extraction uncertainty detection.
 *
 * Given a (tenant, supplier, document_type), look at the supplier's EXISTING
 * stored COA extractions and surface the field-level problems a domain expert
 * (SME) should be asked about. The teach endpoints consume the returned
 * `issues` to drive a guided correction / instruction flow.
 *
 * Data source: the `ai_fields` column on `processing_queue` (a JSON object of
 * field -> stringified value, written by the process worker — see
 * functions/api/queue/[id]/results.ts and bin/process-worker). We read the
 * union of field keys across a sample; nothing is hard-coded to a fixed field
 * list.
 *
 * Per-field confidence is NOT stored (the only confidence signals are a
 * coarse per-doc bucket `ai_confidence` and a numeric per-doc `confidence`),
 * so the `low-confidence` issue kind is intentionally never emitted by the
 * heuristics. The kind remains in the type union for forward-compat / an
 * optional Qwen pass.
 */

export interface UncertaintyExample {
  queue_item_id: string;
  file_name: string | null;
  value: string | null;
}

export interface UncertaintyIssue {
  id: string; // stable slug, e.g. `product_code:phone-like`
  field: string; // the field name, e.g. 'product_code'
  kind: 'often-empty' | 'inconsistent' | 'implausible' | 'low-confidence';
  summary: string; // human-readable description of the problem
  severity: number; // 0..1, how badly it needs SME input (drives ordering)
  examples: UncertaintyExample[]; // a few concrete docs/values illustrating it
}

interface SampleRow {
  id: string;
  file_name: string | null;
  fields: Record<string, string | null>;
}

const DEFAULT_SAMPLE_LIMIT = 40;
const MAX_EXAMPLES = 3;

/**
 * Fields that should be stable per supplier — if we see many distinct values
 * across the sample, that's a sign extraction is mis-reading them (or the
 * field name itself is ambiguous). Matched by substring against the
 * lower-cased field key so `supplier_name`, `mfg_grade`, etc. all hit.
 */
const STABLE_FIELD_HINTS = [
  'supplier',
  'manufacturer',
  'grade',
  'plant',
  'plant_number',
  'plant_code',
  'product_name',
  'origin',
  'country',
  'brand',
  'facility',
];

/**
 * Field-name keywords that imply the value SHOULD parse as a date.
 */
const DATE_FIELD_HINTS = ['date', 'expiration', 'expiry', 'manufactured', 'mfg', 'produced', 'best_by'];

const PHONE_RE = /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const URL_RE = /\bhttps?:\/\//i;
// A loose date matcher: ISO, US slashed, or "Jan 5 2024" style.
const DATE_RE =
  /(\d{4}-\d{1,2}-\d{1,2})|(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})|((jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2})/i;

function isEmpty(v: string | null | undefined): boolean {
  if (v === null || v === undefined) return true;
  const t = String(v).trim().toLowerCase();
  return t === '' || t === 'n/a' || t === 'na' || t === 'none' || t === 'null' || t === 'unknown' || t === '-';
}

function fieldMatchesAny(field: string, hints: string[]): boolean {
  const f = field.toLowerCase();
  return hints.some((h) => f.includes(h));
}

function looksLikeDate(v: string): boolean {
  return DATE_RE.test(v.trim());
}

/**
 * Resolve the effective supplier_id for filtering. Older `processing_queue`
 * rows may have a null `supplier_id` but a populated `supplier` (name)
 * column, so we also accept rows whose `supplier` text matches the supplier's
 * stored name. Returns the supplier's canonical name (or null) for the
 * name-based fallback.
 */
async function resolveSupplierName(db: D1Database, tenantId: string, supplierId: string): Promise<string | null> {
  try {
    const row = await db
      .prepare('SELECT name FROM suppliers WHERE id = ? AND tenant_id = ?')
      .bind(supplierId, tenantId)
      .first<{ name: string | null }>();
    return row?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Normalize a supplier name for fuzzy matching: lowercase, drop punctuation
 * and common corporate suffixes (Inc/LLC/...) so "Medosweet Farms, Inc." and
 * the supplier record "Medosweet Farms" collapse to the same key. Legacy COA
 * queue items have NULL supplier_id and only an inconsistent `supplier` name,
 * so exact matching misses most of the corpus.
 */
function normName(s: string | null | undefined): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[.,/&]/g, ' ')
    .replace(/\b(inc|llc|ltd|co|corp|corporation|company|farms?)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find the distinct `supplier` name strings on this tenant's queue items that
 * fuzzily match the target supplier's name, returned lowercased+trimmed for an
 * IN-list match against `lower(trim(supplier))`.
 */
async function resolveMatchingSupplierNames(
  db: D1Database,
  tenantId: string,
  supplierName: string | null,
): Promise<string[]> {
  const target = normName(supplierName);
  if (!target) return [];
  try {
    const res = await db
      .prepare(`SELECT DISTINCT supplier FROM processing_queue WHERE tenant_id = ? AND supplier IS NOT NULL AND trim(supplier) != ''`)
      .bind(tenantId)
      .all<{ supplier: string }>();
    const out = new Set<string>();
    for (const r of res.results ?? []) {
      const nc = normName(r.supplier);
      if (!nc) continue;
      if (nc === target || nc.includes(target) || target.includes(nc)) {
        out.add(String(r.supplier).trim().toLowerCase());
      }
    }
    return Array.from(out);
  } catch {
    return [];
  }
}

async function resolveDocTypeName(db: D1Database, tenantId: string, documentTypeId: string): Promise<string | null> {
  try {
    const row = await db
      .prepare('SELECT name FROM document_types WHERE id = ? AND tenant_id = ?')
      .bind(documentTypeId, tenantId)
      .first<{ name: string | null }>();
    return row?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Infer the processing_queue.output_kind a doctype's documents extract to, from
 * the doctype name. Used to constrain the sample to the right document family.
 * 'coa' also matches legacy NULL output_kind; an unknown name imposes no
 * output_kind constraint (rely on supplier + doctype matching).
 */
function outputKindForDoctype(name: string | null): 'coa' | 'order' | 'shipment' | null {
  if (!name) return null;
  const n = name.toLowerCase();
  if (n.includes('analysis') || n.includes('coa') || n.includes('certificate') || n.includes('c of a')) return 'coa';
  if (n.includes('order')) return 'order';
  if (n.includes('shipment') || n.includes('audit') || n.includes('bol') || n.includes('lading')) return 'shipment';
  return null;
}

async function loadSample(
  db: D1Database,
  tenantId: string,
  supplierId: string,
  documentTypeId: string,
  sampleLimit: number,
): Promise<SampleRow[]> {
  const supplierName = await resolveSupplierName(db, tenantId, supplierId);
  const docTypeName = await resolveDocTypeName(db, tenantId, documentTypeId);
  const kind = outputKindForDoctype(docTypeName);
  // Legacy queue items carry NULL supplier_id + an inconsistent supplier name;
  // resolve the set of name strings that fuzzily match this supplier.
  const matchNames = await resolveMatchingSupplierNames(db, tenantId, supplierName);

  // Constrain to the right document family by output_kind. 'coa' also accepts
  // legacy rows where output_kind was never set (NULL). order/shipment match
  // exactly. Unknown doctype → no output_kind filter.
  const kindBinds: string[] = [];
  let kindClause = '';
  if (kind === 'coa') {
    kindClause = "AND (output_kind IS NULL OR output_kind = 'coa')";
  } else if (kind) {
    kindClause = 'AND output_kind = ?';
    kindBinds.push(kind);
  }

  // Supplier match: pre-resolved supplier_id, OR (legacy rows with NULL
  // supplier_id) any `supplier` name that fuzzily matches this supplier.
  const supplierBinds: string[] = [supplierId];
  let supplierClause = 'AND supplier_id = ?';
  if (matchNames.length > 0) {
    const ph = matchNames.map(() => '?').join(', ');
    supplierClause = `AND (supplier_id = ? OR (supplier_id IS NULL AND lower(trim(supplier)) IN (${ph})))`;
    supplierBinds.push(...matchNames);
  }

  // Doctype match is RELAXED to also accept NULL: legacy COA queue items were
  // ingested before per-(supplier,doctype) tagging and carry a NULL
  // document_type_id, so a strict `= ?` would miss the real corpus (mirrors
  // the selection bin/parity-coa uses). reviewable states + non-empty fields.
  const sql = `
    SELECT id, file_name, ai_fields
    FROM processing_queue
    WHERE tenant_id = ?
      AND (document_type_id = ? OR document_type_id IS NULL)
      ${supplierClause}
      ${kindClause}
      AND processing_status IN ('ready', 'approved')
      AND ai_fields IS NOT NULL
      AND trim(ai_fields) != ''
      AND trim(ai_fields) != '{}'
    ORDER BY created_at DESC
    LIMIT ?
  `;

  const res = await db
    .prepare(sql)
    .bind(tenantId, documentTypeId, ...supplierBinds, ...kindBinds, sampleLimit)
    .all<{ id: string; file_name: string | null; ai_fields: string }>();

  const rows: SampleRow[] = [];
  for (const r of res.results ?? []) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.ai_fields);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;

    const fields: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === null || v === undefined) {
        fields[k] = null;
      } else if (typeof v === 'object') {
        fields[k] = JSON.stringify(v);
      } else {
        fields[k] = String(v);
      }
    }
    rows.push({ id: r.id, file_name: r.file_name, fields });
  }
  return rows;
}

function takeExamples(
  rows: SampleRow[],
  field: string,
  pick: (value: string | null) => boolean,
): UncertaintyExample[] {
  const out: UncertaintyExample[] = [];
  for (const row of rows) {
    if (out.length >= MAX_EXAMPLES) break;
    const value = field in row.fields ? row.fields[field] : null;
    if (pick(value)) {
      out.push({ queue_item_id: row.id, file_name: row.file_name, value });
    }
  }
  return out;
}

/**
 * Detect implausible values for a single field. Returns a slug suffix +
 * predicate identifying the offending values, or null if the field looks
 * fine. Generic where possible; the known `product_code`-as-phone-number case
 * is the one explicit special case.
 */
function detectImplausible(
  field: string,
  values: string[],
): { slugSuffix: string; describe: string; isBad: (v: string | null) => boolean } | null {
  const nonEmpty = values.filter((v) => !isEmpty(v));
  if (nonEmpty.length === 0) return null;

  const isCodeField = /code|sku|part|item|lot|batch/i.test(field) && !fieldMatchesAny(field, DATE_FIELD_HINTS);
  const isDateField = fieldMatchesAny(field, DATE_FIELD_HINTS);

  // 1. Known case: a code field whose values look like phone numbers.
  if (isCodeField) {
    const phoneish = nonEmpty.filter((v) => PHONE_RE.test(v));
    if (phoneish.length / nonEmpty.length >= 0.4) {
      return {
        slugSuffix: 'phone-like',
        describe: `looks like a phone number rather than a ${field}`,
        isBad: (v) => v != null && !isEmpty(v) && PHONE_RE.test(v),
      };
    }
  }

  // 2. A date field whose values don't parse as dates.
  if (isDateField) {
    const notDates = nonEmpty.filter((v) => !looksLikeDate(v));
    if (notDates.length / nonEmpty.length >= 0.4) {
      return {
        slugSuffix: 'not-a-date',
        describe: `does not parse as a date`,
        isBad: (v) => v != null && !isEmpty(v) && !looksLikeDate(v),
      };
    }
  }

  // 3. A non-date field whose values look like dates (likely mis-mapped).
  if (!isDateField) {
    const dateish = nonEmpty.filter((v) => looksLikeDate(v) && v.trim().length <= 24);
    if (dateish.length / nonEmpty.length >= 0.5) {
      return {
        slugSuffix: 'date-in-non-date-field',
        describe: `contains a date value where a ${field} is expected`,
        isBad: (v) => v != null && !isEmpty(v) && looksLikeDate(v) && v.trim().length <= 24,
      };
    }
  }

  // 4. Generic: values that are email addresses or URLs (almost never a
  //    legitimate COA field value).
  const contactish = nonEmpty.filter((v) => EMAIL_RE.test(v) || URL_RE.test(v));
  if (contactish.length / nonEmpty.length >= 0.5) {
    return {
      slugSuffix: 'email-or-url',
      describe: `contains an email address or URL`,
      isBad: (v) => v != null && !isEmpty(v) && (EMAIL_RE.test(v) || URL_RE.test(v)),
    };
  }

  return null;
}

/**
 * Optional Qwen plausibility pass. Picks the single most ambiguous field
 * (highest distinct-value churn that the heuristics did NOT already flag) and
 * asks the model whether the values look like valid instances of that field.
 * One call max; any failure degrades to "no extra issue". Reuses the
 * Pages -> Qwen fetch shape from functions/lib/llm.ts.
 */
async function maybeQwenJudge(
  env: { QWEN_URL?: string; QWEN_SECRET?: string } | undefined,
  rows: SampleRow[],
  alreadyFlagged: Set<string>,
  fields: string[],
): Promise<UncertaintyIssue | null> {
  if (!env || !env.QWEN_URL) return null;

  // Choose the field with the most distinct non-empty values that isn't
  // already covered, capped to keep the prompt cheap.
  let target: string | null = null;
  let bestDistinct = 0;
  for (const f of fields) {
    if (alreadyFlagged.has(f)) continue;
    const distinct = new Set(rows.map((r) => r.fields[f]).filter((v) => !isEmpty(v)).map((v) => v!.trim()));
    if (distinct.size > bestDistinct && distinct.size >= 3) {
      bestDistinct = distinct.size;
      target = f;
    }
  }
  if (!target) return null;

  const sampleValues = Array.from(
    new Set(rows.map((r) => r.fields[target!]).filter((v) => !isEmpty(v)).map((v) => v!.trim())),
  ).slice(0, 8);
  if (sampleValues.length < 3) return null;

  const baseUrl = (env.QWEN_URL || 'http://127.0.0.1:9600').replace(/\/+$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.QWEN_SECRET ? { Authorization: `Bearer ${env.QWEN_SECRET}` } : {}),
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'best',
        temperature: 0,
        max_tokens: 256,
        messages: [
          {
            role: 'system',
            content:
              'You audit extracted document fields. Given a field name and sample values, decide if the values are plausible instances of that field. Reply with JSON only: {"plausible": true|false, "reason": "short"}. /no_think',
          },
          {
            role: 'user',
            content: `Field: ${target}\nValues: ${JSON.stringify(sampleValues)}`,
          },
        ],
      }),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    let content = (data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
    const fence = content.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
    if (fence) content = fence[1].trim();
    const verdict = JSON.parse(content) as { plausible?: boolean; reason?: string };
    if (verdict.plausible === false) {
      return {
        id: `${target}:llm-implausible`,
        field: target,
        kind: 'implausible',
        summary: `${target}: model flagged the extracted values as implausible${
          verdict.reason ? ` (${verdict.reason})` : ''
        }`,
        severity: 0.5,
        examples: takeExamples(rows, target, (v) => !isEmpty(v)),
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function analyzeUncertainty(
  db: D1Database,
  params: { tenantId: string; supplierId: string; documentTypeId: string; env?: any; sampleLimit?: number },
): Promise<{ issues: UncertaintyIssue[] }> {
  const sampleLimit = params.sampleLimit && params.sampleLimit > 0 ? params.sampleLimit : DEFAULT_SAMPLE_LIMIT;

  const rows = await loadSample(db, params.tenantId, params.supplierId, params.documentTypeId, sampleLimit);
  if (rows.length === 0) return { issues: [] };

  // Union of all field keys across the sample.
  const fieldSet = new Set<string>();
  for (const row of rows) for (const k of Object.keys(row.fields)) fieldSet.add(k);
  const fields = Array.from(fieldSet);

  const n = rows.length;
  const issues: UncertaintyIssue[] = [];
  const implausibleFields = new Set<string>();

  for (const field of fields) {
    const values = rows.map((r) => (field in r.fields ? r.fields[field] : null));
    const present = values.map((v) => v ?? null);
    const emptyCount = present.filter((v) => isEmpty(v)).length;
    const nonEmpty = present.filter((v) => !isEmpty(v)) as string[];
    const emptyFraction = emptyCount / n;

    // --- often-empty -------------------------------------------------------
    // Empty in a high fraction of docs. Skip the all-empty degenerate case
    // (no signal of what it should be) below 100% but still flag it; a
    // perpetually-empty field is itself worth asking about.
    if (emptyFraction >= 0.6 && n >= 2) {
      const examples = takeExamples(rows, field, (v) => isEmpty(v));
      issues.push({
        id: `${field}:often-empty`,
        field,
        kind: 'often-empty',
        summary: `${field}: empty in ${emptyCount}/${n} documents (${Math.round(emptyFraction * 100)}%)`,
        // badness scales with how often it's missing.
        severity: round2(0.3 + 0.5 * emptyFraction),
        examples,
      });
    }

    // --- implausible -------------------------------------------------------
    const implausible = detectImplausible(field, nonEmpty);
    if (implausible) {
      implausibleFields.add(field);
      const badCount = nonEmpty.filter((v) => implausible.isBad(v)).length;
      const badFraction = nonEmpty.length > 0 ? badCount / nonEmpty.length : 0;
      issues.push({
        id: `${field}:${implausible.slugSuffix}`,
        field,
        kind: 'implausible',
        summary: `${field}: ${implausible.describe} in ${badCount}/${nonEmpty.length} non-empty values`,
        // implausible is high-badness; scale by prevalence.
        severity: round2(0.6 + 0.35 * badFraction),
        examples: takeExamples(rows, field, (v) => implausible.isBad(v)),
      });
    }

    // --- inconsistent ------------------------------------------------------
    // Only for fields that should be stable per supplier. If there are many
    // distinct values relative to the number of populated docs, the supplier
    // is presumably consistent in reality and the variance is an extraction
    // problem.
    if (fieldMatchesAny(field, STABLE_FIELD_HINTS) && nonEmpty.length >= 3 && !implausibleFields.has(field)) {
      const distinct = new Set(nonEmpty.map((v) => normalizeForCompare(v)));
      if (distinct.size >= 2) {
        const distinctFraction = distinct.size / nonEmpty.length;
        // Flag when the field — which ought to be near-constant — varies a
        // lot. >=3 distinct, or >50% of values distinct.
        if (distinct.size >= 3 || distinctFraction > 0.5) {
          // Show one example per distinct value (up to MAX_EXAMPLES).
          const seen = new Set<string>();
          const examples: UncertaintyExample[] = [];
          for (const row of rows) {
            if (examples.length >= MAX_EXAMPLES) break;
            const v = field in row.fields ? row.fields[field] : null;
            if (isEmpty(v)) continue;
            const key = normalizeForCompare(v as string);
            if (seen.has(key)) continue;
            seen.add(key);
            examples.push({ queue_item_id: row.id, file_name: row.file_name, value: v });
          }
          issues.push({
            id: `${field}:inconsistent`,
            field,
            kind: 'inconsistent',
            summary: `${field}: ${distinct.size} distinct values across ${nonEmpty.length} documents — expected to be stable for this supplier`,
            severity: round2(0.4 + 0.4 * Math.min(1, distinctFraction)),
            examples,
          });
        }
      }
    }
  }

  // Optional single Qwen judgement on the most ambiguous unflagged field.
  const qwenIssue = await maybeQwenJudge(
    params.env,
    rows,
    new Set(issues.map((i) => i.field)),
    fields,
  );
  if (qwenIssue) issues.push(qwenIssue);

  issues.sort((a, b) => b.severity - a.severity || a.id.localeCompare(b.id));
  return { issues };
}

function round2(n: number): number {
  return Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;
}

function normalizeForCompare(v: string): string {
  return v.trim().toLowerCase().replace(/\s+/g, ' ');
}
