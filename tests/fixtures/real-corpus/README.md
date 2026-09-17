# Real-document corpus — what a supplier actually sends

`tests/fixtures/doctype-corpus` and `tests/fixtures/spec-corpus` are synthetic.
Every fixture in them was written to be **one document**, of **one type that
exists in the FSQA starter pack**, with **a clean text layer**. That ladder is
what makes those numbers diagnosable, and it is also exactly what a real
supplier packet is not.

These five PDFs arrived from the client SME (AJ Conner) on 2026-09-16 for
wizard-config testing, in two deliberately different shapes:

* **Set 1, the comprehensive one** — `packet-fdlw-2026.pdf`: a supplier who
  assembles a clean, indexed, fully-dated annual packet. **36 pages, 25
  documents, one file.**
* **Set 2, the messy one** — four unrelated specification sheets from three
  suppliers on three different templates, none of which agree about where a
  shelf life goes.
* **Set 3 has not arrived**: Medosweet's own packet plus AJ's manual.

```
corpus.json     the manifest — per-document ground truth, page ranges, and the
                printed spec limits each sheet carries
pdf/            the documents. TRACKED, unlike the other two corpora's pdf/ —
                see "why the PDFs are committed" below
.build/         bundles + the carved-out page ranges, gitignored
runs/           saved measurement runs, gitignored — re-score with --rescore
```

| command | what it does |
|---|---|
| `bin/eval-aj-docs` | classify + extract every document and score it |
| `bin/eval-aj-docs --verify` | **no model calls** — assert every ground-truth string is findable in the text the model would see |
| `bin/eval-aj-docs --classify-only` | the classification pass alone, ~2.5 s a document |
| `bin/eval-aj-docs --set specs` | `specs` / `packet` / `packet-parts` / `packet-whole` |
| `bin/eval-aj-docs --force-ocr` | **not the production path** — rasterise and OCR, to see what is on the five inserted certificate images |
| `bin/eval-aj-docs --rescore runs/x.json` | re-score a saved run, no model calls |

Scoring is `../doctype-corpus/score.mjs` — the same scorer, the same six
buckets, the same split between a wrong value and an invented one — so the two
corpora produce comparable numbers. The text path is `bin/lib/corpusText.js`,
the same module `bin/measure-doctype-extraction` runs.

## Why the PDFs are committed

The other two corpora gitignore `pdf/` because it is **build output**: the HTML
in `html/` is the source and `bin/render-*-corpus` rebuilds the PDFs from it. A
real supplier PDF has no source to rebuild from. The PDF **is** the source, so
it is tracked. 2.1 MB for five files.

## The three things this corpus tests that the synthetic one cannot

### 1. One file is not one document

`packet-fdlw-2026.pdf` is 36 pages holding 25 separately-dated documents, and
its own page 2 is a table of contents that names every one of them with its page
range. dox's intake treats an upload as one document: one classification, one
`document_type_id`, one renewal date.

Measured 2026-09-16, `Qwen3.6-35B-A3B-UD-Q8_K_XL` on the Spark:

| | |
|---|---|
| whole packet, classified as one file | **"Letter of Guarantee"**, 4 runs out of 5 |
| whole packet, `document_expires_on` | **`2027-01-02`** — invented, appears nowhere in the file |
| split on its own index, 26 parts | 22/26 types correct |

Both of those are the Letter of Guarantee on **page 3** answering for the other
24 documents. The invented date is the letter's own "valid for no more than one
year from the date hereof" clause, correctly read and then applied to a 36-page
packet — so a single upload produces one document, typed from page 3, expiring
on a date that is not printed anywhere, covering an SQF certificate that lapses
2026-04-23 and a kosher letter that lapses 2026-06-30.

The manifest grades the packet **both ways**, and page-splits the parts with
`functions/lib/kinds/coaPageScope.ts#extractRecordPdf` — the product's own
splitter, the one the COA records path already runs. It carves all 26 parts
without a fallback.

### 2. "None" is very often the right answer

**Seventeen of the packet's twenty-six parts have no matching type in the FSQA
starter pack's 27** (eighteen documents corpus-wide, counting the whole packet).
There is no Bioterrorism Statement, no BSE Statement, no BPA Statement, no Prop
65 Statement, no rBST Statement, no Vegetarian Statement, no PHO Statement, no
Rennet Statement, no Yellow Prussiate Statement, no Heavy Metal Statement, no
Irradiation Statement, no PFAS Statement, no Environmental Program — and no type
at all for a facility contact table or a packet cover.

**This is the wizard finding.** It is not that classification is weak on these;
it is that a tenant seeded from the starter pack has nowhere to put two thirds
of what its best-organised supplier sends, so two thirds of a clean packet lands
unresolved on a human's desk by design. The starter pack is a configuration
decision, and this corpus is the list of types it is missing.

For those the correct classifier answer is `none`, which parks the item for a
human — not the nearest name, because a confident wrong type silently selects
the wrong 0098 instruction block for every future document like it.
`document_type_expected_none: true` says so and `score.mjs` grades it; the flag
is absent from the synthetic corpus, so its numbers are unchanged.

