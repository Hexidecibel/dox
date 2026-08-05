# MODELS.md — the extraction stack: models, hardware, parsing strategy

State as of the 2026-08-04/05 measurement sessions. Seven studies were run over two days,
culminating in an n=99 stratified A/B over the production corpus (`SCALE-AB-REPORT.md`), which
supersedes the earlier n=8 numbers wherever they disagree. Superseded figures are shown as such
below rather than deleted, because several of them are still quoted in older notes.

---

## What to run today

- **Extraction model: Qwen3.6-35B-A3B, Q8 (MoE, ~3B active).** Served on the Mac Mini M4 Pro
  (`ajs-mac-mini-2.tail162d1e.ts.net:9600`). ~30–36 s/page. This is the production default.
- **Text layer: geometry-aware serialization (`shared/pdfTextSerializer.ts`), always with the
  no-alphabetic-content guard.** Worth +4.8pp overall / +6.2pp on documents with a text layer,
  at ~11 ms/document of extra PDF parsing — 0.03% of inference. Unguarded it destroys one supplier's documents outright — the guard is not
  optional (see "The guard is the feature").
- **Reasoning: off. ` /no_think` suffixes: gone** (they were inert). Do not re-add either.
- **VLM mode: off (`QWEN_VLM_MODE=off`).** Confirmed defective — it silently drops the records
  payload on every document and fabricated a record. Do not enable until `coaRecordsCapture`
  is populated on the VLM path.
- **The 122B on the Spark: shelved as a default, available as an escalation tier.** +3.3pp for
  2.13× the wall time, it loses to the serializer, and the two gains do not stack.
- **Chandra OCR: not deployed.** It ties the serializer at ~16,000× the per-page cost. Reserved
  as a possible narrow fallback (~4% of corpus). Licence needs review before any deployment.

---

## Hardware

Three boxes sit behind the qwen-llm router:

| Box | Location / address | Compute | Memory | Serves |
|---|---|---|---|---|
| **Mac Mini M4 Pro** | `ajs-mac-mini-2.tail162d1e.ts.net:9600` | Metal | 64 GB unified | Qwen3.6-35B-A3B Q8 — **production default** |
| **NVIDIA DGX Spark GB10** | `spark-ba9b.tail162d1e.ts.net:9600` | aarch64, CUDA 13 | 121 GB | VL-32B Q8 resident; 122B Q5 + 35B Q8 staged; newly commissioned |
| 4090 Windows box ("buddy") | via router pool | CUDA | — | 35B **Q4_K_M** — the bake-off-losing quant; also the `fast` chain's latency box |

### The decisive measurement: same weights, two boxes

Every earlier Mac-vs-Spark comparison confounded model and box (35B MoE on the Mac vs dense
VL-32B on the Spark). `HARDWARE-REPORT.md` broke the confound by staging the **byte-identical
GGUF** on both — verified by file size plus sha256 of head/middle/tail slices, not by name:

| | Mac M4 Pro (Metal) | DGX Spark GB10 (CUDA) | Spark advantage |
|---|---|---|---|
| prefill tok/s (two real prompts) | 671 / 647 | **1,504 / 1,526** | **2.24–2.36×** |
| decode tok/s | 42.7 / 42.9 | **53.1 / 53.6** | **1.25×** |
| full-arm wall (8 docs / 12 pages) | 363 s | **328 s** (repeat 312 s) | **1.11–1.16×** |
| accuracy (47 graded slots) | 41.0 | 40.5 | −0.5 — one half-credit string, inside noise |

**The Spark is faster at every stage on identical weights.** The earlier "Spark is 9× slower
and more accurate" result was 100% the model, 0% the box. The attribution decomposes exactly:
box effect −0.5, model effect (MoE → dense 32B) +3.5, sum = the +3.0 originally observed.

### The workload is decode-bound

The prompt is prefill-heavy in *tokens* (4.5:1 prompt:completion), but prefill runs 12–35×
faster per token than decode, so in *seconds* the ratio inverts: **81–89% of every call is
decode.** Consequences:

