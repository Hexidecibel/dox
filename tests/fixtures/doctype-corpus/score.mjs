/**
 * Scoring for the document-type extraction corpus.
 *
 * PURE. It takes a manifest document, the extraction the model produced, and
 * the text layer the model was actually shown, and returns one row per graded
 * field. No I/O, no model, no clock — so `bin/measure-doctype-extraction` and a
 * vitest suite can drive the identical logic, and a re-score of a saved run
 * gives byte-identical numbers.
 *
 * THE BUCKETS, and why they are not collapsible into "right / wrong":
 *
 *   correct              truth present, model matched it
 *   wrong_value          truth present, model emitted something else
 *   missed               truth present, model emitted nothing
 *   correct_null         truth is NULL and the model said nothing (or said so
 *                        explicitly: "none", "not applicable")
 *   fabricated_misfiled  truth is NULL, the model emitted a value that IS
 *                        printed somewhere on the page — a reading error
 *   fabricated_invented  truth is NULL, the model emitted a value that appears
 *                        NOWHERE on the page — supplied out of world knowledge
 *
 * Fabrication is kept as its own number everywhere and is never folded into a
 * generic "incorrect" bucket: in this product a wrong value a reviewer can
 * check against the page is a different failure from a value the page does not
 * contain, and the second one is the one that gets a certificate accepted for a
 * claim nobody made. The two fabrication kinds are also never merged — a
 * misfile is a misread of the document, an invention is not about the document
 * at all. `fabricated` (the headline the task asks for) is their sum, and every
 * report prints all three.
 *
 * WHICH KEY CARRIES THE ANSWER. `extractFields` returns an OPEN field object:
 * canonicalizeFields maps a fixed alias set onto canonical names and lets every
 * other key through verbatim. So the manifest names, per graded field, the full
 * set of keys that may legitimately carry its answer (`key_groups` in
 * corpus.json). A value under ANY of them is the model's answer — which is what
 * makes a null-truth judgement honest: the model does not escape a fabrication
 * charge by putting the invented value under a key we were not watching.
 */

/**
 * The canonical field names llm.ts rule 1 tells the model to use. A graded
 * field OUTSIDE this set has no slot in the extractor's schema at all, so a
 * miss on it means something different: not "the model misread the page" but
 * "there was nowhere to put the answer". The two are reported separately —
 * merging them would blame the model for a schema decision, or hide a schema
 * gap behind a model score.
 */
export const CANONICAL_FIELDS = new Set([
  'supplier_name', 'customer_name', 'product_name', 'product_code',
  'lot_number', 'batch_number', 'po_number', 'code_date', 'expiration_date',
  'document_expires_on', 'ship_date', 'grade', 'plant_number', 'net_weight',
  'order_number',
  // Added to rule 1 on 2026-09-02, after the first run of this corpus measured
  // 60 of 66 value failures as "the model read the page and had nowhere to put
  // the answer". Note what this does to the BY SCHEMA SLOT table: it MOVES
  // these rows from the "no field in schema" line to the "canonical field"
  // line, so that split is not comparable across the change. That is the
  // intended reading — the schema gap is meant to disappear, not to be scored
  // around — but a before/after of those two lines is apples to oranges and
  // the overall value accuracy is the number to compare.
  'issuing_body', 'certificate_number', 'scheme', 'kosher_status',
  'gluten_threshold', 'allergens', 'country_of_origin', 'revision_date',
  'signatory',
  // Added to rule 1 on 2026-09-03. It is the ANCHOR shared/renewalPeriod.ts
  // counts a renewal period FROM, and nothing extracted it, so every
  // period-based renewal proposal resolved to `unresolvable`. The graded rows
  // that used to be called `issue_date` are this field renamed — the schema
  // slot they were measuring the absence of now exists.
  'effective_date',
]);