Measured: **15/18 correct**. The three failures are the interesting ones —

* Partially Hydrogenated Oils → "Allergen Statement"
* Yellow Prussiate of Soda → "Allergen Statement"
* Environmental Program → "Sanitation Program"

— all three an ingredient-or-hygiene statement pulled toward the nearest
ingredient-or-hygiene type. That is the pressure the exact-match rule exists to
resist, and it is holding on 15 of 18.

Exactly two parts carry the flag **and** an accept list, because the pack holds
an adjacent-but-not-equal type and the disagreement is worth recording rather
than resolving: a Bioengineered **statement** against "Non-GMO Certificate", and
a one-paragraph Food Defense **statement** against "Food Defense Plan". That
combination makes a document un-failable on type, so the pair is pinned by name
in `tests/unit/realCorpus.test.ts` — it has to stay rare and deliberate rather
than becoming the way an awkward case gets silenced.

### 3. The OCR fallback never fired on an inserted certificate image — FIXED 2026-09-17

Pages 6, 13, 14, 15 and 16 are pasted pictures: the SQF certificate, two OU
kosher letters, two IFANCA halal certificates. **They are the five documents in
the packet that carry real expiry dates.**

They are not blank pages. Each one has a few characters of genuine text over
it — the "C2" confidentiality banner, a typed caption, a page number:

| page | document | text layer | largest drawn image | what OCR reads |
|---|---|---|---|---|
| 6 | SQF certificate, expires 2026-04-23 | **5 chars** | 53.8% of the page | 1097 chars |
| 13 | OU kosher, valid through 6/30/2026 | 83 chars | 38.6% | 1505 chars |
| 14 | OU kosher, valid through 6/30/2026 | 72 chars | 40.7% | 1587 chars |
| 15 | IFANCA halal | 70 chars | 38.0% | 1384 chars |
| 16 | IFANCA halal, valid until 2026-10-31 | 34 chars | 34.8% | 1409 chars |

**What was wrong.** `bin/process-worker` routed to OCR only when the text layer
was **empty** or **garbled**. Five to eighty-three characters is neither, so
tesseract never ran and the model was handed the caption.
`shared/pdfTextSerializer.ts`'s guard did not catch it either: it declines a
serialization of **>200 characters with almost no letters**, and these pages are
short, not letterless. Every guard in the path asked ONE question of the WHOLE
file.

The measured cost, on the split parts: **25 of the corpus's 34 value errors were
these five pages, and they got 0 of 25 graded fields right.** Every certificate
number, every issuing body and every expiry date on them was a miss — and all
five of the corpus's *wrong* values (as against absent ones) were here, because
the caption was the only thing to read, so the model answered `Smithfield` or
`Alouette` for the supplier. Four of the five still *classified* correctly, but
only because somebody typed "alouette Halal Certificate" above the image. Page
6's caption is blank, and page 6 was the only part in the corpus that classified
to `none` when a type did fit.

**The fix: decide OCR one page at a time** (`shared/pdfPageOcr.ts`, applied by
`bin/lib/pdfPageOcr.js` in both `bin/process-worker` PDF branches and in
`bin/lib/corpusText.js`). A page is OCR'd when **one drawn image covers ≥25% of
it AND its text layer is under 300 characters**. Both halves are required, and
this corpus is why: page 36 is a near-blank back cover (5 chars, no picture) and
must not become an OCR bill, while the Smith Brothers spec sheet is drawn on a
background image covering 100% of the page and carries 1957 characters of real
text that must never be replaced by a worse read of the same words. Both
thresholds sit inside measured holes — image coverage 0.124 → 0.348, characters
81 → 396. OCR is **appended** to the page's own text, never substituted for it.

Measured, same model and prompt, only the text path changed:

| | before | after |
|---|---|---|
| value accuracy, whole corpus | 70.4% (81/115) | **89.6% (103/115)** |
| the five image documents' 25 graded fields | **0** | **22** |
| documents where a type in the pack fits, classified correctly | 12/13 | **13/13** |
| `document_expires_on` on the four certificates that print one | 0 | **4** |
| text-path time, whole 36-page packet | 1.7 s | 44 s (five pages of OCR) |
| text-path time, a document with no picture page | unchanged | +~9 ms per page (the operator-list read) |

`bin/eval-aj-docs --verify` now checks the `pdf_text_must_contain_ocr` claims on
the production route as well, which makes it the no-model regression test for
the routing rule: 103/103 claims found. `--force-ocr` is still **not** the
production path — it rasterises every page of every document, and it exists so
the ground truth on these five pages stays independently checkable.

## Set 2: what the four specification sheets are