- The Spark's 2.3× prefill win converts into only a 1.11× end-to-end win.
- Shrinking the 19,000-character system prompt buys little latency (11–19% of the seconds).
- **Decode rate — and therefore throughput — tracks ACTIVE parameters, almost exactly
  inversely:** 3B-active → 1,515 prefill / 53.3 decode; 10B-active → 551 / 18.8; 32B dense →
  577 / 5.3 tok/s. Prefill does *not* scale the same way (a big MoE touches most experts across
  a batch), so a bigger MoE buys accuracy at a decode-only cost.

### Verify the served model, not the name

Production silently ran on the losing Q4 quant for months because a stale Tailscale hostname
pointed the router at the wrong box. Every study since reads the served model from each
response's own `model` field, never from the requested alias — and the worker records it on
every result. When anything about accuracy looks off, check what was actually served first.
Related open limitation: one router name (`Qwen3-6-35B-A3B-turbo`) still fans out to several
hosts at *different quants* (mac=Q8, 4090=Q4), so a tag cannot yet pin a specific box or quant.
The fix is distinct per-(host, quant) model names in the router config — see the comment block
in `functions/lib/models.ts`.

---

## Models

Models are selected by semantic TAG (`best`, `fast`, `vision` — `functions/lib/models.ts`,
mirrored in `bin/lib/models.js`), each resolving an ordered preference chain against live
router health. Env overrides `QWEN_MODEL_BEST/FAST/VISION` pin an exact model.

| Model | Architecture | s/page | Accuracy | Status |
|---|---|---|---|---|
| **Qwen3.6-35B-A3B** Q8 | MoE, ~3B active | ~30–36 | 84.9% base / **89.8% with serialization** (n=33 labelled, 196 slots) | **Production default** (`best` chain) |
| Qwen3.5-122B-A10B q5 | MoE, ~10B active | ~68–76 | 88.3% (n=33) | **Shelved** — see below. Candidate escalation tier only |
| Qwen3-VL-32B Q8 | dense 32B | ~274 | 93.6% (n=8, superseded scale) | **Not used** — dominated by the 122B; hallucinated a reagent lot on the text path |
| Qwen3-8B | dense 8B | fast | — | `fast` chain fallback (3080); the one place ` /no_think` still matters |
| qwen2.5-vl-7b | VLM 7B | — | — | `vision` tag (image-aware extraction) |
| Chandra OCR 2 (Datalab) | ~5B OCR | 100–163 s/page OCR alone | ties serializer (44.5/47, n=8) | **Not deployed** — narrow-fallback candidate; licence flag below |

### Why the 122B is shelved

At n=8 it looked like +6.4pp. At n=33 (byte-identical prompts, model the only variable) it is
**+3.3pp [+0.8, +6.3]** — real, but half the estimate, at **2.13× the wall time** and requiring
the second machine. Two facts kill it as a default:

1. **It loses to a text-ordering change costing ~11 ms/document.** Guarded serialization on the 35B is +4.8pp
   [+2.1, +8.5]; the 122B is +3.3pp for ~2,000,000× the marginal compute.
2. **The gains do not stack.** 35B+serialization 89.8%, 122B alone 88.3%, 122B+serialization
   **87.0%** — the stack is below either single intervention (−1.3pp [−3.7, +0.5] vs the 122B
   alone, P(better)=6%). The mechanism is visible in the changed values, not noise: the
   serializer's ` | ` column delimiters split cells the 122B was reading as one phrase, so it
   drops lot numbers whose cells are now separated from their labels (both EggSolutions
   documents), and it promotes exposed header text it then over-trusts — preferring the legal
   parent entity ("Smith Brothers Holdings Inc.") over the letterhead brand ("Smith Brothers
   Farms"), the exact opposite direction the 35B moves on identical serialized text. Better
   text does not compose with a bigger model; each model has its own reading of layout.

It also fabricates the same `product_code "64917"` as the 35B (few-shot bleed — capacity is not
the cure), and only reaches 1.0/8 on `code_date` where serialization reaches 4.0/8, because
code-date confusion is a *layout* problem. What the 122B is still good for: an escalation tier
on low-confidence items (the per-item confidence from migration 0062 is the natural trigger).
It matched the dense VL-32B's accuracy at 3.6× its speed with zero hallucinations at n=8.
Operational note: it occupies 92 GB of the Spark's 121 GB (cold load ~4m40s; do not raise
`--ctx-size` past 32768 without re-measuring).

