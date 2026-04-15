/**
 * Schema discovery helpers for the file-first wizard.
 *
 * Wave 1 scope: CSV only. XLSX / PDF / email / Qwen-assisted discovery paths
 * are stubbed with 501 errors so the wizard wiring can land before the
 * heavier file formats are implemented.
 *
 * The flow the wizard uses:
 *   1. User drops a sample file.
 *   2. `/api/connectors/discover-schema` calls discoverFromCSV (or the future
 *      XLSX/PDF variant) against the uploaded sample, producing a
 *      DiscoveryResult — a list of detected columns with sample values and
 *      inferred types.
 *   3. autoSuggestTarget runs against each detected column to propose a
 *      core/extended target.
 *   4. buildFieldMappingsFromDetection turns the DiscoveryResult into a draft
 *      v2 ConnectorFieldMappings so the Review step can start from a
 *      fully-populated config instead of a blank one.
 *
 * The autoSuggest heuristic is the one extracted from the old
 * StepFieldMapping.tsx `autoSuggest()` function so the backend (discover)
 * and frontend (review-step reshuffle) use the same scoring logic.
 */

import type {
  ConnectorFieldMappings,
  CoreFieldKey,
  FieldMappingExtended,
} from '../../../shared/fieldMappings';
import {
  CORE_FIELD_DEFINITIONS,
  defaultFieldMappings,
} from '../../../shared/fieldMappings';
import { parseCSVText } from './email';

export type DetectedFieldType = 'string' | 'number' | 'date' | 'id' | 'email' | 'phone';

export interface DetectedField {
  /** Original source column header as it appeared in the file. */
  name: string;
  /** Heuristic-inferred type of the column. */
  inferred_type: DetectedFieldType;
  /** Up to 5 unique sample values from the first rows. */
  sample_values: string[];
  /**
   * Aliases the discovery step thinks this column is known by. Populated
   * by Qwen-assisted discovery (PDF / email); for CSV it is just `[name]`.
   */
  inferred_aliases: string[];
  /** Best-guess target field (core key or extended key). */
  candidate_target?: string;
  /** Confidence score [0..1] for the candidate target. */
  confidence?: number;
  /** Sheet name — XLSX only. Undefined for CSV/PDF/email. */
  sheet_name?: string;
}

export interface DiscoveryResult {
  detected_fields: DetectedField[];
  sample_rows: Record<string, string>[];
  /** Short description of the layout (e.g. "CSV with 12 columns, 47 rows"). */
  layout_hint: string;
  warnings: string[];
}

/** Minimal Qwen call config for discovery helpers. Mirrors llm.ts shape. */
export interface QwenConfig {
  url?: string;
  secret?: string;
}

// =============================================================================
// Type inference heuristics
// =============================================================================

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;
const DATE_RE = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}-\d{1,2}-\d{2,4})$/;
// K00123, P000456, SO-123, SO-1, ORD-2026-001, INV123 — leading letters + digits/hyphens.
const ID_RE = /^[A-Za-z]{1,4}[-_]?\d{1,}[A-Za-z0-9-]*$/;

function inferType(values: string[]): DetectedFieldType {
  const nonEmpty = values.filter(v => v && v.trim().length > 0);
  if (nonEmpty.length === 0) return 'string';

  const count = nonEmpty.length;
  let emails = 0, numbers = 0, dates = 0, ids = 0;

  for (const v of nonEmpty) {
    const s = v.trim();
    if (EMAIL_RE.test(s)) { emails++; continue; }
    if (NUMBER_RE.test(s)) { numbers++; continue; }
    if (DATE_RE.test(s)) { dates++; continue; }
    if (ID_RE.test(s)) { ids++; continue; }
  }

  // Require majority of samples to confidently pick a non-string type.
  if (emails / count >= 0.6) return 'email';
  if (dates / count >= 0.6) return 'date';
  if (numbers / count >= 0.6) return 'number';
  if (ids / count >= 0.6) return 'id';
  return 'string';
}