/** Case-fold, dash-fold, quote-fold, strip surrounding punctuation, collapse whitespace. */
export function normalize(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[.,;:()"'®™]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** "Sept" before "Sep" before "Se" — longest sensible prefix wins. */
function monthOf(word) {
  const w = String(word).toLowerCase();
  return MONTHS[w.slice(0, 4)] ?? MONTHS[w.slice(0, 3)] ?? null;
}

function iso(y, m, d) {
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Parse the date formats these documents actually print, into YYYY-MM-DD.
 * Returns null when the string is not a single unambiguous date.
 *
 * TWO-DIGIT YEARS follow llm.ts rule 2 (they mean 2000s). NUMERIC ORDER is read
 * month-first, matching the same rule, EXCEPT where the first number exceeds 12
 * — every day-first date in this corpus (30/09/2026, 19/05/26, 14/08/2026) is
 * of that shape by construction, so no genuinely ambiguous string is silently
 * resolved here.
 */
export function parseDate(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[\u2010-\u2015]/g, '-').trim();
  if (!s) return null;

  let m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return iso(+m[1], +m[2], +m[3]);

  m = s.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
  if (m) {
    let [, a, b, y] = m;
    let year = +y;
    if (year < 100) year += 2000;
    let mon = +a, day = +b;
    if (mon > 12 && day <= 12) { mon = +b; day = +a; }
    return iso(year, mon, day);
  }

  // 4 July 2026 / 04-JUL-2026 / 4 Jul 26
  m = s.match(/\b(\d{1,2})[\s-]+([A-Za-z]{3,9})\.?[\s-]+(\d{2,4})\b/);
  if (m) {
    const mon = monthOf(m[2]);
    let year = +m[3];
    if (year < 100) year += 2000;
    if (mon) return iso(year, mon, +m[1]);
  }

  // July 4, 2026 / Jul 4 2026 / July 4th, 2026
  m = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})\b/);
  if (m) {
    const mon = monthOf(m[1]);
    let year = +m[3];
    if (year < 100) year += 2000;
    if (mon) return iso(year, mon, +m[2]);
  }
  return null;
}

/** Resolve a field spec's key list from the manifest's shared groups. */
export function keysFor(field, keyGroups) {
  const base = field.keys_ref ? (keyGroups[field.keys_ref] || []) : [];
  const extra = field.keys || [];
  const all = [field.name, ...base, ...extra];
  return [...new Set(all)];
}

function isEmpty(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

/**
 * Which key did the model answer under, and with what? Preference order is the
 * field's own canonical name first, then the declared group order — so a value
 * under `document_expires_on` beats the same value under `valid_through`, which
 * is the shape production stores.
 */
export function pickEmitted(field, keyGroups, fields) {
  const keys = keysFor(field, keyGroups);
  const hits = [];
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(fields, k) && !isEmpty(fields[k])) {
      hits.push({ key: k, value: String(fields[k]).trim() });
    }
  }
  return { chosen: hits[0] || null, all: hits };
}

function textMatches(emitted, field) {
  const e = normalize(emitted);
  if (!e) return false;
  const candidates = [field.truth, ...(field.accept || [])].filter((c) => c != null);
  for (const c of candidates) {
    const n = normalize(c);
    if (!n) continue;
    if (e === n) return true;
    if (e.includes(n)) return true;
  }
  // A date written in another format still answers a text-mode field.
  const et = parseDate(emitted);
  if (et && candidates.some((c) => parseDate(c) === et)) return true;
  return false;
}

function tokensMatch(emitted, field) {
  const e = normalize(emitted);
  if (!e) return false;
  for (const t of field.tokens_all || []) if (!e.includes(normalize(t))) return false;
  for (const t of field.tokens_none || []) if (e.includes(normalize(t))) return false;
  const any = field.tokens_any || [];
  if (any.length && !any.some((t) => e.includes(normalize(t)))) return false;
  return true;
}

function isNullEquivalent(emitted, field) {
  const e = normalize(emitted);
  if (!e) return true;
  for (const t of field.null_equivalents || []) {
    const n = normalize(t);
    if (n && (e === n || e.includes(n))) return true;
  }
  return false;
}