### VLM mode is confirmed defective — do not enable

`QWEN_VLM_MODE=vlm` produced `coa_records = NULL` on **8/8** documents, lot coverage **1/10**
(vs 10/10 on every text arm), and on the hardest document emitted **one fabricated record in
place of eight real ones** — values absent from every page of the prompt. Mechanism:
`coaRecordsCapture` is populated only inside `runTextPath()`, so a *successful* VLM call skips
records assembly entirely and the worker posts a single flat field set. Enabling VLM mode
silently re-breaks every multi-record COA. Also: `QWEN_VLM_MAX_PAGES=5` silently truncates
longer bundles. The viable shapes are `dual` (text primary, VLM into the `vlm_*` review
columns) or a targeted fallback — and only after the records capture is fixed on that path.

### Chandra OCR 2 — capable, expensive, licence-encumbered

Ties geometry serialization exactly (44.5/47 at n=8) at 100–163 s/page on the unoptimised HF
path — **~16,000× the serializer's cost for the same score**. It is the only thing measured
that reads image-only letterheads (it recovered "Savencia Fromage & Dairy Cheese USA" from a
raster logo the text layer renders as `C2#`), but it also introduced a record-level regression
(relabelled `production_date` as `code_date` on both records of a document — an HTML-table
header-binding hazard, not a one-off). Reserved as a candidate for the narrow ~4% fallback
population only. **Licence flag: modified OpenRAIL-M** — free under $2M revenue and with a
"not competitively with our API" clause. Review before any production deployment or any
customer-facing use.

---

## The parsing strategy

Pipeline: **PDF → text layer → LLM extraction (one large prompt per page) → structured
fields + records payload.**

### The big finding: the text layer was being destroyed

The production text layer was `pages.join('\n').replace(/\s+/g,' ')`, and the single-page path
feeds `text.substring(0,6000)` of that collapsed string — so most documents (99% of the corpus
is single-page) reached the model as **one continuous line**, all row and column structure
gone. pdfjs provides x/y geometry for every text item; all of it was being discarded. Labels
arrived orphaned from their values ("`CODE DATE:` … 700 characters … `5/24/'26`"), and the
model's worst errors — code/production date swaps, colony counts extracted as lot numbers,
values read from the *filename* — trace directly to this.

### Geometry-aware serialization

`shared/pdfTextSerializer.ts` (mirrored at `bin/lib/shared/pdfTextSerializer.js`): group text
items into rows by y (tolerance 0.45× median glyph height), order within a row by x, emit
` | ` for column-sized gaps, keep newlines and paragraph breaks. No vocabulary, no supplier
knowledge, no model. Measured at n=99 (33 labelled / 196 graded slots, bootstrap CIs over
documents, 20,000 reps):

| Stratum | Effect (guarded) |
|---|---|
| documents with a text layer (n=26) | **+6.2pp [+2.6, +10.7]**, P(>0)=100% |
| all labelled, scans included (n=33) | **+4.8pp [+2.1, +8.5]** |
| scrambled reading order, D>0.20 (n=8) | **+9.1pp [+2.2, +18.1]** |
| clean reading order, D≤0.20 (n=18) | +5.0pp [+1.4, +9.8] |

And it is very nearly free — but not literally free, and the first reading was wrong. The
n=99 arm showed completion tokens −2.2% and wall clock within 0.1%; that measurement was
**contaminated by the bug this study found**, because six documents were emitting nothing at
all. Decomposed honestly: accepted documents cost **+1.1% prompt / +5.4% completion**, declined
documents 0.0% / +0.2%, overall **+0.8% prompt / +3.9% completion**, plus a second PDF parse at
11.4 ms/document (~75% more parse time, 0.03% of inference). The conclusion survives — the cost
is negligible against ~30 s/page of generation — but it is a cost, over an hour of continuous
inference at n=99 (the +10% latency seen at n=8 was host variance). It ties Chandra OCR — a
dedicated ~5B model at ~100 s/page, for roughly four orders of magnitude less compute. Beyond the score, it cuts
label-free invariant failures 30% (64→45 over 99 docs), and it suppresses two defect classes
outright: filename leakage (Andersen) and cross-document fabrication (`64917`, below).

