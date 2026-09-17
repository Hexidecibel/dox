# Document-type corpus — how extraction does on everything that is not a COA

Production is **139 COAs out of 200 documents**. Every accuracy figure this
project has ever quoted — the 90.6% corpus number, the reviewer accept rate, the
Mac-vs-Spark bake-off — was measured on COAs. The client's working assumption is
that *"COAs are the worst case and everything else is prose with a few tables"*.
That is a hypothesis, and until this corpus existed it had never been tested.

Ten document types the incoming corpus will be heaviest in, three renderings
each, plus a scanned variant of every clean one. Ground truth is written down
**as the fixture is authored** — never read back out of an extraction.

```
corpus.json     the manifest — key groups, per-document ground truth, the
                per-type instruction texts used by the second arm
html/           the fixture SOURCE. Each file is a readable document
pdf/            build output, gitignored — rebuild with bin/render-doctype-corpus
                (also holds the *.scan.pdf image-only variants)
runs/           saved measurement runs, gitignored — re-score with --rescore
score.mjs       the scorer. Pure: manifest + extraction + the text the model saw
```

| command | what it does |
|---|---|
| `bin/render-doctype-corpus` | HTML → PDF, asserts the text layer prints what the manifest claims, builds the scanned variants |
| `bin/measure-doctype-extraction` | runs the production text path over every fixture and scores it |
| `bin/measure-doctype-extraction --instructions` | the same, with a per-type field list appended — the counterfactual |
| `bin/measure-doctype-extraction --rescore runs/x.json` | re-score a saved run against the current manifest, no model calls |
| `bin/measure-doctype-extraction --classify-only` | the classification pass alone — 2.6 s a document instead of 30 s, for re-tuning the classifier |
| `bin/measure-doctype-extraction --classify-model best` | classify on the `best` chain instead of `fast` (`off` skips classification entirely) |

## The difficulty ladder

Synthetic documents are **easier** than real ones: clean text layer, predictable
layout, no scanner noise. A harness that only produced clean documents would
report an optimistic number and teach us nothing. So every type is rendered
three ways, and the clean one is additionally scanned:

* **clean** — labelled fields, one column, one date format.
* **moderate** — multi-column layout, a letterhead/logo block, two or three date
  formats on one page (`15-FEB-2026`, `14 Feb 2027`, `2/20/26`), and the field
  that matters stated inside a prose paragraph rather than in a labelled cell.
* **nasty** — the failure modes that actually occur: a value **split across a
  line break**; two or three dates where only one is the expiry; a table whose
  **header row repeats mid-table**; and, in every type, at least one field that
  is **genuinely absent**, where the correct answer is null and inventing a
  value is scored as a failure rather than a near-miss.
* **scanned** — the clean PDF rasterised at 150 dpi, rotated 0.35°, blurred,
  gaussian-noised, contrast-reduced, and rebuilt as an image-only PDF with **no
  text layer**, so it drives the real OCR branch (`pdftoppm -gray -r 300 |
  tesseract --psm 1`). Same ground truth as its source, so the clean→scanned
  delta is the scanner tax with everything else held equal.

## What "fabricated" means here, and why it is never one bucket

| bucket | meaning |
|---|---|
| `correct` | truth present, model matched it |
| `wrong_value` | truth present, model emitted something else |
| `missed` | truth present, model emitted nothing |
| `correct_null` | truth is NULL and the model said nothing (or said so: "none", "not applicable") |
| `fabricated_misfiled` | truth is NULL, the model emitted a value that **is printed on the page** under a different meaning |
| `fabricated_invented` | truth is NULL, the model emitted a value that appears **nowhere on the page** |

Fabrication is kept as its own number everywhere. A wrong value a reviewer can
check against the page is a different failure from a value the page does not
contain, and the second one is what gets a certificate accepted for a claim
nobody made. The two kinds are never merged either: a misfile is a misread of
the document, an invention is not about the document at all.