function matchesDistractor(emitted, field) {
  const e = normalize(emitted);
  const ed = parseDate(emitted);
  for (const d of field.distractors || []) {
    const n = normalize(d);
    if (n && (e === n || e.includes(n) || n.includes(e))) return d;
    if (ed && parseDate(d) === ed) return d;
  }
  return null;
}

/**
 * Is this value printed on the page at all? The last line between "misread the
 * document" and "did not read the document". Compared against the text the
 * MODEL was given, not against the HTML — a value lost by OCR was, for this
 * run, genuinely not on the page.
 */
function appearsInText(emitted, docText) {
  const e = normalize(emitted);
  if (e.length < 3) return false;
  const t = normalize(docText);
  if (t.includes(e)) return true;
  const d = parseDate(emitted);
  if (d) {
    const [y, m, day] = d.split('-');
    const variants = [
      `${+m}/${+day}/${y}`, `${m}/${day}/${y}`, `${m}/${day}/${y.slice(2)}`,
      `${+day}/${+m}/${y}`, `${day}/${m}/${y}`, d,
    ];
    if (variants.some((v) => t.includes(normalize(v)))) return true;
  }
  return false;
}

/** Score one graded field. Returns a row with a bucket and enough detail to argue with it. */
export function scoreField(field, keyGroups, extraction, docText) {
  const fields = extraction.fields || {};
  const { chosen, all } = pickEmitted(field, keyGroups, fields);
  const emitted = chosen ? chosen.value : null;
  const row = {
    field: field.name,
    canonical: CANONICAL_FIELDS.has(field.name),
    truth: field.truth ?? null,
    emitted,
    emitted_key: chosen ? chosen.key : null,
    keys_hit: all.map((h) => h.key),
    why: field.why || null,
  };

  if (field.truth === null || field.truth === undefined) {
    if (emitted === null || isNullEquivalent(emitted, field)) {
      row.bucket = 'correct_null';
      return row;
    }
    const d = matchesDistractor(emitted, field);
    if (d) {
      row.bucket = 'fabricated_misfiled';
      row.detail = `matched the printed decoy ${JSON.stringify(d)}`;
      return row;
    }
    if (appearsInText(emitted, docText)) {
      row.bucket = 'fabricated_misfiled';
      row.detail = 'the value is printed on the page, but not as this field';
      return row;
    }
    row.bucket = 'fabricated_invented';
    row.detail = 'this value appears nowhere in the text the model was given';
    return row;
  }

  if (emitted === null) {
    row.bucket = 'missed';
    return row;
  }
  const ok = field.match === 'date'
    ? parseDate(emitted) === field.truth
    : field.match === 'tokens'
      ? tokensMatch(emitted, field)
      : textMatches(emitted, field);
  row.bucket = ok ? 'correct' : 'wrong_value';
  return row;
}

/** Score one document: every graded field, the document-type guess, table claims. */
export function scoreDocument(doc, keyGroups, extraction, docText) {
  const rows = (doc.fields || []).map((f) => scoreField(f, keyGroups, extraction, docText));

  const guess = extraction.documentType || null;
  const accept = doc.document_type_accept || [];
  const g = normalize(guess);
  const matched = !!g && accept.some((a) => {
    const n = normalize(a);
    return g === n || g.includes(n) || n.includes(g);
  });
  // `document_type_expected_none` says the correct answer is that NOTHING in
  // this tenant's catalog fits, so leaving the type unresolved for a human is
  // right and any confident answer is wrong. The synthetic corpus never needed
  // it — every fixture there was written against a type in the FSQA pack — but
  // eighteen of the real corpus's documents (tests/fixtures/real-corpus) are
  // supplier statements with no matching type, and scoring "none" as a miss
  // would report the classifier's correct behaviour as its failure.
  //
  // A document may carry the flag AND an accept list, and then either answer
  // counts. That is for the two cases where the pack holds an adjacent-but-not-
  // equal type (a Bioengineered STATEMENT against "Non-GMO Certificate") and
  // the disagreement is worth recording rather than resolving.
  //
  // Absent the flag this is byte-identical to what it was.
  const expectedNone = doc.document_type_expected_none === true;
  const docTypeOk = expectedNone ? (!g || matched) : matched;

  const cells = [];
  for (const t of extraction.tables || []) {
    for (const h of t.headers || []) cells.push(String(h ?? ''));
    for (const r of t.rows || []) for (const c of r) cells.push(String(c ?? ''));
  }
  const flatCells = normalize(cells.join(' | '));
  const tableClaims = (doc.tables_must_contain || []).map((s) => ({
    value: s,
    found: flatCells.includes(normalize(s)),
  }));

  return {
    id: doc.id,
    type: doc.type,
    type_slug: doc.type_slug,
    tier: doc.tier,
    rows,
    document_type: { guess, ok: docTypeOk, accept, expected_none: expectedNone },
    part_of: doc.part_of || null,
    tables: { claims: tableClaims, table_count: (extraction.tables || []).length },
    field_count: Object.keys(extraction.fields || {}).length,
    confidence: extraction.confidence || null,
    served_model: extraction.served_model || null,
  };
}