function uniqueStrings(values: string[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const trimmed = (v ?? '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
}

// =============================================================================
// autoSuggestTarget — alias-table matcher shared between FE + BE
// =============================================================================

/**
 * Normalize a column header for alias matching:
 *  - lowercased
 *  - strip `.`, `#`, `:`, `()`, `[]` and other punctuation (kept as spaces)
 *  - collapse multi-space runs to single space
 *  - trim
 *
 * Preserves spaces so multi-word aliases like "sales order" survive, while
 * "Order #" -> "order" and "P.O. #" -> "p o". Also see `normNameTight` for
 * the no-whitespace variant used for tight abbreviations like "so#" -> "so".
 */
function normName(s: string): string {
  if (!s) return '';
  return s
    .toLowerCase()
    // Replace any non-alphanumeric run with a single space. This folds `#`,
    // `.`, `:`, `/`, `-`, `_`, `()`, `[]`, etc. into whitespace.
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tight variant: same as normName but strips whitespace entirely, so
 * "so #" -> "so", "p o" -> "po", "cust no" -> "custno". Useful for matching
 * abbreviations that may or may not have a separator.
 */
function normNameTight(s: string): string {
  return normName(s).replace(/\s+/g, '');
}

interface ScoredSuggestion {
  target: CoreFieldKey | null;
  confidence: number;
}

/**
 * Alias table. Each canonical field has a list of source-label variants that
 * should map to it. Entries are compared case-insensitively after `normName`,
 * so `"Order #"`, `"order no"`, and `"ORDER NUMBER"` all collapse to the same
 * bucket. Order matters only when two targets share an alias — first match
 * wins for exact-match ties, but scoring usually picks the clear winner.
 *
 * Keep the list sorted most-specific-first inside each canonical group so the
 * prefix / substring heuristics prefer the obvious matches.
 */
const FIELD_ALIASES: Record<CoreFieldKey, string[]> = {
  order_number: [
    'order number', 'order no', 'order num', 'order id', 'order',
    'ord number', 'ord no', 'ord num', 'ord id', 'ord',
    'sales order number', 'sales order no', 'sales order', 'sales ord',
    'so number', 'so no', 'so num', 'so id', 'so',
    'invoice number', 'invoice no', 'invoice', 'inv number', 'inv no', 'inv',
    'order hash',
  ],
  customer_number: [
    'customer number', 'customer no', 'customer num', 'customer id',
    'cust number', 'cust no', 'cust num', 'cust id', 'cust',
    'account number', 'account no', 'account id', 'account',
    'acct number', 'acct no', 'acct id', 'acct',
    'client number', 'client no', 'client id',
    'ship to', 'shipto', 'bill to', 'billto',
    // bare "customer" is included so "Customer #" -> "customer" still hits;
    // customer_name aliases also includes "customer" so scoring decides.
    'customer',
  ],
  customer_name: [
    'customer name', 'cust name', 'customer',
    'bill to name', 'billto name', 'ship to name', 'shipto name',
    'account name', 'acct name',
    'client name', 'client',
    'business name', 'company name', 'company',
    'name',
  ],
  po_number: [
    'po number', 'po no', 'po num', 'po id', 'po',
    'purchase order number', 'purchase order no', 'purchase order',
    'customer po number', 'customer po no', 'customer po',
    'cust po',
  ],
  product_name: [
    'product name', 'product description', 'product desc',
    'item name', 'item description', 'item desc',
    'description', 'desc',
    'sku name',
    'product', 'item',
  ],
  product_code: [
    'product code', 'product number', 'product no', 'product id',
    'item code', 'item number', 'item no', 'item id',
    'part number', 'part no', 'part num', 'part id', 'part',
    'material number', 'material no', 'material',
    'mfg number', 'mfg no', 'mfg',
    'sku',
  ],
  quantity: [
    'quantity', 'qty',
    'units', 'cases', 'cs', 'ea',
    'pieces', 'pcs',
    'count', 'amount',
  ],
  lot_number: [
    'lot number', 'lot no', 'lot num', 'lot id', 'lot code', 'lot',
    'batch number', 'batch no', 'batch num', 'batch id', 'batch code', 'batch',
    'lot code item date',
  ],
};

/**
 * Precompute normalized aliases once at module load. Each entry is
 * `[canonicalField, normSpaced, normTight]`.
 */
interface NormalizedAlias {
  field: CoreFieldKey;
  spaced: string;
  tight: string;
}

const NORMALIZED_ALIASES: NormalizedAlias[] = (() => {
  const out: NormalizedAlias[] = [];
  for (const key of Object.keys(FIELD_ALIASES) as CoreFieldKey[]) {
    for (const alias of FIELD_ALIASES[key]) {
      const spaced = normName(alias);
      if (!spaced) continue;
      out.push({ field: key, spaced, tight: spaced.replace(/\s+/g, '') });
    }
  }
  // Longest-alias-first so prefix/substring checks prefer specific matches
  // ("customer number") before generic ones ("customer").
  out.sort((a, b) => b.spaced.length - a.spaced.length);
  return out;
})();

/**
 * Ambiguous bare tokens that must never auto-match on their own. These are
 * words that could describe several fields ("number", "no"), so we only allow
 * them to match if combined with something more specific.
 */
const AMBIGUOUS_BARE = new Set(['number', 'no', 'num', 'id', 'code', '#']);

/**
 * Check whether `alias` appears inside `name` at word boundaries, e.g.
 * alias "lot" hits "lot code" and "lot number" but not "pilot".
 */
function hasWordBoundaryMatch(name: string, alias: string): boolean {
  if (!alias) return false;
  const pattern = `(?:^|\\s)${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`;
  return new RegExp(pattern).test(name);
}

/**
 * Score a name -> target mapping given the sample values. Returns the raw
 * pattern confidence, boosted / penalized by sample-value evidence:
 *   - +0.05 if samples look like the target (e.g. customer_number samples
 *     look like IDs).
 *   - -0.1 if samples look clearly incompatible (e.g. product_code ->
 *     numeric-only column).
 * Only used internally; exported for tests.
 */
export function scoreSuggestion(
  name: string,
  sampleValues: string[],
  target: CoreFieldKey,
  baseScore: number,
): number {
  const type = inferType(sampleValues);
  let score = baseScore;

  switch (target) {
    case 'order_number':
    case 'customer_number':
    case 'po_number':
    case 'lot_number':
    case 'product_code':
      if (type === 'id' || type === 'string') score += 0.03;
      if (type === 'email' || type === 'date') score -= 0.2;
      break;
    case 'quantity':
      if (type === 'number') score += 0.05;
      else score -= 0.15;
      break;
    case 'customer_name':
    case 'product_name':
      if (type === 'string') score += 0.02;
      if (type === 'number' || type === 'date') score -= 0.1;
      break;
  }

  // Clamp.
  if (score > 1) score = 1;
  if (score < 0) score = 0;
  return score;
}

/**
 * Suggest a canonical core-field target for a detected source column. Returns
 * `{ target: '__none__', confidence: 0 }` when nothing matched with enough
 * confidence — the caller should send that column to the extended pile.
 *
 * Scoring tiers (before sample-value adjustment):
 *   - Exact match (normalized) against any alias: **0.95**
 *   - Prefix match (normalized): **0.85**
 *   - Word-boundary substring match: **0.75**
 *   - Sample-pattern-only match (e.g. detecting K##### with no clear label): **0.55**
 *   - Nothing: **0.0**, target null
 *
 * The alias table is the single source of truth — shared between the backend
 * discover-schema endpoint and the frontend live-preview so they agree.
 */
export function autoSuggestTarget(
  name: string,
  sampleValues: string[] = [],
): { target: string; confidence: number } {
  const spaced = normName(name);
  if (!spaced) return { target: '__none__', confidence: 0 };
  const tight = spaced.replace(/\s+/g, '');

  // Guard: a bare ambiguous word like "Number" or "No" must never match.
  if (AMBIGUOUS_BARE.has(spaced) || AMBIGUOUS_BARE.has(tight)) {
    return { target: '__none__', confidence: 0 };
  }

  // Detect a "number-ish" suffix in the ORIGINAL name (before normalization):
  //   "Item #", "Item No", "Item Number", "Item Num", "Item ID"
  // When present, strongly prefer *_number / *_code targets over *_name ones.
  // Without this, "Item #" -> normalizes to "item" -> matches both product_name
  // (alias "item") and ties are broken by order.
  const numberishSuffix = /(\s*#\s*|\s+(no|num|number|id|code)\.?)\s*$/i.test(name.trim());
  const preferCodeTargets = numberishSuffix;

  const isNameTarget = (t: CoreFieldKey) => t === 'customer_name' || t === 'product_name';

  let best: ScoredSuggestion = { target: null, confidence: 0 };

  // Apply numberish-suffix penalty to name-type targets.
  const adjust = (field: CoreFieldKey, score: number): number => {
    if (preferCodeTargets && isNameTarget(field)) return score - 0.3;
    return score;
  };

  // When the original name had a numberish suffix like "Item #" / "Order No",
  // we synthesize an expanded form so aliases like "item number" can match
  // what would otherwise normalize to just "item". Without this, "Item #"
  // collapses to "item" and only product_name ("item") matches, missing
  // product_code ("item number", "item code"). Matching against both the
  // collapsed and expanded form lets us pick the stronger of the two.
  const expanded = numberishSuffix ? `${spaced} number` : null;
  const expandedTight = expanded ? expanded.replace(/\s+/g, '') : null;

  // Tier 1 — exact match (spaced or tight).
  for (const a of NORMALIZED_ALIASES) {
    const matchesCollapsed = a.spaced === spaced || a.tight === tight;
    const matchesExpanded = expanded != null && (a.spaced === expanded || a.tight === expandedTight);
    if (matchesCollapsed || matchesExpanded) {
      const score = adjust(a.field, scoreSuggestion(name, sampleValues, a.field, 0.95));
      if (score > best.confidence) best = { target: a.field, confidence: score };
    }
  }
  if (best.target && best.confidence >= 0.95) {
    return { target: best.target, confidence: best.confidence };
  }

  // Tier 2 — prefix match. The field name starts with the alias, or the
  // alias starts with the field name. Longest alias first (already sorted).
  if (!best.target) {
    for (const a of NORMALIZED_ALIASES) {
      if (a.spaced.length < 2) continue;
      const spacedPrefix = spaced.startsWith(a.spaced + ' ') || spaced === a.spaced;
      const tightPrefix = tight.startsWith(a.tight) && a.tight.length >= 2;
      if (spacedPrefix || tightPrefix) {
        const score = adjust(a.field, scoreSuggestion(name, sampleValues, a.field, 0.85));
        if (score > best.confidence) best = { target: a.field, confidence: score };
        if (best.confidence >= 0.85 && !isNameTarget(a.field)) break;
      }
    }
  }

  // Tier 3 — word-boundary substring match. Alias appears as a whole word
  // inside the field name. Skips very short aliases to avoid noise.
  if (!best.target) {
    for (const a of NORMALIZED_ALIASES) {
      if (a.spaced.length < 3) continue;
      if (hasWordBoundaryMatch(spaced, a.spaced)) {
        const score = adjust(a.field, scoreSuggestion(name, sampleValues, a.field, 0.75));
        if (score > best.confidence) best = { target: a.field, confidence: score };
      }
    }
  }

  // Tier 4 — sample-value pattern only (e.g. K##### customer number, LOT-### lot).
  // This is a weak signal so we only use it if nothing matched on name.
  if (!best.target && sampleValues.length > 0) {
    const patternTarget = guessTargetFromSamples(sampleValues);
    if (patternTarget) {
      best = { target: patternTarget, confidence: 0.55 };
    }
  }

  if (!best.target) {
    return { target: '__none__', confidence: 0 };
  }
  return { target: best.target, confidence: best.confidence };
}

/**
 * Last-ditch sample-shape heuristics. Used only when the column name gave us
 * zero signal. Deliberately conservative — we only match patterns that are
 * very distinctive (K##### / P##### customer codes, LOT-prefixed lot codes,
 * SO- / INV- / ORD- prefixed order numbers).
 */
function guessTargetFromSamples(samples: string[]): CoreFieldKey | null {
  const nonEmpty = samples.map(s => (s ?? '').trim()).filter(s => s.length > 0);
  if (nonEmpty.length === 0) return null;
  let custLike = 0, lotLike = 0, orderLike = 0;
  for (const s of nonEmpty) {
    if (/^[KP]\d{3,}$/i.test(s)) custLike++;
    else if (/^lot[-_ ]?\w+/i.test(s) || /^b(atch)?[-_ ]?\w+/i.test(s)) lotLike++;
    else if (/^(so|ord|inv)[-_ ]?\d+/i.test(s)) orderLike++;
  }
  const n = nonEmpty.length;
  if (custLike / n >= 0.6) return 'customer_number';
  if (lotLike / n >= 0.6) return 'lot_number';
  if (orderLike / n >= 0.6) return 'order_number';
  return null;
}

// =============================================================================
// CSV discovery
// =============================================================================

/**
 * Parse a CSV string and return a DiscoveryResult. Takes up to the first
 * `sampleRowLimit` rows (default 5) for inference and sample display.
 *
 * This path is intentionally narrow — no quoted-field handling beyond what
 * parseCSVText already does, no encoding detection, no header-row fallback.
 * The user drops a real CSV file during the wizard; anything weirder gets
 * flagged in `warnings`.
 */
export function discoverFromCSV(csvText: string, sampleRowLimit = 5): DiscoveryResult {
  const warnings: string[] = [];
  const { headers, rows } = parseCSVText(csvText);

  if (headers.length === 0) {
    warnings.push('CSV appears empty — no header row detected');
    return {
      detected_fields: [],
      sample_rows: [],
      layout_hint: 'Empty CSV',
      warnings,
    };
  }

  if (rows.length === 0) {
    warnings.push('CSV has a header row but no data rows');
  }

  const sampleRows = rows.slice(0, sampleRowLimit);
  const detectedFields: DetectedField[] = headers.map(header => {
    const columnValues = rows.map(r => r[header] || '').filter(v => v.length > 0);
    const type = inferType(columnValues.slice(0, 20));
    const samples = uniqueStrings(columnValues, 5);
    const suggestion = autoSuggestTarget(header, samples);
    return {
      name: header,
      inferred_type: type,
      sample_values: samples,
      inferred_aliases: [header],
      candidate_target: suggestion.target !== '__none__' ? suggestion.target : undefined,
      confidence: suggestion.target !== '__none__' ? suggestion.confidence : undefined,
    };
  });

  // Check for duplicate headers — hand-tagged CSV exports often smash two
  // columns into the same name which breaks our row->map conversion.
  const seenHeaders = new Set<string>();
  for (const h of headers) {
    if (seenHeaders.has(h)) {
      warnings.push(`Duplicate header detected: "${h}" — downstream rows will only capture the last occurrence`);
    }
    seenHeaders.add(h);
  }

  return {
    detected_fields: detectedFields,
    sample_rows: sampleRows,
    layout_hint: `CSV with ${headers.length} column${headers.length === 1 ? '' : 's'}, ${rows.length} row${rows.length === 1 ? '' : 's'}`,
    warnings,
  };
}

// =============================================================================
// XLSX discovery (no Qwen needed — pure sheet parsing + CSV reuse)
// =============================================================================

/**
 * Scan rows for a `(K00166) NAME:` / `(P1865) NAME:` block-per-customer
 * pattern. Returns a list of detected blocks if the pattern is found on at
 * least 2 rows (so a stray match in a tabular sheet doesn't flip the layout
 * hint).
 */
const BLOCK_PAREN_RE = /^\s*\(([KP]\d{3,})\)\s+(.+?)[:\s]\s*(.*)$/;
const BLOCK_DASH_RE = /^\s*([KP]\d{3,})\s*[-:]\s*(.+)$/;
const EMAIL_GLOBAL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

interface DetectedBlockCustomer {
  customer_number: string;
  customer_name: string;
  emails: string[];
}

function detectCustomerBlocks(rows: string[]): DetectedBlockCustomer[] {
  const out: DetectedBlockCustomer[] = [];
  const scanLimit = Math.min(rows.length, 200);
  for (let i = 0; i < scanLimit; i++) {
    const row = rows[i];
    let m = row.match(BLOCK_PAREN_RE);
    let custNum: string | null = null;
    let custName: string | null = null;
    let tail = '';
    if (m) {
      custNum = m[1];
      custName = (m[2] || '').replace(/[,:]+$/, '').trim();
      tail = m[3] || '';
    } else {
      m = row.match(BLOCK_DASH_RE);
      if (m) {
        custNum = m[1];
        custName = (m[2] || '').replace(/[,:]+$/, '').trim();
      }
    }
    if (!custNum || !custName) continue;
    // Collect emails from this line and the next few rows (until we hit
    // another customer block or a blank row).
    const joined = [tail, ...rows.slice(i + 1, i + 4)].join(' ');
    const emails = Array.from(new Set((joined.match(EMAIL_GLOBAL_RE) || []).map(e => e.trim())));
    out.push({ customer_number: custNum, customer_name: custName, emails });
  }
  return out;
}

/**
 * Discover schema from an XLSX workbook.
 *
 * - Skips sheets whose name contains "inactive" (matches the Weekly Master
 *   `INACTIVE_CUST` convention).
 * - For each remaining sheet, converts to CSV and reuses discoverFromCSV so
 *   type inference + autoSuggest stays consistent with the CSV path.
 * - Stamps `sheet_name` on every returned DetectedField so the frontend
 *   can render a sheet picker.
 * - Detects block-per-customer layouts (e.g. `(K00166) CHUCKANUT BAY FOODS:`)
 *   and synthesizes customer_number / customer_name / customer_emails
 *   detected fields ON TOP OF whatever tabular rows appear below the blocks.
 */
export async function discoverFromXLSX(buffer: ArrayBuffer): Promise<DiscoveryResult> {
  const warnings: string[] = [];
  const detectedFields: DetectedField[] = [];
  let sampleRows: Record<string, string>[] = [];
  let layoutHint = 'XLSX workbook';
  let anyBlockLayout = false;
  let processedSheetCount = 0;
  let firstRealSheetName: string | null = null;

  let XLSX: typeof import('xlsx');
  try {
    XLSX = await import('xlsx');
  } catch (err) {
    return {
      detected_fields: [],
      sample_rows: [],
      layout_hint: 'XLSX parse failed',
      warnings: [`Failed to load XLSX parser: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  let workbook: import('xlsx').WorkBook;
  try {
    workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
  } catch (err) {
    return {
      detected_fields: [],
      sample_rows: [],
      layout_hint: 'XLSX parse failed',
      warnings: [`Unable to parse XLSX: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  // Composite dedupe key on name + sheet so the same column in different
  // sheets survives, but two "Order #" columns in one sheet do not.
  const seen = new Set<string>();

  for (const sheetName of workbook.SheetNames) {
    if (/inactive/i.test(sheetName)) {
      warnings.push(`Skipped sheet: ${sheetName} (inactive customers excluded)`);
      continue;
    }
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    const csv = XLSX.utils.sheet_to_csv(sheet, { FS: ',', RS: '\n', blankrows: false });
    if (!csv || !csv.trim()) continue;

    processedSheetCount++;
    if (!firstRealSheetName) firstRealSheetName = sheetName;

    // Pre-scan for block-per-customer pattern.
    const rawRows = csv.split('\n').map(r => r.trim());
    const blocks = detectCustomerBlocks(rawRows);
    const sheetBlockLayout = blocks.length >= 2;
    if (sheetBlockLayout) anyBlockLayout = true;

    if (sheetBlockLayout) {
      // Synthesize customer_number / customer_name / customer_emails fields.
      const customerNumbers = uniqueStrings(blocks.map(b => b.customer_number), 5);
      const customerNames = uniqueStrings(blocks.map(b => b.customer_name), 5);
      const allEmails = blocks.flatMap(b => b.emails);
      const customerEmails = uniqueStrings(allEmails, 5);

      const pushField = (f: DetectedField) => {
        const key = `${f.name}::${f.sheet_name ?? ''}`;
        if (seen.has(key)) return;
        seen.add(key);
        detectedFields.push(f);
      };

      pushField({
        name: 'customer_number',
        inferred_type: 'id',
        sample_values: customerNumbers,
        inferred_aliases: ['customer_number', 'cust #', 'K# / P#'],
        candidate_target: 'customer_number',
        confidence: 0.95,
        sheet_name: sheetName,
      });
      pushField({
        name: 'customer_name',
        inferred_type: 'string',
        sample_values: customerNames,
        inferred_aliases: ['customer_name', 'name'],
        candidate_target: 'customer_name',
        confidence: 0.9,
        sheet_name: sheetName,
      });
      if (customerEmails.length > 0) {
        pushField({
          name: 'customer_emails',
          inferred_type: 'email',
          sample_values: customerEmails,
          inferred_aliases: ['emails', 'contact'],
          candidate_target: undefined,
          confidence: 0.85,
          sheet_name: sheetName,
        });
      }
      warnings.push(`Sheet "${sheetName}": detected block-per-customer layout (${blocks.length} customers found)`);
    }

    // Either way, also run CSV discovery — even block-layout sheets usually
    // have a tabular region underneath (PO #, SKU, LOT CODE, etc.) we want
    // to surface.
    const csvResult = discoverFromCSV(csv);
    for (const f of csvResult.detected_fields) {
      const key = `${f.name}::${sheetName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      detectedFields.push({ ...f, sheet_name: sheetName });
    }

    // Record sample rows from the first sheet (whichever wins the discovery).
    if (sampleRows.length === 0 && csvResult.sample_rows.length > 0) {
      sampleRows = csvResult.sample_rows.slice(0, 3);
    }
  }

  if (processedSheetCount === 0) {
    warnings.unshift('No readable sheets found in workbook');
  }

  layoutHint = anyBlockLayout
    ? `XLSX with ${processedSheetCount} sheet${processedSheetCount === 1 ? '' : 's'} (block-per-customer layout)`
    : `XLSX with ${processedSheetCount} sheet${processedSheetCount === 1 ? '' : 's'}, ${detectedFields.length} detected field${detectedFields.length === 1 ? '' : 's'}`;

  return {
    detected_fields: detectedFields,
    sample_rows: sampleRows,
    layout_hint: layoutHint,
    warnings,
  };
}

// =============================================================================
// PDF discovery (uses Qwen)
// =============================================================================

/**
 * Discover schema from a PDF buffer.
 *
 * Uses unpdf to extract text, trims to the first 4000 chars (schema discovery
 * is a sampling exercise, not full extraction), and calls Qwen with the schema
 * discovery prompt. Returns an empty result with a warning when:
 *  - the PDF is scanned (unpdf returns no text)
 *  - Qwen is not configured
 *  - Qwen returns an error or invalid JSON
 */
export async function discoverFromPDF(
  buffer: ArrayBuffer,
  qwenConfig: QwenConfig,
): Promise<DiscoveryResult> {
  let text = '';
  try {
    const { extractText } = await import('unpdf');
    const result = await extractText(new Uint8Array(buffer), { mergePages: true });
    text = Array.isArray(result.text) ? result.text.join('\n') : (result.text || '');
  } catch (err) {
    return {
      detected_fields: [],
      sample_rows: [],
      layout_hint: 'PDF parse failed',
      warnings: [`Failed to extract PDF text: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  if (!text || text.trim().length < 50) {
    return {
      detected_fields: [],
      sample_rows: [],
      layout_hint: 'PDF has no extractable text',
      warnings: [
        'PDF appears to be scanned (no extractable text). OCR is not supported for schema discovery. Try exporting the source as CSV or XLSX.',
      ],
    };
  }

  const trimmed = text.slice(0, 4000);
  const result = await callQwenForDiscovery(qwenConfig, trimmed, 'pdf');
  if (!result) {
    return {
      detected_fields: [],
      sample_rows: [],
      layout_hint: 'PDF schema discovery unavailable',
      warnings: ['Schema discovery AI is not configured or unreachable — please map the fields manually.'],
    };
  }
  return result;
}

// =============================================================================
// Email (.eml) discovery
// =============================================================================

/**
 * Detect whether a text blob looks like an RFC822 email by scanning the first
 * ~10 lines for well-known header fields. Used to auto-route misnamed files
 * (e.g. an email saved as `.txt`) away from the CSV parser — which would
 * otherwise shred a `Subject: Daily COA Report - April 6, 2026` line into
 * bogus columns on the comma.
 *
 * Require at least 2 distinct known header fields at start of line so we
 * don't false-positive on CSV rows that happen to contain `Key: value` text.
 */
const KNOWN_EMAIL_HEADERS = new Set([
  'subject', 'from', 'date', 'to', 'reply-to', 'return-path',
  'mime-version', 'delivered-to', 'received', 'message-id', 'content-type',
]);

export function looksLikeEmail(text: string): boolean {
  if (!text || text.length < 10) return false;
  // Only inspect the first ~2KB — header blocks are small.
  const head = text.slice(0, 2048);
  const firstLines = head.split(/\r?\n/).slice(0, 10).join('\n');
  const headerNames = new Set<string>();
  const lineRe = /^([A-Za-z][A-Za-z0-9-]*):\s/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(firstLines)) !== null) {
    const name = m[1].toLowerCase();
    if (KNOWN_EMAIL_HEADERS.has(name)) headerNames.add(name);
  }
  return headerNames.size >= 2;
}

/**
 * Minimal .eml parser — extracts From, Subject, and the body. Handles
 * multipart/alternative by picking the text/plain part when present, else
 * the first text/html part with tags stripped.
 */
export function parseEmlText(raw: string): { from: string; subject: string; body: string } {
  // Split headers from body at the first blank line.
  const split = raw.replace(/\r\n/g, '\n').split(/\n\n/);
  const headerBlock = split[0] || '';
  let body = split.slice(1).join('\n\n');

  const headers: Record<string, string> = {};
  let currentKey: string | null = null;
  for (const line of headerBlock.split('\n')) {
    if (/^\s/.test(line) && currentKey) {
      headers[currentKey] += ' ' + line.trim();
      continue;
    }
    const m = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (m) {
      currentKey = m[1].toLowerCase();
      headers[currentKey] = m[2];
    }
  }

  // Check for multipart content.
  const contentType = headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?`));
    // Prefer text/plain; fall back to text/html.
    let textPlain = '';
    let textHtml = '';
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const [partHeaders, ...partBodyLines] = trimmed.split(/\n\n/);
      const partBody = partBodyLines.join('\n\n');
      if (/content-type:\s*text\/plain/i.test(partHeaders) && !textPlain) {
        textPlain = partBody;
      } else if (/content-type:\s*text\/html/i.test(partHeaders) && !textHtml) {
        textHtml = partBody;
      }
    }
    body = textPlain || textHtml || body;
  }

  // Strip HTML tags if body looks like HTML.
  if (/<html|<body|<table|<div|<p>/i.test(body)) {
    body = body
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#?\w+;/g, '');
  }

  return {
    from: headers['from'] || '',
    subject: headers['subject'] || '',
    body: body.trim(),
  };
}

/**
 * Discover schema from a raw .eml text. Parses the message, extracts the
 * body, and runs it through Qwen for schema discovery.
 */
export async function discoverFromEmail(
  rawText: string,
  qwenConfig: QwenConfig,
): Promise<DiscoveryResult> {
  const parsed = parseEmlText(rawText);
  const body = parsed.body;
  if (!body || body.length < 20) {
    return {
      detected_fields: [],
      sample_rows: [],
      layout_hint: 'Email has no body text',
      warnings: ['Email body was empty or too short to analyze. Paste a richer sample.'],
    };
  }
  const trimmed = body.slice(0, 4000);
  const result = await callQwenForDiscovery(qwenConfig, trimmed, 'email');
  if (!result) {
    return {
      detected_fields: [],
      sample_rows: [],
      layout_hint: 'Email schema discovery unavailable',
      warnings: ['Schema discovery AI is not configured or unreachable — please map the fields manually.'],
    };
  }
  return result;
}

// =============================================================================
// Qwen discovery prompt + caller
// =============================================================================

export function getSchemaDiscoveryPrompt(): string {
  return `/no_think
You are a data schema analyzer, NOT a data extractor. Given a sample of an
ERP/WMS document (PDF text, email body, or spreadsheet excerpt), identify the
LOGICAL FIELDS the document contains and return a structured schema.

Return JSON in this exact format and nothing else:
{
  "detected_fields": [
    {
      "name": "string - the source-side label exactly as it appears",
      "inferred_type": "string | number | date | id | email | phone",
      "sample_values": ["3-5 example values copied verbatim"],
      "inferred_aliases": ["other labels that appear to refer to the same field"],
      "candidate_target": "order_number | customer_number | customer_name | po_number | product_name | product_code | quantity | lot_number | null",
      "confidence": 0.0
    }
  ],
  "layout_hint": "tabular | block_per_customer | key_value | mixed",
  "warnings": []
}

Rules:
- Identify EVERY distinct field you can see, including ones without an obvious
  canonical mapping. Set candidate_target to null for those.
- DO NOT extract every order. Only sample 3-5 example values per field.
- Detect block-per-customer layouts: "(K00166) CHUCKANUT BAY FOODS:" followed
  by indented rows is block_per_customer, not tabular.
- A multi-digit numeric ID adjacent to a K#####/P###### code is order_number,
  not customer_number.
- Customer names never end in numeric digits.
- Return valid JSON only.`;
}

/**
 * Call Qwen with the schema-discovery prompt against a chunk of source text.
 * Returns a DiscoveryResult, or `null` when Qwen is unconfigured / errored.
 *
 * Max tokens is capped at 2000 because the schema output is small (field
 * list, not extracted rows). Single-shot — no chunking; callers pre-trim.
 */
async function callQwenForDiscovery(
  qwenConfig: QwenConfig,
  text: string,
  kind: 'pdf' | 'email',
): Promise<DiscoveryResult | null> {
  if (!qwenConfig.url) return null;

  const systemPrompt = getSchemaDiscoveryPrompt();
  const userMessage = `Source kind: ${kind}\n\n${text}`;

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (qwenConfig.secret) headers['Authorization'] = `Bearer ${qwenConfig.secret}`;

    const response = await fetch(`${qwenConfig.url}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'Qwen3-8B',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.1,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) return null;

    const result = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = result.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content) as {
      detected_fields?: Array<Record<string, unknown>>;
      layout_hint?: string;
      warnings?: string[];
    };

    const detectedFields: DetectedField[] = Array.isArray(parsed.detected_fields)
      ? parsed.detected_fields
        .map(raw => normalizeQwenDetectedField(raw))
        .filter((f): f is DetectedField => f !== null)
      : [];

    return {
      detected_fields: detectedFields,
      sample_rows: [],
      layout_hint: typeof parsed.layout_hint === 'string' ? parsed.layout_hint : 'unknown',
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter(w => typeof w === 'string') : [],
    };
  } catch {
    return null;
  }
}

function normalizeQwenDetectedField(raw: Record<string, unknown>): DetectedField | null {
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return null;

  const allowedTypes: DetectedFieldType[] = ['string', 'number', 'date', 'id', 'email', 'phone'];
  const rawType = typeof raw.inferred_type === 'string' ? raw.inferred_type : 'string';
  const inferredType: DetectedFieldType = allowedTypes.includes(rawType as DetectedFieldType)
    ? (rawType as DetectedFieldType)
    : 'string';

  const sampleValues = Array.isArray(raw.sample_values)
    ? raw.sample_values.filter((v): v is string => typeof v === 'string').slice(0, 5)
    : [];

  const inferredAliases = Array.isArray(raw.inferred_aliases)
    ? raw.inferred_aliases.filter((v): v is string => typeof v === 'string')
    : [name];

  const candidateTargetRaw = raw.candidate_target;
  const candidateTarget = typeof candidateTargetRaw === 'string' && candidateTargetRaw !== 'null'
    ? candidateTargetRaw
    : undefined;

  const rawConfidence = typeof raw.confidence === 'number' ? raw.confidence : undefined;
  const confidence = rawConfidence !== undefined
    ? Math.max(0, Math.min(1, rawConfidence))
    : undefined;

  return {
    name,
    inferred_type: inferredType,
    sample_values: sampleValues,
    inferred_aliases: inferredAliases.length > 0 ? inferredAliases : [name],
    candidate_target: candidateTarget,
    confidence,
  };
}

// =============================================================================
// Draft mapping builder
// =============================================================================

/**
 * Turn a DiscoveryResult into a starting-point v2 field_mappings config.
 * Each detected column with a candidate_target is slotted into either the
 * matching core field's source_labels (if the target is a CoreFieldKey) or
 * into a new extended[] entry (if the target is __none__ or not a core key).
 *
 * Confidence is NOT persisted in ConnectorFieldMappings — the wizard shows
 * it on the Review step, and the final saved config just has source_labels.
 */
export function buildFieldMappingsFromDetection(detection: DiscoveryResult): ConnectorFieldMappings {
  const out = defaultFieldMappings();

  // Reset every core field's source_labels so the draft reflects the
  // ACTUAL detected columns, not the default alias list (which would
  // confuse the wizard's Review step with "why is there an alias I never
  // saw in my sample?").
  for (const def of CORE_FIELD_DEFINITIONS) {
    out.core[def.key].source_labels = [];
    out.core[def.key].enabled = false;
  }

  const extendedEntries: FieldMappingExtended[] = [];
  const coreFieldKeys = new Set<string>(CORE_FIELD_DEFINITIONS.map(d => d.key));

  for (const field of detection.detected_fields) {
    const target = field.candidate_target;
    if (target && coreFieldKeys.has(target)) {
      const coreKey = target as CoreFieldKey;
      if (!out.core[coreKey].source_labels.includes(field.name)) {
        out.core[coreKey].source_labels.push(field.name);
      }
      out.core[coreKey].enabled = true;
    } else {
      // Unmapped column — offer it as an extended field. Key is the snake_cased
      // source header so the user can see the linkage at a glance.
      const key = toSnakeCase(field.name);
      if (!key) continue;
      if (coreFieldKeys.has(key)) continue; // avoid collision with a core key
      extendedEntries.push({
        key,
        label: field.name,
        source_labels: [field.name],
        format_hint: field.sample_values[0] ? `e.g. ${field.sample_values[0]}` : undefined,
      });
    }
  }

  // Always ensure order_number is enabled — even if nothing matched, the
  // wizard will surface an inline error the user can fix by pointing it at
  // one of the detected columns.
  if (!out.core.order_number.enabled) {
    out.core.order_number.enabled = true;
  }

  out.extended = extendedEntries;
  return out;
}

/**
 * Convert an arbitrary string to snake_case, dropping anything non-alphanumeric
 * and collapsing runs. "Ship Date" -> "ship_date", "Cust #" -> "cust".
 */
function toSnakeCase(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}