| id | supplier | product | printed micro limits | shelf life |
|---|---|---|---|---|
| `spec-cmf-light-cream-23` | Country Morning Farms | Light Cream 23% | APC ≤20,000 cfu/**mL**, Coliform ≤10 cfu/mL | 21 days |
| `spec-cmf-ice-cream-mix-14` | Country Morning Farms | 14% Ice Cream Mix | APC ≤50,000 cfu/**mL**, Coliform ≤10 cfu/mL | 1 year frozen, 21 days refrigerated |
| `spec-smithbrothers-heavy-whipping-cream-13106` | Smith Brothers | Heavy Whipping Cream, item 13106 | APC ≤20,000 CFU/**ml**, Coliform ≤10 CFU/ml | 21 days at ≤40 °F |
| `spec-andersen-heavy-whip-cream-half-gallon` | Andersen Dairy | Heavy Whip Cream, half gallon | Fresh: APC <300, Coliform <1. 48 Hr Stress: APC <1,000, Coliform <10 — **no units** | 22 days |

Every one of them states limits, and every one states them differently. Three
observations that are not incidental:

* **All the CFU limits that carry a unit carry it per mL**, on fluid dairy. That
  is precisely what `tenants.spec_volume_mass_equivalent` (migration 0093)
  exists for — on prod, 370 results printed `cfu/mL` against limits written per
  gram, and the majority unit matched nothing.
* **Andersen's four limits have no unit at all, and two scopes** — "Fresh" and
  "48 Hr Stress" for the same two analytes, which is a test *condition*, not a
  product. `spec_limits`' scope columns cannot express it. That is why
  `spec_limits_printed` in the manifest is a **description of the page**, not an
  importable config.
* **The two Country Morning sheets are the same template with a five-times-looser
  aerobic limit**, which is the case for scoping a limit to a product rather
  than a tenant.

They are recorded here rather than in `spec-corpus` deliberately.
`spec-corpus` tests `shared/specCheck.ts`, the **judging** layer, and it is fed
an already-extracted `tables` structure; these four documents carry no results
to judge — they are the limits themselves. What they test is whether extraction
can read a limit off a real page, which is this corpus's question.

## The measured numbers

31 documents, 176 graded fields, `Qwen3.6-35B-A3B-UD-Q8_K_XL` on the Spark,
baseline prompt, no supplier or document-type instructions configured. The only
thing that changed between the two columns is the TEXT PATH — per-page OCR
routing (finding 3 above). Same model, same prompt, same scorer; six documents'
text changed and twenty-five are byte-identical.

| | 2026-09-16, before | 2026-09-17, after |
|---|---|---|
| value accuracy | 70.4% (81/115) — wrong 5, missed 29 | **89.6%** (103/115) — wrong 3, missed 9 |
| null accuracy | 98.4% (60/61) | 96.7% (59/61) |
| fabricated | 1, invented — the packet's `2027-01-02` | 2 — the same one, plus one misfiled |
| document type | 27/31 · 12/13 where a type fits · 15/18 where none does | 27/31 · **13/13** where a type fits · 14/18 where none does |
| the five image documents' 25 fields | 0 correct | **22 correct** |

Read carefully before comparing this to the doctype corpus's 92.8%:

* **The whole improvement is the five image pages.** They scored 0 of 25 and now
  score 22 of 25. Excluding them the corpus was 81/90 = 90.0% and is 81/90 =
  90.0% still: not one of the twenty-five documents whose text did not change
  moved a graded field. That was the point — the image pages were never a model
  result, they were a routing bug, and folding them into one figure reported it
  as a quality problem.
* **The two movements that are NOT the fix are run-to-run variance on
  byte-identical text**: the Andersen spec sheet's `revision_date` and a
  misfiled `expiration_date` ("22 days"), and the whole packet classifying as
  "Letter of Guarantee" (the README's own measurement says it answers that 4
  runs in 5; the 2026-09-16 run was the fifth). Neither document's text differs
  by a byte between the runs.
* **Null accuracy is still ~97% with one invented value across 61 chances**, and
  the corpus is stuffed with date-shaped decoys — every statement prints a
  letter date next to an empty expiry field. The discipline that
  `document_expires_on` is not `expiration_date` is holding on real documents,
  including now on the four certificates that genuinely print an expiry:
  SQF `2026-04-23`, both OU kosher letters `2026-06-30`, the alouette IFANCA
  halal `2026-10-31`. Before the fix, `document_expires_on` was null on all five
  — which is the likeliest reason the column has never been populated once
  across 601 production documents.

Of the nine remaining misses, six are a **schema gap** rather than a model gap:
`shelf_life` missed on **all four** spec sheets and `document_number` on both
Country Morning sheets. Neither is a canonical field in `llm.ts` rule 1 — the
same "there was nowhere to put the answer" the doctype corpus's BY SCHEMA SLOT
table separates out — and a shelf life is the input `shared/renewalPeriod.ts`
most wants that nothing currently extracts.

## Adding a case

1. Drop the PDF in `pdf/` under a descriptive id.
2. Write the ground truth in `corpus.json` **from the page**, reading it with
   the repo's own text path — not from an extraction. Set
   `document_type_expected_none: true` when nothing in the starter pack fits;
   that is a finding, not a gap in the fixture.
3. For a multi-document file, add one entry per contained document with `pages`,
   and one for the whole file. The whole-file entry is what the product ingests
   today and is the one that must not be dropped.
4. `bin/eval-aj-docs --verify` — it fails if any ground-truth string is not in
   the text the model would see. Ground truth that is not on the page is not
   ground truth.
5. `bin/eval-aj-docs --doc <id>`.