export const BUCKETS = [
  'correct', 'wrong_value', 'missed',
  'correct_null', 'fabricated_misfiled', 'fabricated_invented',
];

export function emptyCounts() {
  const c = {};
  for (const b of BUCKETS) c[b] = 0;
  return c;
}

export function addRow(counts, row) {
  counts[row.bucket] = (counts[row.bucket] || 0) + 1;
}

/**
 * Two rates, printed side by side and never merged:
 *   value_accuracy   correct / (correct + wrong_value + missed)   — over fields
 *                    that HAVE an answer. What "did it read the document" means.
 *   null_accuracy    correct_null / (correct_null + fabricated_*) — over fields
 *                    whose answer is nothing. What "did it invent" means.
 * A single blended figure would let a model that answers everything look good
 * on documents where the right answer is silence, which is the whole point of
 * measuring this corpus.
 */
export function rates(counts) {
  const present = counts.correct + counts.wrong_value + counts.missed;
  const absent = counts.correct_null + counts.fabricated_misfiled + counts.fabricated_invented;
  return {
    present_n: present,
    absent_n: absent,
    value_accuracy: present ? counts.correct / present : null,
    null_accuracy: absent ? counts.correct_null / absent : null,
    fabricated: counts.fabricated_misfiled + counts.fabricated_invented,
  };
}

export function summarize(documents) {
  const overall = emptyCounts();
  const byType = {};
  const byTier = {};
  const byField = {};
  const bySchema = { canonical: emptyCounts(), off_schema: emptyCounts() };
  let docTypeOk = 0;
  let tableHits = 0;
  let tableClaims = 0;

  for (const d of documents) {
    byType[d.type_slug] ||= { type: d.type, counts: emptyCounts() };
    byTier[d.tier] ||= { counts: emptyCounts() };
    for (const row of d.rows) {
      addRow(overall, row);
      addRow(byType[d.type_slug].counts, row);
      addRow(byTier[d.tier].counts, row);
      byField[row.field] ||= emptyCounts();
      addRow(byField[row.field], row);
      addRow(bySchema[row.canonical ? 'canonical' : 'off_schema'], row);
    }
    if (d.document_type.ok) docTypeOk++;
    for (const c of d.tables.claims) { tableClaims++; if (c.found) tableHits++; }
  }

  return {
    documents: documents.length,
    overall: { counts: overall, ...rates(overall) },
    by_type: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, { type: v.type, counts: v.counts, ...rates(v.counts) }])),
    by_tier: Object.fromEntries(Object.entries(byTier).map(([k, v]) => [k, { counts: v.counts, ...rates(v.counts) }])),
    by_field: Object.fromEntries(Object.entries(byField).map(([k, v]) => [k, { counts: v, ...rates(v) }])),
    by_schema: Object.fromEntries(Object.entries(bySchema).map(([k, v]) => [k, { counts: v, ...rates(v) }])),
    document_type: { correct: docTypeOk, of: documents.length },
    tables: { found: tableHits, of: tableClaims },
  };
}