Two rates are reported side by side and never blended:

* **value accuracy** = `correct / (correct + wrong + missed)` — over fields that
  have an answer.
* **null accuracy** = `correct_null / (correct_null + fabricated_*)` — over the
  30 rows whose correct answer is silence.

A single blended figure would let a model that answers everything look good on
exactly the documents where the right answer is nothing.

## Which key carries the answer

`extractFields` returns an **open** field object: `canonicalizeFields` maps a
fixed alias set onto canonical names and passes every other key through
verbatim. So one semantic answer ("who issued this certificate") can arrive
under several keys. `key_groups` in the manifest names, per graded field, the
full set of keys that may legitimately carry it — a value under **any** of them
is the model's answer. That is what makes a null judgement honest: the model
cannot escape a fabrication charge by writing the invented value under a key
nobody was watching.

## The two arms

The **baseline** arm runs `functions/lib/llm.ts` exactly as production does
(bundled fresh on every run, so it can never measure a stale copy of the
prompt). The **instructed** arm (`--instructions`) appends the manifest's
per-type field list to the industry layer — the shape a per-document-type
extraction-instructions row takes — and scores identically. Those strings name
**fields only**: never a value, never which documents lack one, and the same
universal null clause closes every one of them.

## Measured, 2026-09-02 → 2026-09-03, `Qwen3.6-35B-A3B-UD-Q8_K_XL` on the Spark

40 documents, 190 graded fields. The 09-02 column is the first run of this
corpus; the 09-03 column is the same corpus after the three defects that run
found were fixed (a dedicated pre-extraction classification pass, nine
certificate fields added to llm.ts rule 1, and the certificate subject-vs-issuer
rule). Nothing about the fixtures or the ground truth changed between them.

| baseline arm | 09-02 | 09-03 |
|---|---|---|
| value accuracy | 56.6% (86/152) | **92.8%** (141/152) |
| null accuracy | 86.8% (33/38) | **92.1%** (35/38) |
| fabricated | 5 — all misfiles, **0 invented** | 3 — all misfiles, **0 invented** |
| doc type correct | 19/40 | **38/40** |

| instructed arm | 09-02 | 09-03 |
|---|---|---|
| value accuracy | 95.4% (145/152) | **96.7%** (147/152) |
| null accuracy | 81.6% (31/38) | **92.1%** (35/38) |
| fabricated | 7 — all misfiles, **0 invented** | 3 — all misfiles, **0 invented** |
| doc type correct | 31/40 | 37/40 |

By tier, baseline value accuracy:

| tier | 09-02 | 09-03 |
|---|---|---|
| clean | 62.5% | 95.0% |
| moderate | 58.5% | 92.7% |
| nasty | 51.6% | 90.3% |
| scanned | 52.5% | 92.5% |

**Zero invented values survived the change, in both arms.** That is the number
to watch: the gluten-free fixture cites 21 CFR 101.91 and prints no ppm figure,
and `gluten_threshold` now exists as a field, so the model was given both the
slot and the temptation. It did not supply the well-known 20 ppm in any run. On
`gf-nasty` it did misfile `<LOQ` — a string that IS printed on the page — which
is the milder failure the two fabrication buckets exist to keep separate.

### Document type: its own pass now

The 09-02 number (19/40) was measured on a `document_type` that fell out of the
extraction call. That is a circular dependency: the document-type instruction
layer (migration 0098) is keyed on the type, so guidance could only be applied
by RE-extracting, and the pass that decided the type was by definition the
unguided one. Every organic, kosher, gluten-free and audit certificate came back
"Certificate of Analysis".

It is now `classifyDocumentType` in `functions/lib/llm.ts`: the first 3000
characters, the tenant's real catalog (this harness uses the FSQA starter pack's
27 types, not a list built from the answer key), an exact-match validation, and
an explicit "none". It runs BEFORE extraction on the `fast` chain, and the type
it settles on is passed into the extraction prompt.

