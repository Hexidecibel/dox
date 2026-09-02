# Spec-engine corpus — generated certificates with written-down expectations

Every defect `shared/specCheck.ts` has ever hit was found **by accident, on
production data**: a buffer control row judged as product, a certification
paragraph's regulatory thresholds reported as measurements, `3.0x10^2` parsed as
3, a unit cell reading `N/A` treated as a unit that matched nothing. This
directory turns each of those into a document you can open and read, with the
verdicts it must produce written down beside it.

```
corpus.json     the manifest — tenant config, per-document extraction shapes,
                expected verdicts, and the negative assertions
html/           the fixture SOURCE. Each file is a readable certificate
pdf/            build output, gitignored — rebuild with bin/render-spec-corpus
evaluate.mjs    the checker, engine injected so both the TS source and the
                bundled bin/lib/shared/specCheck.js can drive it
```

| command | what it does |
|---|---|
| `npm run corpus:render` | HTML → PDF, then asserts the text layer prints what the fixtures claim |
| `npm run corpus:check` | runs the engine over the manifest and reports pass/fail per expectation |
| `npx vitest run tests/unit/specCorpus.test.ts` | the same manifest, in CI, against the TypeScript source |

## Which layer is actually tested

`shared/specCheck.ts` consumes an **already-extracted** `tables` structure. So
`corpus:check` and the vitest suite cover the **judging** layer: given this read
of the document, does the engine reach the right verdict, refuse the right rows,
and stay silent where silence is correct? Deterministic, offline, sub-second.

They do **not** test extraction. Whether a real read of the PDF produces the
declared shape needs the worker and a model, and is neither fast nor
deterministic. The corpus is built so the same fixtures answer that question
too:

* each shape's `sources` **is** the target an extraction harness compares a live
  read against;
* `fields` is the field-level target, and `fields_must_not_contain` states what
  must never land in a product field (a Petrifilm plate lot in `lot_number`, a
  plate's expiry in `expiration_date`);
* `bin/render-spec-corpus` already proves the printed page and the declared
  shape agree — every header and non-empty cell of every table marked
  `printed_verbatim` must be findable in the `pdftotext -layout` output. Without
  that link the manifest would be an assertion about a document nobody has read.

The runner labels those field rows `layer: extraction` and counts them
separately, because here they are checked against the *declared* fields: they
validate the fixture, not the extractor.

Three tables are deliberately marked `printed_verbatim: false` and say why in
`printed_verbatim_why`. Those are shapes that are *not* what the page prints —
an extractor's mangling of a prose paragraph, a misfiled specification column.
They are the inputs the engine has to survive, so the corpus has to be able to
express them.

## The documents

| # | document | what it exercises |
|---|---|---|
| 01 | **Andersen Dairy — Heavy Cream 40% COA** | crosstab micro results with a `Buffer` control row; the closing certification paragraph quoting the regulation's own thresholds (400,000 / 100,000 per ml.); a reagent/plate-lot table with its own lot codes and expiry dates; a placeholder unit cell (`—`); product-scoped limit beating the tenant default |
| 02 | **Cascade Analytical — micro + chemical report** | long table with printed `Specification` and `Pass/Fail`; two rows where the document contradicts itself; scientific notation with the unit in its own column (`2×10³`, `1.2e3`); a censored value straddling our limit (`<50`) beside one clearing it (`<1`); MPN vs CFU; the absence vocabulary (`Negative`, `Not Detected`, `Non-detectable for Listeria mono/25g`, `Absent/25g`); placeholder units `N/A` / `none` / `—`; percent judged against a percent limit — and, in a second shape, percent refused against a CFU limit |
| 03 | **NorthStar Creamery — fluid dairy COA** | CFU/mL results against CFU/g limits, with the *same analyte* printed per mL on one line and per g on another; the same document evaluated twice, with the tenant's volume/mass equivalence off and on |
| 04 | **Valley Co-Pack — three products, three lots** | the multi-record certificate that historically collapsed into one; a result the supplier passed and our tighter limit fails; a placeholder unit column on a micro row that must still be judged; `3.0x10^2` beside it |
| 05 | **Andersen Dairy — Continuing Guaranty** | a non-COA, dense with numbers that look like data (statute sections, `0.5 ppm`, a facility registration). Must produce no verdict of any kind |

## How the manifest says "this must not happen"

Positive expectations are **exhaustive**: the runner compares the full set of
verdicts against the declared list, keyed by scope, table, row, column and
source. An unexpected verdict fails just as loudly as a missing one, so "the
engine started grading the buffer row" is caught even with no rule about
buffers.

On top of that, each shape carries `must_not` rules — a `why` and a
`no_verdict_where` predicate that must match **nothing**:

```json
{
  "why": "Buffer is the sterile negative control the lab runs beside the sample.
          A reviewer taught to wave off 'that's just the buffer' will wave off
          the real failure sitting next to it.",
  "no_verdict_where": { "row_label": "Buffer" }
}
```

The predicate keys are `scope`, `source`, `verdict`, `test_name_raw`,
`value_raw`, `unit_raw`, `value_num`, `limit_id`, `spec_test_id`, `limit_text`,
`table`, `row`, `col`, `row_label`, `group`, `cell`,
`unit_equivalence_applied`, plus `reason_contains` / `message_contains`. An
empty predicate `{}` matches every verdict — that is how document 05 says "no
result of any kind".

Two more assertions are structural rather than per-verdict:

* `scopes_must_all_produce_a_verdict` — document 04 names all three records, so
  a multi-record collapse fails even though the surviving record's verdicts are
  still correct;
* the runner checks, with no manifest input at all, that the review-queue call
  returns exactly the configured verdicts minus their passes, and that two runs
  over the same input agree byte for byte.

## Adding a case

1. Add or edit a certificate in `html/`. Keep it plausible — real letterhead,
   real-looking lot codes, values a lab would print. Fixtures that look like
   fixtures do not test anything, because extraction behaves differently on
   realistic layouts. **No `letter-spacing` and no `font-variant: small-caps`**:
   both shred the PDF text layer into `C E R T I F I C AT E`.
2. Declare the extraction shape in `corpus.json`.
3. `bin/check-spec-corpus --dump <doc-id>/<shape-id>` prints what the engine
   *actually* does, as manifest-ready expectations. Read every line, keep the
   ones that are right, and fix the engine if one is not. This is how the
   manifest was written — guessing the expectations would only test the guess.
4. `npm run corpus:render && npm run corpus:check`.
