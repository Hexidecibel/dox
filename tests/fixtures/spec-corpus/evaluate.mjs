/**
 * evaluate.mjs — run the spec engine over the generated corpus and check it
 * against corpus.json.
 *
 * WHICH LAYER THIS TESTS. `shared/specCheck.ts` consumes an ALREADY-EXTRACTED
 * `tables` structure, so everything here is the JUDGING layer: given this read
 * of the document, does the engine reach the right verdict, refuse the right
 * rows, and stay silent where silence is correct? It is fully deterministic and
 * needs no model, no GPU and no network.
 *
 * It does NOT test extraction. Whether a real read of the PDF produces the
 * declared `sources` is a separate, slower, non-deterministic question that
 * needs the worker and a model. The corpus is built so the same fixtures answer
 * it: each shape's `sources` is the target an extraction harness compares
 * against, and the `fields` / `fields_must_not_contain` blocks are stated for
 * that harness. They are checked here only against the DECLARED shape, which
 * validates the fixture rather than the extractor — the report says so, and
 * those rows are counted separately as `layer: extraction`.
 *
 * The engine is injected rather than imported so the same file can drive the
 * TypeScript source (vitest) and the bundled `bin/lib/shared/specCheck.js` that
 * production tooling actually loads.
 */

/** Stable identity for a verdict — mirrors the engine's own `specVerdictKey`. */
function keyOf(v) {
  const t = v.target;
  const where =
    t.kind === 'table'
      ? `t${t.table_index}r${t.row_index}${t.col_index === undefined ? '' : `c${t.col_index}`}`
      : `g${t.group}/${t.cell}`;
  return `${v.scope}::${where}::${v.source}`;
}

/** The same identity, built from a manifest expectation. */
function keyOfExpectation(e) {
  const where =
    e.group !== undefined
      ? `g${e.group}/${e.cell}`
      : `t${e.table}r${e.row}${e.col === undefined ? '' : `c${e.col}`}`;
  return `${e.scope}::${where}::${e.source}`;
}

/** Fields of a verdict an expectation is allowed to pin, exactly. */
const EXACT_FIELDS = [
  'verdict',
  'test_name_raw',
  'value_raw',
  'unit_raw',
  'limit_text',
  'limit_id',
  'spec_test_id',
  'value_num',
  'reason',
  'message',
];

function checkExpectation(e, actual) {
  const problems = [];
  for (const f of EXACT_FIELDS) {
    if (!(f in e)) continue;
    if (actual[f] !== e[f]) {
      problems.push(`${f}: expected ${JSON.stringify(e[f])}, got ${JSON.stringify(actual[f])}`);
    }
  }
  if ('unit_equivalence_applied' in e) {
    const got = actual.unit_equivalence_applied === true;
    if (got !== e.unit_equivalence_applied) {
      problems.push(
        `unit_equivalence_applied: expected ${e.unit_equivalence_applied}, got ${got}`
      );
    }
  }
  if (e.reason_contains && !String(actual.reason ?? '').includes(e.reason_contains)) {
    problems.push(`reason must contain ${JSON.stringify(e.reason_contains)}, got ${JSON.stringify(actual.reason)}`);
  }
  if (e.message_contains && !String(actual.message ?? '').includes(e.message_contains)) {
    problems.push(`message must contain ${JSON.stringify(e.message_contains)}, got ${JSON.stringify(actual.message)}`);
  }
  return problems;
}

/** Does one verdict match a `no_verdict_where` predicate? An empty one matches all. */
function matchesPredicate(v, p) {
  const t = v.target;
  const at = {
    scope: v.scope,
    source: v.source,
    verdict: v.verdict,
    test_name_raw: v.test_name_raw,
    value_raw: v.value_raw,
    unit_raw: v.unit_raw,
    value_num: v.value_num === undefined ? null : v.value_num,
    limit_id: v.limit_id === undefined ? null : v.limit_id,
    spec_test_id: v.spec_test_id === undefined ? null : v.spec_test_id,
    limit_text: v.limit_text,
    table: t.kind === 'table' ? t.table_index : undefined,
    row: t.kind === 'table' ? t.row_index : undefined,
    col: t.kind === 'table' ? t.col_index : undefined,
    row_label: t.kind === 'table' ? t.row_label : undefined,
    group: t.kind === 'group' ? t.group : undefined,
    cell: t.kind === 'group' ? t.cell : undefined,
    unit_equivalence_applied: v.unit_equivalence_applied === true,
  };
  for (const [k, want] of Object.entries(p)) {
    if (k === 'reason_contains') {
      if (!String(v.reason ?? '').includes(want)) return false;
      continue;
    }
    if (k === 'message_contains') {
      if (!String(v.message ?? '').includes(want)) return false;
      continue;
    }
    if (!(k in at)) throw new Error(`no_verdict_where: unknown key "${k}"`);
    if (at[k] !== want) return false;
  }
  return true;
}

