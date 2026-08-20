# Plan

## In Progress

### Smarter Extraction (Phases 1–3)

**Status:** in-progress

**Summary:** The learning loop is broken end-to-end. `extraction_examples`
sits empty in staging despite 27 A/B evals; the text extractor is bleeding
filename tokens (e.g. Pacific Cheese's stale `25071R`) into structured
fields like `lot_number` / `code_date`; supplier names aren't deduped so
`Medosweet` exists three times; document type never gets canonicalized
(all evaluated rows have `document_type_id = NULL`); and we capture no
per-field signal — reviewer picks, dismissals, value edits, and table
edits all evaporate at approve time. Plan: ship three coherent phases —
foundation fixes, signal capture, then pre-fill + trust ladder + learning
dashboard — so the system progressively learns from every reviewer
decision and graduates suppliers from manual review through pre-fill,
silent-apply, and eventually full auto-ingest.

**Full plan:** `/home/hexi/.claude/plans/breezy-hatching-moonbeam.md`

#### Phase 1 — Foundation Fixes ships when:
- Filename no longer appears in extracted lot/code/date fields for
  Pacific Cheese
- Compare panel shows compacted (no-null) field counts
- New ingests populate `document_type_id` from guess
- Three Medosweet variants collapse to one supplier row on next ingest
- Approving with "Use these results" produces an `extraction_examples` row

#### Phase 2 — Capture All Four Signals ships when:
- Approving any reviewed item populates `reviewer_field_picks`,
  `reviewer_field_dismissals`, `reviewer_table_edits` as appropriate
- Per-field picker buttons in the compare panel work
- Single-side items default to the correct source

#### Phase 3 — Pre-Fill from Learned Preferences ships when:
- A queue item with learned preferences renders pre-filled with badges
- Reviewer can confirm with one click; overrides update preferences
- `extraction_examples` accumulates synthetic rows from preference rollups
- Uncertain fields surface at the top of the review UI with badges
- Trust ladder state visible per (supplier, doctype); promotion/demotion
  rules fire correctly on approve/override
- Learning dashboard renders override-rate trend + trust-level distribution

## Planned

### Spec limits + out-of-parameter warnings

**Status:** done (Phases 0–2 built, not deployed)

**Summary:** The portal read COAs but never judged one — a 40 CFU/g coliform
against a 10 CFU/g limit reached a reviewer looking exactly like a clean
result. Three phases shipped together: the COA's own printed spec/pass-fail
(no configuration, every supplier, day one), our configured limits
(`spec_tests` + `spec_limits`, tenant → supplier/doctype → product, most
specific wins), and the register + notify hop (`document_spec_checks`, one
email per document routed by `assignments`). Engine is three-state on purpose:
`not_checked` means we held a limit and could not honestly apply it, and is
never a silent pass — the false negative is the failure mode that would
discredit the feature, since extraction runs at ~90.6% and the results table is
where its known defects live.

**Full plan:** `/home/hexi/.claude/plans/dynamic-splashing-wreath.md`

**Not included, deliberately:** product-scoped limits are stored but not
offered in the admin UI — the review queue cannot resolve a document's products
at review time, so such a limit would list as active and never fire.
`bin/recheck-spec-limits` reports but does not backfill the register; writing
would mean bypassing the read-only guarantee in `bin/lib/d1.js`, and the
register fills going forward on every approval.

**Still needed from AJ:** spec limits as five columns — test name **as the
supplier prints it**, operator, value, unit, scope. The printed names are the
load-bearing part; matching is exact, never fuzzy.



### COA extraction — deferred items after the 2026-08-04/05 measurement sessions

**Status:** planned (2026-08-05). The extraction workstream is otherwise CLOSED — geometry
serialization, the broken-encoding guard, `product_code` grounding, the Spark/Q8 router fix,
the VLM startup guard and source-bundle retention are all shipped, deployed and verified on
real documents. Evidence lives in the session reports: `SCALE-AB-REPORT.md` (n=99, the
authoritative one), `PORT-REPORT.md`, `KINDS-FTS-REPORT.md`, `HARDWARE-REPORT.md`,
`SERIALIZATION-REPORT.md`, `CHANDRA-REPORT.md`, `HYBRID-REPORT.md`, `ABLATION-REPORT.md`.
Summary + numbers in `MODELS.md`.

**1. The serializer smashes some real words together (KNOWN DEFECT, LIVE).**
`WITHOUT PRIOR WRITTEN APPROVAL` -> `WRITTENAPPROVAL`; `IS REPRESENTATIVE OF` ->
`REPRESENTATIVEOF`. The column-gap threshold reads those inter-word gaps as sub-word gaps.
Measured rate: **2 genuine false joins in 70 documents against 209 genuine token repairs
(~100:1 in favour)**, so the win holds — but this is a NEW failure mode in the OPPOSITE
direction from the one serialization fixes, and it degrades what the MODEL reads, not just
the search index. It appears in neither SERIALIZATION-REPORT nor PORT-REPORT; only the
FTS/kinds validation caught it.
*Likely fix:* scale the word-gap threshold by font size. The ROW tolerance in
`shared/pdfTextSerializer.ts` already scales this way; the COLUMN gap does not.
*Validation is cheap:* the 99-document arm already exists — re-run and diff.

**2. One production order document carries a fabrication that serialization fixes.**
The single order PDF in prod (8 of the 9 orders are `.docx` and never touch the serializer;
there are 0 shipments) has `"customer_name": "PARTNERS 360"` stored — a Cube column welded
onto a name by the OLD flattened text. Re-extraction produces 12/12 fully-correct records
against 10/13. One `bin/reprocess-queue --item <id> --remote --apply` fixes it.

**3. Watch record counts on the FIRST real shipment PDF.**
There are ZERO shipment documents in production, so shipment extraction under serialization
could only be probed synthetically (63 real COAs through `processShipmentItem`). Records went
50 -> 37 with 8 items dropping to zero — but those inputs are COAs, so `{"shipments": []}` is
arguably the CORRECT answer and the flattened arm was hallucinating shipment lines out of a
COA. The mechanism was checked, not assumed: it is the multi-line layout making the model
structure-aware, not header/table block separation. **Do not roll back on this.** But the same
conservatism on a real bill of lading with a header PO could drop every line.

**4. Two duplicate PDF extractors.** `extractTextAndPages()` and the inline extractor in
`processCoaItem()` both do PDF text extraction; the COA path production actually runs is the
inline one, and every one of the 99 validation documents went through the other. It was
closed by a live smoke test rather than by unifying them. Unifying is the real fix.

**5. The narrow OCR fallback (~4% of corpus) is designed but not built.** Serialization cannot
help image-only letterheads (the `C2#` / Savencia class) or broken-ToUnicode PDFs — those
pixels/letters are genuinely not in the file. Routing signals exist and were validated
(`textqual3.js`: reading-order disorder + masthead void); Chandra OCR 2 ties the serializer on
accuracy at ~100 s/page, so it is worth paying ONLY for that ~4%. **Licence needs a decision
first:** modified OpenRAIL-M, free under $2M revenue, "not competitively with our API".

**6. The measurement harness still lives in `/tmp` and will evaporate.** It found a dead prompt
string, broke a hardware confound, caught a fabricated record and found the destroyed text
layer. Per the scripts-first rule it belongs in `bin/`: the parity runner, the prompt-mutation
hook, the text-override hook, the serializer bench, the quality detector — and ONE grader
(`spark-grade.js` and `ablate-grade.js` both score a MISSING records payload as "1 record",
which flatters a model that emitted nothing; `chandra-grade.js` is the fixed one).

**7. Ground truth is 33 labelled documents; ~436 are now reachable.** The corpus unlock
(queue -> `documents.external_ref` -> `document_versions.r2_key`) made the whole approved
corpus fetchable. Stratify by SUPPLIER — text-layer quality is a property of the PDF
generator, and cohorts are emphatically bimodal (Country Morning 0/37 vs Schreiber 5/5).
Caveat: approved documents passed the human gate, so the sample is slightly optimistic
(selection bias measured at ~2.5 pts previously).

**8. Multi-page BUNDLES remain unmeasured across three studies.** 99.1% of the gradeable
corpus is single-page. Source-bundle retention now ships, so the evidence ACCUMULATES from
2026-08-05 forward instead of being destroyed at approve — but it needs real multi-page
uploads before it can be measured. Worth asking AJ to send one deliberately.

**9. Two fabrications are FLAGGED, not PREVENTED.** `product_code` copied from a few-shot
example onto a document whose cell is blank (15/670 corpus-wide, 2.2% — the single largest
failing invariant), and `lot_number` read out of the FILENAME. Both now surface as inline
review warnings via `product_code_in_text` / `lot_in_text`. Prevention would mean retiring the
few-shot block (which is the only consumer of `extraction_examples`, i.e. the reviewer-
correction loop) or prompt-wrestling a behaviour the 122B shares identically — so catching at
the gate was chosen deliberately. Note grounding is a FLOOR on the error rate, not accuracy:
a value that IS on the page but belongs to a different line item passes every check.


### Extraction defects confirmed by the Q4/Q8 A/B — two named, quant-proof gaps

**Status:** planned (2026-07-30). Evidence:
`~/drops/dox-wms/COA_ACCURACY_Q4_vs_Q8_2026-07-30.md` (raw per-doc outputs + harness patch
archived alongside). Both arms served-gguf verified on every call; 15/19 docs on both arms.

**Headline:** fixing the router hostname ([[project_qwen_fleet_q8_hostname_trap]]) took record
accuracy **30.4% → 75.0%** (112 expected lot/sublot records); lot-level 68.8% → 89.3%. Paired
2×2: Q8-only fixes **52 records (46.4%)**, wrong-on-both **26 (23.2%)**. So Q8 recovers ~2/3 of
known failures with no code change — but a ~23% floor remains and it is OURS, not the model's.

#### D1 — sublot has no slot in the flat schema (the bigger, cheaper win)
`sub_lot_code` exists ONLY inside the `records[]` array, while the prompt explicitly licenses
omitting `records[]` when a page has one lot and one sublot. So a *compliant* output has nowhere
to put the sublot — it is a schema defect, not a weights problem. **17/28 affected pages lose it
on BOTH arms** (Q4 loses 28/28). Affects `5a844c7b`, `7707e264`, `9b1c0e97`, `49fd0028`,
`0cfb0cc3`, `0ca1a067`, `5df1ae2f`, `3eba3197`.
Ships when: a single-lot/single-sublot page can express `sub_lot_code` without being forced into
`records[]` (or the omit-records licence is withdrawn); `lot_key` becomes lot+sublot rather than
bare main lot for those pages; regression test per affected doc.

#### D2 — Andersen reagent-lot misread — CLOSED as WONTFIX 2026-07-30
Original framing was wrong twice over, and the record is worth keeping.
1. Those codes (`418325187C` / `346PXN` / `151262C`) are **lab consumable lots** (CC plates / AC
   plates / BUFFER), not product lots — verified against the source PDF. Ground truth was wrong;
   two docs were graded FAIL for correctly declining them and one PASS for extracting them. See
   the correction block atop `~/drops/dox-wms/COA_GRADING_REPORT.md`.
2. **Andersen has since moved to a NEW COA format**, so this is a legacy-corpus problem. The old
   docs are disposable.

A BASE-prompt rule was written and then **REVERTED**. Two lessons, both load-bearing:
- **Wrong layer.** A single supplier's quirk belongs in `supplier_extraction_instructions`
  (migration 0035, applied via `fetchReviewerInstructions`/`prependReviewerInstructions` — the
  two-layer design, [[project_two_layer_prompts]]). Putting it in the BASE prompt applied one
  supplier's legacy quirk to every document from every supplier.
- **It caused collateral damage.** `2a74acd6` lost **6 of 11 table columns** against the prompt's
  own "do not drop columns" instruction — prompt growth crowding out other behavior. That
  generalizes badly beyond this corpus and is the real reason not to grow the base prompt.
- The rule was also mechanically WRONG: it prescribed positional label↔value re-pairing, but the
  flattened value run starts at the AC lot, so positional pairing inverts CC/AC on 3/3.

If this ever matters again: supplier-specific instructions row, not the base prompt.

#### D4 — measure accuracy at CORPUS scale (the A/B sample was 15 of 552)

**The gap:** every accuracy figure we have comes from the 19-doc (15 runnable) graded set in
`COA_GRADING_REPORT.md`. Prod holds **552 documents / 674 COA queue items**. Worse, that set was
built as a Darigold multi-sublot corpus — curated for the HARD cases — so it measures the
difficult tail, not the library. Right sample for "did the fix work"; wrong basis for "what is our
accuracy," which is what the client is actually asking. True corpus rate is very likely better.
Do NOT quote subset figures as an overall rate (the note at `~/drops/aj-extraction-notes.md` now
says so explicitly).

**Two measures available now, neither needing new hand-grading:**

- **Reviewer corrections as ground truth (the big one).** Migration 0038 persists every reviewer
  decision and prod already holds **2,930 `reviewer_field_picks` + 175 dismissals + 115 table
  edits** — ~3,200 labelled judgements on real documents from real suppliers. A correction is a
  labelled model error; an accepted field is a labelled success. Free, corpus-scale, and it
  measures the operationally meaningful quantity (reviewer correction load) rather than
  first-pass perfection. This is the same data [[project_owned_review_flow_direction]] wants for
  maturity/promotion — one pipeline serves both.
- **Differential testing, no answer key needed.** Run two configurations over all 674 items and
  keep only the docs where they DISAGREE; errors concentrate there. Hand-grade only the
  disagreements → corpus coverage for a fraction of the effort. This is also the cheap way to
  regression-test any future prompt change.
- **Plus free invariants over all 552:** does the extracted lot string actually occur in the
  document text? is `sub_lot_code` 2 digits? do dates parse? No model needed; catches a whole
  class of fabrication.

Ships when: an accuracy number exists that describes the real corpus, and any client-facing figure
is sourced from it rather than from the 15-doc set.

#### D3 — measurement hygiene (do before claiming any per-doc number)
- **Q4 is unstable, not reproducibly wrong**: this run's Q4 grades differ from the June Q4-era
  grades on **5 of 15 docs**, and *which* lots it drops moves between runs at temp 0 / seed 42.
  Per-doc grades carry ~±1 grade noise; only aggregates are defensible. Multi-trial before any
  per-doc claim.
- **Q8 regressions exist** — do not oversell: 4 FAILs vs Q4's 3. `3eba3197` (trivial 1-lot COA)
  Q4 got lot `22026110`, Q8 returned none; 2 records on `5a844c7b` p1 Q4 got and Q8 lost.
  "Two main lots sharing a sublot column" is REFUTED as a hard gap but fragile (Q8 29/31).
- **4 docs unrunnable — source PDFs 404 from R2**: `dd37a5ca`, `fe2f07b7`, `66724a88`,
  `e578ae9d`. Three were easy singles, so the covered set skews hard and BOTH arms read
  pessimistically. Same class as the known 11 R2-404s. Clean up or re-upload.
- Throughput measured, not assumed: **Q8 ≈ 3× Q4 wall clock** (35 min vs 12.3 min / 15 docs) —
  not the 9× previously assumed. Budget accordingly.
- VLM was OFF for this run; it is still the expected fix for image-letterhead + scanned layouts.

### Model resiliency — remaining follow-ups (core SHIPPED, uncommitted)

**Status:** in-progress (2026-07-30). Core landed: `MODEL_CHAINS` preference chains +
health-aware `resolveModel()` in `functions/lib/models.ts` and its `bin/lib/models.js`
mirror; all 7 `modelFor` call sites converted; degradation logged, never silent; worker
preflight banner; `text_model` (served id incl. quantization) on the result body.
36 unit tests, 247 green across affected files.

**Why the chain order is what it is (do NOT "optimize" it back):** `best` is ordered by
QUANTIZATION, not speed. The `-turbo` backend (RTX 4090) serves **Q4_K_M** — the quant
that returned ZERO per-sublot records in the bake-off where Q8 returned four. 24GB
cannot hold this model at Q8, so turbo is permanently the FAST tier and the availability
floor for `best`. `fast` leads with turbo because a human is waiting on those paths.

#### Done 2026-08-01 (uncommitted):
- **Persist `text_model`.** Migration `0082_processing_queue_text_model.sql` adds the
  column; `functions/api/queue/[id]/results.ts` passes it through beside `vlm_model`.
  Readable via `GET /api/queue` + `/api/queue/:id` (both select `pq.*`). Registered in
  `tests/helpers/db.ts` and applied locally with `bin/migrate --only`. **Not on prod.**
- **VLM path routed through chain resolution.** `bin/process-worker` resolves the
  `vision` tag per call via `pickVlmModel()`; `QWEN_VLM_MODEL` still PINS (expressed as
  the tag's standard `QWEN_MODEL_VISION` override, so preflight reports it as PINNED).
  `vlm_model` now records what the router SERVED, not what we asked for.
- **Degradation surfaced in the app.** `/api/admin/processing-status` returns
  `models: { tags[], degraded }` (tag → resolved model, preferred, chain, source), and
  the Processing Status page renders a "Model resolution" card that goes yellow on a
  downgrade and red on a dead chain. Reuses the resolver's ~60s health cache — one
  `/v1/models` lookup for all tags.

#### Remaining, in priority order:
- **Q8 on the always-on host.** Q5_K_M is what it serves today — neither the Q4 that
  failed nor the Q8 that passed. Register a Q8 backend and add its router name at the
  HEAD of the `best` chain; the resolver auto-promotes it with no other change.

### Deployment portability — cloud (Cloudflare) AND on-prem appliance

**Status:** planned (2026-07-30). Motivation: both targets must be supported. Cloud is
what we run today; on-prem is the answer for customers whose PII cannot sit with a
third-party processor (see `~/drops/dox-data-handling-and-roadmap.md` §4). A DGX Spark
has been purchased, so this has real hardware behind it and is no longer hypothetical.

**Key insight:** the stack is unusually portable and mostly by luck. **D1 IS SQLite** and
FTS5 is SQLite-native, so the database and the entire search layer move unchanged.
`bin/process-worker` is already plain Node. Inference is already self-hosted. The
genuinely Cloudflare-shaped surface is the Pages Functions runtime and its bindings
(`env.DB`, `env.FILES`) — one port, not a rewrite. A Spark's 128GB comfortably holds the
model AND the application, making "one box, drop it in the network, nothing leaves" a
real product rather than a slide.

**The honest cost is not the port — it is that two targets = two test matrices, two
release paths, and a support surface for patching boxes we cannot SSH into.** That is
what kills these efforts. Sequence accordingly and do not start until a customer is real.

**Approach:** the SharePoint entry's P1 `StorageProvider` seam is the same seam local
object storage needs — build it once, get a third implementation nearly free. Until this
workstream starts in earnest, the standing rule is **portability-preserving**: no NEW
Cloudflare-only bindings, and anything touching storage goes through the provider seam.

#### P1 — Portability audit ships when:
- Every Cloudflare-specific dependency is inventoried (bindings, Pages middleware,
  wrangler-isms, Workers runtime APIs) with a portable substitute named for each
- The result says plainly how big the runtime port actually is, in days

#### P2 — Local target ships when:
- Functions run under a portable runtime (workerd or a Node adapter — P1 decides)
- SQLite + local object storage via the StorageProvider seam; FTS5 unchanged
- `bin/` scripts and the worker run against the local target
- One command stands up the whole application on a single box

#### P3 — Appliance packaging ships when:
- Reproducible install onto Spark-class hardware incl. the model
- Backup/restore, update path, and remote support story for a box we do not control
- SMTP option (Resend is a third party and may be unacceptable to the same customers)

**Open:** single-tenant simplifications on an appliance; how updates reach a customer
box; whether the appliance ships the full Records module or a subset.

### Registry taxonomy — four facets, per-tenant config (AJ correction + vertical readiness)

**Status:** planned (2026-07-29). Motivation: AJ's schema correction. The shipped
registry collapses three different questions into ONE vocabulary. `document_types`
serves as both "what it is" and "what it satisfies" (via the 0076 `document_categories`
junction, which points at `document_types`), and `bin/create-tenant:67-75` seeds it
with 27 Food Safety Manual *program folders* ("Allergen", "Organic Program") — which
are a third thing again. Our own UI copy shows the collision:
`DocumentCreate.tsx:294` reads "Pick every document type this satisfies" — layer-2
semantics on a layer-1 field holding layer-0 data.

**The model AJ actually needs — three questions per document:**
1. **What it is** — the document type. ONE value. Specification Sheet, Kosher
   Certificate, 3rd Party Audit Report.
2. **What it satisfies** — which checklist (SOP 102.2) line items this file closes.
   MANY. One spec sheet typically closes seven (Spec Sheet, Micro Limits, Pack Size,
   100g Nutritionals, Allergen Matrix, Country of Origin, GTIN). Seven things to
   know, one file answering all of them — this is what "one doc, many mappings"
   actually meant.
3. **What it triggers** — claims the document asserts that require a DIFFERENT
   document to prove. A spec sheet saying "Organic, Kosher" is not an organic
   document; it makes two other documents newly applicable and missing.

**Key insight:** layer 2 CLOSES checklist items, layer 3 OPENS them. Layer 3 is
entirely absent today (grep for claim/trigger/requirement/checklist across
functions/, shared/, src/, migrations/ → zero scaffolding) and it carries most of
the product value: "this spec sheet claims organic and the organic certificate is
missing." Layer 2 is ~80% built — the junction, `is_primary`, the FTS `category_text`
column and its refresh triggers (0079 §5b) all work; it is mis-vocabularied, not
missing. Layer 1 is already single-valued (`documents.document_type_id`). Layer 3
also needs a piece AJ did not name: a **claim → required-document mapping**, or a
detected claim cannot resolve to "which document is missing." That config lives in
his "conditional triggers" — we need it from him.

**Second driver — the finance vertical.** Medosweet wants a finance module (historical
financial records). It is the first non-food domain and the proof that the platform
is aimed by configuration, not rebuilt per vertical. Every facet below is therefore
built as **per-tenant rows, never code**. Audited what is already domain-neutral:
ingest/R2/versioning/FTS/NL-retrieval/RBAC/multi-tenancy/audit log are clean;
`primary_metadata`/`extended_metadata` are free-form JSON (no hardcoded field list);
`INDUSTRY_PROMPTS` (`functions/lib/llm.ts:71`) is already a keyed map with one entry
(`DAIRY_FOOD`) overridable per tenant via `tenants.extraction_context` (0072). The
one real blocker is `output_kind` — no CHECK constraint (data-cheap) but dispatch is
spread across ~28 files, so a new kind is a code change in N places. That is P6.

**GREENFIELD** — no production registry data to migrate. Clean rebuild, no backfill
compromises, no dual-read period.

**Approach:** four independent facets, each a per-tenant vocabulary table + a
junction. Layer 1 stays on `documents.document_type_id` (already single-valued,
already tenant+supplier scoped) with the program folders evicted from that table.
New: `program_sections` (layer 0, the manual's 100-126 structure / a finance
equivalent), `requirements` (layer 2 checklist items), `claim_types` +
`claim_type_requirements` (layer 3 + what each claim opens). Junctions:
`document_program_sections`, `document_requirements`, `document_claims`.
`document_claims` carries an optional subject (product_id) so a claim resolves to a
specific gap, not just a tenant-wide one. Gap detection is then a query, not an
engine. Repurpose or drop 0076's `document_categories` — decide in P1.

#### P1 — Facet schema + vocabularies — **DONE** (2026-08-01, local only, uncommitted)
- `migrations/0080_registry_facets.sql` — `requirements` + `document_requirements`
  (layer 2), `claim_types` + `document_claims` (layer 3),
  `claim_type_requirements` (claim → what proves it). All tenant-scoped rows.
- `migrations/0081_documents_classification_status.sql` —
  `classification_status` + `classification_reviewed_at/_by`, indexed
  `(tenant_id, classification_status)`.
- `shared/types.ts` — `RegistryFacet`, `RegistryLinkStatus`, `RegistryLinkSource`,
  `ClaimSubjectType`/`Grain`, `ClassificationStatus`, the five row types and the
  two Api* join shapes.
- `functions/lib/registry.ts` — generalized to a `FACETS` descriptor table with
  `validateFacetIds` / `validateClaimSubjects` / `syncDocumentFacet` /
  `listDocumentFacet` / `parseFacetLinks` / `requirementsOpenedByClaims`. The
  three `*Categor*` functions are `@deprecated`, still wired to the shipped
  write path, and share the validation implementation.
- `tests/unit/registry-facets.test.ts` (45 tests) + both migrations registered in
  `tests/helpers/db.ts`.
- `bin/migrate --only <file>` added: the chain is not re-runnable and local/prod
  tracking has drifted, so a plain run aborts on an already-applied file. New
  migrations are applied surgically. Used for 0080/0081 on local D1.

**Decisions taken in P1:**
1. **0076 `document_categories` — RETIRED, dropped in P3, not P1.** It cannot be
   dropped in isolation: 0079's `documents_fts_source` VIEW selects from it to
   build `category_text`, and every documents/versions/products/lots FTS trigger
   writes through that view, so the DROP has to happen inside a view rebuild.
   P1 leaves it functioning and unread by anything new.
2. **Claim subject grain — polymorphic `(subject_type, subject_id)`,** plus a
   `claim_types.subject_grain` declaring the expected grain per vocabulary row.
   No CHECK on either, so a new grain is data. Concrete nullable
   `products`/`suppliers` FKs were rejected: SQLite cannot FK a polymorphic
   column, and an FK to `products(id)` would not have enforced tenant scoping
   anyway — validation had to live in the lib regardless.
3. **Layer-0 `program_sections` — NOT BUILT.** The manual's folders 100-126 are
   AJ's binder shelf layout; what a doc IS / SATISFIES / TRIGGERS already covers
   the information. Skipping it saves a table, a junction, an FTS column and a
   picker. Build only if he asks for it by name.

Also decided: `status` on both junctions is `suggested | confirmed | rejected`
with the **column default 'suggested'** (fail-safe for any ungoverned insert)
and the **lib default 'confirmed'** (the human editing path). `rejected` rows are
retained, and `syncDocumentFacet(..., { preserveRejected: true })` stops a
re-running extraction pass resurrecting a link a human already turned down.
`source` is an open set with no CHECK, validated in the lib, so a new pipeline
never needs a SQLite table rebuild.

#### P2 — Vocabulary CRUD + tenant provisioning — **DONE** (2026-08-01, local only, uncommitted)
No schema changes; P1's tables carried it.
- **REST** — `/api/requirements` + `/api/requirements/:id`, `/api/claim-types` +
  `/api/claim-types/:id` (GET returns the claim AND its rules), and
  `/api/claim-rules` (GET all rules joined / PUT replaces one claim's whole set).
  Shape, role gate (`super_admin | org_admin`), tenant scoping and soft-delete
  all copied from `/api/document-types` rather than reinvented.
  `functions/lib/registry-vocab.ts` holds `syncClaimTypeRequirements` /
  `listClaimTypeRequirements` / `parseClaimRules`, validating BOTH sides through
  P1's `validateFacetIds` so a mapping can never straddle tenants.
- **UI** — `admin/Requirements.tsx` ("Checklist"), `admin/ClaimTypes.tsx`
  ("Claims"), `admin/ClaimRules.tsx` ("Claim Rules") + the shared
  `components/ClaimRequirementsDialog.tsx`. Wired into Settings and
  `/admin/{requirements,claim-types,claim-rules}`.
- **Starter packs** — `starter-packs/{fsqa,finance}.json` (data a non-engineer
  can edit) compiled by `bin/lib/starter-packs.mjs` + `bin/render-starter-pack`.
  `bin/create-tenant` gained `--pack <name>` (default `fsqa`), `--no-pack`,
  `--list-packs`; the 27-item bash array is gone. Ids are deterministic
  (`req_<tenantslug>_<slug>`), statements are INSERT OR IGNORE, so re-running
  adds nothing and preserves admin edits.
- **The two audit documents** ship as distinct document types AND distinct
  requirements in `fsqa`; the `gfsi-certified` claim opens both.
- Tests: `tests/unit/starter-packs.test.ts` (29), `tests/api/registry-vocabulary.test.ts`
  (40), `tests/api/starter-packs-seed.test.ts` (9).

**Known gap for later:** per-document-type default expiry/renewal cannot be
expressed — `document_types` has no renewal columns (renewal lives per
document, migration 0077). The report-vs-certificate expiry difference is
carried as row DESCRIPTION text only. A `document_types.default_renewal_type` +
`default_renewal_interval_months` migration is the honest fix; deliberately not
written here because P2 was scoped no-schema-change.

#### P3 — Document editing + upload across facets ships when:
- `DocumentCreate.tsx` and document-detail editing expose all four facets with
  correct labels ("What it is" single-select, "What it satisfies" multi-select,
  "Claims" multi-select) — and the misleading line 294 copy is gone
- Ingest API accepts facet arrays; claims land as **suggestions a human confirms**,
  never auto-applied (consistent with no-auto-ingest — a wrong AI claim read would
  manufacture a false missing-document alert)
- FTS rebuilt with `requirements_text` / `claims_text` (no `program_text` — layer 0
  is not built) (0079-style DROP+recreate, new columns appended LAST to preserve
  snippet() indexes) + reindex
- **`document_categories` physically dropped in that same migration.** P1 retired
  it logically but could not drop it; the exact removal checklist is:
  `DROP TRIGGER trg_document_categories_ai_fts` / `_ad_fts`; rebuild
  `documents_fts_source` with `category_text` replaced by `requirements_text`
  (+ `claims_text`) — it is the only reader that blocks the drop; add
  INSERT/DELETE/UPDATE FTS triggers on `document_requirements` and
  `document_claims` mirroring the old junction triggers; retarget
  `functions/lib/search-fts.ts` (`category_text: 11` in the column map and its
  weight at index 6); retarget the `category_id` filter in
  `functions/api/documents/search/index.ts:141-146`; swap the category read
  subqueries in `functions/api/documents/[id].ts:54` and `:366`; swap the
  category write path in `functions/api/documents/ingest.ts` (imports at 16-18,
  writes at 396 and 556) to `syncDocumentFacet('requirement', ...)`; drop
  `DocumentCategoryRow` / `ApiDocumentCategory` and `Document.categories` from
  `shared/types.ts`; delete the three `@deprecated` `*Categor*` functions in
  `functions/lib/registry.ts`; update `tests/api/documents-registry.test.ts:107-137`
  and `tests/api/documents-search.test.ts:551-590`; remove `document_categories`
  from `tests/helpers/db.ts` cleanTables; finally `DROP TABLE document_categories`

#### P4 — Gap detection ships when:
- A gap view answers, per scope (product / supplier / facility / tenant): which
  requirements are closed, which are open, and which claims have no proving document
- Unclassified count surfaced as its own countable bucket
- The claim→requirement mapping is loaded from AJ's conditional-trigger config

**Sequencing:** P1-P3 are startable NOW — greenfield, no external dependency, needed
regardless of the finance bid. **P4 is blocked** on AJ supplying his conditional-trigger
config (claim → which document proves it); without it a detected claim cannot resolve to
a named missing document. Build P1-P3, then P4 lands the moment that config arrives.

The retention direction and the kind-dispatch registry were originally P5/P6 here; both
are finance-vertical prerequisites rather than part of AJ's correction, and are parked in
`backlog.md` under "GATED: Registry taxonomy P5/P6".

**Open decisions — all three resolved in P1 (see the P1 block above).** The only
one still needing AJ is confirmation that he does NOT want the layer-0
program-section facet; the schema is built as if he does not, and adding it later
is additive (a table + a junction + an FTS column), not a rework.

**Still blocked on AJ:** his conditional-trigger config (claim → which document
proves it). The table that holds it, `claim_type_requirements`, now exists and is
empty; P4 is a query over it the moment the rows arrive.

### Multi-product / multi-lot / multi-page COAs (make COA a records-kind)

**Status:** planned (2026-06-05). Motivation: a multi-page COA (Darigold
one-product-per-page, Savencia multi-product-per-row, Darigold multi-lot/sublot)
is captured but FLATTENED — the text path chunks every page then
`mergeTextExtractions` concatenates `products[]`/`tables[]` and keeps one flat
field map, so per-product/per-lot structure is lost and only a crude manual
"multi-product mode" splits it. Goal: no data lost on any COA; each product/lot
becomes its own reviewable, approvable record → its own `documents` + `lots` row,
so order⇄COA matching works per lot.

**Key insight:** orders/shipments ALREADY have the records model COA needs —
`processing_queue.ai_records` (mig 0067) + `output_kind` routing + per-record
review tile (`OrderReviewTile`) + `handleRecordsApprove`. This is "make `coa` a
records-kind," not a greenfield build. Adopts Chris's playbook DATA model
(`record_cardinality`, `record_key_basis`, page-metadata vs per-record, `sub_lot_code`,
structured groups) — not his prompt machinery (we have the two-layer prompt + teach loop).

**Approach:** hybrid extraction — LLM emits `records`/`record_cardinality`/`page_metadata`
(prompt return-shape extension), a deterministic `mergeCoaRecords` assembles records
across chunk boundaries (the LLM is blind across chunks) and hoists shared fields to
`page_metadata` (over-split guard). Reuse `ai_records` (no migration P1–P4). New
`CoaRecordsReviewTile` (per-record edit + partial approve). Generalize
`produceMultiProductCoa` → `produceCoaRecords` with per-record lot linkage.
Flag-gated `COA_RECORDS_MODE=off|shadow|on`, staging-first.

**Full plan:** `/home/hexi/.claude/plans/coa-multi-record.md`

#### P1 — Model + worker emits records (shadow) ships when:
- `shared/types.ts` has `CoaRecord`/`CoaRecordsPayload`/cardinality enums
- Worker COA prompt returns `records`/`record_cardinality`/`page_metadata`
- `mergeCoaRecords` assembles + dedupes records across chunks (lot/sublot/product key)
- `COA_RECORDS_MODE=shadow` posts `ai_records` alongside `ai_fields`; real
  Darigold/Savencia/Andersen COAs inspected and split correctly

#### P2 — Queue storage/serving ships when:
- GET/list queue endpoints surface records-shaped COA `ai_records` with per-record confidence

#### P3 — Review UI ships when:
- `CoaRecordsReviewTile` renders page-metadata panel + one editable record per
  product/lot with source-page + low-confidence chips
- `ReviewQueue` dispatches records-shaped COA → new tile; single-record → flat editor unchanged

#### P4 — Per-record approval (`on`) ships when:
- Record unit = per lot/sublot: approving an N-lot COA creates N documents + N lots; order⇄COA matches per lot
- Each split document stores a PAGE-SCOPED PDF (its own `source_pages` extracted via `unpdf`), not the whole file
- Partial approval (approve/hold/reject per record) leaves held records `pending`

#### P5 — Retire manual multi-product mode ships when:
- `isMultiProduct()` heuristic + shared/per-product UI removed; `produceMultiProductCoa`
  collapsed into `produceCoaRecords`; multi-product COAs route only via the records path

### Connector extraction repair surface (3-stage, sequenced)

**Status:** planned (2026-05-12). Motivation: extraction occasionally
gets specific docs wrong (Anderson Dairy, Darigold flagged as
particularly bad) and the user has no way to fix the output without
re-running with new mappings. Need an escape hatch from "the LLM
got it wrong" all the way through to "the system learned and got
it right next time".

| # | Slice | Why | Rough effort |
|---|-------|-----|--------------|
| R1 | **Per-run manual edit table.** After a connector run, surface the extracted orders/customers/items in an editable table. User can fix incorrect values, mark wrong rows, click Save — changes write back to the DB. No new schema; no learning. Just a fix-and-move-on workflow when the LLM is wrong. | Immediate relief. Today there's no path from "ingest broke" to "fixed data" without re-running with different mappings. | ~1d |
| R2 | **Per-supplier extraction instructions.** Add a notes/instructions field on suppliers (or reuse `supplier_extraction_instructions` from migration 0035) that gets concatenated into the extraction prompt when a doc is ingested from that supplier. Examples: "Anderson Dairy uses Product Code in column 3", "Darigold puts lot numbers in the Description column with prefix LOT-". Per-vendor tuning without code changes. | Closes the loop on R1 — corrections become reusable. Vendor-specific quirks stop costing us a re-run each time. Memory hint: see `supplier_extraction_instructions` table (mig 0035). | ~2-3d |
| R3 | **Visual annotation + chat mode.** PDF/XLSX/image viewer with bbox draw + caption layer. User outlines regions and types instructions ("this column is product code + name combined, split on the dash"; "treat this group of rows as a table"). Annotations get bundled as JSON and fed to the extraction LLM as extra context. Optionally use `qwen2.5-vl-7b` (already in `modelFor('vision')`) so the model literally sees the overlays. Optional chat loop refines output ("the qty on row 3 is 23 not 2"). | The strongest version. Unlocks weird docs that can't be solved by mappings or per-supplier instructions. Captures the user's "click + drag + note" idea from 2026-05-12. | ~2-3w |

**Sequencing rationale:** R1 alone is more valuable than waiting on R3; ship it first. R2 builds on R1 by turning manual edits into persistent vendor tuning. R3 is the long-term answer but the bigger build — gate on whether R1+R2 catch enough cases first.

**Out of scope (for now):**
- Warm-up ping to mask cold-load latency on the schema-discovery / extraction LLM calls. Frontend-prefetch pattern (fire a no-op ping on wizard mount so the model is loaded by the time the user clicks Next). ~30 min change. Defer until users complain about latency vs correctness.
- Multi-page PDF preprocessing — already on `todo.md`; `tests/unit/extraction-pdf.test.ts` uses `mergePages: true` and the LLM confuses multi-page docs. Anderson Dairy / Darigold may be multi-page; check before doing R-anything.

### Document Search v2 — universal, faceted, FTS5-backed

**Status:** in-progress (Phases 1–6 done; Phases 7–8 planned)

**Full plan:** `/home/hexi/.claude/plans/peppy-coalescing-platypus.md`

**Context / why:** The current Documents page search is broken — typing
"darigold" returns nothing because the page calls `/api/documents` (a list
endpoint with no text search). The Search tab uses
`/api/documents/search` with `LIKE '%term%'` which (a) duplicates code with
`Documents.tsx`, (b) doesn't search supplier / product / doc-type names,
and (c) won't scale past ~10k docs/tenant. User target is 10k–50k
docs/tenant; we need to move off `LIKE` to SQLite FTS5, search across all
the entity text (title, description, tags, file_name, extracted_text,
metadata, supplier name + aliases, document_type, products, customer,
bundle), and unify Documents and Search behind one shared
`<DocumentSearchPanel>` component plus a new universal `/search` endpoint.

**Key architectural decisions:**

- **Per-entity FTS5 virtual tables.** `documents_fts` is the heavy hitter,
  denormalized with supplier / doc-type / product text concatenated in.
  Smaller per-entity FTS tables (`suppliers_fts`, `products_fts`,
  `document_types_fts`, `orders_fts`, `customers_fts`, `bundles_fts`) drive
  universal search.
- **Tenant ID UNINDEXED on every FTS row** so isolation lives inside the
  MATCH query, not as a post-filter.
- **TEXT-id → INTEGER rowid map tables** (`documents_fts_map`,
  `orders_fts_map`) since FTS5 rowids must be integers but our IDs are hex.
- **Triggers keep documents_fts in sync** with `documents`,
  `document_versions`, and `document_products`. Cross-cutting renames
  (supplier / product / doc_type name) **enqueue an async reindex job**
  rather than fan out in-trigger — protects API latency on big tenants.
- **200KB cap on extracted_text** in the source view to keep us inside the
  D1 10GB cap; monitored, with token-count cap as follow-up if needed.
- **Hard cutover** after staging soak — no feature flag. Legacy LIKE
  branches deleted in the next release once 48h prod soak passes.
- **AI mode stays as a toggle** — `POST /api/documents/search/natural`
  keeps its LLM parser but builds an FTS5 MATCH expression internally.
- **URL is source of truth** for all search state (`q`, facets, sort,
  page). One shared `<DocumentSearchPanel>` for `/documents` and inside
  `<UniversalSearchPanel>` on `/search`.
- **Multi-token AND** is the only query syntax — FTS5's default. User
  input sanitized (strip `-*:()"`, NEAR), each token quoted, last token
  gets `*` for prefix matching as users type.
- **Saved searches server-backed** (`saved_searches` table); recent
  searches localStorage-only (key `dox.search.recent`, capped at 20).

**Phases at a glance:**

1. **FTS5 backbone** — migration `0054_fts_search.sql`: map tables,
   `documents_fts` + per-entity FTS tables, source views, triggers,
   chunked-per-tenant initial backfill. **Done** — landed on
   `search-v2` branch (commit `search v2 phase 1: FTS5 backbone
   (migration 0054)`); regular FTS5 tables used in place of contentless
   for trigger-friendly DELETE/INSERT semantics (see commit message).
2. **Async reindex queue** — migration `0055_search_reindex_queue.sql`:
   new `search_reindex_jobs` table (chose this over reusing
   `processing_queue` to avoid coupling AI extraction lifecycle with
   pure-SQL reindex jobs). Triggers on suppliers / products /
   document_types enqueue on rename; partial unique index on
   `(entity_kind, entity_id) WHERE status='pending'` makes enqueue
   idempotent. Drainer at `functions/lib/search-reindex.ts` processes
   jobs in 500-row batches via the documents_fts_source view; retries
   up to 3 attempts before flipping to `failed`. Admin endpoint
   `POST /api/admin/search/reindex` (super_admin) supports
   enqueue / drain / enqueue_and_drain. **Done** — landed on
   `search-v2` branch.
3. **Saved searches** — `0057_saved_searches.sql` with
   `UNIQUE(user_id, name)`; recent searches in localStorage.
   (Bumped from `0056` because `0056_fix_fts_view_nulls.sql`
   landed first to harden NULL propagation in
   `documents_fts_source`.) **Done** — landed on `search-v2`
   branch. CRUD endpoints under `/api/search/saved` (list +
   create) and `/api/search/saved/:id` (get + put + delete);
   per-user isolation is the only access rule (super_admins
   only see their own). `scope='shared'` is rejected with 400
   so callers get an explicit signal rather than a silent
   downgrade. 404 (not 403) is returned for non-owner reads /
   writes / deletes — saved searches are a personal surface
   and existence-leakage doesn't help anyone here.
4. **Backend endpoints** — replace internals of `/api/documents/search`
   and `/api/orders?search=` with FTS5; add `GET /api/search` (universal,
   fans out via `db.batch()`); faceted counts as one query per active
   facet against the same `matches` CTE with sticky-filter exclusion;
   FTS5 `snippet()` replaces hand-rolled `generateSnippets()`. **Done**
   — landed on `search-v2` branch as four sub-commits:
   `phase 4a` (`/api/documents/search` FTS5 + sort/facets),
   `phase 4b` (`/api/documents/search/natural` FTS5; LLM parser
   preserved), `phase 4c` (`/api/orders ?search=` FTS5),
   `phase 4d` (NEW `GET /api/search` universal endpoint with
   D1 batch fan-out per entity). Shared sanitizer at
   `functions/lib/search-fts.ts`; types added to `shared/types.ts`
   (`UniversalSearchResponse` + per-entity blocks); API client
   method `api.search.universal()` in `src/lib/api.ts`.
   Implementation deviation: per-entity universal blocks split
   count + page into two D1 statements (still inside one
   `batch()`) because FTS5 `snippet()` cannot coexist with a
   `COUNT(*) OVER ()` window in the same SELECT. Documents block
   stays a single CTE-based query.
5. **Shared frontend primitives** — `src/hooks/{useSearchParamsState,
   useDebouncedValue, useRecentSearches, useSavedSearches,
   useEntityAutocomplete}.ts`, `src/lib/{searchUrl,sanitizeSnippet}.ts`,
   `src/components/search/*` (SearchBar, FacetSidebar, ResultCards,
   Snippet, DocumentSearchPanel, UniversalSearchPanel, …). **Done**
   — landed on `search-v2` as four sub-commits:
   `phase 5` (frontend test infra: vitest projects split — workers
   pool stays for backend tests, new happy-dom + RTL project for
   `src/**/*.test.{ts,tsx}`),
   `phase 5a` (hooks + URL/snippet utilities — 58 tests),
   `phase 5b` (atomic search components: SearchBar, FacetSidebar +
   FacetGroup + FacetOption, ActiveFilterChips, SortMenu, ResultsList,
   Snippet, RecentSearchesList, SavedSearchesDialog, ResultCard{Document,
   Order,Customer,Bundle} — 64 tests),
   `phase 5c` (composed panels DocumentSearchPanel + UniversalSearchPanel
   wired to api.documents.searchV2 and api.search.universal — 10 tests).
   shared/types.ts gains SearchState, FacetCount, FacetKind, SearchSort,
   SearchDateBucket, UniversalSearchType. Frontend project totals 132
   tests; workers project still 1064; combined `npm test` 1196 green.
6. **Page rewrites** — `Documents.tsx` becomes a thin
   `<DocumentSearchPanel syncToUrl />` wrapper; `Search.tsx` becomes
   `<UniversalSearchPanel>` with All / Documents / Orders / Customers /
   Bundles tabs. **Done** — landed on `search-v2` as two sub-commits:
   `phase 6a` (`Documents.tsx` reduced from 399 lines to a 49-line
   shell over `<DocumentSearchPanel syncToUrl />`; legacy client-side
   substring filter and `api.documents.list()` call removed),
   `phase 6b` (`Search.tsx` reduced from 608 lines to a 55-line shell
   over `<UniversalSearchPanel syncToUrl />`; legacy
   Documents/Orders tabs, manual category + date-range filters,
   CSV/JSON export controls, and direct `api.documents.search()` /
   `api.orders.list()` / `api.orders.naturalSearch()` calls removed).
   `api.documents.search()` (legacy) is now orphaned; deletion is a
   follow-up. `npm test` 1196 green throughout.
7. **Tests** — new `tests/unit/search-fts-{documents,snippets,facets}.test.ts`,
   `search-saved.test.ts`, `search-reindex-queue.test.ts`, plus
   `tests/e2e/document-search.spec.ts`.
8. **Rollout** — staging migrations + backfill + smoke + suites; deploy
   to prod (chunked backfill if rows > 5k); 48h p95 monitoring; delete
   legacy LIKE branches in follow-up release.

**Critical files (new):** `migrations/0054_fts_search.sql`,
`migrations/0055_search_reindex_queue.sql`,
`migrations/0056_fix_fts_view_nulls.sql`,
`migrations/0057_saved_searches.sql`, `functions/api/search/index.ts`,
`functions/api/search/saved/{index,[id]}.ts`,
`functions/api/admin/search/reindex.ts`, `src/components/search/*` (full
directory), `src/hooks/useSearchParamsState.ts` (+ siblings), `src/lib/
searchUrl.ts`, `src/lib/sanitizeSnippet.ts`, the new test files.

**Critical files (modified):** `functions/api/documents/search/index.ts`,
`functions/api/documents/search/natural.ts` (FTS internals, keep LLM
parser), `functions/api/orders/index.ts` (`?search=` branch), `src/lib/
api.ts` (`api.search.*`), `shared/types.ts` (`SearchState`,
`UniversalSearchResponse`, `SavedSearch`, `FacetCount`), `src/pages/
Documents.tsx`, `src/pages/Search.tsx`. (CLAUDE.md migration table is
stale — actual latest applied is 0053, new files start at 0054.)

**Risks:**

- **D1 10GB cap** — 50k docs × 200KB × ~4x FTS overhead ≈ 40GB worst
  case. 200KB cap mitigates; token-count cap is the follow-up if
  needed.
- **Wrangler timeout on initial backfill** — chunk per-tenant; provide
  `bin/backfill-fts` script as fallback if migration runner can't carry
  the full inserts on big tenants.
- **Supplier rename of huge tenant** — async reindex queue (non-trigger).
- **FTS5 operator injection / snippet XSS** — sanitizer + `<mark>`-split
  React renderer (no `dangerouslySetInnerHTML`).
- **Tenant leakage** — `tenant_id UNINDEXED` on every FTS row; unit test
  asserts cross-tenant MATCH returns nothing.
- **Hard-cutover rollback** — keep legacy LIKE branches commented in
  code until 48h prod soak completes, then delete in follow-up.

### Records — Collaborative sheets, forms, and workflows

**Status:** planned

**Goal / motivation:** Build a Smartsheet-class collaborative module
inside dox so the same tenants who already trust us with their COAs,
suppliers, and products can run the *operational work around* those
documents — quality intake, new-item approval, audits, recalls, supplier
onboarding, customer requirements tracking — without bouncing to a
generic spreadsheet tool that can't talk to their dox data. The wedge
isn't "another grid"; it's that every cell can natively reference a
real dox entity (supplier, product, document, user) with hover-preview,
inline doc rendering, and live link-back. We are not trying to beat
Smartsheet at being a spreadsheet. We are betting that when the
spreadsheet *is* the document portal, the operations workflows our
users already pay for collapse into a single tool.

**Design philosophy — records-with-many-views (the inversion):**

In Smartsheet, the grid *is* the truth: a row is a row in a table, and
"views" are reskins of that table. We invert that. The truth is a
**Record** — a typed object with its own URL, page, audit history,
relationships, comments, and attachments. A grid is just one view onto
a collection of Records. Board, Timeline, Gallery, and Calendar are
equal first-class views, not bolt-ons. This shows up in five concrete
UX/visual bets that the implementation must hold the line on:

1. **Multi-view per sheet, switchable in one click.** Grid / Kanban /
   Timeline / Gallery / Calendar all render the same record set; the
   toggle lives in the sheet header. Switching views is a viewport
   change, not a query change — the same filter/sort/group state
   carries across views.
2. **Rich row drawer.** Clicking any row anywhere (including a Kanban
   card or Calendar event) opens a side drawer (Linear/Notion-style)
   with: inline document preview (we already render PDFs, images,
   text/CSV), photo carousel for attachments, supplier/product cards,
   activity feed, comments, and the column values themselves. The
   drawer is the Record page; double-clicking opens it as a full route
   for permalinks. Editing a value updates the underlying record, not
   "the grid cell."
3. **Native entity chips.** A column whose type is `supplier_ref` does
   not store a string — it stores a `supplier_id` and renders as a
   chip. Hover surfaces a mini-card pulled from the live Supplier
   record (recent docs, alias list, last activity). Same for
   `product_ref`, `document_ref`, `user_ref`. This is the dox-only
   superpower — generic competitors literally cannot do this without
   integration work the customer has to build.
4. **Forms feel like Typeform, not Google Forms.** One question per
   screen on mobile, large tap targets, conditional logic
   (show/skip/branch), progress bar, autosave, photo capture as a
   native step. The QC-from-warehouse use case demands phone-first.
   The canonical use case is a QC tech standing on a warehouse floor
   with a phone, snapping a photo of a pallet and attaching it to a
   record in seconds — the form must be a one-tap-from-home experience
   on mobile, not a desktop form that happens to render small.
   Desktop forms collapse the same flow into a single column with
   anchor scroll.
5. **Workflow as visualization.** Approval routing is not a checklist
   of checkboxes; it renders as a flowing graph (nodes = steps, edges
   = transitions, avatars on nodes for assignees, color-coded live
   status). The same engine drives cross-sheet automations, just with
   different node types.
6. **Mobile-first throughout.** Every view (Grid, Board, Timeline,
   Gallery, Calendar) must have a deliberate mobile design, not a
   degraded-desktop layout. Grid in particular collapses to a stacked
   card list on phones; the side drawer becomes a full-screen modal.
   Touch targets are >=44px, action buttons sit in the thumb zone,
   lists support pull-to-refresh, and cards support swipe gestures
   (archive, comment, etc.) where they fit. The mobile experience is
   **the** competitive wedge against Smartsheet (whose mobile is bad)
   — it is treated as a primary surface, not a derivative.

The aesthetic mandate from the user: "beautiful and unique, not
cookie-cutter Smartsheet." The visual identity should lean Linear /
Notion / Airtable Pro rather than enterprise grid — generous
whitespace, soft shadows on the drawer, micro-interactions on view
switches, and entity chips that feel like rich content, not text.

#### Data model

All tables are tenant-scoped (`tenant_id` FK), use the existing
`lower(hex(randomblob(8)))` ID convention, and write to the existing
`audit_log` for row-level history. Naming uses the `records_*` prefix
to avoid collision with `documents`, `bundles`, etc.

- **`records_sheets`** — the container. `id`, `tenant_id`, `name`,
  `slug`, `description`, `icon`, `color`, `template_key` (nullable;
  e.g. `quality_intake`, `new_item_approval` — identifies sheets
  spawned from a built-in template so we can ship updates), `archived`,
  `created_by`, timestamps.
- **`records_columns`** — the schema for a sheet. `id`, `sheet_id`,
  `key` (slug, immutable, used in formulas/automations), `label`,
  `type` (see below), `config` (JSON — type-specific: dropdown options,
  number format, formula expression, ref entity type, etc.),
  `required`, `display_order`, `width`, `archived`. Column types:
  `text`, `long_text`, `number`, `currency`, `percent`, `date`,
  `datetime`, `duration`, `checkbox`, `dropdown_single`,
  `dropdown_multi`, `contact` (internal user picker), `email`, `url`,
  `phone`, `attachment`, `formula`, `rollup`, and the entity refs
  `supplier_ref`, `product_ref`, `document_ref`, `record_ref` (link to
  another Record in any sheet — enables cross-sheet relationships).
  `formula` columns evaluate via our own small expression evaluator
  (no HyperFormula / FormulaJS dependency); the supported function
  set is fixed: `SUM`, `IF`, `CONCAT`, `AND`, `OR`, `NOT`, basic date
  math, and basic arithmetic. No user-defined functions. `rollup`
  columns reuse the same evaluator over a `record_ref` traversal.
- **`records_rows`** — the Record itself. `id`, `sheet_id`,
  `tenant_id`, `display_title` (computed from a designated title
  column, denormalized for fast list rendering), `data` (JSON, keyed
  by column `key` — single source of truth for cell values; D1 has no
  JSON ops, so we live with whole-row reads/writes and rely on
  per-sheet pagination), `position` (REAL, fractional indexing for
  drag reorder without renumbering), `parent_row_id` (nullable,
  enables hierarchy / sub-rows), `archived`, `created_by`,
  `updated_by`, timestamps. We deliberately do **not** explode columns
  into a wide table — the JSON-blob approach lets us evolve schema
  without ALTER TABLE per sheet.
- **`records_row_attachments`** — `id`, `row_id`, `column_key`
  (nullable; null = drawer-level attachment, set = bound to a specific
  attachment column), `r2_key`, `file_name`, `file_size`, `mime_type`,
  `checksum`, `uploaded_by`, `created_at`. Reuses the existing R2
  bucket and upload pathway.
- **`records_views`** — saved views. `id`, `sheet_id`, `name`,
  `view_type` (`grid` | `kanban` | `timeline` | `gallery` |
  `calendar`), `config` (JSON: filters, sort, group-by column for
  Kanban, start/end column for Timeline, cover-image column for
  Gallery, date column for Calendar, visible columns + order),
  `is_default`, `shared` (0 = personal, 1 = shared with sheet),
  `created_by`, timestamps.
- **`records_comments`** — `id`, `row_id`, `parent_comment_id`
  (threading), `author_id`, `body` (markdown), `mentions` (JSON array
  of user_ids — drives notifications), `created_at`, `edited_at`.
- **`records_activity`** — per-row activity feed for the drawer.
  `id`, `row_id`, `actor_id`, `kind` (`created`, `updated`,
  `comment_added`, `attachment_added`, `workflow_advanced`,
  `automation_fired`, …), `details` (JSON — for `updated`: `{column,
  from, to}`), `created_at`. We mirror critical events to `audit_log`
  too, but `records_activity` is denormalized for the drawer feed
  (cheap read, no joins).
- **`records_forms`** — `id`, `sheet_id`, `name`, `slug` (unique
  per-tenant, used in public URL `/r/<slug>`), `config` (JSON: ordered
  question list, conditional logic rules, theme, completion message,
  redirect URL), `auth_mode` (`public` | `link_token` | `tenant_user`
  | `email_verified`), `submit_action` (default `create_row`; future:
  `update_row` for Update Requests), `active`, `created_by`,
  timestamps.
- **`records_form_submissions`** — `id`, `form_id`, `row_id` (the
  resulting row), `submitted_by_user_id` (nullable for public),
  `submitted_email` (nullable, captured for public/link_token forms),
  `payload` (JSON of raw answers — preserved even if columns change
  later), `ip_address`, `user_agent`, `created_at`.
- **`records_update_requests`** — the killer feature. `id`,
  `row_id`, `target_column_keys` (JSON array — fields to fill),
  `recipient_email`, `recipient_user_id` (nullable), `token` (random,
  used in URL), `expires_at`, `status` (`pending` | `submitted` |
  `expired` | `cancelled`), `submitted_at`, `created_by`, `created_at`.
  A submitted Update Request triggers a row update with the partial
  payload and a row-activity entry tagged `update_request_submitted`.
- **`records_workflows`** — `id`, `sheet_id`, `name`, `definition`
  (JSON — node graph: steps, transitions, conditions, assignments;
  see Workflow engine below), `active`, `created_by`, timestamps.
  One workflow per "kind of routing" on a sheet (e.g. "Approval", "QC
  Triage"); a sheet can host multiple.
- **`records_workflow_runs`** — `id`, `workflow_id`, `row_id`,
  `current_step_id`, `state` (`active` | `completed` | `cancelled` |
  `error`), `context` (JSON — accumulated decisions, who approved
  what), `started_at`, `completed_at`. Drives the workflow
  visualization.
- **`records_workflow_actions`** — per-step action log. `id`,
  `run_id`, `step_id`, `actor_id`, `action` (`approve` | `reject` |
  `delegate` | `comment` | `auto_advance` | `cross_sheet_push` | …),
  `payload` (JSON), `created_at`.
- **`records_automations`** — sheet-scoped rules using the same
  engine as workflows but triggered by row events (create/update/cron).
  `id`, `sheet_id`, `name`, `trigger` (JSON: type + config),
  `condition` (JSON: filter expression), `actions` (JSON array:
  `update_row` | `push_to_sheet` | `send_email_report` |
  `start_workflow` | `notify_users`), `active`, `last_run_at`, audit
  fields. Cross-sheet automations (Quality → Accounting) are just an
  automation whose action is `push_to_sheet`.

Notes:
- We deliberately keep cell values inside a JSON `data` blob on
  `records_rows` rather than a per-cell EAV table. EAV explodes write
  cost and kills D1 pagination; JSON is fine because D1/SQLite reads
  whole rows anyway and we never need cross-sheet cell-level queries
  (entity references are real FKs we extract on save).
- Entity-ref columns extract a parallel index on save:
  **`records_row_refs`** (`row_id`, `column_key`, `ref_type`,
  `ref_id`) so we can answer "show all records that reference
  supplier X" without scanning every JSON blob. Maintained by the API
  layer on row write.

#### API surface

REST under `/api/records/...`, mirroring the per-feature directory
pattern in `functions/api/`:

```
functions/api/records/
  sheets/
    index.ts                        GET list, POST create
    [id].ts                         GET, PATCH, DELETE
    [id]/columns/index.ts           GET, POST (add column), PATCH (reorder)
    [id]/columns/[colId].ts         PATCH (rename/retype), DELETE (archive)
    [id]/rows/index.ts              GET (paginated, with view filters), POST
    [id]/rows/[rowId].ts            GET, PATCH, DELETE
    [id]/rows/[rowId]/attachments   POST, GET (R2-backed)
    [id]/rows/[rowId]/comments      GET, POST
    [id]/rows/[rowId]/activity      GET
    [id]/rows/[rowId]/send-report   POST (email row + attachments via Resend)
    [id]/views/index.ts             GET, POST
    [id]/views/[viewId].ts          PATCH, DELETE
    [id]/forms/index.ts             GET, POST
    [id]/forms/[formId].ts          GET, PATCH, DELETE
    [id]/workflows/index.ts         GET, POST
    [id]/automations/index.ts       GET, POST
  forms/
    public/[slug].ts                GET (form schema for public render),
                                    POST (submit) — bypasses JWT, rate-limited
  update-requests/
    index.ts                        POST (create + send email)
    [token].ts                      GET (load by token), POST (submit)
  workflow-runs/
    [id]/advance.ts                 POST (approve/reject/delegate)
    [id].ts                         GET (state + visualization data)
```

Auth: all `/api/records/*` routes go through the existing
`_middleware.ts` JWT/API-key path. Public form and Update Request
routes are explicitly carved out with their own token check; we add
those exemptions to the middleware allowlist alongside the existing
`/api/auth/*` and `/api/webhooks/*` exceptions. Public form submit
endpoints validate a Cloudflare Turnstile token server-side as the
primary abuse gate; per-IP per-form rate limits via
`functions/lib/ratelimit.ts` are layered on top.

GraphQL additions (parallel to REST, in
`functions/lib/graphql/`): types for `Sheet`, `RecordRow`,
`RecordColumn`, `RecordView`, `RecordForm`, `WorkflowRun`. Resolvers
delegate to the same service-layer functions the REST handlers call —
no logic in handler files. This is a good time to make the
service-layer pattern explicit; today most of `functions/api/*` is
direct D1 in handlers, which doesn't scale to a module this size.

Shared types in `shared/types.ts`: `RecordSheetRow`, `RecordColumnRow`,
`RecordRow`, `RecordViewRow`, `RecordFormRow`, `RecordCommentRow`,
`RecordActivityRow`, `WorkflowDefinition`, `WorkflowRunRow`, plus
`ApiRecordSheet`, `ApiRecordRow` (with joined `creator_name`,
`updated_by_name`, ref-resolution caches), and request/response
wrappers. Discriminated union `ColumnType` gates `column.config` shape.

#### Frontend surface

New top-level nav entry "Records" (between "Documents" and "Bundles"
in the sidebar). Routes:

```
src/pages/records/
  RecordsHome.tsx              /records              (sheet list, recent, templates)
  SheetDetail.tsx              /records/:sheetId     (the multi-view container)
  RecordDetail.tsx             /records/:sheetId/r/:rowId  (drawer-as-route permalink)
  FormBuilder.tsx              /records/:sheetId/forms/:formId
  PublicForm.tsx               /r/:formSlug          (public route, no auth)
  UpdateRequestForm.tsx        /update/:token        (public, token-gated)
  WorkflowBuilder.tsx          /records/:sheetId/workflows/:workflowId
  AutomationBuilder.tsx        /records/:sheetId/automations/:automationId
```

New components in `src/components/records/`:

- `SheetHeader` — name, view switcher, filter/sort/group controls,
  share, "+ New record" CTA.
- `views/GridView`, `views/KanbanView`, `views/TimelineView`,
  `views/GalleryView`, `views/CalendarView` — all consume a single
  `useSheetRecords({ sheetId, viewConfig })` hook and render the same
  `Record[]`. View-specific UI lives in the view file; row data does
  not.
- `RowDrawer` — the rich drawer. Tabs: **Details** (column values
  rendered with type-aware widgets), **Attachments** (carousel, drop
  zone, inline preview reusing `DocumentDetail.tsx`'s preview
  component), **Activity** (feed), **Comments** (threaded, mention
  support), **Workflow** (current run visualization if applicable).
- `EntityChip` — supplier/product/document/user reference cell.
  Renders avatar/icon + name; hover opens `EntityHoverCard` with
  recent activity from the linked entity. Single component, branched
  on `ref_type`.
- `ColumnTypeWidget` — switch on column type to render the right
  editor (date picker, dropdown, entity picker modal, formula display,
  etc.).
- `FormBuilder` + `FormPlayer` — drag-to-reorder builder; player has
  two layouts (`one_per_screen` mobile, `single_column` desktop)
  driven by viewport.
- `WorkflowGraph` — uses ReactFlow (likely; Open Question) to render
  the node graph; live status from polling/WebSocket subscription.
- `AutomationBuilder` — when-this-then-that form, less visual than
  Workflow.

Where it fits: "Records" lives next to "Documents" in nav; entity
chips throughout dox link back to records (e.g. supplier detail page
gets a "Records referencing this supplier" tab — this is what makes
the integration *feel* native rather than bolted on).

#### View system

All views consume one normalized response: `{ records: ApiRecord[],
columns: ApiRecordColumn[], view_config, total }`. View-specific
config:

- **Grid** — column visibility/order/width, row height, frozen
  columns. Default view if none saved.
- **Kanban** — `group_by_column` (must be a `dropdown_single` or
  `contact` column); columns of the board = options of that column.
  Drag between columns mutates the cell value.
- **Timeline** — `start_column` + `end_column` (date or datetime),
  optional `swimlane_column`. Drag to reschedule.
- **Gallery** — `cover_attachment_column` (renders first image),
  `card_fields` (which columns to show on the card). The QC-photos
  use case lives here.
- **Calendar** — `date_column` (single), color-by-column. Click a day
  to create a row pre-filled with that date.

Saved views (`records_views`) store a complete view spec; switching
views is a route param (`?view=<viewId>`) so views are linkable. Each
view has filter/sort/group state; switching view types preserves the
filter/sort/group portion when possible (Grid → Kanban keeps filters,
adds a default group_by). "Personal" views are only visible to the
creator; "shared" views are visible to anyone with sheet access.

#### Form builder

Forms are derived from the column schema, not authored
free-form. The form spec is a list of "questions," each pointing to a
column key plus optional override of label/help text and a
conditional-show rule (DSL: `{column_key, operator, value}` — same
expression engine the automation/workflow conditions use). This means
columns and forms can't drift; renaming a column updates every form
that references it.

Mobile renderer: one question per screen, full-bleed input, swipe or
tap-to-advance, autosave to `localStorage` by token, photo capture
uses native `<input type="file" capture>`. Desktop renderer:
single-column scrollable. Both share the same component tree, just
different parent layout. Submission writes a row; if `auth_mode =
public`, captures `submitted_email`; if `link_token`, validates the
token first.

Public form URL: `https://<tenant>.dox.app/r/<slug>` — `<slug>` is
unique per tenant. Embed mode (`/r/<slug>?embed=1`) strips chrome for
iframe use.

Abuse protection on every public form: **Cloudflare Turnstile**
(invisible CAPTCHA) is the primary defense, validated server-side on
submit before the row is written. Per-IP per-form rate limits via the
existing D1 `ratelimit.ts` are the secondary layer. The Turnstile
binding is stood up in Phase 1 alongside Durable Objects so Phase 2's
form route plugs in without a fresh infra change.

#### Workflow engine

Workflows and automations share a single primitive: a
**rule-and-action graph**. A workflow is a graph with stateful steps
(approval gates, assignments, branches, completion); an automation is
a stateless single-step trigger→condition→action(s). Sharing the
engine means we maintain one expression evaluator, one assignment
resolver, one notification emitter.

Node types (v1):
- **Trigger** (automation only): `row_created`, `row_updated`
  (with column filter), `field_changed`, `form_submitted`,
  `cron` (e.g. weekly digest).
- **Condition**: filter expression on row + workflow context.
  Branches accordingly.
- **Approval step**: assignees (static user list, role, or
  `contact` column reference), aggregation rule (`any` | `all` |
  `majority`), SLA (optional). Renders in the Workflow tab of the
  drawer with avatars + status.
- **Action**: `update_row`, `push_to_sheet` (the cross-sheet
  mechanism — maps source column keys to target column keys; creates
  a new row in the target sheet, optionally back-linking via a
  `record_ref` column), `send_email_report` (Resend, reuses
  `functions/lib/email.ts`), `notify_users`.
- **Wait** (v2): time-based delay; out of scope for v1.

Workflow runs are the stateful unit. When a triggering row event
fires, we either advance an existing run (matching `(workflow_id,
row_id)`) or start a new one. The graph visualization queries
`records_workflow_runs` + `records_workflow_actions` and hydrates the
UI with `current_step_id` + per-step status.

The Quality → Accounting credit example becomes: an automation on
the Quality sheet with `trigger = row_updated`, `condition =
status == 'credit_owed'`, `action = push_to_sheet({sheet:
accounting_credits, mapping: {...}})`. No special-case code.

#### Integration with existing dox

This is the moat. Concrete touch points:

- **Entity-ref columns** are real FKs to `suppliers`,
  `products`, `documents`, `users`. Hover cards on the chip call
  `/api/suppliers/[id]`, `/api/documents/[id]`, etc. — endpoints
  that already exist.
- **Document attachments inside a row** can either (a) upload a
  fresh file (lives in `records_row_attachments`, R2-backed) or (b)
  link an existing dox `document_id` (no copy; chip renders inline
  preview using the same component as `DocumentDetail.tsx`). This
  collapses "the COA on this row" and "the COA in the doc portal"
  into one artifact.
- **Agent / ingest pipeline can write rows.** A new ingest target —
  `POST /api/records/sheets/[id]/rows` accepted via `X-API-Key` —
  lets the existing email-ingest worker, MindStudio, or the
  in-house extractor drop a structured row into a Records sheet.
  The Quality Intake template's intended ingestion path is
  email-attachment → photo + supplier extracted → row created with
  `supplier_ref`, photo attached, ready for QC review.
- **Audit log**: row-level events mirror to `audit_log` so the
  existing tenant audit page surfaces records activity alongside
  document activity.
- **Permissions**: reuse the existing 4-role model. v1 sheet
  permissions are coarse — sheet-level read/write/admin gated by
  tenant role. Per-column or per-row ACLs are explicitly out of
  scope.
- **Search**: short-term, sheet-scoped search on `data` JSON via a
  `LIKE` scan with column-aware filters. Long-term, integrate with
  the existing natural-language search.

#### Phased rollout

Each phase ships behind a feature flag (`records_enabled` per tenant)
so we can dogfood with our own quality sheet before opening it to
customers.

**Phase 1 — Primitives (the slab).** Sheets, columns (all
non-formula types including the four entity refs), rows with JSON
data, attachments, the row drawer, comments, activity feed,
audit-log integration, permissions, and a working Grid view. No
saved views yet — Grid renders the canonical column order with
client-side filter/sort. No forms, no workflows, no Kanban/Timeline/
Gallery/Calendar.

Phase 1 also stands up the real-time + abuse-protection infrastructure
that later phases depend on:

- **Durable Objects layer for Sheet sessions.** One DO instance per
  Sheet, holding presence (who's viewing), recent edits (ring buffer
  for late-joiners), and optimistic update fan-out to connected
  clients. Cell edits round-trip through the DO so every viewer sees
  them within a frame; this replaces what would otherwise be polling.
- **Cloudflare Turnstile binding setup.** Public forms don't ship
  until Phase 2, but we wire the Turnstile binding (env var, secret,
  client SDK plumbing) in Phase 1 since DOs already make this a new
  infra phase — better to land both new surfaces together than to
  re-open the deploy/config story in Phase 2.

Estimated duration: ~3 weeks (was ~2 weeks; the DO layer plus
Turnstile wiring add roughly a week of infra work). Phase 1 is **not
a developer-only milestone** — it ships to a real user (the author,
running real Quality intake against it) before Phase 2 starts.

**Ships when:** an internal user can create a sheet, add columns
including a supplier_ref, paste in 50 rows, attach a PDF to a row,
comment on it, see entity hover cards work, view audit history
end-to-end, and have a second browser tab show the edit live via the
Sheet's Durable Object.

**Phase 1 → Phase 2 transition (originally a hard gate, now optional).**
The original plan made dogfooding Phase 1 with real Quality data a
prerequisite for Phase 2. The user has chosen to defer this in favor
of velocity — Phase 2 work proceeds in parallel. Friction surfaced
during eventual dogfood use will land as follow-up adjustments rather
than a re-plan. Risk acknowledged: Phase 2 features may sit on
primitives with hidden gaps; mitigation is that primitive refactors
are cheaper than waiting weeks on dogfood feedback.

**Phase 2 — Views + Forms.** **Status: in-progress (Slice 1 — Forms +
Public Intake)**. Saved views (`records_views`), Kanban, Timeline,
Gallery, Calendar — each with their config UI. Form builder + public
form route + form submissions writing rows. Mobile-first form
renderer. Update Request flow (token URLs, partial row updates).
**Ships when:** the Quality Intake template can be used end-to-end
on a phone — open public form link, snap photo, pick supplier from
chip picker, submit; the row appears in the Quality sheet's Gallery
view sorted by date.

Slicing Phase 2 into three sequential chunks: (1) Forms + Public
Intake (in-progress), (2) Update Requests (depends on form renderer),
(3) Alternate Views (orthogonal, can ship anytime). Slice 1 starts
now.

**Phase 3 — Workflows + Automations.** Workflow engine, the graph
visualization, approval steps with assignees and SLAs, automations
(including the cross-sheet `push_to_sheet` action), `send_email_
report` action, in-app notifications for assignees. **Ships when:**
New Item Approval template can route a row through Sales → Quality
→ Operations → Finance, each approver sees the row in their queue,
the workflow visualization updates live, and final approval pushes
a row to a downstream "Approved Items" sheet.

**Phase 4 — Templates: Quality Intake + New Item Approval.**
Polish, content, and seeding. Both templates ship as canonical
sheet/form/workflow bundles via the `template_key` mechanism: a
tenant clicks "Use template," we provision a sheet with the right
columns (supplier_ref, photo attachment, date, severity dropdown,
…), the form (Typeform-style mobile capture), and any associated
workflow or automation. We also build the trending report —
pivot/group by supplier across the Quality sheet — as the demo
hook. **Ships when:** a new tenant can go from zero to a working
Quality program in under five minutes; New Item Approval is
sales-demoable end-to-end with believable seed data.

#### Decided

These were open architectural forks; they are now locked in. Each
entry: the decision, why we chose it over the alternatives, and any
implication for scope or timeline.

1. **Real-time mechanism: Durable Objects from day 1.** Each Sheet
   becomes a Durable Object instance owning that sheet's session
   state — presence, cursors, recent edits, and optimistic cell-update
   fan-out. We picked DOs over polling and over a third-party
   (Liveblocks/PartyKit) because Phase 1 will be dogfooded with real
   Quality data and a polling-based UI would be unusable under live
   edits, and because we'd rather absorb the DO learning curve once
   than rip out a polling layer later. *Implication:* adds a new
   deploy surface in Phase 1 (DO binding, migrations, observability)
   and is the main reason Phase 1's estimate moved from ~2 weeks to
   ~3 weeks.
2. **Formula engine: custom evaluator with a fixed function list.**
   We roll a small expression evaluator with a curated set: SUM, IF,
   CONCAT, AND, OR, NOT, basic date math, basic arithmetic. No
   user-defined functions, no HyperFormula, no FormulaJS. We picked
   this over embedding a library because Smartsheet-grade formula
   depth is not the differentiator, and a finite hand-written
   evaluator gives us a smaller bundle, no license surface, and no
   sandboxing burden. *Implication:* formulas land in Phase 2 with a
   known-bounded function list; "user wants VLOOKUP" is an explicit
   non-goal we can answer cleanly.
3. **Public form abuse protection: Cloudflare Turnstile + tight rate
   limits.** Every public-link form gets Turnstile (invisible
   CAPTCHA) as the primary defense, plus per-IP per-form rate limits
   layered through the existing D1 `ratelimit.ts`. We picked
   Turnstile-first over rate-limit-only because a determined abuser
   burns through pure rate limits, and over auth-only because we
   still want truly public forms (mobile QC capture from the floor)
   to be one tap away. *Implication:* Turnstile binding lands in
   Phase 1 alongside DOs; Phase 2 form builder consumes it.
4. **Phase 1 dogfooding is a hard gate.** The author migrates real
   Quality intake work into Phase 1 before any Phase 2 work begins.
   We picked this over a "build all phases then evaluate" path
   because the riskiest unknown is whether our row/column/attachment
   primitives match how Quality work actually flows; better to find
   out on real data with one user than to find out after we've built
   forms and workflows on a broken foundation. *Implication:* Phase
   2 has a real-world dependency, not just an engineering one — see
   the Phase 1 → Phase 2 gate above.

#### Open questions

These are real architectural forks we have not decided. Each has
downstream consequences and should be resolved before the relevant
phase, not at coding time.

1. **Column-schema migration.** When a user changes a column's
   `type` (e.g. text → number), what happens to existing values?
   Options: hard-fail if any value can't coerce; soft-coerce with
   a preview; archive-the-old-column-and-create-a-new-one
   (Airtable's approach). The third is least destructive but adds
   cruft. Lean toward soft-coerce + preview.
2. **Row-event ordering and idempotency for automations.** If a
   row update fires an automation that updates the row, do we
   re-fire? Loop detection? Smartsheet draws this line at "no
   re-fire within the same change set." We probably do the same.
   Decide before Phase 3.
3. **Search backend.** D1 `LIKE` scan on `data` JSON works for v1
   at low volume. For tenants with 100k+ rows we'll need either a
   D1-side FTS5 virtual table per sheet (one table per sheet does
   not scale) or push records into the existing content index used
   by document search. Defer until tenant load forces it.
4. **Workflow visualization library.** ReactFlow is the obvious
   pick (MIT, mature, handles auto-layout). It adds ~120kB
   gzipped — non-trivial. Worth it; alternative is hand-rolled SVG
   which we will regret.
5. **Public form auth model.** Pure public is easy but invites spam
   and compliance worries (a manufacturer's QC form gets indexed
   by Google). Email-verified (one-time link) is friction.
   Tenant-user is trivial. Probably ship all four `auth_mode`
   options and let the tenant pick per-form, with per-tenant
   defaults. (Turnstile + rate limits handle the abuse vector
   independent of this choice.)

#### Out of scope (for now)

Calling these out explicitly so v1 stays shippable.

- **External integrations** — no Slack, Jira, MS Teams, Google
  Sheets, Salesforce. Webhooks-out is the v2 path; for v1, the only
  outbound channel is email via Resend.
- **Deep BI / dashboarding** — the trending report in Phase 4 is a
  fixed pivot, not a chart builder. No cross-sheet dashboards, no
  saved chart library.
- **Per-cell or per-row permissions** — sheet-level only.
- **Cell-level real-time CRDT editing** (Google Docs style). We
  ship optimistic single-writer-wins with conflict toasts.
- **Mobile native app** — mobile web only. The form player is
  designed for mobile web; no React Native build.
- **Custom theming per tenant** — single dox brand for v1.
  Tenant logo on public forms, nothing else.
- **Import from Excel / CSV beyond a simple paste-grid feature.**
  No format detection, no formula translation, no Excel-file round
  trip.
- **AI features** (auto-suggest column types, auto-generate
  workflows from prompts). The dox extraction stack is the AI
  story; Records v1 is human-driven.
- **Versioning of rows.** Activity feed shows what changed; you
  cannot "restore row to last week's state." If we need that we
  add it later by replaying activity.

### Connector intake button-up (Phases A/B/C)

**Status:** planned (drafted 2026-04-29)
**Scope:** end-to-end functional + production-quality coverage of connector intake

#### Why

The owner thought connectors were done. The partner tried the system
end-to-end and hit two UX gaps (not breakage): (1) `file_watch`
connectors had no UI to drop a file into — the manual drag-drop zone
on `ConnectorDetail.tsx` was only added in this same session; (2) the
email path works but isn't discoverable — there's no surfacing of the
connector's inbound email address on the detail page. Committing now:
verify what exists, close the discoverability gaps, fill in missing
paths, *prove* it works. Connectors ingest **orders + customers**
(`orders` / `customers` / `order_items` tables — migration `0030`);
they are NOT the smart-upload COA pipeline. Success: the partner runs
five intake scenarios on staging cold, no help, all five land
orders/customers in the UI without us touching a thing.

#### Scope

**In:**
- Phase A — audit + fix existing intake paths (manual upload, email).
- Phase B — three new intake paths to production-ready quality:
  - **#4 HTTP POST API** — stable per-connector endpoint with bearer
    auth, e.g. `POST https://supdox.com/api/connectors/<id>/drop`.
  - **#5 S3-compatible bucket drop** — per-connector R2 bucket
    auto-provisioned via the CF API, stable creds, no temp-cred
    refresh dance.
  - **#6 Public drop link** — tenant-generated shareable URL that
    opens an upload form. Form POSTs to the same `/drop` endpoint as
    #4 with the token embedded in the link.
- Phase C — Playwright per intake path through to orders showing up
  in the UI; staging walkthrough doc the partner runs.

**Out (no data-model hooks at all):**
- SFTP delivery
- Outbound pull (connector polls vendor's API)
- Direct app integrations (QuickBooks, Salesforce, NetSuite, etc.)

#### Phase A — Discoverability bring-up

| Step | Action |
|------|--------|
| A1 ✓ | Fresh-eyes walkthrough on staging with a realistic vendor data file. Verify manual upload (drag-drop on `ConnectorDetail.tsx`) and email (`/api/webhooks/email-ingest`, `/api/webhooks/connector-email-ingest`) both work end-to-end. **Done 2026-04-29; punch list at `docs/connectors-A1-walkthrough-2026-04-29.md` (9 high / 18 medium / 13 low).** |
| A2 | Fold all 9 high-severity audit items in, three batches: |
| A2.1 | **Batch 1 — quick UI fixes (no design calls).** (a) Drop zone hardcoded extension list duplicates server-side `classifyFile()` — single source of truth (`src/pages/admin/ConnectorDetail.tsx`, `functions/api/connectors/[id]/run.ts`). (b) Run rows hide `error_message` on failure — surface in the runs table or detail panel (`src/pages/admin/ConnectorDetail.tsx`). (c) Runs don't link to created orders/customers — add "View N orders" link (`src/pages/admin/ConnectorDetail.tsx`). (d) Webhook `curl` example hardcodes `dox.supdox.com` — use `window.location.origin` / env (`src/pages/admin/ConnectorDetail.tsx`). (e) Legacy `Connectors.tsx` JSON dialog bypasses wizard validation — gate to super_admin only with a warning (`src/pages/admin/Connectors.tsx`). |
| A2.2 | **Batch 2 — email card overhaul.** (a) `email-worker/wrangler.toml` is hardcoded to prod (`supdox.com`); add `email-worker/wrangler.staging.toml` so staging email-worker exists or is explicitly absent (and staging UI labels reflect that). (b) **Decision:** rewrite the email probe to NOT mention `email_domain_mappings` — connector address itself is the routing key, sender-domain restriction is deferred (`functions/api/connectors/[id]/test.ts`, `src/pages/admin/ConnectorDetail.tsx`). Probe focuses on "your address is `slug@supdox.com`, send emails with attachments here" + copy button. (c) **Decision:** remove the webhook `curl` example (with `X-API-Key: $EMAIL_INGEST_API_KEY`) from the partner-facing card — service-only secret, not partner-producible. Move to internal docs or delete (`src/pages/admin/ConnectorDetail.tsx`). |
| A2.3 | **Batch 3 — wizard end-state hint** (was A3). After Save/Finish on the connector creation wizard, surface a panel listing each available intake path for that connector type with a "send a file →" link/button per path. Day-one: manual upload + (where configured) email. Phase B adds API + S3 + public link automatically as those paths gain support. |

**Out of scope (audit item #6):** UI to manage `email_domain_mappings`
— connector email is sender-agnostic for now.

**Estimate:** ~2–3 days. Batch 1 ~1d, Batch 2 ~0.5–1d, Batch 3 ~0.25d.

**Ships when:** all 9 high-severity audit items closed, email card
renders the rewritten probe (no `email_domain_mappings` mention, no
partner-facing webhook `curl`), wizard end-state lists every
applicable intake path with working "send a file" affordances.

#### Phase B — Build intake paths

Six sliceable, independently shippable slices. Each ends at a
deployable state.

| # | Slice | Estimate |
|---|-------|----------|
| B1 | Schema + token plumbing | ~0.5d |
| B0 | Collapse connector types | ~1d |
| B2 | HTTP POST API endpoint (#4) | ~1d |
| B3 | S3 bucket auto-provisioning (#5) | ~1.5d |
| B4 | Public drop link (#6) | ~0.5d |
| B5 | Quality bar bring-up (audit, rate-limit, replay, observability) | ~1d |

**B1 — Schema + token plumbing.** Migration
`0047_connector_intake_credentials.sql` adds to `connectors`:
`api_token_hash` + `api_token_last4` (#4); `r2_bucket_name`,
`r2_access_key_id`, `r2_secret_access_key_encrypted`, `r2_secret_iv`
(#5); `public_link_token_hash`, `public_link_expires_at` (#6).
Reuse the HKDF wrapper in `functions/lib/connectors/crypto.ts`
(already used for `credentials_encrypted`). Plaintext tokens are
returned exactly once on create/rotate, never persisted — we store
only the hash. **Acceptance:** migration applied locally + staging;
`shared/types.ts` updated; existing CRUD round-trips with new columns
NULL.

**B0 — Collapse connector types.** Drop the `connectors.type` column
distinction. Universal model: every connector exposes every intake door
(manual, email, API, S3, public link). No per-door enable flags for now
— granularity can come later. Universal cards on `ConnectorDetail.tsx`,
unified orchestrator (`executeConnectorRun(connector, { source, input })`
replacing the type-specific executors), wizard simplified to remove the
type-selection step, tests updated. Migration drops `connectors.type` —
staging + prod each have a small handful of rows; no behavioral effect
since routing pivots to per-source rather than per-type. (~1 day)

**B2 — HTTP POST API endpoint (#4).** New
`functions/api/connectors/[id]/drop.ts`, allowlisted in
`_middleware.ts` (bypasses JWT — bearer is the gate, mirroring
`connectors/poll.ts`). Constant-time hash check against
`api_token_hash`. Body: raw bytes + `X-Filename`. Flow: lookup
(404/403 on missing/inactive) → stream body to R2 (auto-provisioned
bucket from B3, or transitional `FILES` at
`intake/<connectorId>/<isoDate>/<filename>`) → synchronously call
`executeConnectorRun` (`functions/lib/connectors/orchestrator.ts`)
with `input.type = 'file_watch'` → insert `connector_processed_keys`
→ return `{ run_id, status, orders_created, customers_created }`.

UI on `ConnectorDetail.tsx`: "HTTP POST endpoint" card with URL,
masked token, **Generate / Rotate** (one-time plaintext modal),
**Vendor instructions** with copy-paste `curl`.

**Acceptance:** vitest covers missing/wrong/correct bearer, inactive
→ 403, successful drop creates run + orders + processed_keys,
rotation invalidates the old token. Staging `curl` smoke lands an
order in the UI.

**B3 — S3 bucket auto-provisioning (#5).** New
`functions/lib/connectors/provisionBucket.ts` exporting
`provisionConnectorBucket(env, connector)`. Uses the account-level
CF API token to: create bucket
`dox-drops-<tenant-slug>-<connector-slug>` (idempotent) → create an
R2 access token scoped to that bucket (read+write) → persist creds
on the connector row → return `{ endpoint, bucket, access_key,
secret }` for one-time UI display. Wired into the create flow in
`functions/api/connectors/index.ts`; existing connectors get a
**Provision bucket** button. Pivot `pollAllR2Connectors` in
`pollR2.ts` to list each connector's bucket via S3-API (per-connector
keys, least-privilege) instead of `config.r2_prefix` on shared
`FILES`.

UI: "S3 bucket drop" card with endpoint/bucket/keys (one-time reveal
on rotate), **Rotate access key**, **Vendor instructions** with
`aws-cli` and `rclone` examples.

**Acceptance:** create flow provisions bucket + key pair; vitest
mocks the CF API and asserts the calls; vendor `aws s3 cp` smoke on
staging; next poll tick processes the file.

**B4 — Public drop link (#6).** Public route
`/drop/:tenantSlug/:connectorSlug/:publicToken` (in `src/pages/`,
not `admin/`, wired into `src/App.tsx`). Minimal upload form
(file picker, drag-drop, optional sender email). POSTs to the same
`/api/connectors/:id/drop` as B2; server tries `api_token_hash`
first, falls back to `public_link_token_hash` if present and
unexpired. Cloudflare Turnstile gates submission (reuse the binding
the Records plan brings in). UI: "Public drop link" card with
**Generate link** (optional expiry), **Copy URL**, **Revoke**,
last-used timestamp.

**Acceptance:** vitest covers the public-token path; Playwright
drives the form against staging; revoke → 403.

**B5 — Quality bar bring-up.** Applied uniformly across manual /
email / #4 / #5 / #6 / poller:

- **Audit log.** Every dispatch calls `logAudit` (`functions/lib/db.ts`)
  with action `connector.intake` + details `{path, file_name,
  file_size, run_id, result}`.
- **Rate limiting.** Reuse `functions/lib/ratelimit.ts`. Start at
  60/min/connector + 600/min/tenant (both apply).
- **Replay on failure.** Failed runs leave the file in place and skip
  writing `connector_processed_keys`, so the next poll tick retries.
  Add a **Replay** button on failed `connector_runs` rows.
- **Observability.** Last-24h counts on `ConnectorDetail.tsx` by
  path, success/error, last error. New `GET
  /api/connectors/[id]/stats` reads `connector_runs` + `audit_log`.

(Vendor-facing docs page moved to **Phase D — self-documenting system
pass**, slice D5.)

**Acceptance:** every path writes an audit row; rate limits enforce
in vitest; replay re-runs a failed run; stats card renders.

#### Phase D — Self-documenting system pass

**Inserted between B5 and C.** Phase C ships *after* Phase D — the
walkthrough partners run for sign-off should land on pages that explain
themselves.

#### Why

Phase A surfaced how often the user — and a fresh partner — bounces off
unfamiliar pages because nothing on the page says what it's for or what
to do next. The connector intake-doors cards are now self-explanatory;
nothing else in the app is. Before declaring "done," every core module
gets the same treatment so the product stops requiring tribal knowledge
to operate. The 2026-04-30 self-doc audit
(`docs/self-doc-audit-2026-04-30.md`) found 14 of 18 modules at the
"none" tier — bare h4 header, no tooltips, `No X found` empty state.

#### Goals (the four self-doc layers)

1. **Header info well** at the top of every page — one paragraph: what
   the page is for + the typical flow. Dismissible, remembered per-user
   per-page.
2. **Field tooltips** on non-obvious form/table fields (system_type,
   coa_delivery_method, role chips, naming format, extraction fields,
   etc.). `(?)` icon next to the label, hover for the explanation.
3. **Helpful empty states** — title + body + optional CTA. Never bare
   "No X found." Tell the user what to do next.
4. **Actionable error messages** — sweep the existing `Alert
   severity="error"` blocks for "Failed to fetch" garbage and replace
   with operator-style guidance ("Couldn't load connectors. Check your
   network, refresh, or contact your admin.").

In addition, a top-level **`/help`** route hosts longer-form admin
docs, and a public **`/docs/connectors`** route hosts vendor-facing
intake docs (moved out of B5).

#### Architectural approach

Five shared primitives, all introduced in D0, used everywhere thereafter:

a. **`<HelpWell id title>`** (`src/components/HelpWell.tsx`) — MUI
   `Alert severity="info"` with a Collapse + close button.
   `id` keys dismissal in localStorage so users see it once. Children
   are MDX-style copy from `helpContent`.

b. **`<InfoTooltip>`** (`src/components/InfoTooltip.tsx`) — `(?)` icon
   wrapping MUI `Tooltip` + `IconButton` + `InfoOutlinedIcon`. Mirrors
   `CopyId.tsx` shape.

c. **`<EmptyState title description actionLabel onAction>`**
   (`src/components/EmptyState.tsx`) — generalized from the
   one-off helpers in `src/components/records/{Calendar,Timeline,
   Kanban,Gallery}View.tsx`, `WorkflowsTab.tsx`, `FormsTab.tsx`, and
   `src/pages/records/Sheets.tsx`. Migrate those callsites in the same
   slice — net six fewer copies.

d. **`src/lib/helpContent.ts`** — typed module: `helpContent.connectors.
   list.headline`, `helpContent.connectors.detail.intakeDoors.body`,
   etc. Single source of truth for copy. Misspelled keys fail at
   typecheck. Easy to grep, easy to edit.

e. **`/help` route** — `src/pages/Help.tsx`, admin-auth, simple table
   of contents → section layout. Reads from `helpContent` so admin
   docs and inline help share copy. One route, scroll-anchored
   sections — simpler than a nested router.

f. **`/docs/connectors` route** — `src/pages/docs/Connectors.tsx`,
   public (mounted outside `ProtectedRoute` like `/drop`). One-pager
   with curl / aws-cli / rclone / email examples + troubleshooting.
   Linked from each intake card on `ConnectorDetail.tsx`.

#### Slices

| # | Slice | Estimate |
|---|-------|----------|
| D0 | Shared infra: `<HelpWell>`, `<InfoTooltip>`, `<EmptyState>`, `helpContent.ts`, `/help` shell | ~0.5d |
| D1 | Connectors module (list, detail runs table, wizard + step components) | ~1d |
| D2 | Daily-driver modules: Documents, Import, ReviewQueue, Orders, Customers, Suppliers, Products, Search | ~1.5d |
| D3 | Admin/config modules: Document Types, Bundles, IngestHistory, Activity, AuditLog, ApiKeys, naming-templates surfaces | ~1d |
| D4 | Super-admin + auth: Tenants, Users, Profile, Login/Forgot/Reset header polish | ~0.5d |
| D5 | Vendor docs page `/docs/connectors` (moved out of B5) — curl / aws-cli / rclone / email + troubleshooting; intake-card link-throughs | ~0.5d |
| D6 | Coverage check — re-walk all 18 audited modules, confirm all four layers present, polish any gaps | ~0.5d |

**Total:** ~5–6 days. Each slice is independently shippable; mid-slice
reverts are safe (a half-migrated module is no worse than the current
state).

#### Acceptance

Per-slice: every page in the slice has all four layers (info well,
tooltips on at least the non-obvious fields, helpful empty state,
clear errors). The audit doc is updated module-by-module from "none/
partial" → "good" as slices land. D6 ships when all 18 modules are
"good."

#### Out of scope

- **Full feature tutorials / video walkthroughs.** This is help-on-the-
  page, not training material.
- **AI-driven docs search.** Static `/help` only — no embeddings, no
  RAG.
- **Per-user help personalization** (e.g. "hide help for power users
  globally"). The per-`HelpWell` localStorage dismissal is enough.
- **i18n / translation.** Copy is English-only for now.
- **Marketing copy / landing-page material.** Internal/vendor docs
  only.

#### Risk

- **Audit understated the gap.** D2 modules look uniform from the
  outside but each has its own quirks (Import has rich error UX
  already, Search has the AI/keyword toggle, Orders crosses into
  connectors). Slice durations could slip 0.5d if the per-page work
  isn't as mechanical as the audit suggests.
- **Copy drift.** With help in `helpContent.ts` and inline labels
  hardcoded, the two can diverge. Mitigation: the audit doc gets
  updated each slice and serves as the canonical "what does this
  module say about itself" reference.
- **`<EmptyState>` migration risk.** Hoisting six existing one-offs
  could regress the records views if their props don't translate
  cleanly. Mitigation: keep existing local helpers as thin adapters
  during D0; collapse them in D6 as part of the polish round.

#### Phase C — Coverage + sign-off

(Ships AFTER Phase D so the walkthrough lands on self-explanatory pages.)

| Step | Action |
|------|--------|
| C1 | Five Playwright specs in `tests/e2e/connector-intake-{manual,email,api,s3,public-link}.spec.ts`. Each: login → create connector → fire intake via that path → assert orders + customers rows appear in the UI. Wire into `bin/e2e`. |
| C2 | `docs/connectors-walkthrough.md` — five numbered scenarios, one per path, written for the partner to run cold (prerequisite, exact clicks/commands, expected end state). |
| C3 | Sign-off gate: not done until both owner and partner complete all five scenarios on staging cold, no help. Any trip becomes a Phase A-style punch list item, fix and retry. |

**Estimate:** 1–2 days. Existing `connector-wizard.spec.ts` provides
scaffolding to copy.

#### Architectural decisions (locked in)

1. **Bucket-per-connector, NOT bucket-per-tenant.** R2 permanent API
   tokens can't do prefix scoping or write-only — only TTL-bounded
   temp creds can. Bucket-per-connector is the only path to permanent
   set-and-forget vendor creds with proper isolation. R2 supports 1M
   buckets/account. Naming: `dox-drops-<tenant-slug>-<connector-slug>`.
2. **One account-level CF API token** lives as a Pages secret. Scopes:
   **R2 Storage Write** + **API Tokens Edit**. Used for bucket + key
   auto-provisioning.
3. **Tokens stored on the `connectors` row, encrypted/hashed.** API
   bearer (#4), R2 secret (#5), public-link token (#6) — all hashed
   or encrypted at rest, never returned after the one-time modal.
   Encryption reuses `functions/lib/connectors/crypto.ts`.
4. **The R2 prefix poller stays.** Pivots in B3 to scan each
   connector's auto-provisioned bucket. Synchronous dispatch on
   #4 / #5 / #6 writes `connector_processed_keys` so the next tick
   skips. The poller becomes the universal safety net.
5. **Quality bar applies everywhere.** No half-baked paths. Every
   path has auth + rotation UI, rate limiting, audit log, replay,
   observability, vendor docs, e2e coverage. Enforced in B5.
6. **Universal intake doors.** Connectors are typeless; every connector
   exposes every intake door. The previous `connectors.type` column is
   dropped in B0. Vendors pick whichever door fits their tooling.
   Per-door enable/disable flags can be added later if granularity is
   needed.

#### Open questions

1. **Encryption master key for R2 secrets.** Lean toward a dedicated
   `INTAKE_ENCRYPTION_KEY` Pages secret, separate from `JWT_SECRET`.
   Decide before B1.
2. **Public-link expiry default.** Lean configurable with 30-day UI
   default. Decide before B4.
3. **API token rotation grace period.** Lean hard cutover — no zombie
   tokens. Decide before B2.
4. **Rate limit shape.** Tentative per-connector + per-tenant; per-IP
   only matters for #6 where Turnstile already gates. Decide in B5.

#### Risks

- **CF API token blast radius if leaked.** Mitigation: tight scopes
  (R2 Storage Write + API Tokens Edit, not Account Admin), rotate via
  CF dashboard if exposed, never log.
- **`config.r2_prefix` becomes vestigial after B3.** Keep as a
  transition column; delete in a follow-up migration after B3 runs a
  week in staging without fallback.
- **B3 SigV4 signing in the Worker.** The poller pivot in B3 needs to
  call R2's S3 API (ListObjects / GetObject) with per-connector keys,
  which means SigV4. There is no AWS SDK in `package.json` today.
  Mitigation: evaluate `aws4fetch` first (lightweight SigV4 lib that
  runs in Workers — likely fits); fall back to hand-rolled SigV4 if
  it doesn't. B3 estimate may slip ~0.5d if the fallback is needed.
- **Per-connector R2 keys accumulate** if rotations don't prune. B5
  includes a sweep that revokes superseded keys after a grace period.

#### Out of scope

- **SFTP delivery** — vendors who want SFTP use a third-party gateway
  that drops to S3.
- **Outbound pull** — we don't poll vendor APIs.
- **Direct app integrations** (QuickBooks, Salesforce, NetSuite) —
  vendors hit our HTTP POST or S3 from their own middleware.
- **No data-model hooks for any of these.** No `connector_type =
  'sftp'`, no `pull_endpoint`, nothing speculative.