### The guard IS the feature

Shipped exactly as first tested — unguarded — serialization measures **+1.5pp [−6.8, +7.9],
not significant**, because it destroys six previously-correct documents. The mechanism, spelled
out because it will bite again:

- `unpdf.extractText()` maps unmapped Private-Use-Area glyphs (broken `ToUnicode` CMap) to
  whitespace → the text reads empty → `text.trim().length === 0` → **tesseract OCR fires and
  works**. That is today's working fallback.
- `page.getTextContent()` — what the serializer uses — returns the raw PUA codepoints. 800–1,000
  characters of `U+F0xx` is *not* empty, so the serialized garbage is installed **after** the
  OCR decision has already been made, and the model receives pure garbage.

Six of 99 sampled documents went from 9–11 correct fields to `{}` (the labelled one: 6.5/7 →
0.0/7). This is 1.6% of the eligible corpus and **100% of one supplier** (Dairy Products LLC /
West Point). The guard is one condition: **decline the serialized override when it has almost
no alphabetic content (`alpha < 40` over >200 chars)** — which by construction restores the
baseline OCR path on exactly those documents. With the guard, no field regresses anywhere.

### Which path does a document take

| Condition | Detected by | Path | Share of corpus (n=436) |
|---|---|---|---|
| Usable text layer | serialized text has alphabetic content | **serialize → 35B** (the default) | ~91.5% |
| True scan (no text layer) | extracted text empty | tesseract @300dpi → 35B | ~7% |
| Broken encoding (PUA glyphs) | guard: `alpha < 40` over >200 chars | guard declines override → falls through to tesseract | ~1.6% |
| Image-only letterhead (`C2#` class) | masthead void (M signal) | text path runs but the supplier name is pixels, not text — candidate for the narrow OCR/vision fallback | ~2–3% |

**The dedicated-OCR-justified population is ~4% (broken encoding + image-only letterheads),
not corpus-wide.** OCR-everywhere costs ~16,000× per page for the same score as serialization.

### Routing signals

Two cheap, model-free signals (no GPU, milliseconds):

- **D — reading-order disorder**: fraction of consecutive text items that jump backwards up the
  page. Threshold 0.20; the corpus distribution is bimodal with a real valley (clean mode
  0.05–0.10, bad mode 0.24–0.36). 31.9% of the corpus exceeds it.
- **M — masthead void**: page-1's top line has <5 alphabetic characters *and* a >2-line-height
  gap below it — the letterhead is a raster image. Rare and specific (~3%).

Text-layer quality is a property of the *supplier's PDF generator*, so these signals cluster
almost perfectly by supplier: Andersen 80/80, Edaleen 43/43, EggSolutions 12/12, Pacific Cheese
3/3 flagged; Country Morning 0/152, Willamette 0/43, Daisy 0/19, Wilcox 0/12 never. Almost
nobody in between. Rollout, validation, and debugging of anything text-layer-related should be
done per supplier cohort, and one supplier changing its template moves a whole cohort at once.

---

## Prompt findings

- **` /no_think` was inert on the `best` chain** and has been removed from its call sites. The
  served Qwen3.6 template defaults thinking *off*; the real switch is
  `chat_template_kwargs: {enable_thinking: true}`. **Deliberately kept in
  `functions/lib/connectors/schemaDiscovery.ts`**, which runs on the `fast` chain where
  Qwen3-8B genuinely honours the soft switch. Do not re-add it elsewhere; do not remove it
  there.