/** Every string reachable in a `fields` block, for the extraction-layer check. */
function flattenValues(node, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    for (const n of node) flattenValues(n, out);
    return out;
  }
  if (typeof node === 'object') {
    for (const n of Object.values(node)) flattenValues(n, out);
    return out;
  }
  out.push(String(node));
  return out;
}

function sourcesFor(doc, shape) {
  if (shape.sources) return shape.sources;
  if (shape.sources_ref) {
    const ref = doc.shapes.find((s) => s.id === shape.sources_ref);
    if (!ref || !ref.sources) {
      throw new Error(`${doc.id}/${shape.id}: sources_ref "${shape.sources_ref}" resolves to nothing`);
    }
    return ref.sources;
  }
  throw new Error(`${doc.id}/${shape.id}: neither sources nor sources_ref`);
}

/** Run one shape through the engine. Exported so the dump mode can reuse it. */
export function runShape(corpus, engine, doc, shape) {
  const policyName = shape.unit_policy || 'strict';
  const policy = corpus.unit_policies[policyName];
  if (!policy) throw new Error(`${doc.id}/${shape.id}: unknown unit policy "${policyName}"`);
  const sources = sourcesFor(doc, shape);
  const printed = engine.checkPrintedSpecs(sources, { unitPolicy: policy });
  const configured = engine.checkConfiguredLimits(
    sources,
    corpus.spec_tests,
    corpus.spec_limits,
    shape.limit_context || {},
    { includePasses: true, unitPolicy: policy }
  );
  const reviewQueue = engine.checkConfiguredLimits(
    sources,
    corpus.spec_tests,
    corpus.spec_limits,
    shape.limit_context || {},
    { includePasses: false, unitPolicy: policy }
  );
  return { printed, configured, reviewQueue, policy };
}

function compareSet(label, expectations, actuals, checks) {
  const byKey = new Map(actuals.map((v) => [keyOf(v), v]));
  const seen = new Set();
  for (const e of expectations) {
    const key = keyOfExpectation(e);
    seen.add(key);
    const actual = byKey.get(key);
    if (!actual) {
      checks.push({
        name: `${label} ${key}`,
        layer: 'judging',
        ok: false,
        detail: `expected a ${e.verdict ?? ''} verdict here, engine produced none`,
      });
      continue;
    }
    const problems = checkExpectation(e, actual);
    checks.push({
      name: `${label} ${key}`,
      layer: 'judging',
      ok: problems.length === 0,
      detail: problems.join('; ') || `${actual.verdict} — ${actual.reason}`,
    });
  }
  for (const v of actuals) {
    const key = keyOf(v);
    if (seen.has(key)) continue;
    checks.push({
      name: `${label} ${key}`,
      layer: 'judging',
      ok: false,
      detail: `UNEXPECTED verdict the manifest does not declare: ${v.verdict} — ${v.message}`,
    });
  }
}