| | correct | unresolved | median | total |
|---|---|---|---|---|
| `--classify-only --classify-model fast` | 38/40 | 0 | 2.6 s | 125.4 s |
| `--classify-only --classify-model best` | 37/40 | 0 | 2.6 s | 126.8 s |

`fast` and `best` currently resolve to the SAME model on the SAME host
(`Qwen3-6-35B-A3B-spark-q8`), so that one-document difference is run-to-run
noise, not a quality signal, and there is no latency difference to find. The tag
is a statement of intent for the day the chains diverge; the actual saving is
the shape of the call — a page in, one line out, 2.6 s against extraction's 30 s.

Both remaining misses are the same document answering "3rd Party Food Safety
Audit **Report**" where the fixture is a "3rd Party Audit **Certificate**". Both
names are real types in the starter pack. That is a genuinely fine distinction
and it is left standing rather than papered over: fuzzing the answer onto the
nearest name is exactly the confident-wrong-type failure the exact-match rule
exists to prevent.

### What is left, and why it is left

Split by whether llm.ts rule 1 has a canonical field for the answer (baseline,
09-03):

| | value accuracy |
|---|---|
| canonical field exists | 97.9% (140/143) |
| no field in the schema (`issue_date`, `audit_grade`, `signal_word`) | 11.1% (1/9) |

Nine of the eleven remaining baseline failures are still that second row, and it
is now a SHORT row: `issue_date` (5), `audit_grade` (3), `signal_word` (1). They
were deliberately not promoted to canonical fields. A canonical field is one the
product reasons about across every document type — supplier identity, the dates
that drive renewal, the numbers that identify a certificate. A GHS signal word
and an audit score are facts about one kind of document, which is precisely what
migration 0098's per-type instruction layer is for, and the instructed arm
recovers two thirds of them (66.7%) by naming them there.

Note that this table is NOT comparable to the 09-02 one: nine fields moved from
the second row to the first, which was the point.

### 2026-09-17: `shelf_life` + `document_number`, and a warning about the scanned tier

Two more fields moved out of that second row, for the same reason and found the
same way — `tests/fixtures/real-corpus` measured both as MISSED on every real
document that prints them (see that corpus's finding 4). They are graded here on
three spec fixtures plus the scanned variant: `shelf_life` on all four
(`spec-clean` "12 months from date of manufacture in unopened original
packaging", `spec-moderate`'s prose "best if used within 45 days of the pack
date", `spec-nasty`'s fine print "24 months from manufacture when stored below
27 C") and `document_number` on three (`RB-SPEC-4410`, which sits one
character-group from the product code `RB-4410`, and `FSQ-SPEC-0442`, which this
manifest already graded as NOT a product code). **7 of 7 correct** on the
2026-09-17 run, OCR'd scan included.

**The `scanned` tier is not comparable across a re-render.** `makeScan` applies
`+noise Gaussian` with no `-seed`, so every `bin/render-doctype-corpus` produces
a different image and a different OCR read of it. The 09-17 run lost three
`coi-clean#scanned` rows against the 09-03 run — a supplier/customer swap and
`COI` read as `COl` — with no change to that document's text path or to the
rules that govern those fields. Compare the scanned tier only against a run made
from the SAME rendered PDFs, or seed the noise.

## Adding a case

1. Add or edit a document in `html/`. Keep it plausible — real letterhead, real
   certificate numbers, values a certifier would print. **No `letter-spacing`
   and no `font-variant: small-caps`**: both shred the PDF text layer.
2. Write the ground truth in `corpus.json` **from the document you just wrote**,
   including the null-truth traps and the `distractors` that make a misfile
   distinguishable from an invention.
3. `bin/render-doctype-corpus` — it fails if any ground-truth value is not
   findable in the text layer. Ground truth that is not on the page is not
   ground truth.
4. `bin/measure-doctype-extraction --doc <id>`.