- **Genuinely enabling reasoning: not worth it.** +4.3pp flat-field at n=8, but 6.6× wall
  clock, 7.6× completion tokens, and it *regressed record structure* (started eliding repeated
  values from multi-record payloads — the exact collapse class the flat score cannot see) and
  introduced a reagent-lot hallucination. If ever revisited, only as a targeted second pass on
  low-confidence items, graded on records, not fields.
- **The `code_date`/`production_date` glossary fix was the true root cause of a real production
  defect.** Reverting only the glossary costs −4.0/6 on `production_date` alone, with the
  mechanism visible: the old wording told the model to file a production date as a code date on
  single-date documents. This is the one prompt ablation that moved far outside noise.
- **The few-shot `PREVIOUS CORRECTIONS` block is kept but bounded** (`FEWSHOT_MAX_CHARS = 8000`
  in `bin/process-worker`). It is the only consumer of `extraction_examples` — the reviewer
  correction loop — so it stays. Honest status: at n=8 removing it changed zero graded fields,
  and the n=99 grounding sweep caught it **bleeding a fabricated `product_code "64917"` onto
  two documents whose item-number cell is blank** (the 122B fabricates the identical value).
  That is an open issue: the example set is the cause, and model scale is not the cure.
  Serialization suppresses this instance (an explicitly-delimited empty cell stops the
  invention) but the block needs a real fix.

---

## Honest limits — what these numbers do not cover

- **The labelled ground truth is 33 documents / 196 graded slots.** One point ≈ 0.51pp. All CIs
  are bootstrap over documents. Absolute accuracy is label-strictness-dependent; arm-to-arm
  comparisons are not.
- **99.1% of gradeable documents are single-page. The multi-page concatenated-bundle shape is
  untested across all three studies that tried** — approving a bundle replaces the original
  with page-scoped per-record slices, and only the slices survive in storage. The 8/7/6/6-page
  Schreiber and Darigold bundles exist only in that form. Multi-record *within a page* is well
  covered (cardinality correct 33/33 with serialization, including 3- and 4-record documents);
  the bundle shape is not. Getting un-scoped copies of those bundles is the single most
  valuable missing test.
- **Run-to-run noise: 0.0 graded points on byte-identical prompts, confirmed six times — but
  ungraded slots drift 9–28% on identical bytes.** An ungraded-field difference between two
  runs is not signal, ever. Nondeterminism alone has produced a garbage `plant_number` on a
  document nothing touched.
- **The flat field aggregate has been proven blind to a real defect four separate times**: a
  VLM-fabricated record (scored full marks), OCR relabelling `production_date` → `code_date`
  on both records of a document (zero penalty), a garbage value from pure nondeterminism, and
  the serializer's PUA kill (visible only as records cardinality 1→0). **Always read the
  records payload and cardinality separately from the field score.** Label-free invariants are
  a floor on the error rate, never a ranking of accuracy — the arm with the fewest invariant
  failures (122B+serial) scored *lower* against labels than the arm with more.
- **Open issues**: filename leakage (`lot_number`/`code_date` read from the filename despite an
  explicit prohibition in the prompt's `<filename_hint>` block, affecting the 80-document
  Andersen cohort whenever body text is hard to read — serialization suppresses but does not
  fix the underlying behaviour); the few-shot `64917` fabrication above; the `lot_in_text`
  invariant false-positives on normalised dates legitimately serving as lots.

---

## Provenance

The underlying studies (2026-08-04/05, in dependency order): prompt ablation (`ABLATION-REPORT`,
n=8), Mac-vs-Spark model A/B (`AB-REPORT`, n=8), Chandra OCR as text layer (`CHANDRA-REPORT`,
n=8), targeted OCR routing (`HYBRID-REPORT`, n=8 + 104-doc corpus scan), geometry serialization
(`SERIALIZATION-REPORT`, n=8), same-weights hardware bake-off (`HARDWARE-REPORT`, n=8 accuracy /
repeated throughput benches), and the scale replication (`SCALE-AB-REPORT`, n=99 sampled /
n=33 labelled / 436-doc corpus signals). Where an n=8 point estimate disagrees with the n=99
study, the n=99 study wins. Every study ran read-only against frozen worker copies with the
served model verified per response; none touched production state.