function sameList(a, b) {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * Check the whole corpus. `engine` is the specCheck module (TS source or the
 * bundled JS); both must produce identical results, which is the point of
 * injecting it.
 */
export function evaluateCorpus(corpus, engine, opts = {}) {
  const only = opts.only || null;
  const documents = [];
  for (const doc of corpus.documents) {
    if (only && doc.id !== only) continue;
    const shapes = [];
    for (const shape of doc.shapes) {
      const checks = [];
      const { printed, configured, reviewQueue } = runShape(corpus, engine, doc, shape);
      const all = [...printed, ...configured.verdicts];

      compareSet('printed', shape.expect.printed || [], printed, checks);
      compareSet('limit', shape.expect.limit || [], configured.verdicts, checks);

      checks.push({
        name: 'unmatched analyte names',
        layer: 'judging',
        ok: sameList(shape.expect.unmatched || [], configured.unmatched),
        detail: `expected [${[...(shape.expect.unmatched || [])].sort().join(', ')}], got [${[...configured.unmatched].sort().join(', ')}]`,
      });
      checks.push({
        name: 'control rows recognised but not judged',
        layer: 'judging',
        ok: sameList(shape.expect.control_rows || [], configured.control_rows),
        detail: `expected [${[...(shape.expect.control_rows || [])].sort().join(', ')}], got [${[...configured.control_rows].sort().join(', ')}]`,
      });

      // Invariant, not a manifest claim: the review queue is exactly the
      // configured run minus its passes. Silence is the signal a row is fine.
      const expectedQueue = configured.verdicts.filter((v) => v.verdict !== 'in_spec').map(keyOf);
      checks.push({
        name: 'review queue == configured verdicts minus passes',
        layer: 'judging',
        ok: sameList(expectedQueue, reviewQueue.verdicts.map(keyOf)),
        detail: `${reviewQueue.verdicts.length} queued of ${configured.verdicts.length} judged`,
      });

      for (const rule of shape.must_not || []) {
        const hits = all.filter((v) => matchesPredicate(v, rule.no_verdict_where));
        checks.push({
          name: `MUST NOT ${JSON.stringify(rule.no_verdict_where)}`,
          layer: 'judging',
          ok: hits.length === 0,
          detail: hits.length
            ? `${hits.length} verdict(s) matched: ${hits.map((h) => `${keyOf(h)} ${h.verdict} "${h.message}"`).join(' | ')}`
            : rule.why,
        });
      }

      if (shape.scopes_must_all_produce_a_verdict) {
        for (const scope of shape.scopes_must_all_produce_a_verdict) {
          const n = all.filter((v) => v.scope === scope).length;
          checks.push({
            name: `every record survives: ${scope} produces a verdict`,
            layer: 'judging',
            ok: n > 0,
            detail: n ? `${n} verdict(s)` : 'no verdict — this scope was collapsed or dropped',
          });
        }
      }

      // Determinism. A judging layer that is not reproducible cannot be a
      // regression test at all.
      const again = runShape(corpus, engine, doc, shape);
      checks.push({
        name: 'deterministic across runs',
        layer: 'judging',
        ok:
          JSON.stringify(again.printed) === JSON.stringify(printed) &&
          JSON.stringify(again.configured) === JSON.stringify(configured),
        detail: 'same input, same verdicts',
      });

      shapes.push({
        id: shape.id,
        note: shape.note,
        checks,
        counts: {
          printed: printed.length,
          limit: configured.verdicts.length,
          queued: reviewQueue.verdicts.length,
          unmatched: configured.unmatched.length,
          control_rows: configured.control_rows.length,
        },
      });
    }

    // Extraction-layer statements. Checked against the DECLARED fields, so a
    // pass here validates the fixture, not the extractor. See the header.
    const fieldChecks = [];
    if (doc.fields_must_not_contain) {
      const values = flattenValues(doc.fields);
      for (const forbidden of doc.fields_must_not_contain.values) {
        const hits = values.filter((v) => v.includes(forbidden));
        fieldChecks.push({
          name: `no field carries ${JSON.stringify(forbidden)}`,
          layer: 'extraction',
          ok: hits.length === 0,
          detail: hits.length ? `found in: ${hits.join(', ')}` : doc.fields_must_not_contain.why,
        });
      }
    }

    documents.push({ id: doc.id, title: doc.title, covers: doc.covers, shapes, fieldChecks });
  }

  let pass = 0;
  let fail = 0;
  let extractionPass = 0;
  for (const d of documents) {
    for (const s of d.shapes) for (const c of s.checks) (c.ok ? pass++ : fail++);
    for (const c of d.fieldChecks) c.ok ? extractionPass++ : fail++;
  }
  return { documents, summary: { pass, fail, extractionPass, total: pass + fail + extractionPass } };
}

/**
 * Print the verdicts a shape actually produces as manifest-ready expectation
 * objects. This is how the manifest was written: state the extraction shape,
 * look at what the engine really does, then read every line and keep only the
 * ones that are right. Guessing the expectations would test the guess.
 */
export function dumpShape(corpus, engine, docId, shapeId) {
  const doc = corpus.documents.find((d) => d.id === docId);
  const shape = doc.shapes.find((s) => s.id === shapeId);
  const { printed, configured } = runShape(corpus, engine, doc, shape);
  const asExpectation = (v) => {
    const t = v.target;
    const e = { scope: v.scope, table: t.table_index, row: t.row_index };
    if (t.col_index !== undefined) e.col = t.col_index;
    e.source = v.source;
    e.verdict = v.verdict;
    e.test_name_raw = v.test_name_raw;
    e.value_raw = v.value_raw;
    if (v.value_num !== null && v.value_num !== undefined) e.value_num = v.value_num;
    if (v.limit_id) e.limit_id = v.limit_id;
    if (v.unit_equivalence_applied) e.unit_equivalence_applied = true;
    e.reason = v.reason;
    e.message = v.message;
    return e;
  };
  return {
    printed: printed.map(asExpectation),
    limit: configured.verdicts.map(asExpectation),
    unmatched: configured.unmatched,
    control_rows: configured.control_rows,
  };
}
